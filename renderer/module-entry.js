// Module-window shell (v1.1+): hosts ONE module in its own BrowserWindow.
// The module id is the URL hash (set by main.js when opening the window). The same module
// code that ran in the right-slot runs here; we just feed it a "window-mode" host where the
// right-slot machinery (growBy / closeOtherPanels / refit / saveUiState) is neutralised and
// the pane fills the whole window. Editor-facing actions are forwarded to the main window.
import {
  el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt, hydrateIcons, setErrorSink, applyLayoutSwap, ICONS, preloadHighlighter,
} from './ui.js';
import { initI18n } from './i18n.js';
import { syncSettings } from './settings-sync.js';
import { createCodeEditor } from './codeedit.js';
import { termThemeFor, applyLook } from './themes.js';
import { applyFrame } from './frame.js';
import { loadFastRenderer, applyUnicode11, copySelection } from './termutil.js';
import '@xterm/xterm/css/xterm.css';
import 'highlight.js/styles/atom-one-dark.css';

// CSS модулей подключаем здесь, в оболочке: при разбиении на чанки стили лениво загруженного модуля
// попали бы в отдельный CSS-файл, который никто не подключит. katex — стили формул «Обработки текста».
import 'katex/dist/katex.min.css';

// Модули грузятся лениво: окно берёт только СВОЙ модуль (id — из #hash), а не все 22 сразу
// (build.js: ESM + splitting). Загрузчик отдаёт init-функцию модуля.
const initTools = () => import('./modules/tools.js').then((m) => m.initTools);
const initIterflow = () => import('./modules/iterflow.js').then((m) => m.initIterflow);
const initSeo = () => import('./modules/seo.js').then((m) => m.initSeo);
const initAudit = () => import('./modules/audit.js').then((m) => m.initAudit);
const initMonitor = () => import('./modules/monitor.js').then((m) => m.initMonitor);
const initKeepass = () => import('./modules/keepass.js').then((m) => m.initKeepass);
const initSitemon = () => import('./modules/sitemon.js').then((m) => m.initSitemon);
const initPomodoro = () => import('./modules/pomodoro.js').then((m) => m.initPomodoro);
const initVoice = () => import('./modules/voice.js').then((m) => m.initVoice);
const initCompany = () => import('./modules/company.js').then((m) => m.initCompany);
const initNotes = () => import('./modules/notes.js').then((m) => m.initNotes);
const initDb = () => import('./modules/db.js').then((m) => m.initDb);
const initRmq = () => import('./modules/rmq.js').then((m) => m.initRmq);
const initStorage = () => import('./modules/storage.js').then((m) => m.initStorage);
const initKafka = () => import('./modules/kafka.js').then((m) => m.initKafka);
const initJira = () => import('./modules/jira.js').then((m) => m.initJira);
const initOpenRouter = () => import('./modules/openrouter.js').then((m) => m.initOpenRouter);
const initTextProc = () => import('./modules/textproc.js').then((m) => m.initTextProc);
const initContainers = () => import('./modules/containers.js').then((m) => m.initContainers);
const initRh = () => import('./modules/remotehost.js').then((m) => m.initRh);
const initCtx = () => import('./modules/contextgraph.js').then((m) => m.initCtx);
const initScratch = () => import('./modules/scratch.js').then((m) => m.initScratch);
const initFiles = () => import('./modules/files.js').then((m) => m.initFiles);

const lite = window.lite;
const $ = (s) => document.querySelector(s);
const bind = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };

// Лёгкая меню-машинерия для окна модуля (контекст-меню дерева вивера): работает на #menu-layer.
// В ядре редактора эти примитивы свои (с состоянием верхнего меню); тут — автономная копия.
function closeMenus() { const ml = $('#menu-layer'); if (ml) ml.innerHTML = ''; }
function placeMenu(dd, x, y) {
  $('#menu-layer').appendChild(dd);
  dd.style.left = x + 'px'; dd.style.top = y + 'px';
  const r = dd.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) dd.style.left = (window.innerWidth - 8 - r.width) + 'px';
  if (r.bottom > window.innerHeight - 8) dd.style.top = (window.innerHeight - 8 - r.height) + 'px';
}
function menuRow(glyph, text, onClick, cls) {
  const row = el('div', 'menu-row' + (cls ? ' ' + cls : ''));
  const ic = el('span', 'menu-ic');
  if (glyph && ICONS[glyph]) ic.appendChild(icon(glyph, 16));
  else if (glyph) ic.textContent = glyph;
  row.appendChild(ic); row.appendChild(el('span', null, text));
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
// Глобальный гард drag&drop (как в главном окне): без него сброс файла мимо целевой зоны
// навигирует окно модуля на file:// и уничтожает UI. Целевые зоны сами зовут preventDefault раньше.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Активность в окне модуля сбрасывает кросс-оконный таймер заставки «матрица» (троттл).
let __ssAct = 0;
function reportActivity() { const now = Date.now(); if (now - __ssAct > 1500) { __ssAct = now; try { lite.screensaver.activity(); } catch (_) {} } }
for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, reportActivity, { passive: true });

