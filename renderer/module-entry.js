// Module-window shell (v1.1+): hosts ONE module in its own BrowserWindow.
// The module id is the URL hash (set by main.js when opening the window). The same module
// code that ran in the right-slot runs here; we just feed it a "window-mode" host where the
// right-slot machinery (growBy / closeOtherPanels / refit / saveUiState) is neutralised and
// the pane fills the whole window. Editor-facing actions are forwarded to the main window.
import {
  el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt, hydrateIcons, setErrorSink, applyLayoutSwap, ICONS,
} from './ui.js';
import { createCodeEditor, languageFor } from './codeedit.js';
import { THEMES, TERM_THEME, DEFAULT_THEME, termThemeFor } from './themes.js';
import { loadFastRenderer, applyUnicode11, copySelection } from './termutil.js';
import '@xterm/xterm/css/xterm.css';
import 'highlight.js/styles/atom-one-dark.css';

import { initTools } from './modules/tools.js';
import { initIterflow } from './modules/iterflow.js';
import { initSeo } from './modules/seo.js';
import { initAudit } from './modules/audit.js';
import { initNotes } from './modules/notes.js';
import { initDb } from './modules/db.js';
import { initGit } from './modules/git.js';
import { initOpenRouter } from './modules/openrouter.js';
import { initTextProc } from './modules/textproc.js';
import { initContainers } from './modules/containers.js';
import { initRh } from './modules/remotehost.js';
import { initCtx } from './modules/contextgraph.js';
import { initScratch } from './modules/scratch.js';
import { initFiles } from './modules/files.js';

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

// Registry of window-hosted modules. `project:true` → re-render on active-project change.
// `wire(mod)` binds the pane-head buttons (the #<id>-close button is wired generically).
const MODULES = {
  tools: { title: 'Инструменты', init: initTools, project: false },
  iterflow: {
    title: 'IterFlow', init: initIterflow, project: false,
    wire: (mod) => { bind('#iterflow-site', () => mod.openSite()); bind('#iterflow-refresh', () => mod.refresh()); bind('#iterflow-logout', () => mod.logout()); },
  },
  seo: {
    title: 'WEB/SEO аудит', init: initSeo, project: false,
    wire: (mod) => { bind('#seo-rescan', () => mod.rescan()); },
  },
  audit: {
    title: 'Аудит проекта', init: initAudit, project: true,
    wire: (mod) => { bind('#audit-rescan', () => mod.rescan()); },
  },
  notes: {
    title: 'Задачи', init: initNotes, project: true,
    wire: (mod) => {
      bind('#notes-export', () => mod.exportMenu());
      bind('#notes-import', () => mod.importNotes());
      // пульт изменил задачи → редактор ретранслировал app:notesChanged → перечитать, если открыт тот список
      lite.app.onNotesChanged((id) => { try { mod.onExternalChange(id); } catch (_) {} });
    },
  },
  db: {
    title: 'Базы данных', init: initDb, project: false,
    wire: (mod) => { bind('#db-refresh', () => mod.refresh()); },
  },
  git: {
    title: 'Git', init: initGit, project: true,
    wire: (mod) => { bind('#git-refresh', () => mod.renderPanel(activeProj)); },
  },
  chat: {
    title: 'OpenRouter', init: initOpenRouter, project: false,
    // чат сам вешает слушатели панели и стрима (bindControls биндит #chat-close/#chat-keys/модель/сессии).
    wire: (mod) => { try { mod.bindControls(); mod.bindStream(); } catch (_) {} },
  },
  doc: {
    title: 'Обработка текста', init: initTextProc, project: false,
    wire: (mod) => { bind('#doc-settings', () => mod.showSettings()); },
  },
  docker: {
    title: 'Контейнеры', init: initContainers, project: false,
    wire: (mod) => { bind('#docker-refresh', () => mod.refresh()); },
  },
  rh: {
    title: 'Удалённые хосты', init: initRh, project: false,
    wire: (mod) => {
      mod.bindEvents(); // поток данных/закрытие SSH-сессий → xterm-вкладки
      bind('#rh-refresh', () => mod.renderPanel());
      bind('#rh-back', () => mod.goList());
    },
  },
  // ctx сам биндит свои кнопки канвы (включая #ctx-close с dirty-guard) → selfClose:true:
  // module-entry НЕ переопределяет #ctx-close; закрытие окна идёт через host.closeWindow с подтверждением.
  ctx: { title: 'Контекст', init: initCtx, project: true, selfClose: true },
  scratch: {
    title: 'Система · ~', init: initScratch, project: false,
    wire: (mod) => { bind('#scratch-restart', () => mod.restart()); },
  },
  // Вивер кода + дерево файлов (проектозависимое окно: следует за активным проектом редактора).
  // Кнопки #viewer-*/#tree-* и контекст-меню дерева вешает сам модуль (Files.mount); тут — только
  // приём действий от других модулей-окон (открыть файл / обновить дерево) и сигнал готовности.
  files: {
    title: 'Файлы', init: initFiles, project: true, selfClose: true,
    wire: (mod) => {
      lite.editorBus.onOpenInViewer((abs, line) => { try { mod.openFile(abs, line); } catch (_) {} });
      lite.editorBus.onRefreshTree(() => { try { if (activeProj) mod.renderTree(activeProj); } catch (_) {} });
      // живые изменения на диске активного проекта (агент тронул файл) → обновить дерево/перечитать
      lite.fs.onChange(({ root, files }) => { try { if (activeProj && activeProj.path === root) mod.onFsChange(activeProj, files); } catch (_) {} });
      try { lite.editorBus.viewerReady(); } catch (_) {} // флаш отложенных openInViewer из main
    },
  },
};

