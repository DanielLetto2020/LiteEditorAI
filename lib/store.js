// ============================================================================
// lib/store.js — хранилище ~/.LiteEditorAI с in-memory кэшем и коалесируемой
// атомарной записью.
//
// Гарантии:
//   • чтение ключей и снимка store:loadAll после прогрева идёт из памяти за < 0.2 мс
//     без повторных синхронных обращений к диску на каждое открываемое окно модуля;
//   • при передаче modId модульное окно получает только общие ключи и данные своего
//     модуля — гигантские ключи чужих модулей (seoSites, openrouter, voiceClips и др.)
//     не клонируются через IPC;
//   • запись обновляет RAM-кэш синхронно (мгновенная консистентность чтений), а сброс
//     на диск коалесируется по таймеру (по умолчанию 120 мс) через асинхронный
//     crash-safe tmp+rename; на выходе приложения flushAllSync() гарантированно
//     дописывает все отложенные ключи синхронно;
//   • защита от затирания при сбое чтения (storeReadFailed / storeSnapshotBroken) и
//     карантин битых JSON (.corrupt-<ts>) полностью сохранены.
// ============================================================================
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const WRITE_TMP_SUFFIX = '.lite-tmp';

const STORE_KEYS = [
  'projects', 'settings', 'layout', 'recents', 'lastParent', 'categories',
  'sectionOrder', 'favOrder', 'favAgentsOnly', 'accordions', 'dismissed',
  'projTabs', 'openrouter', 'dockerUi', 'dbConnections', 'dbUi',
  'rhConnections', 'rhUi', 'extData', 'extEnabled', 'quickbar', 'seoSites',
  'moduleWins', 'mwLeft', 'mwLogH', 'gitFav', 'commitDrafts', 'bookmarks', 'viewerUi',
  'promptSnippets', 'pomodoro', 'pomodoroLog', 'dbaiProviders', 'sessionSnaps',
  'siteMon', 'rmqConnections', 'rmqUi', 'kafkaConnections', 'kafkaUi',
  'stConnections', 'stUi', 'jiraAccounts', 'jiraUi', 'gsearch', 'gsearchHist',
  'voice', 'voiceClips', 'toolsUi', 'sitemonUi', 'gitGraphUi', 'sshHostKeys',
  'servers', 'serversUi',
];

const MAIN_ONLY_KEYS = new Set([
  'dbConnections', 'rhConnections', 'rmqConnections', 'kafkaConnections',
  'stConnections', 'jiraAccounts', 'sshHostKeys',
]);

const PATCH_KEYS = new Set(['settings']);

// Ключи, принадлежащие строго конкретным окнам модулей: другим модулям и главному окну
// редактора (при запросе селективного снимка) они не нужны.
/** @type {Record<string, string[]>} */
const MODULE_EXCLUSIVE_KEYS = {
  openrouter: ['chat'],
  seoSites: ['seo'],
  dockerUi: ['docker'],
  dbUi: ['db'],
  rhUi: ['rh'],
  rmqUi: ['rmq'],
  kafkaUi: ['kafka'],
  stUi: ['storage'],
  jiraUi: ['jira'],
  toolsUi: ['tools'],
  voice: ['voice'],
  voiceClips: ['voice'],
  pomodoro: ['pomodoro'],
  gitGraphUi: ['gitgraph'],
  serversUi: ['servers'],
  sitemonUi: ['servers', 'sitemon'],
  bookmarks: ['files'],
  gitFav: ['files'],
  commitDrafts: ['files'],
  viewerUi: ['files'],
};

// Ключи, нужные только главному окну редактора (или main), но не окнам модулей.
const EDITOR_ONLY_KEYS = new Set([
  'layout', 'recents', 'lastParent', 'sectionOrder', 'accordions', 'dismissed',
  'projTabs', 'promptSnippets', 'pomodoroLog', 'sessionSnaps', 'siteMon',
  'servers', 'moduleWins', 'gsearch', 'gsearchHist',
]);

function rendererStoreKey(key) {
  return STORE_KEYS.includes(key) && !MAIN_ONLY_KEYS.has(key);
}

function safeKeyName(id) {
  return String(id).replace(/[^\w.-]/g, '_');
}

function cloneVal(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch (_) { return JSON.parse(JSON.stringify(v)); }
}

/**
 * Атомарная синхронная запись через соседний временный файл (с сохранением симлинка и прав).
 * @param {string} file
 * @param {string | Buffer} data
 */
