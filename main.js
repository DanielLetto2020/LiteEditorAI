// LiteEditor — Electron main process.
// Thin backend: project picker, PTY lifecycle, file ops, window controls.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, Tray, nativeImage, crashReporter, safeStorage, Notification } = require('electron');
const i18n = require('./lib/i18n');   // локализация: словари — подключаемые файлы locales/*.json
const rhBackend = require('./lib/remotehost');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { isUtf8 } = require('buffer');
const pty = require('node-pty');
const logger = require('./logger');
const { safeChildName } = require('./lib/safe-name'); // анти-traversal для имён папок/файлов
const { resolveShell: resolveShellPure } = require('./lib/shell'); // выбор оболочки терминала
const { resolveAgyBin, buildAgyArgs, wrapAgyPrompt, parseAgyModelsOutput, parseAgyStreamLine } = require('./lib/dbai-agy');
const updater = require('./lib/updater');  // самообновление: проверка релиза, загрузка, подмена каталога
const { watchTree } = require('./lib/tree-watch'); // слежение за деревом проекта (на Linux — по наблюдению на каталог)
const { watchGitLite } = require('./lib/git-watch'); // лёгкое слежение за .git для чипа ветки без обхода всего дерева
const gitignore = require('./lib/gitignore');      // компиляция и кэш правил .gitignore проекта
const { createHistory } = require('./lib/history'); // локальная история файлов: снимки, троттл, срок и объём
const { createBatcher, createFlowGate } = require('./lib/ptybatch'); // склейка вывода PTY + watermark flow-control
const { createRingStore } = require('./lib/ptyring'); // кольцевой буфер вывода PTY для бесшовного подхвата вкладок
const {
  WRITE_TMP_SUFFIX, STORE_KEYS, PATCH_KEYS, rendererStoreKey,
  atomicWriteSync, readJsonForEdit: readJsonForEditRaw, createStore,
} = require('./lib/store'); // in-memory кэш STORE + коалесируемая атомарная запись
const { createProcService } = require('./lib/proc-service'); // фоновый worker_threads для опроса /proc (индикаторы PTY + монитор)
const { summarizeBusyPtys } = require('./lib/quit-guard'); // проверка живых агентов/команд в PTY перед закрытием редактора
const fastSearch = require('./lib/fast-search');   // быстрый листинг и поиск через системный rg с фолбэком в worker_threads
const { createModuleRouter, createLazyIpc } = require('./lib/module-router'); // единый роутер готовности модулей + ленивая загрузка IPC
const { normalizeProjTermSnapshot, collectLiveSessionIds } = require('./lib/projterm-state'); // снапшоты и живые сессии вынесенных окон терминалов
const { registerGitIpc } = require('./lib/ipc/git');
const { registerPomodoroIpc } = require('./lib/ipc/pomodoro');
const { registerKeepassIpc, KEEPASS_HANDLES, KEEPASS_ONS } = require('./lib/ipc/keepass');
const { registerSitemonIpc } = require('./lib/ipc/sitemon');
const { registerAuditIpc, AUDIT_HANDLES } = require('./lib/ipc/audit');
const { registerIterflowIpc, ITERFLOW_HANDLES } = require('./lib/ipc/iterflow');
const { registerSeoIpc, SEO_HANDLES } = require('./lib/ipc/seo');
const { registerContainersIpc, CONTAINERS_HANDLES, CONTAINERS_ONS } = require('./lib/ipc/containers');
const { registerVoiceIpc } = require('./lib/ipc/voice');
const { createMcpHub } = require('./lib/mcp/hub');
const procService = createProcService({ cacheTtlMs: 200 });

app.setName('LiteEditorAI');
app.setAppUserModelId('com.mletto.liteeditorai'); // Windows: имя/иконка/группировка в панели задач и уведомлениях

// Один экземпляр на пользователя. Второй запуск (повторный клик по ярлыку) поднимал полный второй
// редактор: свои PTY для тех же проектов, и оба перезаписывали projects.json, projTabs.json и
// settings.json целиком — побеждала последняя запись. Теперь второй процесс отдаёт фокус первому
// и выходит сразу, ДО любых чтений и записей стора. Лок привязан к каталогу userData, поэтому
// изолированные прогоны с другим HOME (smoke, тесты) живому редактору не мешают. Апдейтер и
// app.relaunch() ждут смерти старого процесса — лок к тому моменту свободен.
if (!app.requestSingleInstanceLock()) {
  // process.exit, а не app.quit/app.exit: те выходят через цикл событий, и остальной код файла
  // (стор, логгер, таймеры, whenReady) успел бы выполниться. Первому экземпляру сообщение
  // second-instance уже доставлено внутри requestSingleInstanceLock.
  process.exit(0);
} else {
  app.on('second-instance', () => { try { showWindow(); } catch (_) {} });
}

// Capture native (C++) crashes — e.g. a GPU/renderer process abort, which on
// Linux shows up as "trap int3" in dmesg and closes the app with no dialog.
// uploadToServer:false → minidumps stay local (userData/Crashpad), never sent.
try { crashReporter.start({ uploadToServer: false }); } catch (_) {}

// В установленном .deb пакет содержит root-owned SUID-хелпер chrome-sandbox (uid 0, mode 04755),
// поэтому песочница Chromium работает штатно. В dev-запуске из npm и в portable tar.gz (распакованном
// без root) SUID-бита нет, и на Ubuntu 24.04+ с ограничением userns старт упадёт без no-sandbox.
function hasConfiguredSandboxHelper() {
  if (!app.isPackaged) return false;
  try {
    const st = fs.statSync(path.join(path.dirname(process.execPath), 'chrome-sandbox'));
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch (_) {
    return false;
  }
}
if (process.env.LITE_NO_SANDBOX === '1' || !hasConfiguredSandboxHelper()) {
  app.commandLine.appendSwitch('no-sandbox');
}
// GPU accel powers the xterm WebGL renderer (smooth scroll) and is fine on real
// desktops. It only breaks on VM/nested/VNC displays — there set LITE_NO_GPU=1 to
// fall back to software rendering (xterm then uses the Canvas renderer).
if (process.env.LITE_NO_GPU === '1' || process.env.LITE_SOFTWARE_RENDER === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
/** @type {Electron.WebFrameMain | null} */
let filesDockFrame = null; // встроенный фрейм панели «Проект» внутри mainWindow (?embed=1#files)
let filesDockVisible = false; // открыта ли сейчас док-панель «Проект» на экране главного окна
function liveFilesDockFrame() {
  if (!filesDockFrame) return null;
  try {
    if (filesDockFrame.isDestroyed() || filesDockFrame.detached) { filesDockFrame = null; filesDockVisible = false; return null; }
    return filesDockFrame;
  } catch (_) { filesDockFrame = null; filesDockVisible = false; return null; }
}
function sendToFrame(frame, ch, payload) {
  if (!frame) return false;
  try {
    if (frame.isDestroyed() || frame.detached) return false;
    frame.send(ch, payload);
    return true;
  } catch (_) { return false; }
}
function isFilesDocked() { return !!(readSettingsCached() || {}).dockFiles; }
let tray = null;
// Virtual target width for win:growBy. Growth accumulates here UNCLAMPED, while the
// real setBounds is clamped to the screen edge — so a growth cut short by the edge is
// matched by an equal shrink and the window returns to its exact pre-grow size.
// growAppliedWidth = the last width we set ourselves; a resize to anything else means
// the user dragged the edge, so we forget the virtual width and start fresh from there.
let growDesiredWidth = null;
let growAppliedWidth = null;
const ptys = new Map();     // projectId -> IPty
const ptyFlows = new Map(); // sessionId -> FlowGate (pause/resume по watermark вывода в xterm)
const ptyRings = createRingStore(128 * 1024); // кольцевой хвост вывода живых PTY (128 КБ на сессию)
const watchers = new Map(); // project root path -> { watcher, timer, pending:Set } (полный обход дерева по требованию)
const gitWatchers = new Map(); // project root path -> watchGitLite (лёгкое слежение за .git для главного окна)
const watchedRoots = new Set(); // корни, запрошенные рендерером через fs:watch

// Resolve a shell that actually exists. $SHELL can point at a shell that was
// uninstalled (e.g. zsh removed), which makes node-pty fail with "execvp failed".
// Выбор оболочки терминала. Чистая логика — в lib/shell.js (тестируется); здесь тонкая обёртка:
// читает settings.shell из стора и инжектит платформу/env/проверку существования. { file, args }.
function resolveShell() {
  const selected = (readSettingsCached().shell) || '';
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
// Реализация — lib/proctree.js: обходит только потомков шелла, а не весь /proc.

const IGNORE_DIRS = gitignore.DEFAULT_IGNORE_DIRS;
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
const appStore = createStore({
  storeDir,
  logger,
  corruptMsg: (file) => i18n.t('Файл данных повреждён и не откладывается: {0}', file),
  flushDelayMs: 120,
});
function ensureStoreDir() { appStore.ensureDir(); }
function readStoreKey(key) { return appStore.readStoreKey(key); }
function readSettingsCached() { return appStore.readSettingsCached(); }
function writeStoreKey(key, value, opts) { return appStore.writeStoreKey(key, value, opts); }
ensureStoreDir();
process.on('exit', () => { try { appStore.flushAllSync(); } catch (_) {} });

function readJsonForEdit(file, fallback) {
  return readJsonForEditRaw(file, fallback, {
    log: (lvl, src, msg) => logger.log(lvl, src, msg),
    corruptMsg: (f) => i18n.t('Файл данных повреждён и не откладывается: {0}', f),
  });
}

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

// ── Тяжёлые бэкенды модулей (лениво подгружаются только при первом IPC-вызове) ───────────────
const dbLazy = createLazyIpc(ipcMain, {
  handles: [
    'db:list', 'db:save', 'db:delete', 'db:test', 'db:schema', 'db:tableData', 'db:tableMeta',
    'db:relations', 'db:columns', 'db:objects', 'db:objectDdl', 'db:objectInfo', 'db:fetchAll',
    'db:cancel', 'db:ping', 'db:reconnect', 'db:transaction', 'db:query', 'db:queryRo',
    'db:saveText', 'db:chooseDir', 'db:openText',
  ],
  load: (ipc) => require('./lib/db').registerDbIpc({
    ipcMain: ipc, safeStorage, dialog,
    getConnections: () => readStoreKey('dbConnections'),
    setConnections: (v) => writeStoreKey('dbConnections', v),
    findRhConn: (id) => rhApi.findConn(id),
  }),
});

createLazyIpc(ipcMain, {
  handles: [
    'kafka:list', 'kafka:save', 'kafka:delete', 'kafka:test', 'kafka:overview', 'kafka:topics',
    'kafka:topicDetail', 'kafka:createTopic', 'kafka:deleteTopic', 'kafka:addPartitions',
    'kafka:purgeTopic', 'kafka:setTopicConfig', 'kafka:groups', 'kafka:groupDetail',
    'kafka:resetOffsets', 'kafka:deleteGroup', 'kafka:peek', 'kafka:produce', 'kafka:tailStart',
  ],
  ons: ['kafka:tailStop'],
  load: (ipc) => require('./lib/kafka').registerKafkaIpc({
    ipcMain: ipc, safeStorage,
    getConnections: () => readStoreKey('kafkaConnections'),
    setConnections: (v) => writeStoreKey('kafkaConnections', v),
  }),
});

createLazyIpc(ipcMain, {
  handles: [
    'rmq:list', 'rmq:save', 'rmq:delete', 'rmq:test', 'rmq:overview', 'rmq:vhosts',
    'rmq:queues', 'rmq:exchanges', 'rmq:connections', 'rmq:peek', 'rmq:publish',
    'rmq:purge', 'rmq:deleteQueue', 'rmq:killConnection', 'rmq:tailStart',
  ],
  ons: ['rmq:tailStop'],
  load: (ipc) => require('./lib/rmq').registerRmqIpc({
    ipcMain: ipc, safeStorage,
    getConnections: () => readStoreKey('rmqConnections'),
    setConnections: (v) => writeStoreKey('rmqConnections', v),
  }),
});

createLazyIpc(ipcMain, {
  handles: [
    'st:list', 'st:save', 'st:delete', 'st:setScope', 'st:test', 'st:buckets', 'st:ls',
    'st:read', 'st:exists', 'st:presign', 'st:publicUrl', 'st:aclGet', 'st:aclSet',
    'st:mkdir', 'st:copy', 'st:rename', 'st:remove', 'st:removePrefix',
    'st:upload', 'st:download', 'st:downloadPrefix', 'st:stage', 'st:pickUploads', 'st:pickDownloadDir',
  ],
  ons: ['st:cancel'],
  load: (ipc) => require('./lib/storage').registerStorageIpc({
    ipcMain: ipc, safeStorage, dialog,
    getConnections: () => readStoreKey('stConnections'),
    setConnections: (v) => writeStoreKey('stConnections', v),
    stageDir: () => viewStageDir(),
  }),
});

createLazyIpc(ipcMain, {
  handles: [
    'jira:list', 'jira:save', 'jira:delete', 'jira:test', 'jira:searchAll', 'jira:issue',
    'jira:fields', 'jira:meta', 'jira:boards', 'jira:transition', 'jira:comment',
    'jira:recon', 'jira:reconSave',
  ],
  load: (ipc) => require('./lib/jira').registerJiraIpc({
    ipcMain: ipc, safeStorage, storeDir,
    getAccounts: () => readStoreKey('jiraAccounts'),
    setAccounts: (v) => writeStoreKey('jiraAccounts', v),
  }),
});

// Ключи SSH-хостов (TOFU + ~/.ssh/known_hosts) для всех ssh2-подключений: «Удалённые хосты», пул
// «Серверов», туннели «Баз данных». Закрепление и отказ уходят во ВСЕ окна событием rh:hostKey —
// окно «Удалённые хосты» показывает отпечаток и предлагает принять новый ключ.
require('./lib/hostkeys').init({
  get: () => readStoreKey('sshHostKeys'),
  set: (v) => writeStoreKey('sshHostKeys', v),
  onEvent: (ev) => {
    logger.log(ev.kind === 'mismatch' ? 'warn' : 'info', 'hostkey', `${ev.kind} ${ev.hp} ${ev.fp}${ev.expected ? ' (ожидался ' + ev.expected + ')' : ''} [${ev.source}]`);
    sendTo(mainWindow, 'rh:hostKey', ev);
    for (const w of moduleWindows.values()) sendTo(w, 'rh:hostKey', ev);
  },
});

// «RemoteHost» backend (интерактивные SSH-сессии + safeStorage-секреты) — lib/remotehost.js.
// send() лениво ссылается на mainWindow (создаётся позже), вызывается только при живой сессии.
const rhApi = rhBackend.registerRemoteIpc({
  ipcMain, safeStorage,
  send: (ch, payload) => sendToOwner(payload && payload.id, ch, payload),
  onSessionOpen: (sessionId, sender) => { if (sessionId && sender) ownerBySession.set(sessionId, sender); },
  getConnections: () => readStoreKey('rhConnections'),
  setConnections: (v) => writeStoreKey('rhConnections', v),
});

/** @type {{ getPublic: () => any[] } | null} */
let sitemonApi = null;

// «Серверы» — дашборд серверов (lib/servers.js): опрос по постоянному SSH-соединению rhApi, проблемы с
// уведомлениями ОС (клик открывает окно на этом сервере), действия из белого списка.
const SRV_SEV_MARK = { crit: '🔴', warn: '🟡', ok: '✅' };
const serversApi = require('./lib/servers').register({
  ipcMain, rhApi, readStoreKey, writeStoreKey, storeDir,
  getSites: () => { try { return sitemonApi ? sitemonApi.getPublic() : []; } catch (_) { return []; } },
  broadcast: (ch, payload) => { for (const w of moduleWindows.values()) sendTo(w, ch, payload); },
  log: (lvl, src, msg) => logger.log(lvl, src, msg),
  notify: (s, sev, tpl, args) => {
    try {
      if (Notification.isSupported && !Notification.isSupported()) return;
      const n = new Notification({ title: (SRV_SEV_MARK[sev] || '') + ' ' + s.name, body: i18n.t(tpl, ...(args || [])), silent: false });
      n.on('click', () => openModuleWindow('servers', { serverId: s.id }));
      srvNotes.add(n); n.on('close', () => srvNotes.delete(n)); setTimeout(() => srvNotes.delete(n), 10 * 60 * 1000);
      n.show();
    } catch (_) {}
  },
});
const srvNotes = new Set(); // держим ссылку до клика: собранный GC Notification отвязывает обработчик click
app.on('will-quit', () => { try { serversApi.flush(); } catch (_) {} });

// ── MCP Store / Zero-Trust MCP Hub (lib/mcp/hub.js) ───────────────────────────────────────────
function mcpWhichBin(cmd) {
  const pathStr = (tpEnv().PATH || '');
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathStr.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch (_) {}
    }
  }
  return null;
}

function resolveProjectForPty(ptyId, cwd) {
  const projects = Array.isArray(readStoreKey('projects')) ? readStoreKey('projects') : [];
  const raw = String(ptyId || '');
  const sep = raw.indexOf('::');
  if (sep > 0) {
    const pid = raw.slice(0, sep);
    const p = projects.find((x) => x && x.id === pid);
    if (p) return { id: p.id, name: p.name || p.path || p.id };
    return { id: pid, name: cwd ? path.basename(cwd) : pid };
  }
  if (cwd) {
    const cNorm = path.resolve(String(cwd));
    const p = projects.find((x) => x && x.path && (cNorm === path.resolve(x.path) || cNorm.startsWith(path.resolve(x.path) + path.sep)));
    if (p) return { id: p.id, name: p.name || p.path || p.id };
  }
  return { id: '__global__', name: 'Общее' };
}

const mcpHub = createMcpHub({
  storeDir,
  readConfig: () => readStoreKey('mcpConfig'),
  writeConfig: (v) => writeStoreKey('mcpConfig', v),
  readBindings: () => readStoreKey('mcpBindings'),
  writeBindings: (v) => writeStoreKey('mcpBindings', v),
  getDbApi: () => dbLazy.ensure(),
  serversApi,
  rhApi,
  getContainersApi: () => containersLazy.ensure(),
  getProjects: () => (Array.isArray(readStoreKey('projects')) ? readStoreKey('projects') : []),
  broadcast: (ch, payload) => { sendTo(mainWindow, ch, payload); },
  hasUi: () => !!(mainWindow && !mainWindow.isDestroyed()),
  log: (lvl, src, msg) => logger.log(lvl, src, msg),
  whichBin: mcpWhichBin,
  cliEnv: () => tpEnv(),
});
mcpHub.registerIpc(ipcMain);

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
errledger.onChange(() => { sendTo(mainWindow, 'errors:changed'); });
errledger.watch();

ipcMain.on('store:loadAll', (e, opts) => {
  e.returnValue = appStore.loadSnapshot(opts || {}); // synchronous: reads from main's RAM cache
});
ipcMain.on('store:set', (_e, { key, value }) => { if (rendererStoreKey(key)) writeStoreKey(key, value, true); });
// settings пишут несколько окон, поэтому для него — патч по полям, а не объект целиком: иначе
// побеждала последняя запись из устаревшей копии окна (renderer/settings-sync.js). Вливаем патч
// в кэш/файл и рассылаем его остальным окнам — они применят его к своему объекту.
function broadcastStoreChange(msg, exceptWc, exceptFrame) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!exceptWc || w.webContents !== exceptWc || (exceptFrame && w.webContents.mainFrame !== exceptFrame)) {
      sendTo(w, 'store:changed', msg);
    }
  }
  const df = liveFilesDockFrame();
  if (df && df !== exceptFrame) sendToFrame(df, 'store:changed', msg);
}
function patchStoreKey(key, set, unset, exceptWc, exceptFrame) {
  const res = appStore.patchStoreKey(key, set, unset);
  broadcastStoreChange({ key: res.key, set: res.set, unset: res.unset }, exceptWc, exceptFrame);
}
ipcMain.on('store:patch', (e, { key, set, unset } = {}) => { if (PATCH_KEYS.has(key)) patchStoreKey(key, set, unset, e.sender, e.senderFrame); });
// Синхронный вариант — гарантирует запись на диск до выхода из рендерера (beforeunload).
ipcMain.on('store:setSync', (e, { key, value } = {}) => {
  if (rendererStoreKey(key)) writeStoreKey(key, value, { fromWindow: true, sync: true });
  e.returnValue = true;
});
ipcMain.handle('store:notesGet', (_e, id) => appStore.notesGet(id));
ipcMain.handle('store:notesSet', (_e, { id, notes }) => appStore.notesSet(id, notes));

