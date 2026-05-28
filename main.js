// LiteEditor — Electron main process.
// Thin backend: project picker, PTY lifecycle, file ops, window controls.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, Tray, nativeImage, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');
const logger = require('./logger');

app.setName('LiteEditorAI');

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
const ptys = new Map();     // projectId -> IPty
const watchers = new Map(); // project root path -> { watcher, timer, pending:Set }

// Resolve a shell that actually exists. $SHELL can point at a shell that was
// uninstalled (e.g. zsh removed), which makes node-pty fail with "execvp failed".
function resolveShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  const candidates = [process.env.SHELL, '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh'];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'bash'; // last resort — let PATH resolve it
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
const STORE_KEYS = ['projects', 'settings', 'layout', 'recents', 'lastParent', 'categories', 'sectionOrder', 'accordions', 'dismissed', 'uiState', 'projTabs'];
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
  o.noteCounts = {}; // project id -> number of notes, for card badges
  try {
    const nd = path.join(storeDir, 'notes');
    for (const f of fs.readdirSync(nd)) {
      if (!f.endsWith('.json')) continue;
      try { const a = JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8')); if (Array.isArray(a) && a.length) o.noteCounts[f.slice(0, -5)] = a.length; } catch (_) {}
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch (_) {} }
  ptys.clear();
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
  let width = Math.max(760, b.width + dx);
  if (dx > 0) width = Math.min(width, work.x + work.width - b.x); // don't run off-screen
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
  const shell = resolveShell();
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // Log around the spawn: it runs synchronously on the main thread, so if it ever
  // hangs (e.g. a ConPTY conout pipe never connecting on Windows) the log shows
  // "pty spawn …" with no following "pty spawned …" — pinpointing the freeze.
  logger.log('info', 'pty', `spawn shell=${shell} cwd=${startCwd}`);
  let proc;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startCwd,
      env: { ...process.env, SHELL: shell }, // keep the env pointing at a real shell
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
  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', { id, data });
  });
  proc.onExit(() => {
    if (ptys.get(id) && ptys.get(id) !== proc) return; // replaced by a restart — suppress stale exit
    ptys.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit', { id });
  });
  ptys.set(id, proc);
  return { ok: true };
}
ipcMain.handle('pty:create', (_e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) return { ok: true, existed: true };
  return spawnPtyFor(id, cwd, cols, rows);
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
  try {
    const full = path.join(parent, name);
    await fs.promises.mkdir(full, { recursive: false });
    return { path: full, name };
  } catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('fs:exists', (_e, p) => { try { return fs.existsSync(p); } catch { return false; } });

// create a file or directory inside parent
ipcMain.handle('fs:create', async (_e, { parent, name, dir }) => {
  try {
    const full = path.join(parent, name);
    if (fs.existsSync(full)) return { error: 'уже существует' };
    if (dir) await fs.promises.mkdir(full, { recursive: false });
    else { await fs.promises.mkdir(path.dirname(full), { recursive: true }); await fs.promises.writeFile(full, '', { flag: 'wx' }); }
    return { path: full, name, dir: !!dir };
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
