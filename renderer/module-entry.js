// Module-window shell (v1.1+): hosts ONE module in its own BrowserWindow.
// The module id is the URL hash (set by main.js when opening the window). The same module
// code that ran in the right-slot runs here; we just feed it a "window-mode" host where the
// right-slot machinery (growBy / closeOtherPanels / refit / saveUiState) is neutralised and
// the pane fills the whole window. Editor-facing actions are forwarded to the main window.
import {
  el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt, hydrateIcons, setErrorSink, applyLayoutSwap,
} from './ui.js';
import '@xterm/xterm/css/xterm.css';
import 'highlight.js/styles/atom-one-dark.css';

import { initTools } from './modules/tools.js';
import { initIterflow } from './modules/iterflow.js';
import { initSeo } from './modules/seo.js';
import { initAudit } from './modules/audit.js';
import { initNotes } from './modules/notes.js';
import { initDb } from './modules/db.js';

const lite = window.lite;
const $ = (s) => document.querySelector(s);
const bind = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };

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
    STORE, persist, settings, saveSettings,
    layout: layoutProxy, GUTTER: 0,
    saveUiState: () => {}, refitActiveTerminal: () => {}, closeOtherPanels: () => {}, renderProjects: () => {},
    activeProject: () => activeProj,
    getActiveId: () => (activeProj && activeProj.id) || null,
    getProjects: () => (STORE.projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    openInViewer: (abs, line) => lite.editorBus.openInViewer(abs, line),
    sendToTerminal: (t) => lite.editorBus.sendToTerminal(t),
    sendNoteToTerminal: (p, t) => lite.editorBus.sendNoteToTerminal(p && p.id, t),
    refreshTree: () => lite.editorBus.refreshTree(),
    closeMenus: () => {},
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
  $('#mod-brand-title').textContent = def.title;
  document.title = 'LiteEditorAI — ' + def.title;
  $('#win-min').onclick = () => lite.win.minimize();
  $('#win-max').onclick = () => lite.win.maximizeToggle();
  $('#win-close').onclick = () => lite.win.close();
  // reflect maximize state on #mod-app (CSS .is-max tweaks the restore glyph)
  lite.win.onMaximizeChange((v) => $('#mod-app').classList.toggle('is-max', !!v));
  lite.win.isMaximized().then((v) => $('#mod-app').classList.toggle('is-max', !!v)).catch(() => {});
  hydrateIcons(document);

  // live settings/theme updates from the editor
  lite.app.onSettingsChanged((s) => { if (s) { settings = s; applyTheme(settings.theme); } });

  // init the module; the pane is always visible in a window (open with grow:false)
  mod = def.init(buildHost());
  mod.setOpen(true, { grow: false, allowEmpty: true });

  // the pane-head close button now closes the window; module's own buttons via wire()
  const closeBtn = $('#' + modId + '-close');
  if (closeBtn) closeBtn.onclick = () => lite.win.close();
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