// ── Напоминалки Календаря: тикер сканирует agenda/*.json, шлёт нативные уведомления ──
// Работает, пока редактор запущен (не демон). Гейт notifiedAt не даёт дублей/спама при рестарте.
const AGENDA_REMIND_MS = { at: 0, '10m': 600000, '1h': 3600000, '1d': 86400000 };
function agendaBroadcastChanged(id) {
  appStore.invalidateAgendaCounts(id);
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
// Показанные уведомления держим ссылкой до клика: объект Notification, собранный GC, отвязывает
// нативное уведомление от JS (деструктор снимает delegate), и клик по висящему в шторке уведомлению
// молча терялся — «Календарь» не открывался. По 'close' не отпускаем: на Windows он приходит по
// таймауту, а уведомление остаётся в Центре уведомлений и кликабельно. Держим последние 20.
const agendaNotifs = new Set();
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
    const drop = () => { agendaNotifs.delete(n); };
    n.on('click', () => { drop(); try { focusNotesCalendar(); } catch (_) {} });
    n.on('failed', drop);
    agendaNotifs.add(n);
    if (agendaNotifs.size > 20) agendaNotifs.delete(agendaNotifs.values().next().value);
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
    const w = fs.watch(path.join(storeDir, 'agenda'), (_event, filename) => {
      if (!filename || !String(filename).endsWith('.json')) return;
      const id = String(filename).slice(0, -5);
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => agendaBroadcastChanged(id), 150)); // дебаунс rename+change
    });
    // Каталог удалили/отмонтировали: без слушателя 'error' — uncaughtException (FATAL «сбой приложения»
    // в реестре ошибок) при уже мёртвом вотчере. Как в ctx:watchOutputs.
    w.on('error', (e) => { logger.log('warn', 'agenda', `слежение за agenda/ остановлено: ${(e && e.message) || e}`); try { w.close(); } catch (_) {} });
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
    // env: tpEnv() — как у всех запусков claude: у приложения из Dock/ярлыка PATH урезан, и CLI из
    // ~/.local/bin, Homebrew или nvm здесь не находился («CLI не найден», хотя в терминале он есть).
    try { cp = spawn('claude', args, { cwd: projPath || os.homedir(), env: tpEnv() }); }
    catch (e) { return finish({ ok: false, error: String(e.message || e) }); }
    // Без таймаута зависший `claude mcp add` (спросил что-то в stdin и ждёт) держал бы промис
    // IPC навсегда: кнопка в модалке крутилась бы вечно, процесс жил бы до выхода из редактора.
    to = setTimeout(() => { try { cp.kill(); } catch (_) {} finish({ ok: false, error: 'таймаут: «claude mcp add» не ответил за 30 с' }); }, 30000);
    if (cp.stdout) cp.stdout.setEncoding('utf8');   // русские сообщения CLI не бьются на стыке чанков
    if (cp.stderr) cp.stderr.setEncoding('utf8');
    cp.stdout && cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr && cp.stderr.on('data', (d) => { stderr += d; });
    cp.on('error', (err) => finish({ ok: false, error: err.code === 'ENOENT' ? 'CLI «claude» не найден в PATH' : String(err.message || err) }));
    cp.on('exit', (code) => finish(code === 0 ? { ok: true, out: stdout.trim() } : { ok: false, error: (stderr || stdout).trim() || ('claude завершился с кодом ' + code) }));
  });
});
ipcMain.handle('store:agendaGet', (_e, id) => appStore.agendaGet(id));
ipcMain.handle('store:agendaSet', (_e, { id, agenda }) => appStore.agendaSet(id, agenda));

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
ipcMain.handle('openrouter:histGet', (_e, id) => readJsonForEdit(orChatFile(id), []));
ipcMain.handle('openrouter:histSet', (_e, { id, messages } = {}) => {
  // Рендерер пишет сессии чата объектом { sessions, active } (массив — только старый формат и
  // очистка при удалении ключа). Пропуская лишь массив, main молча заменял сессии на [] — история
  // чатов не переживала закрытия окна.
  const doc = Array.isArray(messages) ? messages
    : (messages && Array.isArray(messages.sessions)) ? { sessions: messages.sessions, active: messages.active } : [];
  try {
    fs.mkdirSync(path.join(storeDir, 'orchats'), { recursive: true });
    atomicWriteSync(orChatFile(id), JSON.stringify(doc));
    return { ok: true };
  } catch (e) { return { error: String(e) }; }
});
ipcMain.handle('openrouter:models', async (_e, { key } = {}) => {
  return await new Promise((resolve) => {
    const req = https.request(OR_BASE + '/models', { method: 'GET', headers: orHeaders(key) }, (res) => {
      res.setEncoding('utf8'); // многобайтный символ на границе чанков не бьётся (см. openrouter:chatStart)
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
      // Обрыв посреди ответа: без 'end' и без 'error' у запроса промис не разрешался никогда.
      res.on('close', () => { if (!res.complete) resolve({ error: 'соединение прервано' }); });
    });
    req.on('error', (e) => resolve({ error: String(e.message || e) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'таймаут запроса моделей' }); });
    req.end();
  }).catch((e) => ({ error: String((e && e.message) || e) })); // синхронный бросок https.request (недопустимый символ в ключе) — тем же контрактом {error}
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
let updQuitCheck = false; // update:install ждёт ответа окон модулей о несохранённом
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
// Гейт от двойного вызова: фаза становится 'downloading' только ПОСЛЕ await fetchLatest, и автозагрузка
// при старте + клик по плашке в эту секунду запускали две загрузки в один и тот же .part.
let updDownloading = false;
ipcMain.handle('update:download', async () => {
  if (updState.phase === 'downloading' || updDownloading) return { ok: false, error: 'загрузка уже идёт' };
  updDownloading = true;
  try { return await updDownload(); }
  finally {
    updDownloading = false; updAbort = null;
    // Непредвиденный бросок не должен оставить плашку в «загрузке» навсегда.
    if (updState.phase === 'downloading') updSet({ phase: 'available', pct: 0 });
  }
});
async function updDownload() {
  const inst = updInstallInfo();
  if (!inst.canSelfUpdate) return { ok: false, error: inst.reason || 'эта установка не умеет обновляться сама' };

  const rel = await updater.fetchLatest();
  if (rel.error) return { ok: false, error: rel.error };
  if (!updater.verNewer(rel.tag, app.getVersion())) return { ok: false, error: 'у вас последняя версия' };
  const asset = updater.pickAsset(rel.assets, { ...inst, platform: process.platform, arch: process.arch });
  if (!asset) return { ok: false, error: 'в релизе нет файла для этой системы' };

  const dir = path.join(updater.updatesDir(storeDir), rel.tag);
  updAbort = {};
  // unpacking сбрасываем явно: после неудачной распаковки флаг оставался в состоянии, и повторная
  // загрузка всю дорогу показывала «распаковка…» вместо процентов.
  updSet({ phase: 'downloading', tag: rel.tag, pct: 0, size: asset.size, unpacking: false });
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
}

ipcMain.handle('update:cancel', () => {
  if (updAbort && updAbort.onAbort) { try { updAbort.onAbort(); } catch (_) {} }
  return { ok: true };
});

// Жёсткий выход под обновление. app.exit() не поднимает before-quit, поэтому его уборку делаем
// здесь: иначе реестр ошибок терял бы последние отложенные правки.
function updHardExit() {
  try { appStore.flushAllSync(); } catch (_) {}
  try { errledger.flush(); } catch (_) {}
  // Агенты дочерних модулей не должны пережить жёсткий выход под обновление.
  try { mcpHub.shutdown(); } catch (_) {}
  killReqMap(tpReqs); killReqMap(dbaiReqs); killReqMap(orReqs); killReqMap(ctxmineReqs);
  try { const api = dbLazy.getApi(); if (api) api.closeAll(); } catch (_) {}
  app.exit(0);
}

// Применить обновление и перезапуститься. После этого вызова приложение закрывается — ответ
// рендерер получает только при неудаче.
ipcMain.handle('update:install', async (e) => {
  if (!updStaged) return { ok: false, error: 'обновление ещё не загружено' };
  // Второй вызов (двойное подтверждение, второе окно) запустил бы второй стейджер/pkexec поверх первого.
  if (updState.phase === 'installing' || updQuitCheck) return { ok: false, error: 'установка уже идёт' };
  // Выход под обновление жёсткий (app.exit) и сносит окна модулей мимо их dirty-guard: безымянный
  // документ «Обработки текста» или правка удалённого файла пропали бы молча. Сначала спрашиваем окна.
  updQuitCheck = true;
  let go;
  try {
    const par = senderWin(e) || mainWindow;
    go = (await confirmDiscardUnsaved(par)) && (await confirmStopActiveTerminals(par));
  } finally { updQuitCheck = false; }
  if (!go) return { ok: false, canceled: true };
  const inst = updInstallInfo();
  updSet({ phase: 'installing' });

  if (inst.kind === 'deb') {
    const r = await updater.installDeb(updStaged.file);
    if (!r.ok) { updSet({ phase: 'ready', error: r.canceled ? '' : r.error }); return r; }
    logger.log('info', 'update', 'пакет установлен, перезапуск');
    app.relaunch();
    updHardExit();
    return { ok: true };
  }

  const script = updater.unixStager({
    pid: process.pid, appDir: inst.appDir, newDir: updStaged.root, exec: process.execPath,
    mac: false,
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
  setTimeout(updHardExit, 300);
  return { ok: true };
});
// Key balance: GET /key → credit limit + usage (so the card can show «израсходовано / лимит»).
ipcMain.handle('openrouter:keyInfo', async (_e, { key } = {}) => {
  return await new Promise((resolve) => {
    const req = https.request(OR_BASE + '/key', { method: 'GET', headers: orHeaders(key) }, (res) => {
      res.setEncoding('utf8'); // многобайтный символ на границе чанков не бьётся (см. openrouter:chatStart)
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
      res.on('close', () => { if (!res.complete) resolve({ error: 'соединение прервано' }); });
    });
    req.on('error', (e) => resolve({ error: String(e.message || e) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'таймаут' }); });
    req.end();
  }).catch((e) => ({ error: String((e && e.message) || e) }));
});
const orReqs = new Map(); // reqId -> ClientRequest (for abort)
ipcMain.on('openrouter:chatStart', (e, { reqId, key, model, messages, temperature } = {}) => {
  const sender = e.sender;
  const body = JSON.stringify({ model, messages, stream: true, ...(typeof temperature === 'number' ? { temperature } : {}) });
  let req;
  try {
    req = https.request(OR_BASE + '/chat/completions',
    { method: 'POST', headers: { ...orHeaders(key), 'Content-Length': Buffer.byteLength(body) } },
    (res) => {
      // Строки, а не Buffer: кириллица — два байта, и символ, разрезанный границей чанка, при
      // chunk.toString() превращался в «��» прямо в ответе модели. StringDecoder склеивает хвост.
      res.setEncoding('utf8');
      // Обрыв связи посреди стрима: 'end' не придёт, а у запроса нет 'error' (ответ уже начат) —
      // чат навсегда оставался в «отправке», запись в orReqs висела. После 'end'/abort — no-op.
      res.on('close', () => {
        if (res.complete || !orReqs.has(reqId)) return;
        orReqs.delete(reqId); safeSend(sender, 'openrouter:error', { reqId, error: 'соединение прервано' });
      });
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
  } catch (err) {
    // Символ вне latin1 в ключе (кириллица из-за раскладки) — https.request бросает синхронно. Без
    // ответа рендерер ждал бы done/error вечно, а «Стоп» не помогал: запроса нет в orReqs.
    safeSend(sender, 'openrouter:error', { reqId, error: String((err && err.message) || err) });
    return;
  }
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
  // codex в чате — через stdin («codex exec -», как в AI-DB): промпт несёт весь документ, а один
  // аргумент в Linux ограничен 128 КБ (≈64 тыс. русских букв) — spawn падал с E2BIG; к тому же argv
  // виден в `ps` любому пользователю системы. Агент-режим — аргументом: там только путь и задача.
  codex: { label: 'Codex', cmd: 'codex', args: ['exec', '-'], via: 'stdin', agentArgs: ['exec', '--full-auto'] },
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
// via/pty нормализуем, посторонние ключи из файла в spawn не утекают. user — записи файла
// (tp:saveAgents проверяет результат ещё ДО записи на диск).
function tpAgents(user = tpUserAgents()) {
  const out = {};
  for (const [id, c] of Object.entries(TP_BUILTIN_AGENTS)) out[id] = { id, ...c };
  for (const u of user) {
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
  // Проверяем, что после правки остаётся хоть один агент, ДО записи: раньше файл сохранялся и
  // только потом приходил отказ — «Отмена» в модалке оставляла на диске список без агентов, и
  // любой запрос в чате отвечал «не настроено ни одного агента».
  const list = Object.values(tpAgents(arr)).map((a) => ({ id: a.id, label: a.label, canAgent: Array.isArray(a.agentArgs) && a.agentArgs.length > 0 }));
  if (!list.length) return { ok: false, error: 'Так не остаётся ни одного агента — верните хотя бы одного' };
  ensureStoreDir();
  try { atomicWriteSync(TP_AGENTS_FILE(), JSON.stringify(arr, null, 2)); }
  catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
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
  if (loginPathTried) return;
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
  const extra = [
    loginPath,
    path.join(os.homedir(), '.local', 'bin'),
    path.dirname(process.execPath),
  ].filter(Boolean);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, PATH: extra.join(path.delimiter) + path.delimiter + (process.env.PATH || '') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LITEEDITOR_MCP_SOCK;
  delete env.LITEEDITOR_MCP_TOKEN;
  delete env.LITEEDITOR_MCP_SESSION;
  delete env.LITEEDITOR_MCP_AGENT;
  return env;
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
  agy: 'agy',            // авторизация CLI Antigravity
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
  // Декодируем поток целиком (StringDecoder): русский текст — по два байта на букву, и буква на
  // границе чанков при c.toString() превращалась в «��» и в чате, и в итоговом тексте для «Заменить».
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  // Агент вышел, не дочитав промпт (не авторизован, неверный флаг), а документ больше буфера
  // pipe (64 КБ) → асинхронный EPIPE на stdin. try/catch у write его не ловит, и без слушателя
  // это необработанное исключение главного процесса. Причину и так сообщат 'close'/'error'.
  child.stdin.on('error', () => {});
  let out = '', errOut = '';
  // Агент-режим обходит файлы и правит их — 4 минут ему мало; чат отвечает одним куском.
  const to = setTimeout(() => { if (tpReqs.has(reqId)) { tpReqs.delete(reqId); try { child.kill(); } catch (_) {} safeSend(sender, 'tp:error', { reqId, error: i18n.t('таймаут (агент не ответил вовремя)') }); } }, mode === 'agent' ? 900000 : 240000);
  child.stdout.on('data', (c) => { const chunk = c.toString('utf8'); out += chunk; safeSend(sender, 'tp:data', { reqId, chunk }); });
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  child.on('error', (err) => {
    clearTimeout(to);
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId);
    safeSend(sender, 'tp:error', { reqId, error: 'агент «' + conf.cmd + '» не найден/не запустился: ' + (err.message || err) });
  });
  child.on('close', (code) => {
    clearTimeout(to);   // и после «Стоп»/закрытия окна: иначе таймер до 15 мин держал процесс и весь вывод
    if (!tpReqs.has(reqId)) return; tpReqs.delete(reqId);
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
  // Промпт в аргументе (агент-режим, gemini) — stdin всё равно закрываем: CLI, который при не-TTY
  // stdin дочитывает его до EOF, чтобы приклеить к промпту (так работает `cat f | claude -p …`), с
  // открытым pipe ждал бы до таймаута в 4/15 минут. Пустой вход промпт из аргумента не меняет.
  else { try { child.stdin.end(); } catch (_) {} }
});

// Остановить работающего агента. В агент-режиме это не удобство, а необходимость: до сих пор
// запущенный процесс нельзя было прервать ничем, кроме таймаута, — а он в это время правит файлы.
// Бьём ровно по своему процессу (никаких групп и шаблонов имён), с добиванием, если не внял.
ipcMain.on('tp:cancel', (e, { reqId } = {}) => {
  const child = tpReqs.get(reqId);
  if (!child) return;
  tpReqs.delete(reqId);
  try { child.kill('SIGTERM'); } catch (_) {}
  // Жив ли процесс — по exitCode/signalCode: child.killed становится true сразу после УСПЕШНОЙ
  // отправки SIGTERM, и с проверкой !killed добивание не срабатывало никогда.
  setTimeout(() => { try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch (_) {} }, 3000);
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
  agy: { cmd: 'agy', args: [], stream: 'agy' },
};
// Транскрипты чатов AI-DB — по файлу на подключение. В общем dbUi они раздували стор: сессия
// хранит до 200 строк результата на сообщение, и весь этот объём переписывался при любом
// сохранении раскладки модуля. Формат файла: { sessions: [...], activeId }.
const dbaiDir = () => path.join(storeDir, 'dbai');
const dbaiCwd = () => path.join(storeDir, 'dbai-cwd');
const dbaiFile = (connId) => path.join(dbaiDir(), String(connId).replace(/[^\w.-]/g, '_') + '.json');
// Нет файла — null (истории ещё нет); битый — откладывается рядом, окно начинает с чистого листа;
// не прочитался — { error }: окно в него не пишет (см. readJsonForEdit).
ipcMain.handle('dbai:sessionsGet', (_e, { connId } = {}) => readJsonForEdit(dbaiFile(connId), null));
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
function stopDbaiProc(v) {
  try {
    if (v && typeof v.kill === 'function') {
      v.kill('SIGTERM');
      const t = setTimeout(() => {
        try { if (v.exitCode === null && v.signalCode === null) v.kill('SIGKILL'); } catch (_) {}
      }, 3000);
      if (typeof t.unref === 'function') t.unref();
    } else if (v && typeof v.destroy === 'function') {
      v.destroy();
    }
  } catch (_) {}
}
// Глушит карту in-flight задач разом: значение — ChildProcess (.kill) или ClientRequest/сокет (.destroy).
function killReqMap(m) {
  for (const v of m.values()) stopDbaiProc(v);
  m.clear();
}
// Запрос живёт, пока живо окно, которое его заказало. Каналом ходят «Базы данных» и «Мониторинг
// сайтов»; закрытие окна глушило только запросы окна БД (и заодно чужие), а агент закрытого
// «Мониторинга» жил до таймаута — до 5 минут работы и токенов впустую. Подписка — одна на окно.
const dbaiOwner = new Map();          // reqId → webContents-заказчик
const dbaiWatched = new WeakSet();    // окна, на чьё закрытие уже подписаны
function dbaiTrack(sender, reqId, req) {
  dbaiReqs.set(reqId, req);
  for (const id of [...dbaiOwner.keys()]) if (!dbaiReqs.has(id)) dbaiOwner.delete(id);   // завершённые
  dbaiOwner.set(reqId, sender);
  if (!sender || dbaiWatched.has(sender)) return;
  dbaiWatched.add(sender);
  try {
    sender.once('destroyed', () => {
      for (const [id, wc] of [...dbaiOwner]) {
        if (wc !== sender) continue;
        dbaiOwner.delete(id);
        const c = dbaiReqs.get(id); dbaiReqs.delete(id);
        stopDbaiProc(c);
      }
    });
  } catch (_) {}
}
let agyModelsCache = null;
let agyModelsCacheAt = 0;
ipcMain.handle('dbai:agyModels', async (_e, { force } = {}) => {
  const now = Date.now();
  if (!force && agyModelsCache && now - agyModelsCacheAt < 5 * 60 * 1000) {
    return { models: agyModelsCache };
  }
  const env = tpEnv();
  const cmd = resolveAgyBin({ env });
  let cwd = dbaiCwd();
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) { cwd = os.tmpdir(); }
  return await new Promise((resolve) => {
    const child = execFile(cmd, ['models'], { cwd, env, timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const combined = `${stdout || ''}\n${stderr || ''}`;
      if (err) {
        if (err.code === 'ENOENT') {
          resolve({ error: i18n.t('CLI Antigravity (agy) не найден. Установите agy и проверьте PATH.') });
          return;
        }
        const auth = tpAuthProblem('agy', combined + '\n' + (err.message || ''));
        if (auth) { resolve({ error: auth.error }); return; }
        resolve({ error: String((stderr || err.message || err)).trim().slice(0, 400) });
        return;
      }
      const models = parseAgyModelsOutput(combined);
      if (!models.length) {
        const auth = tpAuthProblem('agy', combined);
        if (auth) { resolve({ error: auth.error }); return; }
        resolve({ error: i18n.t('Список моделей Antigravity пуст — проверьте вход командой «agy» в терминале') });
        return;
      }
      agyModelsCache = models;
      agyModelsCacheAt = Date.now();
      resolve({ models });
    });
    try { child.stdin.end(); } catch (_) {}
  });
});
ipcMain.on('dbai:run', (e, { reqId, agent, prompt, model, effort } = {}) => {
  if (!reqId) return;
  const sender = e.sender;
  const conf = DBAI_AGENTS[agent] || DBAI_AGENTS.claude;
  const env = tpEnv();
  const isAgy = conf.stream === 'agy';
  let cmd = conf.cmd;
  let args = [...conf.args];
  let cwd = dbaiCwd();
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) { cwd = os.tmpdir(); }
  let stdinPayload = prompt || '';
  if (isAgy) {
    cmd = resolveAgyBin({ env });
    args = buildAgyArgs({ model, effort });
    stdinPayload = wrapAgyPrompt(prompt || '');
  }
  let child;
  try { child = spawn(cmd, args, { cwd, env }); }
  catch (err) { safeSend(sender, 'dbai:error', { reqId, error: 'не запустить «' + cmd + '»: ' + (err.message || err) }); return; }
  dbaiTrack(sender, reqId, child);
  // Декодируем поток целиком (StringDecoder): русская буква — два байта, и на границе чанков
  // c.toString() давал «��» в ответе агента (так же в tp:run/openrouter)
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let errOut = '', any = false, buf = '', sawDelta = false, streamErr = '', activeModel = String(model || '');
  const to = setTimeout(() => {
    if (!dbaiReqs.has(reqId)) return;
    dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
    stopDbaiProc(child);
    safeSend(sender, 'dbai:error', { reqId, error: 'таймаут (агент не ответил вовремя)' });
  }, 300000);
  const emit = (chunk) => { if (!chunk) return; any = true; safeSend(sender, 'dbai:data', { reqId, chunk }); };
  // extract incremental assistant text from a claude stream-json NDJSON line
  const handleClaudeLine = (line) => {
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
  const handleAgyLine = (line) => {
    const ev = parseAgyStreamLine(line);
    if (!ev) return;
    if (ev.kind === 'init') {
      if (!activeModel && ev.model) activeModel = ev.model;
    } else if (ev.kind === 'delta') {
      sawDelta = true;
      emit(ev.text);
    } else if (ev.kind === 'result') {
      if (ev.status && ev.status !== 'SUCCESS') {
        streamErr = ev.error || ('Antigravity завершился со статусом ' + ev.status);
        return;
      }
      if (!sawDelta && ev.text) emit(ev.text);
      if (ev.usage) safeSend(sender, 'dbai:usage', { reqId, model: activeModel || 'agy', usage: ev.usage });
    } else if (ev.kind === 'error') {
      streamErr = ev.error || 'Ошибка Antigravity';
    }
  };
  if (conf.stream === 'json' || isAgy) {
    const onLine = isAgy ? handleAgyLine : handleClaudeLine;
    child.stdout.on('data', (c) => { buf += c.toString('utf8'); let nl; while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
  } else {
    child.stdout.on('data', (c) => emit(c.toString('utf8')));
  }
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  // clearTimeout — до проверки: после «Стоп»/закрытия окна запроса в карте уже нет, а 5-минутный
  // таймер с замыканием на процесс и окно висел бы до срабатывания
  child.on('error', (err) => {
    clearTimeout(to);
    if (!dbaiReqs.has(reqId)) return;
    dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
    safeSend(sender, 'dbai:error', { reqId, error: 'агент «' + conf.cmd + '» не найден/не запустился: ' + (err.message || err) });
  });
  child.on('close', (code) => {
    clearTimeout(to);
    if (!dbaiReqs.has(reqId)) return;
    dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
    if ((conf.stream === 'json' || isAgy) && buf.trim()) {
      if (isAgy) handleAgyLine(buf);
      else handleClaudeLine(buf);
    }
    if (streamErr) {
      const auth = tpAuthProblem(conf.cmd, streamErr + '\n' + errOut);
      safeSend(sender, 'dbai:error', { reqId, error: auth ? auth.error : streamErr });
      return;
    }
    if (isAgy && code !== 0) {
      const auth = tpAuthProblem(conf.cmd, errOut);
      safeSend(sender, 'dbai:error', { reqId, error: auth ? auth.error : (errOut.trim() || ('агент завершился с кодом ' + code)) });
      return;
    }
    if (any) safeSend(sender, 'dbai:done', { reqId });
    else {
      const auth = tpAuthProblem(conf.cmd, errOut);
      safeSend(sender, 'dbai:error', { reqId, error: auth ? auth.error : (errOut.trim() || ('агент завершился с кодом ' + code)) });
    }
  });
  child.stdin.on('error', () => {});   // агент не стартовал/вышел раньше, чем дочитал промпт → async EPIPE не должен ронять main
  try { child.stdin.write(stdinPayload); child.stdin.end(); } catch (_) {}
});
ipcMain.on('dbai:abort', (e, { reqId } = {}) => {
  const c = dbaiReqs.get(reqId);
  if (c) { dbaiReqs.delete(reqId); dbaiOwner.delete(reqId); stopDbaiProc(c); safeSend(e.sender, 'dbai:done', { reqId, aborted: true }); }
});

// Generic OpenAI-compatible providers (OpenRouter / Ollama / LM Studio) for the AI-DB picker.
// baseUrl is everything before «/chat/completions» (e.g. http://localhost:11434/v1). All three
// share the OpenAI chat-completions wire format, so one path covers them; events reuse dbai:*.
function dbaiHttpMod(u) {
  if (u.protocol === 'https:') return https;
  if (u.protocol === 'http:') return http;
  throw new Error('поддерживаются только адреса http:// и https://');
}
ipcMain.handle('dbai:apiModels', async (_e, { baseUrl, key } = {}) => {
  return await new Promise((resolve) => {
    let u; try { u = new URL(String(baseUrl || '').replace(/\/+$/, '') + '/models'); } catch (_) { return resolve({ error: 'неверный адрес' }); }
    let mod; try { mod = dbaiHttpMod(u); } catch (err) { return resolve({ error: String(err.message || err) }); }
    const headers = { 'Accept': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) };
    let req;
    try {
      req = mod.request(u, { method: 'GET', headers }, (res) => {
        res.setEncoding('utf8');   // многобайтный символ на границе чанков не бьётся
        let data = ''; res.on('data', (c) => { data += c; });
        // обрыв посреди ответа даёт только 'close' без 'end' — иначе invoke висел бы вечно
        res.on('close', () => { if (!res.complete) resolve({ error: 'соединение с сервером оборвалось' }); });
        res.on('end', () => {
          try { const j = JSON.parse(data); if (res.statusCode >= 400) return resolve({ error: (j.error && j.error.message) || ('HTTP ' + res.statusCode) }); const models = (j.data || j.models || []).map((m) => ({ id: m.id || m.name, name: m.id || m.name })); resolve({ models }); }
          catch (_) { resolve({ error: 'не удалось разобрать список моделей (проверьте адрес/сервер)' }); }
        });
      });
      req.on('error', (e2) => resolve({ error: String(e2.message || e2) }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'таймаут (сервер недоступен)' }); });
      req.end();
    } catch (err) {
      resolve({ error: String((err && err.message) || err) });
    }
  });
});
ipcMain.on('dbai:apiRun', (e, { reqId, baseUrl, key, model, messages, usage, prompt } = {}) => {
  if (!reqId) return;
  const sender = e.sender;
  let u; try { u = new URL(String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions'); } catch (_) { safeSend(sender, 'dbai:error', { reqId, error: 'неверный адрес провайдера' }); return; }
  let mod; try { mod = dbaiHttpMod(u); } catch (err) { safeSend(sender, 'dbai:error', { reqId, error: String(err.message || err) }); return; }
  // Полноценный многоходовой диалог с ролью system: одним склеенным user-сообщением модель хуже
  // держит правила, а провайдер не может кешировать неизменную часть промпта (схему БД).
  // Одиночный prompt — прежний контракт канала: им шлёт «Мониторинг сайтов» (sitemon.js), и без
  // этого фолбэка модель получала пустое сообщение вместо задания.
  const msgs = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: String(prompt || '') }];
  const body = JSON.stringify({ model, messages: msgs, stream: true, ...(usage ? { stream_options: { include_usage: true } } : {}) });
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(key ? { Authorization: 'Bearer ' + key } : {}) };
  let req;
  try {
    req = mod.request(u, { method: 'POST', headers }, (res) => {
    res.setEncoding('utf8');   // SSE-кадры с русским текстом: буква на границе чанков иначе превращалась в «��»
      let buf = '', any = false, streamErr = '';
      res.on('close', () => {
        if (res.complete || !dbaiReqs.has(reqId)) return;
        dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
        safeSend(sender, 'dbai:error', { reqId, error: 'соединение с провайдером оборвалось посреди ответа' });
      });
      if (res.statusCode >= 400) {
        let err = '';
        res.on('data', (c) => { err += c; });
        res.on('end', () => {
          let msg = 'HTTP ' + res.statusCode;
          try { const j = JSON.parse(err); if (j.error && j.error.message) msg = j.error.message; } catch (_) {}
          if (!dbaiReqs.has(reqId)) return;
          dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
          safeSend(sender, 'dbai:error', { reqId, error: msg });
        });
        return;
      }
      const handleSseLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const j = JSON.parse(payload);
          if (j.error) { streamErr = (j.error && j.error.message) || String(j.error); return; }
          const ch = j.choices && j.choices[0];
          const delta = ch && ch.delta && ch.delta.content;
          if (delta) { any = true; safeSend(sender, 'dbai:data', { reqId, chunk: delta }); }
          // последний кадр со stream_options.include_usage несёт счётчики токенов
          if (j.usage) safeSend(sender, 'dbai:usage', { reqId, model: j.model || model, usage: j.usage });
        } catch (_) {}
      };
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8'); let idx;
        while ((idx = buf.indexOf('\n')) >= 0) { handleSseLine(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
      });
      res.on('end', () => {
        if (buf.trim()) handleSseLine(buf);
        if (!dbaiReqs.has(reqId)) return;
        dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
        if (streamErr) safeSend(sender, 'dbai:error', { reqId, error: streamErr });
        else if (any) safeSend(sender, 'dbai:done', { reqId });
        else safeSend(sender, 'dbai:error', { reqId, error: 'пустой ответ модели' });
      });
    });
    req.on('error', (err) => {
      if (!dbaiReqs.has(reqId)) return;
      dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
      safeSend(sender, 'dbai:error', { reqId, error: String(err.message || err) });
    });
    req.setTimeout(300000, () => {
      if (!dbaiReqs.has(reqId)) return;
      dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
      try { req.destroy(); } catch (_) {}
      safeSend(sender, 'dbai:error', { reqId, error: 'таймаут запроса' });
    });
    dbaiTrack(sender, reqId, req);
    req.write(body); req.end();
  } catch (err) {
    dbaiReqs.delete(reqId); dbaiOwner.delete(reqId);
    safeSend(sender, 'dbai:error', { reqId, error: String((err && err.message) || err) });
  }
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
  // Строки, а не Buffer: русская буква на стыке чанков при c.toString() давала «��» в правилах анализа.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { buf += c.toString('utf8'); let nl; while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
  child.stderr.on('data', (c) => { errOut += c.toString('utf8'); });
  child.on('error', (err) => { clearTimeout(to); if (!ctxmineReqs.has(reqId)) return; ctxmineReqs.delete(reqId); safeSend(sender, 'ctxmine:error', { reqId, error: 'claude не найден/не запустился: ' + ((err && err.message) || err) }); });
  child.on('close', (code) => {
    clearTimeout(to);   // и после «Отмены»/закрытия окна: иначе 5-минутный таймер держал процесс и весь дистиллят
    if (!ctxmineReqs.has(reqId)) return; ctxmineReqs.delete(reqId);
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
      // Пустым считаем ТОЛЬКО отсутствующий файл. Раньше любая ошибка чтения (EACCES, EMFILE…) тоже
      // давала cur = '', и запись «заголовок + буллеты» затирала весь существующий CLAUDE.md.
      let cur = '';
      try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      const bullets = arr.map((it) => {
        const t = String((it && it.title) || '').trim();
        const d = String((it && it.detail) || '').trim();
        return '- ' + t + (d ? '\n  ' + d.replace(/\n/g, '\n  ') : '');
      }).join('\n');
      const base = cur.replace(/\s*$/, '');
      let next = cur.includes(CTXMINE_APPLY_HEADER)
        ? base + '\n' + bullets + '\n'
        : (base ? base + '\n\n' : '') + CTXMINE_APPLY_HEADER + '\n' + bullets + '\n';
      if (/\r\n/.test(cur)) next = next.replace(/\r?\n/g, '\r\n');   // файл в CRLF — дописанное тоже, без смеси концов строк
      ctxbkPush(file, 'claude-file');   // как и любая перезапись из модуля — сначала копия (глобальный CLAUDE.md иначе без отката)
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
// Индексы корзины памяти и бэкапов (trash.json, index.json). Битый файл раньше читался как пустой
// список, и первая же запись затирала все прежние записи: файлы в корзине и копии оставались на диске,
// но восстановить их из окна было уже нечем. Теперь битый откладывается рядом (.corrupt-<время>),
// а нечитаемый (права, EMFILE) даёт null — тогда в индекс ничего не пишем.
function ctxListLoad(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { list: [] };
    logger.log('error', 'store', `не прочитать ${file}`, e);
    return null;
  }
  try { const d = JSON.parse(raw); if (d && Array.isArray(d.list)) return d; } catch (_) {}
  try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (_) { return null; }
  logger.log('warn', 'store', `повреждённый индекс отложен рядом: ${file}`);
  return { list: [] };
}
const CTX_INDEX_UNREADABLE = 'служебный список не читается — ничего не изменено, подробности в «Логах»';
function ctxmemTrashLoad() { return ctxListLoad(ctxmemTrashIndex()); }
function ctxmemTrashSave(d) { fs.mkdirSync(CTXMEM_TRASH, { recursive: true }); atomicWriteSync(ctxmemTrashIndex(), JSON.stringify(d, null, 1)); }
// Вырезать/вставить строку файла в MEMORY.md. Возвращает {line, pos} — что было вырезано и откуда.
// ctxmemIndexFind только ищет (ничего не пишет); ctxmemIndexCut вырезает найденное.
function ctxmemIndexFind(dir, file) {
  const f = path.join(dir, 'MEMORY.md');
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { return { line: '', pos: -1 }; }
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const pos = lines.findIndex((l) => { const m = l.match(/^\s*[-*]\s*\[.+?\]\((.+?)\)/); return m && m[1].trim() === file; });
  if (pos < 0) return { line: '', pos: -1 };
  return { line: lines[pos], pos, lines, f };
}
function ctxmemIndexCut(found) {
  if (!found || found.pos < 0) return;
  const lines = found.lines.slice();
  lines.splice(found.pos, 1);
  atomicWriteSync(found.f, lines.join('\n'));
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
  // Порядок — от безопасного к необратимому: копия в корзину → запись о ней → строка индекса →
  // исходник. Раньше строку MEMORY.md вырезали первой, и сбой копирования (ENOSPC) терял её
  // насовсем, а сбой записи trash.json оставлял файл в корзине без записи — восстановить нечем.
  const d = ctxmemTrashLoad();
  if (!d) return { ok: false, error: CTX_INDEX_UNREADABLE };
  const id = 'tm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const dst = path.join(CTXMEM_TRASH, id + '.md');
  let copied = false, recorded = false, found = null;
  try {
    fs.mkdirSync(CTXMEM_TRASH, { recursive: true });
    const text = fs.readFileSync(src, 'utf8');
    found = ctxmemIndexFind(dir, file);
    try { fs.writeFileSync(dst, text, { flag: 'wx' }); copied = true; }
    catch (e) { if (!e || e.code !== 'EEXIST') copied = true; throw e; }   // недописанную копию уберёт откат; чужую (EEXIST) не трогаем
    const { front } = ctxmemFront(text);
    d.list.push({ id, file, name: String(front.name || file.replace(/\.md$/i, '')), dir, base: base || '', scope: scope === 'home' ? 'home' : 'project', ts: Date.now(), chars: text.length, indexLine: found.line, indexPos: found.pos });
    ctxmemTrashSave(d);
    recorded = true;
    ctxmemIndexCut(found);
    fs.rmSync(src, { force: true });   // force: исходник, пропавший сам, не повод откатывать и терять копию
    return { ok: true, id, trashDir: CTXMEM_TRASH };
  } catch (e) {
    // Откат: файл остаётся на месте со своей строкой индекса, в корзине — ни копии, ни записи.
    if (found && found.line) { try { ctxmemIndexPut(dir, found.line, found.pos); } catch (_) {} }   // не дублирует, если строка на месте
    if (recorded) { try { const cur = ctxmemTrashLoad(); if (cur) { cur.list = cur.list.filter((r) => r.id !== id); ctxmemTrashSave(cur); } } catch (_) {} }
    if (copied) { try { fs.rmSync(dst, { force: true }); } catch (_) {} }
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('ctxmem:trash', () => {
  const d = ctxmemTrashLoad();
  if (!d) return { ok: false, error: CTX_INDEX_UNREADABLE };
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
    // Файла ещё нет (запись нового) — сверяем ближайшего существующего предка: иначе «link/new.md»
    // при link → /куда-угодно проходил проверку, и mkdir/запись уходили за пределы корня.
    let probe = abs;
    while (probe !== rootRes && !fs.existsSync(probe)) probe = path.dirname(probe);
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync(probe), realRoot = fs.realpathSync(rootRes);
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
  // Явный limit задаёт просмотр вверх у начала файла: окно должно кончиться ровно на границе уже
  // показанного, и нижняя планка 4 КБ там давала бы перекрытие — только для неявного размера.
  const want = whole ? size : Math.max(limit != null ? 1 : 4096, Math.min(CTXFS_WINDOW, Number(limit) || CTXFS_WINDOW));
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
// Заголовок правила — ответ модели по истории диалогов, то есть недоверенный текст. В двойных
// кавычках (JSON.stringify) оболочка всё равно раскрывает $(…) и `…`, и вставленный хук выполнял бы
// это на КАЖДОМ вызове Bash агентом. В одинарных кавычках оболочка не интерпретирует ничего.
const ctxfsShQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
ipcMain.handle('ctxfs:hookStub', (_e, { title, detail } = {}) => {
  const stub = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `echo ${ctxfsShQuote(String(title || 'правило'))}` }],
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
  // Файл больше предела правки отдаётся только окнами (ctxfs:read) — целиком его у окна нет. Запись
  // поверх такого файла — это текст одного окна вместо всего файла, то есть обрезка. Проверяем здесь,
  // а не только во фронте: путей открыть редактор файла несколько.
  try { if (fs.statSync(abs).size > CTXFS_EDIT_MAX) return { ok: false, error: 'файл больше 512 КБ — он открыт частями и правится только снаружи' }; } catch (_) { /* файла нет — создаём */ }
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
function ctxbkLoad() { return ctxListLoad(ctxbkIndex()); }   // null — индекс не читается (см. ctxListLoad)
function ctxbkSave(d) { fs.mkdirSync(CTXBK_DIR, { recursive: true }); atomicWriteSync(ctxbkIndex(), JSON.stringify(d, null, 1)); }
// Снять копию файла ПЕРЕД перезаписью. Нет файла (создаём новый) — бэкапить нечего.
function ctxbkPush(file, kind) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const d = ctxbkLoad();
  if (!d) return null;   // индекс не читается: копия без записи в нём была бы недоступна из окна
  try {
    fs.mkdirSync(CTXBK_DIR, { recursive: true });
    const id = 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    // Права исходника переносим на копию: в ~/.claude есть файлы 0600 с секретами (.credentials.json,
    // settings.json с токенами MCP/env), и копия по umask (0644) делала их читаемыми всем.
    // 0o600 — владелец копию в любом случае читает (иначе восстановление с «копия пропала»).
    let mode; try { mode = (fs.statSync(file).mode & 0o777) | 0o600; } catch (_) {}
    fs.writeFileSync(path.join(CTXBK_DIR, id + '.bak'), text, mode == null ? undefined : { mode });
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
  if (!d) return { ok: false, error: CTX_INDEX_UNREADABLE };
  const list = d.list
    .filter((r) => !file || r.file === file)
    .map((r) => ({ ...r, gone: !fs.existsSync(path.join(CTXBK_DIR, r.id + '.bak')) }))
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, dir: CTXBK_DIR, keep: CTXBK_KEEP, list };
});
ipcMain.handle('ctxbk:read', (_e, { id } = {}) => {
  const d = ctxbkLoad();
  if (!d) return { ok: false, error: CTX_INDEX_UNREADABLE };
  const rec = d.list.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'копии нет в списке' };
  try { return { ok: true, text: fs.readFileSync(path.join(CTXBK_DIR, id + '.bak'), 'utf8'), rec }; }
  catch (e) { return { ok: false, error: 'копия пропала с диска' }; }
});
// Восстановление = обычная запись поверх (и она, в свою очередь, тоже сначала делает бэкап,
// поэтому «откатил и передумал» не теряет текущую версию).
ipcMain.handle('ctxbk:restore', (_e, { id } = {}) => {
  const d = ctxbkLoad();
  if (!d) return { ok: false, error: CTX_INDEX_UNREADABLE };
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
  if (!d) return { ok: false, error: CTX_INDEX_UNREADABLE };
  const rec = d.list.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'записи нет в корзине' };
  const src = path.join(CTXMEM_TRASH, rec.id + '.md');
  if (!fs.existsSync(src)) return { ok: false, error: 'файл из корзины пропал — восстанавливать нечего' };
  const dst = path.join(rec.dir, rec.file);
  if (fs.existsSync(dst)) return { ok: false, error: 'файл с таким именем уже есть — сначала разберитесь с ним' };
  let text;
  try { text = fs.readFileSync(src, 'utf8'); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  // wx: файл не должен появиться между проверкой выше и записью. Недописанный (ENOSPC) убираем, иначе
  // повтор упирался бы в «файл с таким именем уже есть», а в нём — обрезок.
  try { fs.mkdirSync(rec.dir, { recursive: true }); fs.writeFileSync(dst, text, { flag: 'wx' }); }
  catch (e) {
    if (e && e.code !== 'EEXIST') { try { fs.rmSync(dst, { force: true }); } catch (_) {} }
    return { ok: false, error: String((e && e.message) || e) };
  }
  try { ctxmemIndexPut(rec.dir, rec.indexLine, rec.indexPos); }
  catch (e) { try { fs.rmSync(dst, { force: true }); } catch (_) {} return { ok: false, error: String((e && e.message) || e) }; }
  // Файл и строка индекса уже на месте — дальше только уборка корзины. Не удалась запись trash.json —
  // копию оставляем: запись о ней ещё жива, а файл без записи восстановить было бы нечем.
  try { d.list = d.list.filter((r) => r.id !== id); ctxmemTrashSave(d); }
  catch (e) { logger.log('warn', 'ctxmem', `restore: запись корзины не обновилась (${(e && e.message) || e})`); return { ok: true, file: dst }; }
  try { fs.rmSync(src, { force: true }); } catch (_) {}
  return { ok: true, file: dst };
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
// Для самого CLAUDE.md «не прочитался» ≠ «нет файла»: иначе канва открывалась пустой, а сохранение
// шло веткой «Создание файла» и записывало пару строк поверх настоящего (недоступного на чтение) файла.
function ctxReadTarget(f) {
  try { return { text: fs.readFileSync(f, 'utf8') }; }
  catch (e) { return e && e.code === 'ENOENT' ? { text: null } : { text: null, error: String((e && e.message) || e) }; }
}
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
// Для правки: битый список откладывается рядом (ctxListLoad), нечитаемый — исключение. Раньше и то
// и другое давало пустой список, и первая же правка затирала записи всех версий, включая залоченные.
function ctxLoadPoints(projId) {
  const p = ctxListLoad(ctxPointsFile(projId));
  if (!p) throw new Error(CTX_INDEX_UNREADABLE);
  return p;
}
// Для показа: нечитаемый список — просто пустой, ничего не пишем.
function ctxPointsList(projId) { const p = ctxListLoad(ctxPointsFile(projId)); return p ? p.list : []; }
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
  const rd = ctxReadTarget(file);
  if (rd.error) return { ok: false, error: rd.error };
  const text = rd.text;
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
    chars: text ? text.length : 0, mtime, hash: ctxHash(text), graph, points: ctxPointsList(projId), keep: CTX_KEEP };
});
// Запись файла ЦЕЛИКОМ + копия в историю. Фронт собирает текст из блоков сам — он знает порядок.
ipcMain.handle('ctx:save', (_e, { projId, projPath, text, name, note, expectHash } = {}) => {
  if (!projId || !projPath) return { ok: false, error: 'bad args' };
  const file = ctxTarget(projPath);
  const body = String(text == null ? '' : text);
  const rd = ctxReadTarget(file);
  if (rd.error) return { ok: false, error: rd.error };
  const cur = rd.text;
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
    return { ok: true, file, chars: body.length, hash: ctxHash(body), mtime, points: ctxPointsList(projId) };
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
  const p = ctxListLoad(ctxPointsFile(projId));
  if (!p) return { ok: false, error: CTX_INDEX_UNREADABLE };
  return { ok: true, list: p.list, keep: CTX_KEEP };
});
ipcMain.handle('ctx:pointRead', (_e, { projId, id } = {}) => {
  const t = ctxReadFileSafe(ctxPointFile(projId, id));
  return { ok: t != null, text: t == null ? '' : t, exists: t != null, chars: t ? t.length : 0 };
});
ipcMain.handle('ctx:pointDelete', (_e, { projId, id } = {}) => {
  let p; try { p = ctxLoadPoints(projId); } catch (e) { return { ok: false, error: e.message }; }
  const pt = p.list.find((x) => x.id === id);
  if (!pt) return { ok: false, error: 'нет такой версии' };
  if (pt.locked) return { ok: false, error: 'версия защищена замком — сначала снимите замок' };
  p.list = p.list.filter((x) => x.id !== id); ctxSavePoints(projId, p);
  try { fs.rmSync(ctxPointFile(projId, id), { force: true }); } catch (_) {}
  return { ok: true, list: p.list };
});
// Замок — обычный тумблер на ЛЮБОЙ версии (защита от ротации), а не эксклюзивный «Оригинал».
ipcMain.handle('ctx:pointLock', (_e, { projId, id, locked } = {}) => {
  let p; try { p = ctxLoadPoints(projId); } catch (e) { return { ok: false, error: e.message }; }
  const pt = p.list.find((x) => x.id === id);
  if (!pt) return { ok: false, error: 'нет такой версии' };
  pt.locked = !!locked;
  if (!pt.locked) ctxRotatePoints(projId, p);   // сняли замок — версия попадает под общий лимит
  ctxSavePoints(projId, p);
  return { ok: true, list: p.list };
});
ipcMain.handle('ctx:pointNote', (_e, { projId, id, note } = {}) => {
  let p; try { p = ctxLoadPoints(projId); } catch (e) { return { ok: false, error: e.message }; }
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
  // Каталог проекта удалили/переименовали/отмонтировали при открытом модуле: FSWatcher поднимает
  // 'error', и без слушателя это uncaughtException в main, а мёртвый вотчер оставался в карте.
  watcher.on('error', () => {
    clearTimeout(timer);
    try { watcher.close(); } catch (_) {}
    if (ctxOutWatchers.get(projId) === watcher) ctxOutWatchers.delete(projId);
  });
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
    // null/false/0 — валидный JSON, но проверки ниже пропускали его целиком (и apiVersion тоже)
    if (!error && (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))) { error = 'manifest.json должен быть JSON-объектом'; manifest = null; }
    if (manifest && !error) {
      if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) error = 'некорректный id в манифесте (только a-z, 0-9, дефис)';
      else if (manifest.id !== ent.name) error = `id «${manifest.id}» не совпадает с именем папки «${ent.name}»`;
      else if (Number(manifest.apiVersion) !== EXT_API_VERSION) error = `apiVersion ${manifest.apiVersion} не поддерживается (редактор: ${EXT_API_VERSION})`;
    }
    const mainFile = path.join(dir, (manifest && typeof manifest.main === 'string' && manifest.main) || 'index.js');
    // main — путь ВНУТРИ папки модуля: «../чужой/index.js» грузил бы код из-за её пределов
    const mainRel = path.relative(dir, mainFile);
    if (!error && (!mainRel || mainRel === '..' || mainRel.startsWith('..' + path.sep) || path.isAbsolute(mainRel))) error = 'main должен указывать на файл внутри папки модуля';
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
ipcMain.handle('notes:exportFile', async (e, { json, name }) => {
  const safe = String(name || 'lite-notes').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 80);
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(senderWin(e) || mainWindow, {   // зовут из окна модуля: с mainWindow диалог открывался за ним
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
ipcMain.handle('notes:importFile', async (e) => {
  const res = await dialog.showOpenDialog(senderWin(e) || mainWindow, {   // зовут из окна модуля: с mainWindow диалог открывался за ним
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
  // typeof null и массив — тоже 'object': null ронял цикл ниже невнятным «Cannot convert undefined
  // or null to object», а массив «успешно» импортировал ничего (ключи 0,1,… не из STORE_KEYS).
  if (!data || data._format !== 'lite-settings' || !data.store || typeof data.store !== 'object' || Array.isArray(data.store)) {
    return { error: 'Это не файл настроек LiteEditor.' };
  }
  // Окна модулей держат свой снимок стора и пишут свои ключи из него: после импорта они затёрли бы
  // импортированное старым. Поэтому: сперва их несохранённое (как при выходе), после записи — перезагрузка
  // окон на новый стор.
  if (!(await confirmDiscardUnsaved(mainWindow))) return { canceled: true };
  try {
    ensureStoreDir();
    // writeStoreKey logs+swallows its own errors, so track its boolean result here:
    // an unreported failure would let import claim success after losing settings.
    const failedKeys = [];
    for (const k of STORE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data.store, k) && !writeStoreKey(k, data.store[k], { sync: true })) failedKeys.push(k);
    }
    sanitizeRemovedModules({ sync: true });
    let failedNotes = 0;
    if (data.notes && typeof data.notes === 'object' && !Array.isArray(data.notes)) { // массив дал бы notes/0.json, notes/1.json…
      const nd = path.join(storeDir, 'notes');
      fs.mkdirSync(nd, { recursive: true });
      for (const [id, arr] of Object.entries(data.notes)) {
        try { atomicWriteSync(path.join(nd, String(id).replace(/[^\w.-]/g, '_') + '.json'), JSON.stringify(arr)); }
        catch (e) { failedNotes++; logger.log('error', 'store', `import note '${id}' failed`, e); }
      }
      appStore.invalidateNoteCounts();
    }
    if (data.windowState && typeof data.windowState === 'object') saveState(data.windowState);
    saveState({ lastOpenDir: path.dirname(file) });
    try { const api = dbLazy.getApi(); if (api) api.closeAll(); } catch (_) {}
    for (const w of moduleWindows.values()) { try { if (!w.isDestroyed()) w.webContents.reload(); } catch (_) {} }
    // Surface partial failure instead of a false "success" so the renderer can warn the user.
    if (failedKeys.length || failedNotes) return { ok: true, partial: true, failedKeys, failedNotes, file };
    return { ok: true, file };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ---------------------------------------------------------------- window state
const stateFile = path.join(storeDir, 'window-state.json');
// window-state.json пишет только main — держим копию в памяти, а не перечитываем файл перед
// каждой записью (move/resize окна).
let winStateMem = null;
function loadState() {
  if (!winStateMem) { try { winStateMem = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { winStateMem = {}; } }
  return winStateMem;
}
function saveState(partial) {
  winStateMem = { ...loadState(), ...partial };
  try { atomicWriteSync(stateFile, JSON.stringify(winStateMem)); } catch (_) {}
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
      nodeIntegrationInSubFrames: true, // запускает preload в iframe встроенного дока (?embed=1); сам preload проверяет URL
    },
  };
  if (Number.isInteger(st.x) && Number.isInteger(st.y)) { opts.x = st.x; opts.y = st.y; }
  if (fs.existsSync(iconPng)) opts.icon = iconPng;

  mainWindow = new BrowserWindow(opts);
  hardenNavigation(mainWindow);
  // Отказ loadFile (окно закрыли во время загрузки — ERR_ABORTED) иначе уходит в unhandledRejection
  // и в реестр ошибок как сбой приложения; сам отказ оставляем в логе предупреждением.
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((e) => logger.log('warn', 'window', 'loadFile: ' + String((e && e.message) || e)));
  if (st.maximized) mainWindow.maximize();

  // Renderer death is the most likely "silent close": log reason + exitCode so
  // a recurrence is diagnosable (e.g. reason:'crashed'/'oom' vs a GPU abort).
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    logger.log('fatal', 'render-process-gone', JSON.stringify(d));
    recoverMainRenderer(d && d.reason);
  });
  // Окно редактора начинает загружать страницу заново (перезагрузка после падения, импорт настроек):
  // терминалы старой страницы не гасим — агенты в них продолжают работать, а новая страница забирает
  // их по id (pty:adoptable → pty:create с тем же id). Кого не забрали за ORPHAN_TTL_MS — гасим.
  // did-start-navigation приходит РАНЬШЕ will-navigate (порядок событий навигации в Electron), поэтому
  // переход наружу — ссылка или форма в пользовательском модуле, — который hardenNavigation тут же
  // отменит, ставил бы все терминалы окна на гашение: страница оставалась, а агенты умирали через
  // ORPHAN_TTL_MS. Страницу меняет только переход на свою страницу (перезагрузка, импорт настроек).
  mainWindow.webContents.on('did-start-navigation', (ev) => {
    if (ev && ev.isMainFrame && !ev.isSameDocument && isAppPage(ev.url)) orphanPtysOf(mainWindow.webContents);
  });
  mainWindow.webContents.on('unresponsive', () => logger.log('warn', 'window', 'renderer unresponsive'));
  mainWindow.webContents.on('responsive', () => logger.log('info', 'window', 'renderer responsive'));
  // «CONTEXT_LOST_WEBGL: loseContext: context lost» Chromium пишет на КАЖДЫЙ явный вызов
  // WEBGL_lose_context.loseContext() — а его делаем мы сами: проба GPU при старте окна
  // (isHardwareWebgl) и освобождение контекста вытесненного терминала (dropWebgl, renderer/termutil.js).
  // Это не сбой — пишем info, чтобы не засорять реестр ошибок. Настоящая потеря контекста
  // (сброс GPU) приходит другим текстом и остаётся warn.
  const DELIBERATE_GL_LOSS = /CONTEXT_LOST_WEBGL: loseContext: context lost/;
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level !== 'warning' && e.level !== 'error') return;
    const level = DELIBERATE_GL_LOSS.test(String(e.message)) ? 'info' : (e.level === 'error' ? 'error' : 'warn');
    logger.log(level, 'console', `${e.message} (${e.sourceId}:${e.lineNumber})`);
  });

  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // F11: getBounds() — это весь экран; сохранив его, следующий запуск открыл бы окно размером
    // с экран, но уже не полноэкранным. Держим последние обычные габариты.
    if (mainWindow.isFullScreen()) return;
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
  // Закрытие редактора закрывает все окна модулей (освобождение памяти) — сперва спросив их о
  // несохранённом (guardMainWindowClose). После этого window-all-closed штатно убивает PTY/db/rh
  // и завершает приложение.
  guardMainWindowClose(mainWindow);
  mainWindow.on('maximize', () => sendTo(mainWindow, 'win:maximized', true));
  mainWindow.on('unmaximize', () => sendTo(mainWindow, 'win:maximized', false));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    if (input.key === 'F11') mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
}

// Падение рендерера окна редактора: раньше окно оставалось белым, агенты работали невидимо,
// а выход был один — перезапуск всего приложения. Теперь окно перезагружается само, а терминалы
// упавшей страницы переживают перезагрузку: новая страница забирает их по id. Если окно падает
// снова и снова (сбой при старте страницы), автоперезагрузку прекращаем, терминалы гасим и спрашиваем.
const RENDER_CRASH_WINDOW_MS = 60000;
const RENDER_CRASH_MAX = 3;
let renderCrashes = [];
function killPtysOwnedBy(wc) {
  for (const [id, p] of [...ptys]) {
    if (ownerBySession.get(id) !== wc) continue;
    const g = ptyFlows.get(id); if (g) g.reset();
    ptyFlows.delete(id);
    try { p.kill(); } catch (_) {}
    ptys.delete(id);
    ptyRings.delete(id);
    ownerBySession.delete(id);
    dropOrphan(id);
  }
}
// Терминалы, чья страница ушла (перезагрузка, падение): живут ORPHAN_TTL_MS, пока новая страница их не
// заберёт. Незабранные гасятся — иначе шелл висел бы сиротой до выхода из редактора.
const ORPHAN_TTL_MS = 90000;
const orphanPtys = new Map(); // id → таймер гашения
function dropOrphan(id) { const t = orphanPtys.get(id); if (t) { clearTimeout(t); orphanPtys.delete(id); } }
function orphanPtysOf(wc) {
  for (const [id] of ptys) {
    if (ownerBySession.get(id) !== wc || orphanPtys.has(id)) continue;
    const g = ptyFlows.get(id); if (g) g.reset(); // страница ушла и ack больше не пришлёт — не держим шелл на паузе
    orphanPtys.set(id, setTimeout(() => {
      orphanPtys.delete(id);
      const p = ptys.get(id);
      if (!p) return;
      const fg = ptyFlows.get(id); if (fg) fg.reset();
      ptyFlows.delete(id);
      try { p.kill(); } catch (_) {}
      ptys.delete(id);
      ptyRings.delete(id);
      ownerBySession.delete(id);
      logger.log('info', 'pty', `терминал ${id} никто не забрал после перезагрузки окна — остановлен`);
    }, ORPHAN_TTL_MS));
  }
}
function recoverMainRenderer(reason) {
  if (!mainWindow || mainWindow.isDestroyed() || reason === 'clean-exit') return;
  const wc = mainWindow.webContents;
  orphanPtysOf(wc);
  const now = Date.now();
  renderCrashes = renderCrashes.filter((t) => now - t < RENDER_CRASH_WINDOW_MS);
  renderCrashes.push(now);
  if (renderCrashes.length <= RENDER_CRASH_MAX) {
    logger.log('warn', 'window', `окно редактора упало (${reason}) — перезагружаю`);
    try { wc.reload(); } catch (_) {}
    return;
  }
  logger.log('error', 'window', `окно редактора упало ${renderCrashes.length} раз за минуту — автоперезагрузка остановлена`);
  killPtysOwnedBy(wc);
  dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'LiteEditorAI',
    message: i18n.t('Окно редактора падает снова и снова'),
    detail: i18n.t('Терминалы этого окна остановлены. Подробности — в журнале: ~/.LiteEditorAI/logs.'),
    buttons: [i18n.t('Перезагрузить окно'), i18n.t('Закрыть редактор')],
    defaultId: 0, cancelId: 1, noLink: true,
  }).then(({ response }) => {
    if (response === 0) { renderCrashes = []; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); }
    else app.quit();
  }).catch(() => {});
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
const detachedTermWindows = new Map(); // projId -> BrowserWindow (вынесенные терминалы проектов)
const detachedTermMeta = new Map();    // projId -> { project, snapshot, liveOnDetach, status }
const detachedCollectors = new Map();  // reqId -> (snap) => void
const detachedAckers = new Map();      // ackId -> () => void
const detachedSearchers = new Map();   // reqId -> (hits) => void
let detachedReqSeq = 0;
let activeProjectInfo = null;       // {id,path,name,accent} — кэш активного проекта редактора (для проектозависимых окон)
const ownerBySession = new Map();   // sessionId -> webContents — маршрутизация стримов по окну-владельцу (этап D)

function readModuleWins() { const v = readStoreKey('moduleWins'); return (v && typeof v === 'object') ? v : {}; }
// Однократный перенос id 'sitemon' → 'servers' в наборе окон, квикбаре и автозапуске (окно «Мониторинг
// сайтов» влилось в «Серверы»). Без него закреплённая кнопка и автозапуск указывали бы в никуда.
(function migrateSitemonId() {
  const swap = (arr) => { if (!Array.isArray(arr) || !arr.includes('sitemon')) return null; const out = []; for (const x of arr) { const y = x === 'sitemon' ? 'servers' : x; if (!out.includes(y)) out.push(y); } return out; };
  try {
    const mw = readModuleWins(); const o = swap(mw.__open);
    if (o) { mw.__open = o; if (mw.sitemon && !mw.servers) mw.servers = mw.sitemon; delete mw.sitemon; writeStoreKey('moduleWins', mw); }
    const qb = swap(readStoreKey('quickbar')); if (qb) writeStoreKey('quickbar', qb);
    const st = readStoreKey('settings');
    if (st && typeof st === 'object') { const al = swap(st.autoLaunchMods); if (al) { st.autoLaunchMods = al; writeStoreKey('settings', st); } }
  } catch (e) { logger.log('warn', 'store', 'миграция sitemon → servers: ' + String((e && e.message) || e)); }
})();
// Идемпотентная очистка удалённых модулей ('company', 'quorum') из открытых окон, квикбара и автозапуска.
// Данные пользователя в ~/.LiteEditorAI/quorum-data/ и ~/.LiteEditorAI/company/ на диске не трогаем.
const REMOVED_MODULE_IDS = new Set(['company', 'quorum']);
function sanitizeRemovedModules({ sync = false } = {}) {
  const writeOpts = sync ? { sync: true } : undefined;
  const drop = (arr) => (Array.isArray(arr) && arr.some((x) => REMOVED_MODULE_IDS.has(x)))
    ? arr.filter((x) => !REMOVED_MODULE_IDS.has(x))
    : null;
  const collapseSeps = (arr) => {
    const out = [];
    for (const x of arr) {
      if (x === '|' && (!out.length || out[out.length - 1] === '|')) continue;
      out.push(x);
    }
    while (out.length && out[out.length - 1] === '|') out.pop();
    return out;
  };
  try {
    const mw = readModuleWins();
    const o = drop(mw.__open);
    const hasLegacy = Object.prototype.hasOwnProperty.call(mw, 'company') || Object.prototype.hasOwnProperty.call(mw, 'quorum');
    if (o || hasLegacy) {
      if (o) mw.__open = o;
      delete mw.company;
      delete mw.quorum;
      writeStoreKey('moduleWins', mw, writeOpts);
    }
    const qbRaw = readStoreKey('quickbar');
    const qb = drop(qbRaw);
    if (qb) writeStoreKey('quickbar', collapseSeps(qb), writeOpts);
    const st = readStoreKey('settings');
    if (st && typeof st === 'object') {
      const al = drop(st.autoLaunchMods);
      const hasKeys = Object.prototype.hasOwnProperty.call(st, 'quorumFollowProject')
        || Object.prototype.hasOwnProperty.call(st, 'quorumSourceDir');
      if (al || hasKeys) {
        if (al) st.autoLaunchMods = al;
        delete st.quorumFollowProject;
        delete st.quorumSourceDir;
        writeStoreKey('settings', st, writeOpts);
      }
    }
  } catch (e) { logger.log('warn', 'store', i18n.t('очистка удалённых модулей: {0}', String((e && e.message) || e))); }
}
sanitizeRemovedModules();
function saveModuleBounds(modId, win) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return; // F11 — не затираем обычные габариты размером экрана
  const all = readModuleWins();
  if (win.isMaximized()) { all[modId] = { ...(all[modId] || {}), maximized: true }; }
  else { const b = win.getBounds(); all[modId] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: false }; }
  writeStoreKey('moduleWins', all);
}
let closingAllModules = false;     // closeAllModuleWindows() в процессе: набор окон не переписываем
function broadcastModuleOpenSet() {
  if (closingAllModules) return;
  const ids = [...moduleWindows.keys()];
  sendTo(mainWindow, 'module:openSet', { ids });
  // запоминаем набор открытых окон — чтобы переоткрыть его при следующем запуске редактора
  try { const all = readModuleWins(); all.__open = ids; writeStoreKey('moduleWins', all); } catch (_) {}
}
// Переоткрыть окна модулей, которые были открыты на момент прошлого выхода (с их сохранёнными bounds).
function reopenSavedModuleWindows() {
  try {
    const open = readModuleWins().__open;
    if (Array.isArray(open)) {
      for (const id of open) {
        if (!id || typeof id !== 'string') continue;
        if (id === 'files' && isFilesDocked()) {
          sendTo(mainWindow, 'editor:ensureFilesDock', { open: true });
          continue;
        }
        openModuleWindow(id);
      }
    }
  } catch (_) {}
}
function broadcastToModules(ch, payload) {
  for (const w of moduleWindows.values()) { sendTo(w, ch, payload); }
  for (const w of detachedTermWindows.values()) { sendTo(w, ch, payload); }
  const df = liveFilesDockFrame();
  if (df) sendToFrame(df, ch, payload);
}
// Маршрут стрима к окну-владельцу сессии (fallback — главное окно редактора).
function sendToOwner(sessionId, ch, payload) {
  const wc = ownerBySession.get(sessionId);
  if (sendTo(wc, ch, payload)) return true;     // владелец мог умереть — тогда падаем на окно редактора
  return sendTo(mainWindow, ch, payload);
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
// Внешние протоколы (search-ms:, ms-msdt:, vscode:, …) Chromium отдаёт ОС через запрос разрешения
// 'openExternal', которое Electron без обработчика выдаёт ВСЕГДА. Главный фрейм наших окон режет
// will-navigate выше, но есть и то, что он не видит: iframe превью HTML в вивере (allow-scripts +
// allow-popups — чужой файл из репозитория) и скрытые окна SEO-аудита/мониторинга сайтов, которые
// грузят произвольные страницы. Любая из них одной строкой JS запускала бы обработчик протокола ОС.
// Пропускаем только http(s)/mailto; остальные разрешения — как по умолчанию (выдаём).
const guardedSessions = new WeakSet();
function guardExternalProtocols(ses) {
  if (!ses || guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  try {
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
      if (permission !== 'openExternal') { cb(true); return; }
      const url = String((details && details.externalURL) || '');
      const ok = /^(https?|mailto):/i.test(url);
      if (!ok) logger.log('warn', 'window', 'внешний протокол отклонён: ' + url.slice(0, 200));
      cb(ok);
    });
  } catch (_) {}
}
// shell.openExternal асинхронный: try/catch вокруг него отказ не ловит (нет браузера по умолчанию,
// xdg-open упал) — промис уходил в unhandledRejection и в журнал ошибок как сбой приложения.
function openExternalQuiet(url) {
  Promise.resolve().then(() => shell.openExternal(url))
    .catch((e) => logger.log('warn', 'window', 'openExternal: ' + String((e && e.message) || e)));
}
function hardenNavigation(win) {
  const wc = win.webContents;
  guardExternalProtocols(wc.session); // окна без partition делят defaultSession — вместе со скрытыми окнами аудита
  wc.on('will-navigate', (e, url) => {
    if (isAppPage(url)) return;                       // своя страница и её перезагрузка
    e.preventDefault();
    logger.log('warn', 'window', 'навигация наружу отклонена: ' + String(url).slice(0, 200));
    if (/^https?:/i.test(url)) openExternalQuiet(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) openExternalQuiet(url);
    return { action: 'deny' };                        // отдельных окон без preload-контракта не заводим
  });
}

// Единый маршрутизатор готовности модулей (окон и встроенного дока «Проект»):
// заменяет ручные очереди pendingModuleArgs / pendingViewerOpens / pendingDbOpens / pendingRmqOpens / …
const moduleRouter = createModuleRouter({
  ensureTarget(modId) {
    if (modId === 'files' && isFilesDocked() && mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      sendTo(mainWindow, 'editor:ensureFilesDock', { open: true });
      return;
    }
    const w = moduleWindows.get(modId);
    if (!w || w.isDestroyed()) openModuleWindow(modId);
  },
  getTarget(modId) {
    if (modId === 'files') {
      const df = liveFilesDockFrame();
      if (df && isFilesDocked()) return { __isFrame: true, frame: df };
    }
    const w = moduleWindows.get(modId);
    return (w && !w.isDestroyed()) ? w : null;
  },
  sendToTarget(target, ch, payload) {
    if (!target) return false;
    if (target.__isFrame) return sendToFrame(target.frame, ch, payload);
    return sendTo(target, ch, payload);
  },
  focusTarget(target) {
    if (!target || target.__isFrame) return;
    try { if (target.isMinimized()) target.restore(); target.focus(); } catch (_) {}
  },
});

function deliverModuleArg(modId, arg) {
  if (arg == null) return;
  const w = moduleWindows.get(modId);
  moduleRouter.deliverArg(modId, arg, (w && !w.isDestroyed() && w.__modReady) ? w : null);
}
function openModuleWindow(modId, arg) {
  // «Мониторинг сайтов» стал вкладкой «Сайты» окна «Серверы» (v1.1.212): старые вызовы ведут туда
  if (modId === 'sitemon') { modId = 'servers'; if (arg == null) arg = { view: 'sites' }; }
  if (REMOVED_MODULE_IDS.has(modId)) return;
  const existing = moduleWindows.get(modId);
  if (existing && !existing.isDestroyed()) { if (existing.isMinimized()) existing.restore(); existing.focus(); deliverModuleArg(modId, arg); return; }
  deliverModuleArg(modId, arg);
  const saved = readModuleWins()[modId] || {};
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const opts = {
    width: saved.width || 900, height: saved.height || 700,
    minWidth: 420, minHeight: 320,
    backgroundColor: '#00000000', frame: false, transparent: true,
    title: 'LiteEditorAI', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) { opts.x = saved.x; opts.y = saved.y; }
  if (fs.existsSync(iconPng)) opts.icon = iconPng;
  const win = new BrowserWindow(opts);
  hardenNavigation(win);
  moduleWindows.set(modId, win);
  win.loadFile(path.join(__dirname, 'renderer', 'module.html'), { hash: modId }).catch((e) => logger.log('warn', 'window', `loadFile ${modId}: ` + String((e && e.message) || e))); // как у окна редактора
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
    if (modId === 'files') {
      moduleRouter.markNotReady('files', { clearArg: true, clearQueue: false });
      const df = liveFilesDockFrame();
      if (df) moduleRouter.markReady('files', { __isFrame: true, frame: df });
    } else {
      moduleRouter.markNotReady(modId);
    }
    if (modId === 'voice') voiceApi.stop(); // «Озвучка»: снять слежение за буфером и погасить сайдкар (если загружался)
    if (modId === 'ctx') {
      for (const w of ctxOutWatchers.values()) { try { w.close(); } catch (_) {} } ctxOutWatchers.clear(); // окно «Контекст» закрылось без unwatch → не течём fs.watch (B2)
      // и обрываем анализ диалогов: без этого `claude -p` жил ещё до таймаута (5 мин), жёг токены и писал в мёртвый sender
      for (const c of ctxmineReqs.values()) { try { c.kill(); } catch (_) {} } ctxmineReqs.clear();
    }
    // То же и для остальных окон с агентами: закрыли окно — обрывай его запросы. Иначе `claude -p`
    // (или HTTP-стрим OpenRouter) доживал до своего таймаута — 2–5 минут работы и токенов в никуда.
    if (modId === 'doc') killReqMap(tpReqs);         // «Обработка текста»
    // AI-DB: запросы гасит dbaiTrack по закрытию окна-ЗАКАЗЧИКА (тем же каналом ходит «Мониторинг сайтов» —
    // killReqMap здесь обрывал и его). Соединения и SSH-туннели «Баз данных» нужны только этому окну — закрываем,
    // иначе они жили до выхода из редактора (следующее открытие окна переподключится само).
    if (modId === 'db') { try { const api = dbLazy.getApi(); if (api) api.closeAll(); } catch (_) {} }
    if (modId === 'chat') killReqMap(orReqs);        // OpenRouter
    if (modId === 'docker') { try { const api = containersLazy.getApi(); if (api) api.closeStreams(); } catch (_) {} }
    if (modId === 'files' || modId === 'doc') scheduleSyncWatchers(0);
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
  if (modId === 'files' || modId === 'doc') scheduleSyncWatchers(0);
  broadcastModuleOpenSet();
}

// ── Вынесенные окна терминалов проектов (v1.1+) ──────────────────────────────────────────────
// Каждый проект можно вынести в отдельное окно (module.html?projId=<id>#projterm), сохраняя
// живые PTY (агентов и шеллы). При закрытии вынесенного окна или клике «Вернуть» все вкладки,
// сплиты и живые PTY без разрыва возвращаются в главное окно редактора.
function transferPtysTo(sessionIds, targetWc, { makeOrphan = false } = {}) {
  for (const id of sessionIds || []) {
    const proc = ptys.get(id);
    if (!proc) continue;
    dropOrphan(id);
    const g = ptyFlows.get(id);
    if (g) g.reset();
    if (targetWc && !targetWc.isDestroyed()) {
      ownerBySession.set(id, targetWc);
      bindPtyOwner(proc, targetWc);
    }
    if (makeOrphan) {
      orphanPtys.set(id, setTimeout(() => {
        orphanPtys.delete(id);
        const p = ptys.get(id);
        if (!p) return;
        const fg = ptyFlows.get(id); if (fg) fg.reset();
        ptyFlows.delete(id);
        try { p.kill(); } catch (_) {}
        ptys.delete(id);
        ptyRings.delete(id);
        ownerBySession.delete(id);
        logger.log('info', 'pty', `вынесенный терминал ${id} не забрали при передаче окна — остановлен`);
      }, ORPHAN_TTL_MS));
    }
  }
}
function saveDetachedTermBounds(projId, win) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  try {
    const all = readModuleWins();
    const key = 'projterm:' + projId;
    if (win.isMaximized()) {
      all[key] = { ...(all[key] || {}), maximized: true };
    } else {
      const b = win.getBounds();
      all[key] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: false };
      all.projterm = { width: b.width, height: b.height };
    }
    writeStoreKey('moduleWins', all);
  } catch (_) {}
}
function detachedProjIds() { return [...detachedTermWindows.keys()]; }
function broadcastDetachedTermSet() {
  if (closingAllModules) return;
  sendTo(mainWindow, 'projTerm:detachedSet', { ids: detachedProjIds() });
}
function collectFromDetachedWin(win, fallbackSnap) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve(fallbackSnap || null); return; }
    const reqId = `ptc_${++detachedReqSeq}`;
    const timer = setTimeout(() => {
      detachedCollectors.delete(reqId);
      resolve(fallbackSnap || null);
    }, 650);
    detachedCollectors.set(reqId, (snap) => {
      clearTimeout(timer);
      detachedCollectors.delete(reqId);
      resolve(snap || fallbackSnap || null);
    });
    if (!sendTo(win, 'projTerm:collect', { reqId })) {
      clearTimeout(timer);
      detachedCollectors.delete(reqId);
      resolve(fallbackSnap || null);
    }
  });
}
/** @returns {Promise<void>} */
function waitForReattachAck(projId, project, snapshot) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve(); return; }
    const ackId = `pta_${++detachedReqSeq}`;
    const timer = setTimeout(() => {
      detachedAckers.delete(ackId);
      resolve();
    }, 1500);
    detachedAckers.set(ackId, () => {
      clearTimeout(timer);
      detachedAckers.delete(ackId);
      resolve();
    });
    if (!sendTo(mainWindow, 'projTerm:reattached', { projId, project, snapshot, ackId })) {
      clearTimeout(timer);
      detachedAckers.delete(ackId);
      resolve();
    }
  });
}
async function reattachDetachedTermWindow(projId, { fromCrash = false } = {}) {
  const win = detachedTermWindows.get(projId);
  const meta = detachedTermMeta.get(projId);
  if (!win || win.isDestroyed()) return { ok: false };
  if (win.__reattaching) return { ok: true };
  win.__reattaching = true;

  const fallbackSnap = meta ? meta.snapshot : null;
  const collected = fromCrash ? fallbackSnap : await collectFromDetachedWin(win, fallbackSnap);
  const snap = normalizeProjTermSnapshot(collected || fallbackSnap, projId);

  // Собираем все живые PTY этого окна (по снимку и по текущему owner) до уничтожения webContents,
  // чтобы bindPtyOwner().once('destroyed') увидел нового владельца и не убил живые сессии.
  const idSet = new Set(collectLiveSessionIds(snap));
  try {
    const wc = win.webContents;
    for (const [sid, p] of ptys) {
      if (ptyOwner.get(p) === wc || ownerBySession.get(sid) === wc) idSet.add(sid);
    }
  } catch (_) {}
  const targetWc = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents : null;
  transferPtysTo([...idSet], targetWc, { makeOrphan: true });

  await waitForReattachAck(projId, meta ? meta.project : { id: projId }, snap);

  detachedTermWindows.delete(projId);
  detachedTermMeta.delete(projId);
  win.__forceClose = true;
  try {
    if (!win.isDestroyed()) {
      if (fromCrash) win.destroy(); else win.close();
    }
  } catch (_) {}
  broadcastDetachedTermSet();
  return { ok: true };
}
function closeDetachedProjectWindow(projId, { killPtys = true } = {}) {
  const win = detachedTermWindows.get(projId);
  detachedTermWindows.delete(projId);
  detachedTermMeta.delete(projId);
  if (win && !win.isDestroyed()) {
    win.__forceClose = true;
    try { win.destroy(); } catch (_) {}
  }
  if (killPtys) {
    const prefix = String(projId) + '::';
    for (const [sid, proc] of [...ptys]) {
      if (!String(sid).startsWith(prefix)) continue;
      dropOrphan(sid);
      const g = ptyFlows.get(sid); if (g) g.reset();
      ptyFlows.delete(sid);
      try { proc.kill(); } catch (_) {}
      ptys.delete(sid);
      ptyRings.delete(sid);
      ownerBySession.delete(sid);
    }
  }
  broadcastDetachedTermSet();
}
function openDetachedTermWindow(projId, project, snapshot) {
  const id = String(projId || '');
  if (!id) return { ok: false, error: 'projId required' };
  const existing = detachedTermWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { ok: true, already: true };
  }
  const snap = normalizeProjTermSnapshot(snapshot, id);
  const liveIds = collectLiveSessionIds(snap).filter((sid) => ptys.has(sid));
  const savedAll = readModuleWins();
  const saved = savedAll['projterm:' + id] || savedAll.projterm || {};
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const opts = {
    width: saved.width || 1040, height: saved.height || 740,
    minWidth: 520, minHeight: 360,
    backgroundColor: '#00000000', frame: false, transparent: true,
    title: 'LiteEditorAI — ' + ((project && project.name) || id), show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) { opts.x = saved.x; opts.y = saved.y; }
  if (fs.existsSync(iconPng)) opts.icon = iconPng;
  const win = new BrowserWindow(opts);
  hardenNavigation(win);
  detachedTermWindows.set(id, win);
  detachedTermMeta.set(id, {
    project: project ? { ...project } : { id, name: id, path: '' },
    snapshot: snap,
    liveOnDetach: new Set(liveIds),
    status: null,
  });
  // Сразу переводим владение живыми PTY на новое окно + ставим 90с orphan-защиту на случай сбоя старта.
  transferPtysTo(liveIds, win.webContents, { makeOrphan: true });

  win.loadFile(path.join(__dirname, 'renderer', 'module.html'), {
    query: { projId: id },
    hash: 'projterm',
  }).catch((e) => logger.log('warn', 'window', `loadFile projterm(${id}): ` + String((e && e.message) || e)));
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('maximize', () => { sendTo(win, 'win:maximized', true); });
  win.on('unmaximize', () => { sendTo(win, 'win:maximized', false); });
  win.on('resize', debounce(() => saveDetachedTermBounds(id, win), 400));
  win.on('move', debounce(() => saveDetachedTermBounds(id, win), 400));
  win.on('close', (e) => {
    saveDetachedTermBounds(id, win);
    if (win.__forceClose || closingAllModules) return;
    e.preventDefault();
    reattachDetachedTermWindow(id);
  });
  win.on('closed', () => {
    if (detachedTermWindows.get(id) === win) detachedTermWindows.delete(id);
    detachedTermMeta.delete(id);
    for (const [sid, wc] of ownerBySession) { try { if (wc.isDestroyed()) ownerBySession.delete(sid); } catch (_) { ownerBySession.delete(sid); } }
    broadcastDetachedTermSet();
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    logger.log('error', 'projterm-window', `${id} ${JSON.stringify(d)}`);
    reattachDetachedTermWindow(id, { fromCrash: true });
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  broadcastDetachedTermSet();
  return { ok: true };
}
// ── Выход из редактора при несохранённом в окнах модулей ──────────────────────────────────────
// Закрытие редактора сносит окна модулей destroy() — мимо их dirty-guard (иначе выход упирался бы
// в N диалогов по окнам). Поэтому перед сносом спрашиваем окна: модуль дописывает то, что можно
// сохранить молча (автосейв вивера, документы с файлом, транскрипты AI-DB), и называет остальное —
// безымянный документ, правку при конфликте с диском, файл удалённого хоста. Об этом спрашиваем
// человека одним диалогом. Зависшее или ещё не загруженное окно ждём не дольше QUIT_CHECK_MS.
const QUIT_CHECK_MS = 5000;
let quitCheckSeq = 0;
const quitCheckWaiters = new Map();   // id запроса → resolve
ipcMain.on('win:quitCheckReply', (_e, { id, unsaved } = {}) => {
  const done = quitCheckWaiters.get(id);
  if (done) done(Array.isArray(unsaved) ? unsaved.map(String).slice(0, 20) : []);
});
function askModulesUnsaved() {
  const wins = [...moduleWindows.values()].filter((w) => w && !w.isDestroyed());
  const df = liveFilesDockFrame();
  const tasks = wins.map((w) => new Promise((resolve) => {
    const id = ++quitCheckSeq;
    const timer = setTimeout(() => done([]), QUIT_CHECK_MS);
    function done(list) { clearTimeout(timer); quitCheckWaiters.delete(id); resolve({ win: w, unsaved: list }); }
    quitCheckWaiters.set(id, done);
    if (!sendTo(w, 'win:quitCheck', { id })) done([]);
  }));
  if (df && mainWindow && !mainWindow.isDestroyed()) {
    tasks.push(new Promise((resolve) => {
      const id = ++quitCheckSeq;
      const timer = setTimeout(() => done([]), QUIT_CHECK_MS);
      function done(list) { clearTimeout(timer); quitCheckWaiters.delete(id); resolve({ win: mainWindow, unsaved: list }); }
      quitCheckWaiters.set(id, done);
      if (!sendToFrame(df, 'win:quitCheck', { id })) done([]);
    }));
  }
  return Promise.all(tasks).then((rs) => rs.filter((r) => r.unsaved.length));
}
// true — можно закрывать (несохранённого нет или человек согласился его бросить).
async function confirmDiscardUnsaved(parent) {
  const dirty = await askModulesUnsaved();
  if (!dirty.length) return true;
  const title = (w) => { try { return i18n.t(String(w.getTitle() || '').replace(/^LiteEditorAI\s*—\s*/, '')); } catch (_) { return ''; } };
  /** @type {Electron.MessageBoxOptions} */
  const opts = {
    type: 'warning', title: 'LiteEditorAI',
    message: i18n.t('В окнах модулей есть несохранённые правки'),
    detail: dirty.map((d) => `${title(d.win)}: ${d.unsaved.join(', ')}`).join('\n') + '\n\n' + i18n.t('Если закрыть сейчас, они пропадут.'),
    buttons: [i18n.t('Вернуться к правкам'), i18n.t('Закрыть без сохранения')],
    defaultId: 0, cancelId: 0, noLink: true,
  };
  const par = parent && !parent.isDestroyed() ? parent : null;
  const { response } = await (par ? dialog.showMessageBox(par, opts) : dialog.showMessageBox(opts));
  if (response === 1) return true;
  const w = dirty[0].win;
  if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  return false;
}
// Защита от случайного убийства живых агентов/процессов в PTY при закрытии главного окна или обновлении.
// Голые шеллы на приглашении (idle === true) диалога не вызывают.
async function confirmStopActiveTerminals(parent) {
  if ((readSettingsCached() || {}).confirmQuitWithAgents === false) return true;
  const entries = [];
  for (const [id, proc] of ptys) {
    if (proc && proc.pid) entries.push([String(id), proc.pid]);
  }
  if (!entries.length) return true;
  let agentsMap;
  try {
    agentsMap = await Promise.race([
      procService.agents(entries),
      new Promise((resolve) => setTimeout(() => resolve({}), 2500)),
    ]) || {};
  } catch (_) {
    return true;
  }
  const summary = summarizeBusyPtys({
    agentsMap,
    projects: readStoreKey('projects') || [],
    t: i18n.t,
  });
  if (!summary.busyCount) return true;
  const lines = summary.detailLines.slice(0, 12);
  if (summary.detailLines.length > 12) lines.push(`… (+${summary.detailLines.length - 12})`);
  /** @type {Electron.MessageBoxOptions} */
  const opts = {
    type: 'warning',
    title: 'LiteEditorAI',
    message: summary.agentCount > 0
      ? i18n.t('В терминалах работают агенты')
      : i18n.t('В терминалах выполняются процессы'),
    detail: lines.join('\n') + '\n\n' + i18n.t('При закрытии редактора все сессии терминалов будут остановлены.'),
    buttons: [i18n.t('Остаться в редакторе'), i18n.t('Закрыть и остановить')],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: i18n.t('Больше не спрашивать при выходе'),
    checkboxChecked: false,
    noLink: true,
  };
  const par = parent && !parent.isDestroyed() ? parent : null;
  const { response, checkboxChecked } = await (par ? dialog.showMessageBox(par, opts) : dialog.showMessageBox(opts));
  if (response === 1) {
    if (checkboxChecked) {
      try { patchStoreKey('settings', { confirmQuitWithAgents: false }, [], null, null); } catch (_) {}
    }
    return true;
  }
  if (par && !par.isDestroyed()) { if (par.isMinimized()) par.restore(); par.show(); par.focus(); }
  return false;
}
// Выход через app.quit() (трей «Выход», Cmd+Q): после согласия выходим снова тем же путём, а не только
// закрываем окно — на macOS приложение без окон иначе осталось бы жить.
let quitViaApp = false;
app.on('before-quit', () => { quitViaApp = true; });
function guardMainWindowClose(win) {
  let approved = false, checking = false;
  win.on('close', (e) => {
    const hasModules = [...moduleWindows.values()].some((w) => w && !w.isDestroyed()) || !!liveFilesDockFrame();
    const needPtyCheck = ptys.size > 0 && (readSettingsCached() || {}).confirmQuitWithAgents !== false;
    if (approved || (!hasModules && !needPtyCheck)) { closeAllModuleWindows(); return; }
    e.preventDefault();
    if (checking) return;
    checking = true;
    (async () => {
      if (hasModules && !(await confirmDiscardUnsaved(win))) return false;
      if (needPtyCheck && !(await confirmStopActiveTerminals(win))) return false;
      return true;
    })().then((ok) => {
      checking = false;
      const viaApp = quitViaApp; quitViaApp = false;
      if (!ok || win.isDestroyed()) return;
      approved = true;
      // Уже согласовано — сносим окна модулей сразу: app.quit() закрывал бы их поодиночке, и dirty-guard
      // окна (preventDefault в его 'close') отменил бы выход повторно.
      closeAllModuleWindows();
      if (viaApp) app.quit(); else win.close();
    }, () => { checking = false; quitViaApp = false; });
  });
}
// destroy() поднимает 'closed' синхронно, и обработчик каждого окна записывал в __open остаток карты:
// к концу выхода там оставался [] — и следующий запуск не переоткрывал ни одного окна. Набор на момент
// выхода уже лежит в сторе (пишется на каждое открытие/закрытие), поэтому здесь его просто не трогаем.
function closeAllModuleWindows() {
  closingAllModules = true;
  try {
    for (const w of [...moduleWindows.values()]) { try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) {} }
    for (const w of [...detachedTermWindows.values()]) {
      if (!w) continue;
      w.__forceClose = true;
      try { if (!w.isDestroyed()) w.destroy(); } catch (_) {}
    }
  } finally { closingAllModules = false; }
  moduleWindows.clear();
  detachedTermWindows.clear();
  detachedTermMeta.clear();
}