// Registry of window-hosted modules. `project:true` → re-render on active-project change.
// `wire(mod)` binds the pane-head buttons (the #<id>-close button is wired generically).
const MODULES = {
  tools: { title: 'Инструменты', load: initTools, project: false, highlight: true }, // highlight — диффы с подсветкой (renderDiffInto)
  iterflow: {
    title: 'IterFlow', load: initIterflow, project: false,
    wire: (mod) => { bind('#iterflow-site', () => mod.openSite()); bind('#iterflow-refresh', () => mod.refresh()); bind('#iterflow-logout', () => mod.logout()); },
  },
  seo: {
    title: 'WEB/SEO аудит', load: initSeo, project: false,
    wire: (mod) => { bind('#seo-rescan', () => mod.rescan()); },
  },
  audit: {
    title: 'Аудит проекта', load: initAudit, project: true,
    wire: (mod) => { bind('#audit-rescan', () => mod.rescan()); },
  },
  monitor: {
    title: 'Монитор ресурсов', load: initMonitor, project: false,
    wire: (mod) => { bind('#monitor-copy', () => mod.copySnapshot()); },
  },
  keepass: {
    title: 'Сейф паролей', load: initKeepass, project: false,
    wire: (mod) => { bind('#keepass-open', () => mod.openFile()); bind('#keepass-lock', () => mod.lock()); },
  },
  sitemon: {
    title: 'Мониторинг сайтов', load: initSitemon, project: false,
    wire: (mod) => { bind('#sitemon-add', () => mod.addSite()); bind('#sitemon-check', () => mod.checkAll()); },
  },
  pomodoro: {
    title: 'Помодоро', load: initPomodoro, project: false,
    wire: (mod) => { bind('#pomodoro-min', () => mod.toggleCompact()); },
  },
  // «Озвучка»: текст из буфера обмена читается голосом. Окно самостоятельное (озвучивают что
  // угодно, не только активный проект); wire принимает текст из контекстного меню терминала.
  voice: {
    title: 'Озвучка', load: initVoice, project: false,
    wire: (mod) => {
      bind('#voice-engine-btn', () => mod.openSettings());
      bind('#voice-clear', () => mod.clearHistory());
    },
  },
  company: {
    title: 'ИИ компания', load: initCompany, project: true,
    wire: (mod) => { bind('#company-settings', () => mod.openSettings()); },
  },
  notes: {
    title: 'Задачи', load: initNotes, project: true,
    wire: (mod) => {
      bind('#notes-export', () => mod.exportMenu());
      bind('#notes-import', () => mod.importNotes());
      // задачи изменены извне → редактор ретранслировал app:notesChanged → перечитать, если открыт тот список
      lite.app.onNotesChanged((id) => { try { mod.onExternalChange(id); } catch (_) {} });
      // напоминания изменены извне (MCP-сервер) → перечитать вкладку «Календарь», если она открыта
      lite.app.onAgendaChanged((id) => { try { mod.onAgendaExternalChange(id); } catch (_) {} });
      // клик по уведомлению напоминания → переключить окно на вкладку «Календарь»
      if (lite.app.onAgendaFocus) lite.app.onAgendaFocus(() => { try { mod.focusCalendar(); } catch (_) {} });
    },
  },
  db: {
    title: 'Базы данных', load: initDb, project: false,
    wire: (mod) => {
      bind('#db-refresh', () => mod.refresh());
      // «Контейнеры» → БД: заготовка подключения из контейнера (маршрут через main, очередь до готовности)
      lite.db.onOpenFromContainer((p) => { try { mod.openFromContainer(p); } catch (_) {} });
      // Вивер → БД: открыть SQL-консоль подключения с текстом .sql-файла
      lite.db.onOpenSql((p) => { try { mod.openSqlFromViewer(p); } catch (_) {} });
      try { lite.db.panelReady(); } catch (_) {} // флаш отложенных openFromContainer/openSql из main
    },
  },
  // «Внешние хранилища» (S3): главные вкладки «Проект/Общие» → project:true (перечитка при
  // смене активного проекта редактора); без проекта живёт вкладка «Общие» (allowEmpty).
  storage: {
    title: 'Внешние хранилища', load: initStorage, project: true,
    wire: (mod) => {
      bind('#storage-add', () => mod.addConnection());
      bind('#storage-refresh', () => mod.refresh());
      // «Контейнеры» → MinIO: заготовка подключения из контейнера (маршрут через main, очередь до готовности)
      lite.storage.onOpenFromContainer((p) => { try { mod.openFromContainer(p); } catch (_) {} });
      try { lite.storage.panelReady(); } catch (_) {} // флаш отложенных openFromContainer из main
    },
  },
  rmq: {
    title: 'RabbitMQ', load: initRmq, project: false,
    wire: (mod) => {
      bind('#rmq-refresh', () => mod.refresh());
      // «Контейнеры» → RabbitMQ: заготовка профиля из контейнера (маршрут через main, очередь до готовности)
      lite.rmq.onOpenFromContainer((p) => { try { mod.openFromContainer(p); } catch (_) {} });
      try { lite.rmq.panelReady(); } catch (_) {} // флаш отложенных openFromContainer из main
    },
  },
  kafka: {
    title: 'Kafka', load: initKafka, project: false,
    wire: (mod) => {
      bind('#kafka-refresh', () => mod.refresh());
      // «Контейнеры» → Kafka: заготовка профиля из контейнера (маршрут через main, очередь до готовности)
      lite.kafka.onOpenFromContainer((p) => { try { mod.openFromContainer(p); } catch (_) {} });
      try { lite.kafka.panelReady(); } catch (_) {} // флаш отложенных openFromContainer из main
    },
  },
  // «Jira» — трекер чужих задач: аккаунтов может быть несколько (работа/личный/клиентский),
  // поэтому окно самостоятельное и от активного проекта редактора не зависит.
  jira: {
    title: 'Jira', load: initJira, project: false,
    wire: (mod) => { bind('#jira-refresh', () => mod.refresh()); },
  },
  chat: {
    title: 'OpenRouter', load: initOpenRouter, project: false,
    // чат сам вешает слушатели панели и стрима (bindControls биндит #chat-keys/модель/сессии).
    wire: (mod) => { try { mod.bindControls(); mod.bindStream(); } catch (_) {} },
  },
  // «Обработка текста» (Obsidian-редизайн, PR #6): сайдбар — дерево документов АКТИВНОГО проекта
  // редактора, поэтому project:true; дерево рендерится при старте, смене проекта и правках на диске.
  doc: {
    title: 'Обработка текста', load: initTextProc, project: true,
    wire: (mod) => {
      if (activeProj) { try { mod.renderTree(activeProj); } catch (_) {} }
      lite.app.onActiveProject((p) => { try { if (p) mod.renderTree(p); } catch (_) {} });
      lite.fs.onChange(({ root, files }) => { try { if (activeProj && activeProj.path === root) mod.onFsChange(activeProj, files); } catch (_) {} });
    },
  },
  docker: {
    title: 'Контейнеры', load: initContainers, project: false,
    wire: (mod) => { bind('#docker-refresh', () => mod.refresh()); },
  },
  rh: {
    title: 'Удалённые хосты', load: initRh, project: false,
    wire: (mod) => {
      mod.bindEvents(); // поток данных/закрытие SSH-сессий → xterm-вкладки
      bind('#rh-refresh', () => mod.renderPanel());
      bind('#rh-back', () => mod.goList());
    },
  },
  // ctx даёт confirmClose() (заглушка: канва пишет файл сразу) — закрытие окна
  // спрашивает его перед закрытием; свои кнопки канвы биндит сам в initCtx.
  ctx: { title: 'Контекст', load: initCtx, project: true },
  scratch: {
    title: 'Система · ~', load: initScratch, project: false,
    wire: (mod) => { bind('#scratch-restart', () => mod.restart()); },
  },
  // Вивер кода + дерево файлов (проектозависимое окно: следует за активным проектом редактора).
  // Кнопки #viewer-*/#tree-* и контекст-меню дерева вешает сам модуль (Files.mount); тут — только
  // приём действий от других модулей-окон (открыть файл / обновить дерево) и сигнал готовности.
  files: {
    title: 'Проект', load: initFiles, project: true,
    wire: (mod) => {
      lite.editorBus.onOpenInViewer((abs, line) => { try { mod.openFile(abs, line); } catch (_) {} });
      lite.editorBus.onFocusGit(() => { try { mod.focusGit(); } catch (_) {} }); // «Git» из редактора → секция «Коммит»
      lite.editorBus.onRefreshTree(() => { try { if (activeProj) mod.renderTree(activeProj); } catch (_) {} });
      // живые изменения на диске активного проекта (агент тронул файл) → обновить дерево/перечитать
      lite.fs.onChange(({ root, files }) => { try { if (activeProj && activeProj.path === root) mod.onFsChange(activeProj, files); } catch (_) {} });
      // слежение отвалилось (лимит inotify / ошибка вотчера) → подсказать ручное обновление дерева (идея 11)
      if (lite.fs.onWatchEnded) lite.fs.onWatchEnded(({ root }) => { try { if (activeProj && activeProj.path === root) toast('Авто-слежение за деревом недоступно — обновляйте вручную (⟳)', { kind: 'warn', ttl: 6000 }); } catch (_) {} });
      try { lite.editorBus.viewerReady(); } catch (_) {} // флаш отложенных openInViewer из main
    },
  },
};

