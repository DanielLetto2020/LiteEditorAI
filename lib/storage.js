// Бэкенд модуля «Внешние хранилища»: подключения (scope проект/общие) + адаптеры.
// Первый адаптер — S3 (lib/storage-s3.js); интерфейс адаптера описан там же. Секреты шифрует
// safeStorage (схема enc/dec — как lib/db.js / lib/kafka.js), в рендерер уходит только hasSecret.
// Все ответы — строго { ok:true, ... } | { ok:false, error } (общая обёртка ipcMain.handle в
// main.js логирует {ok:false} сама). Долгие передачи шлют прогресс событиями st:progress/st:done/
// st:opErr в ОКНО-ВЛАДЕЛЬЦА (e.sender), отмена — st:cancel {opId}.
//
// main.js: registerStorageIpc({ ipcMain, safeStorage, dialog, getConnections, setConnections }).

const s3 = require('./storage-s3');
const { safeRelSegments } = require('./safe-name');
const path = require('path');
const fs = require('fs');
const os = require('os');

let _safe = null, _get = null, _set = null;

// ---------------------------------------------------------------- secrets (как lib/db.js)
// Отправка в окно: isDestroyed() не ловит уже снесённый фрейм рендерера, и send бросает
// «Render frame was disposed». Здесь это оборвало бы поток тейла/прогресса на полуслове.
function sendSafe(wc, ch, payload) {
  try { if (wc && !wc.isDestroyed()) wc.send(ch, payload); } catch (_) {}
}

function enc(text) {
  if (!text) return '';
  try { if (_safe && _safe.isEncryptionAvailable()) return 'v1:' + _safe.encryptString(text).toString('base64'); } catch (_) {}
  return 'b64:' + Buffer.from(String(text), 'utf8').toString('base64'); // fallback: только обфускация
}
function dec(blob) {
  if (!blob) return '';
  try {
    if (blob.startsWith('v1:')) return _safe.decryptString(Buffer.from(blob.slice(3), 'base64'));
    if (blob.startsWith('b64:')) return Buffer.from(blob.slice(4), 'base64').toString('utf8');
  } catch (_) {}
  return '';
}

// ---------------------------------------------------------------- store
function loadConns() { const a = _get(); return Array.isArray(a) ? a : []; }
function saveConns(a) { _set(a); }
function publicConn(c) {
  const { secretEnc, sessionTokenEnc, ...rest } = c;
  const a = ADAPTERS[c.adapter || 's3'];
  return { ...rest, hasSecret: !!secretEnc, hasSessionToken: !!sessionTokenEnc, caps: (a && a.caps) || {} };
}
function publicList() { return loadConns().map(publicConn); }
function connById(id) {
  const c = loadConns().find((x) => x.id === id);
  if (!c) throw new Error('Подключение не найдено');
  return c;
}

// ---------------------------------------------------------------- адаптеры и клиенты
// Пока адаптер один; таблица — точка расширения (WebDAV/FTP добавляются записью сюда).
const ADAPTERS = { s3 };
function adapterOf(c) {
  const a = ADAPTERS[c.adapter || 's3'];
  if (!a) throw new Error('Неизвестный адаптер: ' + c.adapter);
  return a;
}
// Расшифрованный конфиг для адаптера (секреты живут только в main-процессе).
function cfgOf(c) {
  return {
    endpoint: c.endpoint || '', region: c.region || 'us-east-1',
    forcePathStyle: !!c.forcePathStyle, anonymous: !!c.anonymous,
    accessKeyId: c.accessKeyId || '', secret: dec(c.secretEnc), sessionToken: dec(c.sessionTokenEnc),
    defaultBucket: c.defaultBucket || '', publicBaseUrl: c.publicBaseUrl || '',
  };
}
const clients = new Map(); // id -> { client } — кэш живых клиентов; сбрасывается при save/delete
function clientFor(c) {
  const hit = clients.get(c.id);
  if (hit) return hit.client;
  const client = adapterOf(c).makeClient(cfgOf(c));
  clients.set(c.id, { client });
  return client;
}
// Эвикция отложенная: client.destroy() под живой передачей оборвал бы её посреди потока
// (сценарий: идёт загрузка → пользователь пересохранил это же подключение). Пока по id есть
// живые операции — только помечаем; добьёт finishOp последней операции.
const pendingEvict = new Set();
const opsByConn = new Map(); // opId -> connId — какие подключения держат живые передачи
function hasLiveOps(connId) { for (const op of opsByConn.values()) if (op === connId) return true; return false; }
function evict(id) {
  if (hasLiveOps(id)) { pendingEvict.add(id); return; }
  const h = clients.get(id);
  if (h) { try { h.client.destroy && h.client.destroy(); } catch (_) {} clients.delete(id); }
  pendingEvict.delete(id);
}

