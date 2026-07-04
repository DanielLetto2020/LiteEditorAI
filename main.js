// LiteEditor — Electron main process.
// Thin backend: project picker, PTY lifecycle, file ops, window controls.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, Tray, nativeImage, crashReporter, safeStorage, Notification } = require('electron');
const dbBackend = require('./lib/db');
const rhBackend = require('./lib/remotehost');
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
const { pathToFileURL } = require('url');
const pty = require('node-pty');
// Headless-xterm: на каждую сессию держим «теневой» терминал, который потребляет тот же
// поток PTY. Пульту по сети идёт НЕ байтовый ANSI-стрим, а «проекция экрана» (принцип mosh):
// видимый экран теневого терминала как простой текст + line-диффы (см. mirrorScreen и
// движок кадров в remote.js). Сколько бы перерисовок ни делал TUI-агент, по сети уходит
// только итоговое состояние. Пакет — pure-JS, нативных зависимостей нет.
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const logger = require('./logger');
const remote = require('./remote'); // удалённый пульт (вкл. только при env LITE_REMOTE=1)
const { safeChildName } = require('./lib/safe-name'); // анти-traversal для имён (в т.ч. с пульта)
const { resolveShell: resolveShellPure } = require('./lib/shell'); // выбор оболочки терминала
const sgrline = require('./lib/sgrline'); // стилизованные строки кадра пульта (цвета как мини-SGR)

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
const ptySize = new Map();  // sessionId -> { cols, rows } — текущий размер PTY (для пульта)
const mirrors = new Map();  // sessionId -> { term: HeadlessTerminal } — теневой терминал для пульта
const MIRROR_SCROLLBACK = 20000;

// --- Теневой терминал сессии (источник кадров «проекции экрана» для пульта) -----
function mirrorCreate(id, cols, rows) {
  mirrorDispose(id);
  try {
    const term = new HeadlessTerminal({
      cols: cols || 80, rows: rows || 24, scrollback: MIRROR_SCROLLBACK, allowProposedApi: true,
    });
    mirrors.set(id, { term });
  } catch (e) { logger.log('warn', 'mirror', 'create failed', e && e.message); }
}
function mirrorWrite(id, data) { const m = mirrors.get(id); if (m) { try { m.term.write(data); } catch (_) {} } }
function mirrorResize(id, cols, rows) { const m = mirrors.get(id); if (m && cols > 0 && rows > 0) { try { m.term.resize(cols, rows); } catch (_) {} } }
function mirrorDispose(id) { const m = mirrors.get(id); if (m) { try { m.term.dispose(); } catch (_) {} mirrors.delete(id); } }
// Видимый экран сессии как простой текст: массив строк + курсор + флаг alt-буфера.
// Это весь «снапшот», который нужен пульту, — ~5КБ вместо мегабайтного serialize().
// styled (пульт попросил в select) → строки с цветами/атрибутами как мини-SGR
// (lib/sgrline.js; строки остаются строками — диффер в remote.js не меняется) +
// curIdx: индекс курсора В ПЛОСКОМ ТЕКСТЕ строки курсора. cursorX — в ЯЧЕЙКАХ, а
// wide-символы (эмодзи/CJK) занимают 2 ячейки при .length 1-2 — пульту ширины ячеек
// не видны, поэтому индекс считаем здесь, где они известны точно.
function mirrorScreen(id, styled) {
  const m = mirrors.get(id);
  if (!m) return null;
  try {
    const term = m.term;
    const buf = term.buffer.active;
    const lines = [];
    if (!styled) {
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.baseY + y);
        lines.push(line ? line.translateToString(true) : '');
      }
      return {
        cols: term.cols, rows: term.rows, lines,
        cursor: [buf.cursorX, buf.cursorY],
        alt: buf.type === 'alternate',
      };
    }
    const cellObj = buf.getNullCell();
    let curIdx = -1;
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) { lines.push(''); continue; }
      const isCurY = (y === buf.cursorY);
      const cells = [];
      let plainLen = 0;   // длина плоского текста в JS-единицах (для curIdx)
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x, cellObj);
        if (!c) break;
        // курсор на continuation-ячейке wide-символа → индекс ПОСЛЕ самого символа
        if (isCurY && x === buf.cursorX) curIdx = plainLen;
        if (c.getWidth() === 0) continue;   // continuation wide-символа — не ячейка
        const ch = c.getChars() || ' ';
        let fg = -1, bg = -1;
        if (c.isFgRGB()) fg = sgrline.RGB | c.getFgColor();
        else if (c.isFgPalette()) fg = c.getFgColor();
        if (c.isBgRGB()) bg = sgrline.RGB | c.getBgColor();
        else if (c.isBgPalette()) bg = c.getBgColor();
        let fl = 0;
        if (c.isBold()) fl |= 1;
        if (c.isDim()) fl |= 2;
        if (c.isItalic()) fl |= 4;
        if (c.isUnderline()) fl |= 8;
        if (c.isInverse()) fl |= 16;
        cells.push({ ch, fg, bg, fl });
        plainLen += ch.length;
      }
      if (isCurY && curIdx === -1) curIdx = plainLen + Math.max(0, buf.cursorX - line.length);
      lines.push(sgrline.encodeLine(cells));
    }
    return {
      cols: term.cols, rows: term.rows, lines,
      cursor: [buf.cursorX, buf.cursorY], curIdx,
      alt: buf.type === 'alternate', styled: true,
    };
  } catch (_) { return null; }
}
// История для пульта = SCROLLBACK теневого терминала (строки, ушедшие выше видимого
// экрана normal-буфера). Раньше историю лепил stripped-ANSI транскрипт из сырого потока —
// у TUI-агентов каждая перерисовка добавлялась заново («кривые повторяющиеся символы»).
// Scrollback эмулирован честно: это ровно то, что видно при скролле в настоящем терминале.
function mirrorScrollback(id) {
  const m = mirrors.get(id);
  if (!m) return '';
  try {
    const buf = m.term.buffer.normal;
    const lines = [];
    for (let y = 0; y < buf.baseY; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  } catch (_) { return ''; }
}
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
const STORE_KEYS = ['projects', 'settings', 'layout', 'recents', 'lastParent', 'categories', 'sectionOrder', 'accordions', 'dismissed', 'uiState', 'projTabs', 'openrouter', 'remote', 'shares', 'pultBlocked', 'dockerUi', 'dbConnections', 'dbUi', 'rhConnections', 'rhUi', 'textproc', 'tpPrompts', 'extData', 'extEnabled', 'quickbar', 'seoTargets', 'seoSites', 'moduleWins', 'mwLeft', 'bookmarks', 'promptSnippets', 'pomodoro', 'pomodoroLog', 'dbaiProviders', 'sessionSnaps'];
// Папка-«стор» для шаринга с пультом (агент кладёт сюда файлы; в PTY доступна как $LITE_STORE).
const pultStoreDir = path.join(storeDir, 'store');
try { fs.mkdirSync(pultStoreDir, { recursive: true }); } catch (_) {}
// Разрешённые с пульта папки (shares). По умолчанию — только стор. Пользователь добавляет
// свои в Настройках; что добавить (хоть «/») — на его усмотрение и ответственность.
function getPultShares() {
  const raw = readStoreKey('shares');
  const user = (Array.isArray(raw) ? raw : []).filter((s) => s && s.path)
    .map((s) => ({ path: path.resolve(s.path), name: s.name || path.basename(s.path) || s.path }));
  const out = [{ path: pultStoreDir, name: 'Стор' }];   // стор доступен всегда
  const seen = new Set([pultStoreDir]);
  for (const s of user) if (!seen.has(s.path)) { seen.add(s.path); out.push(s); }
  return out;
}
// Путь разрешён, только если он внутри одной из shares. Сверяем РЕАЛЬНЫЕ пути (realpath),
// иначе симлинк внутри шары (напр. store/evil → ~/.ssh) обошёл бы строковую проверку границы.
function resolveInShares(p) {
  let abs; try { abs = fs.realpathSync(path.resolve(p)); } catch (_) { return null; }
  for (const s of getPultShares()) {
    let base; try { base = fs.realpathSync(s.path); } catch (_) { continue; }
    if (abs === base || abs.startsWith(base + path.sep)) return abs;
  }
  return null;
}
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
function atomicWriteSync(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
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

// ── Реестр ошибок (errors ledger) ───────────────────────────────────────────────────────────
ipcMain.handle('errors:list', () => errledger.list());
ipcMain.handle('errors:setStatus', (_e, { id, status, note, commit } = {}) => errledger.setStatus(id, status, note, commit));
ipcMain.handle('errors:clearResolved', () => errledger.clearResolved());
ipcMain.handle('errors:setContext', (_e, projectPath) => { errledger.setContext(projectPath); return { ok: true }; });
// Изменения реестра (новые ошибки, правки статуса, ВНЕШНИЕ правки агентом) → живой UI.
errledger.onChange(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('errors:changed'); });
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
function safeSend(sender, channel, payload) {
  try { if (sender && !sender.isDestroyed()) sender.send(channel, payload); } catch (_) {}
}
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
// Update check: query the GitHub Releases API for the latest published release
// and return its tag/notes/url. Public repo → no token needed. The renderer
// compares the tag with APP_VERSION and shows an «update available» badge next
// to the version label. Never throws — resolves {error} so the UI degrades quietly.
const GH_REPO = 'DanielLetto2020/LiteEditorAI';
ipcMain.handle('update:check', async () => {
  return await new Promise((resolve) => {
    const req = https.request(
      `https://api.github.com/repos/${GH_REPO}/releases/latest`,
      { method: 'GET', headers: { 'User-Agent': 'LiteEditorAI', 'Accept': 'application/vnd.github+json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (res.statusCode >= 400) return resolve({ error: j.message || ('HTTP ' + res.statusCode) });
            resolve({ tag: j.tag_name || '', name: j.name || '', notes: j.body || '', url: j.html_url || '' });
          } catch (_) { resolve({ error: 'Не удалось разобрать ответ GitHub' }); }
        });
      },
    );
    req.on('error', (e) => resolve({ error: String(e.message || e) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'таймаут проверки обновления' }); });
    req.end();
  });
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
const tpDir = path.join(storeDir, 'textproc');
ipcMain.handle('tp:dir', () => { try { fs.mkdirSync(tpDir, { recursive: true }); } catch (_) {} return tpDir; });
// Обработка текста: нативные Открыть/Сохранить как (вместо браузерного File API/download — см. handoff design).
ipcMain.handle('tp:openFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
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
    if (stat.size > IMPORT_MAX_BYTES) return { ok: false, error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
    const content = fs.readFileSync(file, 'utf8');
    saveState({ lastOpenDir: path.dirname(file) });
    return { ok: true, file, name: path.basename(file), content };
  } catch (e) { return { ok: false, error: 'Не удалось прочитать файл: ' + String(e.message || e) }; }
});
ipcMain.handle('tp:saveFileAs', async (_e, { content, name, ext } = {}) => {
  const last = loadState().lastOpenDir;
  const base = String(name || 'Безымянный').replace(/[\/\\:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '');
  const res = await dialog.showSaveDialog(mainWindow, {
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
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Как звать CLI в неинтерактивном режиме и куда подавать промпт (stdin/arg).
const TP_AGENTS = {
  claude: { cmd: 'claude', args: ['-p', '--output-format', 'text'], via: 'stdin' },
  codex: { cmd: 'codex', args: ['exec'], via: 'arg' },
  antigravity: { cmd: '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity', args: ['chat', '-m', 'agent', '-'], via: 'stdin' }
};
// GUI-сессия часто не видит ~/.local/bin и nvm-bin → дополняем PATH, чтобы claude/codex нашлись.
function tpEnv() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.dirname(process.execPath)];
  return { ...process.env, PATH: extra.join(sep) + sep + (process.env.PATH || '') };
}
const tpReqs = new Map(); // reqId -> ChildProcess
ipcMain.on('tp:run', (e, { reqId, agent, prompt } = {}) => {
  const sender = e.sender;
  const conf = TP_AGENTS[agent] || TP_AGENTS.claude;
  const args = conf.via === 'arg' ? [...conf.args, prompt || ''] : [...conf.args];
  let child;
  try { child = pty.spawn(conf.cmd, args, { cwd: os.homedir(), env: tpEnv(), cols: 80, rows: 24 }); }
  catch (err) { safeSend(sender, 'tp:error', { reqId, error: 'не запустить «' + conf.cmd + '»: ' + (err.message || err) }); return; }
  tpReqs.set(reqId, child);
  let out = '';
  const to = setTimeout(() => { if (tpReqs.has(reqId)) { tpReqs.delete(reqId); try { child.kill(); } catch (_) {} safeSend(sender, 'tp:error', { reqId, error: 'таймаут (агент не ответил вовремя)' }); } }, 240000);
  child.onData((c) => { 
    const chunk = c.replace(/\x1b\[[0-9;]*m/g, ''); // strip ansi
    out += chunk; 
    safeSend(sender, 'tp:data', { reqId, chunk }); 
  });
  child.onExit(({ exitCode }) => {
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId); clearTimeout(to);
    
    // Attempt to strip echoed prompt if via stdin
    let text = out.trim();
    if (conf.via === 'stdin' && prompt) {
      const promptLines = prompt.split('\n');
      const firstLine = promptLines[0].trim();
      if (firstLine && text.includes(firstLine)) {
         const idx = text.indexOf('\x04');
         if (idx !== -1) text = text.substring(idx + 1).trim();
      }
    }
    
    if (text) safeSend(sender, 'tp:done', { reqId, text }); 
    else safeSend(sender, 'tp:error', { reqId, error: 'агент завершился с кодом ' + exitCode });
  });
  if (conf.via === 'stdin') { try { child.write((prompt || '') + '\r\n\x04'); } catch (_) {} }
});
ipcMain.on('tp:abort', (_e, { reqId } = {}) => {
  const c = tpReqs.get(reqId);
  if (c) { tpReqs.delete(reqId); try { c.kill(); } catch (_) {} }
});

// ---------------------------------------------------------------- AI-DB (read-only SQL chat)
// Streaming variant of tp:run for the «Базы данных» → AI-DB tab: the agent only AUTHORS SQL/text
// (it never touches the DB — the renderer executes read-only queries after explicit confirmation).
// We stream stdout chunks so the chat feels live. Stateless: the renderer re-sends the full
// transcript + schema each turn, so no agent-side session is needed.
// Claude streams real tokens with stream-json + partial messages; codex stays plain-text.
const DBAI_AGENTS = {
  claude: { cmd: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'], via: 'stdin', stream: 'json' },
  codex: { cmd: 'codex', args: ['exec'], via: 'arg', stream: 'text' },
};
const dbaiReqs = new Map();
// Глушит карту in-flight задач разом: значение — ChildProcess (.kill) или ClientRequest/сокет (.destroy).
function killReqMap(m) {
  for (const v of m.values()) { try { if (v && typeof v.kill === 'function') v.kill(); else if (v && typeof v.destroy === 'function') v.destroy(); } catch (_) {} }
  m.clear();
}
ipcMain.on('dbai:run', (e, { reqId, agent, prompt } = {}) => {
  const sender = e.sender;
  const conf = DBAI_AGENTS[agent] || DBAI_AGENTS.claude;
  const args = conf.via === 'arg' ? [...conf.args, prompt || ''] : [...conf.args];
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
  if (conf.via === 'stdin') { try { child.stdin.write(prompt || ''); child.stdin.end(); } catch (_) {} }
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
ipcMain.on('dbai:apiRun', (e, { reqId, baseUrl, key, model, prompt } = {}) => {
  const sender = e.sender;
  let u; try { u = new URL(String(baseUrl).replace(/\/$/, '') + '/chat/completions'); } catch (_) { safeSend(sender, 'dbai:error', { reqId, error: 'неверный адрес провайдера' }); return; }
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt || '' }], stream: true });
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
        try { const j = JSON.parse(payload); const ch = j.choices && j.choices[0]; const delta = ch && ch.delta && ch.delta.content; if (delta) { any = true; safeSend(sender, 'dbai:data', { reqId, chunk: delta }); } } catch (_) {}
      }
    });
    res.on('end', () => { if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); if (any) safeSend(sender, 'dbai:done', { reqId }); else safeSend(sender, 'dbai:error', { reqId, error: 'пустой ответ модели' }); });
  });
  req.on('error', (err) => { if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); safeSend(sender, 'dbai:error', { reqId, error: String(err.message || err) }); });
  req.setTimeout(300000, () => { req.destroy(); if (!dbaiReqs.has(reqId)) return; dbaiReqs.delete(reqId); safeSend(sender, 'dbai:error', { reqId, error: 'таймаут запроса' }); });
  dbaiReqs.set(reqId, req);
  req.write(body); req.end();
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