const modId = (location.hash || '').replace(/^#/, '') || 'tools';
const def = MODULES[modId];

// Store snapshot + settings/theme (each window loads its own; writes go to the shared main store).
const STORE = lite.store.loadAll() || {};
let settings = STORE.settings || {};
// Тема одна («Графит»), палитра — из settings.look (общая с редактором, приходит живьём через settings-sync).
function applyTheme() { applyLook(settings); }
applyTheme();
applyFrame(settings); // рамка окна — та же, что у редактора (настройки → «Рамка окна»)

function persist(key, value) { STORE[key] = value; lite.store.set(key, value); }
// settings — только изменённые поля; чужие изменения (другие окна, смена языка) вливаются в этот же
// объект и применяются живьём (renderer/settings-sync.js). Раньше окно писало свою копию целиком и
// рассылало её остальным — устаревшие поля затирали чужие правки.
const settingsSync = syncSettings(lite, settings, { base: STORE.settings, onRemote: () => applyLiveSettings() });
function saveSettings() { settingsSync.save(); }

// Surface module errors to the main-process log (mirrors the editor's error sink).
setErrorSink((msg) => { try { lite.log('error', '[module:' + modId + ']', msg); } catch (_) {} });
// Необработанное исключение/промис В ОКНЕ МОДУЛЯ раньше не доходило никуда: sink ловит только
// error-тосты, которые модуль позвал сам. В окне редактора эти два слушателя есть — здесь их
// не было, и падение внутри любого из модулей-окон пропадало молча (в реестре ошибок пусто,
// человек видит «просто не работает»). Тост — чтобы это было видно и без F12.
const modLogErr = (...a) => { try { lite.log('error', '[module:' + modId + ']', ...a); } catch (_) {} };
window.addEventListener('error', (e) => {
  modLogErr('window.error', (e.error && e.error.stack) || e.message || '', e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '');
  try { toast('Ошибка: ' + (e.message || (e.error && e.error.message) || 'см. F12'), { kind: 'err', ttl: 8000 }); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  modLogErr('unhandledrejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
  try { toast('Ошибка: ' + ((e.reason && e.reason.message) || e.reason || 'промис'), { kind: 'err', ttl: 8000 }); } catch (_) {}
});

let activeProj = null;   // cached active project of the editor (for project-dependent modules)
let mod = null;          // the initialised module instance

// Применить настройки живьём: тема окна, рамка, xterm-терминалы модуля (если он их рисует).
function applyLiveSettings() {
  applyTheme();
  applyFrame(settings);
  try { mod && mod.applyTermTheme && mod.applyTermTheme(); } catch (_) {}
  try { mod && mod.applyFontSize && mod.applyFontSize(); } catch (_) {}
}

// Window-mode host: right-slot callbacks become no-ops; editor actions are forwarded.
const layoutProxy = new Proxy({}, { get: () => 480 });
function buildHost() {
  return {
    el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast, applyLayoutSwap,
    createCodeEditor, // языковая поддержка — модули импортируют languageFor/ensureLanguage из codeedit.js напрямую
    termTheme: () => termThemeFor(settings), applyUnicode11, loadFastRenderer, copySelection,
    STORE, persist, settings, saveSettings,
    layout: layoutProxy, GUTTER: 0,
    saveUiState: () => {}, refitActiveTerminal: () => {}, closeOtherPanels: () => {}, renderProjects: () => {},
    growBy: () => {}, // окно не двигаем (right-slot growBy → no-op)
    menuRow, placeMenu, closeMenus, // контекст-меню дерева вивера
    activeProject: () => activeProj,
    getActiveId: () => (activeProj && activeProj.id) || null,
    getProjects: () => (STORE.projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    openInViewer: (abs, line) => lite.editorBus.openInViewer(abs, line),
    sendToTerminal: (t) => lite.editorBus.sendToTerminal(t),
    sendNoteToTerminal: (p, t) => lite.editorBus.sendNoteToTerminal(p && p.id, t),
    refreshTree: () => lite.editorBus.refreshTree(),
    closeWindow: () => lite.win.close(), // для модулей со своим dirty-guard на закрытии (ctx)
  };
}

async function boot() {
  if (!def) {
    // Удалённый/устаревший модуль (например, старое окно 'git' из персиста __open после слияния с вивером)
    // — не показываем стрелую заглушку, а тихо закрываем окно; набор открытых окон self-heal'ится.
    try { lite.log('warn', '[module-entry]', 'unknown module → closing window: ' + modId); } catch (_) {}
    try { lite.win.close(); } catch (_) {}
    return;
  }
  document.body.classList.add('mw-' + modId); // per-module хук для CSS (раскладка окна вивера и пр.)
  $('#mod-brand-title').textContent = def.title;
  document.title = 'LiteEditorAI — ' + def.title;
  $('#win-min').onclick = () => lite.win.minimize();
  $('#win-max').onclick = () => lite.win.maximizeToggle();
  $('#win-close').onclick = () => lite.win.close();
  // reflect maximize state on #mod-app (CSS .is-max tweaks the restore glyph)
  lite.win.onMaximizeChange((v) => $('#mod-app').classList.toggle('is-max', !!v));
  lite.win.isMaximized().then((v) => $('#mod-app').classList.toggle('is-max', !!v)).catch(() => {});
  hydrateIcons(document);

  // live settings/theme updates from the editor — МУТИРУЕМ settings (модуль держит ссылку на него),
  // перекрашиваем тему окна и xterm-терминалы модуля (если он их рисует).
  lite.app.onSettingsChanged((s) => {
    if (!s) return;
    Object.assign(settings, s);
    applyLiveSettings();
  });

  // Закрытие окна (единственная ✕ в шапке окна / Alt+F4 / ОС) идёт через dirty-guard модуля:
  // main гасит первое закрытие и шлёт win:closeRequest; модуль с несохранёнными данными
  // (ctx/files) спрашивает подтверждение, остальные закрываются сразу. proceed() = «закрывай».
  // Вешаем до загрузки модуля: закрытие, пока модуль грузится, просто закрывает окно.
  lite.win.onCloseRequest(() => {
    const proceed = () => lite.win.confirmClose();
    try {
      if (mod && typeof mod.confirmClose === 'function') mod.confirmClose(proceed);
      else proceed();
    } catch (_) { proceed(); }
  });
  // project-dependent modules re-render when the editor switches projects (подписка — тоже до
  // загрузки, чтобы смена проекта во время загрузки не потерялась)
  if (def.project) {
    lite.app.onActiveProject((p) => {
      activeProj = p || null;
      if (mod) { try { mod.setOpen(true, { grow: false, allowEmpty: true }); } catch (_) {} }
    });
  }

  // init the module; the pane is always visible in a window (open with grow:false)
  let init;
  try { init = await moduleLoading; }
  catch (e) {
    try { lite.log('error', '[module:' + modId + '] load', String((e && e.stack) || e)); } catch (_) {}
    toast('Не удалось загрузить модуль: ' + ((e && e.message) || e), { kind: 'err', ttl: 8000 });
    return;
  }
  mod = init(buildHost());
  mod.setOpen(true, { grow: false, allowEmpty: true });
  if (def.highlight) preloadHighlighter();   // подсветка кода грузится лениво — прогреть в простое

  // окно изменило размер → подогнать встроенные терминалы модуля (контейнеры exec / SSH-сессии)
  let rezT;
  window.addEventListener('resize', () => {
    clearTimeout(rezT);
    rezT = setTimeout(() => {
      try { mod && mod.refitExec && mod.refitExec(); } catch (_) {}
      try { mod && mod.refitSession && mod.refitSession(); } catch (_) {}
      try { mod && mod.refit && mod.refit(); } catch (_) {}
    }, 80);
  });

  if (def.wire) { try { def.wire(mod); } catch (e) { try { lite.log('error', '[module:' + modId + '] wire', String(e)); } catch (_) {} } }
}

// fetch the editor's current project first, then boot
initI18n();   // язык окна модуля — тот же, что у редактора (словарь синхронно из main)
// Код модуля начинает грузиться сразу, параллельно с запросом активного проекта.
const moduleLoading = def ? def.load() : Promise.resolve(null);
moduleLoading.catch(() => {});   // ошибку разберёт boot; здесь — только чтобы не было unhandledrejection
lite.app.getActiveProject().then((p) => { activeProj = p || null; boot(); }).catch(() => boot());
