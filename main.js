// LiteEditor — Electron main process.
// Thin backend: project picker, PTY lifecycle, file ops, window controls.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, Tray, nativeImage, crashReporter, safeStorage } = require('electron');
const dbBackend = require('./lib/db');
const rhBackend = require('./lib/remotehost');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const https = require('https');
const net = require('net');
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
function mirrorScreen(id) {
  const m = mirrors.get(id);
  if (!m) return null;
  try {
    const term = m.term;
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return {
      cols: term.cols, rows: term.rows, lines,
      cursor: [buf.cursorX, buf.cursorY],
      alt: buf.type === 'alternate',
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
const STORE_KEYS = ['projects', 'settings', 'layout', 'recents', 'lastParent', 'categories', 'sectionOrder', 'accordions', 'dismissed', 'uiState', 'projTabs', 'openrouter', 'remote', 'shares', 'pultBlocked', 'dockerUi', 'dbConnections', 'dbUi', 'rhConnections', 'rhUi', 'textproc', 'tpPrompts'];
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
  send: (ch, payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); },
  getConnections: () => readStoreKey('rhConnections'),
  setConnections: (v) => writeStoreKey('rhConnections', v),
});

// File logging lives next to the store, survives restarts, keeps 5 days.
const logsDir = path.join(storeDir, 'logs');
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

