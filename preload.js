// Bridge between the sandboxed renderer and the main process: window.lite.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lite', {
  openProject: () => ipcRenderer.invoke('dialog:openProject'),
  // Modern replacement for the deprecated File.path (Electron 32+ / Windows-safe).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openInFileManager: (target) => ipcRenderer.invoke('shell:openPath', target),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximizeToggle: () => ipcRenderer.send('win:maximizeToggle'),
    fullscreen: () => ipcRenderer.send('win:fullscreen'),
    close: () => ipcRenderer.send('win:close'),
    show: () => ipcRenderer.send('win:show'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    growBy: (dx) => ipcRenderer.send('win:growBy', { dx }),
    onMaximizeChange: (cb) => {
      const h = (_e, v) => cb(v);
      ipcRenderer.on('win:maximized', h);
      return () => ipcRenderer.removeListener('win:maximized', h);
    },
  },

  tray: { update: (attention) => ipcRenderer.send('tray:update', { attention }) },

  store: {
    loadAll: () => ipcRenderer.sendSync('store:loadAll'),       // sync snapshot at startup
    set: (key, value) => ipcRenderer.send('store:set', { key, value }),
    notesGet: (id) => ipcRenderer.invoke('store:notesGet', id),
    notesSet: (id, notes) => ipcRenderer.invoke('store:notesSet', { id, notes }),
  },

  git: {
    status: (root) => ipcRenderer.invoke('git:status', root),
    fileDiff: (root, file) => ipcRenderer.invoke('git:fileDiff', { root, file }),
    info: (root) => ipcRenderer.invoke('git:info', root),
    init: (root) => ipcRenderer.invoke('git:init', root),
    commit: (root, message, push) => ipcRenderer.invoke('git:commit', { root, message, push }),
    push: (root) => ipcRenderer.invoke('git:push', root),
    pull: (root) => ipcRenderer.invoke('git:pull', root),
    fetch: (root) => ipcRenderer.invoke('git:fetch', root),
    checkout: (root, branch) => ipcRenderer.invoke('git:checkout', { root, branch }),
    createBranch: (root, branch) => ipcRenderer.invoke('git:createBranch', { root, branch }),
    branchUpdate: (root, branch, current) => ipcRenderer.invoke('git:branchUpdate', { root, branch, current }),
    branchCreate: (root, name, base, checkout) => ipcRenderer.invoke('git:branchCreate', { root, name, base, checkout }),
    discardFile: (root, file) => ipcRenderer.invoke('git:discardFile', { root, file }),
  },

  pty: {
    create: (opts) => ipcRenderer.invoke('pty:create', opts),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    restart: (opts) => ipcRenderer.invoke('pty:restart', opts),
    foregroundState: (id) => ipcRenderer.invoke('pty:foregroundState', { id }),
    onData: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('pty:data', h);
      return () => ipcRenderer.removeListener('pty:data', h);
    },
    onExit: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('pty:exit', h);
      return () => ipcRenderer.removeListener('pty:exit', h);
    },
  },

  fs: {
    readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
    readFile: (file) => ipcRenderer.invoke('fs:readFile', file),
    writeFile: (file, content) => ipcRenderer.invoke('fs:writeFile', { file, content }),
    mkdir: (parent, name) => ipcRenderer.invoke('fs:mkdir', { parent, name }),
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
    create: (parent, name, dir) => ipcRenderer.invoke('fs:create', { parent, name, dir }),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', { from, to }),
    trash: (target) => ipcRenderer.invoke('fs:trash', target),
    readDataUrl: (file) => ipcRenderer.invoke('fs:readDataUrl', file),
    watch: (root) => ipcRenderer.send('fs:watch', root),
    unwatch: (root) => ipcRenderer.send('fs:unwatch', root),
    onChange: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('fs:changed', h);
      return () => ipcRenderer.removeListener('fs:changed', h);
    },
  },
});