// ---------------------------------------------------------------- «Контекст» (граф контекста агента)
// Модуль renderer/modules/contextgraph.js: per-project граф блоков контекста (канва как n8n).
// Хранение: ~/.LiteEditorAI/contextgraph/{projects/<projId>/graph.json + blocks/*.md + seen-*.md,
// library/*.md + library.json}. Слоты агента — В ПРОЕКТЕ (<proj>/.lite/ctx-slot-<id>.md), агенту
// нужен прямой путь для записи. Компиляция: включённая часть графа → CLAUDE.md (Claude) /
// AGENTS.md (Codex) в корне проекта; существующий файл бекапится (папка/глубина — в настройках
// графа), чужой файл (без нашей шапки) без force не перезаписывается.
const ctxDir = path.join(storeDir, 'contextgraph');
const ctxSafe = (s) => String(s).replace(/[^\w.-]/g, '_');
const ctxProjDir = (projId) => path.join(ctxDir, 'projects', ctxSafe(projId));
const CTX_TARGETS = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };

// --- Профили per-agent: для каждого агента (claude/codex) свой набор независимых графов под
// agents/<agent>/. Индекс profiles.json {active, applied, list:[{id,name}]}; граф — profiles/<id>.json
// (ОДИН выход — этого агента). Точки восстановления (версии файла) — points.json + points/<id>.md.
// Текстовые блоки — общие на проект: blocks/<nodeId>.md (id уникальны). Без legacy-миграции: старый
// формат (graph.json / профили на проект) не читаем — новый стор начинается с чистого листа.
const CTX_AGENTS = ['claude', 'codex'];
const ctxAgentSafe = (a) => CTX_AGENTS.includes(a) ? a : 'claude';
function ctxAgentDir(projId, agent) { return path.join(ctxProjDir(projId), 'agents', ctxAgentSafe(agent)); }
function ctxBlocksDir(projId) { return path.join(ctxProjDir(projId), 'blocks'); }
function ctxProfilesFile(projId, agent) { return path.join(ctxAgentDir(projId, agent), 'profiles.json'); }
function ctxProfileGraphFile(projId, agent, pid) { return path.join(ctxAgentDir(projId, agent), 'profiles', ctxSafe(pid) + '.json'); }
function ctxPointsFile(projId, agent) { return path.join(ctxAgentDir(projId, agent), 'points.json'); }
function ctxPointFile(projId, agent, ptid) { return path.join(ctxAgentDir(projId, agent), 'points', ctxSafe(ptid) + '.md'); }
// Дефолт держим в памяти; на диск падает при первом действии/сборке (иначе плодили бы пустые файлы).
function ctxLoadProfiles(projId, agent) {
  try { const ix = JSON.parse(fs.readFileSync(ctxProfilesFile(projId, agent), 'utf8')); if (ix && Array.isArray(ix.list) && ix.list.length) return ix; } catch (_) {}
  return { active: 'p1', applied: null, list: [{ id: 'p1', name: 'Профиль 1' }] };
}
function ctxSaveProfiles(projId, agent, ix) { fs.mkdirSync(ctxAgentDir(projId, agent), { recursive: true }); atomicWriteSync(ctxProfilesFile(projId, agent), JSON.stringify(ix)); }
function ctxResolveProfileId(projId, agent, profileId) {
  const ix = ctxLoadProfiles(projId, agent);
  const has = (id) => ix.list.some((p) => p.id === id);
  return (profileId && has(profileId)) ? profileId : (has(ix.active) ? ix.active : ix.list[0].id);
}
function ctxActiveGraphFile(projId, agent, profileId) { return ctxProfileGraphFile(projId, agent, ctxResolveProfileId(projId, agent, profileId)); }
// Контент текстовой ноды — общий на проект: blocks/<id>.md. (file/cmd/slot/lib временно отключены.)
function ctxNodeFile(projId, projPath, node) {
  if (!node || node.type !== 'text') return null;
  return path.join(ctxBlocksDir(projId), ctxSafe(node.id) + '.md');
}
function ctxReadFileSafe(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } }
// --- Точки восстановления (версии файла агента) ----------------------------------------------
function ctxLoadPoints(projId, agent) {
  try { const p = JSON.parse(fs.readFileSync(ctxPointsFile(projId, agent), 'utf8')); if (p && Array.isArray(p.list)) return p; } catch (_) {}
  return { list: [] };
}
function ctxSavePoints(projId, agent, p) { fs.mkdirSync(ctxAgentDir(projId, agent), { recursive: true }); atomicWriteSync(ctxPointsFile(projId, agent), JSON.stringify(p)); }
function ctxAddPoint(projId, agent, name, content, locked) {
  const p = ctxLoadPoints(projId, agent);
  const id = 'pt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  fs.mkdirSync(path.dirname(ctxPointFile(projId, agent, id)), { recursive: true });
  atomicWriteSync(ctxPointFile(projId, agent, id), String(content == null ? '' : content));
  p.list.push({ id, name: String(name || 'Версия').slice(0, 60), ts: Date.now(), locked: !!locked, chars: String(content || '').length });
  ctxSavePoints(projId, agent, p);
  return { id, list: p.list };
}