function atomicWriteSync(file, data) {
  let target = file;
  try { if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file); } catch (_) {}
  let mode;
  try { mode = fs.statSync(target).mode & 0o777; } catch (_) {}
  const tmp = target + '.' + process.pid + WRITE_TMP_SUFFIX;
  try {
    fs.writeFileSync(tmp, data, mode == null ? undefined : { mode });
    if (mode != null) { try { fs.chmodSync(tmp, mode); } catch (_) {} }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

let asyncTmpSeq = 0;
/**
 * Атомарная асинхронная запись через уникальный соседний файл (не блокирует главный поток).
 * @param {string} file
 * @param {string | Buffer} data
 */
async function atomicWriteAsync(file, data) {
  let target = file;
  try {
    const lst = await fsp.lstat(file);
    if (lst.isSymbolicLink()) target = await fsp.realpath(file);
  } catch (_) {}
  let mode;
  try { mode = (await fsp.stat(target)).mode & 0o777; } catch (_) {}
  const tmp = `${target}.${process.pid}.${++asyncTmpSeq}${WRITE_TMP_SUFFIX}`;
  try {
    await fsp.writeFile(tmp, data, mode == null ? undefined : { mode });
    if (mode != null) { try { await fsp.chmod(tmp, mode); } catch (_) {} }
    await fsp.rename(tmp, target);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw e;
  }
}

/**
 * Безопасное чтение JSON для редактирования с карантином битого файла (.corrupt-<ts>).
 * @param {string} file
 * @param {any} fallback
 * @param {{ log?: (lvl: string, src: string, msg: string) => void, corruptMsg?: (file: string) => string }} [opts]
 */
function readJsonForEdit(file, fallback, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && /** @type {any} */ (e).code === 'ENOENT') return fallback;
    return { error: String((e && /** @type {any} */ (e).message) || e), readFailed: true };
  }
  try { return JSON.parse(raw); }
  catch (e) {
    const aside = file + '.corrupt-' + Date.now();
    try { fs.renameSync(file, aside); }
    catch (_) {
      const msg = opts.corruptMsg ? opts.corruptMsg(file) : `Файл данных повреждён и не откладывается: ${file}`;
      return { error: msg, readFailed: true };
    }
    if (opts.log) opts.log('warn', 'store', `повреждённый файл отложен: ${aside} (${(e && /** @type {any} */ (e).message) || e})`);
    return fallback;
  }
}

/**
 * Число напоминаний «требует внимания» = не выполнено И (просрочено или срок сегодня).
 * @param {any} arr
 * @param {number} [nowMs]
 */
function agendaAttentionCount(arr, nowMs) {
  if (!Array.isArray(arr)) return 0;
  const sod = nowMs != null ? new Date(nowMs) : new Date();
  sod.setHours(0, 0, 0, 0);
  const eod = sod.getTime() + 86400000;
  let n = 0;
  for (const r of arr) {
    if (!r || r.done || !r.at) continue;
    const t = new Date(r.at).getTime();
    if (!isNaN(t) && t < eod) n++;
  }
  return n;
}

function dayStamp(nowMs) {
  const d = nowMs != null ? new Date(nowMs) : new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function countActiveNotes(arr) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const x of arr) if (x && x.status !== 'done') n++;
  return n;
}

/**
 * Проверяет, нужен ли ключ `k` в снимке для запрашивающего окна `modId`.
 * Пустой `modId` возвращает полный снимок (обратная совместимость).
 * @param {string} k
 * @param {string} modId
 */
function shouldIncludeInSnapshot(k, modId) {
  if (MAIN_ONLY_KEYS.has(k)) return false;
  if (!modId) return true;
  if (modId === '__editor__') {
    return !Object.prototype.hasOwnProperty.call(MODULE_EXCLUSIVE_KEYS, k);
  }
  if (EDITOR_ONLY_KEYS.has(k)) return false;
  if (Object.prototype.hasOwnProperty.call(MODULE_EXCLUSIVE_KEYS, k)) {
    return MODULE_EXCLUSIVE_KEYS[k].includes(modId);
  }
  return true;
}

/**
 * Создаёт экземпляр менеджера хранилища.
 * @param {{
 *   storeDir: string,
 *   logger?: { log: (level: string, src: string, msg: string, err?: any) => void },
 *   corruptMsg?: (file: string) => string,
 *   flushDelayMs?: number,
 * }} cfg
 */
