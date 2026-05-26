// LiteEditor — Electron main process.
// Thin backend: project picker, PTY lifecycle, file ops, window controls.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

app.setName('LiteEditor');

// Electron installed via npm ships no root-owned setuid sandbox helper, so the
// Chromium SUID sandbox aborts at launch. We load only our own local content,
// and the renderer already gets a shell via PTY, so the sandbox adds nothing.
app.commandLine.appendSwitch('no-sandbox');
// GPU accel is pointless for a terminal/text app and often unavailable on
// VM/nested/VNC displays (silent launch crash). Software render = opens everywhere.
app.disableHardwareAcceleration();

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

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', 'target', '.cache', '.idea',
]);
const MAX_VIEW_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------- window state
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(partial) {
  try { fs.writeFileSync(stateFile, JSON.stringify({ ...loadState(), ...partial })); } catch (_) {}
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
    backgroundColor: '#0a120d',
    title: 'LiteEditor',
    frame: false,
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
    tray.setToolTip('LiteEditor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Показать LiteEditor', click: showWindow },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

app.whenReady().then(() => {
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
ipcMain.on('win:fullscreen', () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()));
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));
ipcMain.on('win:show', showWindow);

// Reflect how many agents need attention on the tray tooltip (and macOS title).
ipcMain.on('tray:update', (_e, { attention } = {}) => {
  const n = attention || 0;
  if (tray) tray.setToolTip(n > 0 ? `LiteEditor — ${n} ждут ответа` : 'LiteEditor');
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
ipcMain.handle('pty:create', (_e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) return { ok: true, existed: true };
  const shell = resolveShell();
  let proc;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      env: { ...process.env, SHELL: shell }, // keep the env pointing at a real shell
    });
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data: `\r\n\x1b[31mНе удалось запустить шелл (${shell}): ${err.message}\x1b[0m\r\n` });
      mainWindow.webContents.send('pty:exit', { id });
    }
    return { error: String(err.message || err) };
  }
  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', { id, data });
  });
  proc.onExit(() => {
    ptys.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit', { id });
  });
  ptys.set(id, proc);
  return { ok: true };
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
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
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