// ── Помодоро: долгоживущий движок таймера в main (lib/ipc/pomodoro.js) ───────────────────
const pomodoroApi = registerPomodoroIpc({
  ipcMain, dialog, Notification,
  readStoreKey, writeStoreKey, atomicWriteSync,
  loadState, saveState, lastDirOpts, backupStamp, importMaxBytes: IMPORT_MAX_BYTES,
  senderWin: (e) => senderWin(e),
  getMainWindow: () => mainWindow,
  getActiveProject: () => activeProjectInfo,
  sendTo, broadcastToModules,
  forwardToEditor: (ch, payload) => forwardToEditor(ch, payload),
});

// Tray gives a quick way back to the window and surfaces how many agents need
// attention while the window is minimised/behind others.
function createTray() {
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  if (tray || !fs.existsSync(iconPng)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPng).resize({ width: 18, height: 18 }));
    tray.setToolTip('LiteEditorAI');
    tray.setContextMenu(trayMenu());
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

// GPU/utility child processes dying (the other half of a "trap int3" crash).
app.on('child-process-gone', (_e, d) =>
  logger.log(d && d.reason === 'clean-exit' ? 'info' : 'error', 'child-process-gone', JSON.stringify(d)));
app.on('before-quit', () => { logger.log('info', 'app', 'before-quit'); });
// Уборка — на will-quit, а не на before-quit: выход может быть отменён (окно с несохранённым,
// guardMainWindowClose).
app.on('will-quit', () => {
  killReqMap(tpReqs); killReqMap(dbaiReqs); killReqMap(orReqs); killReqMap(ctxmineReqs);
  try { const api = dbLazy.getApi(); if (api) api.closeAll(); } catch (_) {}
  try { appStore.flushAllSync(); } catch (_) {}
  try { errledger.flush(); } catch (_) {}
  try { procService.shutdown(); } catch (_) {}
  try { mcpHub.shutdown(); } catch (_) {}
});

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
  if (mcpHub.getConfig().enabled !== false) mcpHub.ensureStarted().catch(() => {});
  // Своё меню рисуется в титлбаре — системное меню окна на Linux не нужно.
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  // Переоткрыть окна модулей, открытые в прошлой сессии (проектозависимые подхватят активный
  // проект, когда редактор его запушит). Небольшая задержка — дать окну редактора подняться.
  setTimeout(reopenSavedModuleWindows, 600);
  startAgendaReminders();  // напоминалки Календаря (дата-задачи)
  startAgendaWatch();      // подхват внешних записей напоминаний (MCP-сервер)
  // Архивы обновлений (по 150 МБ) живут только до перезапуска: раз мы стартовали, скачанное
  // либо уже применено, либо устарело — качать его повторно дешевле, чем копить на диске.
  // Но не во время загрузки этого запуска: автозагрузка стартует через ~3 с после окна и к 8 с ещё
  // идёт — уборка стирала её .part/распаковку, а стейджер без каталога новой версии выходил, не
  // перезапустив редактор.
  setTimeout(() => { if (!updDownloading && !updStaged) updater.cleanup(storeDir); }, 8000);
});


