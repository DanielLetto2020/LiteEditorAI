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
  // Forward renderer-side errors/events to the main-process file log.
  log: (level, ...args) => ipcRenderer.send('log:renderer', { level, args }),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximizeToggle: () => ipcRenderer.send('win:maximizeToggle'),
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

  logs: {
    list: () => ipcRenderer.invoke('logs:list'),
    read: (name) => ipcRenderer.invoke('logs:read', name),
  },

  openrouter: {
    models: (key) => ipcRenderer.invoke('openrouter:models', { key }),
    keyInfo: (key) => ipcRenderer.invoke('openrouter:keyInfo', { key }),
    histGet: (id) => ipcRenderer.invoke('openrouter:histGet', id),
    histSet: (id, messages) => ipcRenderer.invoke('openrouter:histSet', { id, messages }),
    chatStart: (opts) => ipcRenderer.send('openrouter:chatStart', opts),
    chatAbort: (reqId) => ipcRenderer.send('openrouter:chatAbort', { reqId }),
    onChunk: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('openrouter:chunk', h); return () => ipcRenderer.removeListener('openrouter:chunk', h); },
    onDone: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('openrouter:done', h); return () => ipcRenderer.removeListener('openrouter:done', h); },
    onError: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('openrouter:error', h); return () => ipcRenderer.removeListener('openrouter:error', h); },
  },

  settings: {
    export: () => ipcRenderer.invoke('settings:export'),  // → { ok, file, dir } | { canceled } | { error }
    import: () => ipcRenderer.invoke('settings:import'),  // → { ok, file } | { canceled } | { error }
  },

  git: {
    status: (root) => ipcRenderer.invoke('git:status', root),
    fileDiff: (root, file) => ipcRenderer.invoke('git:fileDiff', { root, file }),
    info: (root) => ipcRenderer.invoke('git:info', root),
    init: (root) => ipcRenderer.invoke('git:init', root),
    clone: (root, url) => ipcRenderer.invoke('git:clone', { root, url }),
    commit: (root, message, push) => ipcRenderer.invoke('git:commit', { root, message, push }),
    push: (root) => ipcRenderer.invoke('git:push', root),
    pull: (root) => ipcRenderer.invoke('git:pull', root),
    fetch: (root) => ipcRenderer.invoke('git:fetch', root),
    checkout: (root, branch) => ipcRenderer.invoke('git:checkout', { root, branch }),
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