ipcMain.handle('ctx:load', (_e, { projId, agent, profileId } = {}) => {
  if (!projId) return { error: 'no projId' };
  // битый/отсутствующий граф профиля → null: канва стартует с чистого графа, не роняя панель
  try { return { graph: JSON.parse(fs.readFileSync(ctxActiveGraphFile(projId, agent, profileId), 'utf8')) }; } catch (_) { return { graph: null }; }
});
ipcMain.handle('ctx:save', (_e, { projId, agent, graph, profileId } = {}) => {
  if (!projId || !graph) return { error: 'bad args' };
  try { const f = ctxActiveGraphFile(projId, agent, profileId); fs.mkdirSync(path.dirname(f), { recursive: true }); atomicWriteSync(f, JSON.stringify(graph)); return { ok: true }; }
  catch (e) { return { error: String(e.message || e) }; }
});
// Управление профилями (индекс persist-ится сразу — это метаданные, не контент графа)
ipcMain.handle('ctx:profiles', (_e, { projId, agent } = {}) => { if (!projId) return { error: 'no projId' }; return ctxLoadProfiles(projId, agent); });
// fromId → клон профиля: глубокая копия графа с новыми id нод + копией файлов блоков (профили независимы)
ipcMain.handle('ctx:profileCreate', (_e, { projId, agent, name, fromId } = {}) => {
  if (!projId) return { error: 'no projId' };
  const ag = ctxAgentSafe(agent);
  const ix = ctxLoadProfiles(projId, ag);
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  if (fromId) {
    try {
      const src = JSON.parse(fs.readFileSync(ctxProfileGraphFile(projId, ag, fromId), 'utf8'));
      const clone = JSON.parse(JSON.stringify(src));
      const map = new Map(); let i = 0;
      for (const n of (clone.nodes || [])) {
        if (n.type === 'out') { map.set(n.id, n.id); continue; }
        const nid = 'n' + Date.now().toString(36) + (i++).toString(36) + Math.random().toString(36).slice(2, 4);
        map.set(n.id, nid);
        if (n.type === 'text') {
          try {
            const sf = path.join(ctxBlocksDir(projId), ctxSafe(n.id) + '.md');
            if (fs.existsSync(sf)) { fs.mkdirSync(ctxBlocksDir(projId), { recursive: true }); fs.copyFileSync(sf, path.join(ctxBlocksDir(projId), ctxSafe(nid) + '.md')); }
          } catch (_) {}
        }
        n.id = nid;
      }
      clone.edges = (clone.edges || []).map((e) => ({ from: map.get(e.from) || e.from, to: map.get(e.to) || e.to }));
      const f = ctxProfileGraphFile(projId, ag, id); fs.mkdirSync(path.dirname(f), { recursive: true }); atomicWriteSync(f, JSON.stringify(clone));
    } catch (e) { return { error: 'клон не удался: ' + (e.message || e) }; }
  }
  ix.list.push({ id, name: (String(name || '').trim() || ('Профиль ' + (ix.list.length + 1))).slice(0, 40) });
  ix.active = id;
  ctxSaveProfiles(projId, ag, ix);
  return { ok: true, id, profiles: ix };
});
ipcMain.handle('ctx:profileRename', (_e, { projId, agent, id, name } = {}) => {
  if (!projId || !id) return { error: 'bad args' };
  const ix = ctxLoadProfiles(projId, agent);
  const p = ix.list.find((x) => x.id === id); if (!p) return { error: 'no profile' };
  p.name = (String(name || '').trim() || p.name).slice(0, 40);
  ctxSaveProfiles(projId, agent, ix);
  return { ok: true, profiles: ix };
});
ipcMain.handle('ctx:profileDelete', (_e, { projId, agent, id } = {}) => {
  if (!projId || !id) return { error: 'bad args' };
  const ix = ctxLoadProfiles(projId, agent);
  if (ix.list.length <= 1) return { error: 'нельзя удалить последний профиль' };
  ix.list = ix.list.filter((x) => x.id !== id);
  if (ix.active === id) ix.active = ix.list[0].id;
  if (ix.applied === id) ix.applied = null; // применённый профиль удалён — пометку снимаем
  ctxSaveProfiles(projId, agent, ix);
  try { fs.rmSync(ctxProfileGraphFile(projId, agent, id), { force: true }); } catch (_) {} // блоки осиротевших нод не чистим (мелкие файлы)
  return { ok: true, profiles: ix };
});
ipcMain.handle('ctx:profileSetActive', (_e, { projId, agent, id } = {}) => {
  if (!projId || !id) return { error: 'bad args' };
  const ix = ctxLoadProfiles(projId, agent);
  if (!ix.list.some((x) => x.id === id)) return { error: 'no profile' };
  ix.active = id;
  ctxSaveProfiles(projId, agent, ix);
  return { ok: true, profiles: ix };
});
// --- Точки восстановления (версии файла агента): список / чтение / создание / удаление / снимок #0
ipcMain.handle('ctx:points', (_e, { projId, agent } = {}) => { if (!projId) return { error: 'no projId' }; return ctxLoadPoints(projId, agent); });
ipcMain.handle('ctx:pointRead', (_e, { projId, agent, id } = {}) => {
  const t = ctxReadFileSafe(ctxPointFile(projId, agent, id));
  return { text: t == null ? '' : t, exists: t != null, chars: t ? t.length : 0 };
});
ipcMain.handle('ctx:pointDelete', (_e, { projId, agent, id } = {}) => {
  const p = ctxLoadPoints(projId, agent);
  const pt = p.list.find((x) => x.id === id); if (!pt) return { error: 'нет точки' };
  if (pt.locked) return { error: 'нельзя удалить «Оригинал»' };
  p.list = p.list.filter((x) => x.id !== id); ctxSavePoints(projId, agent, p);
  try { fs.rmSync(ctxPointFile(projId, agent, id), { force: true }); } catch (_) {}
  return { ok: true, list: p.list };
});
// Сделать любую версию «Оригиналом» (🔒): прежний оригинал теряет замок и переименовывается
// (становится обычной удаляемой версией). Оригинал устаревает со временем — так его можно обновить.
ipcMain.handle('ctx:pointSetOriginal', (_e, { projId, agent, id } = {}) => {
  if (!projId || !id) return { error: 'bad args' };
  const p = ctxLoadPoints(projId, agent);
  const target = p.list.find((x) => x.id === id); if (!target) return { error: 'нет версии' };
  if (target.locked) return { ok: true, list: p.list, already: true };
  for (const pt of p.list) {
    if (pt.locked) { pt.locked = false; if (pt.name === 'Оригинал') pt.name = 'Снимок ' + new Date(pt.ts || Date.now()).toISOString().slice(0, 16).replace('T', ' '); }
  }
  target.locked = true; target.name = 'Оригинал';
  ctxSavePoints(projId, agent, p);
  return { ok: true, list: p.list };
});
// Снимок #0 «Оригинал» из живого файла — один раз, пока точек ещё нет
ipcMain.handle('ctx:snapshotOriginal', (_e, { projId, projPath, agent } = {}) => {
  if (!projId || !projPath) return { error: 'bad args' };
  const p = ctxLoadPoints(projId, agent);
  if (p.list.length) return { ok: true, list: p.list, already: true };
  const content = ctxReadFileSafe(path.join(projPath, CTX_TARGETS[ctxAgentSafe(agent)]));
  if (content == null) return { ok: true, list: p.list, empty: true }; // файла нет — оригинала нет
  return { ok: true, ...ctxAddPoint(projId, agent, 'Оригинал', content, true) };
});
ipcMain.handle('ctx:blockRead', (_e, { projId, projPath, node } = {}) => {
  const f = ctxNodeFile(projId, projPath, node);
  if (!f) return { error: 'bad node' };
  const text = ctxReadFileSafe(f);
  return { text: text == null ? '' : text, exists: text != null, chars: text ? text.length : 0, file: f };
});
ipcMain.handle('ctx:blockWrite', (_e, { projId, projPath, node, text } = {}) => {
  const f = ctxNodeFile(projId, projPath, node);
  if (!f) return { error: 'bad node' };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    atomicWriteSync(f, String(text == null ? '' : text));
    return { ok: true, chars: String(text == null ? '' : text).length };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('ctx:blockDelete', (_e, { projId, projPath, node } = {}) => {
  if (node && node.type === 'text') { try { fs.rmSync(ctxNodeFile(projId, projPath, node), { force: true }); } catch (_) {} }
  return { ok: true };
});

// Бекап существующего файла перед перезаписью/распилом + прунинг (держим keep свежих на имя).
// Дефолтная папка — В ПРОЕКТЕ: <proj>/context_project_bkp (пользователь может сменить в настройках).
const CTX_BKP_DEFAULT = 'context_project_bkp';
function ctxBackupDirFor(projPath, settings) {
  return (settings && settings.backupDir) ? String(settings.backupDir) : path.join(projPath, CTX_BKP_DEFAULT);
}
function ctxBackup(file, settings, projPath) {
  const dir = ctxBackupDirFor(projPath, settings);
  const keep = Math.max(1, Math.min(100, parseInt(settings && settings.backupKeep, 10) || 10));
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(file);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = path.join(dir, name + '.' + ts + '.bak');
  fs.copyFileSync(file, dst);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith(name + '.') && f.endsWith('.bak'))
    .map((f) => { try { return { f, m: fs.statSync(path.join(dir, f)).mtimeMs }; } catch (_) { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m);
  for (const o of all.slice(keep)) { try { fs.rmSync(path.join(dir, o.f), { force: true }); } catch (_) {} }
  return dst;
}
// Быстрый хэш строки (для детекта «файл изменён вне модуля»): значение + длина.
function ctxHash(s) { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return h + ':' + str.length; }
// Собрать содержимое файла-выхода агента из графа — общая логика для compile и экспорта.
// Обход pre-order (родитель→дети, сиблинги по y,x). Группа-обёртка прозрачна (только дети);
// группа-текст (с .head) пишет свой заголовок, затем детей. → { content|null, charsByNode }.
function ctxAssemble(graph, projId, projPath, ag) {
  const charsByNode = {};
  const outNode = (graph.nodes || []).find((n) => n.type === 'out' && n.out === ag);
  if (!outNode || !outNode.enabled) return { content: null, charsByNode };
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const childrenOf = (id) => (graph.edges || []).filter((e) => e.to === id).map((e) => byId.get(e.from))
    .filter((n) => n && n.enabled).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const parts = []; const seen = new Set();
  (function visit(id) {
    for (const n of childrenOf(id)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (n.type === 'group') {
        if (n.head && String(n.head).trim()) parts.push(String(n.head).trim()); // группа-текст: свой заголовок
        visit(n.id);
      } else if (n.type === 'text') {
        const f = ctxNodeFile(projId, projPath, n);
        const text = f ? ctxReadFileSafe(f) : null;
        charsByNode[n.id] = text ? text.length : 0;
        if (text && text.trim()) parts.push(text.trim());
        visit(n.id);
      }
    }
  })(outNode.id);
  if (!parts.length) return { content: null, charsByNode };
  return { content: parts.join('\n\n') + '\n', charsByNode };
}
// Сборка ОДНОГО агента: активный профиль (единственный выход) → его файл; старый в бекап + новая точка.
ipcMain.handle('ctx:compile', async (_e, { projId, projPath, agent, force, profileId } = {}) => {
  if (!projId || !projPath) return { error: 'bad args' };
  const ag = ctxAgentSafe(agent);
  const fname = CTX_TARGETS[ag];
  const pid = ctxResolveProfileId(projId, ag, profileId);
  const gFile = ctxProfileGraphFile(projId, ag, pid);
  let graph;
  try { graph = JSON.parse(fs.readFileSync(gFile, 'utf8')); } catch (_) { return { error: 'граф не найден — сначала сохраните канву' }; }
  const settings = graph.settings || {};
  const results = [], conflicts = [], diverged = [], errors = [];
  const { content: asm, charsByNode } = ctxAssemble(graph, projId, projPath, ag);
  let applied = null, point = null;
  if (asm != null) {
    { // пустой выход — файл не трогаем (ничего не удаляем молча)
      const content = asm;
      const target = path.join(projPath, fname);
      const existing = ctxReadFileSafe(target);
      if (existing != null && existing === content) {
        results.push({ out: ag, file: fname, chars: content.length, wrote: false });
      } else if (existing != null && !force && !graph.compiledHash) {
        conflicts.push(fname); // файл есть, но мы его НИКОГДА не собирали → не знаем, наш ли (спросить)
      } else if (existing != null && !force && ctxHash(existing) !== graph.compiledHash) {
        diverged.push(fname); // наш файл (есть запись сборки), но на диске другой → внешняя правка (агентом)
      } else {
        let backup = null;
        if (existing != null) { try { backup = ctxBackup(target, settings, projPath); } catch (e) { errors.push('бекап не записан: ' + (e.message || e)); } }
        try {
          atomicWriteSync(target, content);
          graph.compiledHash = ctxHash(content); // запоминаем, что мы записали (для детекта внешних правок)
          const pr = ctxAddPoint(projId, ag, 'Сборка ' + new Date().toISOString().slice(0, 16).replace('T', ' '), content, false);
          point = pr.id;
          results.push({ out: ag, file: fname, chars: content.length, wrote: true, backup: backup ? path.basename(backup) : null, bdir: backup ? path.dirname(backup) : null, point });
        } catch (e) { errors.push(fname + ': ' + (e.message || e)); }
      }
    }
  }
  for (const n of (graph.nodes || [])) if (charsByNode[n.id] != null) n.chars = charsByNode[n.id];
  const blocked = conflicts.length || diverged.length;
  if (!blocked) { graph.dirty = false; graph.compiledAt = Date.now(); }
  try { fs.mkdirSync(path.dirname(gFile), { recursive: true }); atomicWriteSync(gFile, JSON.stringify(graph)); } catch (_) {}
  if (!blocked) { // запоминаем, какой профиль теперь собран в файле (индикация в UI)
    try { const ix = ctxLoadProfiles(projId, ag); ix.applied = pid; ctxSaveProfiles(projId, ag, ix); applied = pid; } catch (_) {}
  }
  return { ok: true, results, conflicts, diverged, errors, graph, applied, point };
});
// Экспорт собранного файла профиля в произвольное место (save-диалог). Без записи в проект/без точки —
// просто «сохранить копию на ПК». Граф берём с диска (рендерер перед экспортом активного профиля сохраняет канву).
ipcMain.handle('ctx:exportFile', async (_e, { projId, projPath, agent, profileId } = {}) => {
  if (!projId || !projPath) return { error: 'bad args' };
  const ag = ctxAgentSafe(agent);
  const pid = ctxResolveProfileId(projId, ag, profileId);
  let graph;
  try { graph = JSON.parse(fs.readFileSync(ctxProfileGraphFile(projId, ag, pid), 'utf8')); } catch (_) { return { error: 'граф профиля не найден — сначала сохраните канву' }; }
  const { content } = ctxAssemble(graph, projId, projPath, ag);
  if (content == null) return { error: 'нечего сохранять — подключите текст-блоки к выходу' };
  const fname = CTX_TARGETS[ag];
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Сохранить файл контекста',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), fname),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Все файлы', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    atomicWriteSync(res.filePath, content);
    saveState({ lastOpenDir: path.dirname(res.filePath) });
    return { ok: true, file: res.filePath, chars: content.length };
  } catch (e) { return { error: String(e.message || e) }; }
});

// Текущее содержимое файла на диске + флаг внешней правки (для бейджа и окна реконсиляции). Ничего не
// пишет. external = файл есть и его хэш ≠ хэшу нашей последней сборки (значит правил кто-то снаружи).
ipcMain.handle('ctx:assembleText', (_e, { projId, projPath, agent, profileId } = {}) => {
  if (!projId || !projPath) return { error: 'bad args' };
  const ag = ctxAgentSafe(agent);
  const pid = ctxResolveProfileId(projId, ag, profileId);
  let graph = null;
  try { graph = JSON.parse(fs.readFileSync(ctxProfileGraphFile(projId, ag, pid), 'utf8')); } catch (_) {}
  const fileText = ctxReadFileSafe(path.join(projPath, CTX_TARGETS[ag]));
  const fileExists = fileText != null;
  // external = файл на диске разошёлся с тем, что отражает модуль. Если профиль уже собирался —
  // сравниваем с хэшем сборки (точно). Если НЕ собирался (нет compiledHash) — сравниваем с тем,
  // что собрал бы ТЕКУЩИЙ граф. Без этой ветки внешние правки в never-compiled проекте не
  // детектились вовсе (бейдж и реконсиляция молчали, даже после перезагрузки). При первом открытии
  // граф сидируется из файла → сборка == файл → external=false; после внешней переписки файл
  // расходится с графом → external=true. trim гасит косметическую разницу в крайних переносах.
  let external = false;
  if (fileExists && graph) {
    if (graph.compiledHash) {
      external = ctxHash(fileText) !== graph.compiledHash;
    } else {
      const { content } = ctxAssemble(graph, projId, projPath, ag);
      external = ctxHash(String(fileText).trim()) !== ctxHash(String(content || '').trim());
    }
  }
  return { ok: true, fileText: fileText == null ? '' : fileText, fileExists, external };
});
// Снимок текущего файла агента в «Версии» (например, перед втягиванием внешних правок) — страховка.
ipcMain.handle('ctx:snapshotOutput', (_e, { projId, projPath, agent, name } = {}) => {
  if (!projId || !projPath) return { error: 'bad args' };
  const ag = ctxAgentSafe(agent);
  const content = ctxReadFileSafe(path.join(projPath, CTX_TARGETS[ag]));
  if (content == null) return { ok: true, empty: true };
  return { ok: true, ...ctxAddPoint(projId, ag, String(name || 'Внешняя правка').slice(0, 60), content, false) };
});
// Слежение за выходными файлами проекта (CLAUDE.md/AGENTS.md) пока открыт модуль → событие при правке агентом
const ctxOutWatchers = new Map(); // projId -> fs.FSWatcher
ipcMain.on('ctx:watchOutputs', (e, { projId, projPath } = {}) => {
  if (!projId || !projPath || ctxOutWatchers.has(projId)) return;
  const timers = {};
  let watcher;
  try {
    watcher = fs.watch(projPath, (_ev, fname) => {
      const agent = fname === CTX_TARGETS.claude ? 'claude' : (fname === CTX_TARGETS.codex ? 'codex' : null);
      if (!agent) return;
      clearTimeout(timers[agent]);
      timers[agent] = setTimeout(() => safeSend(e.sender, 'ctx:outputChanged', { projId, agent }), 400);
    });
  } catch (_) { return; }
  ctxOutWatchers.set(projId, watcher);
});
ipcMain.on('ctx:unwatchOutputs', (_e, { projId } = {}) => {
  const w = ctxOutWatchers.get(projId);
  if (w) { try { w.close(); } catch (_) {} ctxOutWatchers.delete(projId); }
});
// Папка бекапов для модалки настроек («открыть папку»): резолв дефолта + mkdir
ipcMain.handle('ctx:backupDir', (_e, { projPath, dir } = {}) => {
  if (!projPath && !dir) return { error: 'bad args' };
  const d = ctxBackupDirFor(projPath || '', { backupDir: dir });
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return { dir: d };
});
// Смена папки бекапов: все *.bak переезжают в новую папку без потерь, пустая старая удаляется
ipcMain.handle('ctx:backupMove', (_e, { projPath, from, to } = {}) => {
  if (!projPath) return { error: 'bad args' };
  const src = ctxBackupDirFor(projPath, { backupDir: from });
  const dst = ctxBackupDirFor(projPath, { backupDir: to });
  if (path.resolve(src) === path.resolve(dst)) return { ok: true, moved: 0, dir: dst };
  let moved = 0;
  try {
    if (fs.existsSync(src)) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        if (!f.endsWith('.bak')) continue;
        const a = path.join(src, f), b = path.join(dst, f);
        try { fs.renameSync(a, b); } catch (_) { fs.copyFileSync(a, b); fs.rmSync(a, { force: true }); } // cross-device
        moved++;
      }
      try { fs.rmdirSync(src); } catch (_) {} // удалится только если опустела — чужие файлы не теряем
    }
    return { ok: true, moved, dir: dst };
  } catch (e) { return { error: String(e.message || e), moved }; }
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
// (projects+categories, settings, layout, recents, accordions, section order, uiState…),
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
  const safe = String(name || 'lite-notes').replace(/[\/\\:*?"<>|]+/g, '_').slice(0, 80);
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
  mainWindow.on('maximize', () => mainWindow.webContents.send('win:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximized', false));

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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('module:openSet', { ids });
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
  for (const w of moduleWindows.values()) { if (w && !w.isDestroyed()) w.webContents.send(ch, payload); }
}
// Маршрут стрима к окну-владельцу сессии (fallback — главное окно редактора).
function sendToOwner(sessionId, ch, payload) {
  const wc = ownerBySession.get(sessionId);
  if (wc && !wc.isDestroyed()) { wc.send(ch, payload); return; }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
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
  moduleWindows.set(modId, win);
  win.loadFile(path.join(__dirname, 'renderer', 'module.html'), { hash: modId });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('maximize', () => { if (!win.isDestroyed()) win.webContents.send('win:maximized', true); });
  win.on('unmaximize', () => { if (!win.isDestroyed()) win.webContents.send('win:maximized', false); });
  win.on('resize', debounce(() => saveModuleBounds(modId, win), 400));
  win.on('move', debounce(() => saveModuleBounds(modId, win), 400));
  // Закрытие окна модуля (верхняя ✕ / Alt+F4 / ОС) проходит через dirty-guard рендерера:
  // первый раз гасим закрытие и спрашиваем окно, рендерер ответит win:confirmClose → закрываем.
  // closeAllModuleWindows() зовёт destroy() в обход этого (выход редактора не блокируем).
  win.on('close', (e) => {
    saveModuleBounds(modId, win);
    if (win.__forceClose) return;
    e.preventDefault();
    if (!win.isDestroyed()) win.webContents.send('win:closeRequest');
  });
  win.on('closed', () => {
    moduleWindows.delete(modId);
    if (modId === 'files') filesViewerReady = false; // окно вивера закрыто → следующее openInViewer переоткроет и переждёт готовность
    if (modId === 'ctx') { for (const w of ctxOutWatchers.values()) { try { w.close(); } catch (_) {} } ctxOutWatchers.clear(); } // окно «Контекст» закрылось без unwatch → не течём fs.watch (B2)
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pomodoro:tick', snap);
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
  if (cfg.soundOn !== false && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pomodoro:chime', { to });
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
      { label: 'Показать LiteEditor', click: showWindow },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

// GPU/utility child processes dying (the other half of a "trap int3" crash).
app.on('child-process-gone', (_e, d) =>
  logger.log(d && d.reason === 'clean-exit' ? 'info' : 'error', 'child-process-gone', JSON.stringify(d)));
app.on('before-quit', () => { try { errledger.flush(); } catch (_) {} logger.log('info', 'app', 'before-quit'); });

app.whenReady().then(() => {
  const gpu = !(process.env.LITE_NO_GPU === '1' || process.env.LITE_SOFTWARE_RENDER === '1');
  logger.log('info', 'app', `ready — electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}, gpu=${gpu}`);
  Menu.setApplicationMenu(null); // we draw our own menu in the custom titlebar
  createWindow();
  createTray();
  // Переоткрыть окна модулей, открытые в прошлой сессии (проектозависимые подхватят активный
  // проект, когда редактор его запушит). Небольшая задержка — дать окну редактора подняться.
  setTimeout(reopenSavedModuleWindows, 600);
  startRemotePult();
  signalHeirReady();   // если нас запустили как «наследника» при перезагрузке с пульта — отрапортовать старой копии
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// --- Безопасный перезапуск редактора по команде с пульта ------------------------
// Старая копия поднимает локальный сокет, запускает новую копию (detached) с env
// LITE_HEIR_PORT, ждёт от неё рукопожатие «загрузилась» и ТОЛЬКО ТОГДА закрывается.
// Если новая копия не поднимется за 45с — старая остаётся жить (пульт не теряет ПК).
let restarting = false;
function restartAppSafely() {
  if (restarting) return; restarting = true;
  logger.log('info', 'remote', 'safe restart requested from pult');
  const server = net.createServer();
  let finished = false;
  const fail = (why) => {
    if (finished) return; finished = true; restarting = false;
    try { server.close(); } catch (_) {}
    logger.log('warn', 'remote', 'restart aborted: ' + why);
  };
  server.on('error', (e) => fail('server ' + (e && e.message)));
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    let child;
    try {
      child = spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: 'ignore', cwd: process.cwd(),
        env: Object.assign({}, process.env, { LITE_HEIR_PORT: String(port) }),
      });
    } catch (e) { fail('spawn ' + (e && e.message)); return; }
    child.on('error', (e) => fail('child ' + (e && e.message)));
    child.unref();
    const timer = setTimeout(() => fail('heir not ready in 45s'), 45000);
    server.on('connection', (sock) => {
      sock.on('data', (d) => {
        if (finished || String(d).indexOf('ready') < 0) return;
        finished = true; clearTimeout(timer);
        logger.log('info', 'remote', 'heir ready → closing old instance');
        try { server.close(); } catch (_) {}
        setTimeout(() => app.exit(0), 250);   // даём наследнику долю секунды занять место
      });
    });
  });
}
// Если нас запустили как наследника — после загрузки окна сообщаем старой копии «я жив».
function signalHeirReady() {
  const port = Number(process.env.LITE_HEIR_PORT);
  if (!port || !mainWindow) return;
  const ping = () => {
    try {
      const sock = net.connect(port, '127.0.0.1', () => { try { sock.write('ready'); sock.end(); } catch (_) {} });
      sock.on('error', () => {});
    } catch (_) {}
  };
  // did-finish-load = рендерер загрузился (редактор реально живой) → рапортуем.
  // ping идемпотентен, поэтому держим оба триггера: событие (если ещё грузится) +
  // таймер-подстраховку (если did-finish-load уже прошёл и once больше не сработает).
  mainWindow.webContents.once('did-finish-load', () => setTimeout(ping, 400));
  setTimeout(ping, 1500);
}

// ----------------------------------------------------------- стор (файлы для пульта)
// Read-only шаринг: пульт может листать дерево внутри разрешённых папок (shares) и
// СКАЧИВАТЬ файлы/папки (папка → zip). Никаких правок/удалений с пульта нет.
const STORE_CHUNK = 64 * 1024;            // сырой размер чанка (≈85КБ в base64)
const storeCancelled = new Set();         // reqId, отменённые пультом
const MIME = { txt:'text/plain', md:'text/markdown', json:'application/json', js:'text/javascript', html:'text/html', css:'text/css', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', pdf:'application/pdf', zip:'application/zip', mp4:'video/mp4', mp3:'audio/mpeg' };
function mimeOf(name) { const e = String(name).split('.').pop().toLowerCase(); return MIME[e] || 'application/octet-stream'; }
// Бэкпрешер: не заливаем релей быстрее, чем он отдаёт (по bufferedAmount сокета).
function remoteDrain() {
  return new Promise((resolve) => {
    const check = () => { if (remote.bufferedAmount() < 512 * 1024) resolve(); else setTimeout(check, 15); };
    check();
  });
}
async function streamFileToPult(reqId, filePath, displayName) {
  let fd, stat;
  try { stat = fs.statSync(filePath); fd = fs.openSync(filePath, 'r'); }
  catch (e) { remote.send({ t: 'store:err', reqId, error: 'open: ' + (e && e.message) }); return; }
  remote.send({ t: 'store:begin', reqId, name: displayName, size: stat.size, mime: mimeOf(displayName) });
  const buf = Buffer.allocUnsafe(STORE_CHUNK);
  let seq = 0, pos = 0;
  try {
    while (pos < stat.size) {
      if (storeCancelled.has(reqId)) { storeCancelled.delete(reqId); remote.send({ t: 'store:err', reqId, error: 'cancelled' }); return; }
      const n = fs.readSync(fd, buf, 0, STORE_CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      remote.send({ t: 'store:chunk', reqId, seq: seq++, data: buf.slice(0, n).toString('base64') });
      await remoteDrain();
    }
    remote.send({ t: 'store:end', reqId });
  } catch (e) { remote.send({ t: 'store:err', reqId, error: 'read: ' + (e && e.message) }); }
  finally { try { fs.closeSync(fd); } catch (_) {} }
}
function zipDirToPult(reqId, dirPath) {
  const tmp = path.join(os.tmpdir(), 'lite-store-' + Date.now() + '-' + Math.floor(Math.random() * 1e9) + '.zip');
  // zip содержимого папки (cwd=dir, '.'); требует утилиту zip (есть на большинстве Linux).
  // -y: симлинки хранятся как ссылки, а не разыменовываются — иначе симлинк внутри папки,
  // указывающий наружу шары, утащил бы в архив содержимое внешнего файла.
  execFile('zip', ['-r', '-y', '-q', tmp, '.'], { cwd: dirPath, maxBuffer: 8 * 1024 * 1024 }, (err) => {
    if (err) { remote.send({ t: 'store:err', reqId, error: 'zip недоступен/ошибка: ' + (err.message || err) }); try { fs.unlinkSync(tmp); } catch (_) {} return; }
    streamFileToPult(reqId, tmp, path.basename(dirPath) + '.zip').finally(() => { try { fs.unlinkSync(tmp); } catch (_) {} });
  });
}
function pultStoreList(reqId, p) {
  if (!p || p === '/' || p === '') {   // корень → отдаём сами shares как папки верхнего уровня
    remote.send({ t: 'store:tree', reqId, path: '', entries: getPultShares().map((s) => ({ name: s.name, path: s.path, isDir: true })) });
    return;
  }
  const abs = resolveInShares(p);
  if (!abs) { remote.send({ t: 'store:err', reqId, error: 'доступ запрещён' }); return; }
  let st; try { st = fs.statSync(abs); } catch (_) { remote.send({ t: 'store:err', reqId, error: 'нет доступа' }); return; }
  if (!st.isDirectory()) { remote.send({ t: 'store:err', reqId, error: 'не папка' }); return; }
  let names; try { names = fs.readdirSync(abs); } catch (e) { remote.send({ t: 'store:err', reqId, error: 'readdir: ' + (e && e.message) }); return; }
  const entries = [];
  for (const name of names) {
    try { const full = path.join(abs, name); const s = fs.statSync(full); entries.push({ name, path: full, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs }); }
    catch (_) { /* нечитаемое пропускаем */ }
  }
  entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  remote.send({ t: 'store:tree', reqId, path: abs, entries });
}
// Скачивание из стора: файл → стрим как есть, папка → zip. Один путь для onStoreGet и
// onStoreGetZip (раньше был дубль pultStoreGetZip, отличавшийся лишь текстом ошибки).
function pultStoreGet(reqId, p) {
  const abs = resolveInShares(p);
  if (!abs) { remote.send({ t: 'store:err', reqId, error: 'доступ запрещён' }); return; }
  let st; try { st = fs.statSync(abs); } catch (_) { remote.send({ t: 'store:err', reqId, error: 'нет файла или папки' }); return; }
  if (st.isDirectory()) zipDirToPult(reqId, abs); else streamFileToPult(reqId, abs, path.basename(abs));
}

// Удалённый пульт (Android). Поднимается только при LITE_REMOTE=1 — отдаёт пульту
// список вкладок-сессий (метка = имя проекта · seq), зеркалит вывод PTY и пишет
// ввод/промпт с пульта в нужный PTY. См. remote.js.
let remoteActiveSid = '';   // активная вкладка десктопа (репортит рендерер) — для синка с пультом
// Состояние для пульта: открытые сессии-терминалы + все проекты (с категориями).
function buildRemoteState() {
  const projects = readStoreKey('projects') || [];
  const byId = {};
  for (const p of projects) if (p && p.id) byId[p.id] = p;
  const sessions = [];
  const seqByProj = {};   // нумеруем вкладки последовательно по проекту (1,2,3…), а не по суффиксу sid —
                          // иначе на пульте «Терминал 2», когда в редакторе это «Терминал 1»
  for (const sid of ptys.keys()) {
    const sz = ptySize.get(sid) || { cols: 80, rows: 24 };
    if (sid === '__scratch__') { sessions.push({ sid, projId: null, proj: 'Система', tab: 'Системный (~)', label: 'Системный (~)', cols: sz.cols, rows: sz.rows }); continue; }
    const i = sid.indexOf('::t');
    if (i > 0) {
      const projId = sid.slice(0, i);
      const n = (seqByProj[projId] = (seqByProj[projId] || 0) + 1);
      const proj = byId[projId];
      const name = proj ? proj.name : projId;
      sessions.push({ sid, projId, proj: name, tab: 'Терминал ' + n, label: name + ' · ' + n, cols: sz.cols, rows: sz.rows });
    } else {
      sessions.push({ sid, projId: null, proj: '', tab: sid, label: sid, cols: sz.cols, rows: sz.rows });
    }
  }
  const projOut = projects.map((p) => ({ id: p.id, name: p.name, category: p.category || '', favorite: !!p.favorite }));
  return { sessions, projects: projOut, active: remoteActiveSid };
}
// Открыть терминал для проекта по запросу с пульта → просим рендерер открыть
// настоящую вкладку (как ＋ в редакторе), чтобы она появилась И на ПК, И на пульте.
function remoteOpenProject(projId) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:openProject', { projId });
}
// История — ОКНОМ (ленивая подгрузка при скролле вверх на пульте): отдаём кусок
// транскрипта ДО смещения before размером size; в begin/end кладём start/total,
// чтобы пульт знал, откуда продолжать и когда транскрипт кончился (start=0).
function remoteHistoryGet(reqId, sid, before, size) {
  const text = mirrorScrollback(sid);
  const total = text.length;
  let end = total;
  if (typeof before === 'number' && isFinite(before)) end = Math.max(0, Math.min(Math.floor(before), total));
  const want = (typeof size === 'number' && size > 0) ? Math.min(Math.floor(size), 256 * 1024) : total;
  const start = Math.max(0, end - want);
  const slice = text.slice(start, end);
  const CH = 32 * 1024;
  remote.send({ t: 'history:begin', reqId, sid, size: slice.length, start, total });
  for (let i = 0, seq = 0; i < slice.length; i += CH, seq++) {
    remote.send({ t: 'history:chunk', reqId, sid, seq, data: slice.slice(i, i + CH) });
  }
  remote.send({ t: 'history:end', reqId, sid, start, total });
}
// Хост релея больше НЕ зашит — пользователь указывает свой (self-hosting). Пусто = пульт
// не поднимается, пока не выполнен вход с хостом в модалке «Пульт».
// Нормализуем введённый хост: срезаем схему (wss?://), путь и пробелы — остаётся голый host[:port].
function normalizeRelayHost(s) {
  return String(s || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}
// --- Задачи на пульте: читаем/пишем те же notes/<id>.json, что и панель «Задачи» ---
function notesPath(id) { return path.join(storeDir, 'notes', String(id).replace(/[^\w.-]/g, '_') + '.json'); }
function pultTasksGet(reqId, id) {
  let notes = [];
  try { notes = JSON.parse(fs.readFileSync(notesPath(id), 'utf8')); } catch (_) {}
  if (!Array.isArray(notes)) notes = [];
  remote.send({ t: 'tasks:data', reqId, id, notes });
}
function pultTasksSet(id, notes) {
  if (!Array.isArray(notes)) return;
  try {
    fs.mkdirSync(path.join(storeDir, 'notes'), { recursive: true });
    atomicWriteSync(notesPath(id), JSON.stringify(notes));
    // Освежить открытую в редакторе панель «Задачи», если она показывает этот же список.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:notesChanged', { id: String(id) });
  } catch (e) { logger.log('warn', 'remote', 'pult tasks save failed: ' + (e && e.message)); }
}
// Пульт: вставить текст задачи в терминал проекта — переадресуем рендереру (как в панели «Задачи»).
function pultNoteToTerminal(projId, text) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:noteToTerminal', { projId, text });
}
function startRemotePult() {
  try {
    remote.init({
      logger,
      getSessions: buildRemoteState,
      screenFrame: (sid, styled) => mirrorScreen(sid, styled),  // видимый экран сессии (проекция для пульта; styled — пульт умеет цвета)
      writeInput: (sid, data) => { const p = ptys.get(sid); if (p) p.write(data); },
      openProject: remoteOpenProject,
      onSelect: (sid) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:select', { sid }); },
      onClose: (sid) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:closeTab', { sid }); },
      onNewFolder: (name) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:newFolder', { name }); },
      onRestartApp: () => { restartAppSafely(); },
      onHistoryGet: (reqId, sid, before, size) => remoteHistoryGet(reqId, sid, before, size),
      onStoreList: (reqId, p) => pultStoreList(reqId, p),
      onStoreGet: (reqId, p) => pultStoreGet(reqId, p),
      onStoreGetZip: (reqId, p) => pultStoreGet(reqId, p),
      onStoreCancel: (reqId) => { storeCancelled.add(reqId); },
      // Задачи на пульте: тот же notes/<id>.json, что и панель «Задачи» в редакторе.
      onTasksGet: (reqId, id) => pultTasksGet(reqId, id),
      onTasksSet: (id, notes) => pultTasksSet(id, notes),
      onNoteToTerminal: (projId, text) => pultNoteToTerminal(projId, text),
      // Пульт смотрит «проекцию экрана» и размером PTY не владеет — на presence только лог.
      onPultPresence: (connected) => { logger.log('info', 'remote', connected ? 'pult connected' : 'pult disconnected'); },
      // Пульт просит одобрить устройство → показать модалку в редакторе.
      onPairRequest: (info) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:pairRequest', info); },
      // Учёт подключённых пультов (бейдж у версии) + блок-лист (доступ выключаем, не удаляя).
      isBlocked: (device) => getPultBlocked().includes(device),
      onPultsChanged: (list) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:pults', { list, blocked: getPultBlocked() }); },
      onSysInfo: (m) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:sysinfo', m); },
    });
    const r = readStoreKey('remote') || {};
    if (r.token && r.host) {
      // Аккаунт + хост сохранены (вошли через модалку «Пульт»).
      remote.apply({ host: normalizeRelayHost(r.host), token: r.token, enabled: r.enabled !== false });
    } else if (process.env.LITE_REMOTE === '1' && process.env.LITE_RELAY_TOKEN && process.env.LITE_RELAY_URL) {
      // Legacy: включение через env (общий токен + явный хост релея).
      const host = normalizeRelayHost(process.env.LITE_RELAY_URL);
      if (host) remote.apply({ host, token: process.env.LITE_RELAY_TOKEN, enabled: true });
    }
  } catch (e) { logger.log('error', 'remote', 'start failed', e); }
}

// POST JSON на релей (https). FastAPI-ошибки приходят как {detail:"..."}.
function relayPost(host, pathname, body, extraHeaders) {
  return new Promise((resolve) => {
    let data;
    try { data = Buffer.from(JSON.stringify(body)); } catch (_) { resolve({ status: 0, error: 'bad body' }); return; }
    const headers = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, extraHeaders || {});
    const req = https.request(
      { host, path: pathname, method: 'POST', headers, timeout: 12000 },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message || e) }));
    req.write(data); req.end();
  });
}

function remoteStoreState() {
  const r = readStoreKey('remote') || {};
  const st = remote.status();
  return { loggedIn: !!r.token, login: r.login || '', enabled: r.enabled !== false, connected: st.connected, host: r.host || '' };
}

// Регистрация/вход: дергаем указанный пользователем релей, сохраняем {login, token, host, enabled}, поднимаем соединение.
async function remoteAuth(kind, { login, password, host } = {}) {
  host = normalizeRelayHost(host || (readStoreKey('remote') || {}).host || '');
  if (!host) return { ok: false, error: 'Укажите хост релея (например relay.example.com)' };
  const res = await relayPost(host, '/' + kind, { login, password });
  if (res.status === 200 && res.body && res.body.token) {
    const rec = { login: res.body.login || login, token: res.body.token, host, enabled: true };
    writeStoreKey('remote', rec);
    remote.apply({ host, token: rec.token, enabled: true });
    return { ok: true, status: remoteStoreState() };
  }
  const msg = (res.body && (res.body.detail || res.body.error)) || res.error ||
    (res.status === 401 ? 'Неверный логин или пароль' : res.status === 409 ? 'Логин занят' : `Ошибка (${res.status || 'нет связи'})`);
  return { ok: false, error: String(msg) };
}

ipcMain.handle('remote:status', () => remoteStoreState());
// «Выйти на всех устройствах» — снять одобрение со всех устройств аккаунта + отозвать сессии
// (на случай потери планшета). Авторизуемся сохранённым токеном аккаунта.
ipcMain.handle('remote:revokeAllDevices', async () => {
  const r = readStoreKey('remote') || {};
  if (!r.token) return { ok: false, error: 'не выполнен вход' };
  const host = r.host || '';
  const res = await relayPost(host, '/devices/revoke-all', {}, { Authorization: 'Bearer ' + r.token });
  if (res.status === 200) return { ok: true };
  return { ok: false, error: (res.body && (res.body.detail || res.body.error)) || res.error || `Ошибка (${res.status || 'нет связи'})` };
});
ipcMain.handle('remote:register', (_e, creds) => remoteAuth('register', creds || {}));
ipcMain.handle('remote:login', (_e, creds) => remoteAuth('login', creds || {}));
ipcMain.handle('remote:logout', () => {
  const r = readStoreKey('remote') || {};
  writeStoreKey('remote', { ...r, token: '', enabled: false });
  remote.apply({ token: '', enabled: false });
  return remoteStoreState();
});
ipcMain.handle('remote:setEnabled', (_e, { enabled } = {}) => {
  const r = readStoreKey('remote') || {};
  writeStoreKey('remote', { ...r, enabled: !!enabled });
  remote.apply({ enabled: !!enabled });
  return remoteStoreState();
});
// --- Пульты: список подключённых, блок-лист, запрос сисинфо/гео ----------------
// «Отключить» НЕ удаляет устройство: device id кладётся в pultBlocked (стор) и пульту
// шлётся адресный kick; при каждом следующем появлении заблокированного устройства
// remote.js кикает его снова. «Вернуть» — убрать из списка, пульт подключится сам.
function getPultBlocked() {
  const v = readStoreKey('pultBlocked');
  return Array.isArray(v) ? v : [];
}
ipcMain.handle('remote:pults', () => ({ list: remote.pultList(), blocked: getPultBlocked() }));
ipcMain.handle('remote:pultBlock', (_e, { device } = {}) => {
  device = String(device || '').trim();
  if (device) {
    const b = getPultBlocked();
    if (!b.includes(device)) writeStoreKey('pultBlocked', b.concat([device]));
    try { remote.kick(device); } catch (_) {}
  }
  return { list: remote.pultList(), blocked: getPultBlocked() };
});
ipcMain.handle('remote:pultUnblock', (_e, { device } = {}) => {
  device = String(device || '').trim();
  if (device) writeStoreKey('pultBlocked', getPultBlocked().filter((d) => d !== device));
  return { list: remote.pultList(), blocked: getPultBlocked() };
});
// Запрос у конкретного пульта; what: 'info' (диагностика) | 'geo' (местоположение).
// Ответ прилетит событием remote:sysinfo (c тем же what).
ipcMain.on('remote:pultSysInfo', (_e, { device, what } = {}) => {
  try { remote.send({ t: 'sysinfo:get', device: String(device || ''), what: String(what || '') }); } catch (_) {}
});

// Pairing: пользователь на ПК одобрил/отклонил устройство пульта → шлём решение релею.
ipcMain.on('remote:pairApprove', (_e, { device } = {}) => {
  try { remote.send({ t: 'pair:approve', device: String(device || ''), pubkey: '' }); } catch (_) {}
});
ipcMain.on('remote:pairDeny', (_e, { device } = {}) => {
  try { remote.send({ t: 'pair:deny', device: String(device || '') }); } catch (_) {}
});
// Рендерер сообщает, какая вкладка активна на десктопе → шлём пульту (синк активной).
ipcMain.on('remote:activeChanged', (_e, { sid } = {}) => {
  if ((sid || '') === remoteActiveSid) return;
  remoteActiveSid = sid || '';
  try { remote.notifyState(); } catch (_) {}
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
ipcMain.on('module:close', (_e, { modId } = {}) => { const w = moduleWindows.get(String(modId)); if (w && !w.isDestroyed()) w.close(); });
ipcMain.handle('module:openSet', () => ({ ids: [...moduleWindows.keys()] }));

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
  const safe = String(name || 'lite-pomodoro').replace(/[\/\\:*?"<>|]+/g, '_').slice(0, 80);
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
// Задачи изменились (модуль/пульт) → разослать ВСЕМ окнам модулей КРОМЕ отправителя (иначе автор правки
// получил бы эхо своего же изменения и перезагрузил список после каждого клика) + в главное окно (для бейджа
// счётчика активных задач на квикбаре). Отправитель сам уже знает об изменении и обновляет UI точечно.
ipcMain.on('app:notesChanged', (e, { id } = {}) => {
  for (const w of moduleWindows.values()) { if (w && !w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('app:notesChanged', { id }); }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== e.sender) mainWindow.webContents.send('app:notesChanged', { id });
});

// ── Действия из окна модуля → переслать редактору (терминал) или окну вивера (файл/дерево) ──
function forwardToEditor(ch, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); }
// Вивер живёт в окне модуля «files». openInViewer/refreshTree маршрутизируем туда (открываем окно при
// необходимости). Окно может быть не готово принять сообщение сразу после открытия → копим в очередь до
// сигнала editor:viewerReady (его шлёт module-entry после подписки).
let filesViewerReady = false;
const pendingViewerOpens = [];
let pendingFocusGit = false;        // «Git» нажат до готовности окна → фокус секции после viewerReady
function filesWindow() { const w = moduleWindows.get('files'); return (w && !w.isDestroyed()) ? w : null; }
function routeOpenInViewer(payload) {
  if (!filesWindow()) openModuleWindow('files'); // откроет окно (и переключит на активный проект)
  const w = filesWindow();
  if (w && filesViewerReady) w.webContents.send('editor:openInViewer', payload);
  else pendingViewerOpens.push(payload); // флашнем по editor:viewerReady
}
ipcMain.on('editor:openInViewer', (_e, payload) => routeOpenInViewer(payload));
ipcMain.on('editor:refreshTree', (_e, payload) => { const w = filesWindow(); if (w) w.webContents.send('editor:refreshTree', payload); });
// «Git» из редактора: открыть окно вивера (если закрыто) и переключить его на секцию «Коммит».
ipcMain.on('editor:focusGit', () => {
  if (!filesWindow()) openModuleWindow('files');
  const w = filesWindow();
  if (w && filesViewerReady) { if (w.isMinimized()) w.restore(); w.focus(); w.webContents.send('editor:focusGit'); }
  else pendingFocusGit = true;
});
ipcMain.on('editor:viewerReady', () => {
  filesViewerReady = true;
  while (pendingViewerOpens.length) { const p = pendingViewerOpens.shift(); const w = filesWindow(); if (w) w.webContents.send('editor:openInViewer', p); }
  if (pendingFocusGit) { pendingFocusGit = false; const w = filesWindow(); if (w) { w.focus(); w.webContents.send('editor:focusGit'); } }
});
ipcMain.on('editor:sendToTerminal', (_e, payload) => forwardToEditor('editor:sendToTerminal', payload));
// «Пропустить отдых» с оверлея в окне редактора → пропустить текущую фазу помодоро (движок в main).
ipcMain.on('editor:pomodoroSkip', () => { if (POMO.running) pomoAdvance(); });
ipcMain.on('editor:sendNoteToTerminal', (_e, payload) => forwardToEditor('editor:sendNoteToTerminal', payload));
// Окно вивера (встроенный Git) попросило редактор перерисовать список проектов (git-бейджи после commit/checkout).
ipcMain.on('editor:refreshProjects', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('editor:refreshProjects'); });

// Reflect how many agents need attention on the tray tooltip (and macOS title).
ipcMain.on('tray:update', (_e, { attention } = {}) => {
  const n = attention || 0;
  if (tray) tray.setToolTip(n > 0 ? `LiteEditorAI — ${n} ждут ответа` : 'LiteEditorAI');
  if (process.platform === 'darwin' && app.dock) app.setBadgeCount(n);
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
// Окружение для пользовательских шеллов/exec: НЕ протаскиваем внутренние переменные редактора
// (порт «наследника» при рестарте, секреты релея) в каждый терминал и контейнер (B9) — там им
// не место и они утекали бы в `env` любого процесса агента.
const PTY_ENV_DENY = new Set(['LITE_HEIR_PORT', 'LITE_RELAY_TOKEN', 'LITE_RELAY_URL', 'RELAY_SECRET']);
function userShellEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) if (!PTY_ENV_DENY.has(k)) env[k] = process.env[k];
  return Object.assign(env, extra || {});
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
      // SHELL → реальный шелл; LITE_STORE → папка-стор (агент кладёт туда файлы для пульта).
      env: userShellEnv({ SHELL: shell, LITE_STORE: pultStoreDir }),
    });
  } catch (err) {
    logger.log('error', 'pty', 'spawn failed', err);
    sendToOwner(id, 'pty:data', { id, data: `\r\n\x1b[31mНе удалось запустить шелл (${shell}): ${err.message}\x1b[0m\r\n` });
    sendToOwner(id, 'pty:exit', { id });
    return { error: String(err.message || err) };
  }
  logger.log('info', 'pty', `spawned pid=${proc.pid}`);
  mirrorCreate(id, cols, rows);   // свежий теневой терминал (сбрасывает scrollback при рестарте PTY)
  proc.onData((data) => {
    sendToOwner(id, 'pty:data', { id, data });     // окну-владельцу (редактор/scratch-окно)
    mirrorWrite(id, data);                         // сначала в теневой терминал (кадр всегда консистентен)
    try { remote.screenTouch(id); } catch (_) {}   // потом будим диффер кадров (debounce внутри)
  });
  proc.onExit(() => {
    if (ptys.get(id) && ptys.get(id) !== proc) return; // replaced by a restart — suppress stale exit
    ptys.delete(id);
    ptySize.delete(id);
    mirrorDispose(id);
    sendToOwner(id, 'pty:exit', { id });
    ownerBySession.delete(id); // сессия закрылась — не копим мёртвые id в карте маршрутизации (B4-LOW)
    try { remote.exit(id); remote.notifyState(); } catch (_) {}
  });
  ptys.set(id, proc);
  ptySize.set(id, { cols: cols || 80, rows: rows || 24 });
  return { ok: true };
}
ipcMain.handle('pty:create', (e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) { ownerBySession.set(id, e.sender); return { ok: true, existed: true }; }
  const r = spawnPtyFor(id, cwd, cols, rows, e.sender);
  try { remote.notifyState(); } catch (_) {} // обновить список вкладок на пульте
  return r;
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
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} ptySize.set(id, { cols, rows }); mirrorResize(id, cols, rows); try { remote.notifyState(); } catch (_) {} }
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
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:readFile', async (_e, file) => {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_VIEW_BYTES) return { error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
    return { content: await fs.promises.readFile(file, 'utf8') };
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:writeFile', async (_e, { file, content }) => {
  try { await fs.promises.writeFile(file, content, 'utf8'); return { ok: true }; }
  catch (err) { return { error: String(err.message || err) }; }
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