app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch (_) {} }
  ptys.clear();
  try { const api = containersLazy.getApi(); if (api) api.closeStreams(); } catch (_) {}
  // In-flight агент-процессы/HTTP окон модулей (textproc/чат/AI-DB): окно могло крашнуться,
  // не успев послать *:abort → не оставляем claude/codex/запрос сиротами после выхода (B3).
  killReqMap(tpReqs); killReqMap(dbaiReqs); killReqMap(orReqs); killReqMap(ctxmineReqs); // + анализ диалогов «Контекста»
  try { const api = dbLazy.getApi(); if (api) api.closeAll(); } catch (_) {}
  try { rhApi.closeAll(); } catch (_) {}
  for (const w of watchers.values()) { clearTimeout(w.timer); try { w.watcher.close(); } catch (_) {} }
  watchers.clear();
  for (const gw of gitWatchers.values()) { try { gw.close(); } catch (_) {} }
  gitWatchers.clear();
  watchedRoots.clear();
  for (const w of ctxOutWatchers.values()) { try { w.close(); } catch (_) {} } // fs.watch выходных файлов «Контекста» (B2)
  ctxOutWatchers.clear();
  try { pomodoroApi.stop(); } catch (_) {}
  try { voiceApi.stop(); } catch (_) {} // сайдкар озвучки (если загружался) не должен пережить редактор
  app.quit();
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
  // Патчем и с рассылкой: копии settings в окнах должны узнать новый lang, иначе следующий
  // saveSettings любого окна вернул бы старый язык (так и было: язык → тема → перезапуск = русский).
  patchStoreKey('settings', { lang: i18n.locale() }, [], null);
  const payload = i18nPayload();
  for (const w of BrowserWindow.getAllWindows()) sendTo(w, 'i18n:changed', payload);
  const df = liveFilesDockFrame();
  if (df) sendToFrame(df, 'i18n:changed', payload);
  try { setTrayMenu(); updateTrayTooltip(); } catch (_) {}   // пункты меню и подсказка — на новом языке
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
// arg — только простые данные (JSON): уходит в окно модуля как есть, модуль сам проверяет поля.
ipcMain.on('module:open', (_e, { modId, arg } = {}) => {
  if (!modId) return;
  let a = null;
  if (arg != null) { try { a = JSON.parse(JSON.stringify(arg)); } catch (_) { a = null; } }
  if (String(modId) === 'files' && isFilesDocked() && mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    sendTo(mainWindow, 'editor:ensureFilesDock', { open: true });
    return;
  }
  openModuleWindow(String(modId), a);
});
// Окно модуля подписалось на module:arg — отдать отложенный параметр через единый роутер.
ipcMain.on('module:ready', (e) => {
  for (const [id, w] of moduleWindows) {
    if (w.isDestroyed() || w.webContents !== e.sender) continue;
    w.__modReady = true;
    moduleRouter.consumeArg(id, w);
    break;
  }
});

