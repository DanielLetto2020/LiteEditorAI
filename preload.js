// Bridge between the sandboxed renderer and the main process: window.lite.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lite', {
  platform: process.platform,   // 'win32' | 'linux' | 'darwin' — для платформо-зависимого UI (выбор шелла)
  openProject: () => ipcRenderer.invoke('dialog:openProject'),
  // Modern replacement for the deprecated File.path (Electron 32+ / Windows-safe).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openInFileManager: (target) => ipcRenderer.invoke('shell:openPath', target),
  openInBrowser: (target) => ipcRenderer.invoke('shell:openInBrowser', target),
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
    notesExport: (json, name) => ipcRenderer.invoke('notes:exportFile', { json, name }), // → {ok,file}|{canceled}|{error}
    notesImport: () => ipcRenderer.invoke('notes:importFile'),                            // → {ok,content}|{canceled}|{error}
  },

  logs: {
    list: () => ipcRenderer.invoke('logs:list'),
    read: (name) => ipcRenderer.invoke('logs:read', name),
    delete: (name) => ipcRenderer.invoke('logs:delete', name),
    clearOld: () => ipcRenderer.invoke('logs:clearOld'),
  },
  errors: {
    list: () => ipcRenderer.invoke('errors:list'),
    setStatus: (id, status, note, commit) => ipcRenderer.invoke('errors:setStatus', { id, status, note, commit }),
    clearResolved: () => ipcRenderer.invoke('errors:clearResolved'),
    setContext: (projectPath) => ipcRenderer.invoke('errors:setContext', projectPath),
    onChanged: (cb) => { const h = () => cb(); ipcRenderer.on('errors:changed', h); return () => ipcRenderer.removeListener('errors:changed', h); },
  },

  // Пользовательские модули (расширения): скан папки ~/.LiteEditorAI/modules + скаффолд нового модуля.
  ext: {
    scan: () => ipcRenderer.invoke('ext:scan'),
    scaffold: (opts) => ipcRenderer.invoke('ext:scaffold', opts),
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

  // Обработка текста: дефолтная папка документов + прогон фрагмента через локального агента.
  tp: {
    dir: () => ipcRenderer.invoke('tp:dir'),
    run: (opts) => ipcRenderer.send('tp:run', opts),
    abort: (reqId) => ipcRenderer.send('tp:abort', { reqId }),
    onDone: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('tp:done', h); return () => ipcRenderer.removeListener('tp:done', h); },
    onError: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('tp:error', h); return () => ipcRenderer.removeListener('tp:error', h); },
  },

  // «Контекст» — граф контекста агента (renderer/modules/contextgraph.js).
  ctx: {
    load: (projId, agent, profileId) => ipcRenderer.invoke('ctx:load', { projId, agent, profileId }),
    save: (projId, agent, graph, profileId) => ipcRenderer.invoke('ctx:save', { projId, agent, graph, profileId }),
    profiles: (projId, agent) => ipcRenderer.invoke('ctx:profiles', { projId, agent }),
    profileCreate: (projId, agent, name, fromId) => ipcRenderer.invoke('ctx:profileCreate', { projId, agent, name, fromId }),
    profileRename: (projId, agent, id, name) => ipcRenderer.invoke('ctx:profileRename', { projId, agent, id, name }),
    profileDelete: (projId, agent, id) => ipcRenderer.invoke('ctx:profileDelete', { projId, agent, id }),
    profileSetActive: (projId, agent, id) => ipcRenderer.invoke('ctx:profileSetActive', { projId, agent, id }),
    blockRead: (projId, projPath, node) => ipcRenderer.invoke('ctx:blockRead', { projId, projPath, node }),
    blockWrite: (projId, projPath, node, text) => ipcRenderer.invoke('ctx:blockWrite', { projId, projPath, node, text }),
    blockDelete: (projId, projPath, node) => ipcRenderer.invoke('ctx:blockDelete', { projId, projPath, node }),
    compile: (opts) => ipcRenderer.invoke('ctx:compile', opts),
    assembleText: (projId, projPath, agent, profileId) => ipcRenderer.invoke('ctx:assembleText', { projId, projPath, agent, profileId }),
    snapshotOutput: (projId, projPath, agent, name) => ipcRenderer.invoke('ctx:snapshotOutput', { projId, projPath, agent, name }),
    watchOutputs: (projId, projPath) => ipcRenderer.send('ctx:watchOutputs', { projId, projPath }),
    unwatchOutputs: (projId) => ipcRenderer.send('ctx:unwatchOutputs', { projId }),
    onOutputChanged: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('ctx:outputChanged', h); return () => ipcRenderer.removeListener('ctx:outputChanged', h); },
    exportFile: (projId, projPath, agent, profileId) => ipcRenderer.invoke('ctx:exportFile', { projId, projPath, agent, profileId }),
    points: (projId, agent) => ipcRenderer.invoke('ctx:points', { projId, agent }),
    pointRead: (projId, agent, id) => ipcRenderer.invoke('ctx:pointRead', { projId, agent, id }),
    pointDelete: (projId, agent, id) => ipcRenderer.invoke('ctx:pointDelete', { projId, agent, id }),
    pointSetOriginal: (projId, agent, id) => ipcRenderer.invoke('ctx:pointSetOriginal', { projId, agent, id }),
    snapshotOriginal: (projId, projPath, agent) => ipcRenderer.invoke('ctx:snapshotOriginal', { projId, projPath, agent }),
    backupDir: (projPath, dir) => ipcRenderer.invoke('ctx:backupDir', { projPath, dir }),
    backupMove: (projPath, from, to) => ipcRenderer.invoke('ctx:backupMove', { projPath, from, to }),
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'), // latest GitHub release → {tag,name,notes,url} | {error}
  },

  settings: {
    export: () => ipcRenderer.invoke('settings:export'),  // → { ok, file, dir } | { canceled } | { error }
    import: () => ipcRenderer.invoke('settings:import'),  // → { ok, file } | { canceled } | { error }
  },

  // Удалённый пульт (Android): аккаунт логин/пароль вместо токена.
  remote: {
    status: () => ipcRenderer.invoke('remote:status'),
    register: (login, password, host) => ipcRenderer.invoke('remote:register', { login, password, host }),
    login: (login, password, host) => ipcRenderer.invoke('remote:login', { login, password, host }),
    logout: () => ipcRenderer.invoke('remote:logout'),
    revokeAllDevices: () => ipcRenderer.invoke('remote:revokeAllDevices'),   // «выйти на всех устройствах»
    setEnabled: (enabled) => ipcRenderer.invoke('remote:setEnabled', { enabled }),
    activeChanged: (sid) => ipcRenderer.send('remote:activeChanged', { sid }),               // десктоп → пульт: какая вкладка активна
    onSelect: (cb) => { const h = (_e, p) => cb(p && p.sid); ipcRenderer.on('remote:select', h); return () => ipcRenderer.removeListener('remote:select', h); }, // пульт → десктоп: переключить вкладку
    onOpenProject: (cb) => { const h = (_e, p) => cb(p && p.projId); ipcRenderer.on('remote:openProject', h); return () => ipcRenderer.removeListener('remote:openProject', h); }, // пульт → десктоп: открыть терминал проекта
    onCloseTab: (cb) => { const h = (_e, p) => cb(p && p.sid); ipcRenderer.on('remote:closeTab', h); return () => ipcRenderer.removeListener('remote:closeTab', h); }, // пульт → десктоп: закрыть вкладку
    onNewFolder: (cb) => { const h = (_e, p) => cb(p && p.name); ipcRenderer.on('remote:newFolder', h); return () => ipcRenderer.removeListener('remote:newFolder', h); }, // пульт → десктоп: создать папку
    // Pairing: пульт просит одобрить устройство → показать модалку; ответ — approve/deny.
    onPairRequest: (cb) => { const h = (_e, p) => cb(p || {}); ipcRenderer.on('remote:pairRequest', h); return () => ipcRenderer.removeListener('remote:pairRequest', h); },
    pairApprove: (device) => ipcRenderer.send('remote:pairApprove', { device }),
    pairDeny: (device) => ipcRenderer.send('remote:pairDeny', { device }),
    // Подключённые пульты: список/блок-лист (бейдж у версии + модалка «Пульты»).
    pults: () => ipcRenderer.invoke('remote:pults'),
    pultBlock: (device) => ipcRenderer.invoke('remote:pultBlock', { device }),
    pultUnblock: (device) => ipcRenderer.invoke('remote:pultUnblock', { device }),
    pultSysInfo: (device, what) => ipcRenderer.send('remote:pultSysInfo', { device, what }),   // what: 'info'|'geo'; ответ — событием onSysInfo
    onPults: (cb) => { const h = (_e, p) => cb(p || {}); ipcRenderer.on('remote:pults', h); return () => ipcRenderer.removeListener('remote:pults', h); },
    onSysInfo: (cb) => { const h = (_e, p) => cb(p || {}); ipcRenderer.on('remote:sysinfo', h); return () => ipcRenderer.removeListener('remote:sysinfo', h); },
  },

  audit: {
    scan: (root, opts) => ipcRenderer.invoke('audit:scan', { root, opts }), // → агрегаты | { error }
    export: (content, defaultName) => ipcRenderer.invoke('audit:export', { content, defaultName }), // → {ok,file}|{canceled}|{error}
  },

  // IterFlow — таск-трекер исполнителя через /api/editor/* (см. renderer/modules/iterflow.js).
  // Все ответы — { ok, data } | { ok:false, error[, unauth] }. Токен живёт в main, сюда не приходит.
  iterflow: {
    login: (email, password) => ipcRenderer.invoke('iterflow:login', { email, password }), // → {ok,data:{user,profiles,teams}}
    logout: () => ipcRenderer.invoke('iterflow:logout'),
    session: () => ipcRenderer.invoke('iterflow:session'),                                  // → {ok,data:{authed,user?,profiles?,teams?}}
    counterparties: (ctx) => ipcRenderer.invoke('iterflow:counterparties', { ctx }),        // ctx = 'solo:<id>' | 'team:<id>'
    counterpartyProjects: (cpId) => ipcRenderer.invoke('iterflow:counterpartyProjects', { cpId }),
    projectIterations: (projectId) => ipcRenderer.invoke('iterflow:projectIterations', { projectId }),
    iterationTasks: (iterationId) => ipcRenderer.invoke('iterflow:iterationTasks', { iterationId }),
    setTaskKanban: (taskId, status) => ipcRenderer.invoke('iterflow:setTaskKanban', { taskId, status }), // только active + исполнитель
    projectNotes: (projectId) => ipcRenderer.invoke('iterflow:projectNotes', { projectId }),         // туду (веб-cookie)
    projectMessages: (projectId) => ipcRenderer.invoke('iterflow:projectMessages', { projectId }),   // общий чат (веб-cookie)
    // CRUD + жизненный цикл — через веб-cookie (editor-группа write не умеет). web401 → перелогин.
    createIteration: (projectId, body) => ipcRenderer.invoke('iterflow:createIteration', { projectId, body }),
    renameIteration: (id, title) => ipcRenderer.invoke('iterflow:renameIteration', { id, title }),
    setIterationDeadline: (id, deadline) => ipcRenderer.invoke('iterflow:setIterationDeadline', { id, deadline }),
    deleteIteration: (id) => ipcRenderer.invoke('iterflow:deleteIteration', { id }),
    iterationStage: (id, action, body) => ipcRenderer.invoke('iterflow:iterationStage', { id, action, body }),
    createTask: (iterationId, body) => ipcRenderer.invoke('iterflow:createTask', { iterationId, body }),
    updateTask: (id, body) => ipcRenderer.invoke('iterflow:updateTask', { id, body }),
    toggleTaskDone: (id) => ipcRenderer.invoke('iterflow:toggleTaskDone', { id }),
    deleteTask: (id) => ipcRenderer.invoke('iterflow:deleteTask', { id }),
    createNote: (projectId, body) => ipcRenderer.invoke('iterflow:createNote', { projectId, body }),
    updateNote: (noteId, body) => ipcRenderer.invoke('iterflow:updateNote', { noteId, body }),
    deleteNote: (noteId) => ipcRenderer.invoke('iterflow:deleteNote', { noteId }),
    reorderNotes: (projectId, ids) => ipcRenderer.invoke('iterflow:reorderNotes', { projectId, ids }),
  },

  seo: {
    scan: (url) => ipcRenderer.invoke('seo:scan', { url }),                     // → быстрый отчёт (Node) | { error }
    render: (url) => ipcRenderer.invoke('seo:render', { url }),                 // → глубокий аудит (скрытый Chromium): DOM/метрики/сеть/скриншоты
    links: (urls, base) => ipcRenderer.invoke('seo:links', { urls, base }),     // → { checked, broken[] } проверка ссылок (отдельный этап)
    devServers: () => ipcRenderer.invoke('seo:devServers'),                     // → { ports:[...] } локальные dev-серверы
    export: (content, defaultName) => ipcRenderer.invoke('seo:export', { content, defaultName }), // → {ok,file}|{canceled}|{error}
  },

  git: {
    status: (root) => ipcRenderer.invoke('git:status', root),
    fileDiff: (root, file) => ipcRenderer.invoke('git:fileDiff', { root, file }),
    info: (root) => ipcRenderer.invoke('git:info', root),
    log: (root, limit) => ipcRenderer.invoke('git:log', { root, limit }),
    init: (root) => ipcRenderer.invoke('git:init', root),
    clone: (root, url) => ipcRenderer.invoke('git:clone', { root, url }),
    commit: (root, message, push, files) => ipcRenderer.invoke('git:commit', { root, message, push, files }),
    add: (root, files) => ipcRenderer.invoke('git:add', { root, files }),
    conflicts: (root) => ipcRenderer.invoke('git:conflicts', root),
    merge: (root, branch) => ipcRenderer.invoke('git:merge', { root, branch }),
    mergeAbort: (root) => ipcRenderer.invoke('git:mergeAbort', root),
    push: (root) => ipcRenderer.invoke('git:push', root),
    pull: (root) => ipcRenderer.invoke('git:pull', root),
    fetch: (root) => ipcRenderer.invoke('git:fetch', root),
    checkout: (root, branch) => ipcRenderer.invoke('git:checkout', { root, branch }),
    branchUpdate: (root, branch, current) => ipcRenderer.invoke('git:branchUpdate', { root, branch, current }),
    branchCreate: (root, name, base, checkout) => ipcRenderer.invoke('git:branchCreate', { root, name, base, checkout }),
    discardFile: (root, file) => ipcRenderer.invoke('git:discardFile', { root, file }),
    discardAll: (root) => ipcRenderer.invoke('git:discardAll', root),
    stash: (root) => ipcRenderer.invoke('git:stash', root),
    stashPop: (root) => ipcRenderer.invoke('git:stashPop', root),
  },

  containers: {
    detect: () => ipcRenderer.invoke('containers:detect'),
    list: (engine) => ipcRenderer.invoke('containers:list', { engine }),
    action: (engine, kind, action, id) => ipcRenderer.invoke('containers:action', { engine, kind, action, id }),
    bulk: (engine, action, ids) => ipcRenderer.invoke('containers:bulk', { engine, action, ids }),
    logsStart: (engine, id, streamId, tail) => ipcRenderer.invoke('containers:logsStart', { engine, id, streamId, tail }),
    logsStop: (streamId) => ipcRenderer.send('containers:logsStop', { streamId }),
    onLogsData: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('containers:logsData', h); return () => ipcRenderer.removeListener('containers:logsData', h); },
    onLogsExit: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('containers:logsExit', h); return () => ipcRenderer.removeListener('containers:logsExit', h); },
    execStart: (engine, id, execId, cols, rows) => ipcRenderer.invoke('containers:execStart', { engine, id, execId, cols, rows }),
    execWrite: (execId, data) => ipcRenderer.send('containers:execWrite', { execId, data }),
    execResize: (execId, cols, rows) => ipcRenderer.send('containers:execResize', { execId, cols, rows }),
    execKill: (execId) => ipcRenderer.send('containers:execKill', { execId }),
    onExecData: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('containers:execData', h); return () => ipcRenderer.removeListener('containers:execData', h); },
    onExecExit: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('containers:execExit', h); return () => ipcRenderer.removeListener('containers:execExit', h); },
  },

  db: {
    list: () => ipcRenderer.invoke('db:list'),
    save: (conn) => ipcRenderer.invoke('db:save', { conn }),
    delete: (id) => ipcRenderer.invoke('db:delete', { id }),
    test: (conn) => ipcRenderer.invoke('db:test', { conn }),
    schema: (id) => ipcRenderer.invoke('db:schema', { id }),
    tableData: (id, schema, table, opts) => ipcRenderer.invoke('db:tableData', { id, schema, table, ...(opts || {}) }),
    query: (id, sql) => ipcRenderer.invoke('db:query', { id, sql }),
    saveText: (defaultName, text) => ipcRenderer.invoke('db:saveText', { defaultName, text }),
    openText: () => ipcRenderer.invoke('db:openText'),
  },
  // RemoteHost module — SSH connection profiles + live shell sessions.
  rh: {
    list: () => ipcRenderer.invoke('rh:list'),
    save: (conn) => ipcRenderer.invoke('rh:save', { conn }),
    delete: (id) => ipcRenderer.invoke('rh:delete', { id }),
    test: (conn) => ipcRenderer.invoke('rh:test', { conn }),
    open: (sessionId, id, cols, rows) => ipcRenderer.invoke('rh:open', { sessionId, id, cols, rows }),
    write: (sessionId, data) => ipcRenderer.send('rh:write', { sessionId, data }),
    resize: (sessionId, cols, rows) => ipcRenderer.send('rh:resize', { sessionId, cols, rows }),
    close: (sessionId) => ipcRenderer.send('rh:close', { sessionId }),
    onData: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('rh:data', h); return () => ipcRenderer.removeListener('rh:data', h); },
    onExit: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('rh:exit', h); return () => ipcRenderer.removeListener('rh:exit', h); },
    fsList: (id, path) => ipcRenderer.invoke('rh:fsList', { id, path }),
    fsRead: (id, path) => ipcRenderer.invoke('rh:fsRead', { id, path }),
    fsClose: (id) => ipcRenderer.send('rh:fsClose', { id }),
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