// Как звать CLI в неинтерактивном режиме и куда подавать промпт (stdin/arg).
const TP_AGENTS = {
  claude: { cmd: 'claude', args: ['-p', '--output-format', 'text'], via: 'stdin' },
  codex: { cmd: 'codex', args: ['exec'], via: 'arg' },
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
  try { child = spawn(conf.cmd, args, { cwd: os.homedir(), env: tpEnv() }); }
  catch (err) { safeSend(sender, 'tp:error', { reqId, error: 'не запустить «' + conf.cmd + '»: ' + (err.message || err) }); return; }
  tpReqs.set(reqId, child);
  let out = '', errOut = '';
  const to = setTimeout(() => { if (tpReqs.has(reqId)) { tpReqs.delete(reqId); try { child.kill(); } catch (_) {} safeSend(sender, 'tp:error', { reqId, error: 'таймаут (агент не ответил вовремя)' }); } }, 240000);
  child.stdout.on('data', (c) => { out += c.toString('utf8'); });
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  child.on('error', (err) => {
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId); clearTimeout(to);
    safeSend(sender, 'tp:error', { reqId, error: 'агент «' + conf.cmd + '» не найден/не запустился: ' + (err.message || err) });
  });
  child.on('close', (code) => {
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId); clearTimeout(to);
    const text = out.trim();
    if (text) safeSend(sender, 'tp:done', { reqId, text }); // непустой вывод = результат (даже при ненулевом коде)
    else safeSend(sender, 'tp:error', { reqId, error: errOut.trim() || ('агент завершился с кодом ' + code) });
  });
  if (conf.via === 'stdin') { try { child.stdin.write(prompt || ''); child.stdin.end(); } catch (_) {} }
});
ipcMain.on('tp:abort', (_e, { reqId } = {}) => {
  const c = tpReqs.get(reqId);
  if (c) { tpReqs.delete(reqId); try { c.kill(); } catch (_) {} }
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
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logger.log(level === 3 ? 'error' : 'warn', 'console', `${message} (${sourceId}:${line})`);
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
app.on('before-quit', () => logger.log('info', 'app', 'before-quit'));

app.whenReady().then(() => {
  const gpu = !(process.env.LITE_NO_GPU === '1' || process.env.LITE_SOFTWARE_RENDER === '1');
  logger.log('info', 'app', `ready — electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}, gpu=${gpu}`);
  Menu.setApplicationMenu(null); // we draw our own menu in the custom titlebar
  createWindow();
  createTray();
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
  if (mainWindow.webContents.isLoadingMainFrame && mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(ping, 400));
  } else {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(ping, 400));
    setTimeout(ping, 1500); // подстраховка, если did-finish-load уже прошёл
  }
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
function pultStoreGet(reqId, p) {
  const abs = resolveInShares(p);
  if (!abs) { remote.send({ t: 'store:err', reqId, error: 'доступ запрещён' }); return; }
  let st; try { st = fs.statSync(abs); } catch (_) { remote.send({ t: 'store:err', reqId, error: 'нет файла' }); return; }
  if (st.isDirectory()) zipDirToPult(reqId, abs); else streamFileToPult(reqId, abs, path.basename(abs));
}
function pultStoreGetZip(reqId, p) {
  const abs = resolveInShares(p);
  if (!abs) { remote.send({ t: 'store:err', reqId, error: 'доступ запрещён' }); return; }
  let st; try { st = fs.statSync(abs); } catch (_) { remote.send({ t: 'store:err', reqId, error: 'нет папки' }); return; }
  if (st.isDirectory()) zipDirToPult(reqId, abs); else streamFileToPult(reqId, abs, path.basename(abs));
}

// Удалённый пульт (Android). Поднимается только при LITE_REMOTE=1 — отдаёт пульту
// список вкладок-сессий (метка = имя проекта · seq), зеркалит вывод PTY и пишет
// ввод/промпт с пульта в нужный PTY. См. remote.js.
let remoteSeq = 0;
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
const REMOTE_DEFAULT_HOST = 'lite.codecopy.ru';
function startRemotePult() {
  try {
    remote.init({
      logger,
      getSessions: buildRemoteState,
      screenFrame: (sid) => mirrorScreen(sid),  // видимый экран сессии (проекция для пульта)
      writeInput: (sid, data) => { const p = ptys.get(sid); if (p) p.write(data); },
      openProject: remoteOpenProject,
      onSelect: (sid) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:select', { sid }); },
      onClose: (sid) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:closeTab', { sid }); },
      onNewFolder: (name) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:newFolder', { name }); },
      onRestartApp: () => { restartAppSafely(); },
      onHistoryGet: (reqId, sid, before, size) => remoteHistoryGet(reqId, sid, before, size),
      onStoreList: (reqId, p) => pultStoreList(reqId, p),
      onStoreGet: (reqId, p) => pultStoreGet(reqId, p),
      onStoreGetZip: (reqId, p) => pultStoreGetZip(reqId, p),
      onStoreCancel: (reqId) => { storeCancelled.add(reqId); },
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
    if (r.token) {
      // Аккаунт сохранён (вошли через модалку «Пульт»).
      remote.apply({ host: r.host || REMOTE_DEFAULT_HOST, token: r.token, enabled: r.enabled !== false });
    } else if (process.env.LITE_REMOTE === '1' && process.env.LITE_RELAY_TOKEN) {
      // Legacy: включение через env (общий токен).
      const host = (process.env.LITE_RELAY_URL || '').replace(/^wss?:\/\//, '').replace(/\/.*$/, '') || REMOTE_DEFAULT_HOST;
      remote.apply({ host, token: process.env.LITE_RELAY_TOKEN, enabled: true });
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
  return { loggedIn: !!r.token, login: r.login || '', enabled: r.enabled !== false, connected: st.connected, host: r.host || REMOTE_DEFAULT_HOST };
}

// Регистрация/вход: дергаем релей, сохраняем {login, token, host, enabled}, поднимаем соединение.
async function remoteAuth(kind, { login, password } = {}) {
  const host = REMOTE_DEFAULT_HOST;
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
  const host = r.host || REMOTE_DEFAULT_HOST;
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
  try { dbApi.closeAll(); } catch (_) {}
  try { rhApi.closeAll(); } catch (_) {}
  for (const w of watchers.values()) { try { w.watcher.close(); } catch (_) {} }
  watchers.clear();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- window controls
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:maximizeToggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));
ipcMain.on('win:show', showWindow);

// Reflect how many agents need attention on the tray tooltip (and macOS title).
ipcMain.on('tray:update', (_e, { attention } = {}) => {
  const n = attention || 0;
  if (tray) tray.setToolTip(n > 0 ? `LiteEditorAI — ${n} ждут ответа` : 'LiteEditorAI');
  if (process.platform === 'darwin' && app.dock) app.setBadgeCount(n);
});

// Grow/shrink the window to the right by dx px (used when the viewer opens, so
// the terminal keeps its size instead of being squished).
ipcMain.on('win:growBy', (_e, { dx }) => {
  if (!mainWindow || mainWindow.isFullScreen() || mainWindow.isMaximized()) return;
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
function spawnPtyFor(id, cwd, cols, rows) {
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
      env: { ...process.env, SHELL: shell, LITE_STORE: pultStoreDir },
    });
  } catch (err) {
    logger.log('error', 'pty', 'spawn failed', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data: `\r\n\x1b[31mНе удалось запустить шелл (${shell}): ${err.message}\x1b[0m\r\n` });
      mainWindow.webContents.send('pty:exit', { id });
    }
    return { error: String(err.message || err) };
  }
  logger.log('info', 'pty', `spawned pid=${proc.pid}`);
  mirrorCreate(id, cols, rows);   // свежий теневой терминал (сбрасывает scrollback при рестарте PTY)
  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', { id, data });
    mirrorWrite(id, data);                         // сначала в теневой терминал (кадр всегда консистентен)
    try { remote.screenTouch(id); } catch (_) {}   // потом будим диффер кадров (debounce внутри)
  });
  proc.onExit(() => {
    if (ptys.get(id) && ptys.get(id) !== proc) return; // replaced by a restart — suppress stale exit
    ptys.delete(id);
    ptySize.delete(id);
    mirrorDispose(id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit', { id });
    try { remote.exit(id); remote.notifyState(); } catch (_) {}
  });
  ptys.set(id, proc);
  ptySize.set(id, { cols: cols || 80, rows: rows || 24 });
  return { ok: true };
}
ipcMain.handle('pty:create', (_e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) return { ok: true, existed: true };
  const r = spawnPtyFor(id, cwd, cols, rows);
  try { remote.notifyState(); } catch (_) {} // обновить список вкладок на пульте
  return r;
});
// Kill the existing PTY (if any) and start a fresh one in the same cwd.
ipcMain.handle('pty:restart', (_e, { id, cwd, cols, rows }) => {
  const old = ptys.get(id);
  if (old) { try { old.kill(); } catch (_) {} ptys.delete(id); }
  return spawnPtyFor(id, cwd, cols, rows);
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
    return entries
      .filter((d) => !(d.isDirectory() && IGNORE_DIRS.has(d.name)))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
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

// ---------------------------------------------------------------- file watching
// Watch a project root and tell the renderer when files change on disk — so the
// tree and the open file refresh live while an agent edits things in the terminal.
const isIgnoredPath = (rel) => rel.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg));
ipcMain.on('fs:watch', (_e, root) => {
  if (!root || watchers.has(root) || !fs.existsSync(root)) return;
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true });
  } catch (_) { return; } // inotify limits / unsupported — degrade to manual refresh
  const rec = { watcher, timer: null, pending: new Set() };
  watcher.on('error', () => { try { watcher.close(); } catch (_) {} watchers.delete(root); });
  watcher.on('change', (_type, filename) => {
    const rel = filename == null ? '' : String(filename);
    if (rel && isIgnoredPath(rel)) return;
    if (rel) rec.pending.add(path.join(root, rel));
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      const files = [...rec.pending]; rec.pending.clear();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fs:changed', { root, files });
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
// Map of changed files (abs path -> short status code) for tree decorations.
ipcMain.handle('git:status', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return { error: 'no root' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top == null) return { repo: false, files: {} };
  const base = top.trim();
  const out = await git(root, ['status', '--porcelain', '--untracked-files=normal']);
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
  const brOut = await git(root, ['branch', '--format=%(refname:short)']);
  const branches = brOut ? brOut.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const remote = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
  return { repo: true, branch, ahead, behind, upstream, lastCommit, branches, hasRemote: remote.length > 0 };
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
ipcMain.handle('git:branchCreate', async (_e, { root, name, base, checkout }) =>
  gitRun(root, checkout ? ['checkout', '-b', name, base] : ['branch', name, base]));
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
ipcMain.handle('git:commit', async (_e, { root, message, push }) => {
  const add = await gitRun(root, ['add', '-A']); if (!add.ok) return add;
  const c = await gitRun(root, ['commit', '-m', message || 'update']); if (!c.ok) return c;
  if (push) { const p = await gitRun(root, ['push']); if (!p.ok) return { ok: false, error: 'Коммит создан, push не прошёл: ' + p.error }; }
  return { ok: true, out: c.out };
});
ipcMain.handle('git:push', async (_e, root) => gitRun(root, ['push']));
ipcMain.handle('git:pull', async (_e, root) => gitRun(root, ['pull', '--ff-only']));
// Stash including untracked (-u) so a quick "спрятать всё" doesn't leave new files behind.
ipcMain.handle('git:stash', async (_e, root) => gitRun(root, ['stash', 'push', '-u']));
ipcMain.handle('git:stashPop', async (_e, root) => gitRun(root, ['stash', 'pop']));
// Revert tracked edits only ('checkout -- .'); untracked files are deliberately kept (no -fd clean).
ipcMain.handle('git:discardAll', async (_e, root) => gitRun(root, ['checkout', '--', '.']));

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
  return { items: cParseJson(r.out).map((i) => { const names = i.Names || i.RepoTags || [];
    const full = Array.isArray(names) ? (names[0] || '<none>:<none>') : String(names);
    const ci = full.lastIndexOf(':'); const repo = ci > 0 ? full.slice(0, ci) : full; const tag = ci > 0 ? full.slice(ci + 1) : '';
    return { id: String(i.Id || i.ID || '').slice(0, 12), repo, tag, size: cHumanSize(i.Size), created: i.Created }; }) };
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
ipcMain.handle('containers:list', async (_e, { engine } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
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
ipcMain.handle('containers:logsStart', (_e, { engine, id, streamId, tail } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
  if (!id || !streamId) return { error: 'bad args' };
  let cp;
  try { cp = spawn(engine, ['logs', '-f', '--tail', String(Math.max(1, Math.min(5000, parseInt(tail, 10) || 500))), id], { windowsHide: true }); }
  catch (e) { return { error: String(e.message || e) }; }
  const send = (d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('containers:logsData', { streamId, data: d.toString('utf8') }); };
  cp.stdout.on('data', send); cp.stderr.on('data', send);
  cp.on('error', (err) => send('\n[ошибка logs: ' + (err.message || err) + ']\n'));
  cp.on('close', () => { cLogProcs.delete(streamId); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('containers:logsExit', { streamId }); });
  cLogProcs.set(streamId, cp);
  return { ok: true };
});
ipcMain.on('containers:logsStop', (_e, { streamId } = {}) => { const cp = cLogProcs.get(streamId); if (cp) { try { cp.kill(); } catch (_) {} cLogProcs.delete(streamId); } });
ipcMain.handle('containers:execStart', (_e, { engine, id, execId, cols, rows } = {}) => {
  if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
  if (!id || !execId) return { error: 'bad args' };
  let proc;
  try {
    proc = pty.spawn(engine, ['exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
      { name: 'xterm-color', cols: cols || 80, rows: rows || 24, env: process.env });
  } catch (e) { return { error: String(e.message || e) }; }
  proc.onData((d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('containers:execData', { execId, data: d }); });
  proc.onExit(() => { cExecPtys.delete(execId); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('containers:execExit', { execId }); });
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

ipcMain.handle('shell:openPath', async (_e, target) => {
  const err = await shell.openPath(target);
  return err ? { error: err } : { ok: true };
});
ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url))) return { error: 'bad url' };
  try { await shell.openExternal(url); return { ok: true }; } catch (e) { return { error: String(e) }; }
});
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text == null ? '' : text)));
ipcMain.handle('clipboard:read', () => clipboard.readText());