// ── Кросс-оконная шина: активный проект редактора → окна модулей ──────────────────────
ipcMain.on('app:setActiveProject', (_e, info) => { activeProjectInfo = info || null; broadcastToModules('app:activeProject', activeProjectInfo); });
ipcMain.handle('app:getActiveProject', () => activeProjectInfo);
ipcMain.on('app:settingsChanged', (_e, s) => broadcastToModules('app:settingsChanged', s || {}));
ipcMain.on('app:notesChanged', (e, { id } = {}) => {
  for (const w of moduleWindows.values()) { if (w && !w.isDestroyed() && w.webContents !== e.sender) sendTo(w, 'app:notesChanged', { id }); }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== e.sender) sendTo(mainWindow, 'app:notesChanged', { id });
});
ipcMain.on('app:agendaChanged', (e, { id } = {}) => {
  for (const w of moduleWindows.values()) { if (w && !w.isDestroyed() && w.webContents !== e.sender) sendTo(w, 'app:agendaChanged', { id }); }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== e.sender) sendTo(mainWindow, 'app:agendaChanged', { id });
});

// ── Действия из окна модуля → переслать редактору (терминал) или модулю вивера (файл/дерево) ──
function forwardToEditor(ch, payload) {
  sendTo(mainWindow, ch, payload);
  if (ch === 'editor:restGuard') {
    for (const w of detachedTermWindows.values()) sendTo(w, ch, payload);
  }
}
function filesWindow() { const w = moduleWindows.get('files'); return (w && !w.isDestroyed()) ? w : null; }
function docWindow() { const w = moduleWindows.get('doc'); return (w && !w.isDestroyed()) ? w : null; }
function routeOpenInViewer(payload) {
  moduleRouter.sendWhenReady('files', 'editor:openInViewer', payload);
}
ipcMain.on('editor:openInViewer', (_e, payload) => routeOpenInViewer(payload));
let viewStageRoot = null;
function viewStageDir() {
  if (!viewStageRoot || !fs.existsSync(viewStageRoot)) viewStageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lite-editor-view-${process.pid}-`));
  return viewStageRoot;
}
function stageTextForViewer(name, content) {
  const base = String(name || 'export.txt').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120) || 'export.txt';
  const dir = path.join(viewStageDir(), Date.now().toString(36) + crypto.randomBytes(9).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, base);
  fs.writeFileSync(file, String(content == null ? '' : content), { encoding: 'utf8', mode: 0o600 });
  return file;
}
app.on('will-quit', () => {
  remoteViewerFiles.clear();
  if (viewStageRoot) { try { fs.rmSync(viewStageRoot, { recursive: true, force: true }); } catch (_) {} viewStageRoot = null; }
});
async function sweepStaleViewStageRoots() {
  const tmp = os.tmpdir();
  let names;
  try { names = await fs.promises.readdir(tmp); } catch (_) { return; }
  for (const n of names) {
    const m = /^lite-editor-view-(\d+)-/.exec(n);
    const pid = m ? Number(m[1]) : 0;
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 0); continue; } catch (e) { if (!e || e.code !== 'ESRCH') continue; }
    const p = path.join(tmp, n);
    try {
      const st = await fs.promises.lstat(p);
      if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) continue;
      await fs.promises.rm(p, { recursive: true, force: true });
    } catch (_) {}
  }
}
app.whenReady().then(() => { setTimeout(() => { sweepStaleViewStageRoots().catch(() => {}); }, 20000); });
ipcMain.handle('editor:openTextInViewer', (_e, { name, content } = {}) => {
  try {
    const file = stageTextForViewer(name, content);
    routeOpenInViewer({ path: file });
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
const remoteViewerFiles = new Map(); // tmpFile -> { rhId, remotePath }
ipcMain.handle('rh:fsOpenInViewer', async (_e, { id, path: p } = {}) => {
  try {
    const r = await rhApi.readFile(id, p);
    if (!r || r.error) return { ok: false, error: (r && r.error) || 'не удалось прочитать файл' };
    if (r.notUtf8) return { ok: false, error: 'Файл не в кодировке UTF-8 — правка в вивере испортила бы его. Скачайте файл' };
    if (r.binary) return { ok: false, error: 'Бинарный файл — в вивере не редактируется' };
    const file = stageTextForViewer(path.posix.basename(String(p || '')) || 'remote.txt', r.content || '');
    remoteViewerFiles.set(file, { rhId: id, remotePath: p });
    routeOpenInViewer({ path: file });
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
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
const rhZipOps = new Map(); // opId -> AbortController
ipcMain.handle('rh:fsDownloadZip', async (e, { id, path: p, opId } = {}) => {
  const base = path.posix.basename(String(p || '').replace(/\/+$/, '')) || 'root';
  const last = loadState().lastOpenDir;
  const res = await dialog.showSaveDialog(senderWin(e) || mainWindow, {
    title: 'Скачать папку как ZIP',
    defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), base + '.zip'),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const ac = new AbortController();
  rhZipOps.set(opId, ac);
  const sender = e.sender;
  saveState({ lastOpenDir: path.dirname(res.filePath) });
  try {
    const r = await rhApi.downloadZip(id, p, res.filePath, {
      signal: ac.signal,
      onProgress: (pr) => { if (!sender.isDestroyed()) sender.send('rh:zipProgress', { opId, file: res.filePath, ...pr }); },
    });
    if (r && r.canceled) return { canceled: true };
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'не удалось скачать папку' };
    return { ok: true, file: res.filePath, files: r.files, bytes: r.bytes, skipped: r.skipped };
  } finally { rhZipOps.delete(opId); }
});
ipcMain.on('rh:zipCancel', (_e, { opId } = {}) => { const ac = rhZipOps.get(opId); if (ac) ac.abort(); });
ipcMain.on('editor:refreshTree', (_e, payload) => {
  const w = filesWindow(); if (w) sendTo(w, 'editor:refreshTree', payload);
  const df = liveFilesDockFrame(); if (df) sendToFrame(df, 'editor:refreshTree', payload);
});
ipcMain.on('editor:focusGit', () => {
  moduleRouter.sendWhenReady('files', 'editor:focusGit', undefined, { focus: true, dedupe: true });
});
ipcMain.on('editor:viewerReady', (e) => {
  const fromDock = !!(mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents
    && e.senderFrame && e.senderFrame !== mainWindow.webContents.mainFrame);
  if (fromDock) { filesDockFrame = e.senderFrame; filesDockVisible = true; scheduleSyncWatchers(0); }
  const df = liveFilesDockFrame();
  const override = (df && (isFilesDocked() || fromDock)) ? { __isFrame: true, frame: df } : undefined;
  moduleRouter.markReady('files', override);
});
ipcMain.on('editor:dockFiles', (_e, { docked } = {}) => {
  const want = !!docked;
  patchStoreKey('settings', { dockFiles: want }, [], null, null);
  if (want) {
    const w = filesWindow();
    if (w) { w.__forceClose = true; try { w.close(); } catch (_) {} }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      sendTo(mainWindow, 'editor:ensureFilesDock', { open: true });
    }
  } else {
    filesDockFrame = null;
    filesDockVisible = false;
    moduleRouter.markNotReady('files', { clearArg: false, clearQueue: false });
    if (mainWindow && !mainWindow.isDestroyed()) sendTo(mainWindow, 'editor:ensureFilesDock', { close: true });
    openModuleWindow('files');
  }
  scheduleSyncWatchers(0);
});
ipcMain.on('editor:filesDockState', (_e, { open } = {}) => {
  filesDockVisible = !!open;
  scheduleSyncWatchers(0);
});
ipcMain.on('editor:closeFilesDock', () => {
  filesDockVisible = false;
  scheduleSyncWatchers(0);
  if (mainWindow && !mainWindow.isDestroyed()) sendTo(mainWindow, 'editor:ensureFilesDock', { close: true });
});

// Кросс-модульные открытия («Контейнеры» / вивер → «БД» / «RabbitMQ» / «Хранилища» / «Kafka») через moduleRouter:
ipcMain.on('db:openFromContainer', (_e, payload) => {
  if (payload && typeof payload === 'object') moduleRouter.sendWhenReady('db', 'db:openFromContainer', payload, { focus: true });
});
ipcMain.on('db:openSql', (_e, payload) => {
  if (payload && typeof payload === 'object') moduleRouter.sendWhenReady('db', 'db:openSql', payload, { focus: true });
});
ipcMain.on('db:panelReady', () => { moduleRouter.markReady('db'); });
ipcMain.on('rmq:openFromContainer', (_e, payload) => {
  if (payload && typeof payload === 'object') moduleRouter.sendWhenReady('rmq', 'rmq:openFromContainer', payload, { focus: true });
});
ipcMain.on('rmq:panelReady', () => { moduleRouter.markReady('rmq'); });
ipcMain.on('st:openFromContainer', (_e, payload) => {
  if (payload && typeof payload === 'object') moduleRouter.sendWhenReady('storage', 'st:openFromContainer', payload, { focus: true });
});
ipcMain.on('st:panelReady', () => { moduleRouter.markReady('storage'); });
ipcMain.on('kafka:openFromContainer', (_e, payload) => {
  if (payload && typeof payload === 'object') moduleRouter.sendWhenReady('kafka', 'kafka:openFromContainer', payload, { focus: true });
});
ipcMain.on('kafka:panelReady', () => { moduleRouter.markReady('kafka'); });

ipcMain.on('editor:sendToTerminal', (_e, payload) => {
  const pid = activeProjectInfo && activeProjectInfo.id;
  const dw = pid ? detachedTermWindows.get(pid) : null;
  if (dw && !dw.isDestroyed()) { sendTo(dw, 'projTerm:sendText', payload || {}); return; }
  forwardToEditor('editor:sendToTerminal', payload);
});
ipcMain.on('editor:sendNoteToTerminal', (_e, payload) => {
  const pid = (payload && payload.projId) || (activeProjectInfo && activeProjectInfo.id);
  const dw = pid ? detachedTermWindows.get(pid) : null;
  if (dw && !dw.isDestroyed()) { sendTo(dw, 'projTerm:sendText', payload || {}); return; }
  forwardToEditor('editor:sendNoteToTerminal', payload);
});
ipcMain.on('editor:refreshProjects', () => { sendTo(mainWindow, 'editor:refreshProjects'); });

// ── Вынесенные окна терминалов: IPC ────────────────────────────────────────────────────────────
ipcMain.handle('projTerm:detach', (_e, { project, snapshot } = {}) => {
  const projId = project && project.id ? String(project.id) : (snapshot && snapshot.projId ? String(snapshot.projId) : '');
  return openDetachedTermWindow(projId, project, snapshot);
});
ipcMain.handle('projTerm:dock', async (_e, { projId } = {}) => {
  if (!projId) return { ok: false };
  return reattachDetachedTermWindow(String(projId));
});
ipcMain.on('projTerm:focus', (_e, { projId } = {}) => {
  const w = projId ? detachedTermWindows.get(String(projId)) : null;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
});
ipcMain.on('projTerm:focusSession', (_e, { projId, sid } = {}) => {
  const w = projId ? detachedTermWindows.get(String(projId)) : null;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  if (sid) sendTo(w, 'projTerm:focusSession', { sid: String(sid) });
});
ipcMain.on('projTerm:sendText', (_e, { projId, text } = {}) => {
  const w = projId ? detachedTermWindows.get(String(projId)) : null;
  if (w && !w.isDestroyed()) sendTo(w, 'projTerm:sendText', { projId, text });
});
ipcMain.on('projTerm:closeProject', (_e, { projId } = {}) => {
  if (projId) closeDetachedProjectWindow(String(projId), { killPtys: true });
});
ipcMain.handle('projTerm:listDetached', () => {
  const statuses = [];
  for (const [projId, meta] of detachedTermMeta) {
    if (meta && meta.status) statuses.push({ projId, ...meta.status });
  }
  return { ids: detachedProjIds(), statuses };
});
ipcMain.handle('projTerm:getInit', (_e, { projId } = {}) => {
  const id = String(projId || '');
  const meta = detachedTermMeta.get(id);
  if (!meta) return { ok: false };
  const liveOnDetach = meta.liveOnDetach || new Set();
  const aliveLiveIds = [...liveOnDetach].filter((sid) => ptys.has(sid));
  const deadOnDetachIds = [...liveOnDetach].filter((sid) => !ptys.has(sid));
  return {
    ok: true,
    projId: id,
    project: meta.project,
    snapshot: meta.snapshot,
    aliveLiveIds,
    deadOnDetachIds,
  };
});
ipcMain.on('projTerm:syncSnapshot', (_e, { projId, snapshot } = {}) => {
  const id = String(projId || '');
  const meta = id ? detachedTermMeta.get(id) : null;
  if (!meta || !snapshot) return;
  const norm = normalizeProjTermSnapshot(snapshot, id);
  if (norm) {
    meta.snapshot = norm;
    sendTo(mainWindow, 'projTerm:snapshot', { projId: id, snapshot: norm });
  }
});
ipcMain.on('projTerm:reportStatus', (_e, payload = {}) => {
  const projId = payload && payload.projId ? String(payload.projId) : '';
  if (!projId) return;
  const meta = detachedTermMeta.get(projId);
  if (meta) meta.status = payload;
  sendTo(mainWindow, 'projTerm:status', payload);
});
ipcMain.on('projTerm:collectResult', (_e, { reqId, snapshot } = {}) => {
  const fn = reqId ? detachedCollectors.get(reqId) : null;
  if (fn) fn(snapshot);
});
ipcMain.on('projTerm:reattachAck', (_e, { ackId } = {}) => {
  const fn = ackId ? detachedAckers.get(ackId) : null;
  if (fn) fn();
});
ipcMain.on('projTerm:searchResult', (_e, { reqId, hits } = {}) => {
  const fn = reqId ? detachedSearchers.get(reqId) : null;
  if (fn) fn(Array.isArray(hits) ? hits : []);
});
ipcMain.handle('projTerm:searchBuffers', async (_e, { query, isRe, caseSens } = {}) => {
  if (detachedTermWindows.size === 0) return [];
  const tasks = [];
  for (const [projId, w] of detachedTermWindows) {
    if (!w || w.isDestroyed()) continue;
    tasks.push(new Promise((resolve) => {
      const reqId = `pts_${++detachedReqSeq}`;
      const timer = setTimeout(() => { detachedSearchers.delete(reqId); resolve([]); }, 500);
      detachedSearchers.set(reqId, (hits) => {
        clearTimeout(timer);
        detachedSearchers.delete(reqId);
        resolve(hits.map((h) => ({ ...h, projId })));
      });
      if (!sendTo(w, 'projTerm:searchBuffers', { reqId, query, isRe, caseSens })) {
        clearTimeout(timer);
        detachedSearchers.delete(reqId);
        resolve([]);
      }
    }));
  }
  const chunks = await Promise.all(tasks);
  return chunks.flat();
});

// Reflect how many agents need attention on the tray tooltip (and macOS title).
// Меню трея статичное — ставим его только при создании трея и смене языка (setTrayMenu).
// Раньше оно пересобиралось на каждый tray:update, то есть на каждую смену состояния любого
// терминала; на Linux это ещё и повторная публикация меню по DBus (StatusNotifier).
let trayAttention = 0;
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: i18n.t('Показать LiteEditor'), click: showWindow },
    { type: 'separator' },
    // Через закрытие окна редактора: оно одно спросит окна модулей о несохранённом и проверит активных агентов в PTY.
    { label: i18n.t('Выход'), click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) { quitViaApp = true; mainWindow.close(); } else app.quit();
    } },
  ]);
}
function setTrayMenu() { if (tray) { try { tray.setContextMenu(trayMenu()); } catch (_) {} } }
function updateTrayTooltip() {
  if (!tray) return;
  tray.setToolTip(trayAttention > 0 ? `LiteEditorAI — ${i18n.t('{0} ждут ответа', trayAttention)}` : 'LiteEditorAI');
}
ipcMain.on('tray:update', (_e, { attention } = {}) => {
  const n = attention || 0;
  if (n === trayAttention) return;   // рендерер шлёт на смене числа, но старое окно может слать чаще
  trayAttention = n;
  updateTrayTooltip();
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
  growDesiredWidth = Math.max(760, base + (Number(dx) || 0)); // нечисловой dx навсегда сделал бы ширину NaN
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

// Окно-владелец уничтожено (✕ у окна «Система · ~», падение окна модуля → destroy): его шеллы
// больше некому показать — подхват после перезагрузки есть только у окна редактора (pty:adoptable),
// а новое окно нумерует вкладки заново. Без этого bash и всё запущенное в нём жили до выхода из
// редактора. Владельца держим при самом процессе: ownerBySession чистит 'closed' окна модуля.
const ptyOwner = new WeakMap();        // IPty → webContents окна-владельца
const ptyOwnerHooked = new WeakSet();  // webContents, на чей 'destroyed' уже подписаны
function bindPtyOwner(proc, owner) {
  if (!proc || !owner) return;
  ptyOwner.set(proc, owner);
  if (ptyOwnerHooked.has(owner)) return;
  ptyOwnerHooked.add(owner);
  try {
    owner.once('destroyed', () => {
      for (const [id, p] of [...ptys]) {
        if (ptyOwner.get(p) !== owner) continue;
        const g = ptyFlows.get(id); if (g) g.reset();
        ptyFlows.delete(id);
        try { p.kill(); } catch (_) {}
        ptys.delete(id);
        ptyRings.delete(id);
        dropOrphan(id);
        try { mcpHub.revokeByPty(id); } catch (_) {}
      }
    });
  } catch (_) {}
}

// owner = webContents окна, создавшего сессию (редактор для терминалов проектов, окно «Система · ~»
// для scratch). Данные/выход маршрутизируем владельцу (sendToOwner; фолбэк — окно редактора).
function spawnPtyFor(id, cwd, cols, rows, owner) {
  if (owner) ownerBySession.set(id, owner);
  const { file: shell, args: shellArgs } = resolveShell();
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const proj = resolveProjectForPty(id, startCwd);
  const mcpSess = mcpHub.issueSession({ ptyId: id, projectId: proj.id, projectName: proj.name, agentKind: 'unknown' });
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
      env: userShellEnv({ SHELL: shell, ...(mcpSess ? mcpSess.env : {}) }),   // SHELL → реальный шелл + токен MCP сессии
    });
  } catch (err) {
    try { mcpHub.revokeByPty(id); } catch (_) {}
    logger.log('error', 'pty', 'spawn failed', err);
    sendToOwner(id, 'pty:data', { id, data: `\r\n\x1b[31mНе удалось запустить шелл (${shell}): ${err.message}\x1b[0m\r\n` });
    sendToOwner(id, 'pty:exit', { id });
    ownerBySession.delete(id); // сессии нет — маршрут не нужен (как в onExit)
    return { error: String(err.message || err) };
  }
  logger.log('info', 'pty', `spawned pid=${proc.pid}`);
  ptyRings.delete(id);
  const oldGate = ptyFlows.get(id); if (oldGate) oldGate.reset();
  const gate = createFlowGate({
    onPause: () => { try { proc.pause(); } catch (_) {} },
    onResume: () => { try { proc.resume(); } catch (_) {} },
  });
  ptyFlows.set(id, gate);
  // Вывод — окну-владельцу (редактор/scratch-окно), склеенный: после тишины кусок уходит сразу,
  // под потоком — пачкой раз в 5 мс (lib/ptybatch.js) с паузой PTY при переполнении очереди xterm.
  const out = createBatcher((data) => {
    ptyRings.push(id, data);
    if (sendToOwner(id, 'pty:data', { id, data })) {
      gate.sent(data.length);
    }
  });
  proc.onData((data) => out.push(data));
  proc.onExit(() => {
    out.flush();
    if (ptys.get(id) && ptys.get(id) !== proc) return; // replaced by a restart — suppress stale exit
    const g = ptyFlows.get(id); if (g) g.reset();
    ptyFlows.delete(id);
    ptys.delete(id);
    ptyRings.delete(id);
    sendToOwner(id, 'pty:exit', { id });
    ownerBySession.delete(id); // сессия закрылась — не копим мёртвые id в карте маршрутизации (B4-LOW)
    dropOrphan(id);
    try { mcpHub.revokeByPty(id); } catch (_) {}
  });
  ptys.set(id, proc);
  bindPtyOwner(proc, owner);
  return { ok: true };
}
ipcMain.handle('pty:create', (e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) {
    dropOrphan(id);
    const g = ptyFlows.get(id); if (g) g.reset();
    ownerBySession.set(id, e.sender);
    bindPtyOwner(ptys.get(id), e.sender);
    return { ok: true, existed: true, backlog: ptyRings.read(id) };
  }
  return spawnPtyFor(id, cwd, cols, rows, e.sender);
});
// Kill the existing PTY (if any) and start a fresh one in the same cwd.
ipcMain.handle('pty:restart', (e, { id, cwd, cols, rows }) => {
  dropOrphan(id);
  const g = ptyFlows.get(id); if (g) g.reset();
  ptyFlows.delete(id);
  ptyRings.delete(id);
  try { mcpHub.revokeByPty(id); } catch (_) {}
  const old = ptys.get(id);
  if (old) { try { old.kill(); } catch (_) {} ptys.delete(id); }
  return spawnPtyFor(id, cwd, cols, rows, e.sender);
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:ack', (_e, { id, bytes } = {}) => { const g = ptyFlows.get(id); if (g) g.ack(Number(bytes) || 0); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
});
ipcMain.on('pty:kill', (_e, { id }) => {
  dropOrphan(id);
  const g = ptyFlows.get(id); if (g) g.reset();
  ptyFlows.delete(id);
  ptyRings.delete(id);
  try { mcpHub.revokeByPty(id); } catch (_) {}
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); }
});
// Терминалы этого окна, пережившие перезагрузку страницы: новая страница забирает их по id.
ipcMain.handle('pty:adoptable', (e) => [...orphanPtys.keys()].filter((id) => ptys.has(id) && ownerBySession.get(id) === e.sender));
// 'shell' | 'running' | 'waiting' | null — опрашивается вне главного потока через procService.
ipcMain.handle('pty:foregroundState', (_e, { id }) => {
  const p = ptys.get(id);
  return p && p.pid ? procService.foregroundKind(p.pid) : null;
});
// { fg, claude: { status, waitingFor } | null } | null — то же плюс отчёт Claude Code, если он
// на переднем плане (lib/agentstate.js). По нему индикатор отличает «работает» / «ждёт вас» / «готов».
ipcMain.handle('pty:agentState', (_e, { id }) => {
  const p = ptys.get(id);
  return p && p.pid ? procService.agentState(p.pid) : null;
});
// Какой агент на переднем плане каждого из терминалов ids и можно ли закрыть терминал без потерь
// (lib/agentstate.js agentOf) — для фильтра «только проекты с агентом» в «Избранном» и закрытия
// случайно открытых терминалов. { [id]: { fg, agent, idle } }; вне Linux ответа по терминалу нет.
// Какие TCP-порты слушают процессы каждого из терминалов ids (lib/ports.js) — чипы «:5173» в
// нижней панели. { [id]: [{ port, comm, pid, loopback }] }; вне Linux — пусто.
ipcMain.handle('pty:ports', (_e, { ids } = {}) => {
  const out = {};
  if (process.platform !== 'linux') return out;
  for (const id of Array.isArray(ids) ? ids.slice(0, 16) : []) {
    const p = ptys.get(id);
    if (p && p.pid) { try { out[String(id)] = portsLib().listeningPorts(p.pid, { excludePids: [process.pid] }); } catch (_) { out[String(id)] = []; } }
  }
  return out;
});
let _portsLib = null;
function portsLib() { return _portsLib || (_portsLib = require('./lib/ports')); }
ipcMain.handle('pty:agents', (_e, { ids } = {}) => {
  const entries = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 500) : []) {
    const p = ptys.get(id);
    if (p && p.pid) entries.push([String(id), p.pid]);
  }
  return procService.agents(entries);
});

// ---------------------------------------------------------------- Монитор ресурсов
// Самонаблюдение за потреблением. Снимок раздельно по двум мирам:
//   • Electron-процессы (app.getAppMetrics, маппинг pid→окно) — это «сам редактор», что и можно
//     оптимизировать (число окон-модулей, утечки в рендерерах);
//   • деревья процессов терминалов (PTY-агенты, /proc — ТОЛЬКО Linux) — «полезная нагрузка», к
//     редактору отношения почти не имеет (claude/codex молотят по делу). Не смешиваем, чтобы цифры
//     агентов не выдавались за расход редактора.
// Обход /proc для деревьев PTY вынесен в фоновый worker_threads (lib/proc-service.js) и ходит по
// потомкам шелла (/proc/<pid>/task/*/children), не читая /proc всех тысяч процессов системы.
const MODULE_TITLES = {
  tools: 'Инструменты', iterflow: 'IterFlow', seo: 'WEB/SEO аудит', audit: 'Аудит',
  pomodoro: 'Помодоро', notes: 'Задачи', db: 'Базы данных',
  chat: 'OpenRouter', doc: 'Обработка текста', docker: 'Контейнеры', rh: 'Удалённые хосты',
  ctx: 'Контекст', scratch: 'Система · ~', files: 'Проект', monitor: 'Монитор', gitgraph: 'Граф Git', servers: 'Серверы',
};
function monitorSessionLabel(sid) {
  const s = String(sid);
  const pid = s.split('::')[0];
  try { const p = (readStoreKey('projects') || []).find((x) => x.id === pid); if (p) return 'Терминал: ' + p.name; } catch (_) {}
  return 'Терминал: ' + s;
}

ipcMain.handle('monitor:sample', async () => {
  // ── Electron-процессы: pid → понятная метка (окно/модуль/GPU/служебный) ──
  const pidLabel = new Map();
  try { pidLabel.set(process.pid, { label: 'Ядро (main)', kind: 'main' }); } catch (_) {}
  try { if (mainWindow && !mainWindow.isDestroyed()) pidLabel.set(mainWindow.webContents.getOSProcessId(), { label: 'Главное окно', kind: 'window' }); } catch (_) {}
  for (const [modId, w] of moduleWindows) {
    if (!w || w.isDestroyed()) continue;
    // Заголовок окна — запасной источник имени: словарь выше знает не все модули (sitemon, voice, kafka…).
    const title = MODULE_TITLES[modId] || String(w.getTitle() || '').replace(/^LiteEditorAI\s*—\s*/, '') || modId;
    try { pidLabel.set(w.webContents.getOSProcessId(), { label: 'Окно: ' + title, kind: 'window' }); } catch (_) {}
  }
  for (const [projId, w] of detachedTermWindows) {
    if (!w || w.isDestroyed()) continue;
    const meta = detachedTermMeta.get(projId);
    const name = (meta && meta.project && meta.project.name) || String(w.getTitle() || '').replace(/^LiteEditorAI\s*—\s*/, '') || projId;
    try { pidLabel.set(w.webContents.getOSProcessId(), { label: 'Терминалы: ' + name, kind: 'window' }); } catch (_) {}
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

  // ── PTY-агенты: деревья процессов терминалов (Linux, в worker_threads) ──
  const entries = [];
  for (const [sid, proc] of ptys) {
    if (proc && proc.pid) entries.push([String(sid), proc.pid]);
  }
  const ptySnap = await procService.samplePtyTrees(entries, monitorSessionLabel);

  const editorMem = electron.reduce((s, p) => s + p.memBytes, 0);
  const editorCpu = Math.round(electron.reduce((s, p) => s + p.cpu, 0) * 10) / 10;
  return {
    ok: true, ts: Date.now(),
    editor: { procs: electron, totalMem: editorMem, totalCpu: editorCpu },
    pty: ptySnap,
  };
});

// ---------------------------------------------------------------- «Сейф паролей» (KeePass/.kdbx, ленивая загрузка)
createLazyIpc(ipcMain, {
  handles: KEEPASS_HANDLES,
  ons: KEEPASS_ONS,
  load: (ipc) => registerKeepassIpc({
    app, ipcMain: ipc, dialog, clipboard, atomicWriteSync,
    senderWin: (e) => senderWin(e),
    getMainWindow: () => mainWindow,
    lastDirOpts, saveState,
  }),
});

// ---------------------------------------------------------------- заставка «матрица» (кросс-оконный простой)
// Активность ЛЮБОГО окна (редактор + окна модулей) шлёт screensaver:activity → обновляем метку простоя
// и, если заставка показана авто, гасим её. Тик раз в 5с: если включено в настройках и простой дольше
// порога — показываем заставку на ГЛАВНОМ окне (screensaver:set on). Настройки: settings.screensaver
// (вкл, по умолчанию ДА) + settings.screensaverMins (минуты, по умолчанию 5).
let ssLast = Date.now();
let ssActive = false;
function ssConfig() { const s = readSettingsCached(); return { on: s.screensaver !== false, mins: Math.max(1, Math.min(180, Number(s.screensaverMins) || 5)) }; }
function ssSet(on) { ssActive = on; sendTo(mainWindow, 'screensaver:set', { on }); }
ipcMain.on('screensaver:activity', () => { ssLast = Date.now(); if (ssActive) ssSet(false); });
const ssTimer = setInterval(() => {
  const { on, mins } = ssConfig();
  if (!on || ssActive) return;
  if (Date.now() - ssLast > mins * 60000) ssSet(true);
}, 5000);
if (ssTimer.unref) ssTimer.unref();

// ---------------------------------------------------------------- мониторинг сайтов (lib/ipc/sitemon.js)
sitemonApi = registerSitemonIpc({
  ipcMain, BrowserWindow, Notification,
  readStoreKey, writeStoreKey, appStore,
  sendTo,
  getMainWindow: () => mainWindow,
  getModuleWindows: () => moduleWindows.values(),
  onSitesChanged: () => { try { serversApi.sitesChanged(); } catch (_) {} },
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
    const igRoot = gitignore.findIgnoreRoot(dir);
    const ig = igRoot ? gitignore.forProject(igRoot, IGNORE_DIRS) : null;
    return out
      .filter((e) => {
        if (!e.dir) return true; // одиночные файлы (.env и т.п.) остаются видимыми в дереве
        if (IGNORE_DIRS.has(e.name)) return false;
        if (ig && igRoot) {
          const rel = path.relative(igRoot, e.path);
          if (rel && !rel.startsWith('..') && ig.ignores(rel, true)) return false;
        }
        return true;
      })
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
    const buf = await fs.promises.readFile(file);
    // Файл не в UTF-8 (windows-1251, latin1): в декодированном тексте вместо букв «�», и запись его назад
    // (автосейв вивера через 400 мс после любой правки) уничтожала исходный текст безвозвратно. Флаг
    // говорит вивера и модулям не давать такой файл править.
    return isUtf8(buf) ? { content: buf.toString('utf8') } : { content: buf.toString('utf8'), notUtf8: true };
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
// Записи ОДНОГО пути — строго по очереди прихода. Запись — это снимок истории, сосед и rename (плюс
// заливка на хост), и у двух параллельных вызовов (автосейв и Ctrl+S «Обработки текста», два окна над
// одним файлом) шаги разной длины: более ранний вызов мог завершиться последним, и на диске оставался
// старый текст, а окно уже считало файл сохранённым. Две заливки по SFTP ещё и перемешивали бы байты.
const fileWriteChains = new Map();   // абсолютный путь → хвост очереди записей
function serialFileWrite(file, job) {
  const key = path.resolve(String(file));
  const run = (fileWriteChains.get(key) || Promise.resolve()).then(job, job);
  const tail = run.then(() => {}, () => {});
  fileWriteChains.set(key, tail);
  tail.then(() => { if (fileWriteChains.get(key) === tail) fileWriteChains.delete(key); });
  return run;
}
ipcMain.handle('fs:writeFile', (_e, { file, content }) => serialFileWrite(file, async () => {
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
}));
ipcMain.handle('fs:mkdir', async (_e, { parent, name }) => {
  const safe = safeChildName(name);                       // блокируем ../ и сепараторы (PC-3)
  if (!safe) return { error: 'недопустимое имя' };
  try {
    const full = path.join(parent, safe);
    await fs.promises.mkdir(full, { recursive: false });
    return { path: full, name: safe };
  } catch (err) { return { error: String(err.message || err) }; }
});
// Асинхронно: синхронный stat на отвалившемся sshfs/NFS подвесил бы весь главный процесс.
const pathExists = (p) => fs.promises.access(String(p)).then(() => true, () => false);
ipcMain.handle('fs:exists', (_e, p) => (p ? pathExists(p) : false));
// Пачкой — для проверки всех проектов на возврат фокуса (один IPC вместо запроса на проект).
ipcMain.handle('fs:existsMany', (_e, paths) => (Array.isArray(paths) ? Promise.all(paths.map((p) => (p ? pathExists(p) : false))) : []));

// create a file or directory inside parent
// Файл можно создать сразу по пути внутри parent («src/app.js» — так обещает подсказка «Новый файл»
// в дереве): каждый сегмент проходит safeChildName, так что «..», абсолютный путь и «C:» — по-прежнему
// отказ (PC-3), а файл не выходит за parent. Папка — одним именем, как было.
ipcMain.handle('fs:create', async (_e, { parent, name, dir }) => {
  const segs = (!dir && typeof name === 'string') ? name.split(/[\\/]/).map(safeChildName) : [safeChildName(name)];
  if (segs.some((s) => !s)) return { error: 'недопустимое имя' };
  const safe = segs[segs.length - 1];
  try {
    const full = path.join(parent, ...segs);
    if (fs.existsSync(full)) return { error: 'уже существует' };
    if (dir) await fs.promises.mkdir(full, { recursive: false });
    else { await fs.promises.mkdir(path.dirname(full), { recursive: true }); await fs.promises.writeFile(full, '', { flag: 'wx' }); }
    return { path: full, name: safe, dir: !!dir };
  } catch (err) { return { error: String(err.message || err) }; }
});
// Смена только регистра («readme.md» → «README.md») на нечувствительной к регистру ФС (macOS, Windows):
// existsSync(to) там видит сам источник. Это не чужой файл, если путь совпадает без учёта регистра
// и указывает на тот же inode; на Linux одноимённые в другом регистре — разные файлы, их не трогаем.
async function isSameFileOtherCase(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  const a0 = path.resolve(from), b0 = path.resolve(to);   // вивер склеивает «to» через '/', на Windows «from» — с '\'
  if (a0 === b0 || a0.toLowerCase() !== b0.toLowerCase()) return false;
  try {
    // lstat: две разные ссылки на один файл — разные записи каталога, их rename не должен склеивать
    const [a, b] = await Promise.all([fs.promises.lstat(from, { bigint: true }), fs.promises.lstat(to, { bigint: true })]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (_) { return false; }
}
ipcMain.handle('fs:rename', async (_e, { from, to }) => {
  try {
    if (fs.existsSync(to) && !(await isSameFileOtherCase(from, to))) return { error: 'цель уже существует' };
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
      // другое устройство: rename невозможен → копируем и удаляем оригинал; при сбое копии чистим частичный dest.
      // verbatimSymlinks: по умолчанию cp переписывает относительные ссылки в абсолютные на ИСХОДНОЕ место,
      // которое следом удаляется, — перенесённые ссылки оказывались битыми. rename текст ссылки не трогает.
      try { await fs.promises.cp(src, dest, { recursive: true, verbatimSymlinks: true }); }
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
    // как в fs:readFile: FIFO с «картиночным» именем повесил бы readFile (и поток пула libuv) навсегда
    if (!stat.isFile()) return { error: 'Это не обычный файл (сокет/FIFO/каталог)' };
    if (stat.size > 12 * 1024 * 1024) return { error: 'файл слишком большой для превью' };
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = IMG_MIME[ext] || 'application/octet-stream';
    const buf = await fs.promises.readFile(file);
    return { url: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) { return { error: String(err.message || err) }; }
});

// ---------------------------------------------------------------- files: проектные хелперы вивера
// Ctrl+P (рекурсивный листинг), поиск по проекту (ripgrep / worker_threads) и сравнение двух файлов (git --no-index).
const FILES_LIST_CAP = 30000;                  // потолок файлов для Ctrl+P
const FILES_SEARCH_CAP = 1000;                 // потолок совпадений для поиска по проекту
const FILES_SEARCH_FILE_MAX = 1024 * 1024;     // не грепаем файлы крупнее 1 МБ (минифицированные/данные)
ipcMain.handle('files:listAll', (_e, root) => fastSearch.listFiles(root, { cap: FILES_LIST_CAP }));
ipcMain.handle('files:search', (_e, { root, query, opts } = {}) =>
  fastSearch.searchProject(root, query, Object.assign({}, opts, { cap: FILES_SEARCH_CAP, maxFileSize: FILES_SEARCH_FILE_MAX })));
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
  // Один файл под двумя путями (симлинк на папку внутри проекта — обход поиска находит его под обоими
  // именами) правился бы дважды: второй проход перечитывал уже заменённое, и «foo» → «fooBar» давало
  // «fooBarBar». Цели сводим по реальному пути, строки объединяем (повтор номера — одна замена).
  const jobs = new Map();   // realpath → { full, file, lines:Set<number> }
  for (const t of targets) {
    if (!t || !t.file || !Array.isArray(t.lines) || !t.lines.length) continue;
    const full = path.resolve(rootNorm, t.file);
    if (full !== rootNorm && !full.startsWith(rootNorm + path.sep)) continue;
    let real; try { real = await fs.promises.realpath(full); } catch { continue; }
    let job = jobs.get(real);
    if (!job) { job = { full, file: t.file, lines: new Set() }; jobs.set(real, job); }
    for (const ln of t.lines) job.lines.add(ln | 0);
  }
  let files = 0, lines = 0;
  const skipped = [];   // файлы не в UTF-8 — не тронуты
  for (const t of jobs.values()) {
    const full = t.full;
    // Прочитать-заменить-записать — в общей очереди записей пути (serialFileWrite): сохранение из вивера,
    // пришедшее между чтением и записью, иначе затиралось бы заменой.
    const res = await serialFileWrite(full, async () => {
      let st; try { st = await fs.promises.stat(full); } catch { return null; }
      if (!st.isFile() || st.size > FILES_SEARCH_FILE_MAX) return null;
      let buf; try { buf = await fs.promises.readFile(full); } catch { return null; }
      // Не UTF-8 (windows-1251 и т.п.): замена записала бы файл уже в UTF-8 с «�» вместо всех букв.
      if (!isUtf8(buf)) return { skipped: true };
      const text = buf.toString('utf8');
      if (text.includes('\0')) return null;
      const rows = text.split('\n');
      let touched = 0;
      for (const ln of t.lines) {
        const i = ln - 1;
        if (i < 0 || i >= rows.length) continue;
        re.lastIndex = 0;
        const next = rows[i].replace(re, repl);
        if (next !== rows[i]) { rows[i] = next; touched++; }
      }
      if (!touched) return null;
      try {
        // локальная история: состояние до замены — мимо троттла, иначе после автосейва <45 с назад
        // замену по проекту было не откатить: версии «до» в истории не оставалось
        await histSnapshot(full, text, 'save', { force: true });
        await writeFileCrashSafe(full, rows.join('\n'));   // как и вивер: обрыв не оставляет обрезанный файл
        return { touched };
      } catch (err) { return { error: String(err.message || err) }; }
    });
    if (!res) continue;
    if (res.skipped) { skipped.push(t.file); continue; }
    if (res.error) return { error: res.error + ' (' + t.file + ')', files, lines, skipped };
    files++; lines += res.touched;
  }
  return { ok: true, files, lines, skipped };
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
// Стриминговый брат files:search через lib/fast-search.js (системный rg или worker_threads):
// результат течёт пачками, а главный поток Electron не читает файлы проектов в свою кучу V8.
const GSX_TOTAL_CAP = 5000;                 // общий потолок совпадений на запрос
const GSX_PER_FILE_CAP = 50;                // на файл: один минифицированный бандл не съест всю выдачу
const GSX_FILE_MAX = 2 * 1024 * 1024;       // крупнее — не грепаем (данные/бандлы)
const GSX_FLUSH_HITS = 200;                 // пачка совпадений…
const GSX_FLUSH_MS = 120;                   // …либо столько миллисекунд — что раньше
const GSX_TEXT_MAX = 260;                   // сколько символов строки отдаём в выдачу
const gsxRuns = new Map();                  // runId → { cancel() }

ipcMain.handle('gsearch:cancel', (_e, { runId } = {}) => {
  const run = gsxRuns.get(String(runId));
  if (run) run.cancel();
  return { ok: true };
});
ipcMain.handle('gsearch:start', (e, { runId, query, opts, roots } = {}) => {
  const id = String(runId || '');
  if (!id || !query || !Array.isArray(roots) || !roots.length) return { ok: false, error: 'нет запроса или области поиска' };
  const started = Date.now();
  const ctrl = fastSearch.startGlobalSearch({
    roots,
    query: String(query),
    opts: opts || {},
    caps: {
      totalCap: GSX_TOTAL_CAP,
      perFileCap: GSX_PER_FILE_CAP,
      maxFileSize: GSX_FILE_MAX,
      flushHits: GSX_FLUSH_HITS,
      flushMs: GSX_FLUSH_MS,
      textMax: GSX_TEXT_MAX,
    },
    shouldStop: () => e.sender.isDestroyed(),
    onHits: (hits) => safeSend(e.sender, 'gsearch:hit', { runId: id, hits }),
    onProgress: (p) => safeSend(e.sender, 'gsearch:progress', Object.assign({ runId: id }, p)),
  });
  if (!ctrl.ok) return { ok: false, error: ctrl.error || 'некорректное регулярное выражение' };
  gsxRuns.set(id, ctrl);
  ctrl.promise.then((res) => {
    gsxRuns.delete(id);
    safeSend(e.sender, 'gsearch:done', {
      runId: id,
      total: res.total,
      files: res.files,
      scanned: res.scanned,
      capped: res.capped,
      error: res.error || '',
      cancelled: res.cancelled,
      ms: Date.now() - started,
    });
  });
  return { ok: true, runId: id };
});

// ---------------------------------------------------------------- локальная история файлов (PhpStorm Local History)
// Снапшоты текстовых файлов в ~/.LiteEditorAI/history/<sha1(absPath)>/<ts>-<tag>.snap — логика в
// lib/history.js. Точки съёма: fs:writeFile — состояние ДО записи (tag 'save'); вотчер проекта —
// состояние ПОСЛЕ внешнего изменения (tag 'ext'). Best-effort: ошибки истории работе не мешают.
const HIST_BATCH_CAP = 20;                      // пачка вотчера крупнее — массовая операция (checkout/npm), шум
const history = createHistory({ dir: path.join(storeDir, 'history'), maxBytes: MAX_VIEW_BYTES });
const histSnapshot = (absFile, content, tag, opts) => history.snapshot(absFile, content, tag, opts);
const histSnapshotFromDisk = (absFile, tag, opts) => history.snapshotFromDisk(absFile, tag, opts);
// Общий срок и объём истории: через минуту после старта (не мешать подъёму окон) и раз в сутки.
function historyPrune() {
  history.prune().then((r) => {
    if (r.removed) logger.log('info', 'history', `чистка: удалено каталогов ${r.removed} из ${r.dirs}, освобождено ${Math.round(r.freedBytes / 1048576)} МБ, осталось ${Math.round(r.keptBytes / 1048576)} МБ`);
  }, (e) => logger.log('info', 'history', 'чистка не удалась: ' + ((e && e.message) || e)));
}
{ const t1 = setTimeout(historyPrune, 60000); if (t1.unref) t1.unref(); }
{ const t2 = setInterval(historyPrune, 24 * 3600000); if (t2.unref) t2.unref(); }
ipcMain.handle('hist:list', async (_e, file) => {
  try { return { ok: true, items: await history.list(file) }; }
  catch (_) { return { ok: true, items: [] }; } // истории ещё нет — пустой список, не ошибка
});
ipcMain.handle('hist:read', async (_e, { file, name } = {}) => {
  try { return { ok: true, content: await history.read(file, name) }; }
  catch (err) { return { error: String(err.message || err) }; }
});
// Снимок текущего состояния МИМО троттла — вивер зовёт перед «Откатить к этой версии»: снимок
// из fs:writeFile троттлится (автосейв 10 с назад «закрывал» окно), и откат затирал текущую
// версию безвозвратно. content передан — снимаем его (несохранённые правки открытого файла),
// иначе — файл с диска. saved:false — снимать нечего (дедуп/нет файла/бинарь), это не ошибка.
ipcMain.handle('hist:snapshot', async (_e, { file, content } = {}) => {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { error: 'нет пути' };
  const saved = typeof content === 'string'
    ? await history.snapshot(file, content, 'save', { force: true })
    : await history.snapshotFromDisk(file, 'save', { force: true });
  return { ok: true, saved };
});

// ---------------------------------------------------------------- file watching
// Watch a project root and tell the renderer when files change on disk — so the
// tree and the open file refresh live while an agent edits things in the terminal.
const isIgnoredPath = (rel) => rel.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg));
// Сообщить окнам (редактор + вивер), что слежение за деревом отвалилось → ручной ⟳ (идея 11).
// Окно редактора fs:watchEnded не слушает (дерево и вивер живут в окне «Проект») — ему не шлём.
function notifyWatchEnded(root) {
  const fw = filesWindow(); if (fw) sendTo(fw, 'fs:watchEnded', { root });
  const df = liveFilesDockFrame(); if (df) sendToFrame(df, 'fs:watchEnded', { root });
  const dw = docWindow(); if (dw) sendTo(dw, 'fs:watchEnded', { root });
}
// Потолок каталогов под слежением за одним проектом (Linux: одно inotify-наблюдение на каталог).
// Лимит inotify общий на пользователя (часто 65 536): огромное дерево не должно отнимать его у других
// программ — выше потолка слежение заканчивается, в UI ручной ⟳.
const WATCH_MAX_DIRS = 10000;
// info, а не warn: warn попадает в реестр ошибок, а упёрся в лимит — это свойство проекта, не сбой.
const logWatchEnded = (root, err) => logger.log('info', 'watch', `слежение за ${root} остановлено: ${(err && err.message) || err}`);
// Корень, упёршийся в потолок (свой ELIMIT или ENOSPC ядра), помним WATCH_GIVEUP_MS: иначе каждое
// переключение на такой проект заново обходило 10 000 каталогов, ставило и снимало 10 000
// наблюдений (22.09.2026: 55 раз за день на kudatut-v2 — 15 тысяч временных каталогов Infection).
// Через срок пробуем снова: каталоги могли вычистить.
const WATCH_GIVEUP_MS = 10 * 60 * 1000;
const WATCH_SWITCH_DEBOUNCE_MS = 180;
const watchGaveUp = new Map(); // root -> момент отказа
const isLimitErr = (err) => !!err && (err.code === 'ELIMIT' || err.code === 'ENOSPC');
let syncWatchTimer = null;

// Полный обход подкаталогов дерева нужен только тогда, когда открыт потребитель дерева файлов:
// окно «Проект», видимый встроенный док «Проект» или окно «Обработка текста».
// В обычном режиме главного окна (терминал с агентами) работает только лёгкий watchGitLite (3–5 fd).
function needsFullTreeWatch() {
  return !!(filesWindow() || docWindow() || (filesDockVisible && liveFilesDockFrame()));
}
function stopGitWatcher(root) {
  const gw = gitWatchers.get(root);
  if (gw) { try { gw.close(); } catch (_) {} gitWatchers.delete(root); }
}
function stopTreeWatcher(root) {
  const rec = watchers.get(root);
  if (rec) { clearTimeout(rec.timer); try { rec.watcher.close(); } catch (_) {} watchers.delete(root); }
}
function startGitWatcher(root) {
  if (!root || gitWatchers.has(root) || !fs.existsSync(root)) return;
  try {
    const gw = watchGitLite(root, () => {
      sendTo(mainWindow, 'fs:changed', { root, files: [] });
      const fw = filesWindow(); if (fw) sendTo(fw, 'fs:changed', { root, files: [] });
      const df = liveFilesDockFrame(); if (df && filesDockVisible) sendToFrame(df, 'fs:changed', { root, files: [] });
    }, { writeTmpSuffix: WRITE_TMP_SUFFIX });
    gitWatchers.set(root, gw);
  } catch (_) {}
}
function startTreeWatcher(root) {
  if (!root || watchers.has(root) || !fs.existsSync(root)) return;
  const gaveUp = watchGaveUp.get(root);
  if (gaveUp && Date.now() - gaveUp < WATCH_GIVEUP_MS) { notifyWatchEnded(root); return; }
  watchGaveUp.delete(root);
  let watcher;
  try {
    watcher = watchTree(root, {
      ignore: IGNORE_DIRS,
      ignoreFilter: (rel, _name, isDir) => gitignore.forProject(root, IGNORE_DIRS).ignores(rel, isDir),
      maxDirs: WATCH_MAX_DIRS,
    });
  } catch (err) { // inotify limits / unsupported — degrade to manual refresh
    if (isLimitErr(err)) watchGaveUp.set(root, Date.now());
    logWatchEnded(root, err); notifyWatchEnded(root); return;
  }
  const rec = { watcher, timer: null, pending: new Set() };
  watcher.on('error', (err) => { // рантайм-ошибка или потолок каталогов (B7/идея 11)
    if (isLimitErr(err)) watchGaveUp.set(root, Date.now());
    logWatchEnded(root, err);
    try { watcher.close(); } catch (_) {}
    if (watchers.get(root) === rec) watchers.delete(root);
    notifyWatchEnded(root);
  });
  watcher.on('change', (_type, filename) => {
    const rel = filename == null ? '' : String(filename);
    if (rel && (isIgnoredPath(rel) || gitignore.forProject(root, IGNORE_DIRS).ignoresPath(rel))) return;
    if (rel.endsWith(WRITE_TMP_SUFFIX)) return;        // временный сосед атомарной записи — не наш файл
    if (rel) rec.pending.add(path.join(root, rel));
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      const files = [...rec.pending]; rec.pending.clear();
      const fw = filesWindow(); if (fw) sendTo(fw, 'fs:changed', { root, files }); // окно вивера обновляет дерево/файл
      const df = liveFilesDockFrame(); if (df && filesDockVisible) sendToFrame(df, 'fs:changed', { root, files }); // встроенный док «Проект»
      const dw = docWindow(); if (dw) sendTo(dw, 'fs:changed', { root, files }); // «Обработка текста»: сайдбар-дерево
      sendTo(mainWindow, 'fs:changed', { root, files }); // редактор: пересчитать чип git под терминалом
      // локальная история: внешняя правка (агент/git). Большая пачка = массовая операция — шум, пропускаем.
      if (files.length <= HIST_BATCH_CAP) for (const f of files) histSnapshotFromDisk(f, 'ext');
    }, 180);
  });
  watchers.set(root, rec);
}
function applyProjectWatchersNow() {
  const full = needsFullTreeWatch();
  for (const r of [...gitWatchers.keys()]) { if (!watchedRoots.has(r)) stopGitWatcher(r); }
  for (const r of [...watchers.keys()]) { if (!watchedRoots.has(r) || !full) stopTreeWatcher(r); }
  for (const r of watchedRoots) {
    startGitWatcher(r);
    if (full) startTreeWatcher(r);
  }
}
function scheduleSyncWatchers(delay = WATCH_SWITCH_DEBOUNCE_MS) {
  const full = needsFullTreeWatch();
  // Освобождаем ненужные наблюдения сразу, а постановку новых при быстром Ctrl+Tab коалесируем.
  for (const r of [...gitWatchers.keys()]) { if (!watchedRoots.has(r)) stopGitWatcher(r); }
  for (const r of [...watchers.keys()]) { if (!watchedRoots.has(r) || !full) stopTreeWatcher(r); }
  clearTimeout(syncWatchTimer);
  if (delay <= 0) {
    syncWatchTimer = null;
    applyProjectWatchersNow();
    return;
  }
  syncWatchTimer = setTimeout(() => {
    syncWatchTimer = null;
    applyProjectWatchersNow();
  }, delay);
}
ipcMain.on('fs:watch', (_e, root) => {
  if (!root) return;
  watchedRoots.add(root);
  scheduleSyncWatchers(WATCH_SWITCH_DEBOUNCE_MS);
});
ipcMain.on('fs:unwatch', (_e, root) => {
  if (!root) return;
  watchedRoots.delete(root);
  stopGitWatcher(root);
  stopTreeWatcher(root);
});

// ---------------------------------------------------------------- доменные IPC-модули (git, audit, iterflow, seo, containers)
registerGitIpc({
  ipcMain,
  maxViewBytes: MAX_VIEW_BYTES,
  histSnapshotFromDisk,
});

createLazyIpc(ipcMain, {
  handles: AUDIT_HANDLES,
  load: (ipc) => registerAuditIpc({
    ipcMain: ipc, dialog,
    ignoreDirs: IGNORE_DIRS,
    writeTmpSuffix: WRITE_TMP_SUFFIX,
    atomicWriteSync,
    senderWin: (e) => senderWin(e),
    getMainWindow: () => mainWindow,
  }),
});

createLazyIpc(ipcMain, {
  handles: ITERFLOW_HANDLES,
  load: (ipc) => registerIterflowIpc({ ipcMain: ipc, storeDir }),
});

createLazyIpc(ipcMain, {
  handles: SEO_HANDLES,
  load: (ipc) => registerSeoIpc({
    ipcMain: ipc, BrowserWindow, dialog, atomicWriteSync,
    senderWin: (e) => senderWin(e),
    getMainWindow: () => mainWindow,
  }),
});

const containersLazy = createLazyIpc(ipcMain, {
  handles: CONTAINERS_HANDLES,
  ons: CONTAINERS_ONS,
  load: (ipc) => registerContainersIpc({
    ipcMain: ipc, pty, rhApi, safeSend, userShellEnv,
    maxViewBytes: MAX_VIEW_BYTES,
    stageTextForViewer, routeOpenInViewer,
  }),
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
    // Только HTML (так канал и зовут: вивер/дерево — для .html/.htm): file:// к .exe/.bat/.desktop
    // shell.openExternal не «открывает в браузере», а запускает программой ОС.
    if (!/\.html?$/i.test(p)) return { error: 'в браузере открывается только HTML-файл' };
    if (!fs.existsSync(p)) return { error: 'файл не найден' };
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
    clipboard.writeText(p);
    return { ok: true, mode: 'path' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text == null ? '' : text)));
ipcMain.handle('clipboard:read', () => clipboard.readText());
// Картинка из буфера → PNG-файл, путь к которому вставляется в терминал (Ctrl+V скриншота агенту:
// Claude Code принимает изображения по пути). Кладём в <проект>/.lite/shots — рядом с проектом агенту
// не нужно разрешение на чтение чужого каталога; каталог сам себя исключает из git (.gitignore «*»).
// Без проекта (терминал «Система») или без прав на запись — в ~/.LiteEditorAI/shots. Старше 14 дней — удаляем.
const SHOTS_TTL_MS = 14 * 24 * 3600 * 1000;
function pruneShots(dir) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!/^shot-.*\.png$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > SHOTS_TTL_MS) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) {}
}
ipcMain.handle('clipboard:saveImage', (_e, { dir } = {}) => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return { empty: true };
  const png = img.toPNG();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `shot-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}.png`;
  const targets = [];
  const base = typeof dir === 'string' && path.isAbsolute(dir) ? dir : '';
  try { if (base && fs.statSync(base).isDirectory()) targets.push(path.join(base, '.lite', 'shots')); } catch (_) {}
  targets.push(path.join(storeDir, 'shots'));
  for (const t of targets) {
    try {
      fs.mkdirSync(t, { recursive: true });
      const gi = path.join(t, '.gitignore');
      if (t !== targets[targets.length - 1] && !fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
      const file = path.join(t, name);
      fs.writeFileSync(file, png);
      pruneShots(t);
      return { ok: true, path: file };
    } catch (_) { /* следующий вариант */ }
  }
  return { ok: false, error: 'Не удалось сохранить изображение из буфера' };
});

// ---------------------------------------------------------------- «Озвучка» (lib/ipc/voice.js, сайдкар TTS грузится лениво)
const voiceApi = registerVoiceIpc({
  ipcMain, dialog, clipboard, storeDir,
  readSettingsCached,
  log: (lvl, srcName, msg) => logger.log(lvl, srcName, msg),
  safeSend,
  senderWin: (e) => senderWin(e),
  getMainWindow: () => mainWindow,
  moduleRouter,
});