// Запрет записи: read-only и анонимные подключения мутировать хранилище не могут.
// Энфорс здесь (первая линия — UI прячет кнопки, но границей безопасности является бэкенд).
function guardWrite(c) {
  if (c.readOnly) throw new Error('Подключение помечено «только чтение»');
  if (c.anonymous) throw new Error('Анонимное подключение — запись недоступна');
}

// ---------------------------------------------------------------- просмотр (лимиты как в проекте)
const MAX_TEXT_VIEW = 2 * 1024 * 1024;    // текст в вивере — 2 МБ (как fs:readFile)
const MAX_IMG_VIEW = 12 * 1024 * 1024;    // картинка — 12 МБ (как fs:readDataUrl)
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const looksBinary = (buf) => buf.subarray(0, 8192).includes(0); // NUL-детект, как lib/remotehost.js

// ---------------------------------------------------------------- IPC

/** @param {{ ipcMain: import('electron').IpcMain, safeStorage?: any, dialog?: any, getConnections?: any, setConnections?: any }} deps */
function registerStorageIpc({ ipcMain, safeStorage, dialog, getConnections, setConnections }) {
  _safe = safeStorage; _get = getConnections; _set = setConnections;

  const ops = new Map(); // opId -> { abort } — живые передачи (отмена + уборка при смерти окна)

  ipcMain.handle('st:list', () => ({ ok: true, connections: publicList(), secure: !!(safeStorage && safeStorage.isEncryptionAvailable()) }));

  // Создание/правка. Секреты приходят только когда меняются; нет — оставляем прежние блобы.
  ipcMain.handle('st:save', (_e, { conn } = {}) => {
    if (!conn || !conn.name) return { ok: false, error: 'нет данных подключения' };
    const list = loadConns();
    const idx = conn.id ? list.findIndex((x) => x.id === conn.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...conn };
    delete rec.hasSecret; delete rec.hasSessionToken; delete rec.caps; // производные publicConn — не персистим
    if (conn.secretKey != null) rec.secretEnc = conn.secretKey ? enc(conn.secretKey) : '';
    if (conn.sessionToken != null) rec.sessionTokenEnc = conn.sessionToken ? enc(conn.sessionToken) : '';
    delete rec.secretKey; delete rec.sessionToken;
    if (!rec.id) rec.id = 'st' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (!rec.scope) rec.scope = '__global__';
    if (!rec.adapter) rec.adapter = 's3';
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveConns(list);
    evict(rec.id);
    return { ok: true, id: rec.id, connection: publicConn(rec) };
  });

  ipcMain.handle('st:delete', (_e, { id } = {}) => {
    saveConns(loadConns().filter((x) => x.id !== id));
    evict(id);
    return { ok: true };
  });

  // Перенос «Проект ⇄ Общие»: смена одного поля = одна атомарная запись (задвоение невозможно).
  ipcMain.handle('st:setScope', (_e, { id, scope } = {}) => {
    if (!scope) return { ok: false, error: 'нет scope' };
    const list = loadConns();
    const rec = list.find((x) => x.id === id);
    if (!rec) return { ok: false, error: 'Подключение не найдено' };
    rec.scope = String(scope);
    saveConns(list);
    return { ok: true, connection: publicConn(rec) };
  });

  // Тест: поля формы поверх сохранённых; секрет — введённый, иначе сохранённый блоб.
  ipcMain.handle('st:test', async (_e, { conn } = {}) => {
    try {
      const saved = conn && conn.id ? (loadConns().find((x) => x.id === conn.id) || {}) : {};
      const merged = { ...saved, ...conn };
      if (conn && conn.secretKey != null) merged.secretEnc = conn.secretKey ? enc(conn.secretKey) : '';
      if (conn && conn.sessionToken != null) merged.sessionTokenEnc = conn.sessionToken ? enc(conn.sessionToken) : '';
      const a = adapterOf(merged);
      const cfg = cfgOf(merged);
      const client = a.makeClient(cfg);
      try { return { ok: true, ...(await a.test(client, cfg)) }; }
      finally { try { client.destroy && client.destroy(); } catch (_) {} }
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // Обёртки: dataCall — чтение, writeCall — мутация (плюс guardWrite).
  const dataCall = (fn) => async (_e, args = {}) => {
    try { const c = connById(args.id); return { ok: true, ...(await fn(c, args)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };
  const writeCall = (fn) => async (_e, args = {}) => {
    try { const c = connById(args.id); guardWrite(c); return { ok: true, ...(await fn(c, args)) }; }
    catch (e) { return { ok: false, error: String(e.message || e), ...(e.aclUnsupported ? { aclUnsupported: true } : {}) }; }
  };

  ipcMain.handle('st:buckets', dataCall(async (c) => ({ buckets: await adapterOf(c).listBuckets(clientFor(c)) })));
  ipcMain.handle('st:ls', dataCall(async (c, { bucket, prefix, token }) => adapterOf(c).ls(clientFor(c), { bucket, prefix: prefix || '', token })));

  // Просмотр: картинка → dataUrl (≤12 МБ), текст → Range-GET первых 2 МБ + NUL-детект.
  ipcMain.handle('st:read', dataCall(async (c, { bucket, key }) => {
    const a = adapterOf(c);
    const client = clientFor(c);
    const meta = await a.stat(client, { bucket, key });
    const ext = path.extname(String(key)).toLowerCase();
    if (IMG_EXT.has(ext)) {
      if (meta.size > MAX_IMG_VIEW) return { kind: 'binary', size: meta.size, meta, note: 'Картинка больше 12 МБ — скачайте для просмотра' };
      const buf = await a.readObject(client, { bucket, key, maxBytes: MAX_IMG_VIEW });
      return { kind: 'image', dataUrl: 'data:' + (meta.contentType || a.mimeOf(key)) + ';base64,' + buf.toString('base64'), size: meta.size, meta };
    }
    const end = Math.min(meta.size, MAX_TEXT_VIEW) - 1;
    if (end < 0) return { kind: 'text', content: '', size: 0, truncated: false, meta }; // пустой объект
    const buf = await a.readRange(client, { bucket, key, start: 0, end });
    if (looksBinary(buf)) return { kind: 'binary', size: meta.size, meta };
    return { kind: 'text', content: buf.toString('utf8'), size: meta.size, truncated: meta.size > MAX_TEXT_VIEW, meta };
  }));

  ipcMain.handle('st:presign', dataCall(async (c, { bucket, key, ttl, method }) => {
    if (c.anonymous) throw new Error('Анонимное подключение — подписанные ссылки недоступны (объекты и так публичны)');
    if (method === 'PUT') guardWrite(c); // подписанная ссылка НА ЗАПИСЬ с read-only профиля — дыра
    return adapterOf(c).presign(clientFor(c), { bucket, key, ttl, method });
  }));
  ipcMain.handle('st:publicUrl', dataCall(async (c, { bucket, key }) => ({ url: adapterOf(c).publicUrl(cfgOf(c), bucket, key) })));
  ipcMain.handle('st:aclGet', dataCall(async (c, { bucket, key }) => adapterOf(c).aclGet(clientFor(c), { bucket, key })));
  ipcMain.handle('st:aclSet', writeCall(async (c, { bucket, key, public: pub }) => adapterOf(c).aclSet(clientFor(c), { bucket, key, public: pub })));

  ipcMain.handle('st:mkdir', writeCall(async (c, { bucket, prefix }) => adapterOf(c).mkdir(clientFor(c), { bucket, prefix })));
  ipcMain.handle('st:copy', writeCall(async (c, { bucket, from, to }) => adapterOf(c).copy(clientFor(c), { bucket, from, to })));
  // rename = copy + delete: НЕ атомарно по природе S3 (фронт предупреждает в подтверждении)
  ipcMain.handle('st:rename', writeCall(async (c, { bucket, from, to }) => {
    const a = adapterOf(c);
    await a.copy(clientFor(c), { bucket, from, to });
    await a.remove(clientFor(c), { bucket, keys: [from] });
    return {};
  }));
  ipcMain.handle('st:remove', writeCall(async (c, { bucket, keys }) => adapterOf(c).remove(clientFor(c), { bucket, keys: Array.isArray(keys) ? keys : [] })));
  ipcMain.handle('st:removePrefix', writeCall(async (c, { bucket, prefix }) => adapterOf(c).removePrefix(clientFor(c), { bucket, prefix })));

  // ------------------------------------------------ передачи (прогресс → окно-владелец)
  // Троттл эмита ~5 к/с — прогресс большого файла не должен заспамить IPC.
  function progressSender(sender, opId, phase, key) {
    let last = 0;
    return (loaded, total) => {
      const now = Date.now();
      if (now - last < 200 && loaded !== total) return;
      last = now;
      sendSafe(sender, 'st:progress', { opId, phase, key, loaded, total });
    };
  }
  // Один 'destroyed'-listener на ОКНО (а не на каждую передачу — иначе после 11 параллельных
  // загрузок сыпался MaxListenersExceededWarning, и замыкания копились до закрытия окна).
  const wiredSenders = new WeakSet();
  function wireSender(sender) {
    if (wiredSenders.has(sender)) return;
    wiredSenders.add(sender);
    sender.once('destroyed', () => {
      for (const [opId, t] of [...ops]) if (t.sender === sender) { finishOp(opId); t.abort(); }
    });
  }
  function finishOp(opId) {
    const t = ops.get(opId);
    if (!t) return null;
    ops.delete(opId);
    const connId = opsByConn.get(opId);
    opsByConn.delete(opId);
    if (connId && pendingEvict.has(connId) && !hasLiveOps(connId)) evict(connId); // отложенная эвикция
    return t;
  }
  function runOp(sender, opId, key, connId, task) {
    ops.set(opId, { abort: task.abort, sender });
    opsByConn.set(opId, connId);
    wireSender(sender);
    task.done
      .then(() => { if (finishOp(opId)) sendSafe(sender, 'st:done', { opId, key }); })
      .catch((e) => { if (finishOp(opId)) sendSafe(sender, 'st:opErr', { opId, key, error: String(e.message || e) }); });
  }

  ipcMain.handle('st:upload', (e, { id, bucket, key, filePath, opId } = {}) => {
    try {
      const c = connById(id); guardWrite(c);
      if (!opId || !filePath) return { ok: false, error: 'нет opId/filePath' };
      const task = adapterOf(c).upload(clientFor(c), { bucket, key, filePath, onProgress: progressSender(e.sender, opId, 'upload', key) });
      runOp(e.sender, opId, key, c.id, task);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  });

  ipcMain.handle('st:download', (e, { id, bucket, key, destPath, opId } = {}) => {
    try {
      const c = connById(id);
      if (!opId || !destPath) return { ok: false, error: 'нет opId/destPath' };
      const task = adapterOf(c).download(clientFor(c), { bucket, key, destPath, onProgress: progressSender(e.sender, opId, 'download', key) });
      runOp(e.sender, opId, key, c.id, task);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  });

  ipcMain.on('st:cancel', (_e, { opId } = {}) => { const t = ops.get(opId); if (t) { finishOp(opId); t.abort(); } });

  // «Скачать папку»: рекурсивный листинг → последовательное скачивание с агрегированным
  // прогрессом (в байтах по всем файлам). Композитная операция под тем же opId/отменой.
  const DL_PREFIX_MAX_FILES = 5000;
  function downloadPrefixTask(a, client, { bucket, prefix, destDir, onProgress }) {
    let aborted = false, current = null;
    const done = (async () => {
      const items = await a.listAll(client, { bucket, prefix, max: DL_PREFIX_MAX_FILES });
      if (!items.length) throw new Error('Под префиксом нет файлов');
      const total = items.reduce((s, o) => s + o.size, 0);
      let base = 0;
      for (const o of items) {
        if (aborted) throw new Error('Операция отменена');
        const rel = o.key.slice(prefix.length);
        const dest = path.join(destDir, ...safeRelSegments(rel));
        current = a.download(client, { bucket, key: o.key, destPath: dest, onProgress: (l) => onProgress(base + l, total) });
        await current.done;
        base += o.size;
        onProgress(base, total);
      }
      return { ok: true };
    })();
    return { abort: () => { aborted = true; if (current) current.abort(); }, done };
  }
  ipcMain.handle('st:downloadPrefix', (e, { id, bucket, prefix, destDir, opId } = {}) => {
    try {
      const c = connById(id);
      if (!opId || !destDir || !prefix) return { ok: false, error: 'нет opId/destDir/prefix' };
      const task = downloadPrefixTask(adapterOf(c), clientFor(c), { bucket, prefix, destDir, onProgress: progressSender(e.sender, opId, 'download', prefix) });
      runOp(e.sender, opId, prefix, c.id, task);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  });

  // «Открыть в вивере редактора»: объект → временный файл на диске (read-only копия).
  const STAGE_MAX = 12 * 1024 * 1024;
  ipcMain.handle('st:stage', dataCall(async (c, { bucket, key }) => {
    const buf = await adapterOf(c).readObject(clientFor(c), { bucket, key, maxBytes: STAGE_MAX });
    const dir = path.join(os.tmpdir(), 'liteeditor-storage');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (String(key).split('/').pop() || 'object').replace(/[\\/:*?"<>|]/g, '_');
    const p = path.join(dir, Date.now().toString(36) + '-' + safe);
    fs.writeFileSync(p, buf);
    return { path: p };
  }));

  // ------------------------------------------------ диалоги выбора файлов/папок
  ipcMain.handle('st:pickUploads', async (e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Загрузить в хранилище', properties: ['openFile', 'multiSelections'] });
    return { ok: true, paths: r.canceled ? [] : r.filePaths };
  });
  ipcMain.handle('st:pickDownloadDir', async (e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Куда скачать', properties: ['openDirectory', 'createDirectory'] });
    return { ok: true, dir: r.canceled ? '' : r.filePaths[0] };
  });

  return {};
}

module.exports = { registerStorageIpc, _test: { enc, dec, publicConn, cfgOf } };
