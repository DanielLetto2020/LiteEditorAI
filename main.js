// LiteEditor — Electron main process.
// Thin backend: project picker, PTY lifecycle, file ops, window controls.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, Tray, nativeImage, crashReporter, safeStorage, Notification } = require('electron');
const i18n = require('./lib/i18n');   // локализация: словари — подключаемые файлы locales/*.json
const dbBackend = require('./lib/db');
const rhBackend = require('./lib/remotehost');
const { guessDbKind, dbPrefillFromInspect, guessMqKind, rmqPrefillFromInspect, kafkaPrefillFromInspect, guessWebKind, webPrefillFromInspect, guessStorageKind, storagePrefillFromInspect } = require('./lib/dbdetect'); // «Контейнеры» → «Базы данных»/«RabbitMQ»/«Kafka»/«Мониторинг сайтов»/«Внешние хранилища»
const rmqBackend = require('./lib/rmq');
const kafkaBackend = require('./lib/kafka');
const storageBackend = require('./lib/storage');
const jiraBackend = require('./lib/jira');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const crypto = require('crypto');
const vm = require('vm'); // песочница для пользовательских предикатов «Мониторинга сайтов»
const { pathToFileURL } = require('url');
const pty = require('node-pty');
const logger = require('./logger');
const { safeChildName } = require('./lib/safe-name'); // анти-traversal для имён папок/файлов
const { resolveShell: resolveShellPure } = require('./lib/shell'); // выбор оболочки терминала
const syncmark = require('./lib/sync');   // метка «sync» в плашке: что домашняя машина держит в синхронизации с сервером
const updater = require('./lib/updater');  // самообновление: проверка релиза, загрузка, подмена каталога

app.setName('LiteEditorAI');
app.setAppUserModelId('com.mletto.liteeditorai'); // Windows: имя/иконка/группировка в панели задач и уведомлениях

// Capture native (C++) crashes — e.g. a GPU/renderer process abort, which on
// Linux shows up as "trap int3" in dmesg and closes the app with no dialog.
// uploadToServer:false → minidumps stay local (userData/Crashpad), never sent.
try { crashReporter.start({ uploadToServer: false }); } catch (_) {}

// Electron installed via npm ships no root-owned setuid sandbox helper, so the
// Chromium SUID sandbox aborts at launch. We load only our own local content,
// and the renderer already gets a shell via PTY, so the sandbox adds nothing.
app.commandLine.appendSwitch('no-sandbox');
// GPU accel powers the xterm WebGL renderer (smooth scroll) and is fine on real
// desktops. It only breaks on VM/nested/VNC displays — there set LITE_NO_GPU=1 to
// fall back to software rendering (xterm then uses the Canvas renderer).
if (process.env.LITE_NO_GPU === '1' || process.env.LITE_SOFTWARE_RENDER === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let tray = null;
// Virtual target width for win:growBy. Growth accumulates here UNCLAMPED, while the
// real setBounds is clamped to the screen edge — so a growth cut short by the edge is
// matched by an equal shrink and the window returns to its exact pre-grow size.
// growAppliedWidth = the last width we set ourselves; a resize to anything else means
// the user dragged the edge, so we forget the virtual width and start fresh from there.
let growDesiredWidth = null;
let growAppliedWidth = null;
const ptys = new Map();     // projectId -> IPty
const watchers = new Map(); // project root path -> { watcher, timer, pending:Set }

// Resolve a shell that actually exists. $SHELL can point at a shell that was
// uninstalled (e.g. zsh removed), which makes node-pty fail with "execvp failed".
// Выбор оболочки терминала. Чистая логика — в lib/shell.js (тестируется); здесь тонкая обёртка:
// читает settings.shell из стора и инжектит платформу/env/проверку существования. { file, args }.
function resolveShell() {
  const selected = ((readStoreKey('settings') || {}).shell) || '';
  return resolveShellPure({
    platform: process.platform,
    selected,
    env: process.env,
    exists: (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } },
  });
}

// Universal "is the agent waiting for input?" detection via the PTY's foreground
// process group (Linux). Works for any agent (Claude/Codex/Qwen/Kimi) because it
// reads process state, not terminal text. Returns:
//   'shell'   — bare shell at its prompt (idle; nothing is waiting)
//   'running' — a foreground program is actively computing
//   'waiting' — a foreground program is alive but sleeping (waiting on your input)
//   null      — unknown (non-Linux / error) → caller falls back to text heuristics
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ash', 'tcsh', 'csh', 'ksh', '-bash', '-zsh', '-sh']);
function readProcStat(pid) {
  try {
    const data = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const r = data.lastIndexOf(')');
    const comm = data.slice(data.indexOf('(') + 1, r);
    const rest = data.slice(r + 2).split(' '); // state ppid pgrp session tty_nr tpgid ...
    return { comm, state: rest[0], pgrp: +rest[2], tpgid: +rest[5] };
  } catch (_) { return null; }
}
function foregroundKind(shellPid) {
  if (process.platform !== 'linux' || !shellPid) return null;
  const sh = readProcStat(shellPid);
  if (!sh || !(sh.tpgid > 0)) return null;
  if (sh.tpgid === sh.pgrp) return 'shell';            // shell's own group is foreground
  const leader = readProcStat(sh.tpgid);
  if (leader && SHELLS.has(leader.comm)) return 'shell'; // a nested shell sitting at its prompt
  let alive = false, running = false;
  try {
    for (const ent of fs.readdirSync('/proc')) {
      if (ent.charCodeAt(0) < 48 || ent.charCodeAt(0) > 57) continue; // numeric pids only ('0'..'9' = 48..57)
      const st = readProcStat(ent);
      if (!st || st.pgrp !== sh.tpgid) continue;
      alive = true;
      if (st.state === 'R' || st.state === 'D') running = true;
    }
  } catch (_) { return null; }
  if (!alive) return 'shell';
  return running ? 'running' : 'waiting';
}

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', 'target', '.cache', '.idea',
]);
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const IMPORT_MAX_BYTES = 64 * 1024 * 1024; // settings backup gate — small in practice, blocks pathological files

// ---------------------------------------------------------------- global store (~/.LiteEditor)
// One predictable home-dir folder holds everything (settings, projects, recents,
// categories, notes) — like .idea, easy to find/back up. main owns the files;
// the renderer keeps a sync snapshot and writes through.
const storeDir = path.join(os.homedir(), '.LiteEditorAI');
// one-time migration from the pre-rename folder so existing users keep their data
try {
  const legacy = path.join(os.homedir(), '.LiteEditor');
  if (!fs.existsSync(storeDir) && fs.existsSync(legacy)) fs.cpSync(legacy, storeDir, { recursive: true });
} catch (_) {}
const STORE_KEYS = ['projects', 'settings', 'layout', 'recents', 'lastParent', 'categories', 'sectionOrder', 'favOrder', 'accordions', 'dismissed', 'projTabs', 'openrouter', 'dockerUi', 'dbConnections', 'dbUi', 'rhConnections', 'rhUi', 'extData', 'extEnabled', 'quickbar', 'seoSites', 'moduleWins', 'mwLeft', 'mwLogH', 'gitFav', 'commitDrafts', 'bookmarks', 'promptSnippets', 'pomodoro', 'pomodoroLog', 'dbaiProviders', 'sessionSnaps', 'siteMon', 'rmqConnections', 'rmqUi', 'kafkaConnections', 'kafkaUi', 'stConnections', 'stUi', 'jiraAccounts', 'jiraUi', 'gsearch', 'gsearchHist'];
function ensureStoreDir() { try { fs.mkdirSync(storeDir, { recursive: true }); } catch (_) {} }
function storeFile(key) { return path.join(storeDir, String(key).replace(/[^\w.-]/g, '_') + '.json'); }
function readStoreKey(key) {
  try { return JSON.parse(fs.readFileSync(storeFile(key), 'utf8')); }
  // ENOENT just means "never written yet" (normal); anything else (bad JSON, perms) is worth logging.
  catch (e) { if (e && e.code !== 'ENOENT') logger.log('error', 'store', `read '${key}' failed`, e); return undefined; }
}
// Crash-safe write: write a sibling .tmp then rename(2) over the target. rename is atomic
// on the same filesystem, so a crash / OOM-kill / power-loss mid-write can never leave a
// half-written (corrupt) JSON — the original file stays intact and a stale .tmp is harmless
// (overwritten next time). Without this, dying during the write of projects.json would lose
// the entire project list on the next launch (JSON.parse throws → undefined).
// Суффикс временного соседа при атомарной записи. Вотчер и листинг дерева его отфильтровывают:
// иначе сохранение файла В ПРОЕКТЕ (через atomicWriteSync это, например, CLAUDE.md) дёргало бы
// дерево лишним «изменился файл» на соседа, которого через миллисекунду уже нет.
const WRITE_TMP_SUFFIX = '.lite-tmp';
function atomicWriteSync(file, data) {
  // Пишем по РЕАЛЬНОМУ пути: rename поверх симлинка заменяет саму ссылку обычным файлом, и связь
  // с общим файлом-целью рвётся молча (CLAUDE.md или конфиг вполне держат симлинком на шаблон —
  // дальше правки уходили бы в копию, а общий файл больше не обновлялся).
  let target = file;
  try { if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file); } catch (_) {}
  // Права существующей цели переносим на нового соседа: rename кладёт на её место файл, созданный
  // по umask, и цель с чувствительным содержимым (база KeePass, 0600) стала бы читаемой всем.
  let mode; try { mode = fs.statSync(target).mode & 0o777; } catch (_) {}
  // Имя соседа уникально по процессу. У приложения нет single-instance-лока: второй запущенный
  // редактор пишет ТЕ ЖЕ файлы стора, и с общим `X.tmp` два процесса писали бы в один временный
  // файл вперемешку, после чего один переименовывал бы мешанину поверх цели. Для projects.json
  // это ровно та потеря всего списка проектов, ради предотвращения которой запись и делалась
  // атомарной. Тот же приём уже применён в mcp/lite-agenda-server.js, который пишет agenda/*.json
  // из отдельного процесса.
  const tmp = target + '.' + process.pid + WRITE_TMP_SUFFIX;
  fs.writeFileSync(tmp, data, mode == null ? undefined : { mode });
  if (mode != null) { try { fs.chmodSync(tmp, mode); } catch (_) {} }  // tmp мог остаться от прошлого краха — { mode } его не переоткрывает
  fs.renameSync(tmp, target);
}
// Returns true on success. store:set is fire-and-forget (renderer updates its in-memory
// snapshot before the write), so a swallowed failure = silent data loss after restart — we
// log it; the boolean lets callers that DO care (import) detect a partial failure.
function writeStoreKey(key, value) {
  ensureStoreDir();
  try { atomicWriteSync(storeFile(key), JSON.stringify(value)); return true; }
  catch (e) { logger.log('error', 'store', `write '${key}' failed`, e); return false; }
}
ensureStoreDir();

// ── Централизованная обвязка ошибок IPC (см. CLAUDE.md → «Логирование ошибок») ──────────────
// ВСЕ модули (текущие и будущие, включая db/remotehost ниже) общаются с бэкендом через
// ipcMain.handle / ipcMain.on. Оборачиваем регистрацию ОДИН раз, до первого обработчика, чтобы:
//   • исключение в любом handler → лог [ERROR] с каналом и стеком, затем проброс (reject в рендерер
//     остаётся как был — поведение модулей не меняем);
//   • результат вида { ok:false, error } → лог [WARN] (так провалившиеся git/db/seo/… операции
//     перестают «теряться»: раньше push-ошибка нигде не фиксировалась);
//   • исключение в ipcMain.on (fire-and-forget) → лог [ERROR] вместо тихого падения EventEmitter.
// Лог пишется в рантайме (logger.init уже отработал к моменту вызова). Это и есть та «обвязка на
// сбор ошибок», которую достаточно держать здесь — отдельные модули её НЕ дублируют.
(() => {
  const _handle = ipcMain.handle.bind(ipcMain);
  const oneLine = (s) => String(s == null ? '' : s).split('\n')[0].slice(0, 400);
  ipcMain.handle = (channel, fn) => _handle(channel, async (event, ...args) => {
    try {
      const res = await fn(event, ...args);
      if (res && typeof res === 'object' && res.ok === false && res.error) {
        logger.log('warn', 'ipc', `${channel} → ${oneLine(res.error)}`);
      }
      return res;
    } catch (e) {
      logger.log('error', 'ipc', `${channel} threw`, e);
      throw e;
    }
  });
  const _on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, fn) => _on(channel, (event, ...args) => {
    try { return fn(event, ...args); }
    catch (e) { logger.log('error', 'ipc', `${channel} (on) threw`, e); }
  });
})();

// «Базы данных» backend (drivers + SSH tunnel + safeStorage secrets) — handlers live in lib/db.js.
const dbApi = dbBackend.registerDbIpc({
  ipcMain, safeStorage, dialog,
  getConnections: () => readStoreKey('dbConnections'),
  setConnections: (v) => writeStoreKey('dbConnections', v),
});

// «Kafka» backend (профили кластеров + kafkajs) — lib/kafka.js.
kafkaBackend.registerKafkaIpc({
  ipcMain, safeStorage,
  getConnections: () => readStoreKey('kafkaConnections'),
  setConnections: (v) => writeStoreKey('kafkaConnections', v),
});
// «RabbitMQ» backend (профили + management HTTP API, без зависимостей) — lib/rmq.js.
rmqBackend.registerRmqIpc({
  ipcMain, safeStorage,
  getConnections: () => readStoreKey('rmqConnections'),
  setConnections: (v) => writeStoreKey('rmqConnections', v),
});
// «Внешние хранилища» backend (подключения scope проект/общие + адаптер S3) — lib/storage.js.
storageBackend.registerStorageIpc({
  ipcMain, safeStorage, dialog,
  getConnections: () => readStoreKey('stConnections'),
  setConnections: (v) => writeStoreKey('stConnections', v),
});

// «Jira» backend (мульти-аккаунт + REST API v2, без зависимостей) — lib/jira.js.
// storeDir нужен для выгрузки отчёта разведки в ~/.LiteEditorAI/jira/ (токен в отчёт не попадает).
jiraBackend.registerJiraIpc({
  ipcMain, safeStorage, storeDir,
  getAccounts: () => readStoreKey('jiraAccounts'),
  setAccounts: (v) => writeStoreKey('jiraAccounts', v),
});

// «RemoteHost» backend (интерактивные SSH-сессии + safeStorage-секреты) — lib/remotehost.js.
// send() лениво ссылается на mainWindow (создаётся позже), вызывается только при живой сессии.
const rhApi = rhBackend.registerRemoteIpc({
  ipcMain, safeStorage,
  // rh:data/rh:exit несут { id: sessionId } → маршрутизируем в окно-владельца сессии (редактор ИЛИ
  // окно модуля «Удалённые хосты»); если владельца нет — фолбэк в окно редактора (sendToOwner).
  send: (ch, payload) => sendToOwner(payload && payload.id, ch, payload),
  onSessionOpen: (sessionId, sender) => { if (sessionId && sender) ownerBySession.set(sessionId, sender); },
  getConnections: () => readStoreKey('rhConnections'),
  setConnections: (v) => writeStoreKey('rhConnections', v),
});

// File logging lives next to the store, survives restarts, keeps 5 days.
const logsDir = path.join(storeDir, 'logs');
// Реестр ошибок (errors.json в storeDir) — инициализируем ДО logger.init: logger.write()
// кормит реестр на каждый warn/error/fatal, поэтому реестр должен быть готов раньше.
const errledger = require('./errledger');
errledger.init(storeDir);
logger.init(logsDir);
ipcMain.on('log:renderer', (_e, { level, args } = {}) => logger.renderer(level, ...(Array.isArray(args) ? args : [args])));

// Logs viewer (in-app, menu "Логи"). Only the app's own log files are listed/readable.
const LOG_FILE_RE = /^(lite|launch)-\d{4}-\d{2}-\d{2}\.log$/;
ipcMain.handle('logs:list', () => {
  try {
    const out = [];
    for (const f of fs.readdirSync(logsDir)) {
      if (!LOG_FILE_RE.test(f)) continue;
      try { const s = fs.statSync(path.join(logsDir, f)); out.push({ name: f, size: s.size, mtime: s.mtimeMs }); } catch (_) {}
    }
    out.sort((a, b) => b.name.localeCompare(a.name)); // newest day first
    return { files: out };
  } catch (e) { return { error: String(e), files: [] }; }
});
ipcMain.handle('logs:read', (_e, name) => {
  if (!LOG_FILE_RE.test(String(name || ''))) return { error: 'bad name' }; // no path traversal
  try {
    const full = path.join(logsDir, name);
    const stat = fs.statSync(full);
    const MAX = 1024 * 1024; // tail the last 1 MB so a huge file can't freeze the UI
    if (stat.size <= MAX) return { content: fs.readFileSync(full, 'utf8'), truncated: false };
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(MAX);
      fs.readSync(fd, buf, 0, MAX, stat.size - MAX);
      return { content: buf.toString('utf8'), truncated: true };
    } finally { fs.closeSync(fd); }
  } catch (e) { return { error: String(e) }; }
});
// Удалить один лог-файл / очистить старые (сегодняшний живой файл сохраняется).
ipcMain.handle('logs:delete', (_e, name) => ({ ok: logger.removeFile(name) }));
ipcMain.handle('logs:clearOld', () => ({ ok: true, removed: logger.clearOld() }));

// ── Метка синхронизации в плашке проекта ────────────────────────────────────────────────────
// Редактор синхронизацией не управляет: демон (scripts/server-sync/) живёт своей
// жизнью, здесь мы только читаем его конфиг. Сопоставление делает главный процесс —
// у рендерера нет fs, а сравнивать нужно разрешённые пути (симлинки, см. lib/sync.js).
ipcMain.handle('sync:match', (_e, paths) => {
  try { return { paths: syncmark.match(paths), available: syncAvailable() }; } catch (e) { return { paths: [], available: false, error: String(e) }; }
});

// Подключение проекта к синхронизации. Процедура одна на оба редактора и живёт
// рядом с демоном (scripts/server-sync/lite-sync-link.js): здесь мы на домашней
// машине, поэтому запускаем её сразу, без заявок через сервер.
// ⚠️ Проверка whitelist перед релизом (docs/RELEASE.md) показывает этот require
// как `MISS scripts/server-sync/lite-sync-link.js` — и это ОЖИДАЕМО: каталог
// приватный, в публичные сборки он не уезжает и в `build.files` ему не место.
// Отсутствие модуля безопасно: до require дело доходит только когда на машине
// есть настройки синхронизации, а сам вызов обёрнут в try/catch (см. syncAvailable).
let linker = null;
function linkerModule() {
  // @ts-ignore -- модуля намеренно нет в публичном дереве (каталог приватный),
  // и проверка типов на CI не должна падать на его отсутствии.
  if (!linker) linker = require('./scripts/server-sync/lite-sync-link.js');
  return linker;
}

// Синхронизация — личная оснастка владельца: её каталог (scripts/server-sync/)
// приватный и в публичные сборки не попадает. Поэтому доступность проверяем по
// факту: есть ли настройки и лежит ли рядом сама процедура. Нет — интерфейс о
// синхронизации молчит, а не показывает кнопку, которая ничего не сделает.
function syncAvailable() {
  try {
    if (!syncmark.available()) return false;
    linkerModule();
    return true;
  } catch (_) {
    return false;
  }
}

ipcMain.handle('sync:inspect', (_e, projectPath) => {
  try { return linkerModule().inspect(String(projectPath || '')); } catch (e) { return { ok: false, reason: String(e && e.message ? e.message : e) }; }
});

let linkRunning = false;
ipcMain.handle('sync:link', async (_e, { path: projectPath, prefer } = {}) => {
  // Процедура правит конфиг и переносит файлы — второй заход параллельно не пускаем.
  if (linkRunning) return { ok: false, reason: 'подключение уже идёт' };
  linkRunning = true;
  try {
    return await linkerModule().link(String(projectPath || ''), {
      prefer: prefer === 'local' || prefer === 'remote' ? prefer : null,
      onStep: (step) => {
        sendTo(mainWindow, 'sync:linkStep', step);
      },
    });
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  } finally {
    linkRunning = false;
  }
});

// ── Реестр ошибок (errors ledger) ───────────────────────────────────────────────────────────
ipcMain.handle('errors:list', () => errledger.list());
ipcMain.handle('errors:setStatus', (_e, { id, status, note, commit } = {}) => errledger.setStatus(id, status, note, commit));
ipcMain.handle('errors:clearResolved', () => errledger.clearResolved());
ipcMain.handle('errors:setContext', (_e, projectPath) => { errledger.setContext(projectPath); return { ok: true }; });
// Изменения реестра (новые ошибки, правки статуса, ВНЕШНИЕ правки агентом) → живой UI.
errledger.onChange(() => { sendTo(mainWindow, 'errors:changed'); });
errledger.watch();

ipcMain.on('store:loadAll', (e) => {
  const o = {};
  for (const k of STORE_KEYS) { const v = readStoreKey(k); if (v !== undefined) o[k] = v; }
  o.noteCounts = {}; // project id -> number of ACTIVE (не выполненных) задач, for card badges
  try {
    const nd = path.join(storeDir, 'notes');
    for (const f of fs.readdirSync(nd)) {
      if (!f.endsWith('.json')) continue;
      // старые заметки без поля status считаем активными (status='todo' по умолчанию)
      try { const a = JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8')); if (Array.isArray(a)) { const n = a.filter((x) => x && x.status !== 'done').length; if (n) o.noteCounts[f.slice(0, -5)] = n; } } catch (_) {}
    }
  } catch (_) {}
  o.agendaCounts = {}; // project id -> число напоминаний «требует внимания» (просрочено + сегодня, не done)
  try {
    const ad = path.join(storeDir, 'agenda');
    for (const f of fs.readdirSync(ad)) {
      if (!f.endsWith('.json')) continue;
      try { const a = JSON.parse(fs.readFileSync(path.join(ad, f), 'utf8')); const n = agendaAttentionCount(a); if (n) o.agendaCounts[f.slice(0, -5)] = n; } catch (_) {}
    }
  } catch (_) {}
  e.returnValue = o; // synchronous: renderer loads the snapshot once at startup
});
ipcMain.on('store:set', (_e, { key, value }) => { if (STORE_KEYS.includes(key)) writeStoreKey(key, value); });
// Синхронный вариант — для записи на beforeunload (снимки сессий, идея 7): обычный send может
// не успеть флашнуться до сноса рендерера, sendSync гарантирует запись до выхода.
ipcMain.on('store:setSync', (e, { key, value } = {}) => { if (STORE_KEYS.includes(key)) writeStoreKey(key, value); e.returnValue = true; });
ipcMain.handle('store:notesGet', (_e, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(storeDir, 'notes', String(id).replace(/[^\w.-]/g, '_') + '.json'), 'utf8')); }
  catch { return []; }
});
ipcMain.handle('store:notesSet', (_e, { id, notes }) => {
  try {
    fs.mkdirSync(path.join(storeDir, 'notes'), { recursive: true });
    atomicWriteSync(path.join(storeDir, 'notes', String(id).replace(/[^\w.-]/g, '_') + '.json'), JSON.stringify(notes));
    return { ok: true };
  } catch (e) { return { error: String(e) }; }
});

// «Календарь» (дата-задачи / напоминания) — отдельный источник, зеркалит notesGet/Set (agenda/<id>.json).
const agendaPath = (id) => path.join(storeDir, 'agenda', String(id).replace(/[^\w.-]/g, '_') + '.json');
// Число напоминаний «требует внимания» = не выполнено И (просрочено или срок сегодня). Для бейджа квикбара.
function agendaAttentionCount(arr) {
  if (!Array.isArray(arr)) return 0;
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const eod = sod.getTime() + 86400000; // конец сегодняшнего дня (граница «просрочено+сегодня»)
  let n = 0;
  for (const r of arr) {
    if (!r || r.done || !r.at) continue;
    const t = new Date(r.at).getTime();
    if (!isNaN(t) && t < eod) n++; // просрочено или срок наступает сегодня
  }
  return n;
}

// ── Напоминалки Календаря: тикер сканирует agenda/*.json, шлёт нативные уведомления ──
// Работает, пока редактор запущен (не демон). Гейт notifiedAt не даёт дублей/спама при рестарте.
const AGENDA_REMIND_MS = { at: 0, '10m': 600000, '1h': 3600000, '1d': 86400000 };
function agendaBroadcastChanged(id) {
  for (const w of moduleWindows.values()) { sendTo(w, 'app:agendaChanged', { id }); }
  sendTo(mainWindow, 'app:agendaChanged', { id });
}
function agendaReminderTick() {
  let files;
  try { files = fs.readdirSync(path.join(storeDir, 'agenda')); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(storeDir, 'agenda', f);
    let arr; try { arr = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    let changed = false;
    for (const r of arr) {
      if (!r || r.done || r.notifiedAt || !r.at || !r.remind) continue;
      const off = AGENDA_REMIND_MS[r.remind]; if (off === undefined) continue;
      const at = new Date(r.at).getTime(); if (isNaN(at)) continue;
      if (at - off > now) continue;                       // ещё рано напоминать
      r.notifiedAt = new Date(now).toISOString();          // пометить (не показывать повторно)
      changed = true;
      if (now - at < 7 * 86400000) agendaShowNotification(r); // очень старое (>7 дней) — гасим молча
    }
    if (changed) {
      try { atomicWriteSync(full, JSON.stringify(arr)); } catch (_) {}
      agendaBroadcastChanged(f.slice(0, -5));
    }
  }
}
function agendaShowNotification(r) {
  try {
    if (Notification.isSupported && !Notification.isSupported()) return;
    const title = String(r.text || '').split('\n')[0].trim() || 'Напоминание';
    let body = 'Напоминание';
    const d = r.at ? new Date(r.at) : null;
    if (d && !isNaN(d.getTime())) body = r.allDay
      ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const n = new Notification({ title: '🔔 ' + title, body, silent: false });
    n.on('click', () => { try { focusNotesCalendar(); } catch (_) {} });
    n.show();
  } catch (_) {}
}
// Клик по уведомлению → открыть/сфокусировать окно «Задачи» на вкладке «Календарь».
function focusNotesCalendar() {
  openModuleWindow('notes');
  const w = moduleWindows.get('notes');
  if (!w || w.isDestroyed()) return;
  const send = () => { try { sendTo(w, 'agenda:focus'); } catch (_) {} };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(send, 250));
  else send();
}
function startAgendaReminders() {
  setTimeout(agendaReminderTick, 4000);   // стартовый прогон — покажет пропущенные (один раз, гейт notifiedAt)
  setInterval(agendaReminderTick, 60000); // раз в минуту
}
// fs.watch на каталоге agenda: внешние записи (MCP-сервер) → освежить бейдж/ленту в окнах.
function startAgendaWatch() {
  try { fs.mkdirSync(path.join(storeDir, 'agenda'), { recursive: true }); } catch (_) {}
  const timers = new Map();
  try {
    fs.watch(path.join(storeDir, 'agenda'), (_event, filename) => {
      if (!filename || !String(filename).endsWith('.json')) return;
      const id = String(filename).slice(0, -5);
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => agendaBroadcastChanged(id), 150)); // дебаунс rename+change
    });
  } catch (e) { logger.log('warn', 'agenda', 'fs.watch недоступен: ' + e.message); }
}

// ── MCP-мост: регистрация встроенного сервера напоминаний в Claude Code (scope local, не в репозиторий) ──
function agendaMcpServerPath() {
  // В упакованном приложении файл распакован рядом с asar (asarUnpack: 'mcp/**').
  return path.join(__dirname, 'mcp', 'lite-agenda-server.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}
function agendaMcpCommand(projId) {
  const sp = agendaMcpServerPath();
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return `claude mcp add lite-tasks --scope local -- node ${q(sp)} --project ${projId || '__global__'}`;
}
ipcMain.handle('agenda:mcpCommand', (_e, { projId } = {}) => ({ cmd: agendaMcpCommand(projId), server: agendaMcpServerPath() }));
ipcMain.handle('agenda:mcpConnect', async (_e, { projId, projPath } = {}) => {
  const sp = agendaMcpServerPath();
  const args = ['mcp', 'add', 'lite-tasks', '--scope', 'local', '--', 'node', sp, '--project', String(projId || '__global__')];
  return await new Promise((resolve) => {
    let done = false, stderr = '', stdout = '', to = null;
    const finish = (r) => { if (!done) { done = true; clearTimeout(to); resolve({ ...r, cmd: agendaMcpCommand(projId) }); } };
    let cp;
    try { cp = spawn('claude', args, { cwd: projPath || os.homedir() }); }
    catch (e) { return finish({ ok: false, error: String(e.message || e) }); }
    // Без таймаута зависший `claude mcp add` (спросил что-то в stdin и ждёт) держал бы промис
    // IPC навсегда: кнопка в модалке крутилась бы вечно, процесс жил бы до выхода из редактора.
    to = setTimeout(() => { try { cp.kill(); } catch (_) {} finish({ ok: false, error: 'таймаут: «claude mcp add» не ответил за 30 с' }); }, 30000);
    cp.stdout && cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr && cp.stderr.on('data', (d) => { stderr += d; });
    cp.on('error', (err) => finish({ ok: false, error: err.code === 'ENOENT' ? 'CLI «claude» не найден в PATH' : String(err.message || err) }));
    cp.on('exit', (code) => finish(code === 0 ? { ok: true, out: stdout.trim() } : { ok: false, error: (stderr || stdout).trim() || ('claude завершился с кодом ' + code) }));
  });
});
ipcMain.handle('store:agendaGet', (_e, id) => {
  try { return JSON.parse(fs.readFileSync(agendaPath(id), 'utf8')); }
  catch { return []; }
});
ipcMain.handle('store:agendaSet', (_e, { id, agenda }) => {
  try {
    fs.mkdirSync(path.join(storeDir, 'agenda'), { recursive: true });
    atomicWriteSync(agendaPath(id), JSON.stringify(agenda));
    return { ok: true };
  } catch (e) { return { error: String(e) }; }
});

// ---------------------------------------------------------------- OpenRouter chat
// HTTP from main (Node https): no CORS, the API key never reaches the renderer bundle.
// The list of keys/cards lives in store ('openrouter'); per-card chat history lives in
// orchats/<id>.json (mirrors notes). Streaming uses SSE — chunks are pushed to the
// renderer as openrouter:chunk events, finished with openrouter:done / openrouter:error.
const OR_BASE = 'https://openrouter.ai/api/v1';
function orHeaders(key) {
  return {
    'Authorization': 'Bearer ' + (key || ''),
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://apisell.ru', // OpenRouter attribution headers (optional)
    'X-Title': 'LiteEditorAI',
  };
}
// Отправка в окно. isDestroyed() НЕДОСТАТОЧНО: между проверкой и send фрейм рендерера может быть
// уже снесён (закрытие окна, перезагрузка, падение рендерера), и send бросает
// «Render frame was disposed before WebFrameMain could be accessed». Это не теория: в логе
// набегали сотни таких записей. Хуже шума то, что бросок рвал ЦИКЛ рассылки — окна модулей после
// умирающего не получали сообщение вовсе, — и вылетал наружу из onData PTY.
// Возвращает true, если сообщение ушло.
function sendTo(target, channel, payload) {
  try {
    const wc = (target && target.webContents) ? target.webContents : target;
    if (!wc || wc.isDestroyed()) return false;
    wc.send(channel, payload);
    return true;
  } catch (_) { return false; }
}
function safeSend(sender, channel, payload) { return sendTo(sender, channel, payload); }
function orChatFile(id) { return path.join(storeDir, 'orchats', String(id).replace(/[^\w.-]/g, '_') + '.json'); }
ipcMain.handle('openrouter:histGet', (_e, id) => {
  try { return JSON.parse(fs.readFileSync(orChatFile(id), 'utf8')); } catch { return []; }
});
ipcMain.handle('openrouter:histSet', (_e, { id, messages }) => {
  try {
    fs.mkdirSync(path.join(storeDir, 'orchats'), { recursive: true });
    atomicWriteSync(orChatFile(id), JSON.stringify(Array.isArray(messages) ? messages : []));
    return { ok: true };
  } catch (e) { return { error: String(e) }; }
});
ipcMain.handle('openrouter:models', async (_e, { key } = {}) => {
  return await new Promise((resolve) => {
    const req = https.request(OR_BASE + '/models', { method: 'GET', headers: orHeaders(key) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return resolve({ error: (j.error && j.error.message) || ('HTTP ' + res.statusCode) });
          // keep pricing (USD per token) + context window so the UI can show cost/size
          const models = (j.data || []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
            context: m.context_length || (m.top_provider && m.top_provider.context_length) || 0,
            pricing: { prompt: m.pricing && m.pricing.prompt, completion: m.pricing && m.pricing.completion },
          }));
          resolve({ models });
        } catch (_) { resolve({ error: 'Не удалось разобрать ответ OpenRouter' }); }
      });
    });
    req.on('error', (e) => resolve({ error: String(e.message || e) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'таймаут запроса моделей' }); });
    req.end();
  });
});
// ---------------------------------------------------------------- обновление приложения
// Самообновление «как в мессенджере»: плашка в шапке → загрузка в фоне → «Перезапустить» →
// приложение закрывается и открывается уже новой версией. Механика подмены каталога и выбора
// файла релиза живёт в lib/updater.js (там же объяснено, почему не electron-updater).
//
// Здесь — только состояние процесса и его трансляция в окно: рендерер ничего не качает и не
// распаковывает сам, он лишь показывает фазу. Состояние держим в main, потому что загрузка не
// должна прерываться перезагрузкой рендерера (F5, падение фрейма) — файл в 150 МБ качается долго.
// phase: idle | available | downloading | ready | installing
let updState = { phase: 'idle', pct: 0 };
let updAbort = null;   // { onAbort } — заполняет lib/updater при активной загрузке
let updStaged = null;  // { tag, file, root } — что уже скачано и распаковано, готово к применению

function updSet(patch) {
  updState = { ...updState, ...patch };
  // Плашка живёт в главном окне, но состояние шлём во все — окно модуля тоже может его показать.
  sendTo(mainWindow, 'update:state', updState);
  for (const w of moduleWindows.values()) sendTo(w, 'update:state', updState);
}

// Сведения об установке считаем один раз: тип дистрибутива и права на каталог за время работы
// приложения не меняются (а если бы менялись — обновляться посреди этого всё равно нельзя).
let updInstall = null;
function updInstallInfo() {
  if (!updInstall) {
    updInstall = updater.describeInstall({
      platform: process.platform, execPath: process.execPath, isPackaged: app.isPackaged,
    });
    logger.log('info', 'update', `установка: ${updInstall.kind}, самообновление: ${updInstall.canSelfUpdate ? 'да' : 'нет'}${updInstall.reason ? ' (' + updInstall.reason + ')' : ''}`);
  }
  return updInstall;
}

// Проверка обновления. Публичный репозиторий → токен не нужен. Никогда не бросает: отдаёт {error},
// чтобы фоновая проверка при старте молча ничего не делала, когда сети нет.
ipcMain.handle('update:check', async () => {
  const r = await updater.fetchLatest();
  if (r.error) return r;
  const inst = updInstallInfo();
  const newer = updater.verNewer(r.tag, app.getVersion());
  const asset = newer ? updater.pickAsset(r.assets, { ...inst, platform: process.platform, arch: process.arch }) : null;
  const out = {
    tag: r.tag, name: r.name, notes: r.notes, url: r.url, newer,
    install: { kind: inst.kind, canSelfUpdate: inst.canSelfUpdate, needsPassword: !!inst.needsPassword, reason: inst.reason || '' },
    // Нет файла под эту платформу (релиз собрался частично) — предлагать «Обновить» нельзя,
    // иначе кнопка молча ничего не сделает; UI отправит на страницу релиза.
    asset: asset ? { name: asset.name, size: asset.size } : null,
  };
  if (newer) {
    // Уже скачанное этой же версии переживает перезагрузку рендерера: не качаем 150 МБ заново.
    if (updStaged && updStaged.tag === r.tag) updSet({ phase: 'ready', tag: r.tag, pct: 100 });
    else if (updState.phase !== 'downloading') updSet({ phase: 'available', tag: r.tag, pct: 0 });
  } else if (updState.phase === 'available') updSet({ phase: 'idle', pct: 0 });
  return out;
});

ipcMain.handle('update:state', () => ({ ...updState, install: updInstallInfo() }));

// Скачать и подготовить обновление. Возвращается сразу после ЗАВЕРШЕНИЯ загрузки (это долгая
// операция, прогресс идёт событиями update:state).
ipcMain.handle('update:download', async () => {
  if (updState.phase === 'downloading') return { ok: false, error: 'загрузка уже идёт' };
  const inst = updInstallInfo();
  if (!inst.canSelfUpdate) return { ok: false, error: inst.reason || 'эта установка не умеет обновляться сама' };

  const rel = await updater.fetchLatest();
  if (rel.error) return { ok: false, error: rel.error };
  if (!updater.verNewer(rel.tag, app.getVersion())) return { ok: false, error: 'у вас последняя версия' };
  const asset = updater.pickAsset(rel.assets, { ...inst, platform: process.platform, arch: process.arch });
  if (!asset) return { ok: false, error: 'в релизе нет файла для этой системы' };

  const dir = path.join(updater.updatesDir(storeDir), rel.tag);
  updAbort = {};
  updSet({ phase: 'downloading', tag: rel.tag, pct: 0, size: asset.size });
  logger.log('info', 'update', `загрузка ${asset.name} (${Math.round((asset.size || 0) / 1048576)} МБ)`);
  const dl = await updater.download(asset, dir, {
    signal: updAbort,
    onProgress: (p) => updSet({ phase: 'downloading', pct: p.pct, loaded: p.loaded, size: p.total }),
  });
  updAbort = null;
  if (!dl.ok) {
    updSet({ phase: 'available', pct: 0, error: dl.canceled ? '' : dl.error });
    if (!dl.canceled) logger.log('error', 'update', 'загрузка не удалась: ' + dl.error);
    return { ok: false, error: dl.error, canceled: dl.canceled };
  }

  // .deb ставится системным менеджером пакетов как есть — распаковывать нечего.
  if (inst.kind === 'deb') {
    updStaged = { tag: rel.tag, file: dl.file, root: null };
    updSet({ phase: 'ready', tag: rel.tag, pct: 100 });
    return { ok: true, tag: rel.tag, needsPassword: true };
  }

  updSet({ phase: 'downloading', pct: 100, unpacking: true });
  const un = await updater.unpack(dl.file, path.join(dir, 'unpacked'), process.platform);
  if (!un.ok) {
    updSet({ phase: 'available', pct: 0, error: un.error });
    logger.log('error', 'update', un.error);
    return { ok: false, error: un.error };
  }
  updStaged = { tag: rel.tag, file: dl.file, root: un.root };
  updSet({ phase: 'ready', tag: rel.tag, pct: 100 });
  logger.log('info', 'update', `${rel.tag} готова к установке`);
  return { ok: true, tag: rel.tag };
});

ipcMain.handle('update:cancel', () => {
  if (updAbort && updAbort.onAbort) { try { updAbort.onAbort(); } catch (_) {} }
  return { ok: true };
});

// Применить обновление и перезапуститься. После этого вызова приложение закрывается — ответ
// рендерер получает только при неудаче.
ipcMain.handle('update:install', async () => {
  if (!updStaged) return { ok: false, error: 'обновление ещё не загружено' };
  const inst = updInstallInfo();
  updSet({ phase: 'installing' });

  if (inst.kind === 'deb') {
    const r = await updater.installDeb(updStaged.file);
    if (!r.ok) { updSet({ phase: 'ready', error: r.canceled ? '' : r.error }); return r; }
    logger.log('info', 'update', 'пакет установлен, перезапуск');
    app.relaunch();
    app.exit(0);
    return { ok: true };
  }

  const script = process.platform === 'win32'
    ? updater.winStager({ pid: process.pid, appDir: inst.appDir, newDir: updStaged.root, exec: process.execPath })
    : updater.unixStager({
      pid: process.pid, appDir: inst.appDir, newDir: updStaged.root, exec: process.execPath,
      mac: process.platform === 'darwin',
    });
  try {
    updater.launchStager(script, path.join(updater.updatesDir(storeDir), updStaged.tag), process.platform,
      (e) => logger.log('error', 'update', 'стейджер не запустился: ' + String(e && e.message || e)));
  } catch (e) {
    updSet({ phase: 'ready', error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
  logger.log('info', 'update', `стейджер запущен, выходим для подмены ${inst.appDir}`);
  // Стейджер ждёт смерти этого процесса, поэтому выходим сразу и жёстко: обычный quit может
  // упереться в диалог «сохранить файл?» и оставить стейджер крутиться впустую.
  setTimeout(() => app.exit(0), 300);
  return { ok: true };
});
// Key balance: GET /key → credit limit + usage (so the card can show «израсходовано / лимит»).
ipcMain.handle('openrouter:keyInfo', async (_e, { key } = {}) => {
  return await new Promise((resolve) => {
    const req = https.request(OR_BASE + '/key', { method: 'GET', headers: orHeaders(key) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return resolve({ error: (j.error && j.error.message) || ('HTTP ' + res.statusCode) });
          const d = j.data || {};
          resolve({ usage: d.usage, limit: d.limit, limit_remaining: d.limit_remaining, label: d.label, is_free_tier: d.is_free_tier });
        } catch (_) { resolve({ error: 'Не удалось разобрать ответ OpenRouter' }); }
      });
    });
    req.on('error', (e) => resolve({ error: String(e.message || e) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'таймаут' }); });
    req.end();
  });
});
const orReqs = new Map(); // reqId -> ClientRequest (for abort)
ipcMain.on('openrouter:chatStart', (e, { reqId, key, model, messages, temperature } = {}) => {
  const sender = e.sender;
  const body = JSON.stringify({ model, messages, stream: true, ...(typeof temperature === 'number' ? { temperature } : {}) });
  const req = https.request(OR_BASE + '/chat/completions',
    { method: 'POST', headers: { ...orHeaders(key), 'Content-Length': Buffer.byteLength(body) } },
    (res) => {
      if (res.statusCode >= 400) { // surface the API error body (bad key, no credit, bad model…)
        let errData = '';
        res.on('data', (c) => { errData += c; });
        res.on('end', () => {
          let msg = 'HTTP ' + res.statusCode;
          try { const j = JSON.parse(errData); if (j.error && j.error.message) msg = j.error.message; } catch (_) {}
          if (!orReqs.has(reqId)) return; // aborted meanwhile
          orReqs.delete(reqId); safeSend(sender, 'openrouter:error', { reqId, error: msg });
        });
        return;
      }
      let buf = '';
      const seenImg = new Set(); // de-dupe images that arrive both in a delta and the final message
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;        // skip SSE comments / blank lines
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const ch = j.choices && j.choices[0];
            if (!ch) continue;
            const delta = ch.delta && ch.delta.content;
            if (delta) safeSend(sender, 'openrouter:chunk', { reqId, delta });
            // image-generation models return pictures in delta.images / message.images
            // ({type:'image_url', image_url:{url}}). Fold them into the stream as markdown
            // images so the renderer shows <img> (data:/https: allowed by CSP).
            const imgs = (ch.delta && ch.delta.images) || (ch.message && ch.message.images);
            if (Array.isArray(imgs)) {
              for (const im of imgs) {
                const url = im && (im.image_url ? im.image_url.url : im.url);
                if (url && !seenImg.has(url)) { seenImg.add(url); safeSend(sender, 'openrouter:chunk', { reqId, delta: `\n\n![image](${url})\n\n` }); }
              }
            }
          } catch (_) {}
        }
      });
      res.on('end', () => { if (!orReqs.has(reqId)) return; orReqs.delete(reqId); safeSend(sender, 'openrouter:done', { reqId }); });
    });
  req.on('error', (err) => { if (!orReqs.has(reqId)) return; orReqs.delete(reqId); safeSend(sender, 'openrouter:error', { reqId, error: String(err.message || err) }); });
  req.setTimeout(120000, () => { req.destroy(); if (!orReqs.has(reqId)) return; orReqs.delete(reqId); safeSend(sender, 'openrouter:error', { reqId, error: 'таймаут запроса' }); });
  orReqs.set(reqId, req);
  req.write(body); req.end();
});
ipcMain.on('openrouter:chatAbort', (e, { reqId } = {}) => {
  const r = orReqs.get(reqId);
  if (r) { orReqs.delete(reqId); try { r.destroy(); } catch (_) {} safeSend(e.sender, 'openrouter:done', { reqId }); }
});

// ---------------------------------------------------------------- Text processing (Обработка текста)
// Изолированная подсистема (renderer/textproc.js). Документы-плашки = файлы в
// ~/.LiteEditorAI/textproc/ (IO идёт через общие fs:* по абсолютным путям). Выделенный
// фрагмент прогоняется через ЛОКАЛЬНОГО агента в headless-режиме — по подписке
// пользователя, БЕЗ API-ключей (ключевая идея фичи).
// Обработка текста: нативные Открыть/Сохранить как (вместо браузерного File API/download — PR #6).
// Родитель диалога — окно-отправитель (модульное окно doc), НЕ mainWindow; лимит — как у текстовых панелей.
ipcMain.handle('tp:openFile', async (e) => {
  const res = await dialog.showOpenDialog(senderWin(e) || mainWindow, {
    title: 'Открыть документ', properties: ['openFile'],
    filters: [
      { name: 'Документы', extensions: ['md', 'markdown', 'txt', 'html', 'htm'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
    ...lastDirOpts(),
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const file = res.filePaths[0];
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_VIEW_BYTES) return { ok: false, error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ, лимит ${Math.round(MAX_VIEW_BYTES / 1024 / 1024)} МБ)` };
    const content = fs.readFileSync(file, 'utf8');
    saveState({ lastOpenDir: path.dirname(file) });
    return { ok: true, file, name: path.basename(file), content };
  } catch (e2) { return { ok: false, error: 'Не удалось прочитать файл: ' + String(e2.message || e2) }; }
});
ipcMain.handle('tp:saveFileAs', async (e, { content, name, ext } = {}) => {
  const last = loadState().lastOpenDir;
  const base = String(name || 'Безымянный').replace(/[/\\:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '');
  const res = await dialog.showSaveDialog(senderWin(e) || mainWindow, {
    title: 'Сохранить документ как',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), `${base}.${ext || 'md'}`),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'HTML', extensions: ['html'] },
      { name: 'Текст', extensions: ['txt'] },
    ],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    atomicWriteSync(res.filePath, String(content || ''));
    saveState({ lastOpenDir: path.dirname(res.filePath) });
    return { ok: true, file: res.filePath, name: path.basename(res.filePath) };
  } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
});

// Как звать CLI в неинтерактивном режиме и куда подавать промпт (stdin/arg).
// gemini — официальный Gemini CLI из PATH (идея из PR #6; там был захардкожен macOS-путь Antigravity).
// agentArgs — как звать ту же утилиту в АГЕНТ-режиме: она правит файлы сама, поэтому нужен флаг
// авто-одобрения (подтверждать в неинтерактивном прогоне некому). Флаги сверены по --help
// соответствующих CLI; при смене версий сверить заново.
const TP_BUILTIN_AGENTS = {
  claude: { label: 'Claude', cmd: 'claude', args: ['-p', '--output-format', 'text'], via: 'stdin', agentArgs: ['--permission-mode', 'acceptEdits', '-p'] },
  codex: { label: 'Codex', cmd: 'codex', args: ['exec'], via: 'arg', agentArgs: ['exec', '--full-auto'] },
  gemini: { label: 'Gemini', cmd: 'gemini', args: ['-p'], via: 'arg', agentArgs: ['--yolo', '-p'] },
};
// Список агентов расширяется файлом ~/.LiteEditorAI/tpAgents.json — по записи на утилиту:
//   [{ "id":"agy", "label":"Antigravity", "cmd":"agy", "args":["-p"], "via":"arg", "pty":true }]
// Запись с существующим id ПЕРЕОПРЕДЕЛЯЕТ встроенную, а "hidden": true убирает её из выбора.
// Так и добавление новой утилиты (просьба из PR #10 — Antigravity), и удаление разонравившейся
// (там же — «вырезать Gemini») решаются пользователем, без правки кода под каждую CLI.
const TP_AGENTS_FILE = () => path.join(storeDir, 'tpAgents.json');
function tpUserAgents() {
  try {
    const raw = fs.readFileSync(TP_AGENTS_FILE(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }   // нет файла или битый JSON — работаем на встроенных
}
// id → конфиг запуска. Пользовательские поля берём выборочно: массив args приводим к строкам,
// via/pty нормализуем, посторонние ключи из файла в spawn не утекают.
function tpAgents() {
  const out = {};
  for (const [id, c] of Object.entries(TP_BUILTIN_AGENTS)) out[id] = { id, ...c };
  for (const u of tpUserAgents()) {
    const id = String((u && u.id) || '').trim();
    if (!id) continue;
    if (u.hidden) { delete out[id]; continue; }
    const base = out[id] || {};
    const cmd = String(u.cmd || base.cmd || '').trim();
    if (!cmd) continue;
    out[id] = {
      id,
      label: String(u.label || base.label || id),
      cmd,
      args: Array.isArray(u.args) ? u.args.map((a) => String(a)) : (base.args || []),
      via: u.via === 'stdin' ? 'stdin' : (u.via === 'arg' ? 'arg' : (base.via || 'arg')),
      pty: u.pty === undefined ? !!base.pty : !!u.pty,
      agentArgs: Array.isArray(u.agentArgs) ? u.agentArgs.map((a) => String(a)) : base.agentArgs,
    };
  }
  return out;
}
// Фронту — только то, что нужно для выбора модели (без внутренностей запуска).
ipcMain.handle('tp:agents', () => ({
  ok: true,
  list: Object.values(tpAgents()).map((a) => ({ id: a.id, label: a.label, canAgent: Array.isArray(a.agentArgs) && a.agentArgs.length > 0 })),
  file: TP_AGENTS_FILE(),
  raw: (() => { try { return fs.readFileSync(TP_AGENTS_FILE(), 'utf8'); } catch (_) { return ''; } })(),
}));
ipcMain.handle('tp:saveAgents', (_e, { text } = {}) => {
  const src = String(text == null ? '' : text).trim();
  if (!src) { try { fs.unlinkSync(TP_AGENTS_FILE()); } catch (_) {} return { ok: true, list: Object.values(tpAgents()).map((a) => ({ id: a.id, label: a.label, canAgent: Array.isArray(a.agentArgs) && a.agentArgs.length > 0 })) }; }
  let arr;
  try { arr = JSON.parse(src); } catch (e2) { return { ok: false, error: i18n.t('Список агентов — не JSON: {0}', String(e2.message || e2)) }; }
  if (!Array.isArray(arr)) return { ok: false, error: 'Ожидается массив записей [{ id, cmd, … }]' };
  for (const u of arr) {
    if (!u || typeof u !== 'object') return { ok: false, error: i18n.t('Каждая запись — объект { id, cmd, … }') };
    if (!String(u.id || '').trim()) return { ok: false, error: i18n.t('У записи нет поля id') };
    if (!u.hidden && !String(u.cmd || '').trim() && !TP_BUILTIN_AGENTS[u.id]) return { ok: false, error: i18n.t('У записи «{0}» нет команды (cmd)', u.id) };
    if (u.args !== undefined && !Array.isArray(u.args)) return { ok: false, error: i18n.t('Поле args у записи «{0}» должно быть массивом', u.id) };
  }
  ensureStoreDir();
  try { atomicWriteSync(TP_AGENTS_FILE(), JSON.stringify(arr, null, 2)); }
  catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  const list = Object.values(tpAgents()).map((a) => ({ id: a.id, label: a.label, canAgent: Array.isArray(a.agentArgs) && a.agentArgs.length > 0 }));
  if (!list.length) return { ok: false, error: 'Так не остаётся ни одного агента — верните хотя бы одного' };
  return { ok: true, list };
});
// GUI-сессия часто не видит ~/.local/bin и nvm-bin → дополняем PATH, чтобы claude/codex нашлись.
// Запущенное из меню/Dock приложение наследует минимальный PATH: nvm, Homebrew и npm-global в нём
// отсутствуют, и агент «не найден», хотя в терминале работает (та же беда, из-за которой лаунчер
// прописывает каталог node — см. CLAUDE.md). Спрашиваем PATH у логин-шелла ОДИН раз.
// В PR #10 это делалось execFileSync прямо в tpEnv(): main-процесс вставал на время запуска шелла,
// а интерактивный rc (спиннеры, менеджеры версий, ожидание ввода) мог подвесить редактор совсем.
// Поэтому: асинхронно, в фоне после старта, с таймаутом и stdin из /dev/null; до готовности
// работаем на прежнем PATH — первый запрос просто не получит расширения.
let loginPath = '';        // '' = ещё не знаем или не вышло
let loginPathTried = false;
function probeLoginPath() {
  if (loginPathTried || process.platform === 'win32') return;
  loginPathTried = true;
  const shell = process.env.SHELL || '/bin/bash';
  // -lic: rc-файлы (nvm живёт в .bashrc/.zshrc) читаются только интерактивным шеллом.
  const probe = execFile(shell, ['-lic', 'printf "%s" "$PATH"'], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' }, (err, stdout) => {
    if (err) { logger.log('warn', 'tp', `не удалось прочитать PATH логин-шелла: ${err.message || err}`); return; }
    // Интерактивный шелл мог что-то напечатать от себя — PATH идёт последней непустой строкой.
    const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    if (line.includes(path.sep)) loginPath = line;
  });
  // Закрываем шеллу stdin: интерактивный rc, решивший что-то спросить, иначе ждал бы ввода до таймаута.
  try { probe.stdin.end(); } catch (_) {}
}
function tpEnv() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = [
    loginPath,
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    path.join(os.homedir(), '.local', 'bin'),
    path.dirname(process.execPath),
  ].filter(Boolean);
  return { ...process.env, PATH: extra.join(sep) + sep + (process.env.PATH || '') };
}
// ---- Единый разбор «агент не авторизован» ---------------------------------------------------
// CLI-агенты запускаются неинтерактивно: свой запрос логина показать нам они не могут, и он
// приходит обычным текстом в stdout/stderr. В чате это выглядело как ОТВЕТ агента (а с кнопкой
// «Заменить» его ещё и предлагалось вставить в документ). Ловим типовые формулировки известных
// утилит и возвращаем фронту готовую подсказку с командой входа. Идея — PR #10 (@Ainour108).
const TP_LOGIN_CMD = {
  claude: 'claude',      // внутри сессии: /login
  codex: 'codex login',
  gemini: 'gemini',      // мастер входа на первом экране
};
const TP_AUTH_RE = [
  /\bnot logged ?in\b/i,
  /\bauthentication required\b/i,
  /\bplease (?:run )?(?:\/)?login\b/i,
  /\byou (?:must|need to) (?:log ?in|sign ?in|authenticate)\b/i,
  /\bsign in with google\b/i,
  /\bunauthorized\b/i,
  /\b401\b[^\n]{0,40}\b(?:unauthorized|auth)/i,
  /\b(?:invalid|missing|expired)\s+(?:api\s*key|credentials?|token)\b/i,
  /\bsession (?:has )?expired\b/i,
];
// → { authRequired, loginCmd, error } если текст похож на отказ по авторизации, иначе null.
function tpAuthProblem(cmd, text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (!TP_AUTH_RE.some((re) => re.test(s))) return null;
  const loginCmd = TP_LOGIN_CMD[cmd] || cmd;
  // Одной строкой-шаблоном, а не конкатенацией: иначе экстрактор растащит фразу на обрывки
  // («Агент «», «» не авторизован…»), и перевести её было бы нечем.
  return {
    authRequired: true,
    loginCmd,
    error: i18n.t('Агент «{0}» не авторизован. Выполните в терминале: {1} — войдите в аккаунт и повторите запрос.\n\nОтвет агента:\n{2}',
      cmd, loginCmd, s.trim().slice(0, 600)),
  };
}

const tpReqs = new Map(); // reqId -> ChildProcess
// Живой стриминг ответа в чат (tp:data, идея из PR #6), но через spawn как раньше — БЕЗ PTY:
// под PTY stderr сливается в stdout, CLI видит TTY (спиннеры/контрол-коды), терминал эхоит промпт,
// а \x04 не является EOF под ConPTY (Windows зависал бы до таймаута). stdout чист — стримим как есть.
// Агент-режим: та же утилита, но с флагом авто-одобрения и рабочим каталогом = папка документа.
// Она правит файлы САМА, поэтому:
//  · cwd обязателен и проверяется здесь (без него — отказ). Никакого os.homedir() по умолчанию:
//    промах рабочим каталогом означал бы автономные правки во всём домашнем каталоге;
//  · промпт всегда идёт аргументом (у агентных вызовов свой набор флагов, via не применяется).
function tpAgentRun(sender, { reqId, conf, prompt, cwd }) {
  if (!Array.isArray(conf.agentArgs) || !conf.agentArgs.length) {
    safeSend(sender, 'tp:error', { reqId, error: i18n.t('У агента «{0}» не задан режим правки файлов (agentArgs)', conf.id) });
    return null;
  }
  let stat = null;
  try { stat = fs.statSync(String(cwd || '')); } catch (_) { /* ниже */ }
  if (!stat || !stat.isDirectory()) {
    safeSend(sender, 'tp:error', { reqId, error: i18n.t('Агент-режим требует каталог документа: сохраните файл на диск') });
    return null;
  }
  return { args: [...conf.agentArgs, prompt || ''], cwd, viaStdin: false };
}

ipcMain.on('tp:run', (e, { reqId, agent, prompt, mode, cwd } = {}) => {
  const sender = e.sender;
  const all = tpAgents();
  const conf = all[agent] || all.claude || Object.values(all)[0];
  if (!conf) { safeSend(sender, 'tp:error', { reqId, error: i18n.t('не настроено ни одного агента') }); return; }
  let plan;
  if (mode === 'agent') {
    plan = tpAgentRun(sender, { reqId, conf, prompt, cwd });
    if (!plan) return;                       // причина уже отправлена
  } else {
    plan = { args: conf.via === 'arg' ? [...conf.args, prompt || ''] : [...conf.args], cwd: os.homedir(), viaStdin: conf.via === 'stdin' };
  }
  const args = plan.args;
  let child;
  try { child = spawn(conf.cmd, args, { cwd: plan.cwd, env: tpEnv() }); }
  catch (err) { safeSend(sender, 'tp:error', { reqId, error: 'не запустить «' + conf.cmd + '»: ' + (err.message || err) }); return; }
  tpReqs.set(reqId, child);
  let out = '', errOut = '';
  // Агент-режим обходит файлы и правит их — 4 минут ему мало; чат отвечает одним куском.
  const to = setTimeout(() => { if (tpReqs.has(reqId)) { tpReqs.delete(reqId); try { child.kill(); } catch (_) {} safeSend(sender, 'tp:error', { reqId, error: i18n.t('таймаут (агент не ответил вовремя)') }); } }, mode === 'agent' ? 900000 : 240000);
  child.stdout.on('data', (c) => { const chunk = c.toString('utf8'); out += chunk; safeSend(sender, 'tp:data', { reqId, chunk }); });
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  child.on('error', (err) => {
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId); clearTimeout(to);
    safeSend(sender, 'tp:error', { reqId, error: 'агент «' + conf.cmd + '» не найден/не запустился: ' + (err.message || err) });
  });
  child.on('close', (code) => {
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId); clearTimeout(to);
    const text = out.trim();
    // Отказ по авторизации приходит обычным текстом и выглядел бы как ответ агента — ловим раньше.
    // Но модуль обработки ТЕКСТА: агента вполне могут попросить написать раздел про логин, и в
    // удачном длинном ответе «not logged in» — цитата, а не отказ. Поэтому разбираем только то,
    // что на удачный ответ не похоже: ненулевой код или короткий вывод.
    const auth = (code !== 0 || text.length < 400) ? tpAuthProblem(conf.cmd, text + '\n' + errOut) : null;
    if (auth) { safeSend(sender, 'tp:error', { reqId, ...auth }); return; }
    if (text) safeSend(sender, 'tp:done', { reqId, text }); // непустой вывод = результат (даже при ненулевом коде)
    else safeSend(sender, 'tp:error', { reqId, error: errOut.trim() || ('агент завершился с кодом ' + code) });
  });
  if (plan.viaStdin) { try { child.stdin.write(prompt || ''); child.stdin.end(); } catch (_) {} }
});

// Остановить работающего агента. В агент-режиме это не удобство, а необходимость: до сих пор
// запущенный процесс нельзя было прервать ничем, кроме таймаута, — а он в это время правит файлы.
// Бьём ровно по своему процессу (никаких групп и шаблонов имён), с добиванием, если не внял.
ipcMain.on('tp:cancel', (e, { reqId } = {}) => {
  const child = tpReqs.get(reqId);
  if (!child) return;
  tpReqs.delete(reqId);
  try { child.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { try { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); } catch (_) {} }, 3000);
  safeSend(e.sender, 'tp:error', { reqId, error: i18n.t('Остановлено') });
});

// ---------------------------------------------------------------- AI-DB (read-only SQL chat)
// Streaming variant of tp:run for the «Базы данных» → AI-DB tab: the agent only AUTHORS SQL/text
// (it never touches the DB — the renderer executes read-only queries after explicit confirmation).
// We stream stdout chunks so the chat feels live. Stateless: the renderer re-sends the full
// transcript + schema each turn, so no agent-side session is needed.
// Claude streams real tokens with stream-json + partial messages; codex stays plain-text.
// Промпт несёт структуру базы и строки результата, поэтому оба агента получают его ТОЛЬКО через
// stdin: argv виден в `ps` любому пользователю системы («codex exec -» читает инструкции оттуда).
const DBAI_AGENTS = {
  claude: { cmd: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'], stream: 'json' },
  codex: { cmd: 'codex', args: ['exec', '-'], stream: 'text' },
};
// Транскрипты чатов AI-DB — по файлу на подключение. В общем dbUi они раздували стор: сессия
// хранит до 200 строк результата на сообщение, и весь этот объём переписывался при любом
// сохранении раскладки модуля. Формат файла: { sessions: [...], activeId }.
const dbaiDir = () => path.join(storeDir, 'dbai');
const dbaiFile = (connId) => path.join(dbaiDir(), String(connId).replace(/[^\w.-]/g, '_') + '.json');
ipcMain.handle('dbai:sessionsGet', (_e, { connId } = {}) => {
  const file = dbaiFile(connId);
  if (!fs.existsSync(file)) return null;   // истории просто ещё нет — это не ошибка
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('dbai:sessionsSet', (_e, { connId, data } = {}) => {
  try {
    fs.mkdirSync(dbaiDir(), { recursive: true });
    atomicWriteSync(dbaiFile(connId), JSON.stringify(data || {}));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('dbai:sessionsDelete', (_e, { connId } = {}) => {
  try { fs.rmSync(dbaiFile(connId), { force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
const dbaiReqs = new Map();
// Глушит карту in-flight задач разом: значение — ChildProcess (.kill) или ClientRequest/сокет (.destroy).
function killReqMap(m) {
  for (const v of m.values()) { try { if (v && typeof v.kill === 'function') v.kill(); else if (v && typeof v.destroy === 'function') v.destroy(); } catch (_) {} }
  m.clear();
}
ipcMain.on('dbai:run', (e, { reqId, agent, prompt } = {}) => {
  const sender = e.sender;
  const conf = DBAI_AGENTS[agent] || DBAI_AGENTS.claude;
  const args = [...conf.args];
  let child;
  try { child = spawn(conf.cmd, args, { cwd: os.homedir(), env: tpEnv() }); }
  catch (err) { safeSend(sender, 'dbai:error', { reqId, error: 'не запустить «' + conf.cmd + '»: ' + (err.message || err) }); return; }
  dbaiReqs.set(reqId, child);
  let errOut = '', any = false, buf = '', sawDelta = false;
  const to = setTimeout(() => { if (dbaiReqs.has(reqId)) { dbaiReqs.delete(reqId); try { child.kill(); } catch (_) {} safeSend(sender, 'dbai:error', { reqId, error: 'таймаут (агент не ответил вовремя)' }); } }, 300000);
  const emit = (chunk) => { if (!chunk) return; any = true; safeSend(sender, 'dbai:data', { reqId, chunk }); };
  // extract incremental assistant text from a claude stream-json NDJSON line
  const handleLine = (line) => {
    const s = line.trim(); if (!s) return; let ev; try { ev = JSON.parse(s); } catch (_) { return; }
    if (ev.type === 'stream_event' && ev.event) {
      const evt = ev.event;
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') { sawDelta = true; emit(evt.delta.text || ''); }
      return;
    }
    // fallback when partial messages aren't supported: assistant block carries full text
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content) && !sawDelta) {
      for (const b of ev.message.content) if (b && b.type === 'text' && b.text) emit(b.text);
    }
  };
  if (conf.stream === 'json') {
    child.stdout.on('data', (c) => { buf += c.toString('utf8'); let nl; while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
  } else {
    child.stdout.on('data', (c) => emit(c.toString('utf8')));
  }
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  child.on('error', (err) => { if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); clearTimeout(to); safeSend(sender, 'dbai:error', { reqId, error: 'агент «' + conf.cmd + '» не найден/не запустился: ' + (err.message || err) }); });
  child.on('close', (code) => {
    if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); clearTimeout(to);
    if (conf.stream === 'json' && buf.trim()) handleLine(buf);
    if (any) safeSend(sender, 'dbai:done', { reqId });
    else safeSend(sender, 'dbai:error', { reqId, error: errOut.trim() || ('агент завершился с кодом ' + code) });
  });
  try { child.stdin.write(prompt || ''); child.stdin.end(); } catch (_) {}
});
ipcMain.on('dbai:abort', (e, { reqId } = {}) => {
  const c = dbaiReqs.get(reqId);
  if (c) { dbaiReqs.delete(reqId); try { if (typeof c.kill === 'function') c.kill(); else if (typeof c.destroy === 'function') c.destroy(); } catch (_) {} safeSend(e.sender, 'dbai:done', { reqId, aborted: true }); }
});

// Generic OpenAI-compatible providers (OpenRouter / Ollama / LM Studio) for the AI-DB picker.
// baseUrl is everything before «/chat/completions» (e.g. http://localhost:11434/v1). All three
// share the OpenAI chat-completions wire format, so one path covers them; events reuse dbai:*.
function dbaiHttpMod(u) { return u.protocol === 'https:' ? https : http; }
ipcMain.handle('dbai:apiModels', async (_e, { baseUrl, key } = {}) => {
  return await new Promise((resolve) => {
    let u; try { u = new URL(String(baseUrl).replace(/\/$/, '') + '/models'); } catch (_) { return resolve({ error: 'неверный адрес' }); }
    const headers = { 'Accept': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) };
    const req = dbaiHttpMod(u).request(u, { method: 'GET', headers }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { const j = JSON.parse(data); if (res.statusCode >= 400) return resolve({ error: (j.error && j.error.message) || ('HTTP ' + res.statusCode) }); const models = (j.data || j.models || []).map((m) => ({ id: m.id || m.name, name: m.id || m.name })); resolve({ models }); }
        catch (_) { resolve({ error: 'не удалось разобрать список моделей (проверьте адрес/сервер)' }); }
      });
    });
    req.on('error', (e2) => resolve({ error: String(e2.message || e2) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'таймаут (сервер недоступен)' }); });
    req.end();
  });
});
ipcMain.on('dbai:apiRun', (e, { reqId, baseUrl, key, model, messages, usage } = {}) => {
  const sender = e.sender;
  let u; try { u = new URL(String(baseUrl).replace(/\/$/, '') + '/chat/completions'); } catch (_) { safeSend(sender, 'dbai:error', { reqId, error: 'неверный адрес провайдера' }); return; }
  // Полноценный многоходовой диалог с ролью system: одним склеенным user-сообщением модель хуже
  // держит правила, а провайдер не может кешировать неизменную часть промпта (схему БД).
  const msgs = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: '' }];
  const body = JSON.stringify({ model, messages: msgs, stream: true, ...(usage ? { stream_options: { include_usage: true } } : {}) });
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(key ? { Authorization: 'Bearer ' + key } : {}) };
  const req = dbaiHttpMod(u).request(u, { method: 'POST', headers }, (res) => {
    if (res.statusCode >= 400) { let err = ''; res.on('data', (c) => { err += c; }); res.on('end', () => { let msg = 'HTTP ' + res.statusCode; try { const j = JSON.parse(err); if (j.error && j.error.message) msg = j.error.message; } catch (_) {} if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); safeSend(sender, 'dbai:error', { reqId, error: msg }); }); return; }
    let buf = '', any = false;
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8'); let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const ch = j.choices && j.choices[0];
          const delta = ch && ch.delta && ch.delta.content;
          if (delta) { any = true; safeSend(sender, 'dbai:data', { reqId, chunk: delta }); }
          // последний кадр со stream_options.include_usage несёт счётчики токенов
          if (j.usage) safeSend(sender, 'dbai:usage', { reqId, model: j.model || model, usage: j.usage });
        } catch (_) {}
      }
    });
    res.on('end', () => { if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); if (any) safeSend(sender, 'dbai:done', { reqId }); else safeSend(sender, 'dbai:error', { reqId, error: 'пустой ответ модели' }); });
  });
  req.on('error', (err) => { if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); safeSend(sender, 'dbai:error', { reqId, error: String(err.message || err) }); });
  req.setTimeout(300000, () => { req.destroy(); if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); safeSend(sender, 'dbai:error', { reqId, error: 'таймаут запроса' }); });
  dbaiReqs.set(reqId, req);
  req.write(body); req.end();
});

// ---------------------------------------------------------------- «Анализ диалогов» (ctxmine)
// Майнинг ДОЛГОИГРАЮЩИХ ПРАВИЛ из транскриптов Claude Code (~/.claude/projects/<enc>/*.jsonl).
// Кодирование пути проекта в имя каталога: каждый НЕ-alnum символ → '-' (формула Claude Code,
// проверена на реальных каталогах). scan — быстрый стат по транскриптам активного проекта;
// analyze — спавн `claude -p` над ДИСТИЛЛЯТОМ диалога (только реальные реплики разработчика +
// текст агента, без thinking/tool-шума) с промптом «вытащи правила и порекомендуй, куда положить».
// Модель отдаёт JSON-реестр. Стоп-кран и поток как у dbai. Цель — ОБКАТКА: в реальные CLAUDE.md/
// память НИЧЕГО не пишем, только собираем и показываем.
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ctxmineEnc = (p) => String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
function ctxmineDirFor(projPath) {
  if (!projPath) return null;
  const d = path.join(CLAUDE_PROJECTS_DIR, ctxmineEnc(projPath));
  try { return fs.existsSync(d) && fs.statSync(d).isDirectory() ? d : null; } catch (_) { return null; }
}
function ctxmineFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const fp = path.join(dir, f); let mt = 0; try { mt = fs.statSync(fp).mtimeMs; } catch (_) {} return { fp, mt }; })
    .sort((a, b) => b.mt - a.mt); // новые сессии первыми
}
// служебный мусор CLI (не слова разработчика) — system-reminder'ы и command-обёртки
function ctxmineCleanUser(t) {
  return String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, ' ')
    .replace(/<local-command[\s\S]*?<\/local-command[a-z-]*>/g, ' ')
    .trim();
}
// одна строка JSONL → {role,text} либо null (берём только содержательный текст user/assistant)
function ctxmineMsg(o) {
  const m = o && o.message; if (!m || typeof m !== 'object') return null;
  const role = m.role; if (role !== 'user' && role !== 'assistant') return null;
  const c = m.content; let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
  text = text.trim(); if (!text) return null;
  if (role === 'user') { text = ctxmineCleanUser(text); if (text.length < 2) return null; }
  return { role, text };
}
function ctxmineStat(dir) {
  const files = ctxmineFiles(dir); let messages = 0, bytes = 0, first = 0, last = 0;
  for (const { fp, mt } of files) {
    let st; try { st = fs.statSync(fp); } catch (_) { continue; }
    bytes += st.size; if (!first || mt < first) first = mt; if (mt > last) last = mt;
    let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split('\n')) { const s = line.trim(); if (!s) continue; let o; try { o = JSON.parse(s); } catch (_) { continue; } if (ctxmineMsg(o)) messages++; }
  }
  return { sessions: files.length, messages, bytes, first, last };
}
// собрать дистиллят диалога под промпт (новые сессии первыми, в пределах лимита символов).
// БАТЧИНГ ПО ИМЕНАМ СЕССИЙ: doneNames — Set уже разобранных файлов (.jsonl). Берём НЕразобранные
// сессии (новые первыми) цельными кусками до capChars; batchFiles — какие имена вошли в ЭТОТ батч
// (фронт добавит их в «разобрано» и запишет в localStorage), remaining — сколько ещё неразобранных
// осталось после батча. Так и «Продолжить», и «разобрать ТОЛЬКО новые сессии» (появившиеся позже)
// работают одним механизмом: новый файл просто оказывается «неразобранным».
// Дистилляция истории в текст для анализа. ВАЖНО про «уже разобрано»: раньше done был просто
// списком имён файлов, и длинная сессия резалась по capChars — а помечалась разобранной ЦЕЛИКОМ,
// поэтому её хвост не анализировался никогда. Теперь запись в done может быть либо строкой
// (сессия пройдена до конца), либо {f, off} — «пройдена до символа off»: следующий батч
// продолжает с этого места. Так по длинной сессии едет плавающее окно, а не один первый кусок.
function ctxmineDistill(dir, capChars, doneNames, onlyNames) {
  const done = new Map();
  for (const d of (Array.isArray(doneNames) ? doneNames : [])) {
    if (typeof d === 'string') done.set(d, Infinity);
    else if (d && d.f) done.set(d.f, Math.max(0, Number(d.off) || 0));
  }
  const only = (Array.isArray(onlyNames) && onlyNames.length) ? new Set(onlyNames) : null;
  const files = ctxmineFiles(dir);
  const totalFiles = files.length;
  const chunks = []; const batchFiles = [];
  let total = 0, used = 0, messages = 0, truncated = false, remaining = 0, capped = false;
  for (const { fp } of files) {
    const name = path.basename(fp);
    if (only && !only.has(name)) continue;        // разбираем ровно выбранные сессии
    // Явный выбор человека важнее отметки «уже разобрано»: он ткнул именно в эту сессию, значит
    // читаем её с начала. Иначе «Разобрать выбранные» на разобранной сессии отвечало «нечего анализировать».
    const off = only ? 0 : (done.has(name) ? done.get(name) : 0);
    if (off === Infinity) continue;               // пройдена до конца
    if (capped) { remaining++; continue; }
    let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    const parts = ['\n----- новая сессия -----'];
    let cnt = 0;
    for (const line of txt.split('\n')) {
      const s = line.trim(); if (!s) continue; let o; try { o = JSON.parse(s); } catch (_) { continue; }
      const mm = ctxmineMsg(o); if (!mm) continue;
      let body = mm.text;
      if (mm.role === 'assistant' && body.length > 800) body = body.slice(0, 800) + ' …[обрезано]';
      parts.push((mm.role === 'user' ? 'РАЗРАБОТЧИК: ' : 'АГЕНТ: ') + body);
      cnt++;
    }
    if (cnt === 0) { batchFiles.push(name); continue; }  // пустая сессия — закрываем, чтобы не висела
    const full = parts.join('\n\n');
    if (off >= full.length) { batchFiles.push(name); continue; } // дочитали в прошлый раз
    const room = capChars - total;
    if (used > 0 && room < 2000) { capped = true; remaining++; continue; } // остаток батча слишком мал
    let slice = full.slice(off, off + Math.max(2000, room));
    let end = off + slice.length;
    if (end < full.length) {
      // режем по границе реплики, чтобы кусок не обрывался на полуслове
      const nl = slice.lastIndexOf('\n\n');
      if (nl > slice.length * 0.5) { slice = slice.slice(0, nl); end = off + nl; }
      truncated = true;
    }
    chunks.push(off > 0 ? '\n----- продолжение сессии -----\n' + slice : slice);
    total += slice.length; messages += cnt; used++;
    batchFiles.push(end >= full.length ? name : { f: name, off: end });
    if (end < full.length) { capped = true; remaining++; }   // у этой же сессии остался хвост
    if (total >= capChars) capped = true;
  }
  const hasMore = remaining > 0;
  return { text: chunks.join('\n'), sessions: used, messages, truncated, batchFiles, remaining, hasMore, totalFiles, doneCount: done.size };
}
// Список сессий проекта для выбора вручную: когда/сколько/о чём и разобрана ли уже.
function ctxmineSessions(dir, doneNames) {
  const done = new Map();
  for (const d of (Array.isArray(doneNames) ? doneNames : [])) {
    if (typeof d === 'string') done.set(d, Infinity);
    else if (d && d.f) done.set(d.f, Math.max(0, Number(d.off) || 0));
  }
  const out = [];
  for (const { fp, mt } of ctxmineFiles(dir)) {
    const name = path.basename(fp);
    let size = 0; try { size = fs.statSync(fp).size; } catch (_) {}
    let first = '', msgs = 0;
    try { // первая реплика человека = «о чём был разговор», плюс счётчик реплик — нужен весь файл
      const head = fs.readFileSync(fp, 'utf8');
      for (const line of head.split('\n')) {
        const s = line.trim(); if (!s) continue; let o; try { o = JSON.parse(s); } catch (_) { continue; }
        const mm = ctxmineMsg(o); if (!mm) continue;
        msgs++;
        if (!first && mm.role === 'user') first = mm.text.replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    } catch (_) {}
    const off = done.has(name) ? done.get(name) : 0;
    out.push({ file: name, mtime: mt, bytes: size, messages: msgs, title: first,
      state: off === Infinity ? 'full' : (off > 0 ? 'partial' : 'no') });
  }
  return out;
}
function ctxminePrompt(distill, projName) {
  return `Ты — аналитик. Изучи ИСТОРИЮ ДИАЛОГОВ между разработчиком и ИИ-агентом (Claude Code) в проекте «${projName}» и извлеки из неё ДОЛГОИГРАЮЩИЕ ПРАВИЛА — то, что стоит занести в контекст агента, чтобы он сразу работал правильно и не повторял ошибок.

Что искать (приоритет по убыванию ценности):
1. ИСПРАВЛЕНИЯ разработчика («нет, не так», откаты, «всегда/никогда», поправки стиля) — самый ценный сигнал, каждое = правило.
2. Ошибки и то, КАК их починили (грабли, которые не надо повторять).
3. Соглашения по коду/стилю/именованию, принятые в проекте.
4. Предпочтения по инструментам, командам, рабочему процессу.
5. Архитектурные договорённости.

Для КАЖДОГО правила реши, КУДА его положить (placement). Правило поведения — в контекст; ПРОЦЕДУРА
(последовательность шагов, которую надо выполнить целиком) — в скилл или команду; то, что должно
срабатывать САМО, без участия агента, — в хук:
- "global"  — личное правило поведения, применимо ко ВСЕМ проектам (привычки разработчика) → главный ~/.claude/CLAUDE.md
- "project" — правило поведения, специфичное для этого проекта → CLAUDE.md проекта
- "skill"   — многошаговая ПРОЦЕДУРА, которую агент должен применять сам, когда задача подходит
              (чеклист релиза, порядок отладки, ритуал добавления модуля) → .claude/skills/<имя>/SKILL.md
- "command" — то, что человек запускает РУКАМИ по имени, когда захочет (/deploy, /release) → .claude/commands/<имя>.md
- "hook"    — то, что должно выполняться АВТОМАТИЧЕСКИ на событие (перед коммитом, после правки файла),
              без участия модели → .claude/settings.json, секция hooks
- "memory"  — разовый факт/контекст, полезный для памяти, но не правило поведения → авто-память
- "skip"    — сомнительное/противоречивое/слишком частное — на ревью человеку, пока никуда

Не превращай в скилл/команду/хук то, что является ОДНОЙ фразой-правилом: одна фраза — это контекст.

ВЕРНИ СТРОГО ОДИН JSON-объект, без текста до/после и без markdown-обёртки. Схема:
{
  "summary": "1-2 предложения: что за проект и какие правила преобладают",
  "rules": [
    {
      "title": "короткое правило в повелительном наклонении",
      "detail": "развёрнуто: суть + как применять",
      "category": "code-style|error-fix|workflow|preference|tooling|architecture|other",
      "placement": "global|project|skill|command|hook|memory|skip",
      "placement_reason": "почему именно туда",
      "artifact": "для placement skill/command — короткое имя-слаг латиницей через дефис (например release-checklist); иначе пустая строка",
      "confidence": "high|medium|low",
      "occurrences": 1,
      "evidence": "краткий пересказ момента, где это проявилось"
    }
  ]
}
Не выдумывай правил, которых нет в диалоге. Мало правил в истории — верни мало. Дубли объединяй и повышай occurrences.

=== ИСТОРИЯ ДИАЛОГОВ ===
${distill}`;
}
function ctxmineParse(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return JSON.parse(s);
}

ipcMain.handle('ctxmine:scan', (_e, { projPath } = {}) => {
  try {
    const dir = ctxmineDirFor(projPath);
    if (!dir) return { ok: true, found: false, sessions: 0, messages: 0, bytes: 0, first: 0, last: 0 };
    return { ok: true, found: true, ...ctxmineStat(dir) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ctxmine:sessions', (_e, { projPath, done } = {}) => {
  try {
    const dir = ctxmineDirFor(projPath);
    if (!dir) return { ok: true, found: false, list: [] };
    return { ok: true, found: true, list: ctxmineSessions(dir, done) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

const ctxmineReqs = new Map();
ipcMain.on('ctxmine:analyze', (e, { reqId, projPath, capChars, done, only } = {}) => {
  const sender = e.sender; if (!reqId) return;
  const dir = ctxmineDirFor(projPath);
  if (!dir) { safeSend(sender, 'ctxmine:error', { reqId, error: 'Для этого проекта не найдено транскриптов Claude Code (~/.claude/projects/).' }); return; }
  let distill;
  try { distill = ctxmineDistill(dir, Math.max(5000, Math.min(120000, capChars || 60000)), done, only); }
  catch (err) { safeSend(sender, 'ctxmine:error', { reqId, error: 'Не прочитать транскрипты: ' + ((err && err.message) || err) }); return; }
  if (!distill.text.trim()) { safeSend(sender, 'ctxmine:error', { reqId, error: 'В оставшихся сессиях нет содержательных реплик для анализа.' }); return; }
  const projName = path.basename(projPath || '') || 'проект';
  let child;
  try { child = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'], { cwd: os.homedir(), env: tpEnv() }); }
  catch (err) { safeSend(sender, 'ctxmine:error', { reqId, error: 'не запустить «claude»: ' + ((err && err.message) || err) }); return; }
  ctxmineReqs.set(reqId, child);
  safeSend(sender, 'ctxmine:progress', { reqId, stage: 'start', sessions: distill.sessions, messages: distill.messages, truncated: distill.truncated, chars: distill.text.length, batchFiles: distill.batchFiles, remaining: distill.remaining, hasMore: distill.hasMore, totalFiles: distill.totalFiles });
  let full = '', errOut = '', buf = '', sawDelta = false;
  const to = setTimeout(() => { if (ctxmineReqs.has(reqId)) { ctxmineReqs.delete(reqId); try { child.kill(); } catch (_) {} safeSend(sender, 'ctxmine:error', { reqId, error: 'таймаут (модель не ответила за 5 минут)' }); } }, 300000);
  const emit = (t) => { if (!t) return; full += t; safeSend(sender, 'ctxmine:progress', { reqId, stage: 'delta', delta: t }); };
  const handleLine = (line) => {
    const s = line.trim(); if (!s) return; let ev; try { ev = JSON.parse(s); } catch (_) { return; }
    if (ev.type === 'stream_event' && ev.event) {
      const evt = ev.event;
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') { sawDelta = true; emit(evt.delta.text || ''); }
      return;
    }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content) && !sawDelta) {
      for (const b of ev.message.content) if (b && b.type === 'text' && b.text) emit(b.text);
    }
  };
  child.stdout.on('data', (c) => { buf += c.toString('utf8'); let nl; while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  child.on('error', (err) => { if (!ctxmineReqs.has(reqId)) return; ctxmineReqs.delete(reqId); clearTimeout(to); safeSend(sender, 'ctxmine:error', { reqId, error: 'claude не найден/не запустился: ' + ((err && err.message) || err) }); });
  child.on('close', (code) => {
    if (!ctxmineReqs.has(reqId)) return; ctxmineReqs.delete(reqId); clearTimeout(to);
    if (buf.trim()) handleLine(buf);
    if (!full.trim()) { safeSend(sender, 'ctxmine:error', { reqId, error: errOut.trim() || ('claude завершился с кодом ' + code) }); return; }
    let parsed;
    try { parsed = ctxmineParse(full); }
    catch (err) {
      // Ответить мог не только МОДЕЛЬ, но и сам CLI — «Not logged in», «Usage limit reached».
      // Показывать поверх такого ответа ошибку JSON-парсера бессмысленно: человек видит
      // «Unexpected token N» вместо «войдите в Claude Code».
      const plain = full.trim();
      const looksLikeJson = /[{[]/.test(plain);
      safeSend(sender, 'ctxmine:error', {
        reqId,
        error: looksLikeJson ? ('Модель вернула не-JSON: ' + ((err && err.message) || err)) : ('claude ответил: ' + plain.slice(0, 300)),
        raw: full.slice(0, 4000),
      });
      return;
    }
    const rules = Array.isArray(parsed && parsed.rules) ? parsed.rules : [];
    safeSend(sender, 'ctxmine:result', { reqId, summary: (parsed && parsed.summary) || '', rules, meta: { sessions: distill.sessions, messages: distill.messages, truncated: distill.truncated, batchFiles: distill.batchFiles, remaining: distill.remaining, hasMore: distill.hasMore, totalFiles: distill.totalFiles } });
  });
  child.stdin.on('error', () => {});   // claude не стартовал → async EPIPE на stdin не должен ронять main
  try { child.stdin.write(ctxminePrompt(distill.text, projName)); child.stdin.end(); } catch (_) {}
});
ipcMain.on('ctxmine:abort', (e, { reqId } = {}) => {
  const c = ctxmineReqs.get(reqId);
  if (c) { ctxmineReqs.delete(reqId); try { c.kill(); } catch (_) {} safeSend(e.sender, 'ctxmine:error', { reqId, error: 'Отменено.', aborted: true }); }
});
// Содержимое уже существующих файлов контекста — для дедупа (B): фронт пометит правила, которые в них
// уже записаны, чтобы не предлагать повторно. Читаем только эти три файла (не пишем).
ipcMain.handle('ctxmine:context', (_e, { projPath } = {}) => {
  const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch (_) { return ''; } };
  return {
    ok: true,
    global: read(path.join(os.homedir(), '.claude', 'CLAUDE.md')),
    project: projPath ? read(path.join(projPath, 'CLAUDE.md')) : '',
  };
});
// Применить выбранные правила в файлы контекста (A): дописать маркдаун-буллеты в нужный файл под общим
// заголовком. placement → файл: global=~/.claude/CLAUDE.md, project=<proj>/CLAUDE.md.
// memory/skip файлами НЕ пишем (их в items быть не должно). Подтверждение — на стороне фронта (модалка).
const CTXMINE_APPLY_HEADER = '## Правила из диалогов (LiteEditor)';
ipcMain.handle('ctxmine:apply', (_e, { projPath, items } = {}) => {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Нечего применять' };
  const targets = {
    global: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    project: projPath ? path.join(projPath, 'CLAUDE.md') : null,
  };
  const byPlace = {};
  for (const it of items) { const pl = it && it.placement; if (targets[pl]) (byPlace[pl] = byPlace[pl] || []).push(it); }
  const applied = []; const errors = [];
  for (const [pl, arr] of Object.entries(byPlace)) {
    const file = targets[pl];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let cur = ''; try { cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch (_) {}
      const bullets = arr.map((it) => {
        const t = String((it && it.title) || '').trim();
        const d = String((it && it.detail) || '').trim();
        return '- ' + t + (d ? '\n  ' + d.replace(/\n/g, '\n  ') : '');
      }).join('\n');
      const base = cur.replace(/\s*$/, '');
      const next = cur.includes(CTXMINE_APPLY_HEADER)
        ? base + '\n' + bullets + '\n'
        : (base ? base + '\n\n' : '') + CTXMINE_APPLY_HEADER + '\n' + bullets + '\n';
      atomicWriteSync(file, next);
      applied.push({ placement: pl, file, count: arr.length });
    } catch (err) { errors.push({ placement: pl, error: String((err && err.message) || err) }); }
  }
  return { ok: errors.length === 0, applied, errors };
});

// ---------------------------------------------------------------- Память Claude Code (ctxmem, read-only)
// Claude Code держит долгую память В КАТАЛОГЕ СЕССИЙ, а не в проекте: ~/.claude/projects/<enc(путь)>/memory/
// — по файлу на факт (markdown с YAML-фронтматтером) плюс индекс MEMORY.md, который целиком уезжает
// в контекст КАЖДОЙ сессии. Отдельной «глобальной» памяти у Claude Code нет: её роль играет память
// домашнего каталога (проект с путём ~), поэтому scope='home' — это ровно она, а не особое хранилище.
// Вкладка «Память» модуля «Контекст» показывает список, тела, ссылки [[…]] и расхождения индекса
// с файлами, умеет править файл и удалять его в корзину (см. ctxmem:save / ctxmem:delete).
const CTXMEM_MAX_FILES = 500;          // защита от абсурдного каталога: читаем не больше стольких файлов
const CTXMEM_MAX_BYTES = 512 * 1024;   // и не больше стольких байт на файл (память — мелкие заметки)
function ctxmemDir(projPath) {
  return projPath ? path.join(CLAUDE_PROJECTS_DIR, ctxmineEnc(projPath), 'memory') : null;
}
// Мини-парсер фронтматтера: между парой строк «---» в начале файла. Нужны плоские ключи и ОДИН
// уровень вложенности (metadata:). Полноценный YAML тут избыточен, а js-yaml в прямых зависимостях
// нет — тянуть парсер ради пяти полей смысла нет.
function ctxmemFront(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { front: {}, body: t.trim() };
  const front = {}; let sub = null;
  const unq = (v) => {
    const s = String(v).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  };
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    if (indent.length === 0) { // ключ верхнего уровня
      if (raw.trim() === '') { sub = front[key] = {}; } else { front[key] = unq(raw); sub = null; }
    } else if (sub) { sub[key] = unq(raw); }
  }
  return { front, body: t.slice(m[0].length).trim() };
}
// Строка индекса MEMORY.md: «- [Заголовок](файл.md) — крючок».
function ctxmemIndex(text) {
  const rows = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[(.+?)\]\((.+?)\)\s*(?:—|–|-)?\s*(.*)$/);
    if (m) rows.push({ title: m[1].trim(), file: m[2].trim(), hook: (m[3] || '').trim() });
  }
  return rows;
}
ipcMain.handle('ctxmem:list', (_e, { projPath, scope } = {}) => {
  const base = scope === 'home' ? os.homedir() : projPath;
  const dir = ctxmemDir(base);
  if (!dir) return { ok: true, exists: false, dir: null, base: base || '', items: [], index: [], orphans: [], missing: [] };
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); }
  catch (_) { return { ok: true, exists: false, dir, base, items: [], index: [], orphans: [], missing: [] }; }
  const idxName = names.find((f) => f === 'MEMORY.md');
  let index = [], indexChars = 0;
  if (idxName) {
    try {
      const raw = fs.readFileSync(path.join(dir, idxName), 'utf8');
      index = ctxmemIndex(raw);
      indexChars = raw.length; // именно СИМВОЛЫ, как и chars тел: иначе кириллица в байтах завысит оценку вдвое
    } catch (_) {}
  }
  const items = [];
  let truncated = false;
  for (const f of names.filter((f) => f !== 'MEMORY.md').sort()) {
    if (items.length >= CTXMEM_MAX_FILES) { truncated = true; break; }
    const fp = path.join(dir, f);
    let st, text;
    try {
      st = fs.statSync(fp);
      if (!st.isFile()) continue;
      text = st.size > CTXMEM_MAX_BYTES ? null : fs.readFileSync(fp, 'utf8');
    } catch (_) { continue; }
    if (text == null) { // слишком большой — показываем строкой, но не грузим в память
      items.push({ file: f, name: f.replace(/\.md$/i, ''), description: '', type: '', body: '', links: [], chars: st.size, mtime: st.mtimeMs, tooBig: true });
      continue;
    }
    const { front, body } = ctxmemFront(text);
    const meta = (front.metadata && typeof front.metadata === 'object') ? front.metadata : {};
    items.push({
      file: f,
      name: String(front.name || f.replace(/\.md$/i, '')),
      description: String(front.description || ''),
      type: String(meta.type || ''),
      modified: String(meta.modified || ''),
      session: String(meta.originSessionId || ''),
      body,
      links: [...new Set((body.match(/\[\[([^\]]+)\]\]/g) || []).map((x) => x.slice(2, -2).trim()))],
      chars: text.length,
      mtime: st.mtimeMs,
    });
  }
  // расхождения индекса и файлов — ровно то, чего не видно, пока не сверишь руками
  const files = new Set(items.map((i) => i.file));
  const linked = new Set(index.map((r) => r.file));
  const orphans = items.filter((i) => !linked.has(i.file)).map((i) => i.file);   // файл есть, в индексе нет
  const missing = index.filter((r) => !files.has(r.file)).map((r) => r.file);    // в индексе есть, файла нет
  // Ссылка [[…]] указывает на СЛАГ `name:` из фронтматтера, и он совпадает с именем файла далеко
  // не всегда (в реальной памяти расходится примерно у каждого шестого факта). Поэтому цель ссылки
  // ищем и по имени файла, и по name — иначе живые связи метились «битыми».
  const names2 = new Set();
  for (const i of items) { names2.add(i.file.replace(/\.md$/i, '')); if (i.name) names2.add(String(i.name)); }
  for (const it of items) it.broken = it.links.filter((l) => !names2.has(l));    // битые [[ссылки]]
  return { ok: true, exists: true, dir, base, indexChars, hasIndex: !!idxName, items, index, orphans, missing, truncated };
});
// --- Корзина памяти -------------------------------------------------------------------------
// Claude Code сам ничего не удаляет, а стирать факты насовсем страшно: часть из них — единственный
// след давнего решения. Поэтому удаление = перенос в ~/.claude/custom-trash-memory (общая на все
// проекты) + вырезание строки из MEMORY.md, чтобы индекс не разъехался с файлами. В trash.json
// помним, откуда файл, как звучала его строка индекса и на какой позиции она стояла — этого хватает,
// чтобы восстановление вернуло и файл, и запись в индексе на прежнее место.
const CTXMEM_TRASH = path.join(os.homedir(), '.claude', 'custom-trash-memory');
const ctxmemTrashIndex = () => path.join(CTXMEM_TRASH, 'trash.json');
function ctxmemTrashLoad() {
  try { const d = JSON.parse(fs.readFileSync(ctxmemTrashIndex(), 'utf8')); if (d && Array.isArray(d.list)) return d; } catch (_) {}
  return { list: [] };
}
function ctxmemTrashSave(d) { fs.mkdirSync(CTXMEM_TRASH, { recursive: true }); atomicWriteSync(ctxmemTrashIndex(), JSON.stringify(d, null, 1)); }
// Вырезать/вставить строку файла в MEMORY.md. Возвращает {line, pos} — что было вырезано и откуда.
function ctxmemIndexCut(dir, file) {
  const f = path.join(dir, 'MEMORY.md');
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { return { line: '', pos: -1 }; }
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const pos = lines.findIndex((l) => { const m = l.match(/^\s*[-*]\s*\[.+?\]\((.+?)\)/); return m && m[1].trim() === file; });
  if (pos < 0) return { line: '', pos: -1 };
  const line = lines[pos];
  lines.splice(pos, 1);
  atomicWriteSync(f, lines.join('\n'));
  return { line, pos };
}
function ctxmemIndexPut(dir, line, pos) {
  if (!line) return;
  const f = path.join(dir, 'MEMORY.md');
  let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) {}
  const lines = raw ? raw.replace(/\r\n?/g, '\n').split('\n') : [];
  if (lines.some((l) => l.trim() === line.trim())) return; // уже на месте — не плодим дубль
  const at = (pos >= 0 && pos <= lines.length) ? pos : lines.length;
  lines.splice(at, 0, line);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(f, lines.join('\n'));
}
ipcMain.handle('ctxmem:delete', (_e, { projPath, scope, file } = {}) => {
  if (!file || /[\\/]/.test(String(file))) return { ok: false, error: 'плохое имя файла' };
  if (String(file) === 'MEMORY.md') return { ok: false, error: 'индекс MEMORY.md удалять нельзя' };
  const base = scope === 'home' ? os.homedir() : projPath;
  const dir = ctxmemDir(base);
  if (!dir) return { ok: false, error: 'нет каталога памяти' };
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) return { ok: false, error: 'файла уже нет' };
  try {
    fs.mkdirSync(CTXMEM_TRASH, { recursive: true });
    const id = 'tm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const dst = path.join(CTXMEM_TRASH, id + '.md');
    const text = fs.readFileSync(src, 'utf8');
    const cut = ctxmemIndexCut(dir, file);          // сначала индекс — иначе при сбое останется запись без файла
    fs.writeFileSync(dst, text);
    fs.rmSync(src, { force: true });
    const d = ctxmemTrashLoad();
    const { front } = ctxmemFront(text);
    d.list.push({ id, file, name: String(front.name || file.replace(/\.md$/i, '')), dir, base: base || '', scope: scope === 'home' ? 'home' : 'project', ts: Date.now(), chars: text.length, indexLine: cut.line, indexPos: cut.pos });
    ctxmemTrashSave(d);
    return { ok: true, id, trashDir: CTXMEM_TRASH };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('ctxmem:trash', () => {
  const d = ctxmemTrashLoad();
  // Помечаем записи, чей файл в корзине пропал (кто-то почистил папку руками) — восстановить их нечем.
  const list = d.list.map((r) => ({ ...r, gone: !fs.existsSync(path.join(CTXMEM_TRASH, r.id + '.md')) })).sort((a, b) => b.ts - a.ts);
  return { ok: true, dir: CTXMEM_TRASH, list };
});
// --- Файлы настроек Claude Code (вкладка «Файлы» модуля «Контекст») ---------------------------
// Две области: ПРОЕКТ = <proj>/.claude (+ сам CLAUDE.md проекта в корне) и ГЛОБАЛЬНО = ~/.claude.
// В ~/.claude лежат сотни мегабайт служебного (projects/ 115 МБ, security/ ~300 МБ, plugins/, cache/) —
// это НЕ настройки, и в дерево они не попадают: показываем только то, чем настраивают агента.
// Всё чтение/запись зажаты внутри корня области (см. ctxfsResolve) — путь из рендерера недоверенный.
const CTXFS_SKIP = new Set(['projects', 'security', 'plugins', 'cache', 'file-history', 'session-env',
  'daemon', 'jobs', 'backups', 'downloads', 'paste-cache', 'ide', 'sessions', 'shell-snapshots',
  'custom-backups', 'custom-trash-memory', 'memory', 'node_modules', '.git', 'statsig', 'todos']);
const CTXFS_EDIT_MAX = 512 * 1024;  // до этого размера файл правится целиком
const CTXFS_WINDOW = 128 * 1024;    // окно постраничного ЧТЕНИЯ больших файлов (фронт держит ≤3 окна)
const CTXFS_MAX_NODES = 2000;       // предохранитель обхода
// Корень области. project → <proj>/.claude, home → ~/.claude.
function ctxfsRoot(scope, projPath) {
  if (scope === 'home') return path.join(os.homedir(), '.claude');
  return projPath ? path.join(projPath, '.claude') : null;
}
// Относительный путь из рендерера → абсолютный ВНУТРИ корня. Любая попытка выйти наружу
// (../, абсолютный путь, симлинк за пределы) — отказ.
function ctxfsResolve(root, rel) {
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (r.includes('\0')) return null;
  const abs = path.resolve(root, r);
  const rootRes = path.resolve(root);
  if (abs !== rootRes && !abs.startsWith(rootRes + path.sep)) return null;
  try { // симлинк наружу корня режем по фактическому пути
    if (fs.existsSync(abs)) {
      const real = fs.realpathSync(abs), realRoot = fs.realpathSync(rootRes);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    }
  } catch (_) {}
  return abs;
}
function ctxfsWalk(dir, rel, out, depth) {
  if (depth > 6 || out.length >= CTXFS_MAX_NODES) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'ru') : (a.isDirectory() ? -1 : 1)));
  for (const e of ents) {
    if (out.length >= CTXFS_MAX_NODES) return;
    if (CTXFS_SKIP.has(e.name)) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ rel: childRel, name: e.name, dir: true, items: 0, size: 0 });
      ctxfsWalk(abs, childRel, out, depth + 1);
    } else if (e.isFile()) {
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      out.push({ rel: childRel, name: e.name, dir: false, size: st.size, mtime: st.mtimeMs, editable: st.size <= CTXFS_EDIT_MAX });
    }
  }
}
// Папке приписываем, сколько внутри объектов и сколько это весит суммарно (по всей глубине):
// без этого дерево не отвечает на простой вопрос «а что там внутри и много ли».
function ctxfsAggregate(nodes) {
  // Одним проходом: каждый узел добавляет себя всем своим предкам. Раньше здесь был двойной цикл
  // (папка × все узлы) — на предельных 2000 узлах это 4 млн сравнений строк на каждое открытие вкладки.
  const dirs = new Map();
  for (const n of nodes) if (n.dir) { n.items = 0; n.size = 0; dirs.set(n.rel, n); }
  for (const n of nodes) {
    const parts = n.rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = dirs.get(parts.slice(0, i).join('/'));
      if (!d) continue;
      d.items++;
      if (!n.dir) d.size += (n.size || 0);
    }
  }
}
ipcMain.handle('ctxfs:tree', (_e, { scope, projPath } = {}) => {
  const root = ctxfsRoot(scope, projPath);
  if (!root) return { ok: true, exists: false, root: null, nodes: [], extra: [] };
  const nodes = [];
  const exists = fs.existsSync(root);
  if (exists) ctxfsWalk(root, '', nodes, 0);
  ctxfsAggregate(nodes);
  // CLAUDE.md лежит РЯДОМ с .claude, а не внутри — но правят его чаще всего, поэтому показываем
  // его отдельной записью сверху (в проекте — корневой, глобально — ~/.claude/CLAUDE.md уже в дереве).
  const extra = [];
  if (scope !== 'home' && projPath) {
    const f = path.join(projPath, 'CLAUDE.md');
    if (fs.existsSync(f)) {
      let st = null; try { st = fs.statSync(f); } catch (_) {}
      extra.push({ rel: '../CLAUDE.md', name: 'CLAUDE.md', dir: false, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, outside: true, editable: !st || st.size <= CTXFS_EDIT_MAX });
    }
  }
  return { ok: true, exists, root, nodes, extra, truncated: nodes.length >= CTXFS_MAX_NODES, editMax: CTXFS_EDIT_MAX, window: CTXFS_WINDOW };
});
// Чтение. rel === '../CLAUDE.md' — единственный разрешённый выход за корень (файл проекта).
function ctxfsTarget(scope, projPath, rel) {
  if (rel === '../CLAUDE.md') return (scope !== 'home' && projPath) ? path.join(projPath, 'CLAUDE.md') : null;
  const root = ctxfsRoot(scope, projPath);
  return root ? ctxfsResolve(root, rel) : null;
}
// Чтение файла ОКНОМ: [offset, offset+limit) байт, границы подтянуты к переводам строк, чтобы
// кусок не рвался посреди строки. Большой файл так открывается без загрузки целиком в память —
// фронт держит максимум три соседних окна и выбрасывает уехавшие.
ipcMain.handle('ctxfs:read', (_e, { scope, projPath, rel, offset, limit } = {}) => {
  const abs = ctxfsTarget(scope, projPath, rel);
  if (!abs) return { ok: false, error: 'путь вне разрешённой папки' };
  let st;
  try { st = fs.statSync(abs); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  if (!st.isFile()) return { ok: false, error: 'это не файл' };
  const size = st.size;
  const whole = size <= CTXFS_EDIT_MAX && offset == null;
  const from = Math.max(0, Math.min(size, Number(offset) || 0));
  const want = whole ? size : Math.max(4096, Math.min(CTXFS_WINDOW, Number(limit) || CTXFS_WINDOW));
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const len = Math.min(want, Math.max(0, size - from));
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    // Границы окна двигаем в БАЙТАХ по самому буферу: считать смещения через длину строки нельзя —
    // в UTF-8 символ занимает 1–4 байта, и start/end разъехались бы с реальным файлом.
    let lo = 0, hi = len;
    if (!whole) {
      // Начало окна режем ТОЛЬКО если оно попало в середину строки. Когда предыдущее окно кончилось
      // ровно после \n (обычный случай стыковки), from уже стоит на начале строки — и срезать первую
      // строку нельзя: именно так при склейке терялось по строке на каждом стыке.
      if (from > 0) {
        let atLineStart = false;
        try { const pb = Buffer.alloc(1); fs.readSync(fd, pb, 0, 1, from - 1); atLineStart = pb[0] === 0x0a; } catch (_) {}
        if (!atLineStart) { const nl = buf.indexOf(0x0a); if (nl >= 0) lo = nl + 1; }
      }
      if (from + len < size) { const nl = buf.lastIndexOf(0x0a); if (nl >= lo) hi = nl + 1; } // не заканчиваем обрывком
      if (hi <= lo) { lo = 0; hi = len; }   // строка длиннее окна — отдаём как есть, иначе зациклимся
    }
    const text = buf.slice(lo, hi).toString('utf8');
    const start = from + lo, end = from + hi;
    return { ok: true, text, file: abs, size, mtime: st.mtimeMs, start, end,
      eof: end >= size, bof: start <= 0, whole, editable: size <= CTXFS_EDIT_MAX, window: CTXFS_WINDOW };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
});
// --- Создание артефактов из правил «Анализа диалогов» -----------------------------------------
// Скилл и команда — это ФАЙЛЫ с обязательной структурой, их нельзя «дописать буллетом», поэтому
// модуль создаёт заготовку сам: слаг из названия правила, фронтматтер по формату Claude Code, тело
// из формулировки. Хук трогать автоматически НЕ будем — он живёт внутри settings.json со своей
// схемой, и вслепую патчить чужой конфиг опаснее, чем открыть его человеку (см. ctxfs:hookStub).
const CTXFS_ART = {
  skill: (root, slug) => path.join(root, 'skills', slug, 'SKILL.md'),
  command: (root, slug) => path.join(root, 'commands', slug + '.md'),
};
function ctxfsSlug(s) {
  const base = String(s || '').toLowerCase()
    .replace(/[а-яё]/g, (c) => ({ а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }[c] || ''))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'rule';
}
// Есть ли уже такой артефакт (для пометки «уже создан» в реестре правил).
ipcMain.handle('ctxfs:artifactState', (_e, { scope, projPath, items } = {}) => {
  const root = ctxfsRoot(scope === 'home' ? 'home' : 'project', projPath);
  const out = {};
  for (const it of (Array.isArray(items) ? items : [])) {
    const kind = it && it.kind, slug = ctxfsSlug(it && (it.slug || it.title));
    const mk = CTXFS_ART[kind];
    if (!root || !mk) { out[(it && it.key) || ''] = { slug, exists: false }; continue; }
    const f = mk(root, slug);
    out[(it && it.key) || ''] = { slug, exists: fs.existsSync(f), file: f };
  }
  return { ok: true, root, states: out };
});
ipcMain.handle('ctxfs:createArtifact', (_e, { scope, projPath, kind, slug, title, detail, evidence } = {}) => {
  const mk = CTXFS_ART[kind];
  if (!mk) return { ok: false, error: 'такой артефакт модуль не создаёт' };
  const root = ctxfsRoot(scope === 'home' ? 'home' : 'project', projPath);
  if (!root) return { ok: false, error: 'нет корня .claude' };
  const sl = ctxfsSlug(slug || title);
  const file = mk(root, sl);
  if (fs.existsSync(file)) return { ok: false, error: 'такой файл уже есть: ' + file, exists: true, file };
  const name = String(title || sl).trim();
  const body = String(detail || '').trim();
  const why = String(evidence || '').trim();
  const text = kind === 'skill'
    ? `---\nname: ${sl}\ndescription: ${JSON.stringify(name)}\n---\n\n# ${name}\n\n${body || 'Опишите процедуру по шагам.'}\n\n`
      + `## Когда применять\n\n${why || 'Опишите, в какой ситуации агент должен взять этот скилл.'}\n\n`
      + `## Шаги\n\n1. \n2. \n\n<!-- Заготовка создана модулем «Контекст» из правила, найденного в истории диалогов. Допишите шаги. -->\n`
    : `---\ndescription: ${JSON.stringify(name)}\n---\n\n${body || name}\n\n`
      + `<!-- Заготовка команды создана модулем «Контекст». Опишите, что именно должен сделать агент. -->\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteSync(file, text);
    return { ok: true, file, slug: sl, rel: path.relative(root, file).split(path.sep).join('/') };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Заготовка хука: НЕ пишем в settings.json сами (там чужая схема и чужие настройки),
// а отдаём готовый кусок JSON — человек вставит его в открытый рядом редактор.
ipcMain.handle('ctxfs:hookStub', (_e, { title, detail } = {}) => {
  const stub = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `echo ${JSON.stringify(String(title || 'правило'))}` }],
      }],
    },
  };
  return { ok: true, text: JSON.stringify(stub, null, 2), note: String(detail || '') };
});
// Проверка синтаксиса shell-файла: `bash -n` только РАЗБИРАЕТ скрипт и ничего из него не выполняет.
ipcMain.handle('ctxfs:shcheck', async (_e, { scope, projPath, rel } = {}) => {
  const abs = ctxfsTarget(scope, projPath, rel);
  if (!abs) return { ok: false, error: 'путь вне разрешённой папки' };
  return await new Promise((resolve) => {
    execFile('bash', ['-n', abs], { timeout: 8000 }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true, clean: true });
      resolve({ ok: true, clean: false, message: String(stderr || (err && err.message) || '').trim().slice(0, 2000) });
    });
  });
});

ipcMain.handle('ctxfs:write', (_e, { scope, projPath, rel, text } = {}) => {
  const abs = ctxfsTarget(scope, projPath, rel);
  if (!abs) return { ok: false, error: 'путь вне разрешённой папки' };
  const body = String(text == null ? '' : text);
  if (Buffer.byteLength(body, 'utf8') > CTXFS_EDIT_MAX) return { ok: false, error: 'слишком большой текст' };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const backup = ctxbkPush(abs, 'claude-file');
    atomicWriteSync(abs, body);
    return { ok: true, file: abs, chars: body.length, backup };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Сырой текст одного файла памяти (для редактора: правится ВЕСЬ файл, включая фронтматтер —
// в списке тела приходят уже без него). Отдельной ручкой, чтобы не таскать сырьё всех 50 файлов.
ipcMain.handle('ctxmem:read', (_e, { projPath, scope, file } = {}) => {
  if (!file || /[\\/]/.test(String(file))) return { ok: false, error: 'плохое имя файла' };
  const dir = ctxmemDir(scope === 'home' ? os.homedir() : projPath);
  if (!dir) return { ok: false, error: 'нет каталога памяти' };
  const abs = path.join(dir, file);
  try { return { ok: true, text: fs.readFileSync(abs, 'utf8'), file: abs }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Сохранение файла памяти (правка из вкладки «Память»). Пишем ровно то, что дал пользователь:
// фронтматтер — часть текста, редактор его видит и правит целиком. Перед записью — бэкап.
ipcMain.handle('ctxmem:save', (_e, { projPath, scope, file, text } = {}) => {
  if (!file || /[\\/]/.test(String(file)) || !String(file).toLowerCase().endsWith('.md')) return { ok: false, error: 'плохое имя файла' };
  const base = scope === 'home' ? os.homedir() : projPath;
  const dir = ctxmemDir(base);
  if (!dir) return { ok: false, error: 'нет каталога памяти' };
  const target = path.join(dir, file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const backup = ctxbkPush(target, 'memory');
    atomicWriteSync(target, String(text == null ? '' : text));
    return { ok: true, chars: String(text == null ? '' : text).length, backup };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// --- Бэкапы правок (общие для памяти и файлов .claude) ---------------------------------------
// Всё, что модуль «Контекст» ПЕРЕЗАПИСЫВАЕТ, сначала откладывается копией в ~/.claude/custom-backups.
// Хранилище плоское: <id>.bak + index.json; на каждый исходный путь держим CTXBK_KEEP последних,
// лишние удаляются (ротация). Это не история версий, а страховка «откатить последнюю глупость».
const CTXBK_DIR = path.join(os.homedir(), '.claude', 'custom-backups');
const CTXBK_KEEP = 10;
const ctxbkIndex = () => path.join(CTXBK_DIR, 'index.json');
function ctxbkLoad() {
  try { const d = JSON.parse(fs.readFileSync(ctxbkIndex(), 'utf8')); if (d && Array.isArray(d.list)) return d; } catch (_) {}
  return { list: [] };
}
function ctxbkSave(d) { fs.mkdirSync(CTXBK_DIR, { recursive: true }); atomicWriteSync(ctxbkIndex(), JSON.stringify(d, null, 1)); }
// Снять копию файла ПЕРЕД перезаписью. Нет файла (создаём новый) — бэкапить нечего.
function ctxbkPush(file, kind) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  try {
    fs.mkdirSync(CTXBK_DIR, { recursive: true });
    const id = 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    fs.writeFileSync(path.join(CTXBK_DIR, id + '.bak'), text);
    const d = ctxbkLoad();
    d.list.push({ id, file, kind: kind || '', ts: Date.now(), chars: text.length });
    // ротация: у каждого пути остаются CTXBK_KEEP свежих копий
    const mine = d.list.filter((r) => r.file === file).sort((a, b) => b.ts - a.ts);
    for (const old of mine.slice(CTXBK_KEEP)) {
      try { fs.rmSync(path.join(CTXBK_DIR, old.id + '.bak'), { force: true }); } catch (_) {}
      d.list = d.list.filter((r) => r.id !== old.id);
    }
    ctxbkSave(d);
    return id;
  } catch (_) { return null; }
}
ipcMain.handle('ctxbk:list', (_e, { file } = {}) => {
  const d = ctxbkLoad();
  const list = d.list
    .filter((r) => !file || r.file === file)
    .map((r) => ({ ...r, gone: !fs.existsSync(path.join(CTXBK_DIR, r.id + '.bak')) }))
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, dir: CTXBK_DIR, keep: CTXBK_KEEP, list };
});
ipcMain.handle('ctxbk:read', (_e, { id } = {}) => {
  const d = ctxbkLoad();
  const rec = d.list.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'копии нет в списке' };
  try { return { ok: true, text: fs.readFileSync(path.join(CTXBK_DIR, id + '.bak'), 'utf8'), rec }; }
  catch (e) { return { ok: false, error: 'копия пропала с диска' }; }
});
// Восстановление = обычная запись поверх (и она, в свою очередь, тоже сначала делает бэкап,
// поэтому «откатил и передумал» не теряет текущую версию).
ipcMain.handle('ctxbk:restore', (_e, { id } = {}) => {
  const d = ctxbkLoad();
  const rec = d.list.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'копии нет в списке' };
  let text; try { text = fs.readFileSync(path.join(CTXBK_DIR, id + '.bak'), 'utf8'); } catch (_) { return { ok: false, error: 'копия пропала с диска' }; }
  try {
    fs.mkdirSync(path.dirname(rec.file), { recursive: true });
    ctxbkPush(rec.file, rec.kind);
    atomicWriteSync(rec.file, text);
    return { ok: true, file: rec.file, chars: text.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('ctxmem:restore', (_e, { id } = {}) => {
  const d = ctxmemTrashLoad();
  const rec = d.list.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'записи нет в корзине' };
  const src = path.join(CTXMEM_TRASH, rec.id + '.md');
  if (!fs.existsSync(src)) return { ok: false, error: 'файл из корзины пропал — восстанавливать нечего' };
  const dst = path.join(rec.dir, rec.file);
  if (fs.existsSync(dst)) return { ok: false, error: 'файл с таким именем уже есть — сначала разберитесь с ним' };
  try {
    fs.mkdirSync(rec.dir, { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src, 'utf8'));
    ctxmemIndexPut(rec.dir, rec.indexLine, rec.indexPos);
    fs.rmSync(src, { force: true });
    d.list = d.list.filter((r) => r.id !== id);
    ctxmemTrashSave(d);
    return { ok: true, file: dst };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ---------------------------------------------------------------- «ИИ компания» (company)
// Модуль renderer/modules/company.js: агент-ДИРЕКТОР (claude -p, stream-json) над активным
// проектом нанимает и зовёт сабагентов Claude (родная оркестровка, вариант А). Штат/настройки
// per-project в ~/.LiteEditorAI/company/<projId>.json; роли-сотрудники МАТЕРИАЛИЗУЮТСЯ в
// <proj>/.claude/agents/*.md (Claude понимает их нативно). Шина — доска-файл
// <proj>/.lite/company/board.md (виден владельцу и команде). Поток событий stream-json
// уходит в окно-владелец как company:event/done/error. Директор cwd = корень проекта,
// иначе Claude не увидит .claude/agents/.
const companyDir = path.join(storeDir, 'company');
const companySafe = (s) => String(s).replace(/[^\w.-]/g, '_');
const companyDataFile = (projId) => path.join(companyDir, companySafe(projId) + '.json');

ipcMain.handle('company:getData', (_e, { projId } = {}) => {
  try { return JSON.parse(fs.readFileSync(companyDataFile(projId), 'utf8')); } catch { return null; }
});
ipcMain.handle('company:setData', (_e, { projId, data } = {}) => {
  try {
    fs.mkdirSync(companyDir, { recursive: true });
    atomicWriteSync(companyDataFile(projId), JSON.stringify(data));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});
// Текущая доска компании из проекта (read-only для UI).
ipcMain.handle('company:boardGet', (_e, { projPath } = {}) => {
  try { return { text: fs.readFileSync(path.join(projPath, '.lite', 'company', 'board.md'), 'utf8') }; }
  catch { return { text: '' }; }
});
// Разбор сабагента .claude/agents/<name>.md в роль (для отображения штата, в т.ч. нанятых директором).
function companyParseRole(raw, file) {
  const role = { name: file.replace(/\.md$/, ''), description: '', model: '', tools: '', prompt: (raw || '').trim(), source: 'disk' };
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw || '');
  if (m) {
    role.prompt = m[2].trim();
    for (const ln of m[1].split('\n')) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(ln.trim());
      if (!kv) continue;
      const v = kv[2].replace(/^["']|["']$/g, '');
      if (kv[1] === 'name') role.name = v;
      else if (kv[1] === 'description') role.description = v;
      else if (kv[1] === 'model') role.model = v;
      else if (kv[1] === 'tools') role.tools = v;
    }
  }
  return role;
}
ipcMain.handle('company:listRoles', (_e, { projPath } = {}) => {
  try {
    const agDir = path.join(projPath, '.claude', 'agents');
    const roles = [];
    for (const f of fs.readdirSync(agDir)) {
      if (!f.endsWith('.md')) continue;
      try { roles.push(companyParseRole(fs.readFileSync(path.join(agDir, f), 'utf8'), f)); } catch (_) {}
    }
    return { roles };
  } catch { return { roles: [] }; }
});
// Роль штата → markdown-сабагент Claude.
function companyRoleMd(role) {
  const L = ['---', 'name: ' + companySafe(role.name), 'description: ' + JSON.stringify(role.description || '')];
  if (role.model) L.push('model: ' + role.model);
  if ((role.tools || '').trim()) L.push('tools: ' + role.tools.trim());
  L.push('---', '', (role.prompt || '').trim(), '');
  return L.join('\n');
}
// Система-промпт директора: роль, цель, команда, правила доски, право нанимать, память компании.
function companyDirectorPrompt(goal, roles, notes) {
  const team = (roles || []).filter((r) => r && r.name).map((r) => '- ' + companySafe(r.name) + ': ' + (r.description || '')).join('\n');
  const L = [
    'Ты — ДИРЕКТОР ИИ-компании, работающей над ЭТИМ проектом. Твоя задача — не писать код самому,',
    'а управлять командой ИИ-сотрудников (сабагентов) и довести цель владельца до результата.',
    '',
    'ТВОЯ КОМАНДА — вызывай их как сабагентов (механизм Task) по имени и описанию:',
    (team || '- (сотрудников ещё нет — наними нужных)'),
  ];
  if ((notes || '').trim()) {
    L.push('', 'ПАМЯТЬ КОМПАНИИ (уроки и договорённости по этому проекту — учитывай их):', notes.trim());
  }
  L.push(
    '',
    'ПРАВИЛА:',
    '1. Веди доску задач в файле .lite/company/board.md (создай каталоги при необходимости).',
    '   Формат — markdown чек-лист (- [ ] задача / - [x] сделано). Сразу после декомпозиции запиши',
    '   ВСЕ задачи на доску чекбоксами, по ходу отмечай выполненные. Это общий журнал для владельца и команды.',
    '2. Декомпозируй цель на задачи и делегируй их подходящим сотрудникам-сабагентам. Сам пиши код',
    '   только если задача совсем тривиальна.',
    '3. Нет нужного специалиста — НАНИМИ его: создай файл .claude/agents/<имя>.md с YAML-шапкой',
    '   (name, description, tools, model) и системным промптом роли, затем вызывай как сабагента.',
    '4. По завершении допиши в .lite/company/notes.md краткие уроки на будущее (стек проекта, договорённости,',
    '   грабли) — это память компании между прогонами. Не дублируй уже записанное.',
    '5. В конце кратко отчитайся владельцу: что сделано, что осталось, что проверить.',
    '6. Пиши по-русски.',
  );
  return L.join('\n');
}
// Память компании (.lite/company/notes.md) и обзор изменений (git diff --stat) — отдельные каналы.
function companyNotesPath(projPath) { return path.join(projPath, '.lite', 'company', 'notes.md'); }
ipcMain.handle('company:notesGet', (_e, { projPath } = {}) => {
  try { return { text: fs.readFileSync(companyNotesPath(projPath), 'utf8') }; } catch { return { text: '' }; }
});
ipcMain.handle('company:notesSet', (_e, { projPath, text } = {}) => {
  try {
    fs.mkdirSync(path.dirname(companyNotesPath(projPath)), { recursive: true });
    atomicWriteSync(companyNotesPath(projPath), String(text || ''));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('company:diff', async (_e, { projPath } = {}) => {
  try {
    const stat = await git(projPath, ['diff', '--stat']);
    const names = await git(projPath, ['diff', '--name-only']);
    if (stat == null && names == null) return { ok: false, error: 'git недоступен' };
    return { ok: true, stat: stat || '', files: (names || '').split('\n').map((s) => s.trim()).filter(Boolean) };
  } catch (e) { return { ok: false, error: String(e) }; }
});

const companyReqs = new Map(); // reqId -> ChildProcess
// Убить директора вместе с деревом подпроцессов (process group), иначе Stop оставит сирот, жгущих бюджет.
function companyKill(child) {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch (_) { try { child.kill(); } catch (_) {} }
}
ipcMain.on('company:run', (e, { reqId, projPath, goal, roles, director, limitUsd, permission, memoryOn } = {}) => {
  const sender = e.sender;
  if (!projPath) { safeSend(sender, 'company:error', { reqId, error: 'нет активного проекта' }); return; }
  // материализуем штат в .claude/agents/ (нативные сабагенты)
  try {
    const agDir = path.join(projPath, '.claude', 'agents');
    fs.mkdirSync(agDir, { recursive: true });
    for (const r of (roles || [])) {
      if (!r || !r.name) continue;
      atomicWriteSync(path.join(agDir, companySafe(r.name) + '.md'), companyRoleMd(r));
    }
  } catch (err) { safeSend(sender, 'company:error', { reqId, error: 'не записать роли: ' + (err.message || err) }); return; }

  let notes = '';
  if (memoryOn) { try { notes = fs.readFileSync(companyNotesPath(projPath), 'utf8'); } catch (_) {} }
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', permission || 'acceptEdits',
    '--append-system-prompt', companyDirectorPrompt(goal, roles, notes)];
  if (limitUsd) args.push('--max-budget-usd', String(limitUsd));
  if (director && director.model) args.push('--model', director.model);

  let child;
  // detached → свой process group: убиваем всё дерево (директор + его tool-подпроцессы), а не только claude.
  try { child = spawn('claude', args, { cwd: projPath, env: tpEnv(), detached: process.platform !== 'win32' }); }
  catch (err) { safeSend(sender, 'company:error', { reqId, error: 'не запустить «claude»: ' + (err.message || err) }); return; }
  companyReqs.set(reqId, child);
  let buf = '', errOut = '';
  // сторож простоя: директор может думать долго, но если МОЛЧИТ 15 минут — считаем зависшим
  let idle;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => {
    if (!companyReqs.has(reqId)) return; companyReqs.delete(reqId); companyKill(child);
    safeSend(sender, 'company:error', { reqId, error: 'таймаут: директор молчит 15 минут' });
  }, 15 * 60 * 1000); };
  bump();
  const emitLine = (line) => { const s = line.trim(); if (!s) return; let ev; try { ev = JSON.parse(s); } catch (_) { return; } safeSend(sender, 'company:event', { reqId, ev }); };
  // stream-json идёт построчно (NDJSON) — режем по \n, парсим, шлём событиями
  child.stdout.on('data', (c) => {
    bump();
    buf += c.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { emitLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  child.stderr.on('data', (c) => { bump(); errOut += c.toString('utf8'); });
  child.stdin.on('error', () => {}); // claude не стартовал → async EPIPE на stdin не должен ронять main
  child.on('error', (err) => {
    if (!companyReqs.has(reqId)) return; companyReqs.delete(reqId); clearTimeout(idle);
    safeSend(sender, 'company:error', { reqId, error: '«claude» не найден/не запустился: ' + (err.message || err) });
  });
  child.on('close', (code) => {
    if (!companyReqs.has(reqId)) return; companyReqs.delete(reqId); clearTimeout(idle);
    if (buf.trim()) emitLine(buf);   // флаш хвоста: финальный {type:'result'} может прийти без \n
    safeSend(sender, 'company:done', { reqId, code, error: code ? (errOut.trim() || ('claude завершился с кодом ' + code)) : '' });
  });
  try { child.stdin.write(goal || ''); child.stdin.end(); } catch (_) {}
});
ipcMain.on('company:stop', (_e, { reqId } = {}) => {
  const c = companyReqs.get(reqId);
  if (c) { companyReqs.delete(reqId); companyKill(c); }
});

// ---------------------------------------------------------------- «Контекст» (канва файла CLAUDE.md)
// Модуль renderer/modules/contextgraph.js: канва блоков поверх CLAUDE.md проекта.
//
// ⚠️ МОДЕЛЬ (переделана в v1.1.137): единственный носитель текста — САМ ФАЙЛ <proj>/CLAUDE.md.
// Раньше текст жил в blocks/<id>.md, а файл «собирался» из них — два носителя расходились, отсюда
// была нужна кнопка «Подтвердить», compiledHash и реконсиляция. Теперь:
//   • блок на канве = секция файла (режет фронт, splitToTree по заголовкам);
//   • модуль хранит ТОЛЬКО раскладку (позиции блоков) в graph.json;
//   • любая правка сразу пишет весь файл целиком (ctx:save) и снимает копию в историю.
// Профили и тумблеры блоков убраны там же: за всё время ими никто не пользовался.
//
// Хранение: ~/.LiteEditorAI/contextgraph/projects/<projId>/agents/claude/
//   graph.json — раскладка; points.json + points/<id>.md — история версий (50 незалоченных).
const ctxDir = path.join(storeDir, 'contextgraph');
const ctxSafe = (s) => String(s).replace(/[^\w.-]/g, '_');
const ctxProjDir = (projId) => path.join(ctxDir, 'projects', ctxSafe(projId));
const CTX_FILE = 'CLAUDE.md';
const CTX_KEEP = 50;                 // сколько НЕзалоченных версий держим (залоченные сверх лимита)
function ctxAgentDir(projId) { return path.join(ctxProjDir(projId), 'agents', 'claude'); }
function ctxGraphFile(projId) { return path.join(ctxAgentDir(projId), 'graph.json'); }
function ctxPointsFile(projId) { return path.join(ctxAgentDir(projId), 'points.json'); }
function ctxPointFile(projId, ptid) { return path.join(ctxAgentDir(projId), 'points', ctxSafe(ptid) + '.md'); }
// «Последнее, что модуль видел в файле». Нужен, чтобы правку ВНЕ модуля (агент дописал CLAUDE.md,
// человек поправил его в другом редакторе) можно было откатить: точку истории надо снять с ПРЕЖНЕГО
// содержимого, а его к моменту обнаружения в файле уже нет. Лежит на диске, а не в памяти, —
// иначе перезапуск редактора терял бы одну версию.
function ctxSeenFile(projId) { return path.join(ctxAgentDir(projId), 'seen.md'); }
function ctxSeenWrite(projId, text) {
  try { fs.mkdirSync(ctxAgentDir(projId), { recursive: true }); atomicWriteSync(ctxSeenFile(projId), String(text == null ? '' : text)); } catch (_) {}
}
function ctxReadFileSafe(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } }
const ctxTarget = (projPath) => path.join(projPath, CTX_FILE);
function ctxHash(s) { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return h + ':' + str.length; }

// --- Раскладка канвы -------------------------------------------------------------------------
// Миграция со старого формата: граф лежал в profiles/<id>.json, активный профиль — в profiles.json.
// Берём активный (или единственный) профиль как раскладку. Старые файлы НЕ удаляем — страховка.
function ctxLoadGraph(projId) {
  const g = ctxReadFileSafe(ctxGraphFile(projId));
  if (g != null) { try { return JSON.parse(g); } catch (_) {} }
  try {
    const ix = JSON.parse(fs.readFileSync(path.join(ctxAgentDir(projId), 'profiles.json'), 'utf8'));
    const id = (ix && ix.active) || (ix && ix.list && ix.list[0] && ix.list[0].id);
    if (id) {
      const old = JSON.parse(fs.readFileSync(path.join(ctxAgentDir(projId), 'profiles', ctxSafe(id) + '.json'), 'utf8'));
      const nodes = (old.nodes || []).filter((n) => n.type === 'text')
        .map((n) => ({ title: n.title || '', x: n.x || 0, y: n.y || 0 }));
      return { v: 2, layout: nodes, view: old.view || { x: 0, y: 0, z: 1 }, migrated: true };
    }
  } catch (_) {}
  return null;
}
function ctxSaveGraph(projId, graph) {
  const f = ctxGraphFile(projId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  atomicWriteSync(f, JSON.stringify(graph));
}

// --- История версий --------------------------------------------------------------------------
function ctxLoadPoints(projId) {
  try { const p = JSON.parse(fs.readFileSync(ctxPointsFile(projId), 'utf8')); if (p && Array.isArray(p.list)) return p; } catch (_) {}
  return { list: [] };
}
function ctxSavePoints(projId, p) { fs.mkdirSync(ctxAgentDir(projId), { recursive: true }); atomicWriteSync(ctxPointsFile(projId), JSON.stringify(p)); }
// Ротация: лимит считается ТОЛЬКО по незалоченным. Залоченные не удаляются и в счёт не идут —
// это и есть «отложить версию от ротации», о чём просил владелец.
function ctxRotatePoints(projId, p) {
  const free = p.list.filter((x) => !x.locked).sort((a, b) => b.ts - a.ts);
  for (const old of free.slice(CTX_KEEP)) {
    try { fs.rmSync(ctxPointFile(projId, old.id), { force: true }); } catch (_) {}
    p.list = p.list.filter((x) => x.id !== old.id);
  }
}
function ctxAddPoint(projId, name, content, opts = {}) {
  const p = ctxLoadPoints(projId);
  const id = 'pt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  fs.mkdirSync(path.dirname(ctxPointFile(projId, id)), { recursive: true });
  atomicWriteSync(ctxPointFile(projId, id), String(content == null ? '' : content));
  p.list.push({ id, name: String(name || 'Версия').slice(0, 60), ts: Date.now(), locked: !!opts.locked,
    note: String(opts.note || '').slice(0, 400), chars: String(content || '').length });
  ctxRotatePoints(projId, p);
  ctxSavePoints(projId, p);
  return { id, list: p.list };
}

// Всё состояние вкладки одним вызовом: текст файла + раскладка + версии.
ipcMain.handle('ctx:state', (_e, { projId, projPath } = {}) => {
  if (!projId || !projPath) return { ok: false, error: 'bad args' };
  const file = ctxTarget(projPath);
  const text = ctxReadFileSafe(file);
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
  const graph = ctxLoadGraph(projId) || { v: 2, layout: [], view: { x: 0, y: 0, z: 1 } };
  // Первое открытие после обновления модуля: снимаем копию ДО того, как канва что-то перестроит,
  // иначе прежнее содержимое файла нечем будет вернуть.
  // История — вспомогательная вещь: если её не удалось записать (нет прав, кончилось место),
  // это не повод не открыть модуль. Раньше исключение отсюда роняло весь ctx:state, и канва
  // не показывалась вовсе.
  try {
    const pts = ctxLoadPoints(projId);
    if (text != null && !pts.list.length) {
      ctxAddPoint(projId, 'Как было до модуля', text, { locked: true, note: 'снято автоматически при первом открытии' });
      ctxSeenWrite(projId, text);
    } else {
      // Файл изменился мимо модуля — прежнее содержимое иначе пропадёт безвозвратно.
      const seen = ctxReadFileSafe(ctxSeenFile(projId));
      if (text != null && seen != null && seen !== text) ctxAddPoint(projId, 'Правка вне модуля', seen, { note: 'файл изменили снаружи — это версия ДО правки' });
      if (text != null && seen !== text) ctxSeenWrite(projId, text);
    }
  } catch (e) { logger.log('error', 'ctx', 'история версий недоступна: ' + ((e && e.message) || e)); }
  return { ok: true, file, exists: text != null, text: text == null ? '' : text,
    chars: text ? text.length : 0, mtime, hash: ctxHash(text), graph, points: ctxLoadPoints(projId).list, keep: CTX_KEEP };
});
// Запись файла ЦЕЛИКОМ + копия в историю. Фронт собирает текст из блоков сам — он знает порядок.
ipcMain.handle('ctx:save', (_e, { projId, projPath, text, name, note, expectHash } = {}) => {
  if (!projId || !projPath) return { ok: false, error: 'bad args' };
  const file = ctxTarget(projPath);
  const body = String(text == null ? '' : text);
  const cur = ctxReadFileSafe(file);
  // Файл успели изменить снаружи между чтением и записью — не затираем молча.
  // Проверяем и случай cur == null: ctxHash(null) === ctxHash('') === '0:0', поэтому «файла не было
  // и нет» проходит, а «файла не было, но он появился» честно упирается в stale.
  if (expectHash && ctxHash(cur) !== expectHash) {
    return { ok: false, error: 'файл изменился снаружи — обновите канву', stale: true, text: cur, hash: ctxHash(cur) };
  }
  try {
    if (cur != null && cur !== body) ctxAddPoint(projId, name || 'Правка', cur, { note });  // копия ПРЕЖНЕГО содержимого
    else if (cur == null) ctxAddPoint(projId, name || 'Создание файла', body, { note });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteSync(file, body);
    ctxSeenWrite(projId, body);   // своя запись — не «правка снаружи»
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
    return { ok: true, file, chars: body.length, hash: ctxHash(body), mtime, points: ctxLoadPoints(projId).list };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Только раскладка — файл не трогаем (перетаскивание блоков по канве его не меняет).
ipcMain.handle('ctx:layout', (_e, { projId, graph } = {}) => {
  if (!projId || !graph) return { ok: false, error: 'bad args' };
  try { ctxSaveGraph(projId, graph); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('ctx:points', (_e, { projId } = {}) => {
  if (!projId) return { ok: false, error: 'no projId' };
  return { ok: true, list: ctxLoadPoints(projId).list, keep: CTX_KEEP };
});
ipcMain.handle('ctx:pointRead', (_e, { projId, id } = {}) => {
  const t = ctxReadFileSafe(ctxPointFile(projId, id));
  return { ok: t != null, text: t == null ? '' : t, exists: t != null, chars: t ? t.length : 0 };
});
ipcMain.handle('ctx:pointDelete', (_e, { projId, id } = {}) => {
  const p = ctxLoadPoints(projId);
  const pt = p.list.find((x) => x.id === id);
  if (!pt) return { ok: false, error: 'нет такой версии' };
  if (pt.locked) return { ok: false, error: 'версия защищена замком — сначала снимите замок' };
  p.list = p.list.filter((x) => x.id !== id); ctxSavePoints(projId, p);
  try { fs.rmSync(ctxPointFile(projId, id), { force: true }); } catch (_) {}
  return { ok: true, list: p.list };
});
// Замок — обычный тумблер на ЛЮБОЙ версии (защита от ротации), а не эксклюзивный «Оригинал».
ipcMain.handle('ctx:pointLock', (_e, { projId, id, locked } = {}) => {
  const p = ctxLoadPoints(projId);
  const pt = p.list.find((x) => x.id === id);
  if (!pt) return { ok: false, error: 'нет такой версии' };
  pt.locked = !!locked;
  if (!pt.locked) ctxRotatePoints(projId, p);   // сняли замок — версия попадает под общий лимит
  ctxSavePoints(projId, p);
  return { ok: true, list: p.list };
});
ipcMain.handle('ctx:pointNote', (_e, { projId, id, note } = {}) => {
  const p = ctxLoadPoints(projId);
  const pt = p.list.find((x) => x.id === id);
  if (!pt) return { ok: false, error: 'нет такой версии' };
  pt.note = String(note || '').slice(0, 400);
  ctxSavePoints(projId, p);
  return { ok: true, list: p.list };
});
// Слежение за CLAUDE.md проекта пока открыт модуль → событие при правке агентом
const ctxOutWatchers = new Map(); // projId -> fs.FSWatcher
ipcMain.on('ctx:watchOutputs', (e, { projId, projPath } = {}) => {
  if (!projId || !projPath || ctxOutWatchers.has(projId)) return;
  let timer = null, watcher;
  try {
    watcher = fs.watch(projPath, (_ev, fname) => {
      if (fname !== CTX_FILE) return;
      clearTimeout(timer);
      timer = setTimeout(() => safeSend(e.sender, 'ctx:outputChanged', { projId }), 400);
    });
  } catch (_) { return; }
  ctxOutWatchers.set(projId, watcher);
});
ipcMain.on('ctx:unwatchOutputs', (_e, { projId } = {}) => {
  const w = ctxOutWatchers.get(projId);
  if (w) { try { w.close(); } catch (_) {} ctxOutWatchers.delete(projId); }
});

// ---------------------------------------------------------------- user modules (extensions)
// Пользовательские модули: ~/.LiteEditorAI/modules/<id>/ = manifest.json + index.js.
// main только сканит/валидирует и отдаёт file:// URL главного файла — загрузка и весь
// рантайм (динамический import, ctx, панель) живут в renderer/extensions.js.
const extModulesDir = path.join(storeDir, 'modules');
const EXT_API_VERSION = 1;
function extEnsureDir() {
  try {
    if (fs.existsSync(extModulesDir)) return;
    fs.mkdirSync(extModulesDir, { recursive: true });
    fs.writeFileSync(path.join(extModulesDir, 'README.md'),
      '# Модули LiteEditor\n\nСюда устанавливаются пользовательские модули: одна папка = один модуль\n' +
      '(manifest.json + index.js). Проще всего создать свой через меню «Модули → Создать модуль…».\n' +
      'Спецификация: https://github.com/DanielLetto2020/LiteEditorAI/tree/main/module-kit\n');
  } catch (_) {}
}
ipcMain.handle('ext:scan', () => {
  extEnsureDir();
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(extModulesDir, { withFileTypes: true }); } catch (_) {}
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(extModulesDir, ent.name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue; // служебные папки молча пропускаем
    let manifest = null, error = '';
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
    catch (e) { error = 'manifest.json не парсится: ' + (e.message || e); }
    if (manifest && !error) {
      if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) error = 'некорректный id в манифесте (только a-z, 0-9, дефис)';
      else if (manifest.id !== ent.name) error = `id «${manifest.id}» не совпадает с именем папки «${ent.name}»`;
      else if (Number(manifest.apiVersion) !== EXT_API_VERSION) error = `apiVersion ${manifest.apiVersion} не поддерживается (редактор: ${EXT_API_VERSION})`;
    }
    const mainFile = path.join(dir, (manifest && typeof manifest.main === 'string' && manifest.main) || 'index.js');
    if (!error && !fs.existsSync(mainFile)) error = 'нет главного файла: ' + path.basename(mainFile);
    out.push({ id: ent.name, dir, manifest, error, mainUrl: error ? '' : pathToFileURL(mainFile).href, mainFile });
  }
  return { dir: extModulesDir, modules: out, apiVersion: EXT_API_VERSION };
});
// Скаффолд нового модуля: заготовка кода + GUIDE/CLAUDE.md/AGENTS.md из module-kit ПРИЛОЖЕНИЯ —
// гайд гарантированно совпадает с apiVersion запущенного редактора (никаких клонирований из сети).
const EXT_STUB = `// Стартовая заготовка модуля LiteEditor. Спецификация API — в GUIDE.md рядом.
export function activate(ctx) {
  const root = ctx.ui.el('div', 'ext-' + ctx.id);
  root.style.cssText = 'padding:14px;color:var(--text);display:flex;flex-direction:column;gap:8px;';
  root.appendChild(ctx.ui.el('div', null, 'Модуль «' + ctx.id + '» создан.'));
  root.appendChild(ctx.ui.el('div', null, 'Опишите агенту, что здесь должно быть — он перепишет index.js.'));
  ctx.panel.element.appendChild(root);
}
export function deactivate() {}
`;
ipcMain.handle('ext:scaffold', (_e, { id, name, desc } = {}) => {
  try {
    if (!id || !/^[a-z0-9-]+$/.test(String(id))) return { error: 'некорректный id (только a-z, 0-9, дефис)' };
    extEnsureDir();
    const dir = path.join(extModulesDir, String(id));
    if (fs.existsSync(dir)) return { error: 'модуль с таким id уже существует: ' + dir };
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id: String(id), name: String(name || id), version: '0.1.0', apiVersion: EXT_API_VERSION, main: 'index.js', description: String(desc || ''), author: '', repo: '', capabilities: [] };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'index.js'), EXT_STUB);
    const kit = path.join(__dirname, 'module-kit');
    for (const [src, dst] of [['GUIDE.md', 'GUIDE.md'], [path.join('ai', 'CLAUDE.md'), 'CLAUDE.md'], [path.join('ai', 'AGENTS.md'), 'AGENTS.md']]) {
      try { fs.copyFileSync(path.join(kit, src), path.join(dir, dst)); } catch (e) { console.warn('ext:scaffold copy failed', src, String(e.message || e)); }
    }
    return { dir };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ---------------------------------------------------------------- settings backup (export / import)
// A single self-contained JSON snapshot of the editor's whole state: every store key
// (projects+categories, settings, layout, recents, accordions, section order…),
// per-project notes, and the saved window geometry. Lets a user back up / move their setup.
function readAllNotes() {
  const out = {};
  try {
    const nd = path.join(storeDir, 'notes');
    for (const f of fs.readdirSync(nd)) {
      if (!f.endsWith('.json')) continue;
      try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8')); } catch (_) {}
    }
  } catch (_) {}
  return out;
}
function backupStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
ipcMain.handle('settings:export', async () => {
  const store = {};
  for (const k of STORE_KEYS) { const v = readStoreKey(k); if (v !== undefined) store[k] = v; }
  const payload = {
    _format: 'lite-settings',
    _app: app.getName(),
    _version: app.getVersion(),
    _exportedAt: new Date().toISOString(),
    store,
    notes: readAllNotes(),
    windowState: loadState(),
  };
  const fname = `${app.getName()}_${backupStamp()}.json`;
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Экспорт настроек',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), fname),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    atomicWriteSync(res.filePath, JSON.stringify(payload, null, 2));
    saveState({ lastOpenDir: path.dirname(res.filePath) });
    return { ok: true, file: res.filePath, dir: path.dirname(res.filePath) };
  } catch (e) { return { error: String(e.message || e) }; }
});
// Notes export/import: generic JSON file save/open (assembly + merge happen in the renderer,
// which owns the project list and notesGet/notesSet). Mirrors the settings handlers above.
ipcMain.handle('notes:exportFile', async (_e, { json, name }) => {
  const safe = String(name || 'lite-notes').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 80);
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Экспорт заметок',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), `${safe}_${backupStamp()}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    atomicWriteSync(res.filePath, String(json));
    saveState({ lastOpenDir: path.dirname(res.filePath) });
    return { ok: true, file: res.filePath };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('notes:importFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Импорт заметок', properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }], ...lastDirOpts(),
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  const file = res.filePaths[0];
  try {
    const stat = fs.statSync(file);
    if (stat.size > IMPORT_MAX_BYTES) return { error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
    const content = fs.readFileSync(file, 'utf8');
    saveState({ lastOpenDir: path.dirname(file) });
    return { ok: true, content };
  } catch (e) { return { error: 'Не удалось прочитать файл: ' + String(e.message || e) }; }
});
ipcMain.handle('settings:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Импорт настроек', properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }], ...lastDirOpts(),
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  const file = res.filePaths[0];
  let data;
  try {
    // Guard the synchronous read+parse against a pathologically large file freezing main.
    const stat = fs.statSync(file);
    if (stat.size > IMPORT_MAX_BYTES) return { error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return { error: 'Не удалось прочитать файл: ' + String(e.message || e) }; }
  if (!data || data._format !== 'lite-settings' || typeof data.store !== 'object') {
    return { error: 'Это не файл настроек LiteEditor.' };
  }
  try {
    ensureStoreDir();
    // writeStoreKey logs+swallows its own errors, so track its boolean result here:
    // an unreported failure would let import claim success after losing settings.
    const failedKeys = [];
    for (const k of STORE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data.store, k) && !writeStoreKey(k, data.store[k])) failedKeys.push(k);
    }
    let failedNotes = 0;
    if (data.notes && typeof data.notes === 'object') {
      const nd = path.join(storeDir, 'notes');
      fs.mkdirSync(nd, { recursive: true });
      for (const [id, arr] of Object.entries(data.notes)) {
        try { atomicWriteSync(path.join(nd, String(id).replace(/[^\w.-]/g, '_') + '.json'), JSON.stringify(arr)); }
        catch (e) { failedNotes++; logger.log('error', 'store', `import note '${id}' failed`, e); }
      }
    }
    if (data.windowState && typeof data.windowState === 'object') saveState(data.windowState);
    saveState({ lastOpenDir: path.dirname(file) });
    // Surface partial failure instead of a false "success" so the renderer can warn the user.
    if (failedKeys.length || failedNotes) return { ok: true, partial: true, failedKeys, failedNotes, file };
    return { ok: true, file };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ---------------------------------------------------------------- window state
const stateFile = path.join(storeDir, 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(partial) {
  try { atomicWriteSync(stateFile, JSON.stringify({ ...loadState(), ...partial })); } catch (_) {}
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function createWindow() {
  const st = loadState();
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const opts = {
    width: st.width || 1280,
    height: st.height || 820,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#00000000',
    title: 'LiteEditorAI',
    frame: false,
    transparent: true, // so #app's rounded corners show through to the desktop (needs a compositor)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (Number.isInteger(st.x) && Number.isInteger(st.y)) { opts.x = st.x; opts.y = st.y; }
  if (fs.existsSync(iconPng)) opts.icon = iconPng;

  mainWindow = new BrowserWindow(opts);
  hardenNavigation(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (st.maximized) mainWindow.maximize();

  // Renderer death is the most likely "silent close": log reason + exitCode so
  // a recurrence is diagnosable (e.g. reason:'crashed'/'oom' vs a GPU abort).
  mainWindow.webContents.on('render-process-gone', (_e, d) =>
    logger.log('fatal', 'render-process-gone', JSON.stringify(d)));
  mainWindow.webContents.on('unresponsive', () => logger.log('warn', 'window', 'renderer unresponsive'));
  mainWindow.webContents.on('responsive', () => logger.log('info', 'window', 'renderer responsive'));
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error')
      logger.log(e.level === 'error' ? 'error' : 'warn', 'console', `${e.message} (${e.sourceId}:${e.lineNumber})`);
  });

  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) { saveState({ maximized: true }); return; }
    const b = mainWindow.getBounds();
    saveState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: false });
  };
  // A resize to a width we didn't set = the user dragged the edge → forget the virtual
  // grow width so the next viewer open/close measures from where the user left it.
  mainWindow.on('resize', () => {
    if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
    const w = mainWindow.getBounds().width;
    if (growAppliedWidth == null || Math.abs(w - growAppliedWidth) > 2) growDesiredWidth = null;
  });
  mainWindow.on('resize', debounce(persist, 400));
  mainWindow.on('move', debounce(persist, 400));
  mainWindow.on('close', persist);
  // Закрытие редактора закрывает все окна модулей (освобождение памяти). После этого
  // window-all-closed штатно убивает PTY/db/rh и завершает приложение.
  mainWindow.on('close', () => closeAllModuleWindows());
  mainWindow.on('maximize', () => sendTo(mainWindow, 'win:maximized', true));
  mainWindow.on('unmaximize', () => sendTo(mainWindow, 'win:maximized', false));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    if (input.key === 'F11') mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- module windows (v1.1+)
// Каждый модуль (git/db/контейнеры/чат/…) живёт в ОТДЕЛЬНОМ окне, а не в правом слоте редактора.
// Одно окно на тип модуля (повторный open = фокус). Окно помнит свои bounds (STORE.moduleWins[id]).
// Закрытие редактора закрывает все окна модулей (освобождение памяти — отдельный процесс на окно).
const moduleWindows = new Map();    // modId -> BrowserWindow
let activeProjectInfo = null;       // {id,path,name,accent} — кэш активного проекта редактора (для проектозависимых окон)
const ownerBySession = new Map();   // sessionId -> webContents — маршрутизация стримов по окну-владельцу (этап D)

function readModuleWins() { const v = readStoreKey('moduleWins'); return (v && typeof v === 'object') ? v : {}; }
function saveModuleBounds(modId, win) {
  if (!win || win.isDestroyed()) return;
  const all = readModuleWins();
  if (win.isMaximized()) { all[modId] = { ...(all[modId] || {}), maximized: true }; }
  else { const b = win.getBounds(); all[modId] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: false }; }
  writeStoreKey('moduleWins', all);
}
function broadcastModuleOpenSet() {
  const ids = [...moduleWindows.keys()];
  sendTo(mainWindow, 'module:openSet', { ids });
  // запоминаем набор открытых окон — чтобы переоткрыть его при следующем запуске редактора
  try { const all = readModuleWins(); all.__open = ids; writeStoreKey('moduleWins', all); } catch (_) {}
}
// Переоткрыть окна модулей, которые были открыты на момент прошлого выхода (с их сохранёнными bounds).
function reopenSavedModuleWindows() {
  try {
    const open = readModuleWins().__open;
    if (Array.isArray(open)) for (const id of open) { if (id && typeof id === 'string') openModuleWindow(id); }
  } catch (_) {}
}
function broadcastToModules(ch, payload) {
  for (const w of moduleWindows.values()) { sendTo(w, ch, payload); }
}
// Маршрут стрима к окну-владельцу сессии (fallback — главное окно редактора).
function sendToOwner(sessionId, ch, payload) {
  const wc = ownerBySession.get(sessionId);
  if (sendTo(wc, ch, payload)) return;          // владелец мог умереть — тогда падаем на окно редактора
  sendTo(mainWindow, ch, payload);
}
// ── Навигация окон с мостом ───────────────────────────────────────────────────────────────────
// preload применяется к КАЖДОМУ документу webContents, поэтому окно, ушедшее на внешний адрес,
// отдаёт этому адресу весь window.lite — то есть файловую систему пользователя. А уйти есть куда:
// превью markdown рисует обычные ссылки, а содержимое CLAUDE.md и памяти приходит из чужих
// репозиториев и от агента. Поэтому окну разрешены ровно две свои страницы, всё остальное
// уезжает в системный браузер.
// Сравниваем file-URL с file-URL: pathname у file:// на Windows выглядит как «/C:/app/…», а
// path.join даёт «C:\app\…» — прямое сравнение путей там не совпало бы НИКОГДА, и защита
// заблокировала бы окну его собственную страницу.
const APP_PAGES = new Set([
  pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href,
  pathToFileURL(path.join(__dirname, 'renderer', 'module.html')).href,
]);
function isAppPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    u.hash = ''; u.search = '';        // module.html#ctx и ?query — та же страница
    return APP_PAGES.has(u.href);
  } catch (_) { return false; }
}
function hardenNavigation(win) {
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (isAppPage(url)) return;                       // своя страница и её перезагрузка
    e.preventDefault();
    logger.log('warn', 'window', 'навигация наружу отклонена: ' + String(url).slice(0, 200));
    if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch (_) {} }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch (_) {} }
    return { action: 'deny' };                        // отдельных окон без preload-контракта не заводим
  });
}

function openModuleWindow(modId) {
  const existing = moduleWindows.get(modId);
  if (existing && !existing.isDestroyed()) { if (existing.isMinimized()) existing.restore(); existing.focus(); return; }
  const saved = readModuleWins()[modId] || {};
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const opts = {
    width: saved.width || 900, height: saved.height || 700,
    minWidth: 420, minHeight: 320,
    backgroundColor: '#00000000', frame: false, transparent: true,
    title: 'LiteEditorAI', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) { opts.x = saved.x; opts.y = saved.y; }
  if (fs.existsSync(iconPng)) opts.icon = iconPng;
  const win = new BrowserWindow(opts);
  hardenNavigation(win);
  moduleWindows.set(modId, win);
  win.loadFile(path.join(__dirname, 'renderer', 'module.html'), { hash: modId });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('maximize', () => { sendTo(win, 'win:maximized', true); });
  win.on('unmaximize', () => { sendTo(win, 'win:maximized', false); });
  win.on('resize', debounce(() => saveModuleBounds(modId, win), 400));
  win.on('move', debounce(() => saveModuleBounds(modId, win), 400));
  // Закрытие окна модуля (верхняя ✕ / Alt+F4 / ОС) проходит через dirty-guard рендерера:
  // первый раз гасим закрытие и спрашиваем окно, рендерер ответит win:confirmClose → закрываем.
  // closeAllModuleWindows() зовёт destroy() в обход этого (выход редактора не блокируем).
  win.on('close', (e) => {
    saveModuleBounds(modId, win);
    if (win.__forceClose) return;
    e.preventDefault();
    sendTo(win, 'win:closeRequest');
  });
  win.on('closed', () => {
    moduleWindows.delete(modId);
    if (modId === 'files') filesViewerReady = false; // окно вивера закрыто → следующее openInViewer переоткроет и переждёт готовность
    if (modId === 'db') dbPanelReady = false;        // окно БД закрыто → следующий openFromContainer переоткроет и переждёт готовность
    if (modId === 'rmq') rmqPanelReady = false;      // аналогично для окна RabbitMQ
    if (modId === 'kafka') kafkaPanelReady = false;  // аналогично для окна Kafka
    if (modId === 'storage') stPanelReady = false;   // аналогично для окна «Внешние хранилища»
    if (modId === 'ctx') {
      for (const w of ctxOutWatchers.values()) { try { w.close(); } catch (_) {} } ctxOutWatchers.clear(); // окно «Контекст» закрылось без unwatch → не течём fs.watch (B2)
      // и обрываем анализ диалогов: без этого `claude -p` жил ещё до таймаута (5 мин), жёг токены и писал в мёртвый sender
      for (const c of ctxmineReqs.values()) { try { c.kill(); } catch (_) {} } ctxmineReqs.clear();
    }
    // То же и для остальных окон с агентами: закрыли окно — обрывай его запросы. Иначе `claude -p`
    // (или HTTP-стрим OpenRouter) доживал до своего таймаута — 2–5 минут работы и токенов в никуда,
    // а «Директор» ИИ-компании ещё и detached, то есть переживал бы окно гарантированно.
    if (modId === 'doc') killReqMap(tpReqs);         // «Обработка текста»
    if (modId === 'db') killReqMap(dbaiReqs);        // AI-DB (child ИЛИ ClientRequest — killReqMap разбирает оба)
    if (modId === 'chat') killReqMap(orReqs);        // OpenRouter
    if (modId === 'company') { for (const c of companyReqs.values()) { try { companyKill(c); } catch (_) {} } companyReqs.clear(); }
    // «Контейнеры»: закрыть окно ✕ мимо closeDockerDetail() — и `logs -f` продолжал бы качать вывод
    // мёртвому окну, а `exec -it` держал бы живую оболочку в контейнере до выхода из редактора.
    // Тейлы rmq/kafka так уже умеют (sender.once('destroyed') в lib/), эти два — нет.
    if (modId === 'docker') {
      for (const cp of cLogProcs.values()) { try { cp.kill(); } catch (_) {} } cLogProcs.clear();
      for (const p of cExecPtys.values()) { try { p.kill(); } catch (_) {} } cExecPtys.clear();
    }
    for (const [sid, wc] of ownerBySession) { try { if (wc.isDestroyed()) ownerBySession.delete(sid); } catch (_) { ownerBySession.delete(sid); } }
    broadcastModuleOpenSet();
  });
  // Рендерер окна модуля умер → окно неюзабельно, dirty-guard (win:closeRequest) ждать некому.
  // Снимаем гард и закрываем принудительно, иначе ✕ не сработает (B4). destroy() → сработает 'closed'.
  win.webContents.on('render-process-gone', (_e, d) => {
    logger.log('error', 'module-window', `${modId} ${JSON.stringify(d)}`);
    win.__forceClose = true;
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  broadcastModuleOpenSet();
}
function closeAllModuleWindows() {
  for (const w of [...moduleWindows.values()]) { try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) {} }
  moduleWindows.clear();
}

// ── Помодоро: долгоживущий движок таймера в main ──────────────────────────────────────
// Таймер живёт здесь (а не в окне модуля), чтобы отсчёт переживал закрытие окна «Помодоро»:
// смысл фичи — «поставил и работаешь». Окно модуля = пульт; на каждом тике сюда летит снимок
// состояния (pomodoro:tick). В фазе перерыва, если у техники включён `block`, main управляет
// полупрозрачным оверлеем над терминалами в окне редактора (editor:restGuard) — оверлей блокирует
// ВВОД человека, но НЕ PTY: агенты продолжают работать, вывод виден сквозь оверлей.
const POMO = {
  running: false, paused: false,
  phase: 'idle',   // 'idle' | 'work' | 'short' | 'long'
  remaining: 0,    // секунд до конца текущей фазы
  cycle: 0,        // завершённых рабочих интервалов в текущем подходе
  tech: null,      // снимок техники {name, work, short, long, cyclesBeforeLong, block, allowSkip}
};
let pomoTimer = null;

// Длительность текущей фазы в секундах (для прогресс-кольца и затемнения оверлея).
function pomoPhaseTotal() {
  const t = POMO.tech || {};
  const mins = POMO.phase === 'work' ? t.work : POMO.phase === 'long' ? t.long : POMO.phase === 'short' ? t.short : 0;
  return Math.max(1, Math.round((mins || 0) * 60));
}
function pomoSnapshot() {
  return { running: POMO.running, paused: POMO.paused, phase: POMO.phase, remaining: POMO.remaining, total: pomoPhaseTotal(), cycle: POMO.cycle, tech: POMO.tech };
}
// Тик уходит и в окна модулей (пульт), и в окно редактора (мини-таймер в титлбаре + бейдж квикбара).
function pomoEmit() {
  const snap = pomoSnapshot();
  broadcastToModules('pomodoro:tick', snap);
  sendTo(mainWindow, 'pomodoro:tick', snap);
}

// Журнал завершённых помидоров (только main пишет; ключ отдельный от 'pomodoro', который пишет рендерер).
function readPomoLog() { const v = readStoreKey('pomodoroLog'); return Array.isArray(v) ? v : []; }
function pomoRecordDone() {
  const log = readPomoLog();
  log.push({
    ts: Date.now(),
    techName: (POMO.tech && POMO.tech.name) || '',
    workMin: (POMO.tech && POMO.tech.work) || 0,
    projId: (activeProjectInfo && activeProjectInfo.id) || null,
    projName: (activeProjectInfo && activeProjectInfo.name) || null,
  });
  if (log.length > 5000) log.splice(0, log.length - 5000); // хвостовая обрезка — лог не растёт бесконечно
  writeStoreKey('pomodoroLog', log);
  broadcastToModules('pomodoro:logChanged', null);
}
// Уведомление ОС + звон при смене фазы. Звук играем в окне редактора (всегда открыто; модуль-пульт может
// быть закрыт). Настройки soundOn/notifyOn читаем из общего ключа 'pomodoro' (его пишет рендерер).
function pomoNotifyPhase(from, to) {
  if (from === to) return;
  const cfg = readStoreKey('pomodoro') || {};
  const label = { work: 'Работа', short: 'Короткий перерыв', long: 'Длинный перерыв' };
  if (cfg.notifyOn !== false && Notification.isSupported()) {
    try {
      new Notification({
        title: to === 'work' ? 'Перерыв окончен — за работу' : 'Время отдыхать 🍅',
        body: to === 'work' ? 'Возвращайтесь к делу' : (label[to] + ' — агенты продолжают работать'),
        silent: true, // свой звон играем сами (ниже), чтобы он был и без системного звука уведомлений
      }).show();
    } catch (_) {}
  }
  if (cfg.soundOn !== false) sendTo(mainWindow, 'pomodoro:chime', { to });
}
// Оверлей отдыха в окне редактора: показываем на перерыве (если техника блокирует), иначе прячем.
function pomoSyncOverlay() {
  const onBreak = POMO.running && (POMO.phase === 'short' || POMO.phase === 'long');
  const block = !!(POMO.tech && POMO.tech.block);
  if (onBreak && block) {
    forwardToEditor('editor:restGuard', {
      show: true, phase: POMO.phase, remaining: POMO.remaining, total: pomoPhaseTotal(), paused: POMO.paused,
      allowSkip: !!(POMO.tech && POMO.tech.allowSkip), techName: POMO.tech && POMO.tech.name,
    });
  } else {
    forwardToEditor('editor:restGuard', { show: false });
  }
}
function pomoSetPhase(phase) {
  POMO.phase = phase;
  const t = POMO.tech || {};
  const mins = phase === 'work' ? t.work : phase === 'long' ? t.long : phase === 'short' ? t.short : 0;
  POMO.remaining = Math.max(1, Math.round((mins || 0) * 60));
}
// Завершить текущую фазу и перейти к следующей (естественный конец отсчёта ИЛИ «Пропустить»).
// viaSkip=true → рабочий интервал НЕ засчитывается в журнал (засчитываем только доведённые до конца).
function pomoAdvance(viaSkip) {
  const t = POMO.tech || {};
  const from = POMO.phase;
  if (from === 'work') {
    if (!viaSkip) pomoRecordDone();   // завершённый помидор → в журнал
    POMO.cycle += 1;
    const beforeLong = Math.max(1, t.cyclesBeforeLong || 4);
    pomoSetPhase((POMO.cycle % beforeLong === 0) ? 'long' : 'short');
  } else {
    // перерыв (short/long) закончился → новый рабочий интервал
    pomoSetPhase('work');
  }
  pomoSyncOverlay();
  pomoNotifyPhase(from, POMO.phase);
  pomoEmit();
}
function pomoTick() {
  if (!POMO.running || POMO.paused) return;
  POMO.remaining -= 1;
  if (POMO.remaining <= 0) { pomoAdvance(false); return; }
  // на перерыве каждую секунду обновляем оверлей (и самовосстанавливаем его, если редактор перезагрузился)
  if (POMO.phase === 'short' || POMO.phase === 'long') pomoSyncOverlay();
  pomoEmit();
}
function pomoEnsureTimer() {
  if (!pomoTimer) { pomoTimer = setInterval(pomoTick, 1000); if (pomoTimer.unref) pomoTimer.unref(); }
}
function pomoStart(tech) {
  if (!tech) return { ok: false, error: 'Не задана техника' };
  POMO.tech = {
    name: String(tech.name || 'Помодоро'),
    work: Number(tech.work) || 25, short: Number(tech.short) || 5, long: Number(tech.long) || 15,
    cyclesBeforeLong: Math.max(1, Number(tech.cyclesBeforeLong) || 4),
    block: tech.block !== false, allowSkip: tech.allowSkip !== false,
  };
  POMO.running = true; POMO.paused = false; POMO.cycle = 0;
  pomoSetPhase('work');
  pomoEnsureTimer();
  pomoSyncOverlay();
  pomoEmit();
  return { ok: true };
}
function pomoStop() {
  POMO.running = false; POMO.paused = false; POMO.phase = 'idle'; POMO.remaining = 0; POMO.cycle = 0;
  if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = null; } // не крутим 1с-тик впустую после «Стоп»
  pomoSyncOverlay();   // спрячет оверлей
  pomoEmit();
  return { ok: true };
}

// Tray gives a quick way back to the window and surfaces how many agents need
// attention while the window is minimised/behind others.
function createTray() {
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  if (tray || !fs.existsSync(iconPng)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPng).resize({ width: 18, height: 18 }));
    tray.setToolTip('LiteEditorAI');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: i18n.t('Показать LiteEditor'), click: showWindow },
      { type: 'separator' },
      { label: i18n.t('Выход'), click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

// GPU/utility child processes dying (the other half of a "trap int3" crash).
app.on('child-process-gone', (_e, d) =>
  logger.log(d && d.reason === 'clean-exit' ? 'info' : 'error', 'child-process-gone', JSON.stringify(d)));
app.on('before-quit', () => { try { errledger.flush(); } catch (_) {} logger.log('info', 'app', 'before-quit'); });

app.whenReady().then(() => {
  // Язык интерфейса — до создания окон: рендерер забирает словарь синхронно при старте.
  try {
    const lang = ((readStoreKey('settings') || {}).lang || 'ru');
    i18n.setLocale(lang);
    logger.log('info', 'i18n', `locale=${i18n.locale()}, строк в словаре: ${Object.keys(i18n.dictionary()).length}`);
  } catch (_) {}
  const gpu = !(process.env.LITE_NO_GPU === '1' || process.env.LITE_SOFTWARE_RENDER === '1');
  logger.log('info', 'app', `ready — electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}, gpu=${gpu}`);
  probeLoginPath(); // фоном: PATH логин-шелла для CLI-агентов «Обработки текста»
  // Своё меню мы рисуем в титлбаре, поэтому системное не нужно — но на macOS оно ещё и держит
  // системные ускорители: без меню в приложении не работают Cmd+C/V/X/A и Cmd+Q, а About/Hide
  // недоступны совсем. Поэтому там ставим минимальное меню из ролей (идея PR #10), на остальных
  // платформах — как было, без меню.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: i18n.t('Правка'), submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: i18n.t('Окно'), submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'close' },
    ] },
  ]) : null);
  createWindow();
  createTray();
  // Переоткрыть окна модулей, открытые в прошлой сессии (проектозависимые подхватят активный
  // проект, когда редактор его запушит). Небольшая задержка — дать окну редактора подняться.
  setTimeout(reopenSavedModuleWindows, 600);
  startAgendaReminders();  // напоминалки Календаря (дата-задачи)
  startAgendaWatch();      // подхват внешних записей напоминаний (MCP-сервер)
  // Архивы обновлений (по 150 МБ) живут только до перезапуска: раз мы стартовали, скачанное
  // либо уже применено, либо устарело — качать его повторно дешевле, чем копить на диске.
  setTimeout(() => updater.cleanup(storeDir), 8000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});


app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch (_) {} }
  ptys.clear();
  for (const p of cExecPtys.values()) { try { p.kill(); } catch (_) {} }
  cExecPtys.clear();
  for (const cp of cLogProcs.values()) { try { cp.kill(); } catch (_) {} }
  cLogProcs.clear();
  for (const c of companyReqs.values()) { try { companyKill(c); } catch (_) {} } // detached-директора не должны пережить редактор
  companyReqs.clear();
  // In-flight агент-процессы/HTTP окон модулей (textproc/чат/AI-DB): окно могло крашнуться,
  // не успев послать *:abort → не оставляем claude/codex/запрос сиротами после выхода (B3).
  killReqMap(tpReqs); killReqMap(dbaiReqs); killReqMap(orReqs);
  try { dbApi.closeAll(); } catch (_) {}
  try { rhApi.closeAll(); } catch (_) {}
  for (const w of watchers.values()) { try { w.watcher.close(); } catch (_) {} }
  watchers.clear();
  for (const w of ctxOutWatchers.values()) { try { w.close(); } catch (_) {} } // fs.watch выходных файлов «Контекста» (B2)
  ctxOutWatchers.clear();
  if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = null; }
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- локализация
// Язык живёт в settings.lang; словари — подключаемые файлы (locales/ + ~/.LiteEditorAI/locales/).
// Рендерер берёт словарь СИНХРОННО при старте, чтобы интерфейс не мигал русским.
function i18nPayload() {
  // Никаких обращений к диску: это синхронный ответ на старте КАЖДОГО окна.
  return { code: i18n.locale(), dict: i18n.dictionary(), rtl: i18n.isRtl() };
}
ipcMain.on('i18n:current', (e) => { e.returnValue = i18nPayload(); });
ipcMain.handle('i18n:list', () => ({ current: i18n.locale(), list: i18n.available() }));
ipcMain.handle('i18n:set', (_e, { code } = {}) => {
  const known = i18n.available().some((l) => l.code === String(code || '').toLowerCase());
  if (!known) return { ok: false, error: 'Неизвестный язык' };
  i18n.setLocale(code);
  const st = readStoreKey('settings') || {};
  st.lang = i18n.locale();
  writeStoreKey('settings', st);
  const payload = i18nPayload();
  for (const w of BrowserWindow.getAllWindows()) sendTo(w, 'i18n:changed', payload);
  try { updateTrayTooltip(); } catch (_) {}
  return { ok: true, code: i18n.locale() };
});
ipcMain.handle('i18n:openUserDir', async () => {
  try { fs.mkdirSync(i18n.USER_DIR, { recursive: true }); await shell.openPath(i18n.USER_DIR); return { ok: true, dir: i18n.USER_DIR }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

// ---------------------------------------------------------------- window controls
// Действуют на окно ОТПРАВИТЕЛЯ (редактор ИЛИ окно модуля), не на mainWindow жёстко.
function senderWin(e) { try { return BrowserWindow.fromWebContents(e.sender); } catch (_) { return null; } }
ipcMain.on('win:minimize', (e) => { const w = senderWin(e); if (w) w.minimize(); });
ipcMain.on('win:maximizeToggle', (e) => {
  const w = senderWin(e);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (e) => { const w = senderWin(e); if (w) w.close(); });
ipcMain.on('win:confirmClose', (e) => { const w = senderWin(e); if (w) { w.__forceClose = true; w.close(); } });
ipcMain.handle('win:isMaximized', (e) => { const w = senderWin(e); return !!(w && w.isMaximized()); });
ipcMain.on('win:show', showWindow);

// ── Окна модулей: open/close/реестр открытых ──────────────────────────────────────────
ipcMain.on('module:open', (_e, { modId } = {}) => { if (modId) openModuleWindow(String(modId)); });

// ── Помодоро: пульт окна модуля управляет движком таймера в main ──────────────────────
ipcMain.handle('pomodoro:start', (_e, { tech } = {}) => pomoStart(tech));
ipcMain.handle('pomodoro:stop', () => pomoStop());
ipcMain.handle('pomodoro:pause', () => { if (POMO.running) { POMO.paused = true; pomoSyncOverlay(); pomoEmit(); } return { ok: true }; });
ipcMain.handle('pomodoro:resume', () => { if (POMO.running) { POMO.paused = false; pomoSyncOverlay(); pomoEmit(); } return { ok: true }; });
ipcMain.handle('pomodoro:skip', () => { if (POMO.running) pomoAdvance(true); return { ok: true }; });
ipcMain.handle('pomodoro:getState', () => pomoSnapshot());
ipcMain.handle('pomodoro:history', () => readPomoLog());
// Экспорт/импорт своих техник (JSON-файл через системный диалог).
ipcMain.handle('pomodoro:exportFile', async (_e, { json, name } = {}) => {
  const safe = String(name || 'lite-pomodoro').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 80);
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Экспорт техник помодоро',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), `${safe}_${backupStamp()}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try { atomicWriteSync(res.filePath, String(json)); saveState({ lastOpenDir: path.dirname(res.filePath) }); return { ok: true, file: res.filePath }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('pomodoro:importFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Импорт техник помодоро', properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }], ...lastDirOpts(),
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  const file = res.filePaths[0];
  try {
    const stat = fs.statSync(file);
    if (stat.size > IMPORT_MAX_BYTES) return { ok: false, error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
    const content = fs.readFileSync(file, 'utf8');
    saveState({ lastOpenDir: path.dirname(file) });
    return { ok: true, content };
  } catch (e) { return { ok: false, error: 'Не удалось прочитать файл: ' + String(e.message || e) }; }
});

// ── Кросс-оконная шина: активный проект редактора → окна модулей ──────────────────────
ipcMain.on('app:setActiveProject', (_e, info) => { activeProjectInfo = info || null; broadcastToModules('app:activeProject', activeProjectInfo); });
ipcMain.handle('app:getActiveProject', () => activeProjectInfo);
ipcMain.on('app:settingsChanged', (_e, s) => broadcastToModules('app:settingsChanged', s || {}));
// Задачи изменились (окно «Задачи») → разослать ВСЕМ окнам модулей КРОМЕ отправителя (иначе автор правки
// получил бы эхо своего же изменения и перезагрузил список после каждого клика) + в главное окно (для бейджа
// счётчика активных задач на квикбаре). Отправитель сам уже знает об изменении и обновляет UI точечно.
ipcMain.on('app:notesChanged', (e, { id } = {}) => {
  for (const w of moduleWindows.values()) { if (w && !w.isDestroyed() && w.webContents !== e.sender) sendTo(w, 'app:notesChanged', { id }); }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== e.sender) sendTo(mainWindow, 'app:notesChanged', { id });
});
// Напоминания изменились (Календарь / MCP / пульт) → тем же образом: окнам модулей + главному окну (бейдж).
ipcMain.on('app:agendaChanged', (e, { id } = {}) => {
  for (const w of moduleWindows.values()) { if (w && !w.isDestroyed() && w.webContents !== e.sender) sendTo(w, 'app:agendaChanged', { id }); }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== e.sender) sendTo(mainWindow, 'app:agendaChanged', { id });
});

// ── Действия из окна модуля → переслать редактору (терминал) или окну вивера (файл/дерево) ──
function forwardToEditor(ch, payload) { sendTo(mainWindow, ch, payload); }
// Вивер живёт в окне модуля «files». openInViewer/refreshTree маршрутизируем туда (открываем окно при
// необходимости). Окно может быть не готово принять сообщение сразу после открытия → копим в очередь до
// сигнала editor:viewerReady (его шлёт module-entry после подписки).
let filesViewerReady = false;
const pendingViewerOpens = [];
let pendingFocusGit = false;        // «Git» нажат до готовности окна → фокус секции после viewerReady
function filesWindow() { const w = moduleWindows.get('files'); return (w && !w.isDestroyed()) ? w : null; }
function docWindow() { const w = moduleWindows.get('doc'); return (w && !w.isDestroyed()) ? w : null; } // «Обработка текста»: сайдбар-дерево следит за диском
function routeOpenInViewer(payload) {
  if (!filesWindow()) openModuleWindow('files'); // откроет окно (и переключит на активный проект)
  const w = filesWindow();
  if (w && filesViewerReady) sendTo(w, 'editor:openInViewer', payload);
  else pendingViewerOpens.push(payload); // флашнем по editor:viewerReady
}
ipcMain.on('editor:openInViewer', (_e, payload) => routeOpenInViewer(payload));
// Открыть ПРОИЗВОЛЬНЫЙ ТЕКСТ в вивере: пишем во временный файл (человеческое имя сохраняется —
// каждый экспорт в своей подпапке) и роутим обычный openInViewer. Используют: экспорт результата
// SQL-запроса (CSV/JSON), просмотр файла из контейнера, правка удалённого файла (SFTP) и т.п.
function stageTextForViewer(name, content) {
  // Контент бывает чувствительным (SQL-выгрузки, конфиги с хоста) → каталог 0700 / файл 0600,
  // имя каталога — из CSPRNG (общий /tmp, соседний юзер не должен ни читать, ни угадать путь).
  const base = String(name || 'export.txt').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120) || 'export.txt';
  const dir = path.join(os.tmpdir(), 'lite-editor-view', Date.now().toString(36) + crypto.randomBytes(9).toString('hex'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, base);
  fs.writeFileSync(file, String(content == null ? '' : content), { encoding: 'utf8', mode: 0o600 });
  return file;
}
ipcMain.handle('editor:openTextInViewer', (_e, { name, content } = {}) => {
  try {
    const file = stageTextForViewer(name, content);
    routeOpenInViewer({ path: file });
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Правка удалённого файла в вивере (SFTP/FTP): tmp-копия → вивер; каждое сохранение tmp-файла
// (fs:writeFile ловит по этой карте) заливается обратно на хост. Карта живёт до конца процесса.
const remoteViewerFiles = new Map(); // tmpFile -> { rhId, remotePath }
ipcMain.handle('rh:fsOpenInViewer', async (_e, { id, path: p } = {}) => {
  try {
    const r = await rhApi.readFile(id, p);
    if (!r || r.error) return { ok: false, error: (r && r.error) || 'не удалось прочитать файл' };
    if (r.binary) return { ok: false, error: 'Бинарный файл — в вивере не редактируется' };
    const file = stageTextForViewer(path.posix.basename(String(p || '')) || 'remote.txt', r.content || '');
    remoteViewerFiles.set(file, { rhId: id, remotePath: p });
    routeOpenInViewer({ path: file });
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// «Скачать файл с хоста»: нативный диалог сохранения + потоковая выгрузка (бинарники тоже,
// без порога просмотра). Окно-владелец берём у отправителя — диалог модален своему окну модуля.
ipcMain.handle('rh:fsDownload', async (e, { id, path: p } = {}) => {
  const base = path.posix.basename(String(p || '')) || 'file';
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(senderWin(e) || mainWindow, {
    title: 'Скачать файл с хоста',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), base),
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const r = await rhApi.downloadFile(id, p, res.filePath);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'не удалось скачать файл' };
  saveState({ lastOpenDir: path.dirname(res.filePath) });
  return { ok: true, file: res.filePath };
});
ipcMain.on('editor:refreshTree', (_e, payload) => { const w = filesWindow(); if (w) sendTo(w, 'editor:refreshTree', payload); });
// «Git» из редактора: открыть окно вивера (если закрыто) и переключить его на секцию «Коммит».
ipcMain.on('editor:focusGit', () => {
  if (!filesWindow()) openModuleWindow('files');
  const w = filesWindow();
  if (w && filesViewerReady) { if (w.isMinimized()) w.restore(); w.focus(); sendTo(w, 'editor:focusGit'); }
  else pendingFocusGit = true;
});
ipcMain.on('editor:viewerReady', () => {
  filesViewerReady = true;
  while (pendingViewerOpens.length) { const p = pendingViewerOpens.shift(); const w = filesWindow(); if (w) sendTo(w, 'editor:openInViewer', p); }
  if (pendingFocusGit) { pendingFocusGit = false; const w = filesWindow(); if (w) { w.focus(); sendTo(w, 'editor:focusGit'); } }
});
// «Контейнеры» → «Базы данных»: открыть окно модуля БД с заготовкой подключения из контейнера.
// Паттерн тот же, что у вивера выше: окно может быть не готово сразу → очередь до db:panelReady.
let dbPanelReady = false;
const pendingDbOpens = [];
function dbModWindow() { const w = moduleWindows.get('db'); return (w && !w.isDestroyed()) ? w : null; }
ipcMain.on('db:openFromContainer', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (!dbModWindow()) openModuleWindow('db');
  const w = dbModWindow();
  if (w && dbPanelReady) { if (w.isMinimized()) w.restore(); w.focus(); sendTo(w, 'db:openFromContainer', payload); }
  else pendingDbOpens.push(payload);
});
ipcMain.on('db:panelReady', () => {
  dbPanelReady = true;
  const w = dbModWindow();
  while (w && pendingDbOpens.length) { w.focus(); sendTo(w, 'db:openFromContainer', pendingDbOpens.shift()); }
  while (w && pendingDbSql.length) { w.focus(); sendTo(w, 'db:openSql', pendingDbSql.shift()); }
});
// Вивер → «Базы данных»: выполнить SQL на выбранном подключении (та же очередь до готовности окна).
const pendingDbSql = [];
ipcMain.on('db:openSql', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (!dbModWindow()) openModuleWindow('db');
  const w = dbModWindow();
  if (w && dbPanelReady) { if (w.isMinimized()) w.restore(); w.focus(); sendTo(w, 'db:openSql', payload); }
  else pendingDbSql.push(payload);
});
// «Контейнеры» → «RabbitMQ»: тот же паттерн, что и с БД выше.
let rmqPanelReady = false;
const pendingRmqOpens = [];
function rmqModWindow() { const w = moduleWindows.get('rmq'); return (w && !w.isDestroyed()) ? w : null; }
ipcMain.on('rmq:openFromContainer', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (!rmqModWindow()) openModuleWindow('rmq');
  const w = rmqModWindow();
  if (w && rmqPanelReady) { if (w.isMinimized()) w.restore(); w.focus(); sendTo(w, 'rmq:openFromContainer', payload); }
  else pendingRmqOpens.push(payload);
});
// «Контейнеры» → «Внешние хранилища» (MinIO): тот же паттерн, что и с БД/RabbitMQ.
let stPanelReady = false;
const pendingStOpens = [];
function stModWindow() { const w = moduleWindows.get('storage'); return (w && !w.isDestroyed()) ? w : null; }
ipcMain.on('st:openFromContainer', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (!stModWindow()) openModuleWindow('storage');
  const w = stModWindow();
  if (w && stPanelReady) { if (w.isMinimized()) w.restore(); w.focus(); sendTo(w, 'st:openFromContainer', payload); }
  else pendingStOpens.push(payload);
});
ipcMain.on('st:panelReady', () => {
  stPanelReady = true;
  const w = stModWindow();
  while (w && pendingStOpens.length) { w.focus(); sendTo(w, 'st:openFromContainer', pendingStOpens.shift()); }
});
ipcMain.on('rmq:panelReady', () => {
  rmqPanelReady = true;
  const w = rmqModWindow();
  while (w && pendingRmqOpens.length) { w.focus(); sendTo(w, 'rmq:openFromContainer', pendingRmqOpens.shift()); }
});
// «Контейнеры» → «Kafka»: тот же паттерн, что и с БД/RabbitMQ выше.
let kafkaPanelReady = false;
const pendingKafkaOpens = [];
function kafkaModWindow() { const w = moduleWindows.get('kafka'); return (w && !w.isDestroyed()) ? w : null; }
ipcMain.on('kafka:openFromContainer', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (!kafkaModWindow()) openModuleWindow('kafka');
  const w = kafkaModWindow();
  if (w && kafkaPanelReady) { if (w.isMinimized()) w.restore(); w.focus(); sendTo(w, 'kafka:openFromContainer', payload); }
  else pendingKafkaOpens.push(payload);
});
ipcMain.on('kafka:panelReady', () => {
  kafkaPanelReady = true;
  const w = kafkaModWindow();
  while (w && pendingKafkaOpens.length) { w.focus(); sendTo(w, 'kafka:openFromContainer', pendingKafkaOpens.shift()); }
});
ipcMain.on('editor:sendToTerminal', (_e, payload) => forwardToEditor('editor:sendToTerminal', payload));
// «Пропустить отдых» с оверлея в окне редактора → пропустить текущую фазу помодоро (движок в main).
ipcMain.on('editor:pomodoroSkip', () => { if (POMO.running) pomoAdvance(); });
ipcMain.on('editor:sendNoteToTerminal', (_e, payload) => forwardToEditor('editor:sendNoteToTerminal', payload));
// Окно вивера (встроенный Git) попросило редактор перерисовать список проектов (git-бейджи после commit/checkout).
ipcMain.on('editor:refreshProjects', () => { sendTo(mainWindow, 'editor:refreshProjects'); });

// Reflect how many agents need attention on the tray tooltip (and macOS title).
let trayAttention = 0;
function updateTrayTooltip() {
  if (!tray) return;
  tray.setToolTip(trayAttention > 0 ? `LiteEditorAI — ${i18n.t('{0} ждут ответа', trayAttention)}` : 'LiteEditorAI');
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: i18n.t('Показать LiteEditor'), click: showWindow },
      { type: 'separator' },
      { label: i18n.t('Выход'), click: () => app.quit() },
    ]));
  } catch (_) {}
}
ipcMain.on('tray:update', (_e, { attention } = {}) => {
  trayAttention = attention || 0;
  updateTrayTooltip();
  if (process.platform === 'darwin' && app.dock) app.setBadgeCount(trayAttention);
});

// Grow/shrink the window to the right by dx px (used when the viewer opens, so
// the terminal keeps its size instead of being squished).
ipcMain.on('win:growBy', (e, { dx }) => {
  // growBy растягивает ТОЛЬКО окно редактора (правый слот). В окнах модулей панель занимает всё окно,
  // поэтому их вызовы growBy (напр. из setOpen(false) модуля) — no-op, чтобы не двигать окно редактора.
  if (!mainWindow || senderWin(e) !== mainWindow) return;
  if (mainWindow.isFullScreen() || mainWindow.isMaximized()) return;
  const b = mainWindow.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  // Accumulate the request in a virtual width (unclamped) so a clamped grow + full shrink
  // cancel out exactly. Re-sync from the real width if the user resized in between.
  const base = growDesiredWidth != null ? growDesiredWidth : b.width;
  growDesiredWidth = Math.max(760, base + dx);
  const width = Math.max(760, Math.min(growDesiredWidth, work.x + work.width - b.x)); // don't run off-screen
  growAppliedWidth = width;
  mainWindow.setBounds({ x: b.x, y: b.y, width, height: b.height });
});

// Расширить/сузить ОКНО-ОТПРАВИТЕЛЬ по ширине на dx (для окон модулей: напр. канбан-вид «Задач»
// делает окно шире). В отличие от win:growBy (только окно редактора) — работает с любым окном-отправителем.
ipcMain.on('win:resizeBy', (e, { dx } = {}) => {
  const w = senderWin(e);
  if (!w || w.isDestroyed() || w.isFullScreen() || w.isMaximized()) return;
  const b = w.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  const width = Math.max(420, Math.min(b.width + (Number(dx) || 0), work.x + work.width - b.x));
  w.setBounds({ x: b.x, y: b.y, width, height: b.height });
});
// Компактный режим окна-модуля (кнопка «минимализм»): ужать окно до заданных габаритов, запомнив
// прежние; off — вернуть запомненные. Габариты клампятся к minWidth/minHeight окна и к экрану.
ipcMain.on('win:compact', (e, { on, width, height } = {}) => {
  const w = senderWin(e);
  if (!w || w.isDestroyed() || w.isFullScreen() || w.isMaximized()) return;
  const b = w.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  if (on) {
    w.__preCompact = { width: b.width, height: b.height };
    const cw = Math.max(420, Math.min(Number(width) || 420, work.width));
    const ch = Math.max(320, Math.min(Number(height) || 520, work.height));
    w.setBounds({ x: b.x, y: b.y, width: cw, height: ch });
  } else if (w.__preCompact) {
    const pc = w.__preCompact; w.__preCompact = null;
    w.setBounds({ x: b.x, y: b.y, width: pc.width, height: pc.height });
  }
});

// ---------------------------------------------------------------- dialogs
// Remember the last folder you navigated to, so the picker reopens there.
function lastDirOpts() {
  const last = loadState().lastOpenDir;
  return last && fs.existsSync(last) ? { defaultPath: last } : {};
}

ipcMain.handle('dialog:openProject', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Открыть папку', properties: ['openDirectory'], ...lastDirOpts(),
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const dir = res.filePaths[0];
  saveState({ lastOpenDir: path.dirname(dir) }); // next time start in the containing folder
  return { path: dir, name: path.basename(dir) || dir };
});

ipcMain.handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Где создать папку', properties: ['openDirectory', 'createDirectory'], ...lastDirOpts(),
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const dir = res.filePaths[0];
  saveState({ lastOpenDir: dir });
  return dir;
});

// ---------------------------------------------------------------- PTY
// Окружение для пользовательских шеллов/exec. Своих служебных переменных редактор больше не
// заводит (набор появлялся ради удалённого пульта и ушёл вместе с ним, см. v1.1.175), поэтому
// среда передаётся как есть; аргумент extra позволяет добавить точечные переменные.
function userShellEnv(extra) {
  return Object.assign({}, process.env, extra || {});
}

// owner = webContents окна, создавшего сессию (редактор для терминалов проектов, окно «Система · ~»
// для scratch). Данные/выход маршрутизируем владельцу (sendToOwner; фолбэк — окно редактора).
function spawnPtyFor(id, cwd, cols, rows, owner) {
  if (owner) ownerBySession.set(id, owner);
  const { file: shell, args: shellArgs } = resolveShell();
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // Log around the spawn: it runs synchronously on the main thread, so if it ever
  // hangs (e.g. a ConPTY conout pipe never connecting on Windows) the log shows
  // "pty spawn …" with no following "pty spawned …" — pinpointing the freeze.
  logger.log('info', 'pty', `spawn shell=${shell} args=${shellArgs.join(' ')} cwd=${startCwd}`);
  let proc;
  try {
    proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startCwd,
      env: userShellEnv({ SHELL: shell }),   // SHELL → реальный шелл, а не тот, что унаследован от лаунчера
    });
  } catch (err) {
    logger.log('error', 'pty', 'spawn failed', err);
    sendToOwner(id, 'pty:data', { id, data: `\r\n\x1b[31mНе удалось запустить шелл (${shell}): ${err.message}\x1b[0m\r\n` });
    sendToOwner(id, 'pty:exit', { id });
    return { error: String(err.message || err) };
  }
  logger.log('info', 'pty', `spawned pid=${proc.pid}`);
  proc.onData((data) => sendToOwner(id, 'pty:data', { id, data }));   // окну-владельцу (редактор/scratch-окно)
  proc.onExit(() => {
    if (ptys.get(id) && ptys.get(id) !== proc) return; // replaced by a restart — suppress stale exit
    ptys.delete(id);
    sendToOwner(id, 'pty:exit', { id });
    ownerBySession.delete(id); // сессия закрылась — не копим мёртвые id в карте маршрутизации (B4-LOW)
  });
  ptys.set(id, proc);
  return { ok: true };
}
ipcMain.handle('pty:create', (e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) { ownerBySession.set(id, e.sender); return { ok: true, existed: true }; }
  return spawnPtyFor(id, cwd, cols, rows, e.sender);
});
// Kill the existing PTY (if any) and start a fresh one in the same cwd.
ipcMain.handle('pty:restart', (e, { id, cwd, cols, rows }) => {
  const old = ptys.get(id);
  if (old) { try { old.kill(); } catch (_) {} ptys.delete(id); }
  return spawnPtyFor(id, cwd, cols, rows, e.sender);
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
});
ipcMain.on('pty:kill', (_e, { id }) => {
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); }
});
// 'shell' | 'running' | 'waiting' | null — see foregroundKind().
ipcMain.handle('pty:foregroundState', (_e, { id }) => {
  const p = ptys.get(id);
  return p ? foregroundKind(p.pid) : null;
});

// ---------------------------------------------------------------- Монитор ресурсов
// Самонаблюдение за потреблением. Снимок раздельно по двум мирам:
//   • Electron-процессы (app.getAppMetrics, маппинг pid→окно) — это «сам редактор», что и можно
//     оптимизировать (число окон-модулей, утечки в рендерерах);
//   • деревья процессов терминалов (PTY-агенты, /proc — ТОЛЬКО Linux) — «полезная нагрузка», к
//     редактору отношения почти не имеет (claude/codex молотят по делу). Не смешиваем, чтобы цифры
//     агентов не выдавались за расход редактора.
// CPU% PTY считаем дельтой между последовательными вызовами (UI опрашивает раз в ~3с) — без
// искусственных sleep. getAppMetrics уже отдаёт cpu.percentCPUUsage за интервал с прошлого вызова.
const MONITOR_PAGE = 4096;                    // размер страницы (rss в /proc/<pid>/stat — в страницах)
const MODULE_TITLES = {
  tools: 'Инструменты', iterflow: 'IterFlow', seo: 'WEB/SEO аудит', audit: 'Аудит',
  pomodoro: 'Помодоро', company: 'ИИ компания', notes: 'Задачи', db: 'Базы данных',
  chat: 'OpenRouter', doc: 'Обработка текста', docker: 'Контейнеры', rh: 'Удалённые хосты',
  ctx: 'Контекст', scratch: 'Система · ~', files: 'Проект', monitor: 'Монитор',
};
let monPrev = null;   // { total, perSid: Map<sid,jiffies> } — для расчёта CPU% деревьев PTY

// /proc/<pid>/stat → { comm, ppid, jiffies (utime+stime), rssBytes }; null если процесс исчез.
function readPidStatFull(pid) {
  try {
    const data = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const r = data.lastIndexOf(')');
    const comm = data.slice(data.indexOf('(') + 1, r);
    const f = data.slice(r + 2).split(' '); // [0]=state [1]=ppid … [11]=utime [12]=stime [21]=rss(стр.)
    return { comm, ppid: +f[1] || 0, jiffies: (+f[11] || 0) + (+f[12] || 0), rssBytes: (+f[21] || 0) * MONITOR_PAGE };
  } catch (_) { return null; }
}
// суммарные «джиффи» процессора из /proc/stat (для нормировки CPU% деревьев PTY)
function readTotalJiffies() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0]; // "cpu  u n s i ..."
    return line.trim().split(/\s+/).slice(1).reduce((a, b) => a + (+b || 0), 0);
  } catch (_) { return 0; }
}
function monitorSessionLabel(sid) {
  const s = String(sid);
  const pid = s.split('::')[0];
  try { const p = (readStoreKey('projects') || []).find((x) => x.id === pid); if (p) return 'Терминал: ' + p.name; } catch (_) {}
  return 'Терминал: ' + s;
}

ipcMain.handle('monitor:sample', () => {
  // ── Electron-процессы: pid → понятная метка (окно/модуль/GPU/служебный) ──
  const pidLabel = new Map();
  try { pidLabel.set(process.pid, { label: 'Ядро (main)', kind: 'main' }); } catch (_) {}
  try { if (mainWindow && !mainWindow.isDestroyed()) pidLabel.set(mainWindow.webContents.getOSProcessId(), { label: 'Главное окно', kind: 'window' }); } catch (_) {}
  for (const [modId, w] of moduleWindows) {
    if (!w || w.isDestroyed()) continue;
    try { pidLabel.set(w.webContents.getOSProcessId(), { label: 'Окно: ' + (MODULE_TITLES[modId] || modId), kind: 'window' }); } catch (_) {}
  }
  const TYPE_RU = { GPU: 'GPU', Utility: 'Служебный', Browser: 'Ядро (main)', Tab: 'Renderer', Pepper: 'Плагин' };
  const electron = (app.getAppMetrics() || []).map((m) => {
    const info = pidLabel.get(m.pid);
    return {
      pid: m.pid, type: m.type || '?',
      kind: info ? info.kind : (m.type === 'GPU' ? 'gpu' : 'util'),
      name: m.name || m.serviceName || '',
      label: info ? info.label : (TYPE_RU[m.type] || m.type || 'Процесс'),
      cpu: Math.round((m.cpu && m.cpu.percentCPUUsage || 0) * 10) / 10,
      memBytes: (m.memory && m.memory.workingSetSize || 0) * 1024, // workingSetSize в КБ
    };
  }).sort((a, b) => b.memBytes - a.memBytes);

  // ── PTY-агенты: деревья процессов терминалов (Linux) ──
  const pty = [];
  let ptyNote = null;
  if (process.platform === 'linux') {
    const all = new Map();
    try {
      for (const ent of fs.readdirSync('/proc')) {
        if (ent.charCodeAt(0) < 48 || ent.charCodeAt(0) > 57) continue; // только числовые pid
        const st = readPidStatFull(ent); if (st) all.set(+ent, st);
      }
    } catch (_) {}
    const kids = new Map();
    for (const [p, st] of all) { if (!kids.has(st.ppid)) kids.set(st.ppid, []); kids.get(st.ppid).push(p); }
    const total = readTotalJiffies();
    const dTotal = monPrev ? Math.max(0, total - monPrev.total) : 0;
    const ncpu = (os.cpus() || []).length || 1;
    const nowPer = new Map();
    for (const [sid, proc] of ptys) {
      const root = proc && proc.pid; if (!root) continue;
      const seen = new Set(); const stack = [root]; let rss = 0, jif = 0, n = 0, topComm = '';
      while (stack.length) {
        const p = stack.pop(); if (seen.has(p)) continue; seen.add(p);
        const st = all.get(p); if (!st) continue;
        rss += st.rssBytes; jif += st.jiffies; n++;
        if (p === root) topComm = st.comm;
        for (const c of (kids.get(p) || [])) stack.push(c);
      }
      nowPer.set(sid, jif);
      let cpu = 0;
      if (monPrev && monPrev.perSid.has(sid) && dTotal > 0) {
        cpu = Math.max(0, Math.round(((jif - monPrev.perSid.get(sid)) / dTotal) * ncpu * 100 * 10) / 10);
      }
      pty.push({ sid, pid: root, label: monitorSessionLabel(sid), comm: topComm, procs: n, state: foregroundKind(root), cpu, memBytes: rss });
    }
    pty.sort((a, b) => b.memBytes - a.memBytes);
    monPrev = { total, perSid: nowPer };
  } else {
    ptyNote = 'Детализация процессов терминалов доступна только на Linux.';
  }

  const editorMem = electron.reduce((s, p) => s + p.memBytes, 0);
  const editorCpu = Math.round(electron.reduce((s, p) => s + p.cpu, 0) * 10) / 10;
  const ptyMem = pty.reduce((s, p) => s + p.memBytes, 0);
  const ptyCpu = Math.round(pty.reduce((s, p) => s + p.cpu, 0) * 10) / 10;
  return {
    ok: true, ts: Date.now(),
    editor: { procs: electron, totalMem: editorMem, totalCpu: editorCpu },
    pty: { procs: pty, totalMem: ptyMem, totalCpu: ptyCpu, note: ptyNote },
  };
});

// ---------------------------------------------------------------- «Сейф паролей» (KeePass/.kdbx)
// Расшифровка целиком в main (Node: kdbxweb + node crypto, без бандлинга). Мастер-пароль приходит по
// IPC и НИГДЕ не логируется. Пароли записей в рендерер НЕ уходят: список содержит только метаданные
// (заголовок/логин/URL/имена полей), а копирование в буфер и показ конкретного поля делает main по
// запросу. Argon2 (KDBX4) — чистый JS из @noble/hashes (без нативщины/wasm).
let _kdbxweb = null, _nobleArgon = null;
function ensureKdbx() {
  if (_kdbxweb) return _kdbxweb;
  _kdbxweb = require('kdbxweb');
  _nobleArgon = require('@noble/hashes/argon2.js');
  _kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type, version) => {
    const fn = type === 0 ? _nobleArgon.argon2d : _nobleArgon.argon2id; // 0=Argon2d, 2=Argon2id; memory уже в KiB
    const out = fn(new Uint8Array(password), new Uint8Array(salt), { t: iterations, m: memory, p: parallelism, dkLen: length, version });
    return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  });
  return _kdbxweb;
}
let kpDb = null; let kpClipTimer = null;
let kpDbFile = null, kpDbName = null; // путь/имя открытой базы (status + запись новых записей)
const kpEntryById = new Map(); // uuid.id -> entry (живёт в main, в рендерер не отдаём)
function kpVal(en, field) { const v = en.fields.get(field); return v && typeof v.getText === 'function' ? v.getText() : (v == null ? '' : String(v)); }
// Метаданные записей открытой базы (секретные значения полей НЕ отдаём) + перестройка kpEntryById.
function kpListEntries() {
  kpEntryById.clear();
  const entries = [];
  const walk = (g, prefix) => {
    const gp = prefix ? prefix + ' / ' + (g.name || '') : (g.name || '');
    for (const en of g.entries) {
      const id = en.uuid && en.uuid.id; if (!id) continue;
      kpEntryById.set(id, en);
      const fields = [];
      for (const [k, v] of en.fields) {
        if (k === 'Title') continue;
        const secret = !!(v && typeof v.getText === 'function');
        if (secret || (v != null && String(v) !== '')) fields.push({ name: k, secret, value: secret ? null : String(v) }); // секретные значения НЕ отдаём
      }
      entries.push({ id, title: kpVal(en, 'Title') || '(без названия)', username: kpVal(en, 'UserName'), url: kpVal(en, 'URL'), group: gp, fields });
    }
    for (const sg of g.groups) walk(sg, gp);
  };
  walk(kpDb.getDefaultGroup(), '');
  return entries;
}

ipcMain.handle('keepass:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Открыть базу KeePass', properties: ['openFile'],
    filters: [{ name: 'KeePass', extensions: ['kdbx'] }, { name: 'Все файлы', extensions: ['*'] }], ...lastDirOpts(),
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const file = res.filePaths[0];
  saveState({ lastOpenDir: path.dirname(file) });
  return { ok: true, path: file, name: path.basename(file) };
});
ipcMain.handle('keepass:open', async (_e, { path: file, password } = {}) => {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'Файл не найден' };
    const kw = ensureKdbx();
    const buf = fs.readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const cred = new kw.Credentials(kw.ProtectedValue.fromString(String(password || '')));
    const db = await kw.Kdbx.load(ab, cred);   // мастер-пароль использован только здесь, не сохраняем
    kpDb = db; kpDbFile = file; kpDbName = path.basename(file);
    return { ok: true, name: kpDbName, entries: kpListEntries() };
  } catch (err) {
    const code = err && err.code;
    return { ok: false, error: code === 'InvalidKey' ? 'Неверный мастер-пароль' : ('Не удалось открыть базу: ' + ((err && err.message) || err)) };
  }
});
ipcMain.handle('keepass:reveal', (_e, { id, field } = {}) => {
  const en = kpEntryById.get(id); if (!en) return { ok: false, error: 'нет записи' };
  return { ok: true, value: kpVal(en, field) };
});
ipcMain.handle('keepass:copy', (_e, { id, field } = {}) => {
  const en = kpEntryById.get(id); if (!en) return { ok: false, error: 'нет записи' };
  const val = kpVal(en, field);
  try { clipboard.writeText(val); } catch (_) { return { ok: false, error: 'буфер недоступен' }; }
  if (kpClipTimer) clearTimeout(kpClipTimer);
  kpClipTimer = setTimeout(() => { try { if (clipboard.readText() === val) clipboard.writeText(''); } catch (_) {} }, 20000); // авто-очистка
  return { ok: true };
});
ipcMain.on('keepass:lock', () => { kpDb = null; kpDbFile = null; kpDbName = null; kpEntryById.clear(); if (kpClipTimer) { clearTimeout(kpClipTimer); kpClipTimer = null; } });
// --- Шов «из сейфа» для форм подключений (db/rmq/kafka/rh): пикер записей в чужом окне.
ipcMain.handle('keepass:status', () => ({ open: !!kpDb, name: kpDbName }));
ipcMain.handle('keepass:entries', () => {
  if (!kpDb) return { ok: false, closed: true, error: 'База не открыта' };
  try { return { ok: true, name: kpDbName, entries: kpListEntries() }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Креды записи для автозаполнения формы подключения. Пароль уходит в рендерер ФОРМЫ — ровно тот же
// путь, что и ручной ввод пароля в это поле (дальше он шифруется в safeStorage при сохранении).
ipcMain.handle('keepass:cred', (_e, { id } = {}) => {
  const en = kpEntryById.get(id); if (!en) return { ok: false, error: 'нет записи' };
  return { ok: true, username: kpVal(en, 'UserName'), password: kpVal(en, 'Password'), url: kpVal(en, 'URL') };
});
// Новая запись в открытую базу (кнопка «в сейф» в формах подключений). Перед записью — бэкап
// рядом с базой (страховка от порчи ценного файла), затем kdbxweb save → перезапись .kdbx.
ipcMain.handle('keepass:add', async (_e, { title, username, password, url, notes } = {}) => {
  if (!kpDb || !kpDbFile) return { ok: false, closed: true, error: 'База не открыта' };
  try {
    const kw = ensureKdbx();
    const en = kpDb.createEntry(kpDb.getDefaultGroup());
    en.fields.set('Title', String(title || 'Без названия'));
    if (username) en.fields.set('UserName', String(username));
    if (password) en.fields.set('Password', kw.ProtectedValue.fromString(String(password)));
    if (url) en.fields.set('URL', String(url));
    if (notes) en.fields.set('Notes', String(notes));
    try { fs.copyFileSync(kpDbFile, kpDbFile + '.lite-bak'); } catch (_) {} // best-effort бэкап
    const ab = await kpDb.save();
    atomicWriteSync(kpDbFile, Buffer.from(ab));   // не обычный writeFile: обрыв посреди записи убил бы .kdbx целиком
    kpListEntries(); // перестроить карту id → entry (включая новую запись)
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ---------------------------------------------------------------- заставка «матрица» (кросс-оконный простой)
// Активность ЛЮБОГО окна (редактор + окна модулей) шлёт screensaver:activity → обновляем метку простоя
// и, если заставка показана авто, гасим её. Тик раз в 5с: если включено в настройках и простой дольше
// порога — показываем заставку на ГЛАВНОМ окне (screensaver:set on). Настройки: settings.screensaver
// (вкл, по умолчанию ДА) + settings.screensaverMins (минуты, по умолчанию 5).
let ssLast = Date.now();
let ssActive = false;
function ssConfig() { const s = readStoreKey('settings') || {}; return { on: s.screensaver !== false, mins: Math.max(1, Math.min(180, Number(s.screensaverMins) || 5)) }; }
function ssSet(on) { ssActive = on; sendTo(mainWindow, 'screensaver:set', { on }); }
ipcMain.on('screensaver:activity', () => { ssLast = Date.now(); if (ssActive) ssSet(false); });
const ssTimer = setInterval(() => {
  const { on, mins } = ssConfig();
  if (!on || ssActive) return;
  if (Date.now() - ssLast > mins * 60000) ssSet(true);
}, 5000);
if (ssTimer.unref) ssTimer.unref();

// ---------------------------------------------------------------- мониторинг сайтов (target → checks)
// STORE 'siteMon' = массив ЦЕЛЕЙ (target). Цель = URL + общие настройки (интервал, заголовки,
// «рендерить»). У цели ≥1 ЧЕК (статус-рамка): своё условие, состояние, история, уведомления. main в
// ФОНЕ грузит URL ОДИН раз за цикл и прогоняет по этому ответу все чеки цели. Чек бывает:
//   • basic  — декларативный предикат из полей (экстрактор → компаратор → ожидание);
//   • custom — чистая функция-предикат, которую написал агент, исполняется в vm-песочнице.
// Внутренний примитив один: predicate(capture) → { ok, value, label }. На СМЕНУ состояния (после
// debounce) — нативное уведомление + событие 'sitemon:update' в окна. Правки — из окна модуля по IPC.
const SM_HISTORY = 60;
const SM_BODY_CAP = 2 * 1024 * 1024;      // тело ответа режем по 2 МБ
let smTargets = [];

function smNewId(p) { return (p || 'sm') + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
function smNormUrl(url) { let u = String(url || '').trim(); if (!u) return null; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; try { new URL(u); return u; } catch (_) { return null; } }
function smClampInt(v) { return Math.max(15, Math.min(86400, Number(v) || 60)); }
function smCleanHeaders(h) { if (!h || typeof h !== 'object') return null; const out = {}; let n = 0; for (const k of Object.keys(h)) { if (n++ >= 20) break; const key = String(k).trim(); if (!key) continue; out[key] = String(h[k]); } return Object.keys(out).length ? out : null; }

// ── одиночный HTTP(S)-запрос: следуем редиректам, режем тело, кастомные заголовки, таймаут ──────────
// TLS проверяется по умолчанию (истёкший/самоподписанный серт = ошибка = валидный сигнал мониторинга).
// Отключить проверку можно ТОЛЬКО явным opt-in на цель (insecureTls) — иначе MITM увёл бы Authorization.
function smFetch(rawUrl, opts = {}) {
  const headers = (opts.headers && typeof opts.headers === 'object') ? opts.headers : null;
  const timeoutMs = opts.timeoutMs || 12000;
  const rejectUnauthorized = opts.insecureTls !== true;
  return new Promise((resolve) => {
    let redirects = 6;
    const go = (urlStr) => {
      let u; try { u = new URL(urlStr); } catch (_) { return resolve({ ok: false, error: 'некорректный URL' }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, error: 'только http/https' });
      const mod = u.protocol === 'https:' ? https : http;
      const t0 = Date.now();
      let req;
      try {
        req = mod.request(u, { method: 'GET', rejectUnauthorized, headers: Object.assign({ 'User-Agent': 'LiteEditor-Monitor/1.0', 'Accept': '*/*' }, headers || {}), timeout: timeoutMs }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { redirects--; res.resume(); try { return go(new URL(res.headers.location, u).toString()); } catch (_) { return resolve({ ok: false, error: 'плохой редирект' }); } }
          const chunks = []; let len = 0, capped = false;
          res.on('data', (c) => { if (len < SM_BODY_CAP) { chunks.push(c); len += c.length; } else capped = true; });
          res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0, bytes: len, capped }));
          res.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        });
      } catch (e) { return resolve({ ok: false, error: String((e && e.message) || e) }); }
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: 'таймаут' }); });
      req.on('error', (e) => resolve({ ok: false, error: (e && e.code === 'ENOTFOUND') ? 'домен не найден' : String((e && e.message) || e) }));
      req.end();
    };
    go(rawUrl);
  });
}

// ── рендер страницы в скрытом окне: innerText + textContent нужных селекторов (для SPA / DOM-чеков) ──
function smRenderCapture(url, selectors, timeoutMs) {
  return new Promise((resolve) => {
    let win = null, done = false;
    const finish = (r) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {} resolve(r); };
    const to = setTimeout(() => finish({ error: 'таймаут рендера' }), (timeoutMs || 15000) + 3000);
    try {
      win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: false, images: false, contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: true } });
      try { win.webContents.setAudioMuted(true); } catch (_) {}
      win.webContents.on('did-finish-load', async () => {
        try {
          await new Promise((r) => setTimeout(r, 1200));    // дать SPA дорисоваться
          const text = await win.webContents.executeJavaScript('(document.body?document.body.innerText:"").slice(0,500000)');
          const sel = {};
          for (const s of (selectors || [])) { try { sel[s] = await win.webContents.executeJavaScript('(function(){try{var e=document.querySelector(' + JSON.stringify(s) + ');return e?(e.textContent||"").trim():null;}catch(_){return null;}})()'); } catch (_) { sel[s] = null; } }
          clearTimeout(to); finish({ text, sel });
        } catch (e) { clearTimeout(to); finish({ error: String((e && e.message) || e) }); }
      });
      win.webContents.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => { if (isMainFrame) { clearTimeout(to); finish({ error: desc || ('ошибка загрузки ' + code) }); } });
      win.loadURL(url, { userAgent: 'LiteEditor-Monitor/1.0' });
    } catch (e) { clearTimeout(to); finish({ error: String((e && e.message) || e) }); }
  });
}

// ── извлечение значения / сравнение / json-путь / форматирование ───────────────────────────────────
function smJsonPath(obj, path) {
  if (obj === undefined || obj === null) return undefined;
  const parts = String(path || '').replace(/\[(\d+)\]/g, '.$1').replace(/\[["']?([^"'\]]+)["']?\]/g, '.$1').split('.').map((s) => s.trim()).filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur === null || cur === undefined) return undefined; cur = cur[p]; }
  return cur;
}
function smExtract(spec, cap) {
  switch (spec.source) {
    case 'status': return cap.status;
    case 'latency': return cap.ms;
    case 'text': return cap.text || '';
    case 'header': return cap.headers ? cap.headers[String(spec.path || '').toLowerCase()] : undefined;
    case 'json': return smJsonPath(cap.json, spec.path);
    case 'css': return cap.sel ? cap.sel[spec.path] : undefined;
    case 'regex': { try { const m = new RegExp(spec.path).exec(cap.text || ''); return m ? (m[1] !== undefined ? m[1] : m[0]) : undefined; } catch (_) { return undefined; } }
    default: return undefined;
  }
}
function smNum(v) { return parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/[^0-9.eE+-]/g, '')); }
function smCompare(val, cmp, exp) {
  const s = (v) => (v === undefined || v === null ? '' : String(v));
  switch (cmp) {
    case 'eq': { if (s(val).trim() === s(exp).trim()) return true; const a = smNum(val), b = smNum(exp); return isFinite(a) && isFinite(b) && a === b; }
    case 'ne': return s(val).trim() !== s(exp).trim();
    case 'lt': return smNum(val) < smNum(exp);
    case 'le': return smNum(val) <= smNum(exp);
    case 'gt': return smNum(val) > smNum(exp);
    case 'ge': return smNum(val) >= smNum(exp);
    case 'contains': return s(val).includes(s(exp));
    case 'ncontains': return !s(val).includes(s(exp));
    case 'matches': { try { return new RegExp(exp).test(s(val)); } catch (_) { return false; } }
    case 'exists': return val !== undefined && val !== null && s(val) !== '';
    default: return false;
  }
}
function smNorm(v) { if (v === undefined) return '∅u'; if (v === null) return '∅n'; return typeof v === 'object' ? JSON.stringify(v) : String(v); }
function smFmtVal(v) { if (v === undefined) return '∅'; if (v === null) return 'null'; let s; if (typeof v === 'object') { try { s = JSON.stringify(v); } catch (_) { return '[object]'; } } else s = String(v); return s.length > 120 ? s.slice(0, 117) + '…' : s; }
function smFmtShort(v) { const s = String(v); return s.length > 40 ? s.slice(0, 37) + '…' : s; }

// ── песочница пользовательского предиката ──────────────────────────────────────────────────────────
// input передаём JSON-строкой и реконструируем ВНУТРИ контекста (JSON.parse): все объекты, что видит
// предикат, принадлежат песочнице, поэтому input.constructor.constructor НЕ дотягивается до хостового
// Function/process (защита от побега через прототип). Контекст свежий — нет require/process/таймеров/
// import(); timeout ловит зацикливание. Код доверенный (пишет пользователь/его агент), но т.к. «сэмпл»
// мониторимого URL попадает в промпт, изолируем данные хоста от предиката строго.
function smRunCustom(code, input) {
  let j; try { j = JSON.stringify(input === undefined ? null : input); } catch (_) { j = 'null'; }
  return vm.runInNewContext('"use strict";const input=JSON.parse(__j);(' + String(code || '').trim() + ')(input)', { __j: j }, { timeout: 1500, contextName: 'sitemon-predicate' });
}

// ── что цели нужно достать (какие части ответа собирать) ───────────────────────────────────────────
function smBuildCapture(target) {
  const checks = target.checks || [];
  const anyCustom = checks.some((c) => c.kind === 'custom');
  const needJson = anyCustom || checks.some((c) => c.kind === 'basic' && c.spec && c.spec.source === 'json');
  const cssSel = []; for (const c of checks) if (c.kind === 'basic' && c.spec && c.spec.source === 'css' && c.spec.path) cssSel.push(c.spec.path);
  const needDom = !!target.render && (anyCustom || cssSel.length > 0 || checks.some((c) => c.kind === 'basic' && c.spec && (c.spec.source === 'text' || c.spec.source === 'regex')));
  return smFetch(target.url, { headers: target.headers, timeoutMs: 12000, insecureTls: !!target.insecureTls }).then(async (res) => {
    const cap = { url: target.url, ok: !!res.ok, status: res.ok ? (res.status || 0) : 0, ms: res.ms || 0, headers: res.headers || {}, text: res.ok ? (res.body || '') : '', json: undefined, sel: {}, error: res.ok ? '' : (res.error || 'нет связи') };
    if (needJson && cap.ok) { try { cap.json = JSON.parse(res.body || ''); } catch (_) { cap.json = undefined; } }
    if (needDom && cap.ok) { const dom = await smRenderCapture(target.url, cssSel, 15000); if (dom && !dom.error) { cap.text = dom.text || cap.text; cap.sel = dom.sel || {}; cap.rendered = true; } else if (dom) cap.renderError = dom.error; }
    return cap;
  });
}

// Статусы чека (4 цвета): ok🟢 / warn🟡 / triggered🔴(«тревога») / info🔵. Плюс системные error/unknown.
// Нормализуем то, что вернул кастомный предикат (status-строка ИЛИ легаси ok:boolean).
function smNormStatus(out) {
  let s = out && out.status;
  if (s != null) {
    s = String(s).toLowerCase().trim();
    if (s === 'ok' || s === 'green' || s === 'good' || s === 'up' || s === 'success' || s === 'pass') return 'ok';
    if (s === 'warn' || s === 'warning' || s === 'yellow' || s === 'degraded') return 'warn';
    if (s === 'info' || s === 'blue' || s === 'note' || s === 'notice') return 'info';
    if (s === 'alert' || s === 'red' || s === 'bad' || s === 'down' || s === 'triggered' || s === 'critical' || s === 'fail' || s === 'error') return 'triggered';
  }
  if (out && typeof out.ok === 'boolean') return out.ok ? 'ok' : 'triggered';
  return null;
}
// ── оценить один чек по готовому capture. mutate=true разрешает обновлять baseline (для «изменилось») ──
function smEvalCheck(check, cap, mutate) {
  try {
    if (check.kind === 'custom') {
      const input = { url: cap.url, ok: cap.ok, status: cap.status, ms: cap.ms, headers: cap.headers, text: cap.text, json: cap.json, error: cap.error };
      const out = smRunCustom(check.code, input);
      if (out === null || typeof out !== 'object') return { state: 'error', value: '', error: 'предикат вернул не объект {status,…}' };
      const state = smNormStatus(out);
      if (!state) return { state: 'error', value: '', error: 'нет статуса: верните {status:"ok|warn|alert|info"} или {ok:true|false}' };
      const label = out.label != null ? String(out.label) : (out.value != null ? smFmtVal(out.value) : '');
      return { state, value: label, error: '' };
    }
    const spec = check.spec || {};
    // уровень базового чека при НЕ-выполнении условия: тревога(красн, по умолч.) / внимание(жёлт) / инфо(син)
    const levelState = spec.level === 'warn' ? 'warn' : spec.level === 'info' ? 'info' : 'triggered';
    if (spec.cmp === 'up') {
      const ok = cap.ok && cap.status > 0 && cap.status < 400;
      return { state: ok ? 'ok' : 'triggered', value: cap.ok ? ('HTTP ' + cap.status + ' · ' + cap.ms + ' мс') : (cap.error || 'нет связи'), error: '' };
    }
    if (!cap.ok) return { state: 'error', value: '', error: cap.error || 'сайт недоступен' };
    const raw = smExtract(spec, cap);
    if (spec.cmp === 'changed') {
      const cur = smNorm(raw);
      if (check.baseline === undefined || check.baseline === null) { if (mutate) check.baseline = cur; return { state: 'ok', value: 'эталон: ' + smFmtVal(raw), error: '' }; }
      if (cur !== check.baseline) { const was = check.baseline; if (mutate) check.baseline = cur; return { state: levelState, value: smFmtShort(was) + ' → ' + smFmtVal(raw), error: '', changed: true }; }
      return { state: 'ok', value: smFmtVal(raw), error: '' };
    }
    const ok = smCompare(raw, spec.cmp, spec.expected);
    return { state: ok ? 'ok' : levelState, value: smFmtVal(raw), error: '' };
  } catch (e) { return { state: 'error', value: '', error: String((e && e.message) || e) }; }
}

// ── дневная статистика чека (для графиков «за месяц»): последние 31 суток ───────────────────────────
function smDayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function smBumpStats(check, state, ms) {
  const key = smDayKey(Date.now());
  check.stats = Array.isArray(check.stats) ? check.stats : [];
  let b = check.stats[check.stats.length - 1];
  if (!b || b.d !== key) { b = { d: key, total: 0, ok: 0, warn: 0, trig: 0, info: 0, err: 0, msSum: 0, msN: 0 }; check.stats.push(b); if (check.stats.length > 31) check.stats = check.stats.slice(-31); }
  b.total++;
  if (state === 'ok') b.ok++; else if (state === 'warn') b.warn++; else if (state === 'triggered') b.trig++; else if (state === 'info') b.info++; else if (state === 'error') b.err++;
  if (typeof ms === 'number' && ms > 0) { b.msSum += ms; b.msN++; }
}

// ── зафиксировать результат чека: статистика, debounce, история, уведомление ────────────────────────
function smCommit(target, check, ev, ms) {
  check.checkedAt = Date.now();
  smBumpStats(check, ev.state, ms);
  check.value = ev.value; check.error = ev.error || '';
  const prev = check.state || 'unknown';
  const raw = ev.state;
  let flip = false;
  if (ev.changed) { flip = true; check.pend = null; }              // «изменилось» — импульс, без debounce
  else if (raw === prev) { check.pend = null; }
  else { const deb = Math.max(1, Number(check.debounce) || 1); if (!check.pend || check.pend.state !== raw) check.pend = { state: raw, n: 1 }; else check.pend.n++; if (check.pend.n >= deb) { flip = true; check.pend = null; } }
  const before = check.state;
  if (flip) check.state = raw;
  const hstate = ev.changed ? 'triggered' : (check.state || 'unknown');
  check.history = (check.history || []).concat({ t: check.checkedAt, s: hstate, v: (typeof ev.value === 'string' ? ev.value.slice(0, 60) : ev.value) }).slice(-SM_HISTORY);
  if (check.notify !== false) {
    // «изменилось» уведомляет ТОЛЬКО импульсом change; его «успокоение» →ok — не восстановление
    const isChange = ev.changed || (check.kind === 'basic' && check.spec && check.spec.cmp === 'changed');
    const attention = (s) => s === 'triggered' || s === 'warn'; // «тревога» и «внимание» — состояния для уведомления
    if (ev.changed) smNotify(target, check, 'change');
    else if (!isChange && flip && before && before !== 'unknown') {
      if (attention(check.state)) smNotify(target, check, check.state);        // вошли в тревогу/внимание
      else if (check.state === 'ok' && attention(before)) smNotify(target, check, 'up'); // восстановились
    }
  }
}
function smNotify(target, check, kind) {
  try {
    if (Notification.isSupported && !Notification.isSupported()) return;
    const who = target.name || target.url;
    let title, body;
    if (kind === 'change') { title = '🔔 ' + check.title; body = who + ' · ' + (check.value || 'изменилось'); }
    else if (kind === 'triggered') { title = '🔴 ' + check.title; body = who + ' · ' + (check.error || check.value || 'тревога'); }
    else if (kind === 'warn') { title = '🟡 ' + check.title; body = who + ' · ' + (check.value || 'внимание'); }
    else { title = '✅ ' + check.title; body = who + ' · снова в норме'; }
    new Notification({ title, body, silent: false }).show();
  } catch (_) {}
}

async function smCheckTarget(target) {
  if (!target || target.checking) return; target.checking = true;
  try {
    if (target.checks && target.checks.length) {
      const cap = await smBuildCapture(target);
      for (const check of target.checks) smCommit(target, check, smEvalCheck(check, cap, true), cap.ms);
    }
  } catch (_) { /* отдельные чеки уже под своим try/catch */ }
  target.checking = false;
  target.nextAt = Date.now() + smClampInt(target.intervalSec) * 1000;
  smPersist(); smBroadcast();
}

// ── публичный вид / персист / загрузка (+ миграция старого плоского формата) ────────────────────────
function smCheckPublic(c) { return { id: c.id, title: c.title, kind: c.kind, spec: c.spec, code: c.code, meta: c.meta, notify: c.notify !== false, debounce: c.debounce || 1, state: c.state || 'unknown', value: c.value, error: c.error, checkedAt: c.checkedAt, history: (c.history || []).slice(-SM_HISTORY), stats: (c.stats || []).slice(-31) }; }
function smTargetPersist(t) { return { id: t.id, name: t.name, url: t.url, intervalSec: t.intervalSec, render: !!t.render, insecureTls: !!t.insecureTls, headers: t.headers || null, checks: (t.checks || []).map((c) => ({ id: c.id, title: c.title, kind: c.kind, spec: c.spec, code: c.code, meta: c.meta, notify: c.notify !== false, debounce: c.debounce || 1, state: c.state, value: c.value, error: c.error, baseline: c.baseline, checkedAt: c.checkedAt, history: (c.history || []).slice(-SM_HISTORY), stats: (c.stats || []).slice(-31) })) }; }
function smPublic() { return smTargets.map((t) => ({ id: t.id, name: t.name, url: t.url, intervalSec: t.intervalSec, render: !!t.render, insecureTls: !!t.insecureTls, headers: t.headers || null, checks: (t.checks || []).map(smCheckPublic) })); }
function smPersist() { try { writeStoreKey('siteMon', smTargets.map(smTargetPersist)); } catch (_) {} }
function smBroadcast() {
  const p = smPublic();
  sendTo(mainWindow, 'sitemon:update', p);
  for (const w of moduleWindows.values()) { sendTo(w, 'sitemon:update', p); }
}
function smMigrateOld(s) {
  const url = smNormUrl(s.url) || String(s.url || '');
  const hist = Array.isArray(s.history) ? s.history.map((h) => ({ t: h.t, s: h.up ? 'ok' : 'triggered', v: h.ms })) : [];
  return { id: s.id || smNewId('t'), name: s.name, url, intervalSec: smClampInt(s.intervalSec), render: false, headers: null,
    checks: [{ id: smNewId('c'), title: 'Доступность', kind: 'basic', spec: { source: 'status', cmp: 'up' }, notify: true, debounce: 1, state: s.up === true ? 'ok' : s.up === false ? 'triggered' : 'unknown', value: s.up === true ? ('HTTP ' + (s.code || '')) : (s.error || ''), checkedAt: s.checkedAt, history: hist }],
    checking: false, nextAt: 0 };
}
function smLoad() {
  const raw = readStoreKey('siteMon');
  if (!Array.isArray(raw)) { smTargets = []; return; }
  smTargets = raw.map((x) => {
    if (x && Array.isArray(x.checks)) return { id: x.id || smNewId('t'), name: x.name, url: x.url, intervalSec: smClampInt(x.intervalSec), render: !!x.render, insecureTls: !!x.insecureTls, headers: x.headers || null, checks: x.checks.map((c) => Object.assign({}, c, { pend: null })), checking: false, nextAt: 0 };
    return smMigrateOld(x || {});
  });
}

// ── валидация чека из UI → нормализованный объект (basic|custom) ────────────────────────────────────
function smSanitizeCheck(c) {
  if (!c || typeof c !== 'object') return { ok: false, error: 'пустой чек' };
  const kind = c.kind === 'custom' ? 'custom' : 'basic';
  const title = String(c.title || '').trim().slice(0, 200) || (kind === 'custom' ? 'Кастомный чек' : 'Проверка');
  const base = { id: c.id || smNewId('c'), title, kind, notify: c.notify !== false, debounce: Math.max(1, Math.min(10, Number(c.debounce) || 1)), state: 'unknown', history: Array.isArray(c.history) ? c.history.slice(-SM_HISTORY) : [] };
  if (kind === 'custom') {
    const code = String(c.code || '').trim();
    if (!code) return { ok: false, error: 'пустой код предиката' };
    if (code.length > 20000) return { ok: false, error: 'слишком длинный код предиката' };
    return { ok: true, check: Object.assign(base, { code, meta: (c.meta && typeof c.meta === 'object') ? c.meta : {} }) };
  }
  const spec = (c.spec && typeof c.spec === 'object') ? c.spec : {};
  const cmp = String(spec.cmp || 'up');
  if (cmp !== 'up' && !spec.source) return { ok: false, error: 'не задан источник значения' };
  const level = (spec.level === 'warn' || spec.level === 'info') ? spec.level : 'alert';
  return { ok: true, check: Object.assign(base, { spec: { source: String(spec.source || 'status'), cmp, path: spec.path != null ? String(spec.path) : '', expected: spec.expected != null ? String(spec.expected) : '', level } }) };
}

// ── IPC ────────────────────────────────────────────────────────────────────────────────────────────
ipcMain.handle('sitemon:list', () => smPublic());
ipcMain.handle('sitemon:addTarget', (_e, { name, url, intervalSec, render, insecureTls, headers } = {}) => {
  const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' };
  const t = { id: smNewId('t'), name: String(name || '').trim() || new URL(u).hostname, url: u, intervalSec: smClampInt(intervalSec), render: !!render, insecureTls: !!insecureTls, headers: smCleanHeaders(headers),
    checks: [{ id: smNewId('c'), title: 'Доступность', kind: 'basic', spec: { source: 'status', cmp: 'up' }, notify: true, debounce: 1, state: 'unknown', history: [] }], checking: false, nextAt: 0 };
  smTargets.push(t); smPersist(); smBroadcast(); smCheckTarget(t);
  return { ok: true, id: t.id };
});
ipcMain.handle('sitemon:editTarget', (_e, { id, name, url, intervalSec, render, insecureTls, headers } = {}) => {
  const t = smTargets.find((x) => x.id === id); if (!t) return { ok: false, error: 'нет цели' };
  if (name != null) t.name = String(name).trim() || t.name;
  if (url != null) { const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' }; t.url = u; }
  if (intervalSec != null) t.intervalSec = smClampInt(intervalSec);
  if (render != null) t.render = !!render;
  if (insecureTls != null) t.insecureTls = !!insecureTls;
  if (headers !== undefined) t.headers = smCleanHeaders(headers);
  t.nextAt = 0; smPersist(); smBroadcast(); smCheckTarget(t); return { ok: true };
});
ipcMain.handle('sitemon:removeTarget', (_e, { id } = {}) => { smTargets = smTargets.filter((x) => x.id !== id); smPersist(); smBroadcast(); return { ok: true }; });
ipcMain.handle('sitemon:addCheck', (_e, { targetId, check } = {}) => {
  const t = smTargets.find((x) => x.id === targetId); if (!t) return { ok: false, error: 'нет цели' };
  const san = smSanitizeCheck(check); if (!san.ok) return { ok: false, error: san.error };
  t.checks = t.checks || []; t.checks.push(san.check); t.nextAt = 0; smPersist(); smBroadcast(); smCheckTarget(t);
  return { ok: true, id: san.check.id };
});
ipcMain.handle('sitemon:editCheck', (_e, { targetId, checkId, patch } = {}) => {
  const t = smTargets.find((x) => x.id === targetId); if (!t) return { ok: false, error: 'нет цели' };
  const c = (t.checks || []).find((x) => x.id === checkId); if (!c) return { ok: false, error: 'нет чека' };
  if (patch && typeof patch === 'object') {
    if (patch.title != null) c.title = String(patch.title).trim().slice(0, 200) || c.title;
    if (patch.spec && c.kind === 'basic') c.spec = { source: String(patch.spec.source || 'status'), cmp: String(patch.spec.cmp || 'up'), path: patch.spec.path != null ? String(patch.spec.path) : '', expected: patch.spec.expected != null ? String(patch.spec.expected) : '', level: (patch.spec.level === 'warn' || patch.spec.level === 'info') ? patch.spec.level : 'alert' };
    if (patch.code != null && c.kind === 'custom') c.code = String(patch.code);
    if (patch.meta) c.meta = patch.meta;
    if (patch.notify != null) c.notify = !!patch.notify;
    if (patch.debounce != null) c.debounce = Math.max(1, Math.min(10, Number(patch.debounce) || 1));
    c.state = 'unknown'; c.baseline = undefined; c.pend = null; c.error = ''; c.value = undefined;   // условие изменилось → сброс
  }
  t.nextAt = 0; smPersist(); smBroadcast(); smCheckTarget(t); return { ok: true };
});
ipcMain.handle('sitemon:removeCheck', (_e, { targetId, checkId } = {}) => {
  const t = smTargets.find((x) => x.id === targetId); if (!t) return { ok: false, error: 'нет цели' };
  t.checks = (t.checks || []).filter((x) => x.id !== checkId); smPersist(); smBroadcast(); return { ok: true };
});
ipcMain.handle('sitemon:checkNow', (_e, { id } = {}) => {
  if (id) { const t = smTargets.find((x) => x.id === id); if (t) { t.nextAt = 0; smCheckTarget(t); } }
  else { for (const t of smTargets) { t.nextAt = 0; smCheckTarget(t); } }
  return { ok: true };
});
// Разовая загрузка URL — «показать сэмпл ответа» (агенту при написании чека / для предпросмотра)
ipcMain.handle('sitemon:sample', async (_e, { url, headers, render, insecureTls } = {}) => {
  const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' };
  const res = await smFetch(u, { headers: smCleanHeaders(headers), timeoutMs: 15000, insecureTls: !!insecureTls });
  if (!res.ok) return { ok: false, error: res.error || 'нет связи' };
  const body = res.body || '';
  const ctype = String((res.headers && res.headers['content-type']) || '').toLowerCase();
  // полный ответ (без обрезки; тело уже ограничено SM_BODY_CAP=2МБ в smFetch). Тип для UI: json/html/text.
  const out = { ok: true, status: res.status, headers: res.headers, bytes: res.bytes, capped: !!res.capped, ctype, body, bodyTrunc: !!res.capped, isJson: false, kind: 'text' };
  try { out.json = JSON.parse(body); out.isJson = true; out.kind = 'json'; }
  catch (_) { out.kind = (ctype.includes('html') || /^\s*<(?:!doctype|html|\?xml|body|head)/i.test(body)) ? 'html' : 'text'; }
  if (render) { const dom = await smRenderCapture(u, [], 15000); if (dom && !dom.error) { out.renderedText = dom.text || ''; out.rendered = true; } else if (dom) out.renderError = dom.error; }
  return out;
});
// Прогнать один чек на живом ответе прямо сейчас, НЕ трогая сохранённое состояние (предпросмотр правила)
ipcMain.handle('sitemon:dryRun', async (_e, { url, headers, render, insecureTls, check } = {}) => {
  const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' };
  const san = smSanitizeCheck(check); if (!san.ok) return { ok: false, error: san.error };
  try {
    const cap = await smBuildCapture({ url: u, headers: smCleanHeaders(headers), render: !!render, insecureTls: !!insecureTls, checks: [san.check] });
    const ev = smEvalCheck(Object.assign({}, san.check, { baseline: undefined }), cap, false);
    return { ok: true, state: ev.state, value: ev.value, error: ev.error, capStatus: cap.status, capOk: cap.ok, capError: cap.error, rendered: !!cap.rendered, renderError: cap.renderError };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

const smTimer = setInterval(() => { const now = Date.now(); for (const t of smTargets) if (!t.checking && (!t.nextAt || now >= t.nextAt)) smCheckTarget(t); }, 5000);
if (smTimer.unref) smTimer.unref();
smLoad();
setTimeout(() => { for (const t of smTargets) smCheckTarget(t); }, 3000); // первый прогон вскоре после старта

// ---------------------------------------------------------------- filesystem
ipcMain.handle('fs:readDir', async (_e, dir) => {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (d) => {
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      // симлинк на папку: Dirent.isDirectory() == false → иначе показался бы файлом и клик читал бы каталог как файл. stat резолвит цель (битый симлинк → строка-файл).
      if (d.isSymbolicLink()) { try { isDir = (await fs.promises.stat(full)).isDirectory(); } catch (_) { isDir = false; } }
      return { name: d.name, path: full, dir: isDir };
    }));
    return out
      .filter((e) => !(e.dir && IGNORE_DIRS.has(e.name)))
      .filter((e) => !(!e.dir && e.name.endsWith(WRITE_TMP_SUFFIX)))   // сосед атомарной записи — живёт миллисекунды
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:readFile', async (_e, file) => {
  try {
    const stat = await fs.promises.stat(file);
    // Сокеты/FIFO/девайсы — не открываем: socket даёт ENXIO, а readFile FIFO повис бы навсегда.
    if (!stat.isFile()) return { error: 'Это не обычный файл (сокет/FIFO/каталог)' };
    if (stat.size > MAX_VIEW_BYTES) return { error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
    return { content: await fs.promises.readFile(file, 'utf8') };
  } catch (err) { return { error: String(err.message || err) }; }
});
// Запись файла ЧЕЛОВЕКА: во временный файл-сосед, потом rename(2) поверх цели. rename атомарен в
// пределах одной ФС, поэтому краш редактора, kill или выключение питания посреди записи больше не
// оставляют обрезанный файл: на диске либо старая версия целиком, либо новая целиком. Обычный
// writeFile сначала обнуляет файл ('w'), и вивер пишет так каждые 400 мс автосейва — окно потери
// открыто постоянно.
//   • Права цели сохраняем: иначе исполняемый скрипт после сохранения терял бы +x.
//   • Симлинк резолвим (как в atomicWriteSync): rename поверх ссылки заменил бы саму ссылку файлом.
//   • Каталог только на чтение (соседа не создать) — честный фолбэк на прямую запись, как было.
//     На ENOSPC фолбэка НЕТ: там прямая запись как раз и обрезала бы файл.
const WRITE_FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'EXDEV', 'ENOTDIR']);
async function writeFileCrashSafe(file, content) {
  let target = file;
  try { if ((await fs.promises.lstat(file)).isSymbolicLink()) target = await fs.promises.realpath(file); } catch (_) {}
  let mode; try { mode = (await fs.promises.stat(target)).mode & 0o777; } catch (_) {}
  // Хвост уникален на вызов: два окна, сохраняющих ОДИН файл одновременно, иначе делили бы один
  // и тот же временный файл и второй rename падал бы на пустом месте.
  const tmp = path.join(path.dirname(target),
    '.' + path.basename(target) + '.' + Math.random().toString(36).slice(2, 8) + WRITE_TMP_SUFFIX);
  try {
    await fs.promises.writeFile(tmp, content, mode == null ? 'utf8' : { encoding: 'utf8', mode });
    if (mode != null) { try { await fs.promises.chmod(tmp, mode); } catch (_) {} }  // сосед от прошлого краха: { mode } его не переоткрывает
    await fs.promises.rename(tmp, target);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch (_) {}
    if (!WRITE_FALLBACK_CODES.has(e && e.code)) throw e;
    await fs.promises.writeFile(target, content, 'utf8');
  }
}
ipcMain.handle('fs:writeFile', async (_e, { file, content }) => {
  try {
    await histSnapshotFromDisk(file, 'save');   // локальная история: состояние ДО записи (best-effort)
    await writeFileCrashSafe(file, content);
    // tmp-копия удалённого файла (открыт из «Удалённых хостов») → залить обратно на хост.
    // Локальная запись удалась в любом случае; упавшая заливка = честная ошибка сохранения
    // (вивер оставит dirty-точку и покажет тост), чтобы правка не «потерялась» молча.
    const remote = remoteViewerFiles.get(file);
    if (remote) {
      const w = await rhApi.writeFile(remote.rhId, remote.remotePath, content);
      if (!w || !w.ok) return { error: 'Записано локально, но НЕ залито на хост: ' + ((w && w.error) || 'ошибка соединения') };
    }
    return { ok: true };
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:mkdir', async (_e, { parent, name }) => {
  const safe = safeChildName(name);                       // блокируем ../ и сепараторы (PC-3)
  if (!safe) return { error: 'недопустимое имя' };
  try {
    const full = path.join(parent, safe);
    await fs.promises.mkdir(full, { recursive: false });
    return { path: full, name: safe };
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:exists', (_e, p) => { try { return fs.existsSync(p); } catch { return false; } });

// create a file or directory inside parent
ipcMain.handle('fs:create', async (_e, { parent, name, dir }) => {
  const safe = safeChildName(name);                       // блокируем ../ и сепараторы (PC-3)
  if (!safe) return { error: 'недопустимое имя' };
  try {
    const full = path.join(parent, safe);
    if (fs.existsSync(full)) return { error: 'уже существует' };
    if (dir) await fs.promises.mkdir(full, { recursive: false });
    else { await fs.promises.mkdir(path.dirname(full), { recursive: true }); await fs.promises.writeFile(full, '', { flag: 'wx' }); }
    return { path: full, name: safe, dir: !!dir };
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:rename', async (_e, { from, to }) => {
  try {
    if (fs.existsSync(to)) return { error: 'цель уже существует' };
    await fs.promises.rename(from, to);
    return { path: to };
  } catch (err) { return { error: String(err.message || err) }; }
});
// delete → OS trash (recoverable), not rm
ipcMain.handle('fs:trash', async (_e, target) => {
  try { await shell.trashItem(target); return { ok: true }; }
  catch (err) { return { error: String(err.message || err) }; }
});
// Перемещение узла внутри дерева (drag-and-drop): src → destDir/<имя>. Те же грабли, что у rename
// (цель существует, EXDEV cross-device), плюс запрет затащить папку внутрь себя/своего потомка.
ipcMain.handle('fs:move', async (_e, { src, destDir }) => {
  try {
    if (!src || !destDir) return { error: 'нет пути' };
    if (!fs.existsSync(src)) return { error: 'источник не найден' };
    if (!fs.statSync(destDir).isDirectory()) return { error: 'цель не папка' };
    const base = path.basename(src);
    const dest = path.join(destDir, base);
    if (path.dirname(src) === destDir) return { path: src }; // уже в этой папке — no-op
    const norm = (p) => p.replace(/[\\/]+$/, '');
    if (fs.statSync(src).isDirectory() && (norm(destDir) === norm(src) || norm(destDir).startsWith(norm(src) + path.sep)))
      return { error: 'нельзя переместить папку внутрь себя' };
    if (fs.existsSync(dest)) return { error: `в папке уже есть «${base}»` };
    try { await fs.promises.rename(src, dest); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      // другое устройство: rename невозможен → копируем и удаляем оригинал; при сбое копии чистим частичный dest
      try { await fs.promises.cp(src, dest, { recursive: true }); }
      catch (ce) { await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {}); throw ce; }
      await fs.promises.rm(src, { recursive: true, force: true });
    }
    return { path: dest };
  } catch (err) { return { error: String(err.message || err) }; }
});
// Втянуть файл/папку извне (drag из файлового менеджера ОС) → копией в destDir. Имя-коллизия →
// добавляем « (2)», « (3)»… (как в проводниках), чтобы не перезаписать существующее.
ipcMain.handle('fs:import', async (_e, { src, destDir }) => {
  try {
    if (!src || !destDir) return { error: 'нет пути' };
    if (!fs.existsSync(src)) return { error: 'источник не найден' };
    if (!fs.statSync(destDir).isDirectory()) return { error: 'цель не папка' };
    const isDir = fs.statSync(src).isDirectory();
    const base = path.basename(src);
    let dest = path.join(destDir, base);
    if (fs.existsSync(dest)) {
      const ext = isDir ? '' : path.extname(base);     // у каталога точка — часть имени, не расширение
      const stem = base.slice(0, base.length - ext.length);
      let n = 2; while (fs.existsSync(path.join(destDir, `${stem} (${n})${ext}`))) n++;
      dest = path.join(destDir, `${stem} (${n})${ext}`);
    }
    if (isDir) await fs.promises.cp(src, dest, { recursive: true });
    else await fs.promises.copyFile(src, dest);
    return { path: dest, name: path.basename(dest) };
  } catch (err) { return { error: String(err.message || err) }; }
});
// binary file → data: URL (for image preview under our CSP, which blocks file://)
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
ipcMain.handle('fs:readDataUrl', async (_e, file) => {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > 12 * 1024 * 1024) return { error: 'файл слишком большой для превью' };
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = IMG_MIME[ext] || 'application/octet-stream';
    const buf = await fs.promises.readFile(file);
    return { url: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) { return { error: String(err.message || err) }; }
});

// ---------------------------------------------------------------- files: проектные хелперы вивера
// Ctrl+P (рекурсивный листинг), поиск по проекту (grep на Node) и сравнение двух файлов (git --no-index).
const FILES_LIST_CAP = 30000;                  // потолок файлов для Ctrl+P
const FILES_SEARCH_CAP = 1000;                 // потолок совпадений для поиска по проекту
const FILES_SEARCH_FILE_MAX = 1024 * 1024;     // не грепаем файлы крупнее 1 МБ (минифицированные/данные)
// Обход дерева проекта (тот же IGNORE_DIRS, что у дерева/аудита). onFile(full) — на каждый файл;
// stop() → true прекращает обход (достигнут потолок). Симлинки на папки резолвим через stat.
async function walkProjectFiles(root, onFile, stop) {
  const stack = [root];
  while (stack.length) {
    if (stop && stop()) return;
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) { try { isDir = (await fs.promises.stat(full)).isDirectory(); } catch { isDir = false; } }
      if (isDir) { if (!IGNORE_DIRS.has(d.name)) stack.push(full); continue; }
      if (stop && stop()) return;
      await onFile(full);
    }
  }
}
ipcMain.handle('files:listAll', async (_e, root) => {
  if (!root) return { error: 'нет корня' };
  const files = [];
  let capped = false;
  try {
    await walkProjectFiles(root, (full) => { files.push(path.relative(root, full)); },
      () => { if (files.length >= FILES_LIST_CAP) { capped = true; return true; } return false; });
  } catch (err) { return { error: String(err.message || err) }; }
  return { files, capped };
});
ipcMain.handle('files:search', async (_e, { root, query, opts } = {}) => {
  if (!root || !query) return { matches: [] };
  const o = opts || {};
  let re;
  try {
    const src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(src, o.caseSensitive ? 'g' : 'gi');
  } catch { return { error: 'некорректное регулярное выражение' }; }
  const matches = [];
  let capped = false;
  try {
    await walkProjectFiles(root, async (full) => {
      if (matches.length >= FILES_SEARCH_CAP) return;
      let stat; try { stat = await fs.promises.stat(full); } catch { return; }
      if (!stat.size || stat.size > FILES_SEARCH_FILE_MAX) return;
      let buf; try { buf = await fs.promises.readFile(full); } catch { return; }
      const probe = Math.min(buf.length, 8192);
      for (let i = 0; i < probe; i++) if (buf[i] === 0) return;   // NUL → бинарь, пропускаем
      const rel = path.relative(root, full);
      const rows = buf.toString('utf8').split('\n');
      for (let i = 0; i < rows.length && matches.length < FILES_SEARCH_CAP; i++) {
        re.lastIndex = 0;
        const m = re.exec(rows[i]);
        if (m) matches.push({ file: rel, line: i + 1, col: m.index + 1, text: rows[i].slice(0, 240) });
      }
    }, () => { if (matches.length >= FILES_SEARCH_CAP) { capped = true; return true; } return false; });
  } catch (err) { return { error: String(err.message || err) }; }
  return { matches, capped };
});
// Замена по проекту: рендерер присылает итог files:search с галочками — список целей
// { file(rel), lines[1-based] }. Заменяем ТОЛЬКО в этих строках (та же регэксп-логика, что у
// поиска, + флаг g — несколько совпадений на строке заменяются разом). Перед записью каждого
// файла — снапшот в локальную историю. Пути целей зажаты внутрь root (без ../-побегов).
ipcMain.handle('files:replace', async (_e, { root, query, opts, replacement, targets } = {}) => {
  if (!root || !query || !Array.isArray(targets) || !targets.length) return { error: 'нет целей замены' };
  const o = opts || {};
  let re;
  try {
    const src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(src, o.caseSensitive ? 'g' : 'gi');
  } catch { return { error: 'некорректное регулярное выражение' }; }
  // не-regex режим: replacement литеральный — экранируем $, иначе "$&" в тексте замены сработал бы как группа
  const repl = o.regex ? String(replacement ?? '') : String(replacement ?? '').replace(/\$/g, '$$$$');
  const rootNorm = path.resolve(root);
  let files = 0, lines = 0;
  for (const t of targets) {
    if (!t || !t.file || !Array.isArray(t.lines) || !t.lines.length) continue;
    const full = path.resolve(rootNorm, t.file);
    if (full !== rootNorm && !full.startsWith(rootNorm + path.sep)) continue;
    let st; try { st = await fs.promises.stat(full); } catch { continue; }
    if (!st.isFile() || st.size > FILES_SEARCH_FILE_MAX) continue;
    let text; try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const rows = text.split('\n');
    let touched = 0;
    for (const ln of t.lines) {
      const i = (ln | 0) - 1;
      if (i < 0 || i >= rows.length) continue;
      re.lastIndex = 0;
      const next = rows[i].replace(re, repl);
      if (next !== rows[i]) { rows[i] = next; touched++; }
    }
    if (!touched) continue;
    try {
      await histSnapshot(full, text, 'save');       // локальная история: состояние до замены
      await writeFileCrashSafe(full, rows.join('\n'));   // как и вивер: обрыв не оставляет обрезанный файл
      files++; lines += touched;
    } catch (err) { return { error: String(err.message || err) + ' (' + t.file + ')', files, lines }; }
  }
  return { ok: true, files, lines };
});
ipcMain.handle('files:diffPair', async (_e, { a, b } = {}) => {
  if (!a || !b) return { error: 'нужны два файла' };
  // git diff --no-index сравнивает произвольные файлы вне репозитория; exit 1 = «есть отличия» (норма).
  const out = await new Promise((resolve) => {
    execFile('git', ['diff', '--no-index', '--', a, b],
      { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (_err, stdout) => resolve(stdout || ''));
  });
  return { diff: out };
});

// ---------------------------------------------------------------- глобальный поиск по всем проектам
// Стриминговый брат files:search: тот же обход (IGNORE_DIRS, пропуск бинарей), но по N корням сразу
// и с выдачей ПАЧКАМИ — окно рисует первые попадания через доли секунды, а не ждёт обхода двадцати
// проектов. Запрос живёт под своим runId: gsearch:cancel и закрытие окна его гасят (флаг проверяется
// и в stop() обхода, и перед каждой отправкой).
const GSX_TOTAL_CAP = 5000;                 // общий потолок совпадений на запрос
const GSX_PER_FILE_CAP = 50;                // на файл: один минифицированный бандл не съест всю выдачу
const GSX_FILE_MAX = 2 * 1024 * 1024;       // крупнее — не грепаем (данные/бандлы)
const GSX_FLUSH_HITS = 200;                 // пачка совпадений…
const GSX_FLUSH_MS = 120;                   // …либо столько миллисекунд — что раньше
const GSX_TEXT_MAX = 260;                   // сколько символов строки отдаём в выдачу
const gsxRuns = new Map();                  // runId → { cancelled }

// Маска вида "*.js, src/**" → предикат по относительному пути. Маска со слэшем меряется по всему
// пути, без слэша — по имени файла (так человек и думает, печатая «*.md»). «**» ходит через границы
// папок, одиночная «*» — только внутри сегмента.
function gsxMaskPred(raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const res = [];
  for (const p of parts) {
    let body = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '*') { if (p[i + 1] === '*') { body += '.*'; i++; } else body += '[^/]*'; }
      else if (ch === '?') body += '.';
      else if ('.+^${}()|[]\\'.includes(ch)) body += '\\' + ch;
      else body += ch;
    }
    try { res.push({ re: new RegExp('^' + body + '$', 'i'), full: p.includes('/') }); } catch (_) { /* мусорная маска — игнор */ }
  }
  if (!res.length) return null;
  return (rel) => {
    const name = rel.split('/').pop();
    return res.some((r) => r.re.test(r.full ? rel : name));
  };
}
ipcMain.handle('gsearch:cancel', (_e, { runId } = {}) => {
  const run = gsxRuns.get(String(runId));
  if (run) run.cancelled = true;
  return { ok: true };
});
ipcMain.handle('gsearch:start', (e, { runId, query, opts, roots } = {}) => {
  const id = String(runId || '');
  const o = opts || {};
  const mode = (o.mode === 'names' || o.mode === 'both') ? o.mode : 'content';
  if (!id || !query || !Array.isArray(roots) || !roots.length) return { ok: false, error: 'нет запроса или области поиска' };
  let re;
  try {
    let src = o.regex ? String(query) : String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (o.wholeWord) src = '\\b(?:' + src + ')\\b';
    re = new RegExp(src, o.caseSensitive ? 'g' : 'gi');
  } catch { return { ok: false, error: 'некорректное регулярное выражение' }; }
  const incl = gsxMaskPred(o.include);
  const excl = gsxMaskPred(o.exclude);
  const run = { cancelled: false };
  gsxRuns.set(id, run);
  // Обход идёт ФОНОМ: invoke отвечает сразу, результат течёт событиями. Иначе окно ждало бы конца
  // обхода всех проектов, чтобы показать первую строку.
  (async () => {
    const started = Date.now();
    let total = 0, files = 0, scanned = 0, capped = false, error = '';
    let batch = [], lastFlush = 0;
    const flush = (force) => {
      if (!batch.length || run.cancelled) return;
      if (!force && batch.length < GSX_FLUSH_HITS && Date.now() - lastFlush < GSX_FLUSH_MS) return;
      const hits = batch; batch = [];
      lastFlush = Date.now();
      safeSend(e.sender, 'gsearch:hit', { runId: id, hits });
    };
    try {
      for (const r of roots) {
        if (run.cancelled || capped) break;
        const root = r && r.path ? String(r.path) : '';
        if (!root) continue;
        try { if (!(await fs.promises.stat(root)).isDirectory()) continue; } catch { continue; } // папка удалена — просто пропускаем
        safeSend(e.sender, 'gsearch:progress', { runId: id, rootId: r.id, name: r.name, total, scanned });
        await walkProjectFiles(root, async (full) => {
          if (run.cancelled || total >= GSX_TOTAL_CAP) return;
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (incl && !incl(rel)) return;
          if (excl && excl(rel)) return;
          scanned++;
          if (scanned % 500 === 0) safeSend(e.sender, 'gsearch:progress', { runId: id, rootId: r.id, name: r.name, total, scanned });
          let fileHits = 0;
          if (mode === 'names' || mode === 'both') {
            re.lastIndex = 0;
            const m = re.exec(rel);
            if (m) { batch.push({ rootId: r.id, file: rel, line: 0, text: rel, mcol: m.index, len: m[0].length }); total++; fileHits++; }
          }
          if (mode === 'content' || mode === 'both') {
            let stat; try { stat = await fs.promises.stat(full); } catch { if (fileHits) { files++; flush(); } return; }
            if (!stat.size || stat.size > GSX_FILE_MAX) { if (fileHits) { files++; flush(); } return; }
            let raw; try { raw = await fs.promises.readFile(full); } catch { if (fileHits) { files++; flush(); } return; }
            const probe = Math.min(raw.length, 8192);
            for (let i = 0; i < probe; i++) if (raw[i] === 0) { if (fileHits) { files++; flush(); } return; }  // NUL → бинарь
            const rows = raw.toString('utf8').split('\n');
            let perFile = 0;
            for (let i = 0; i < rows.length && total < GSX_TOTAL_CAP && perFile < GSX_PER_FILE_CAP; i++) {
              re.lastIndex = 0;
              const m = re.exec(rows[i]);
              if (!m) continue;
              // окно вокруг совпадения: обрезка «с начала строки» прятала бы находку в длинной строке
              const from = Math.max(0, m.index - 60);
              const text = (from ? '…' : '') + rows[i].slice(from, from + GSX_TEXT_MAX);
              batch.push({ rootId: r.id, file: rel, line: i + 1, text, mcol: m.index - from + (from ? 1 : 0), len: m[0].length });
              total++; perFile++; fileHits++;
            }
          }
          if (fileHits) files++;
          if (total >= GSX_TOTAL_CAP) capped = true;
          flush();
        }, () => run.cancelled || total >= GSX_TOTAL_CAP);
      }
    } catch (err) { error = String((err && err.message) || err); }
    flush(true);
    gsxRuns.delete(id);
    safeSend(e.sender, 'gsearch:done', { runId: id, total, files, scanned, capped, error, cancelled: run.cancelled, ms: Date.now() - started });
  })();
  return { ok: true, runId: id };
});

// ---------------------------------------------------------------- локальная история файлов (PhpStorm Local History)
// Снапшоты текстовых файлов в ~/.LiteEditorAI/history/<sha1(absPath)>/<ts>-<tag>.snap.
// Точки съёма: fs:writeFile — состояние ДО записи (tag 'save', правка из вивера/замены по проекту);
// вотчер проекта — состояние ПОСЛЕ внешнего изменения (tag 'ext' — агент/git/другой редактор).
// Best-effort: любая ошибка истории молча глотается, работе редактора не мешает.
const HIST_DIR = path.join(storeDir, 'history');
const HIST_MAX_PER_FILE = 25;                   // ротация: столько версий держим на файл
const HIST_MAX_BYTES = MAX_VIEW_BYTES;          // крупнее лимита вивера — не снапшотим
const HIST_MIN_GAP_MS = { save: 45000, ext: 15000 }; // троттл на файл: серия автосейвов ≠ серия версий
const HIST_BATCH_CAP = 20;                      // пачка вотчера крупнее — массовая операция (checkout/npm), шум
const histKey = (absFile) => crypto.createHash('sha1').update(String(absFile)).digest('hex').slice(0, 20);
const HIST_NAME_RE = /^(\d{10,16})-(save|ext)\.snap$/;
async function histSnapshot(absFile, content, tag) {
  try {
    if (typeof content !== 'string' || Buffer.byteLength(content) > HIST_MAX_BYTES || content.includes('\0')) return;
    const dir = path.join(HIST_DIR, histKey(absFile));
    await fs.promises.mkdir(dir, { recursive: true });
    const names = (await fs.promises.readdir(dir)).filter((n) => HIST_NAME_RE.test(n)).sort();
    if (names.length) {
      const last = names[names.length - 1];
      const m = HIST_NAME_RE.exec(last);
      // дедуп по содержимому + троттл по времени (свежий снапшот уже есть — серию не плодим)
      if (Date.now() - Number(m[1]) < (HIST_MIN_GAP_MS[tag] || 15000)) return;
      const prev = await fs.promises.readFile(path.join(dir, last), 'utf8');
      if (prev === content) return;
    }
    await fs.promises.writeFile(path.join(dir, `${Date.now()}-${tag}.snap`), content, 'utf8');
    fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ file: absFile }), 'utf8').catch(() => {});
    const all = (await fs.promises.readdir(dir)).filter((n) => HIST_NAME_RE.test(n)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - HIST_MAX_PER_FILE)))
      fs.promises.unlink(path.join(dir, n)).catch(() => {});
  } catch (_) { /* история — best-effort */ }
}
// Снапшот текущего состояния файла на диске (для внешних изменений из вотчера).
async function histSnapshotFromDisk(absFile, tag) {
  try {
    const st = await fs.promises.stat(absFile);
    if (!st.isFile() || st.size > HIST_MAX_BYTES) return;
    await histSnapshot(absFile, await fs.promises.readFile(absFile, 'utf8'), tag);
  } catch (_) { /* удалён/не читается — пропускаем */ }
}
ipcMain.handle('hist:list', async (_e, file) => {
  try {
    const dir = path.join(HIST_DIR, histKey(file));
    const names = (await fs.promises.readdir(dir)).filter((n) => HIST_NAME_RE.test(n)).sort().reverse();
    const items = await Promise.all(names.map(async (n) => {
      const m = HIST_NAME_RE.exec(n);
      let size = 0; try { size = (await fs.promises.stat(path.join(dir, n))).size; } catch (_) {}
      return { name: n, ts: Number(m[1]), tag: m[2], size };
    }));
    return { ok: true, items };
  } catch (_) { return { ok: true, items: [] }; } // истории ещё нет — пустой список, не ошибка
});
ipcMain.handle('hist:read', async (_e, { file, name } = {}) => {
  if (!HIST_NAME_RE.test(String(name || ''))) return { error: 'bad name' }; // защита от traversal
  try { return { ok: true, content: await fs.promises.readFile(path.join(HIST_DIR, histKey(file), name), 'utf8') }; }
  catch (err) { return { error: String(err.message || err) }; }
});

// ---------------------------------------------------------------- file watching
// Watch a project root and tell the renderer when files change on disk — so the
// tree and the open file refresh live while an agent edits things in the terminal.
const isIgnoredPath = (rel) => rel.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg));
// Сообщить окнам (редактор + вивер), что слежение за деревом отвалилось → ручной ⟳ (идея 11).
function notifyWatchEnded(root) {
  sendTo(mainWindow, 'fs:watchEnded', { root });
  const fw = filesWindow(); if (fw) sendTo(fw, 'fs:watchEnded', { root });
  const dw = docWindow(); if (dw) sendTo(dw, 'fs:watchEnded', { root });
}
ipcMain.on('fs:watch', (_e, root) => {
  if (!root || watchers.has(root) || !fs.existsSync(root)) return;
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true });
  } catch (_) { notifyWatchEnded(root); return; } // inotify limits / unsupported — degrade to manual refresh
  const rec = { watcher, timer: null, pending: new Set() };
  watcher.on('error', () => { try { watcher.close(); } catch (_) {} watchers.delete(root); notifyWatchEnded(root); }); // рантайм-ошибка (B7/идея 11)
  watcher.on('change', (_type, filename) => {
    const rel = filename == null ? '' : String(filename);
    if (rel && isIgnoredPath(rel)) return;
    if (rel.endsWith(WRITE_TMP_SUFFIX)) return;        // временный сосед атомарной записи — не наш файл
    if (rel) rec.pending.add(path.join(root, rel));
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      const files = [...rec.pending]; rec.pending.clear();
      sendTo(mainWindow, 'fs:changed', { root, files });
      const fw = filesWindow(); if (fw) sendTo(fw, 'fs:changed', { root, files }); // окно вивера обновляет дерево/файл
      const dw = docWindow(); if (dw) sendTo(dw, 'fs:changed', { root, files }); // «Обработка текста»: сайдбар-дерево
      // локальная история: внешняя правка (агент/git). Большая пачка = массовая операция — шум, пропускаем.
      if (files.length <= HIST_BATCH_CAP) for (const f of files) histSnapshotFromDisk(f, 'ext');
    }, 180);
  });
  watchers.set(root, rec);
});
ipcMain.on('fs:unwatch', (_e, root) => {
  const rec = watchers.get(root);
  if (rec) { clearTimeout(rec.timer); try { rec.watcher.close(); } catch (_) {} watchers.delete(root); }
});

// ---------------------------------------------------------------- git (read-only)
// Resolves stdout on success, or null on ANY failure (non-repo, error, or timeout)
// — null is the deliberate error sentinel every caller already checks. The timeout
// matters: git:status runs on every tree decoration and git:info fires 6 calls per
// branch view, so a hook or slow/networked repo without it would hang the handler
// (and freeze the UI) forever. Mirrors gitRun()'s timeout for mutating commands.
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// ---------------------------------------------------------------- audit (базовый аудит проекта)
// Один проход по дереву проекта → агрегаты: типы файлов, крупнейшие файлы, медиа по весу.
// Источник файлов: 'git' (git ls-files — только отслеживаемое, самый честный фильтр; node_modules
// и сборка отсекаются репозиторием) или 'fs' (рекурсивный обход с IGNORE_DIRS). Бинарь не читаем
// построчно (классификация по расширению + NUL-проба первых байт); строки считаем у текста до лимита.
// MVP: читает каждый текстовый файл целиком ради подсчёта строк — на гигантских деревьях небыстро,
// поэтому два предохранителя: лимит файлов и лимит размера для построчного счёта.
const AUDIT_MAX_FILES = 60000;                       // патологические деревья → стоп, флаг capped
const AUDIT_LINE_MAX_BYTES = 4 * 1024 * 1024;        // крупнее — вес считаем, строки пропускаем
const AUDIT_FILES_OUT = 20000;                       // сколько файлов отдаём в рендерер для дралл-даунов
// Расширение → категория (для группировки и вкладки «Медиа»).
const AUDIT_EXT_CAT = (() => {
  const m = {};
  const add = (cat, exts) => exts.forEach((e) => { m[e] = cat; });
  add('code', ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'rb', 'php', 'swift', 'm', 'mm', 'lua', 'dart', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'fish', 'pl', 'r', 'jl', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'sql', 'gradle', 'groovy']);
  add('web', ['html', 'htm', 'css', 'scss', 'sass', 'less', 'styl']);
  add('config', ['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'plist', 'lock', 'properties', 'editorconfig', 'gitignore', 'dockerignore']);
  add('docs', ['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org', 'tex']);
  add('data', ['csv', 'tsv', 'ndjson']);
  add('image', ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'heic']);
  add('media', ['mp4', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'm4v']);
  add('archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']);
  add('font', ['ttf', 'otf', 'woff', 'woff2', 'eot']);
  add('binary', ['pdf', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'jar', 'pyc']);
  return m;
})();
const AUDIT_BINARY_CATS = new Set(['image', 'media', 'archive', 'font', 'binary']); // не читать построчно
function auditCat(ext) { return AUDIT_EXT_CAT[ext] || 'other'; }

// --- эвристики находок (вкладки «Гигиена»/«Долг») ---
const AUDIT_MARKER_RE = /\b(TODO|FIXME|HACK|XXX|BUG)\b/;       // метки техдолга (вкладка «Долг»)
const AUDIT_MINIFIED_MAXLINE = 1000;                          // строка длиннее → «минифицированный»/генерённый
const AUDIT_FIND_CAP = 800;                                   // потолок на общий список меток/секретов
const AUDIT_GIT_COMMITS = 2000;                               // глубина истории для churn/возраста
// Правила секретов — консервативный набор с низким FP (имя правила → regex).
/** @type {Array<[string, RegExp]>} */
const AUDIT_SECRET_RULES = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['GitHub token', /gh[posru]_[0-9A-Za-z]{36,}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ['Stripe key', /sk_live_[0-9A-Za-z]{16,}/],
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Generic secret', /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
// «Мусор в гите»: что обычно не должно лежать под версионным контролем.
const AUDIT_JUNK_SEG = new Set(['node_modules', 'dist', 'build', '.next', 'out', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.cache', '.parcel-cache']);
function auditJunkReason(rel, cat, bytes) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  for (const s of segs) if (AUDIT_JUNK_SEG.has(s)) return 'каталог сборки/зависимостей под git (' + s + ')';
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) return 'файл окружения (.env) под git — риск утечки';
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return 'служебный файл ОС';
  if (/\.(log|tmp|temp|swp|swo|bak|orig)$/.test(base)) return 'временный/лог-файл';
  if (/\.min\.(js|css)$/.test(base)) return 'минифицированный бандл (часто генерируется)';
  if (cat === 'archive') return 'архив под git';
  if (AUDIT_BINARY_CATS.has(cat) && bytes > 1024 * 1024) return 'крупный бинарь (>1 МБ) под git';
  return null;
}

// Текстовый проход: строки + макс. длина строки + метки + секреты. NUL → null (бинарь).
async function auditScanText(full) {
  let buf;
  try { buf = await fs.promises.readFile(full); } catch { return null; }
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) if (buf[i] === 0) return null; // нашли NUL → бинарь
  if (buf.length === 0) return { lines: 0, maxLine: 0, markers: [], secrets: [] };
  const rows = buf.toString('utf8').split('\n');
  let lines = rows.length;
  if (rows[rows.length - 1] === '') lines -= 1; // финальный \n не создаёт «лишнюю» строку
  let maxLine = 0;
  const markers = [], secrets = [];
  for (let i = 0; i < rows.length; i++) {
    const ln = rows[i];
    if (ln.length > maxLine) maxLine = ln.length;
    if (markers.length < 12) { const m = AUDIT_MARKER_RE.exec(ln); if (m) markers.push({ line: i + 1, kind: m[1], text: ln.trim().slice(0, 160) }); }
    if (secrets.length < 8) for (const [rule, re] of AUDIT_SECRET_RULES) if (re.test(ln)) { secrets.push({ line: i + 1, rule, text: ln.trim().slice(0, 120) }); break; }
  }
  return { lines, maxLine, markers, secrets };
}

// Дубликаты: хешируем только файлы, чей размер совпал с другим (кандидаты), — дёшево.
async function auditDupes(root, files) {
  const bySize = new Map();
  for (const f of files) { if (f.bytes < 16) continue; const a = bySize.get(f.bytes); if (a) a.push(f); else bySize.set(f.bytes, [f]); }
  const cand = [];
  for (const arr of bySize.values()) if (arr.length > 1) cand.push(...arr);
  if (!cand.length || cand.length > 4000) return { groups: [], skipped: cand.length > 4000 };
  const byHash = new Map();
  for (const f of cand) {
    let buf; try { buf = await fs.promises.readFile(path.join(root, f.rel)); } catch { continue; }
    const k = f.bytes + ':' + crypto.createHash('sha1').update(buf).digest('hex');
    const a = byHash.get(k); if (a) a.push(f); else byHash.set(k, [f]);
  }
  const groups = [];
  for (const arr of byHash.values()) if (arr.length > 1) groups.push({ bytes: arr[0].bytes, files: arr.map((x) => x.rel) });
  groups.sort((a, b) => b.bytes * b.files.length - a.bytes * a.files.length);
  return { groups: groups.slice(0, 200), skipped: false };
}

// История из git: churn (число коммитов на файл) + дата последнего изменения (log новейшие-сверху).
// quotePath=false — пути без кавычек, чтобы совпадали с `ls-files -z`.
async function auditGitHistory(root, fileSet) {
  const out = await git(root, ['-c', 'core.quotePath=false', 'log', '-n', String(AUDIT_GIT_COMMITS), '--no-merges', '--pretty=format:\x01%aI', '--name-only']);
  if (out == null) return null;
  const commits = new Map(), lastDate = new Map();
  let cur = null;
  for (const ln of out.split('\n')) {
    if (ln[0] === '\x01') { cur = ln.slice(1); continue; }
    if (!ln || !fileSet.has(ln)) continue;
    commits.set(ln, (commits.get(ln) || 0) + 1);
    if (!lastDate.has(ln) && cur) lastDate.set(ln, cur);
  }
  return { commits, lastDate };
}

// Осиротевшие (эвристика): basename файла не встречается ни в одном ДРУГОМ файле. Только малые проекты.
async function auditOrphans(root, files) {
  if (files.length > 1500) return { items: [], skipped: true };
  const corpus = [];
  for (const f of files) {
    if (AUDIT_BINARY_CATS.has(f.cat) || f.bytes > AUDIT_LINE_MAX_BYTES) continue;
    let buf; try { buf = await fs.promises.readFile(path.join(root, f.rel)); } catch { continue; }
    if (buf.includes(0)) continue;
    corpus.push({ rel: f.rel, lower: buf.toString('utf8').toLowerCase() });
  }
  const ENTRY = /^(index|main|app|mod|__init__|readme|license|changelog|setup|conftest)\b/i;
  const items = [];
  for (const f of files) {
    if (items.length >= 200) break;
    if (f.cat !== 'code' && f.cat !== 'web') continue;
    const base = f.rel.split('/').pop();
    if (ENTRY.test(base) || base.startsWith('.')) continue;
    const b = base.toLowerCase(), n = b.replace(/\.[^.]+$/, '');
    const referenced = corpus.some((o) => o.rel !== f.rel && (o.lower.includes(b) || o.lower.includes(n)));
    if (!referenced) items.push({ rel: f.rel, bytes: f.bytes });
  }
  return { items, skipped: false };
}

// Рекурсивный обход (источник 'fs'): относительные пути, IGNORE_DIRS отсекаются.
async function auditWalkFs(root, out) {
  const stack = ['.'];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (out.length >= AUDIT_MAX_FILES) return true; // capped
      const childRel = rel === '.' ? ent.name : rel + '/' + ent.name;
      if (ent.isDirectory()) { if (!IGNORE_DIRS.has(ent.name)) stack.push(childRel); }
      else if (ent.isFile()) out.push(childRel);
    }
  }
  return false;
}

// ── IterFlow (модуль renderer/modules/iterflow.js) ─────────────────────────────
// Сетевой клиент изолированной группы /api/editor/* IterFlow живёт в main (CSP
// рендерера запрещает сеть). Хост — прод https://iter-flow.ru (env ITERFLOW_HOST
// для локалки). Контракт ответа: успех → { ok:true, data }, провал → { ok:false,
// error[, unauth:true] } (обёртка ipcMain.handle логирует ok:false сама). Токен
// device-сессии наружу в рендерер НЕ отдаём — он живёт только в main/session.json.
const { createIterflowApi } = require('./lib/iterflow-api');
const iterflowApi = createIterflowApi({ storeDir });
function ifWrap(fn) {
  return async (...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e), unauth: (e && e.status) === 401, web401: !!(e && e.web401) }; }
  };
}
ipcMain.handle('iterflow:login', ifWrap(async (_e, { email, password }) => {
  const r = await iterflowApi.login(email, password);
  return { user: r.user, profiles: r.profiles || [], teams: r.teams || [] };
}));
ipcMain.handle('iterflow:logout', ifWrap(async () => { await iterflowApi.logout(); return true; }));
ipcMain.handle('iterflow:session', ifWrap(async () => {
  if (!iterflowApi.isAuthed()) return { authed: false };
  try {
    const b = await iterflowApi.me();
    return { authed: true, user: b.user, profiles: b.profiles || [], teams: b.teams || [] };
  } catch (e) {
    if ((e && e.status) === 401) return { authed: false }; // токен протух — тихо на логин
    throw e;
  }
}));
ipcMain.handle('iterflow:counterparties', ifWrap((_e, { ctx }) => iterflowApi.counterparties(ctx)));
ipcMain.handle('iterflow:counterpartyProjects', ifWrap((_e, { cpId }) => iterflowApi.counterpartyProjects(cpId)));
ipcMain.handle('iterflow:projectIterations', ifWrap((_e, { projectId }) => iterflowApi.projectIterations(projectId)));
ipcMain.handle('iterflow:iterationTasks', ifWrap((_e, { iterationId }) => iterflowApi.iterationTasks(iterationId)));
ipcMain.handle('iterflow:setTaskKanban', ifWrap((_e, { taskId, status }) => iterflowApi.setTaskKanban(taskId, status)));
ipcMain.handle('iterflow:projectNotes', ifWrap((_e, { projectId }) => iterflowApi.projectNotes(projectId)));
ipcMain.handle('iterflow:projectMessages', ifWrap((_e, { projectId }) => iterflowApi.projectMessages(projectId)));
// CRUD + жизненный цикл (веб-cookie). web401 в обёртке → UI просит перелогин.
ipcMain.handle('iterflow:createIteration', ifWrap((_e, { projectId, body }) => iterflowApi.createIteration(projectId, body)));
ipcMain.handle('iterflow:renameIteration', ifWrap((_e, { id, title }) => iterflowApi.renameIteration(id, title)));
ipcMain.handle('iterflow:setIterationDeadline', ifWrap((_e, { id, deadline }) => iterflowApi.setIterationDeadline(id, deadline)));
ipcMain.handle('iterflow:deleteIteration', ifWrap((_e, { id }) => iterflowApi.deleteIteration(id)));
ipcMain.handle('iterflow:iterationStage', ifWrap((_e, { id, action, body }) => iterflowApi.iterationStage(id, action, body)));
ipcMain.handle('iterflow:createTask', ifWrap((_e, { iterationId, body }) => iterflowApi.createTask(iterationId, body)));
ipcMain.handle('iterflow:updateTask', ifWrap((_e, { id, body }) => iterflowApi.updateTask(id, body)));
ipcMain.handle('iterflow:toggleTaskDone', ifWrap((_e, { id }) => iterflowApi.toggleTaskDone(id)));
ipcMain.handle('iterflow:deleteTask', ifWrap((_e, { id }) => iterflowApi.deleteTask(id)));
ipcMain.handle('iterflow:createNote', ifWrap((_e, { projectId, body }) => iterflowApi.createNote(projectId, body)));
ipcMain.handle('iterflow:updateNote', ifWrap((_e, { noteId, body }) => iterflowApi.updateNote(noteId, body)));
ipcMain.handle('iterflow:deleteNote', ifWrap((_e, { noteId }) => iterflowApi.deleteNote(noteId)));

ipcMain.handle('audit:scan', async (_e, { root, opts }) => {
  if (!root || !fs.existsSync(root)) return { error: 'Нет каталога проекта' };
  const wanted = (opts && opts.source) === 'fs' ? 'fs' : 'git';
  let source = wanted, capped = false, gitless = false;
  let relPaths = null;

  if (wanted === 'git') {
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top == null) { source = 'fs'; gitless = true; }            // не git-репозиторий → откат на fs
    else {
      const out = await git(root, ['ls-files', '-z']);
      if (out == null) { source = 'fs'; gitless = true; }          // буфер/ошибка → откат на fs
      else relPaths = out.split('\0').filter(Boolean);
    }
  }
  if (relPaths == null) { relPaths = []; capped = await auditWalkFs(root, relPaths); }
  else if (relPaths.length >= AUDIT_MAX_FILES) { relPaths = relPaths.slice(0, AUDIT_MAX_FILES); capped = true; }

  const byExtMap = new Map();   // ext → {ext, cat, files, lines, bytes}
  const byCatMap = new Map();   // cat → {cat, files, lines, bytes}
  const files = [];             // {rel, ext, cat, bytes, lines, hasLines, mtime}
  const junk = [], todos = [], secrets = [], minified = []; // находки для «Гигиена»/«Долг»
  let totFiles = 0, totLines = 0, totBytes = 0, skippedBig = 0;

  for (const rel of relPaths) {
    const full = path.join(root, rel);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    const bytes = st.size;
    const dot = path.extname(rel);
    const ext = dot ? dot.slice(1).toLowerCase() : '';
    const key = ext || '—';
    const cat = auditCat(ext);
    let lines = null;
    const isBinary = AUDIT_BINARY_CATS.has(cat);
    if (!isBinary && bytes <= AUDIT_LINE_MAX_BYTES) {
      const scan = await auditScanText(full);
      if (scan) {
        lines = scan.lines;
        if (scan.maxLine >= AUDIT_MINIFIED_MAXLINE) minified.push({ rel, maxLine: scan.maxLine, bytes, lines });
        for (const m of scan.markers) if (todos.length < AUDIT_FIND_CAP) todos.push({ rel, line: m.line, kind: m.kind, text: m.text });
        for (const s of scan.secrets) if (secrets.length < AUDIT_FIND_CAP) secrets.push({ rel, line: s.line, rule: s.rule, text: s.text });
      }
    } else if (!isBinary) { skippedBig++; }
    const hasLines = lines != null;

    const reason = auditJunkReason(rel, cat, bytes);
    if (reason) junk.push({ rel, reason, bytes });

    totFiles++; totBytes += bytes; if (hasLines) totLines += lines;
    let e = byExtMap.get(key);
    if (!e) { e = { ext: key, cat, files: 0, lines: 0, bytes: 0 }; byExtMap.set(key, e); }
    e.files++; e.bytes += bytes; if (hasLines) e.lines += lines;
    let c = byCatMap.get(cat);
    if (!c) { c = { cat, files: 0, lines: 0, bytes: 0 }; byCatMap.set(cat, c); }
    c.files++; c.bytes += bytes; if (hasLines) c.lines += lines;
    files.push({ rel, ext: key, cat, bytes, lines: hasLines ? lines : 0, hasLines, mtime: st.mtimeMs });
  }

  // Дубликаты и осиротевшие — пост-проходы (читают только нужные файлы / только малые проекты).
  const dupes = await auditDupes(root, files);
  const orphans = await auditOrphans(root, files);

  // Свежие/старые БЕЗ пересечения: на малых проектах «top-N новых» и «top-N старых» иначе
  // делят одни и те же файлы (файл попадал и в «Свежие», и в «Давно не тронуты»).
  const splitAge = (dated) => {
    const sorted = dated.slice().sort((a, b) => b.when.localeCompare(a.when)); // новые сверху
    const recent = sorted.slice(0, 40);
    const seen = new Set(recent.map((x) => x.rel));
    const stale = sorted.filter((x) => !seen.has(x.rel)).slice(-40).reverse(); // старые снизу, исключая свежие
    return { recent, stale };
  };
  // История: из git (churn + дата последнего коммита) либо из mtime (источник fs / не репозиторий).
  let history;
  if (source === 'git') {
    const h = await auditGitHistory(root, new Set(files.map((f) => f.rel)));
    if (h) {
      const churn = [...h.commits.entries()].map(([rel, commits]) => ({ rel, commits })).sort((a, b) => b.commits - a.commits).slice(0, 60);
      const dated = files.filter((f) => h.lastDate.has(f.rel)).map((f) => ({ rel: f.rel, when: h.lastDate.get(f.rel), bytes: f.bytes }));
      history = { mode: 'git', churn, ...splitAge(dated), windowCommits: AUDIT_GIT_COMMITS };
    }
  }
  if (!history) {
    const dated = files.map((f) => ({ rel: f.rel, when: new Date(f.mtime).toISOString(), bytes: f.bytes }));
    history = { mode: 'mtime', churn: [], ...splitAge(dated) };
  }

  const slim = (f) => ({ rel: f.rel, ext: f.ext, cat: f.cat, bytes: f.bytes, lines: f.lines, hasLines: f.hasLines });
  const byExt = [...byExtMap.values()].sort((a, b) => b.bytes - a.bytes);
  const byCat = [...byCatMap.values()].sort((a, b) => b.bytes - a.bytes);
  // Языки для обзора: топ расширений код+веб по строкам.
  const langs = byExt.filter((e) => e.cat === 'code' || e.cat === 'web').sort((a, b) => b.lines - a.lines).slice(0, 8);
  // Полный список файлов (для дралл-даунов на клиенте: по типу, по категории, крупные, медиа, аномалии).
  // Отсортирован по весу убыв.; лимит на отдачу, чтобы не гнать в рендерер сотни тысяч объектов.
  const filesSorted = files.sort((a, b) => b.bytes - a.bytes);
  const filesOut = filesSorted.slice(0, AUDIT_FILES_OUT).map(slim);
  const filesCapped = filesSorted.length > AUDIT_FILES_OUT;
  minified.sort((a, b) => b.maxLine - a.maxLine);
  junk.sort((a, b) => b.bytes - a.bytes);

  return {
    root, source, gitless, capped, scannedAt: Date.now(),
    totals: { files: totFiles, lines: totLines, bytes: totBytes, skippedBig },
    byExt, byCat, langs, files: filesOut, filesCapped,
    // находки
    junk, todos, secrets, minified: minified.slice(0, 200),
    dupes: dupes.groups, dupesSkipped: dupes.skipped,
    orphans: orphans.items, orphansSkipped: orphans.skipped,
    history,
  };
});

// Экспорт отчёта аудита в файл (md/json) через системный диалог сохранения.
ipcMain.handle('audit:export', async (_e, { content, defaultName }) => {
  try {
    const r = await dialog.showSaveDialog({
      defaultPath: defaultName || 'audit-report.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'JSON', extensions: ['json'] }, { name: 'Все файлы', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, String(content == null ? '' : content));
    return { ok: true, file: r.filePath };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});

// ---------------------------------------------------------------- web/seo audit (модуль «WEB/SEO аудит»)
// Базовый MVP: чистый Node, без браузера. Достаёт сайт (локальный dev-сервер или внешний домен),
// разбирает заголовки/безопасность/SEO-мету из сырого HTML, проверяет robots/sitemap/security.txt,
// для https — сертификат (tls), для внешних доменов — DNS и почтовую гигиену (SPF/DMARC). Каждая
// проверка изолирована (try/catch → статус «недоступно»), у всех — таймауты, тело ответа ограничено.
// Дальнейшие этапы (скрытый BrowserWindow → SEO из отрендеренного DOM, Lighthouse, история) — поверх.
const SEO_TIMEOUT = 12000;                 // таймаут одного HTTP-запроса, мс
const SEO_BODY_CAP = 3 * 1024 * 1024;      // сколько тела читаем (хватает на <head> любой страницы)
const SEO_MAX_REDIRECTS = 6;
const SEO_DEV_PORTS = [3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

function seoIsLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i.test(host) || /\.local$/i.test(host);
}
// Нормализуем пользовательский ввод в URL (по умолчанию http для localhost, https для домена).
function seoNormalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    const host = s.split('/')[0];
    s = (seoIsLocalHost(host.split(':')[0]) ? 'http://' : 'https://') + s;
  }
  try { return new URL(s); } catch { return null; }
}

// Один HTTP(S)-запрос с таймаутом; тело режем по SEO_BODY_CAP. Редиректы НЕ следуем здесь (см. seoFetchChain).
function seoRequestOnce(u, method, timeoutMs) {
  const to = timeoutMs || SEO_TIMEOUT;
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.request(u, {
      method: method || 'GET',
      // самоподписанные сертификаты у dev-серверов не должны валить проверку
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'LiteEditor-Audit/1.0', 'Accept': 'text/html,*/*' },
      timeout: to,
    }, (res) => {
      const chunks = []; let len = 0;
      res.on('data', (c) => { if (len < SEO_BODY_CAP) { chunks.push(c); len += c.length; } });
      res.on('end', () => resolve({
        ok: true, status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0, bytes: len,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'таймаут (' + to + ' мс)' }); });
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    req.end();
  });
}
// Следуем по цепочке редиректов, записывая её.
async function seoFetchChain(start) {
  const redirects = [];
  let u = start;
  for (let i = 0; i <= SEO_MAX_REDIRECTS; i++) {
    const r = await seoRequestOnce(u, 'GET');
    if (!r.ok) return { ...r, finalUrl: u.href, redirects };
    const loc = r.headers && r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc && i < SEO_MAX_REDIRECTS) {
      let next; try { next = new URL(loc, u); } catch { return { ...r, finalUrl: u.href, redirects }; }
      redirects.push({ from: u.href, status: r.status, to: next.href });
      u = next; continue;
    }
    return { ...r, finalUrl: u.href, redirects };
  }
  return { ok: false, error: 'слишком много редиректов', finalUrl: u.href, redirects };
}

// --- разбор сырого HTML (MVP: без рендера, regex по <head>) ---
function seoMatch(re, html) { const m = re.exec(html); return m ? (m[1] || '').trim() : null; }
function seoMetaContent(html, nameAttr, val) {
  const re = new RegExp('<meta[^>]*' + nameAttr + '\\s*=\\s*["\']' + val + '["\'][^>]*>', 'i');
  const tag = seoMatch(new RegExp('(' + re.source + ')', 'i'), html);
  if (!tag) return null;
  return seoMatch(/content\s*=\s*["']([^"']*)["']/i, tag);
}
function seoParseHtml(html) {
  html = String(html || '');
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html])[0];
  const ogs = {};
  const ogRe = /<meta[^>]*property\s*=\s*["']og:([a-z]+)["'][^>]*content\s*=\s*["']([^"']*)["']/gi;
  let m; while ((m = ogRe.exec(head))) ogs[m[1]] = m[2];
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  const imgs = (html.match(/<img\b[^>]*>/gi) || []);
  const imgsNoAlt = imgs.filter((t) => !/\balt\s*=/i.test(t)).length;
  return {
    title: seoMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, head),
    description: seoMetaContent(head, 'name', 'description'),
    keywords: seoMetaContent(head, 'name', 'keywords'),
    robotsMeta: seoMetaContent(head, 'name', 'robots'),
    canonical: (() => { const t = seoMatch(/(<link[^>]*rel\s*=\s*["']canonical["'][^>]*>)/i, head); return t ? seoMatch(/href\s*=\s*["']([^"']*)["']/i, t) : null; })(),
    viewport: seoMetaContent(head, 'name', 'viewport'),
    charset: seoMatch(/<meta[^>]*charset\s*=\s*["']?([\w-]+)/i, head),
    lang: seoMatch(/<html[^>]*\blang\s*=\s*["']([^"']*)["']/i, html),
    h1Count: h1,
    imgCount: imgs.length,
    imgNoAlt: imgsNoAlt,
    og: ogs,
    hasJsonLd: /<script[^>]*type\s*=\s*["']application\/ld\+json["']/i.test(head),
  };
}

// --- TLS-сертификат (только https) ---
function seoTls(u) {
  return new Promise((resolve) => {
    const port = u.port ? Number(u.port) : 443;
    const socket = tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false, timeout: SEO_TIMEOUT }, () => {
      const c = socket.getPeerCertificate(true);
      const proto = socket.getProtocol();
      const cipher = socket.getCipher() || /** @type {{ name?: string }} */ ({});
      const authorized = socket.authorized;
      const authError = socket.authorizationError ? String(socket.authorizationError) : '';
      socket.end();
      if (!c || !c.valid_to) { resolve({ ok: false, error: 'сертификат не получен' }); return; }
      const to = new Date(c.valid_to).getTime();
      const daysLeft = Math.round((to - Date.now()) / 86400000);
      const san = (c.subjectaltname || '').split(',').map((s) => s.replace(/^\s*DNS:/, '').trim()).filter(Boolean);
      // Цепочка сертификатов (issuerCertificate ссылается вверх, конец — самоподпись).
      const chain = []; let cur = c; const seen = new Set();
      while (cur && cur.subject && !seen.has(cur.fingerprint)) { seen.add(cur.fingerprint); chain.push(((cur.subject && cur.subject.CN) || (cur.issuer && cur.issuer.O) || '?')); cur = cur.issuerCertificate; if (chain.length > 8) break; }
      resolve({
        ok: true, protocol: proto, cipher: cipher.name || '', authorized, authError,
        subject: (c.subject && c.subject.CN) || '', issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '',
        validFrom: c.valid_from, validTo: c.valid_to, daysLeft, san: san.slice(0, 20), chain,
      });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'таймаут TLS' }); });
    socket.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  });
}

// --- DNS + почтовая гигиена (только внешние домены) ---
async function seoDns(host) {
  const r = { a: [], aaaa: [], mx: [], ns: [], txt: [], caa: [] };
  const safe = async (fn, key, map) => { try { const v = await fn(); r[key] = map ? v.map(map) : v; } catch { /* нет записи */ } };
  await Promise.all([
    safe(() => dns.promises.resolve4(host), 'a'),
    safe(() => dns.promises.resolve6(host), 'aaaa'),
    safe(() => dns.promises.resolveMx(host), 'mx', (x) => x.exchange + ' (' + x.priority + ')'),
    safe(() => dns.promises.resolveNs(host), 'ns'),
    safe(() => dns.promises.resolveCaa(host), 'caa', (x) => JSON.stringify(x)),
  ]);
  let txt = []; try { txt = await dns.promises.resolveTxt(host); } catch {}
  r.txt = txt.map((parts) => parts.join('')).slice(0, 30);
  const spf = r.txt.find((t) => /^v=spf1/i.test(t)) || null;
  let dmarc = null;
  try { const d = await dns.promises.resolveTxt('_dmarc.' + host); dmarc = d.map((p) => p.join('')).find((t) => /^v=DMARC1/i.test(t)) || null; } catch {}
  r.mail = {
    spf: { found: !!spf, value: spf || '' },
    dmarc: { found: !!dmarc, value: dmarc || '', policy: dmarc ? (/(p=[a-z]+)/i.exec(dmarc) || ['', ''])[1] : '' },
  };
  return r;
}

// --- проверка наличия служебного файла по корню сайта ---
async function seoProbeFile(origin, pth) {
  let u; try { u = new URL(pth, origin); } catch { return { found: false }; }
  const r = await seoRequestOnce(u, 'GET');
  if (!r.ok) return { found: false, error: r.error };
  return { found: r.status === 200, status: r.status, bytes: r.bytes || (r.body ? r.body.length : 0), sample: (r.body || '').slice(0, 400) };
}

// Анализ security-заголовков → строки с оценкой и советом. sev: crit|warn|ok|info.
function seoSecurityHeaders(headers, isHttps) {
  const h = headers || {};
  const get = (k) => h[k] != null ? String(h[k]) : null;
  const rows = [];
  const add = (key, label, value, sev, advice) => rows.push({ key, label, value: value || '', present: !!value, sev, advice });
  add('csp', 'Content-Security-Policy', get('content-security-policy'),
    get('content-security-policy') ? 'ok' : 'warn', 'Защита от XSS/инъекций. Задайте политику источников скриптов и стилей.');
  add('hsts', 'Strict-Transport-Security (HSTS)', get('strict-transport-security'),
    !isHttps ? 'info' : (get('strict-transport-security') ? 'ok' : 'warn'),
    isHttps ? 'Принуждает браузер к HTTPS. Добавьте max-age ≥ 15552000; includeSubDomains.' : 'Актуально только для HTTPS.');
  add('xfo', 'X-Frame-Options', get('x-frame-options'),
    get('x-frame-options') || /frame-ancestors/i.test(get('content-security-policy') || '') ? 'ok' : 'warn',
    'Защита от кликджекинга. Поставьте SAMEORIGIN или frame-ancestors в CSP.');
  add('xcto', 'X-Content-Type-Options', get('x-content-type-options'),
    /nosniff/i.test(get('x-content-type-options') || '') ? 'ok' : 'warn', 'Поставьте nosniff — отключает MIME-sniffing.');
  add('refpol', 'Referrer-Policy', get('referrer-policy'),
    get('referrer-policy') ? 'ok' : 'info', 'Контролирует утечку Referer. Рекомендуется strict-origin-when-cross-origin.');
  add('permpol', 'Permissions-Policy', get('permissions-policy'),
    get('permissions-policy') ? 'ok' : 'info', 'Ограничивает доступ к камере/гео/микрофону и т.п.');
  return rows;
}

// Куки из set-cookie: флаги Secure/HttpOnly/SameSite.
function seoCookies(headers) {
  let sc = headers && headers['set-cookie'];
  if (!sc) return [];
  if (!Array.isArray(sc)) sc = [sc];
  return sc.slice(0, 40).map((line) => {
    const name = (line.split('=')[0] || '').trim();
    return {
      name, secure: /;\s*secure/i.test(line), httpOnly: /;\s*httponly/i.test(line),
      sameSite: (/;\s*samesite\s*=\s*(\w+)/i.exec(line) || ['', ''])[1],
    };
  });
}

// SEO-проблемы из распарсенного HTML → находки.
function seoIssues(seo) {
  const out = [];
  if (!seo.title) out.push({ sev: 'crit', title: 'Нет <title>', advice: 'Добавьте заголовок страницы — ключевой SEO-сигнал.' });
  else if (seo.title.length < 10 || seo.title.length > 65) out.push({ sev: 'warn', title: 'Длина <title> = ' + seo.title.length, advice: 'Оптимально 10–65 символов.' });
  if (!seo.description) out.push({ sev: 'warn', title: 'Нет meta description', advice: 'Добавьте описание 50–160 символов — попадает в сниппет выдачи.' });
  else if (seo.description.length < 50 || seo.description.length > 160) out.push({ sev: 'info', title: 'Длина description = ' + seo.description.length, advice: 'Оптимально 50–160 символов.' });
  if (!seo.canonical) out.push({ sev: 'info', title: 'Нет canonical', advice: 'Укажите canonical, чтобы избежать дублей.' });
  if (!seo.viewport) out.push({ sev: 'warn', title: 'Нет viewport', advice: 'Без него страница не адаптивна на мобильных.' });
  if (!seo.lang) out.push({ sev: 'info', title: 'Нет lang у <html>', advice: 'Укажите язык — важно для доступности и поиска.' });
  if (seo.h1Count === 0) out.push({ sev: 'warn', title: 'Нет <h1>', advice: 'Добавьте один главный заголовок H1.' });
  else if (seo.h1Count > 1) out.push({ sev: 'info', title: seo.h1Count + ' тегов <h1>', advice: 'Обычно на странице один H1.' });
  if (seo.imgNoAlt > 0) out.push({ sev: 'info', title: seo.imgNoAlt + ' картинок без alt', advice: 'Добавьте alt — доступность и image-SEO.' });
  if (!seo.og || !seo.og.title) out.push({ sev: 'info', title: 'Нет OpenGraph', advice: 'og:title/description/image улучшают превью в соцсетях.' });
  return out;
}

// Грубая балльная оценка 0–100 из набора находок (crit=-25, warn=-10, info=-3).
function seoScore(findings) {
  let s = 100;
  for (const f of findings) s -= (f.sev === 'crit' ? 25 : f.sev === 'warn' ? 10 : f.sev === 'info' ? 3 : 0);
  return Math.max(0, Math.min(100, s));
}

// --- WHOIS по протоколу 43 (чистый Node): IANA → реферал на whois TLD → возраст/регистратор/срок ---
function seoWhoisQuery(server, query) {
  return new Promise((resolve) => {
    let data = '';
    const s = net.connect(43, server);
    s.setTimeout(8000);
    s.on('connect', () => s.write(query + '\r\n'));
    s.on('data', (d) => { data += d; if (data.length > 200000) s.destroy(); });
    s.on('end', () => resolve(data));
    s.on('timeout', () => { s.destroy(); resolve(data); });
    s.on('error', () => resolve(data || null));
  });
}
async function seoWhois(host) {
  // регистрируемый домен (грубо: последние две метки — для большинства зон верно)
  const labels = host.split('.');
  const domain = labels.length > 2 ? labels.slice(-2).join('.') : host;
  try {
    const ref = await seoWhoisQuery('whois.iana.org', domain);
    let raw = ref || '';
    const m = /refer:\s*(\S+)/i.exec(raw);
    if (m) { const r2 = await seoWhoisQuery(m[1].trim(), domain); if (r2) raw = r2; }
    if (!raw) return null;
    const g = (re) => { const x = re.exec(raw); return x ? x[1].trim() : null; };
    return {
      domain,
      registrar: g(/Registrar:\s*(.+)/i),
      created: g(/(?:Creation Date|created|Registered on):\s*(.+)/i),
      expires: g(/(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date|paid-till|Expiration Date):\s*(.+)/i),
      ns: [...raw.matchAll(/Name Server:\s*(\S+)/ig)].map((x) => x[1].toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6),
    };
  } catch { return null; }
}

// --- гео-IP через бесплатный ip-api.com (внешний сервис; уходит только IP цели) ---
async function seoGeo(host) {
  let ip; try { const ips = await dns.promises.resolve4(host); ip = ips[0]; } catch { return null; }
  if (!ip) return null;
  return new Promise((resolve) => {
    const req = http.get('http://ip-api.com/json/' + ip + '?fields=status,country,city,isp,org,as,query', { timeout: 6000 }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { try { const j = JSON.parse(d); resolve(j.status === 'success' ? j : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// --- проверка ссылок: HEAD (с GET-фолбэком на 405) пулом, возвращаем только битые ---
const SEO_LINKS_MAX = 60;
async function seoCheckLinks(urls, base) {
  const uniq = [...new Set(urls)].filter(Boolean).slice(0, SEO_LINKS_MAX);
  const broken = []; let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const idx = i++; let lu; try { lu = new URL(uniq[idx], base); } catch { continue; }
      if (!/^https?:$/.test(lu.protocol)) continue;
      let r = await seoRequestOnce(lu, 'HEAD', 6000);
      let status = r.ok ? r.status : 0;
      if (r.ok && (status === 405 || status === 501)) { const g = await seoRequestOnce(lu, 'GET', 6000); status = g.ok ? g.status : 0; }
      const ok = status >= 200 && status < 400;
      if (!ok) broken.push({ url: lu.href, status: r.ok ? status : ('ошибка: ' + r.error) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, uniq.length || 1) }, worker));
  return { checked: uniq.length, broken: broken.slice(0, 40) };
}

ipcMain.handle('seo:scan', async (_e, { url }) => {
  const u = seoNormalizeUrl(url);
  if (!u) return { error: 'Некорректный адрес' };
  const local = seoIsLocalHost(u.hostname);
  const out = { url: u.href, host: u.hostname, scheme: u.protocol.replace(':', ''), local, scannedAt: new Date().toISOString() };

  const fetched = await seoFetchChain(u);
  out.fetch = fetched.ok
    ? { ok: true, status: fetched.status, finalUrl: fetched.finalUrl, server: fetched.headers['server'] || '', contentType: fetched.headers['content-type'] || '', bytes: fetched.bytes, ms: fetched.ms, redirects: fetched.redirects }
    : { ok: false, error: fetched.error, redirects: fetched.redirects || [] };
  if (!fetched.ok) return out; // сайт недоступен — дальше нечего проверять

  const headers = fetched.headers;
  out.headers = headers;
  const isHttps = new URL(fetched.finalUrl).protocol === 'https:';
  out.security = seoSecurityHeaders(headers, isHttps);
  out.cookies = seoCookies(headers);
  out.seo = seoParseHtml(fetched.body);
  out.seo.issues = seoIssues(out.seo);

  const origin = new URL(fetched.finalUrl).origin;
  const [robots, sitemap, secTxt, gitHead, envFile] = await Promise.all([
    seoProbeFile(origin, '/robots.txt'), seoProbeFile(origin, '/sitemap.xml'), seoProbeFile(origin, '/.well-known/security.txt'),
    seoProbeFile(origin, '/.git/HEAD'), seoProbeFile(origin, '/.env'),
  ]);
  out.files = { robots, sitemap, securityTxt: secTxt };
  // Экспонированные файлы — серьёзная утечка: .git/HEAD начинается с «ref:», .env содержит «=».
  out.exposed = {
    git: gitHead.found && /^ref:|^[0-9a-f]{40}/i.test(gitHead.sample || ''),
    env: envFile.found && /[A-Z_]+\s*=/.test(envFile.sample || ''),
  };

  if (isHttps) { try { out.tls = await seoTls(new URL(fetched.finalUrl)); } catch (e) { out.tls = { ok: false, error: String(e) }; } }
  if (!local) {
    try { out.dns = await seoDns(u.hostname); } catch (e) { out.dns = { error: String(e) }; }
    [out.whois, out.geo] = await Promise.all([
      seoWhois(u.hostname).catch(() => null),
      seoGeo(u.hostname).catch(() => null),
    ]);
  }

  // Сводный список находок (для чипов «Обзора», оценок и передачи агенту).
  const findings = [];
  for (const s of out.security) if (s.sev === 'crit' || s.sev === 'warn') findings.push({ cat: 'Безопасность', sev: s.sev, title: s.label + ' — отсутствует', advice: s.advice });
  for (const c of out.cookies) if (isHttps && !c.secure) findings.push({ cat: 'Безопасность', sev: 'info', title: 'Кука ' + c.name + ' без Secure', advice: 'На HTTPS все куки должны быть Secure.' });
  if (out.tls && out.tls.ok && out.tls.daysLeft < 21) findings.push({ cat: 'Безопасность', sev: out.tls.daysLeft < 0 ? 'crit' : 'warn', title: 'Сертификат: ' + out.tls.daysLeft + ' дн до истечения', advice: 'Обновите TLS-сертификат.' });
  if (out.exposed.git) findings.push({ cat: 'Безопасность', sev: 'crit', title: 'Открыт каталог .git/', advice: 'Доступ к /.git/ позволяет выкачать исходники. Закройте на уровне веб-сервера.' });
  if (out.exposed.env) findings.push({ cat: 'Безопасность', sev: 'crit', title: 'Открыт файл .env', advice: 'В /.env обычно ключи и пароли. Немедленно закройте доступ и смените секреты.' });
  { const leak = String(headers['x-powered-by'] || '') + ' ' + String(headers['server'] || ''); if (/[\d]+\.[\d]+/.test(leak)) findings.push({ cat: 'Безопасность', sev: 'info', title: 'Утечка версии ПО в заголовках', advice: 'Скройте версии в Server/X-Powered-By (' + leak.trim() + ').' }); }
  if (!out.files.robots.found) findings.push({ cat: 'SEO', sev: 'info', title: 'Нет robots.txt', advice: 'Добавьте robots.txt с ссылкой на sitemap.' });
  if (!out.files.sitemap.found) findings.push({ cat: 'SEO', sev: 'info', title: 'Нет sitemap.xml', advice: 'Добавьте карту сайта для индексации.' });
  for (const i of out.seo.issues) findings.push({ cat: 'SEO', sev: i.sev, title: i.title, advice: i.advice });
  if (out.dns && out.dns.mail) {
    if (!out.dns.mail.spf.found) findings.push({ cat: 'Почта', sev: 'info', title: 'Нет SPF-записи', advice: 'Добавьте TXT v=spf1 — защита от подделки писем.' });
    if (!out.dns.mail.dmarc.found) findings.push({ cat: 'Почта', sev: 'info', title: 'Нет DMARC-записи', advice: 'Добавьте _dmarc TXT v=DMARC1.' });
  }
  out.findings = findings;
  out.scores = {
    security: seoScore(findings.filter((f) => f.cat === 'Безопасность')),
    seo: seoScore(findings.filter((f) => f.cat === 'SEO')),
  };
  return out;
});

// Скрипт извлечения из ОТРЕНДЕРЕННОГО DOM (исполняется в контексте загруженной страницы).
// Возвращает JSON-сериализуемый объект: мета/заголовки/ссылки/картинки/техстек/метрики производительности.
const SEO_DOM_SCRIPT = `(async () => {
  const q = (s) => document.querySelector(s);
  const meta = (s) => { const e = q(s); return e ? (e.getAttribute('content') || '').trim() : null; };
  const hs = {}; for (let i = 1; i <= 6; i++) hs['h' + i] = [...document.querySelectorAll('h' + i)].map(e => (e.textContent || '').trim().slice(0, 80)).slice(0, 40);
  const loc = location.origin, internal = [], external = [];
  for (const el of document.querySelectorAll('a[href]')) { let href; try { href = new URL(el.getAttribute('href'), location.href).href; } catch { continue; } if (!/^https?:/.test(href)) continue; (href.startsWith(loc) ? internal : external).push(href.split('#')[0]); }
  const imgs = [...document.querySelectorAll('img')].map(im => ({ alt: im.getAttribute('alt'), w: im.getAttribute('width'), h: im.getAttribute('height'), lazy: im.getAttribute('loading') === 'lazy' }));
  const og = {}; for (const m of document.querySelectorAll('meta[property^="og:"]')) og[m.getAttribute('property').slice(3)] = m.getAttribute('content');
  const tw = {}; for (const m of document.querySelectorAll('meta[name^="twitter:"]')) tw[m.getAttribute('name').slice(8)] = m.getAttribute('content');
  const tech = []; const W = window; const add = (n) => { if (n && !tech.includes(n)) tech.push(n); };
  if (W.React || document.querySelector('[data-reactroot]')) add('React');
  if (W.__NEXT_DATA__) add('Next.js'); if (W.__NUXT__) add('Nuxt'); if (W.__remixContext) add('Remix');
  if (W.Vue || document.querySelector('[data-v-app]')) add('Vue');
  if (document.querySelector('[ng-version]')) add('Angular'); if (document.querySelector('[data-svelte-h]')) add('Svelte');
  if (W.jQuery) add('jQuery' + (W.jQuery.fn && W.jQuery.fn.jquery ? ' ' + W.jQuery.fn.jquery : ''));
  if (W.gtag || W.dataLayer) add('Google Analytics/GTM'); if (W.ym || W.Ya) add('Яндекс.Метрика');
  const gen = meta('meta[name="generator"]'); if (gen) add(gen);
  const srcs = [...document.scripts].map(s => s.src).join(' ');
  if (/wp-content|wp-includes/.test(srcs)) add('WordPress'); if (/tilda/.test(srcs)) add('Tilda'); if (/bitrix/i.test(srcs)) add('1C-Bitrix'); if (/cdn\\.shopify/.test(srcs)) add('Shopify');
  let lcp = 0, cls = 0;
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  await new Promise(r => setTimeout(r, 450));
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = (performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint') || {}).startTime || 0;
  const perf = { ttfb: Math.round(nav.responseStart || 0), fcp: Math.round(fcp), dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0), lcp: Math.round(lcp), cls: Math.round(cls * 1000) / 1000, domNodes: document.getElementsByTagName('*').length };
  return {
    title: (q('title') && q('title').textContent.trim()) || null,
    description: meta('meta[name="description"]'), canonical: (q('link[rel="canonical"]') && q('link[rel="canonical"]').getAttribute('href')) || null,
    viewport: meta('meta[name="viewport"]'), robotsMeta: meta('meta[name="robots"]'), lang: document.documentElement.getAttribute('lang') || null,
    h: hs, h1Count: hs.h1.length, links: { internal: [...new Set(internal)].slice(0, 250), external: [...new Set(external)].slice(0, 250) },
    imgCount: imgs.length, imgNoAlt: imgs.filter(i => i.alt == null).length, imgNoDim: imgs.filter(i => !i.w || !i.h).length, imgNoLazy: imgs.filter(i => !i.lazy).length,
    og, twitter: tw, hasJsonLd: !!document.querySelector('script[type="application/ld+json"]'), textLen: ((document.body && document.body.innerText) || '').length, tech, perf,
  };
})()`;

const SEO_RENDER_TIMEOUT = 20000;
// Обёртка против зависания отдельного шага рендера (страница/GPU/CDP могут залипнуть навсегда).
function seoWithTimeout(p, ms, fallback) {
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

// Глубокий аудит: грузим страницу в скрытом окне, снимаем отрендеренный DOM, метрики, сеть (CDP),
// скриншоты, консольные ошибки, битые ссылки. Окно ВСЕГДА уничтожается в finally.
// Каждый потенциально-залипающий шаг обёрнут таймаутом, чтобы аудит не висел бесконечно.
ipcMain.handle('seo:render', async (_e, { url }) => {
  const u = seoNormalizeUrl(url);
  if (!u) return { ok: false, error: 'Некорректный адрес' };
  let win = null;
  const network = { requests: 0, bytes: 0, byType: {}, uncompressed: 0, thirdParty: 0, heavy: [], mixed: 0 };
  const consoleMsgs = [];
  try {
    win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, images: true } });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.on('console-message', (e) => { const message = e.message; const level = e.level === 'error' ? 3 : e.level === 'warning' ? 2 : 0; if (level >= 2) consoleMsgs.push({ level, text: String(message).slice(0, 300) }); if (/Mixed Content/i.test(message)) network.mixed++; });

    // Сетевая статистика через CDP (точные размеры передачи, типы, сжатие).
    let dbg = false; const reqInfo = new Map();
    try {
      wc.debugger.attach('1.3'); dbg = true;
      wc.debugger.on('message', (_ev, method, params) => {
        if (method === 'Network.responseReceived') {
          const r = params.response || {};
          const hh = r.headers || {};
          reqInfo.set(params.requestId, { type: params.type, mime: r.mimeType || '', url: r.url || '', enc: hh['content-encoding'] || hh['Content-Encoding'] || '' });
        } else if (method === 'Network.loadingFinished') {
          const info = reqInfo.get(params.requestId) || {}; const size = params.encodedDataLength || 0;
          network.requests++; network.bytes += size;
          const t = info.type || 'Other'; network.byType[t] = (network.byType[t] || 0) + size;
          if (!info.enc && size > 2048 && /text|javascript|json|css|html|svg|xml/i.test(info.mime)) network.uncompressed += size;
          try { if (info.url) { const h = new URL(info.url).host; if (h && h !== u.host) network.thirdParty++; } } catch (e) {}
          if (size > 150 * 1024 && info.url) network.heavy.push({ url: info.url, bytes: size, type: t });
        }
      });
      await wc.debugger.sendCommand('Network.enable');
    } catch (e) { /* CDP недоступен — сетевые метрики пропустим */ }

    const loaded = new Promise((res) => { wc.once('did-finish-load', () => res({ ok: true })); wc.once('did-fail-load', (_e2, code, desc) => res({ fail: desc || String(code) })); });
    const timer = new Promise((res) => setTimeout(() => res({ timeout: true }), SEO_RENDER_TIMEOUT));
    win.loadURL(u.href).catch(() => {});
    const loadRes = await Promise.race([loaded, timer]);
    await new Promise((r) => setTimeout(r, 400)); // дать догрузиться

    // Извлечение DOM — с таймаутом (страница может залипнуть и не отдать результат).
    const dom = await seoWithTimeout(
      wc.executeJavaScript(SEO_DOM_SCRIPT, true).catch((e) => ({ error: String((e && e.message) || e) })),
      8000, { error: 'таймаут извлечения DOM' });

    let shotDesktop = null, shotMobile = null;
    try { const img = await seoWithTimeout(wc.capturePage(), 6000, null); if (img && !img.isEmpty()) shotDesktop = img.resize({ width: 520 }).toDataURL(); } catch (e) {}
    try {
      if (dbg) {
        await seoWithTimeout(wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }), 3000, null);
        await new Promise((r) => setTimeout(r, 300));
        const img2 = await seoWithTimeout(wc.capturePage(), 6000, null); if (img2 && !img2.isEmpty()) shotMobile = img2.resize({ width: 280 }).toDataURL();
        await seoWithTimeout(wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'), 3000, null);
      }
    } catch (e) {}

    network.heavy.sort((a, b) => b.bytes - a.bytes); network.heavy = network.heavy.slice(0, 12);

    try { if (dbg) wc.debugger.detach(); } catch (e) {}
    // Реальный провал загрузки: ошибка + ни одного запроса + пустой DOM (а не просто ERR_ABORTED на догрузке).
    if (loadRes && loadRes.fail && network.requests === 0 && (!dom || (!dom.title && (!dom.perf || !dom.perf.domNodes)))) {
      return { ok: false, error: 'страница не загрузилась: ' + loadRes.fail };
    }
    // Проверка ссылок вынесена в seo:links (отдельный этап) — рендер отдаёт скриншоты/метрики сразу.
    return { ok: true, url: u.href, dom, perf: (dom && dom.perf) || null, network, console: consoleMsgs.slice(0, 30), screenshot: { desktop: shotDesktop, mobile: shotMobile }, loadResult: loadRes };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  }
});

// Проверка ссылок (третий этап аудита) — отдельным IPC, чтобы рендер не ждал HEAD-обхода.
ipcMain.handle('seo:links', async (_e, { urls, base }) => {
  let b; try { b = new URL(base); } catch { return { checked: 0, broken: [] }; }
  return seoCheckLinks(Array.isArray(urls) ? urls : [], b);
});

// Поиск локальных dev-серверов: пробуем открыть TCP на типовых портах 127.0.0.1.
ipcMain.handle('seo:devServers', async () => {
  const probe = (port) => new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 350 }, () => { s.destroy(); resolve(port); });
    s.on('timeout', () => { s.destroy(); resolve(null); });
    s.on('error', () => resolve(null));
  });
  const open = (await Promise.all(SEO_DEV_PORTS.map(probe))).filter(Boolean);
  return { ports: open };
});

// Экспорт отчёта в файл (как audit:export).
ipcMain.handle('seo:export', async (_e, { content, defaultName }) => {
  try {
    const r = await dialog.showSaveDialog({
      defaultPath: defaultName || 'seo-report.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'JSON', extensions: ['json'] }, { name: 'Все файлы', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, String(content == null ? '' : content));
    return { ok: true, file: r.filePath };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});

// Map of changed files (abs path -> short status code) for tree decorations.
ipcMain.handle('git:status', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return { error: 'no root' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { repo: false, files: {} };
  const base = top.trim();
  // --untracked-files=all: перечислять КАЖДЫЙ новый файл по отдельности, а не схлопывать
  // содержимое неотслеживаемой папки в один элемент-каталог (во вкладке «Изменения» нужны файлы).
  // core.quotePath=false: иначе git октально экранирует не-ASCII имена и оборачивает в кавычки —
  // снять кавычки мало, путь останется искажённым и не совпадёт с файлом на диске (декорации/диффы
  // молча промахивались мимо русских/юникод-имён, B5).
  const out = await git(root, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']);
  const files = {};
  if (out) {
    for (const line of out.split('\n')) {
      if (!line) continue;
      const code = line.slice(0, 2).trim();
      let p = line.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ')[1]; // renames: take the new path
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      files[path.join(base, p)] = code || '?';
    }
  }
  return { repo: true, files };
});
// Unified diff of one file vs HEAD — "what did the agent just change here".
ipcMain.handle('git:fileDiff', async (_e, { root, file }) => {
  if (!root) return { error: 'no root' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { error: 'не git-репозиторий' };
  let out = await git(root, ['diff', 'HEAD', '--', file]);
  if (out != null && out.trim() === '') out = await git(root, ['diff', '--', file]); // unstaged-only fallback
  // Неотслеживаемый (новый) файл git diff не знает → синтезируем дифф «всё добавлено» из содержимого
  // на диске, иначе клик по новому файлу открывал бы пустую панель «Нет изменений».
  if ((out == null || out.trim() === '') && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', file]); // null → файл не отслеживается
    if (tracked == null) {
      try {
        const buf = fs.readFileSync(file);
        const rel = path.basename(file);
        if (buf.includes(0)) out = 'diff --git a/' + rel + ' b/' + rel + '\nBinary file (новый, не отслеживается)';
        else {
          const lines = buf.toString('utf8').split('\n');
          if (lines.length && lines[lines.length - 1] === '') lines.pop(); // не считать финальный перевод строки лишней строкой
          out = '--- /dev/null\n+++ b/' + rel + '\n@@ -0,0 +1,' + lines.length + ' @@\n' + lines.map((l) => '+' + l).join('\n');
        }
      } catch (_) { /* нечитаемый файл — оставляем пустой дифф */ }
    }
  }
  return { diff: out || '' };
});
// Пара «до/после» одного файла для side-by-side диффа: old = версия из HEAD, new = рабочий файл.
// Новый (untracked) файл → old:'' ; удалённый с диска → new:''. Бинарь/огромный файл → error (UI
// откатится на unified-вид).
ipcMain.handle('git:filePair', async (_e, { root, file } = {}) => {
  if (!root || !file) return { error: 'no root/file' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { error: 'не git-репозиторий' };
  const rel = path.relative(top.trim(), file).replace(/\\/g, '/');
  const oldText = await git(root, ['show', 'HEAD:' + rel]);      // null → файла не было в HEAD
  let newText = null;
  try {
    const st = await fs.promises.stat(file);
    if (st.isFile() && st.size <= MAX_VIEW_BYTES) newText = await fs.promises.readFile(file, 'utf8');
    else if (st.isFile()) return { error: 'файл слишком большой' };
  } catch (_) { /* удалён с диска → null */ }
  if (oldText == null && newText == null) return { error: 'нет содержимого' };
  if ((oldText || '').includes('\0') || (newText || '').includes('\0')) return { error: 'бинарный файл' };
  if ((oldText || '').length > MAX_VIEW_BYTES) return { error: 'файл слишком большой' };
  return { ok: true, oldText: oldText || '', newText: newText || '' };
});
// Пара «родитель/коммит» файла (rel-путь из git:commitFiles) для side-by-side диффа истории.
ipcMain.handle('git:commitFilePair', async (_e, { root, hash, file } = {}) => {
  const h = String(hash || '').trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(h)) return { error: 'bad hash' };
  const rel = String(file || '').replace(/\\/g, '/');
  if (!rel) return { error: 'no file' };
  const oldText = await git(root, ['show', h + '^:' + rel]);     // null → нет в родителе (новый / первый коммит)
  const newText = await git(root, ['show', h + ':' + rel]);      // null → удалён этим коммитом
  if (oldText == null && newText == null) return { error: 'нет содержимого' };
  if ((oldText || '').includes('\0') || (newText || '').includes('\0')) return { error: 'бинарный файл' };
  if ((oldText || '').length > MAX_VIEW_BYTES || (newText || '').length > MAX_VIEW_BYTES) return { error: 'файл слишком большой' };
  return { ok: true, oldText: oldText || '', newText: newText || '' };
});

// Mutating git for the light panel. GIT_TERMINAL_PROMPT=0 + timeout so a command
// that would block on auth fails fast with a message instead of hanging the app.
function gitRun(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: opts.timeout || 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' } },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: (stdout || '').trim(),
        error: err ? ((stderr || '').trim() || String(err.message || err)) : '',
      }));
  });
}
ipcMain.handle('git:info', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return { repo: false };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { repo: false };
  const branch = ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim() || 'HEAD';
  let ahead = 0, behind = 0, upstream = false;
  const counts = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts != null) { const m = counts.trim().split(/\s+/); behind = +m[0] || 0; ahead = +m[1] || 0; upstream = true; }
  // Per-branch upstream tracking: имя + upstream + [ahead N, behind M] (по уже зафетченным
  // remote-tracking ref'ам, без сети — как PhpStorm после fetch). Таб-разделитель безопасен:
  // имя ветки таб не содержит, а %(upstream:track) — только пробелы/скобки/запятые.
  const brOut = await git(root, ['branch', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)']);
  const branches = [];
  const branchTrack = {};
  if (brOut) for (const line of brOut.split('\n')) {
    if (!line.trim()) continue;
    const [name, up, track] = line.split('\t');
    if (!name) continue;
    branches.push(name);
    let a = 0, bh = 0, gone = false;
    if (track) {
      if (/gone/.test(track)) gone = true;
      const am = track.match(/ahead (\d+)/); if (am) a = +am[1];
      const bm = track.match(/behind (\d+)/); if (bm) bh = +bm[1];
    }
    branchTrack[name] = { upstream: (up || '').trim(), ahead: a, behind: bh, gone };
  }
  const remote = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
  return { repo: true, branch, ahead, behind, upstream, branches, branchTrack, hasRemote: remote.length > 0 };
});
// Recent commit history for the Git module's log view (PhpStorm-style). Read-only.
ipcMain.handle('git:log', async (_e, { root, limit } = {}) => {
  if (!root || !fs.existsSync(root)) return { error: 'no root' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { repo: false, commits: [] };
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 40));
  // \x1f = field sep, one record per line; safe against spaces in subject/author.
  const out = await git(root, ['log', `-${n}`, '--pretty=format:%h%x1f%s%x1f%cr%x1f%an%x1f%D']);
  const commits = [];
  if (out) for (const rec of out.split('\n')) {
    if (!rec) continue;
    const [hash, subject, when, author, refs] = rec.split('\x1f');
    commits.push({ hash, subject, when, author, refs: (refs || '').trim() });
  }
  return { repo: true, commits };
});
ipcMain.handle('git:checkout', async (_e, { root, branch }) => gitRun(root, ['checkout', branch]));
ipcMain.handle('git:fetch', async (_e, root) => gitRun(root, ['fetch', '--all', '--prune']));
// Откат правок — тоже перезапись файла рукой редактора, значит по контракту локальной истории
// (см. histSnapshot) состояние ДО неё надо снять: `git checkout --` стирает несохранённую в
// коммит работу насовсем, вернуть её больше неоткуда. Вотчер снимет уже ОТКАЧЕННОЕ содержимое —
// поздно. Троттл истории (45 с) сам решит, нужен ли ещё один снимок.
ipcMain.handle('git:discardFile', async (_e, { root, file }) => {
  await histSnapshotFromDisk(path.isAbsolute(file) ? file : path.join(root, file), 'save');
  return gitRun(root, ['checkout', '--', file]);
});
// Update a branch from its upstream WITHOUT checkout (fast-forward of the local ref).
// Current branch can't be ff-fetched into → use pull --ff-only instead.
ipcMain.handle('git:branchUpdate', async (_e, { root, branch, current }) => {
  if (current) return gitRun(root, ['pull', '--ff-only']);
  const remote = ((await git(root, ['config', `branch.${branch}.remote`])) || '').trim() || 'origin';
  const rb = ((await git(root, ['config', `branch.${branch}.merge`])) || '').trim().replace('refs/heads/', '') || branch;
  return gitRun(root, ['fetch', remote, `${rb}:${branch}`]);
});
// New branch from any base branch; optionally check it out.
ipcMain.handle('git:branchCreate', async (_e, { root, name, base, checkout }) => {
  const nm = (name || '').trim();
  // Имя из пользовательского ввода: ведущий '-' git примет за флаг (как в git:clone выше),
  // а пробелы/спецсимволы — невалидный ref. Отсекаем до вызова с понятной ошибкой.
  if (!nm || nm.startsWith('-') || /[\s~^:?*[\\]/.test(nm) || nm.includes('..')) return { ok: false, error: 'Недопустимое имя ветки' };
  return gitRun(root, checkout ? ['checkout', '-b', nm, base] : ['branch', nm, base]);
});
ipcMain.handle('git:init', async (_e, root) => gitRun(root, ['init']));
// Clone INTO the (empty) project folder. Longer timeout than other mutations — fetching
// a repo legitimately takes a while; private repos that need auth still fail fast via
// GIT_TERMINAL_PROMPT=0 (do that clone from the terminal instead).
ipcMain.handle('git:clone', async (_e, { root, url }) => {
  const u = (url || '').trim();
  // Guard against argv flag-smuggling (leading '-' parsed as a git option) and the
  // ext::/fd:: remote-helper transports, which let a URL run arbitrary shell commands.
  if (!u || u.startsWith('-') || /^(ext|fd)::/i.test(u)) return { ok: false, error: 'Недопустимый URL репозитория' };
  // '--' ends option parsing so the URL can never be treated as a flag.
  return gitRun(root, ['clone', '--', u, '.'], { timeout: 120000 });
});
// Пуш с авто-установкой upstream при первом пуше ветки (как PhpStorm / git push.autoSetupRemote).
// Без этого `git push` для ветки без upstream падал «has no upstream branch» — коммит проходил,
// а пуш нет; пользователю приходилось пушить из стороннего клиента.
async function gitPush(root) {
  const first = await gitRun(root, ['push']);
  if (first.ok) return first;
  if (/no upstream branch|--set-upstream|no configured push destination|does not have a branch/i.test(first.error || '')) {
    const remotes = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (remote) return gitRun(root, ['push', '-u', remote, 'HEAD']);
  }
  return first;
}
ipcMain.handle('git:commit', async (_e, { root, message, push, files, amend }) => {
  // files передан → коммитим только выбранное (git add -- <files>), иначе всё (git add -A, как раньше).
  // amend + files:[] (пустой массив) — особый случай «только поправить сообщение»: ничего не добавляем.
  const sel = Array.isArray(files) && files.length;
  const msgOnly = amend && Array.isArray(files) && !files.length;
  if (!msgOnly) { const add = await gitRun(root, sel ? ['add', '--', ...files] : ['add', '-A']); if (!add.ok) return add; }
  // sel → коммитим РОВНО выбранные пути (pathspec), иначе `git commit` забрал бы и всё прочее,
  // что уже лежит в индексе (напр. файл, застейдженный при разрешении конфликта и затем снятый галкой).
  const base = amend ? ['commit', '--amend', '-m', message || 'update'] : ['commit', '-m', message || 'update'];
  const c = await gitRun(root, sel ? [...base, '--', ...files] : base); if (!c.ok) return c;
  // committed:true даже при провале пуша — фронт обязан обновить список (коммит-то уже лёг).
  if (push) { const p = await gitPush(root); if (!p.ok) return { ok: false, committed: true, error: 'Коммит создан, push не прошёл: ' + p.error }; }
  return { ok: true, out: c.out };
});
// Последнее сообщение коммита (для подстановки при включении Amend).
ipcMain.handle('git:lastMessage', async (_e, root) => {
  const out = await git(root, ['log', '-1', '--format=%B']);
  return out == null ? { ok: false, message: '' } : { ok: true, message: out.trim() };
});
// История одного файла (--follow: переживает переименования) для оверлея «История файла».
ipcMain.handle('git:fileLog', async (_e, { root, file, limit } = {}) => {
  if (!root || !file) return { error: 'no root/file' };
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
  const out = await git(root, ['log', '--follow', `-${n}`, '--pretty=format:%h%x1f%s%x1f%cr%x1f%an', '--', file]);
  if (out == null) return { error: 'не git-репозиторий или файл не отслеживается' };
  const commits = [];
  for (const rec of out.split('\n')) {
    if (!rec) continue;
    const [hash, subject, when, author] = rec.split('\x1f');
    commits.push({ hash, subject, when, author });
  }
  return { ok: true, commits };
});
// Cherry-pick / revert коммита из лога + полное сообщение коммита (для «Копировать сообщение»).
const OK_HASH = (h) => /^[0-9a-fA-F]{4,40}$/.test(String(h || '').trim());
ipcMain.handle('git:cherryPick', async (_e, { root, hash } = {}) =>
  OK_HASH(hash) ? gitRun(root, ['cherry-pick', String(hash).trim()]) : { ok: false, error: 'bad hash' });
ipcMain.handle('git:revertCommit', async (_e, { root, hash } = {}) =>
  OK_HASH(hash) ? gitRun(root, ['revert', '--no-edit', String(hash).trim()]) : { ok: false, error: 'bad hash' });
ipcMain.handle('git:commitMsg', async (_e, { root, hash } = {}) => {
  if (!OK_HASH(hash)) return { error: 'bad hash' };
  const out = await git(root, ['log', '-1', '--format=%B', String(hash).trim()]);
  return out == null ? { error: 'коммит не найден' } : { ok: true, message: out.trim() };
});
// Стейджинг выбранных путей (для пометки конфликта разрешённым и выборочного коммита).
ipcMain.handle('git:add', async (_e, { root, files }) =>
  gitRun(root, ['add', '--', ...(Array.isArray(files) ? files : [files])]));
// Список конфликтных файлов (unmerged). Коды porcelain с 'U' либо AA/DD — обе стороны изменили.
ipcMain.handle('git:conflicts', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return { error: 'no root' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { repo: false, files: [] };
  const base = top.trim();
  const out = await git(root, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=no']); // не-ASCII имена без октального экранирования (B5)
  const files = [];
  if (out) for (const line of out.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    // Unmerged: оба знака конфликта (DD, AU, UD, UA, DU, AA, UU) — наличие 'U', либо DD/AA.
    if (/U/.test(code) || code === 'DD' || code === 'AA') {
      let p = line.slice(3);
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      files.push({ rel: p, abs: path.join(base, p), code: code.trim() });
    }
  }
  return { repo: true, files };
});
// Слить ветку в текущую. Конфликт → ok:false (UI откроет модалку разрешения по git:conflicts).
ipcMain.handle('git:merge', async (_e, { root, branch }) => gitRun(root, ['merge', '--no-edit', branch]));
ipcMain.handle('git:mergeAbort', async (_e, root) => gitRun(root, ['merge', '--abort']));
ipcMain.handle('git:push', async (_e, root) => gitPush(root));
ipcMain.handle('git:pull', async (_e, root) => gitRun(root, ['pull', '--ff-only']));
// Stash including untracked (-u) so a quick "спрятать всё" doesn't leave new files behind.
ipcMain.handle('git:stash', async (_e, root) => gitRun(root, ['stash', 'push', '-u']));
// Revert tracked edits only ('checkout -- .'); untracked files are deliberately kept (no -fd clean).
// «Откатить всё» — самая разрушительная кнопка в редакторе: снимаем историю по каждому
// изменённому отслеживаемому файлу. Лимит — чтобы откат на тысяче файлов не встал колом.
const DISCARD_HIST_CAP = 60;
ipcMain.handle('git:discardAll', async (_e, root) => {
  const out = await git(root, ['diff', '--name-only']);
  if (out) {
    for (const rel of out.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, DISCARD_HIST_CAP))
      await histSnapshotFromDisk(path.join(root, rel), 'save');
  }
  return gitRun(root, ['checkout', '--', '.']);
});

// C18: откатить один ханк правок агента — reverse-apply минимального патча к рабочему дереву.
ipcMain.handle('git:revertHunk', async (_e, { root, patch } = {}) => {
  if (!root || !patch) return { ok: false, error: 'нет патча' };
  return new Promise((resolve) => {
    const child = execFile('git', ['apply', '--reverse', '-'], { cwd: root, timeout: 15000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, _stdout, stderr) => resolve({ ok: !err, error: err ? ((stderr || '').trim() || String(err.message || err)) : '' }));
    try { child.stdin.write(patch); child.stdin.end(); } catch (e) { resolve({ ok: false, error: String(e) }); }
  });
});

// A7: git blame файла (--line-porcelain) → массив пер-строчных {hash,author,time,summary} (1:1 строкам файла).
ipcMain.handle('git:blame', async (_e, { root, file } = {}) => {
  if (!root || !file) return { error: 'no root/file' };
  const out = await git(root, ['blame', '--line-porcelain', '--', file]);
  if (out == null) return { error: 'не git-репозиторий или файл не отслеживается' };
  const lines = [];
  let cur = null;
  for (const ln of out.split('\n')) {
    if (/^[0-9a-f]{40} /.test(ln)) { cur = { hash: ln.slice(0, 8), uncommitted: /^0{40} /.test(ln) }; }
    else if (cur && ln.startsWith('author ')) cur.author = ln.slice(7);
    else if (cur && ln.startsWith('author-time ')) cur.time = parseInt(ln.slice(12), 10) || 0;
    else if (cur && ln.startsWith('summary ')) cur.summary = ln.slice(8);
    else if (cur && ln.startsWith('\t')) { lines.push(cur); cur = null; }
  }
  return { ok: true, lines };
});

// ---------------------------------------------------------------- git: stash management (PhpStorm-style)
// index приходит из UI, но в ref подставляем только провалидированное число — никакого argv-инъекшна.
const stashRef = (index) => { const i = parseInt(index, 10); return i >= 0 ? `stash@{${i}}` : null; };
ipcMain.handle('git:stashList', async (_e, root) => {
  const out = await git(root, ['stash', 'list', '--format=%gd%x1f%s%x1f%cr']);
  const items = [];
  if (out) for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, subject, when] = line.split('\x1f');
    const m = /stash@\{(\d+)\}/.exec(ref || '');
    items.push({ index: m ? +m[1] : items.length, ref: ref || '', subject: subject || '', when: when || '' });
  }
  return { ok: true, items };
});
// Файлы в конкретном stash (--name-status, включая untracked).
ipcMain.handle('git:stashShow', async (_e, { root, index } = {}) => {
  const ref = stashRef(index); if (!ref) return { ok: false, error: 'bad stash index' };
  const out = await git(root, ['stash', 'show', '--include-untracked', '--name-status', ref]);
  const files = [];
  if (out != null) for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    files.push({ code: (parts[0] || '').trim(), rel: parts[parts.length - 1] });
  }
  return { ok: true, files };
});
ipcMain.handle('git:stashApply', async (_e, { root, index } = {}) => { const r = stashRef(index); return r ? gitRun(root, ['stash', 'apply', r]) : { ok: false, error: 'bad index' }; });
ipcMain.handle('git:stashPopIndex', async (_e, { root, index } = {}) => { const r = stashRef(index); return r ? gitRun(root, ['stash', 'pop', r]) : { ok: false, error: 'bad index' }; });
ipcMain.handle('git:stashDrop', async (_e, { root, index } = {}) => { const r = stashRef(index); return r ? gitRun(root, ['stash', 'drop', r]) : { ok: false, error: 'bad index' }; });

// ---------------------------------------------------------------- git: commit details (changed-files tree for the log)
// Файлы, изменённые в коммите (--name-status), для дерева изменённых файлов в логе.
ipcMain.handle('git:commitFiles', async (_e, { root, hash } = {}) => {
  const h = String(hash || '').trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(h)) return { ok: false, error: 'bad hash' };
  const out = await git(root, ['show', '--no-color', '--name-status', '--format=', h]);
  const files = [];
  if (out != null) for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    files.push({ code: (parts[0] || '').trim(), rel: parts[parts.length - 1] });
  }
  return { ok: true, files };
});
// Дифф одного файла в коммите (показать в центре вивера при выборе файла в логе).
ipcMain.handle('git:commitFileDiff', async (_e, { root, hash, file } = {}) => {
  const h = String(hash || '').trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(h)) return { error: 'bad hash' };
  // --format= убирает заголовок коммита из вывода — в центре вивера нужен чистый дифф
  // (сообщение и так видно в списке истории и в имени вкладки).
  const out = await git(root, ['show', '--no-color', '--format=', h, '--', file]);
  return { diff: out || '' };
});

// ---------------------------------------------------------------- git: branches (local + remote) & ops (PhpStorm-style)
// Отсекаем argv-инъекшн/невалидные ref'ы (ведущий '-', пробелы/спецсимволы, '..'); '/' разрешён (remote/feature).
const BAD_REF = (s) => !s || String(s).startsWith('-') || /[\s~^:?*[\\]/.test(String(s)) || String(s).includes('..');
ipcMain.handle('git:branches', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return { repo: false };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { repo: false };
  const current = ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim();
  // for-each-ref (в отличие от log) НЕ понимает плейсхолдер %x1f — подставляем реальный байт 0x1F разделителем.
  const localOut = await git(root, ['for-each-ref', '--format=%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track)', 'refs/heads']);
  const local = [];
  if (localOut) for (const line of localOut.split('\n')) {
    if (!line.trim()) continue;
    const [name, up, track] = line.split('\x1f');
    let ahead = 0, behind = 0, gone = false;
    if (track) { if (/gone/.test(track)) gone = true; const a = track.match(/ahead (\d+)/); if (a) ahead = +a[1]; const b = track.match(/behind (\d+)/); if (b) behind = +b[1]; }
    local.push({ name, upstream: (up || '').trim(), ahead, behind, gone });
  }
  const remoteOut = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  const remote = [];
  if (remoteOut) for (const line of remoteOut.split('\n')) { const n = line.trim(); if (!n || /\/HEAD$/.test(n)) continue; remote.push(n); }
  return { repo: true, current, local, remote };
});
ipcMain.handle('git:branchRename', async (_e, { root, from, to } = {}) => {
  if (BAD_REF(to) || BAD_REF(from)) return { ok: false, error: 'Недопустимое имя ветки' };
  return gitRun(root, ['branch', '-m', from, to]);
});
ipcMain.handle('git:branchDelete', async (_e, { root, name, force } = {}) => {
  if (BAD_REF(name)) return { ok: false, error: 'Недопустимое имя ветки' };
  return gitRun(root, ['branch', force ? '-D' : '-d', name]);
});
ipcMain.handle('git:branchPush', async (_e, { root, name } = {}) => {
  if (BAD_REF(name)) return { ok: false, error: 'Недопустимое имя ветки' };
  const remotes = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) return { ok: false, error: 'нет remote' };
  return gitRun(root, ['push', '-u', remote, name]);
});
// Checkout remote-ветки: создаём локальную tracking-ветку (origin/foo → foo), либо переключаемся, если уже есть.
ipcMain.handle('git:checkoutRemote', async (_e, { root, remoteBranch } = {}) => {
  const rb = String(remoteBranch || '');
  if (BAD_REF(rb)) return { ok: false, error: 'Недопустимое имя ветки' };
  const local = rb.replace(/^[^/]+\//, '');   // origin/foo → foo
  if (BAD_REF(local)) return { ok: false, error: 'Недопустимое имя ветки' };
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + local]);
  if (exists != null) return gitRun(root, ['checkout', local]);
  return gitRun(root, ['checkout', '-b', local, '--track', rb]);
});
ipcMain.handle('git:rebaseOnto', async (_e, { root, onto } = {}) => BAD_REF(onto) ? { ok: false, error: 'плохая ветка' } : gitRun(root, ['rebase', onto]));
ipcMain.handle('git:rebaseAbort', async (_e, root) => gitRun(root, ['rebase', '--abort']));
// Pull into current: тянем ИМЕННО выбранную remote-ветку (origin/foo → git pull <remote> <branch>),
// а не безымянный upstream текущей ветки. Без аргумента — фолбэк на стандартный pull.
function gitPullRef(root, remoteBranch, rebase) {
  const flag = rebase ? '--rebase' : '--no-rebase';
  if (!remoteBranch) return gitRun(root, ['pull', flag]);
  if (BAD_REF(remoteBranch)) return Promise.resolve({ ok: false, error: 'плохая ветка' });
  const i = String(remoteBranch).indexOf('/');
  const remote = i > 0 ? remoteBranch.slice(0, i) : 'origin';
  const branch = i > 0 ? remoteBranch.slice(i + 1) : remoteBranch;
  // перепроверяем КАЖДУЮ часть после split (ветка после '/' могла бы начинаться с '-' и протащить флаг);
  // '--' завершает разбор опций перед позиционными remote/refspec (defense-in-depth от argv-инъекции).
  if (BAD_REF(remote) || BAD_REF(branch)) return Promise.resolve({ ok: false, error: 'плохая ветка' });
  return gitRun(root, ['pull', flag, '--', remote, branch]);
}
ipcMain.handle('git:pullMerge', async (_e, { root, remoteBranch } = {}) => gitPullRef(root, remoteBranch, false));
ipcMain.handle('git:pullRebase', async (_e, { root, remoteBranch } = {}) => gitPullRef(root, remoteBranch, true));
// Compare with current: коммиты, что есть в выбранной ветке но нет в текущей (и наоборот).
ipcMain.handle('git:branchCompare', async (_e, { root, branch } = {}) => {
  if (BAD_REF(branch)) return { ok: false, error: 'плохая ветка' };
  const ahead = await git(root, ['log', '--oneline', '--no-color', `HEAD..${branch}`]);
  const behind = await git(root, ['log', '--oneline', '--no-color', `${branch}..HEAD`]);
  const parse = (s) => (s || '').split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return { hash: l.slice(0, i), subject: l.slice(i + 1) }; });
  return { ok: true, branch, onlyInBranch: parse(ahead), onlyInCurrent: parse(behind) };
});
// Diff выбранной ветки vs рабочее дерево (показать в центре вивера).
ipcMain.handle('git:branchDiffWorktree', async (_e, { root, branch } = {}) => {
  if (BAD_REF(branch)) return { error: 'плохая ветка' };
  const out = await git(root, ['diff', '--no-color', branch]);
  return { diff: out || '' };
});

// ================================================================ containers (docker/podman)
// Lightweight container manager — a desktop-GUI replacement. Read-only listing + basic
// lifecycle actions, shelled out to the docker/podman CLIs (no daemon socket, no extra deps).
// execFile (no shell) + an {engine} whitelist make CLI-arg injection a non-issue.
//
// Удалённый контекст («Удалённые хосты» → Контейнеры): SSH-туннель до docker/podman-сокета хоста
// (rh:sockTunnel), все CLI-вызовы идут с DOCKER_HOST/CONTAINER_HOST=tcp://127.0.0.1:<port>.
// Контекст один на процесс (окно «Контейнеры» одно на тип); opts.local=true обходит подмену.
let containersRemote = null; // { rhId, name, tunId, port, cli, sockPath }
let containersTunnelFix = null; // обещание переподнятия туннеля — чтобы параллельные опросы не плодили туннели
function cRemoteCtx(cli, baseEnv) {
  if (!containersRemote) return { cli, env: undefined };
  const env = { ...(baseEnv || process.env) };
  if (containersRemote.cli === 'docker') env.DOCKER_HOST = 'tcp://127.0.0.1:' + containersRemote.port;
  else env.CONTAINER_HOST = 'tcp://127.0.0.1:' + containersRemote.port;
  return { cli: containersRemote.cli, env };
}
function containerRun(cli, args, opts = {}) {
  // opts.env — явное окружение (проба свежего туннеля ДО фиксации containersRemote); opts.local — форс-локальный
  const ctx = opts.env ? { cli, env: opts.env } : (opts.local ? { cli } : cRemoteCtx(cli));
  return new Promise((resolve) => {
    execFile(ctx.cli, args, { timeout: opts.timeout || 15000, maxBuffer: 24 * 1024 * 1024, windowsHide: true, env: ctx.env },
      (err, stdout, stderr) => resolve({
        ok: !err, out: (stdout || '').trim(),
        error: err ? ((stderr || '').trim() || String(err.message || err)) : '',
      }));
  });
}
// Переключить окно «Контейнеры» на docker/podman удалённого хоста (или назад на локальный, rhId=null).
ipcMain.handle('containers:remoteSet', async (_e, { rhId, engine } = {}) => {
  if (!rhId) {
    if (containersRemote) { try { rhApi.closeTunnel(containersRemote.tunId); } catch (_) {} containersRemote = null; }
    return { ok: true, rhId: null };
  }
  const conn = rhApi.findConn(rhId);
  if (!conn) return { ok: false, error: 'SSH-профиль не найден' };
  const scan = await rhApi.scan(rhId);
  if (!scan.ok) return { ok: false, error: 'Скан хоста не удался: ' + (scan.error || '') };
  // hint 'podman-socket' → UI предложит включить socket-activated сервис по SSH
  const podmanHint = { ok: false, hint: 'podman-socket', error: 'Podman на хосте установлен, но API-сокет спит (systemctl --user enable --now podman.socket)' };
  // Сокет есть, но у SSH-пользователя нет прав (sshd открывает его от имени пользователя) —
  // без этой проверки CLI через туннель видел бы только голый «EOF». hint 'sock-access' → UI покажет
  // диагностику; если на хосте доступен sudo (NOPASSWD или пароль = паролю профиля) — предложит
  // кнопку «Починить по SSH» (canFix + fix из белого списка C_FIX_SCRIPTS, исполняет containers:remoteFix).
  const user = conn.user || '<user>';
  const denied = scan.denied || {};
  const deniedErr = async (eng) => {
    // sudo-детект: free (NOPASSWD) / need-pass / no. Пароль профиля пробуем только для password-профилей.
    const s = await rhApi.exec(rhId, 'command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null && echo sudo=free || echo sudo=need-pass; } || echo sudo=no', 12000);
    const mode = /sudo=free/.test(s.stdout || '') ? 'free' : (/sudo=need-pass/.test(s.stdout || '') ? 'need-pass' : 'no');
    const canFix = mode === 'free' || (mode === 'need-pass' && conn.auth !== 'key' && conn.auth !== 'agent' && !!conn.passEnc);
    if (eng === 'docker') return {
      ok: false, hint: 'sock-access', canFix, fix: 'docker-group',
      error: `Сокет Docker на хосте есть (${denied.docker}), но у пользователя «${user}» нет к нему доступа.` +
        (canFix ? ' Могу починить сам: добавлю пользователя в группу docker через sudo и сразу переподключусь.' : ' Добавьте его в группу docker (команда ниже) и повторите.'),
      cmd: `sudo sh -c '${C_FIX_SCRIPTS['docker-group']}'`,
    };
    return {
      ok: false, hint: 'sock-access', canFix, fix: 'podman-socket-group',
      error: `Сокет Podman на хосте есть (${denied.podman}), но у пользователя «${user}» нет к нему доступа — это рутовый podman.sock, по умолчанию он только для root.` +
        (canFix ? ' Могу починить сам: выдам группе пользователя право на этот сокет (drop-in systemd + перезапуск podman.socket; контейнеры не затрагиваются) и сразу переподключусь.' : ' Выдайте доступ командой ниже и повторите.'),
      cmd: `sudo sh -c '${C_FIX_SCRIPTS['podman-socket-group']}'`,
    };
  };
  const socks = scan.sockets || {};
  let sockPath;
  if (engine === 'docker' || engine === 'podman') { // явный выбор (из модалки или запомненный) — строго его сокет
    sockPath = socks[engine] || null;
    if (!sockPath && denied[engine]) return await deniedErr(engine);
    if (!sockPath) return (engine === 'podman' && scan.podmanCli) ? podmanHint : { ok: false, error: `На хосте нет сокета ${engine}` };
  } else if (socks.docker && socks.podman) {
    return { ok: true, needChoice: true }; // оба движка — пусть выберет пользователь (ok:true — не ошибка, без WARN в логе)
  } else {
    sockPath = socks.docker || socks.podman || null;
    if (!sockPath && (denied.docker || denied.podman)) return await deniedErr(denied.docker ? 'docker' : 'podman');
    if (!sockPath) return scan.podmanCli ? podmanHint : { ok: false, error: 'На хосте нет docker/podman-сокета (docker.sock / podman.sock не найдены)' };
  }
  const isPodman = sockPath.includes('podman');
  // Локальный клиент: docker CLI говорит и с Docker, и с podman-сокетом (compat API);
  // podman CLI (remote) — только с podman-сервисом.
  const probe = (cli) => containerRun(cli, ['--version'], { timeout: 5000, local: true });
  let cli = null;
  if ((await probe('docker')).ok) cli = 'docker';
  else if (isPodman && (await probe('podman')).ok) cli = 'podman';
  if (!cli) return { ok: false, error: isPodman ? 'Нужен локальный docker или podman CLI' : 'Удалённый демон — Docker: нужен локальный docker CLI' };
  const t = await rhApi.sockTunnel(rhId, sockPath, 'containers: ' + (conn.name || conn.host));
  if (!t.ok) return { ok: false, error: 'Туннель до сокета не поднялся: ' + (t.error || '') };
  // Проба демона СКВОЗЬ туннель до фиксации контекста: локальный listener поднимается всегда,
  // а канал к сокету sshd открывает только в момент коннекта — все прочие проблемы (форвардинг
  // запрещён, SELinux, мёртвый демон) всплывают именно здесь, и лучше внятной ошибкой, чем EOF-ами в списке.
  const env = { ...process.env };
  if (cli === 'docker') env.DOCKER_HOST = 'tcp://127.0.0.1:' + t.port; else env.CONTAINER_HOST = 'tcp://127.0.0.1:' + t.port;
  const check = await containerRun(cli, ['version'], { timeout: 12000, env });
  if (!check.ok) {
    const chanErr = rhApi.tunnelError(t.tunId); // причину смотрим ДО закрытия (closeTunnel убирает запись)
    try { rhApi.closeTunnel(t.tunId); } catch (_) {}
    let msg = `Демон на хосте не ответил через туннель (${sockPath}): ` + cFirstLine(check.error);
    if (chanErr) msg += ` · SSH-канал: ${chanErr}`;
    if (chanErr && /administratively|prohibited/i.test(chanErr)) msg += '. Похоже, sshd на хосте запрещает проброс unix-сокетов (AllowStreamLocalForwarding/DisableForwarding в sshd_config).';
    else if (sockPath.includes('docker')) msg += `. Чаще всего это права на сокет: пользователь «${user}» не в группе docker.`;
    return { ok: false, hint: 'sock-probe', error: msg, cmd: sockPath.includes('docker') ? `sudo usermod -aG docker ${user}` : undefined };
  }
  if (containersRemote) { try { rhApi.closeTunnel(containersRemote.tunId); } catch (_) {} }
  containersRemote = { rhId, name: conn.name || conn.host, tunId: t.tunId, port: t.port, cli, sockPath };
  return { ok: true, rhId, name: containersRemote.name, engine: cli };
});
ipcMain.handle('containers:remoteStatus', () => (containersRemote
  ? { rhId: containersRemote.rhId, name: containersRemote.name, engine: containersRemote.cli }
  : { rhId: null }));
// «Починить по SSH»: выдать SSH-пользователю доступ к сокету движка под sudo. Белый список скриптов —
// рендерер выбирает только идентификатор, произвольная root-команда отсюда не выполняется.
// Скрипты идут в sh -c '<...>' под sudo (rhApi.sudoExec: сперва -n, затем -S с паролем профиля),
// $SUDO_USER внутри — тот самый SSH-пользователь. Одинарных кавычек в теле быть не должно.
// docker-group: классика — членство в группе docker; наши SSH-соединения одноразовые, поэтому
//   новая группа подхватывается сразу же (relogin не нужен).
// podman-socket-group: рутовый podman.sock 0600 root:root → drop-in systemd даёт группе пользователя
//   rw (SocketMode=0660 + SocketGroup); рестарт только socket-юнита (+ стоп idle API-сервиса,
//   иначе systemd не даст пересоздать сокет) — контейнеры живут под conmon и не затрагиваются.
const C_FIX_SCRIPTS = {
  'docker-group': 'usermod -aG docker "$SUDO_USER"',
  'podman-socket-group': 'g=$(id -gn "$SUDO_USER"); mkdir -p /etc/systemd/system/podman.socket.d && printf "[Socket]\\nSocketMode=0660\\nSocketGroup=%s\\n" "$g" > /etc/systemd/system/podman.socket.d/50-liteeditor.conf && systemctl daemon-reload && { systemctl stop podman.service 2>/dev/null || true; } && systemctl restart podman.socket',
};
ipcMain.handle('containers:remoteFix', async (_e, { rhId, fix } = {}) => {
  const conn = rhApi.findConn(rhId);
  if (!conn) return { ok: false, error: 'SSH-профиль не найден' };
  const script = C_FIX_SCRIPTS[fix];
  if (!script) return { ok: false, error: 'Неизвестный тип починки' };
  const r = await rhApi.sudoExec(rhId, script, 45000);
  if (!r.ok) return { ok: false, error: 'Починка не прошла: ' + (r.error || '') + `. Выполните на хосте вручную: sudo sh -c '${script}'` };
  return { ok: true };
});
const cFirstLine = (s) => String(s || '').split('\n')[0].trim();
function cHumanSize(bytes) { // podman reports image size in bytes; docker is already human
  const n = Number(bytes); if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}
function cImgCreated(img) { // podman: CreatedAt is ISO, Created is a raw unix int — show a short date (docker has CreatedSince)
  const at = img.CreatedAt;
  if (typeof at === 'string' && /^\d{4}-\d\d-\d\d/.test(at)) return at.slice(0, 10);
  const n = Number(img.Created);
  if (Number.isFinite(n) && n > 0) { try { return new Date(n * 1000).toISOString().slice(0, 10); } catch (_) {} }
  return '';
}
function cParseLines(out) { // docker `{{json .}}` → one JSON object per line
  const arr = [];
  for (const ln of String(out || '').split('\n')) { const s = ln.trim(); if (!s) continue; try { arr.push(JSON.parse(s)); } catch (_) {} }
  return arr;
}
function cParseJson(out) { // podman `--format json` → array (fallback to line-JSON)
  const s = String(out || '').trim(); if (!s) return [];
  try { const j = JSON.parse(s); return Array.isArray(j) ? j : [j]; } catch (_) { return cParseLines(out); }
}
function cLabelMap(str) { const m = {}; for (const part of String(str || '').split(',')) { const i = part.indexOf('='); if (i > 0) m[part.slice(0, i)] = part.slice(i + 1); } return m; }
const C_PROJECT = 'com.docker.compose.project', C_SERVICE = 'com.docker.compose.service';

// Detect both engines + their compose flavours (legacy `docker-compose` vs the `docker compose` plugin).
ipcMain.handle('containers:detect', async () => {
  const probe = (cli, args) => containerRun(cli, args, { timeout: 6000 });
  const [dcli, dleg, dplug, pcli, pleg, pplug] = await Promise.all([
    probe('docker', ['--version']), probe('docker-compose', ['--version']), probe('docker', ['compose', 'version']),
    probe('podman', ['--version']), probe('podman-compose', ['--version']), probe('podman', ['compose', 'version']),
  ]);
  // Only treat output as a real version if the first line looks version-like — some shims
  // (e.g. a `docker-compose` redirect to the v2 plugin) print usage text with exit 0.
  const v = (r) => { const fl = cFirstLine(r.out); return r.ok && /v?\d+\.\d+/.test(fl) ? fl : null; };
  return {
    docker: { cli: v(dcli), compose: v(dleg), composePlugin: v(dplug) },
    podman: { cli: v(pcli), compose: v(pleg), composePlugin: v(pplug) },
  };
});

async function cListContainers(engine) {
  if (engine === 'docker') {
    const r = await containerRun('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 12000 });
    if (!r.ok) return { error: r.error };
    return { items: cParseLines(r.out).map((c) => { const L = cLabelMap(c.Labels);
      return { id: c.ID, name: c.Names, image: c.Image, state: String(c.State || '').toLowerCase(), status: c.Status, ports: c.Ports || '', project: L[C_PROJECT] || '', service: L[C_SERVICE] || '', dbKind: guessDbKind(c.Image, c.Ports), mqKind: guessMqKind(c.Image, c.Ports), webKind: guessWebKind(c.Image, c.Ports), storageKind: guessStorageKind(c.Image) }; }) };
  }
  const r = await containerRun('podman', ['ps', '-a', '--format', 'json'], { timeout: 12000 });
  if (!r.ok) return { error: r.error };
  return { items: cParseJson(r.out).map((c) => { const L = c.Labels || {};
    const name = Array.isArray(c.Names) ? c.Names[0] : (c.Names || c.Name || '');
    const ports = Array.isArray(c.Ports) ? c.Ports.map((p) => `${p.host_port || p.hostPort || ''}${(p.host_port || p.hostPort) ? ':' : ''}${p.container_port || p.containerPort || ''}`).filter((s) => s && s !== ':').join(', ') : '';
    return { id: c.Id || c.ID, name, image: c.Image, state: String(c.State || '').toLowerCase(), status: c.Status || c.State, ports, project: L[C_PROJECT] || L['io.podman.compose.project'] || '', service: L[C_SERVICE] || '', dbKind: guessDbKind(c.Image, ports), mqKind: guessMqKind(c.Image, ports), webKind: guessWebKind(c.Image, ports), storageKind: guessStorageKind(c.Image) }; }) };
}
async function cListPods() {
  const r = await containerRun('podman', ['pod', 'ps', '--format', 'json'], { timeout: 10000 });
  if (!r.ok) return { error: r.error };
  return { items: cParseJson(r.out).map((p) => ({ id: p.Id || p.ID, name: p.Name, status: String(p.Status || '').toLowerCase(), containers: Array.isArray(p.Containers) ? p.Containers.length : (p.NumberOfContainers || 0) })) };
}
async function cListImages(engine) {
  const fmt = engine === 'docker' ? '{{json .}}' : 'json';
  const r = await containerRun(engine, ['images', '--format', fmt], { timeout: 12000 });
  if (!r.ok) return { error: r.error };
  if (engine === 'docker') return { items: cParseLines(r.out).map((i) => ({ id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince })) };
  // podman repeats the full Names[] across several entries sharing one Id, so taking Names[0] yields
  // duplicate identical rows and hides extra tags. Expand to one row per repo:tag, dedup by Id|name.
  const seen = new Set(), items = [];
  for (const i of cParseJson(r.out)) {
    const names = Array.isArray(i.Names) ? i.Names : (Array.isArray(i.RepoTags) ? i.RepoTags : []);
    const id = String(i.Id || i.ID || '');
    for (const full of (names.length ? names : ['<none>:<none>'])) {
      const key = id + '|' + full; if (seen.has(key)) continue; seen.add(key);
      const ci = full.lastIndexOf(':'); const repo = ci > 0 ? full.slice(0, ci) : full; const tag = ci > 0 ? full.slice(ci + 1) : '';
      items.push({ id: id.slice(0, 12), repo, tag, size: cHumanSize(i.Size), created: cImgCreated(i) });
    }
  }
  return { items };
}
async function cListVolumes(engine) {
  const fmt = engine === 'docker' ? '{{json .}}' : 'json';
  const r = await containerRun(engine, ['volume', 'ls', '--format', fmt], { timeout: 10000 });
  if (!r.ok) return { error: r.error };
  const raw = engine === 'docker' ? cParseLines(r.out) : cParseJson(r.out);
  return { items: raw.map((vo) => ({ name: vo.Name, driver: vo.Driver || '' })) };
}
async function cListDf(engine) { // disk usage per object type (`system df`)
  const fmt = engine === 'docker' ? '{{json .}}' : 'json';
  const r = await containerRun(engine, ['system', 'df', '--format', fmt], { timeout: 12000 });
  if (!r.ok) return { error: r.error };
  const raw = engine === 'docker' ? cParseLines(r.out) : cParseJson(r.out);
  const out = {};
  for (const row of raw) {
    const t = String(row.Type || '').toLowerCase();
    if (t.includes('image')) out.images = row.Size;
    else if (t.includes('container')) out.containers = row.Size;
    else if (t.includes('volume')) out.volumes = row.Size;
    else if (t.includes('build') || t.includes('cache')) out.cache = row.Size;
  }
  return out;
}
ipcMain.handle('containers:list', async (_e, { engine, light } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
  // Удалённый контекст: SSH мог мигнуть и унести туннель (ssh.on('close') прибирает запись) —
  // самовосстановление на ближайшем полле, чтобы не заставлять пользователя перевыбирать хост.
  if (containersRemote && !rhApi.tunnelAlive(containersRemote.tunId)) {
    // Переподнимаем ОДИН раз на всех: список запрашивает и опрос (раз в 3 с), и кнопка «Обновить»,
    // а коннект по SSH идёт секундами — без этой защёлки каждый вызов, пришедший за время
    // переподключения, поднимал бы свой туннель. Запись хранит только последний, остальные
    // оставались бы висеть навсегда: живое SSH-соединение и занятый локальный порт.
    if (!containersTunnelFix) {
      const rc = containersRemote;
      containersTunnelFix = rhApi.sockTunnel(rc.rhId, rc.sockPath, 'containers: ' + rc.name)
        .then((t) => { if (t.ok && containersRemote === rc) { rc.tunId = t.tunId; rc.port = t.port; } return t; })
        .finally(() => { containersTunnelFix = null; });
    }
    const t = await containersTunnelFix;
    if (!t.ok) return { containers: { error: `SSH-туннель к «${containersRemote.name}» оборвался и не восстановился: ` + (t.error || '') } };
  }
  // Light path = the live poll: only the fast, frequently-changing data (containers + pods). Skips the heavy
  // `system df` (storage scan, ~1s) and images/volumes so a 3s poll doesn't churn the disk. The renderer
  // reconciles only the sections present in the reply, leaving the rest as last rendered by a full fetch.
  if (light) {
    if (engine === 'podman') {
      const [containers, pods] = await Promise.all([cListContainers(engine), cListPods()]);
      return { containers, pods };
    }
    return { containers: await cListContainers(engine) };
  }
  const [containers, images, volumes, pods, df] = await Promise.all([
    cListContainers(engine), cListImages(engine), cListVolumes(engine),
    engine === 'podman' ? cListPods() : Promise.resolve({ items: [] }),
    cListDf(engine),
  ]);
  return { containers, images, volumes, pods, df };
});
// Bulk action over a list of container ids (a compose group). Applies sequentially, collecting errors.
ipcMain.handle('containers:bulk', async (_e, { engine, action, ids } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'no ids' };
  const verb = { start: ['start'], stop: ['stop'], pause: ['pause'], unpause: ['unpause'], restart: ['restart'], remove: ['rm', '-f'] }[action];
  if (!verb) return { ok: false, error: 'bad action' };
  const failed = [];
  for (const id of ids) { if (typeof id !== 'string') continue; const r = await containerRun(engine, [...verb, id], { timeout: 60000 }); if (!r.ok) failed.push(r.error); }
  return failed.length ? { ok: false, error: failed.join('; ') } : { ok: true };
});

// --- container logs (streamed) and interactive exec (PTY) for the detail view
const cLogProcs = new Map();  // streamId -> ChildProcess (logs -f)
const cExecPtys = new Map();  // execId   -> IPty (exec -it)
ipcMain.handle('containers:logsStart', (e, { engine, id, streamId, tail } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
  if (!id || !streamId) return { error: 'bad args' };
  let cp;
  const lctx = cRemoteCtx(engine); // удалённый контекст: стрим логов тоже через туннель к сокету
  try { cp = spawn(lctx.cli, ['logs', '-f', '--tail', String(Math.max(1, Math.min(5000, parseInt(tail, 10) || 500))), id], { windowsHide: true, env: lctx.env }); }
  catch (e2) { return { error: String(e2.message || e2) }; }
  const sender = e.sender; // окно-владелец (редактор ИЛИ окно модуля «Контейнеры») — стрим уходит туда
  const send = (d) => safeSend(sender, 'containers:logsData', { streamId, data: d.toString('utf8') });
  cp.stdout.on('data', send); cp.stderr.on('data', send);
  cp.on('error', (err) => send('\n[ошибка logs: ' + (err.message || err) + ']\n'));
  cp.on('close', () => { cLogProcs.delete(streamId); safeSend(sender, 'containers:logsExit', { streamId }); });
  cLogProcs.set(streamId, cp);
  return { ok: true };
});
ipcMain.on('containers:logsStop', (_e, { streamId } = {}) => { const cp = cLogProcs.get(streamId); if (cp) { try { cp.kill(); } catch (_) {} cLogProcs.delete(streamId); } });
ipcMain.handle('containers:execStart', (e, { engine, id, execId, cols, rows } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
  if (!id || !execId) return { error: 'bad args' };
  let proc;
  const xctx = cRemoteCtx(engine, userShellEnv()); // удалённый контекст: exec-терминал через туннель к сокету
  try {
    proc = pty.spawn(xctx.cli, ['exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
      { name: 'xterm-color', cols: cols || 80, rows: rows || 24, env: xctx.env || userShellEnv() });
  } catch (e2) { return { error: String(e2.message || e2) }; }
  const sender = e.sender; // окно-владелец exec-терминала
  proc.onData((d) => safeSend(sender, 'containers:execData', { execId, data: d }));
  proc.onExit(() => { cExecPtys.delete(execId); safeSend(sender, 'containers:execExit', { execId }); });
  cExecPtys.set(execId, proc);
  return { ok: true };
});
ipcMain.on('containers:execWrite', (_e, { execId, data } = {}) => { const p = cExecPtys.get(execId); if (p) p.write(data); });
ipcMain.on('containers:execResize', (_e, { execId, cols, rows } = {}) => { const p = cExecPtys.get(execId); if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} } });
ipcMain.on('containers:execKill', (_e, { execId } = {}) => { const p = cExecPtys.get(execId); if (p) { try { p.kill(); } catch (_) {} cExecPtys.delete(execId); } });
// Lifecycle action on one object. action/kind are whitelisted; id is a CLI arg (execFile, no shell).
ipcMain.handle('containers:action', async (_e, { engine, kind, action, id } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  let args = null;
  if (kind === 'container') args = ({ start: ['start', id], stop: ['stop', id], pause: ['pause', id], unpause: ['unpause', id], restart: ['restart', id], remove: ['rm', '-f', id] })[action];
  else if (kind === 'pod') args = ({ start: ['pod', 'start', id], stop: ['pod', 'stop', id], remove: ['pod', 'rm', '-f', id] })[action];
  else if (kind === 'image' && action === 'remove') args = ['rmi', '-f', id];
  else if (kind === 'volume' && action === 'remove') args = ['volume', 'rm', id];
  if (!args) return { ok: false, error: 'bad action' };
  const r = await containerRun(engine, args, { timeout: 60000 });
  return { ok: r.ok, error: r.error };
});

// «Открыть в модуле БД»: inspect контейнера → заготовка подключения (тип/хост-порт/лог/пас/база).
// Разбор — в lib/dbdetect.js; пароль берётся из env контейнера (он и так виден любому с доступом к CLI).
ipcMain.handle('containers:inspectDb', async (_e, { engine, id } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error };
  const info = cParseJson(r.out)[0];
  if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
  const res = dbPrefillFromInspect(info, engine);
  if (!res) return { ok: false, error: 'В контейнере не распознана поддерживаемая БД (PostgreSQL / MySQL / MariaDB)' };
  // Удалённый контекст: 127.0.0.1:<port> префилла — это loopback УДАЛЁННОГО хоста, отсюда так не достучаться.
  // Обогащаем заготовку SSH-туннелем модуля БД из rh-профиля; шифроблобы секретов совместимы (одна схема
  // safeStorage v1:), поэтому пароль/ключ переезжают зашифрованными, без плейнтекста через рендерер.
  if (containersRemote) {
    const conn = rhApi.findConn(containersRemote.rhId);
    if (conn) {
      const p = res.prefill;
      p.name += ' @ ' + (conn.name || conn.host);
      p.source = 'rh:' + containersRemote.rhId + ':' + p.source; // дедуп не пересекается с тем же контейнером локально
      p.sshEnabled = true; p.sshHost = conn.host; p.sshPort = +conn.port || 22; p.sshUser = conn.user || '';
      if (conn.auth === 'key') { p.sshKeyEnc = conn.keyEnc || ''; p.sshPassEnc = conn.passphraseEnc || ''; }
      else if (conn.auth !== 'agent') p.sshPassEnc = conn.passEnc || '';
      // auth 'agent': секретов нет — lib/db.js openTunnel сам падает назад на ssh-agent/дефолтные ключи
    }
  }
  return { ok: true, ...res };
});
// «Открыть в модуле RabbitMQ»: inspect контейнера → заготовка профиля (management-порт/лог/пас/vhost).
// «Открыть в модуле Внешние хранилища»: inspect MinIO-контейнера → заготовка S3-подключения.
ipcMain.handle('containers:inspectStorage', async (_e, { engine, id } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error };
  const info = cParseJson(r.out)[0];
  if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
  const res = storagePrefillFromInspect(info, engine);
  if (!res) return { ok: false, error: 'В контейнере не распознано S3-хранилище (MinIO)' };
  return { ok: true, ...res };
});
ipcMain.handle('containers:inspectMq', async (_e, { engine, id } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error };
  const info = cParseJson(r.out)[0];
  if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
  const res = rmqPrefillFromInspect(info, engine);
  if (!res) return { ok: false, error: 'В контейнере не распознан RabbitMQ' };
  return { ok: true, ...res };
});
// «Открыть в модуле Kafka»: inspect контейнера → заготовка профиля (брокер = 127.0.0.1:порт).
ipcMain.handle('containers:inspectKafka', async (_e, { engine, id } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error };
  const info = cParseJson(r.out)[0];
  if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
  const res = kafkaPrefillFromInspect(info, engine);
  if (!res) return { ok: false, error: 'В контейнере не распознан Kafka' };
  return { ok: true, ...res };
});
// «Наблюдать в Мониторинге сайтов»: inspect контейнера → URL веб-интерфейса по published-порту.
ipcMain.handle('containers:inspectWeb', async (_e, { engine, id } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error };
  const info = cParseJson(r.out)[0];
  if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
  const res = webPrefillFromInspect(info, engine);
  if (!res) return { ok: false, error: 'В контейнере не распознан веб-сервис' };
  return { ok: true, ...res };
});
// Файлы контейнера: листинг и просмотр через `exec ls/cat` (без шелла на нашей стороне —
// execFile передаёт путь одним аргументом). Работает только на запущенном контейнере,
// внутри должен быть ls/cat (busybox достаточно; distroless честно вернёт ошибку).
ipcMain.handle('containers:fsList', async (_e, { engine, id, path: p } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string') return { ok: false, error: 'no id' };
  const dir = String(p || '/');
  const r = await containerRun(engine, ['exec', id, 'ls', '-1Ap', dir], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error || 'ls не выполнился (контейнер запущен?)' };
  const entries = [];
  for (const ln of r.out.split('\n')) {
    const name = ln.trim(); if (!name) continue;
    const isDir = name.endsWith('/');
    entries.push({ name: isDir ? name.slice(0, -1) : name, dir: isDir });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
  return { ok: true, path: dir, entries };
});
ipcMain.handle('containers:fsOpenInViewer', async (_e, { engine, id, path: p } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
  if (!id || typeof id !== 'string' || !p) return { ok: false, error: 'no id/path' };
  const r = await containerRun(engine, ['exec', id, 'cat', String(p)], { timeout: 15000 });
  if (!r.ok) return { ok: false, error: r.error || 'cat не выполнился (контейнер запущен?)' };
  if (r.out.length > MAX_VIEW_BYTES) return { ok: false, error: 'Файл слишком большой для просмотра (> 2 МБ)' };
  if (r.out.slice(0, 8192).includes('\0')) return { ok: false, error: 'Бинарный файл — просмотр не поддерживается' };
  try {
    const file = stageTextForViewer(String(p).split('/').filter(Boolean).pop() || 'container.txt', r.out);
    routeOpenInViewer({ path: file });
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('shell:openPath', (_e, target) => {
  // shell.openPath на Linux ждёт завершения xdg-open: «холодный» запуск файлового
  // менеджера/браузера может тянуться дольше, чем живёт окно IPC-ответа, и Electron
  // отклоняет invoke с "reply was never sent" (в рендерере — ложный error-тост, хотя
  // открытие по факту прошло). Поэтому отвечаем сразу, а реальную ошибку открытия
  // (если будет) логируем отдельно. Все вызовы из рендерера — fire-and-forget, error-строку
  // никто не читает, так что семантика не теряется.
  Promise.resolve(shell.openPath(String(target == null ? '' : target)))
    .then((err) => { if (err) logger.log('warn', 'shell', `openPath: ${err}`); })
    .catch((e) => logger.log('error', 'shell', 'openPath threw', e));
  return { ok: true };
});
ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url))) return { error: 'bad url' };
  try { await shell.openExternal(url); return { ok: true }; } catch (e) { return { error: String(e) }; }
});
// Открыть локальный файл в браузере по умолчанию (как «Open in Browser» в IDE). Отдельный канал
// от shell:openExternal: тот принимает только http(s); здесь валидируем существующий файл и формируем
// file://-URL (shell.openExternal с file:// уходит именно в браузер, в отличие от openPath = приложение по умолчанию).
ipcMain.handle('shell:openInBrowser', async (_e, target) => {
  try {
    const p = String(target == null ? '' : target);
    if (!p || !fs.existsSync(p)) return { error: 'файл не найден' };
    let u = p.replace(/\\/g, '/'); if (!u.startsWith('/')) u = '/' + u;
    const url = 'file://' + encodeURI(u).replace(/%(?![0-9A-Fa-f]{2})/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) { return { error: String(e) }; }
});
// Показать файл в системном файловом менеджере с выделением (reveal-in-folder, как в IDE).
// Отличается от shell:openPath: тот открыл бы файл приложением по умолчанию, а здесь — открываем
// каталог и подсвечиваем сам файл (shell.showItemInFolder).
ipcMain.handle('shell:showItemInFolder', (_e, target) => {
  try {
    const p = String(target == null ? '' : target);
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'файл не найден' };
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
// Положить сам ФАЙЛ в системный буфер обмена, чтобы его можно было вставить (Ctrl+V) в файловом
// менеджере как копию. Нативного «copy file» в Electron нет — используем форматы буфера, понятные
// файловым менеджерам: Linux/GNOME (Nautilus) — x-special/gnome-copied-files, macOS — public.file-url.
// На Windows и прочих такого формата нет → кладём путь текстом (mode:'path'), фронт честно сообщает.
ipcMain.handle('shell:copyFile', (_e, target) => {
  try {
    const p = String(target == null ? '' : target);
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'файл не найден' };
    const fileUrl = require('url').pathToFileURL(p).href;
    if (process.platform === 'linux') {
      clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from('copy\n' + fileUrl, 'utf8'));
      return { ok: true, mode: 'file' };
    }
    if (process.platform === 'darwin') {
      clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'));
      return { ok: true, mode: 'file' };
    }
    clipboard.writeText(p);
    return { ok: true, mode: 'path' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text == null ? '' : text)));
ipcMain.handle('clipboard:read', () => clipboard.readText());