const modId = (location.hash || '').replace(/^#/, '') || 'tools';
const def = MODULES[modId];

// Store snapshot + settings/theme (each window loads its own; writes go to the shared main store).
const STORE = lite.store.loadAll() || {};
let settings = STORE.settings || {};
function applyTheme(name) { document.body.dataset.theme = name || 'neumorphism'; }
applyTheme(settings.theme);

function persist(key, value) { STORE[key] = value; lite.store.set(key, value); }
function saveSettings() { lite.store.set('settings', settings); lite.app.settingsChanged(settings); }

// Surface module errors to the main-process log (mirrors the editor's error sink).
setErrorSink((msg) => { try { lite.log('error', '[module:' + modId + ']', msg); } catch (_) {} });

let activeProj = null;   // cached active project of the editor (for project-dependent modules)
let mod = null;          // the initialised module instance

// Window-mode host: right-slot callbacks become no-ops; editor actions are forwarded.
const layoutProxy = new Proxy({}, { get: () => 480 });
function buildHost() {
  return {
    el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast, applyLayoutSwap,
    createCodeEditor, languageFor,
    termTheme: () => termThemeFor(settings.theme), applyUnicode11, loadFastRenderer, copySelection,
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

function boot() {
  if (!def) {
    const box = el('div', 'mod-unknown');
    box.style.padding = '24px';
    box.style.color = '#bbb';
    box.textContent = 'Неизвестный модуль: ' + modId;
    document.body.replaceChildren(box);
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
    applyTheme(settings.theme);
    try { mod && mod.applyTermTheme && mod.applyTermTheme(); } catch (_) {}
    try { mod && mod.applyFontSize && mod.applyFontSize(); } catch (_) {}
  });

  // init the module; the pane is always visible in a window (open with grow:false)
  mod = def.init(buildHost());
  mod.setOpen(true, { grow: false, allowEmpty: true });

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

  // the pane-head close button now closes the window; module's own buttons via wire().
  // selfClose:true → модуль сам биндит #<id>-close (с своим подтверждением) и зовёт host.closeWindow.
  if (!def.selfClose) {
    const closeBtn = $('#' + modId + '-close');
    if (closeBtn) closeBtn.onclick = () => lite.win.close();
  }
  if (def.wire) { try { def.wire(mod); } catch (e) { try { lite.log('error', '[module:' + modId + '] wire', String(e)); } catch (_) {} } }

  // project-dependent modules re-render when the editor switches projects
  if (def.project) {
    lite.app.onActiveProject((p) => {
      activeProj = p || null;
      try { mod.setOpen(true, { grow: false, allowEmpty: true }); } catch (_) {}
    });
  }
}

// fetch the editor's current project first, then boot
lite.app.getActiveProject().then((p) => { activeProj = p || null; boot(); }).catch(() => boot());