// ---------------------------------------------------------------- file watching
// Watch a project root and tell the renderer when files change on disk — so the
// tree and the open file refresh live while an agent edits things in the terminal.
const isIgnoredPath = (rel) => rel.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg));
// Сообщить окнам (редактор + вивер), что слежение за деревом отвалилось → ручной ⟳ (идея 11).
function notifyWatchEnded(root) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fs:watchEnded', { root });
  const fw = filesWindow(); if (fw) fw.webContents.send('fs:watchEnded', { root });
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
    if (rel) rec.pending.add(path.join(root, rel));
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      const files = [...rec.pending]; rec.pending.clear();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fs:changed', { root, files });
      const fw = filesWindow(); if (fw) fw.webContents.send('fs:changed', { root, files }); // окно вивера обновляет дерево/файл
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
ipcMain.handle('iterflow:reorderNotes', ifWrap((_e, { projectId, ids }) => iterflowApi.reorderNotes(projectId, ids)));

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
      const cipher = socket.getCipher() || {};
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
    dmarc: { found: !!dmarc, value: dmarc || '', policy: dmarc ? (/(p=[a-z]+)/i.exec(dmarc) || [, ''])[1] : '' },
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
      sameSite: (/;\s*samesite\s*=\s*(\w+)/i.exec(line) || [, ''])[1],
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
  const last = await git(root, ['log', '-1', '--format=%h\t%s\t%cr\t%an']);
  let lastCommit = null;
  if (last && last.trim()) { const [hash, subject, when, author] = last.trim().split('\t'); lastCommit = { hash, subject, when, author }; }
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
  return { repo: true, branch, ahead, behind, upstream, lastCommit, branches, branchTrack, hasRemote: remote.length > 0 };
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
ipcMain.handle('git:discardFile', async (_e, { root, file }) => gitRun(root, ['checkout', '--', file]));
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
  if (!nm || nm.startsWith('-') || /[\s~^:?*\[\\]/.test(nm) || nm.includes('..')) return { ok: false, error: 'Недопустимое имя ветки' };
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
ipcMain.handle('git:commit', async (_e, { root, message, push, files }) => {
  // files передан → коммитим только выбранное (git add -- <files>), иначе всё (git add -A, как раньше).
  const sel = Array.isArray(files) && files.length;
  const add = await gitRun(root, sel ? ['add', '--', ...files] : ['add', '-A']); if (!add.ok) return add;
  // sel → коммитим РОВНО выбранные пути (pathspec), иначе `git commit` забрал бы и всё прочее,
  // что уже лежит в индексе (напр. файл, застейдженный при разрешении конфликта и затем снятый галкой).
  const c = await gitRun(root, sel ? ['commit', '-m', message || 'update', '--', ...files] : ['commit', '-m', message || 'update']); if (!c.ok) return c;
  // committed:true даже при провале пуша — фронт обязан обновить список (коммит-то уже лёг).
  if (push) { const p = await gitPush(root); if (!p.ok) return { ok: false, committed: true, error: 'Коммит создан, push не прошёл: ' + p.error }; }
  return { ok: true, out: c.out };
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
ipcMain.handle('git:stashPop', async (_e, root) => gitRun(root, ['stash', 'pop']));
// Revert tracked edits only ('checkout -- .'); untracked files are deliberately kept (no -fd clean).
ipcMain.handle('git:discardAll', async (_e, root) => gitRun(root, ['checkout', '--', '.']));

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
  const out = await git(root, ['show', '--no-color', h, '--', file]);
  return { diff: out || '' };
});

// ---------------------------------------------------------------- git: branches (local + remote) & ops (PhpStorm-style)
// Отсекаем argv-инъекшн/невалидные ref'ы (ведущий '-', пробелы/спецсимволы, '..'); '/' разрешён (remote/feature).
const BAD_REF = (s) => !s || String(s).startsWith('-') || /[\s~^:?*\[\\]/.test(String(s)) || String(s).includes('..');
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
function containerRun(cli, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: opts.timeout || 15000, maxBuffer: 24 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({
        ok: !err, out: (stdout || '').trim(),
        error: err ? ((stderr || '').trim() || String(err.message || err)) : '',
      }));
  });
}
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
      return { id: c.ID, name: c.Names, image: c.Image, state: String(c.State || '').toLowerCase(), status: c.Status, ports: c.Ports || '', project: L[C_PROJECT] || '', service: L[C_SERVICE] || '' }; }) };
  }
  const r = await containerRun('podman', ['ps', '-a', '--format', 'json'], { timeout: 12000 });
  if (!r.ok) return { error: r.error };
  return { items: cParseJson(r.out).map((c) => { const L = c.Labels || {};
    const name = Array.isArray(c.Names) ? c.Names[0] : (c.Names || c.Name || '');
    const ports = Array.isArray(c.Ports) ? c.Ports.map((p) => `${p.host_port || p.hostPort || ''}${(p.host_port || p.hostPort) ? ':' : ''}${p.container_port || p.containerPort || ''}`).filter((s) => s && s !== ':').join(', ') : '';
    return { id: c.Id || c.ID, name, image: c.Image, state: String(c.State || '').toLowerCase(), status: c.Status || c.State, ports, project: L[C_PROJECT] || L['io.podman.compose.project'] || '', service: L[C_SERVICE] || '' }; }) };
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
  try { cp = spawn(engine, ['logs', '-f', '--tail', String(Math.max(1, Math.min(5000, parseInt(tail, 10) || 500))), id], { windowsHide: true }); }
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
  try {
    proc = pty.spawn(engine, ['exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
      { name: 'xterm-color', cols: cols || 80, rows: rows || 24, env: userShellEnv() });
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