function createStore(cfg) {
  const { storeDir } = cfg;
  const log = (lvl, msg, err) => {
    try { if (cfg.logger) cfg.logger.log(lvl, 'store', msg, err); } catch (_) {}
  };
  const flushDelayMs = cfg.flushDelayMs == null ? 120 : Math.max(0, Number(cfg.flushDelayMs));

  /** @type {Map<string, any>} */
  const cache = new Map();
  /** @type {Map<string, number>} */
  const statMtime = new Map();
  /** @type {Set<string>} */
  const readFailed = new Set();
  /** @type {Set<string>} */
  const snapshotBroken = new Set();

  /** @type {Map<string, string>} */
  const dirty = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Map<string, { promise: Promise<void>, json: string }>} */
  const inFlight = new Map();

  /** @type {Record<string, number> | null} */
  let noteCountsCache = null;
  /** @type {Record<string, number> | null} */
  let agendaCountsCache = null;
  let agendaCachedDay = '';

  function ensureDir() {
    try { fs.mkdirSync(storeDir, { recursive: true }); } catch (_) {}
  }

  function storeFile(key) {
    return path.join(storeDir, safeKeyName(key) + '.json');
  }

  function notesFile(id) {
    return path.join(storeDir, 'notes', safeKeyName(id) + '.json');
  }

  function agendaFile(id) {
    return path.join(storeDir, 'agenda', safeKeyName(id) + '.json');
  }

  function readKeyFromDisk(k) {
    const f = storeFile(k);
    let raw;
    let mtime;
    try {
      const st = fs.statSync(f);
      mtime = st.mtimeMs;
      raw = fs.readFileSync(f, 'utf8');
    } catch (e) {
      if (e && /** @type {any} */ (e).code === 'ENOENT') {
        readFailed.delete(k);
        cache.set(k, undefined);
        statMtime.delete(k);
        return undefined;
      }
      readFailed.add(k);
      log('error', `read '${k}' failed`, e);
      return undefined;
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (e) {
      const aside = f + '.corrupt-' + Date.now();
      try {
        fs.renameSync(f, aside);
        readFailed.delete(k);
        cache.set(k, undefined);
        statMtime.delete(k);
        log('warn', `повреждённый файл отложен: ${aside} (${(e && /** @type {any} */ (e).message) || e})`);
      } catch (_) {
        readFailed.add(k);
        log('error', `read '${k}' failed`, e);
      }
      return undefined;
    }
    readFailed.delete(k);
    cache.set(k, value);
    if (mtime >= 0) statMtime.set(k, mtime);
    return value;
  }

  /** @param {string} key */
  function readStoreKey(key) {
    const k = String(key);
    if (cache.has(k)) return cloneVal(cache.get(k));
    return cloneVal(readKeyFromDisk(k));
  }

  function readSettingsCached() {
    if (!dirty.has('settings') && !inFlight.has('settings')) {
      try {
        const mtime = fs.statSync(storeFile('settings')).mtimeMs;
        if (statMtime.get('settings') !== mtime) cache.delete('settings');
      } catch (e) {
        if (e && /** @type {any} */ (e).code === 'ENOENT') {
          cache.set('settings', undefined);
          statMtime.delete('settings');
          return {};
        }
      }
    }
    return readStoreKey('settings') || {};
  }

  async function flushKeyAsync(k) {
    const prevTimer = timers.get(k);
    if (prevTimer) { clearTimeout(prevTimer); timers.delete(k); }
    if (inFlight.has(k) || !dirty.has(k)) return;
    const json = /** @type {string} */ (dirty.get(k));
    dirty.delete(k);
    ensureDir();
    const f = storeFile(k);
    const run = (async () => {
      try {
        await atomicWriteAsync(f, json);
        if (!dirty.has(k)) {
          try { statMtime.set(k, fs.statSync(f).mtimeMs); } catch (_) {}
        }
      } catch (e) {
        log('error', `write '${k}' failed`, e);
      } finally {
        inFlight.delete(k);
        if (dirty.has(k)) {
          void flushKeyAsync(k);
        }
      }
    })();
    inFlight.set(k, { promise: run, json });
    await run;
  }

  /**
   * Записывает ключ в RAM-кэш и коалесированно (или синхронно при sync:true) сбрасывает на диск.
   * @param {string} key
   * @param {any} value
   * @param {boolean | { fromWindow?: boolean, sync?: boolean }} [opts]
   */
  function writeStoreKey(key, value, opts) {
    const k = String(key);
    const fromWindow = typeof opts === 'boolean' ? opts : !!(opts && opts.fromWindow);
    const sync = typeof opts === 'object' && opts !== null ? !!opts.sync : false;

    if (snapshotBroken.has(k) || (!fromWindow && readFailed.has(k))) {
      log('error', `write '${k}' skipped: файл не прочитался в этой сессии — запись затёрла бы его`);
      return false;
    }

    let json;
    try {
      json = JSON.stringify(value === undefined ? null : value);
    } catch (e) {
      log('error', `serialize '${k}' failed`, e);
      return false;
    }

    cache.set(k, JSON.parse(json));
    readFailed.delete(k);

    const prevTimer = timers.get(k);
    if (prevTimer) { clearTimeout(prevTimer); timers.delete(k); }

    if (sync || flushDelayMs === 0) {
      dirty.delete(k);
      ensureDir();
      const f = storeFile(k);
      try {
        atomicWriteSync(f, json);
        try { statMtime.set(k, fs.statSync(f).mtimeMs); } catch (_) {}
        return true;
      } catch (e) {
        log('error', `write '${k}' failed`, e);
        return false;
      }
    }

    dirty.set(k, json);
    const t = setTimeout(() => { timers.delete(k); void flushKeyAsync(k); }, flushDelayMs);
    if (t && typeof t.unref === 'function') t.unref();
    timers.set(k, t);
    return true;
  }

  /**
   * Синхронно дописывает все отложенные и находящиеся в полёте записи (вызывается при выходе).
   */
  function flushAllSync() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    /** @type {Map<string, string>} */
    const toWrite = new Map();
    for (const [k, entry] of inFlight.entries()) toWrite.set(k, entry.json);
    for (const [k, json] of dirty.entries()) toWrite.set(k, json); // более свежее перекрывает inFlight
    dirty.clear();
    if (!toWrite.size) return;
    ensureDir();
    for (const [k, json] of toWrite.entries()) {
      const f = storeFile(k);
      try {
        atomicWriteSync(f, json);
        try { statMtime.set(k, fs.statSync(f).mtimeMs); } catch (_) {}
      } catch (e) {
        log('error', `flush '${k}' failed`, e);
      }
    }
  }

  /**
   * Дожидается завершения всех асинхронных записей (удобно в тестах и перед перезагрузкой окон).
   */
  async function flushAllAsync() {
    const keys = [...timers.keys(), ...dirty.keys()];
    for (const k of keys) await flushKeyAsync(k);
    while (inFlight.size) {
      await Promise.all([...inFlight.values()].map((x) => x.promise));
    }
  }

  /**
   * Патчит объектный ключ (например settings) по полям без затирания соседних ключей.
   * @param {string} key
   * @param {Record<string, any>} set
   * @param {string[]} unset
   */
  function patchStoreKey(key, set, unset) {
    const cur = readStoreKey(key);
    const next = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
    const s = (set && typeof set === 'object') ? set : {};
    const u = Array.isArray(unset) ? unset.map(String) : [];
    for (const fk of Object.keys(s)) next[fk] = s[fk];
    for (const fk of u) delete next[fk];
    writeStoreKey(key, next);
    return { key: String(key), set: s, unset: u, next };
  }

  function getNoteCounts() {
    if (noteCountsCache) return { ...noteCountsCache };
    /** @type {Record<string, number>} */
    const counts = {};
    try {
      const nd = path.join(storeDir, 'notes');
      for (const f of fs.readdirSync(nd)) {
        if (!f.endsWith('.json')) continue;
        try {
          const a = JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8'));
          const n = countActiveNotes(a);
          if (n) counts[f.slice(0, -5)] = n;
        } catch (_) {}
      }
    } catch (_) {}
    noteCountsCache = counts;
    return { ...counts };
  }

  /** @param {string} [id] @param {any[]} [notesArr] */
  function invalidateNoteCounts(id, notesArr) {
    if (!id) { noteCountsCache = null; return; }
    if (!noteCountsCache) return;
    const key = safeKeyName(id);
    if (Array.isArray(notesArr)) {
      const n = countActiveNotes(notesArr);
      if (n) noteCountsCache[key] = n; else delete noteCountsCache[key];
      return;
    }
    try {
      const a = JSON.parse(fs.readFileSync(notesFile(key), 'utf8'));
      const n = countActiveNotes(a);
      if (n) noteCountsCache[key] = n; else delete noteCountsCache[key];
    } catch (_) {
      delete noteCountsCache[key];
    }
  }

  function getAgendaCounts() {
    const today = dayStamp();
    if (agendaCountsCache && agendaCachedDay === today) return { ...agendaCountsCache };
    /** @type {Record<string, number>} */
    const counts = {};
    try {
      const ad = path.join(storeDir, 'agenda');
      for (const f of fs.readdirSync(ad)) {
        if (!f.endsWith('.json')) continue;
        try {
          const a = JSON.parse(fs.readFileSync(path.join(ad, f), 'utf8'));
          const n = agendaAttentionCount(a);
          if (n) counts[f.slice(0, -5)] = n;
        } catch (_) {}
      }
    } catch (_) {}
    agendaCountsCache = counts;
    agendaCachedDay = today;
    return { ...counts };
  }

  /** @param {string} [id] @param {any[]} [agendaArr] */
  function invalidateAgendaCounts(id, agendaArr) {
    const today = dayStamp();
    if (!id || agendaCachedDay !== today) { agendaCountsCache = null; return; }
    if (!agendaCountsCache) return;
    const key = safeKeyName(id);
    if (Array.isArray(agendaArr)) {
      const n = agendaAttentionCount(agendaArr);
      if (n) agendaCountsCache[key] = n; else delete agendaCountsCache[key];
      return;
    }
    try {
      const a = JSON.parse(fs.readFileSync(agendaFile(key), 'utf8'));
      const n = agendaAttentionCount(a);
      if (n) agendaCountsCache[key] = n; else delete agendaCountsCache[key];
    } catch (_) {
      delete agendaCountsCache[key];
    }
  }

  /**
   * Собирает снимок для store:loadAll из RAM-кэша.
   * @param {{ modId?: string }} [opts]
   */
  function loadSnapshot(opts = {}) {
    const modId = opts && typeof opts.modId === 'string' ? opts.modId.trim() : '';
    /** @type {Record<string, any>} */
    const o = {};
    for (const k of STORE_KEYS) {
      if (!shouldIncludeInSnapshot(k, modId)) continue;
      const v = readStoreKey(k);
      if (v !== undefined) o[k] = v;
      else if (readFailed.has(k)) snapshotBroken.add(k);
    }
    // Счётчики задач и календаря нужны главному окну (или при полном снимке без modId).
    if (!modId || modId === '__editor__') {
      o.noteCounts = getNoteCounts();
      o.agendaCounts = getAgendaCounts();
    }
    if (snapshotBroken.size) o.__readFailed = [...snapshotBroken];
    return o;
  }

  function notesGet(id) {
    return readJsonForEdit(notesFile(id), [], {
      log: (lvl, _src, msg) => log(lvl, msg),
      corruptMsg: cfg.corruptMsg,
    });
  }

  function notesSet(id, notes) {
    try {
      fs.mkdirSync(path.join(storeDir, 'notes'), { recursive: true });
      atomicWriteSync(notesFile(id), JSON.stringify(notes));
      invalidateNoteCounts(id, notes);
      return { ok: true };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function agendaGet(id) {
    return readJsonForEdit(agendaFile(id), [], {
      log: (lvl, _src, msg) => log(lvl, msg),
      corruptMsg: cfg.corruptMsg,
    });
  }

  function agendaSet(id, agenda) {
    try {
      fs.mkdirSync(path.join(storeDir, 'agenda'), { recursive: true });
      atomicWriteSync(agendaFile(id), JSON.stringify(agenda));
      invalidateAgendaCounts(id, agenda);
      return { ok: true };
    } catch (e) {
      return { error: String(e) };
    }
  }

  return {
    ensureDir,
    storeFile,
    notesFile,
    agendaFile,
    readStoreKey,
    readSettingsCached,
    writeStoreKey,
    patchStoreKey,
    loadSnapshot,
    flushAllSync,
    flushAllAsync,
    notesGet,
    notesSet,
    agendaGet,
    agendaSet,
    invalidateNoteCounts,
    invalidateAgendaCounts,
    markSnapshotBrokenIfReadFailed(key) {
      const k = String(key);
      if (readFailed.has(k)) snapshotBroken.add(k);
    },
    hasReadFailed: (key) => readFailed.has(String(key)),
    hasSnapshotBroken: (key) => snapshotBroken.has(String(key)),
  };
}

module.exports = {
  WRITE_TMP_SUFFIX,
  STORE_KEYS,
  MAIN_ONLY_KEYS,
  PATCH_KEYS,
  MODULE_EXCLUSIVE_KEYS,
  rendererStoreKey,
  atomicWriteSync,
  atomicWriteAsync,
  readJsonForEdit,
  agendaAttentionCount,
  createStore,
};
