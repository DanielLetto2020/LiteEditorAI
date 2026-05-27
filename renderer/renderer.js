// LiteEditor renderer — projects, per-project terminal, viewer, file tree,
// custom titlebar, menu, modals. Talks to the backend only via window.lite.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';

import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';

const APP_VERSION = 'alpha v1.0.27';
const GUTTER = 5;

const lite = window.lite;
const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svgEl(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
// basename that survives both POSIX and Windows separators (for the Windows build).
function baseName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p); }

// ---------------------------------------------------------------- global store (~/.LiteEditor)
// Synchronous snapshot loaded once; reads are in-memory, writes go through to disk.
const STORE = lite.store.loadAll();
function persist(key, value) { STORE[key] = value; lite.store.set(key, value); }
// One-time import from the old localStorage layout (builds before ~/.LiteEditor).
(function migrateLocalStorage() {
  if (STORE.projects !== undefined) return;
  let did = false;
  for (const k of ['projects', 'layout', 'recents', 'projFiles', 'settings']) {
    try { const raw = localStorage.getItem('lite.' + k); if (raw != null) { persist(k, JSON.parse(raw)); did = true; } } catch (_) {}
  }
  const lp = localStorage.getItem('lite.lastParent'); if (lp) persist('lastParent', lp);
  if (did) console.log('[LiteEditor] state migrated from localStorage → ~/.LiteEditor');
})();
// Stable id derived from the path, so categories/notes/favorites survive a rescan.
function projId(p) { let h = 5381; for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0; return 'p' + h.toString(36); }

// ---------------------------------------------------------------- settings (tiny on purpose)
const DEFAULT_SETTINGS = { notifications: true, sound: false, idleMs: 1200, fontSize: 13, workingDir: '', scanDirs: [], theme: 'emerald', onboarded: false };
function loadSettings() { return { ...DEFAULT_SETTINGS, ...(STORE.settings || {}) }; }
let settings = loadSettings();
function saveSettings() { persist('settings', settings); }

// ---------------------------------------------------------------- state
let projects = [];
let activeId = null;
const terms = new Map();
const projState = new Map(); // id -> 'quiet' | 'busy' | 'waiting'
const missing = new Set();   // ids of projects whose folder no longer exists on disk
const projFiles = loadProjFiles(); // id -> last file opened in the viewer
const expandedDirs = new Set(); // tree dir paths currently expanded (survives live refresh)
let gitFiles = {};           // active project: abs path -> git short status code
let noteCounts = STORE.noteCounts || {}; // project id -> number of notes (card badge)
let viewerOpen = false;
let currentFile = null;
let dirty = false;
let diffMode = false;        // viewer showing a git diff instead of the file
let previewMode = false;     // viewer showing a rendered preview (md/image/html) instead of source
let editor = null;
let loadingDoc = false;
const langComp = new Compartment();

const DEFAULT_LAYOUT = { sidebar: 240, viewer: 520, tree: 240 };
let layout = loadLayout();
let lastParent = STORE.lastParent || '';

const TERM_THEME = {
  background: '#0a120d', foreground: '#cfe6d9', cursor: '#3ddc84',
  selectionBackground: '#1f4a36',
  black: '#0a120d', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
};
// ---------------------------------------------------------------- themes (a curated few)
const THEMES = {
  emerald: { label: 'Изумруд', cursor: '#3ddc84', selectionBackground: '#1f4a36' },
  ocean: { label: 'Океан', cursor: '#46cfe6', selectionBackground: '#1d4a55' },
  violet: { label: 'Аметист', cursor: '#a98cf0', selectionBackground: '#3a2f5a' },
};
function termTheme() {
  const t = THEMES[settings.theme] || THEMES.emerald;
  return { ...TERM_THEME, cursor: t.cursor, selectionBackground: t.selectionBackground };
}
function applyTheme() {
  const name = THEMES[settings.theme] ? settings.theme : 'emerald';
  if (name === 'emerald') document.body.removeAttribute('data-theme');
  else document.body.dataset.theme = name;
  for (const rec of terms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
}

const activeProject = () => projects.find((p) => p.id === activeId);

// ---------------------------------------------------------------- persistence
function saveProjects() { persist('projects', projects); }
function loadProjectsFromDisk() { return Array.isArray(STORE.projects) ? STORE.projects : []; }
function loadLayout() { return { ...DEFAULT_LAYOUT, ...(STORE.layout || {}) }; }
function saveLayout() { persist('layout', layout); }
function applyLayout() {
  $('#sidebar').style.flexBasis = layout.sidebar + 'px';
  $('#viewer-pane').style.flexBasis = layout.viewer + 'px';
  $('#tree-pane').style.flexBasis = layout.tree + 'px';
}
function loadRecents() { return Array.isArray(STORE.recents) ? STORE.recents : []; }
function pushRecent(p) {
  const r = loadRecents().filter((x) => x.path !== p.path);
  r.unshift({ path: p.path, name: p.name });
  persist('recents', r.slice(0, 30));
}
function loadProjFiles() {
  try { return new Map(Object.entries(STORE.projFiles || {})); } catch { return new Map(); }
}
function saveProjFiles() { persist('projFiles', Object.fromEntries(projFiles)); }

// ---------------------------------------------------------------- projects column
const UNCATEGORIZED = 'Все';
const FAV_KEY = '__fav';
function loadCategories() { return Array.isArray(STORE.categories) ? STORE.categories : []; }
function saveCategories(c) { persist('categories', c); }
function isCollapsed(key) { return !!(STORE.accordions || {})[key]; }
function setCollapsed(key, v) { persist('accordions', { ...(STORE.accordions || {}), [key]: v }); }
function loadSectionOrder() { return Array.isArray(STORE.sectionOrder) ? STORE.sectionOrder.slice() : null; }
function saveSectionOrder(o) { persist('sectionOrder', o); }

// Section display order. Default = "избранное / <категории> / все"; persisted once
// reordered. effectiveOrder() reconciles the stored order with the keys that exist
// now: drops gone categories, and slots new ones in just before «Все».
function effectiveOrder() {
  const keys = [FAV_KEY, ...loadCategories(), UNCATEGORIZED];
  const stored = loadSectionOrder();
  if (!stored) return keys;
  const order = stored.filter((k) => keys.includes(k));
  for (const k of keys) {
    if (order.includes(k)) continue;
    if (k === UNCATEGORIZED) { order.push(k); continue; }
    const at = order.indexOf(UNCATEGORIZED);
    if (at >= 0) order.splice(at, 0, k); else order.push(k);
  }
  return order;
}
// Sections that actually render now, in display order (★ Избранное only when non-empty).
function buildSections() {
  const cats = loadCategories();
  const favs = projects.filter((p) => p.favorite);
  return effectiveOrder().map((key) => {
    if (key === FAV_KEY) return favs.length ? { key, label: '★ Избранное', list: favs, pinned: true } : null;
    if (key === UNCATEGORIZED) return { key, label: UNCATEGORIZED, pinned: false, list: projects.filter((p) => !p.favorite && !cats.includes(p.category)) };
    return { key, label: key, pinned: false, list: projects.filter((p) => !p.favorite && p.category === key) };
  }).filter(Boolean);
}
function moveSection(key, dir) {
  const visible = buildSections().map((s) => s.key);
  const target = visible[visible.indexOf(key) + dir];
  if (target === undefined) return;
  const order = effectiveOrder();
  const a = order.indexOf(key), b = order.indexOf(target);
  [order[a], order[b]] = [order[b], order[a]];
  saveSectionOrder(order); renderProjects();
}

function renderProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  const sections = buildSections();
  sections.forEach((s, i) => box.appendChild(renderSection(s, i, sections.length)));
  renderMiniRail();
}
function renderSection(s, index, total) {
  const { label, key, list, pinned } = s;
  const sec = el('div', 'pgroup' + (pinned ? ' pinned' : ''));
  const collapsed = isCollapsed(key);
  const head = el('div', 'pgroup-head');
  const chev = el('span', 'pgroup-chev', collapsed ? '▸' : '▾');
  head.appendChild(chev);
  head.appendChild(el('span', 'pgroup-name', label));
  head.appendChild(el('span', 'pgroup-count', String(list.length)));
  const tools = el('div', 'pgroup-tools');
  const up = el('button', 'pgroup-arrow', '▲'); up.title = 'Выше'; up.disabled = index === 0;
  const down = el('button', 'pgroup-arrow', '▼'); down.title = 'Ниже'; down.disabled = index === total - 1;
  up.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, -1); });
  down.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, +1); });
  tools.appendChild(up); tools.appendChild(down);
  head.appendChild(tools);
  const body = el('div', 'pgroup-body');
  if (collapsed) body.style.display = 'none';
  head.addEventListener('click', () => {
    const now = !isCollapsed(key); setCollapsed(key, now);
    body.style.display = now ? 'none' : 'block'; chev.textContent = now ? '▸' : '▾';
  });
  if (key !== FAV_KEY && key !== UNCATEGORIZED) // custom categories can be renamed/deleted
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); showCategoryMenu(e.clientX, e.clientY, key); });
  for (const p of list) body.appendChild(makeCard(p));
  sec.appendChild(head); sec.appendChild(body);
  return sec;
}
function makeCard(p) {
  const card = el('div', 'card');
  card.dataset.id = p.id;
  if (p.id === activeId) card.classList.add('active');
  if (missing.has(p.id)) card.classList.add('missing');
  if (p.accent) { card.style.borderLeftWidth = '3px'; card.style.borderLeftColor = p.accent; card.style.paddingLeft = '7px'; }

  const head = el('div', 'card-head');
  const ind = el('span', 'pind ' + (projState.get(p.id) || 'quiet'));
  ind.dataset.id = p.id;
  ind.title = 'Спиннер — работает · янтарный — ждёт ответа · точка — готов';
  const title = el('span', 'card-title', p.name);
  title.title = p.path;
  const star = el('button', 'card-star' + (p.favorite ? ' on' : ''), p.favorite ? '★' : '☆');
  star.title = p.favorite ? 'Убрать из избранного' : 'В избранное';
  star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(p.id); });
  const kebab = el('button', 'card-kebab', '⋮');
  kebab.title = 'Меню проекта';
  kebab.addEventListener('click', (e) => { e.stopPropagation(); showCardMenu(e.clientX, e.clientY, p); });
  head.appendChild(ind); head.appendChild(title); head.appendChild(star); head.appendChild(kebab);
  card.appendChild(head);

  if (missing.has(p.id)) card.appendChild(el('div', 'card-missing', '⚠ папка удалена — закрой проект'));

  const actions = el('div', 'card-actions');
  const openViewer = el('button', null, '👁 вивер');
  if (p.id === activeId && viewerOpen) openViewer.classList.add('on');
  openViewer.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeId === p.id && viewerOpen) setViewerOpen(false);
    else { setActive(p.id); setViewerOpen(true); }
  });
  const nc = noteCounts[p.id] || 0;
  const notesBtn = el('button', null, nc ? `заметки · ${nc}` : 'заметки');
  notesBtn.addEventListener('click', (e) => { e.stopPropagation(); showNotes(p); });
  actions.appendChild(openViewer); actions.appendChild(notesBtn);
  card.appendChild(actions);

  card.addEventListener('click', () => setActive(p.id));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e.clientX, e.clientY, p); });
  return card;
}
function toggleFavorite(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  p.favorite = !p.favorite;
  saveProjects(); renderProjects();
}
function moveToCategory(id, cat) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  p.category = cat;          // null → "Все"; favorite stays independent
  saveProjects(); renderProjects();
}

// kebab/right-click project menu (two pages: actions ↔ move-to-category)
function showCardMenu(x, y, p) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '210px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  buildCardMenuMain(dd, p);
  placeMenu(dd, x, y);
}
function buildCardMenuMain(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('📁', 'Открыть в проводнике', () => { closeMenus(); lite.openInFileManager(p.path); }));
  dd.appendChild(menuRow('⎇', 'Git', () => { closeMenus(); showGit(p); }));
  dd.appendChild(menuRow('📝', 'Заметки', () => { closeMenus(); showNotes(p); }));
  dd.appendChild(menuRow('⧉', 'Копировать путь', () => { closeMenus(); lite.copyText(p.path); toast('Путь скопирован'); }));
  dd.appendChild(menuRow(p.favorite ? '★' : '☆', p.favorite ? 'Убрать из избранного' : 'В избранное', () => { closeMenus(); toggleFavorite(p.id); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('✎', 'Переименовать проект…', () => { closeMenus(); renameProject(p.id); }));
  dd.appendChild(menuRow('🎨', 'Цвет проекта…', () => buildCardMenuColor(dd, p)));
  dd.appendChild(menuRow('➜', 'Переместить в категорию…', () => buildCardMenuMove(dd, p)));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('✕', 'Закрыть проект', () => { closeMenus(); closeProject(p.id); }, 'danger'));
}
const ACCENTS = ['#2fbf71', '#3dc8dc', '#7aa2f7', '#a98cf0', '#e06fae', '#e0af68', '#f7768e', '#8aa79a'];
function buildCardMenuColor(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('‹', 'Назад', () => buildCardMenuMain(dd, p), 'muted'));
  dd.appendChild(el('div', 'menu-label', 'Цвет проекта'));
  const sw = el('div', 'accent-swatches');
  for (const c of ACCENTS) {
    const b = el('button', 'accent-sw' + (p.accent === c ? ' on' : ''));
    b.style.background = c;
    b.onclick = () => { closeMenus(); setAccent(p.id, c); };
    sw.appendChild(b);
  }
  dd.appendChild(sw);
  dd.appendChild(menuRow('✕', 'Сбросить цвет', () => { closeMenus(); setAccent(p.id, null); }, 'muted'));
}
function setAccent(id, c) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  if (c) p.accent = c; else delete p.accent;
  saveProjects(); renderProjects();
}
function renameProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  showPrompt('Переименовать проект', 'Название (папка на диске не меняется)', p.name, (name) => { p.name = name; saveProjects(); renderProjects(); });
}
// category section header menu
function showCategoryMenu(x, y, name) {
  closeMenus();
  const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '190px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  dd.appendChild(menuRow('✎', 'Переименовать категорию…', () => { closeMenus(); renameCategory(name); }));
  dd.appendChild(menuRow('🗑', 'Удалить категорию', () => { closeMenus(); deleteCategory(name); }, 'danger'));
  placeMenu(dd, x, y);
}
function renameCategory(old) {
  showPrompt('Переименовать категорию', 'Название', old, (name) => {
    if (name === old || name === UNCATEGORIZED) return;
    saveCategories([...new Set(loadCategories().map((c) => (c === old ? name : c)))]);
    const order = loadSectionOrder();
    if (order) saveSectionOrder(order.map((k) => (k === old ? name : k)));
    for (const p of projects) if (p.category === old) p.category = name;
    saveProjects(); renderProjects();
  });
}
function deleteCategory(name) {
  showConfirm('Удалить категорию?', `Проекты из «${name}» переедут в «Все». Папки на диске не трогаются.`, 'Удалить', () => {
    saveCategories(loadCategories().filter((c) => c !== name));
    for (const p of projects) if (p.category === name) p.category = null;
    saveProjects(); renderProjects();
  });
}
function buildCardMenuMove(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('‹', 'Назад', () => buildCardMenuMain(dd, p), 'muted'));
  dd.appendChild(el('div', 'menu-label', 'Переместить в'));
  const cats = loadCategories();
  const opts = [UNCATEGORIZED, ...cats];
  for (const c of opts) {
    const here = c === UNCATEGORIZED ? !cats.includes(p.category) : p.category === c;
    dd.appendChild(menuRow(here ? '•' : ' ', c, () => { closeMenus(); moveToCategory(p.id, c === UNCATEGORIZED ? null : c); }));
  }
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('✚', 'Создать новую…', () => { closeMenus(); showCreateCategory(p.id); }));
}
function showCreateCategory(id) {
  const { m, close } = makeModal(`
    <h2>✚ Новая категория</h2>
    <div class="field"><input type="text" id="nc-name" placeholder="Название категории" autocomplete="off" spellcheck="false"></div>
    <div class="modal-actions"><button class="btn" id="nc-cancel">Отмена</button><button class="btn primary" id="nc-ok">Создать</button></div>`);
  const inp = m.querySelector('#nc-name');
  setTimeout(() => inp.focus(), 30);
  m.querySelector('#nc-cancel').onclick = close;
  const ok = () => {
    const name = inp.value.trim();
    if (!name || name === UNCATEGORIZED) { close(); return; }
    const cats = loadCategories();
    if (!cats.includes(name)) { cats.push(name); saveCategories(cats); }
    moveToCategory(id, name);
    close();
  };
  m.querySelector('#nc-ok').onclick = ok;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
}

// ---------------------------------------------------------------- scan dirs (#1)
// Add immediate subfolders of each settings.scanDirs as projects (deduped; closed
// ones stay closed via STORE.dismissed). Runs at startup; non-blocking.
async function scanProjects() {
  const dirs = settings.scanDirs || [];
  if (!dirs.length) return;
  const dismissed = new Set(STORE.dismissed || []);
  const known = new Set(projects.map((p) => p.path));
  let added = false;
  for (const dir of dirs) {
    const entries = await lite.fs.readDir(dir);
    if (!Array.isArray(entries)) continue;
    for (const ent of entries) {
      if (!ent.dir || ent.name.startsWith('.')) continue;
      if (known.has(ent.path) || dismissed.has(ent.path)) continue;
      projects.push({ id: projId(ent.path), name: ent.name, path: ent.path });
      known.add(ent.path); added = true;
    }
  }
  if (added) {
    saveProjects();
    renderProjects();
    if (!activeId && projects.length) setActive(projects[0].id);
  }
}

// ---------------------------------------------------------------- keyboard layout swap
// Fix text typed in the wrong layout (e.g. "ghbdtn" → "привет") by physical key
// position. Direction is auto-detected from which alphabet dominates the text.
const US_RU_BASE = {
  '`': 'ё', q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '/': '.',
};
const US_RU = {};
for (const [k, v] of Object.entries(US_RU_BASE)) {
  US_RU[k] = v;
  if (/[a-z]/.test(k)) US_RU[k.toUpperCase()] = v.toUpperCase();
}
Object.assign(US_RU, { '{': 'Х', '}': 'Ъ', ':': 'Ж', '"': 'Э', '<': 'Б', '>': 'Ю' }); // shifted punctuation keys
const RU_US = {};
for (const [k, v] of Object.entries(US_RU)) if (!(v in RU_US)) RU_US[v] = k;

function convertLayout(text) {
  let lat = 0, cyr = 0;
  for (const ch of text) { if (/[a-z]/i.test(ch)) lat++; else if (/[а-яё]/i.test(ch)) cyr++; }
  const map = lat >= cyr ? US_RU : RU_US;
  let out = '';
  for (const ch of text) out += (map[ch] || ch);
  return out;
}
function applyLayoutSwap(ta) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s !== e) { // convert only the selection if there is one
    ta.value = ta.value.slice(0, s) + convertLayout(ta.value.slice(s, e)) + ta.value.slice(e);
    ta.setSelectionRange(s, e);
  } else {
    ta.value = convertLayout(ta.value);
  }
  ta.focus();
}

// ---------------------------------------------------------------- notes / prompt cards (#4)
async function showNotes(p) {
  let notes = await lite.store.notesGet(p.id);
  if (!Array.isArray(notes)) notes = [];
  const { m, close } = makeModal(`
    <h2>📝 Заметки — <span class="nm-proj"></span></h2>
    <div class="nm-hint">Карточки промптов: «В терминал» отправляет текст в терминал проекта (без Enter). Перетаскивай для сортировки.</div>
    <div class="nm-list" id="nm-list"></div>
    <button class="btn nm-add" id="nm-add">＋ Новая карточка</button>
    <div class="modal-actions"><button class="btn primary" id="nm-close">Готово</button></div>`);
  m.classList.add('notes-modal');
  m.querySelector('.nm-proj').textContent = p.name;
  const list = m.querySelector('#nm-list');
  const save = () => { lite.store.notesSet(p.id, notes); noteCounts[p.id] = notes.length; renderProjects(); };
  let dragFrom = null;

  function editNote(row, note) {
    row.innerHTML = '';
    const ta = el('textarea', 'note-edit'); ta.value = note.text || '';
    const acts = el('div', 'note-acts');
    const layout = el('button', 'note-btn', '⇄ Раскладка');
    layout.title = 'Сменить раскладку EN⇄РУ по позиции клавиш (или только выделенное)';
    layout.addEventListener('click', () => applyLayoutSwap(ta));
    const ok = el('button', 'note-btn', '✓ Сохранить');
    ok.addEventListener('click', () => { note.text = ta.value; save(); render(); });
    const cancel = el('button', 'note-btn', 'Отмена');
    cancel.addEventListener('click', render);
    acts.append(layout, ok, cancel);
    row.append(ta, acts);
    ta.focus();
  }
  function render() {
    list.innerHTML = '';
    notes.forEach((note, i) => {
      const row = el('div', 'note-card');
      row.draggable = true; row.dataset.i = String(i);
      row.append(el('div', 'note-text', note.text || '(пусто)'));
      const acts = el('div', 'note-acts');
      const sendDel = el('button', 'note-btn primary', '➤ В терминал + удалить');
      sendDel.title = 'Отправить в терминал и убрать карточку (одноразовый промпт)';
      sendDel.addEventListener('click', () => { const t = note.text; notes.splice(i, 1); save(); sendNoteToTerminal(p, t); close(); });
      const send = el('button', 'note-btn', '➤ В терминал');
      send.title = 'Отправить, но оставить карточку (для повторяющихся)';
      send.addEventListener('click', () => { sendNoteToTerminal(p, note.text); close(); });
      const edit = el('button', 'note-btn', '✎'); edit.title = 'Редактировать';
      edit.addEventListener('click', () => editNote(row, note));
      const del = el('button', 'note-btn danger', '🗑'); del.title = 'Удалить';
      del.addEventListener('click', () => { notes.splice(i, 1); save(); render(); });
      acts.append(sendDel, send, edit, del);
      row.append(acts);
      row.addEventListener('dragstart', () => { dragFrom = i; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom == null || dragFrom === i) return;
        const [moved] = notes.splice(dragFrom, 1); notes.splice(i, 0, moved);
        dragFrom = null; save(); render();
      });
      list.appendChild(row);
    });
    if (!notes.length) list.appendChild(el('div', 'nm-empty', 'Пока пусто — добавь карточку с промптом.'));
  }
  m.querySelector('#nm-add').addEventListener('click', () => {
    const note = { id: 'n' + Date.now().toString(36), text: '' };
    notes.push(note); save(); render();
    const rows = list.querySelectorAll('.note-card');
    if (rows.length) editNote(rows[rows.length - 1], note);
  });
  m.querySelector('#nm-close').onclick = close;
  render();
}
function sendNoteToTerminal(p, text) {
  if (!text) return;
  const proj = projects.find((x) => x.id === p.id);
  if (!proj) return;
  ensureTerminal(proj);
  setActive(proj.id);
  lite.pty.write(proj.id, text); // no trailing newline — review, then press Enter yourself
}

// ---------------------------------------------------------------- light git panel (#3)
function gitCodeClass(code) {
  if (code === '?' || code.includes('A')) return 'g-add';
  if (code.includes('D')) return 'g-del';
  return 'g-mod';
}
// Branch manager (JetBrains-style): per branch — checkout · update WITHOUT switching · new branch from it.
async function showBranches(body, p, back) {
  const info = await lite.git.info(p.path);
  body.innerHTML = '';
  const head = el('div', 'gm-branch');
  head.appendChild(el('span', 'gm-branchname', 'Ветки'));
  head.appendChild(el('span', 'gm-track', 'текущая: ' + info.branch));
  body.appendChild(head);

  const list = el('div', 'gm-branches');
  for (const b of (info.branches || [])) {
    const cur = b === info.branch;
    const row = el('div', 'gm-brow');
    row.appendChild(el('span', 'gm-brname' + (cur ? ' cur' : ''), (cur ? '• ' : '') + b));
    const acts = el('div', 'gm-bacts');
    if (!cur) {
      const co = el('button', 'gm-mini', '⤳'); co.title = 'Переключиться';
      co.onclick = async () => { const r = await lite.git.checkout(p.path, b); toast(r.ok ? 'Ветка: ' + b : (r.error || 'не вышло'), { kind: r.ok ? undefined : 'err', ttl: 7000 }); renderProjects(); showBranches(body, p, back); };
      acts.appendChild(co);
    }
    const up = el('button', 'gm-mini', '↻'); up.title = cur ? 'Обновить (pull --ff-only)' : 'Обновить из удалёнки БЕЗ переключения';
    up.onclick = async () => { const r = await lite.git.branchUpdate(p.path, b, cur); toast(r.ok ? ('Обновлено: ' + b) : (r.error || 'не fast-forward / нет upstream'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); showBranches(body, p, back); };
    acts.appendChild(up);
    const nb = el('button', 'gm-mini', '＋'); nb.title = 'Новая ветка от «' + b + '»';
    nb.onclick = () => showPrompt('Новая ветка от «' + b + '»', 'Имя ветки (создастся и перейдём на неё)', '', async (name) => {
      const r = await lite.git.branchCreate(p.path, name, b, true);
      if (r.ok) { toast('Создана и перешёл: ' + name); renderProjects(); back(); } return r;
    });
    acts.appendChild(nb);
    row.appendChild(acts);
    list.appendChild(row);
  }
  body.appendChild(list);

  const footer = el('div', 'gm-actions');
  const b1 = el('button', 'btn', '‹ Назад к git'); b1.onclick = back;
  footer.appendChild(b1);
  body.appendChild(footer);
}
async function showGit(p) {
  const { m, close } = makeModal(`<h2>⎇ Git — <span class="gm-proj"></span></h2><div id="gm-body" class="gm-body">Загрузка…</div>`);
  m.classList.add('git-modal');
  m.querySelector('.gm-proj').textContent = p.name;
  const body = m.querySelector('#gm-body');
  async function refresh() {
    const info = await lite.git.info(p.path);
    body.innerHTML = '';
    if (!info.repo) {
      body.appendChild(el('div', 'gm-norepo', 'Это не git-репозиторий.'));
      const row = el('div', 'gm-actions');
      const init = el('button', 'btn primary', '⎇ git init');
      init.onclick = async () => {
        const r = await lite.git.init(p.path);
        if (r.ok) { toast('git init готов'); refresh(); renderProjects(); }
        else toast(r.error || 'ошибка init', { kind: 'err', ttl: 7000 });
      };
      const cancel = el('button', 'btn', 'Закрыть'); cancel.onclick = close;
      row.append(init, cancel); body.appendChild(row);
      return;
    }
    const head = el('div', 'gm-branch');
    const sel = el('select', 'gm-branchsel');
    const brs = info.branches && info.branches.length ? info.branches : [info.branch];
    for (const b of brs) { const o = document.createElement('option'); o.value = b; o.textContent = '⎇ ' + b; if (b === info.branch) o.selected = true; sel.appendChild(o); }
    sel.onchange = async () => {
      const r = await lite.git.checkout(p.path, sel.value);
      if (r.ok) toast('Ветка: ' + sel.value); else toast(r.error || 'не удалось переключить', { kind: 'err', ttl: 8000 });
      refresh(); renderProjects();
    };
    head.appendChild(sel);
    const mgr = el('button', 'gm-mini', '⎇'); mgr.title = 'Ветки: переключить · обновить без перехода · новая от ветки';
    mgr.onclick = () => showBranches(body, p, refresh);
    head.appendChild(mgr);
    if (info.upstream && (info.ahead || info.behind)) head.appendChild(el('span', 'gm-track', `↑${info.ahead} ↓${info.behind}`));
    body.appendChild(head);

    if (info.lastCommit) {
      const lc = el('div', 'gm-last');
      lc.appendChild(el('span', 'gm-hash', info.lastCommit.hash));
      lc.appendChild(el('span', 'gm-subject', info.lastCommit.subject));
      lc.appendChild(el('span', 'gm-meta', `${info.lastCommit.when} · ${info.lastCommit.author}`));
      body.appendChild(lc);
    }

    const st = await lite.git.status(p.path);
    const files = (st && st.files) ? st.files : {};
    const keys = Object.keys(files);
    const changes = el('div', 'gm-changes');
    if (!keys.length) changes.appendChild(el('div', 'gm-clean', '✓ Рабочее дерево чистое.'));
    else for (const f of keys) {
      const r = el('div', 'gm-file'); r.title = f;
      r.appendChild(el('span', 'gm-code ' + gitCodeClass(files[f]), files[f]));
      r.appendChild(el('span', 'gm-fname', baseName(f)));
      const disc = el('button', 'gm-mini gm-disc', '↩'); disc.title = 'Откатить изменения файла';
      disc.onclick = () => showConfirm('Откатить файл?', `Изменения в «${baseName(f)}» будут отменены (git checkout --).`, 'Откатить', async () => {
        const rr = await lite.git.discardFile(p.path, f);
        if (rr.ok) { refresh(); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
      });
      r.appendChild(disc);
      changes.appendChild(r);
    }
    body.appendChild(changes);

    const msg = el('textarea', 'gm-msg'); msg.placeholder = 'Сообщение коммита…';
    body.appendChild(msg);
    const row = el('div', 'gm-actions');
    const commit = el('button', 'btn primary', 'Commit');
    const commitPush = el('button', 'btn', 'Commit & Push');
    const fetchBtn = el('button', 'btn', 'Fetch');
    const pull = el('button', 'btn', 'Pull');
    const push = el('button', 'btn', 'Push');
    commit.disabled = !keys.length; commitPush.disabled = !keys.length;
    const doCommit = async (withPush) => {
      const message = msg.value.trim();
      if (!message) { toast('Введи сообщение коммита', { kind: 'err' }); return; }
      const r = await lite.git.commit(p.path, message, withPush);
      if (r.ok) { toast(withPush ? 'Закоммичено и запушено' : 'Закоммичено'); msg.value = ''; refresh(); renderProjects(); }
      else toast(r.error || 'ошибка коммита', { kind: 'err', ttl: 8000 });
    };
    commit.onclick = () => doCommit(false);
    commitPush.onclick = () => doCommit(true);
    fetchBtn.onclick = async () => { const r = await lite.git.fetch(p.path); toast(r.ok ? 'Fetch готов' : (r.error || 'fetch не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); refresh(); };
    push.onclick = async () => { const r = await lite.git.push(p.path); toast(r.ok ? 'Запушено' : (r.error || 'push не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); refresh(); };
    pull.onclick = async () => { const r = await lite.git.pull(p.path); toast(r.ok ? 'Pull готов' : (r.error || 'pull не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); refresh(); renderProjects(); };
    row.append(commit, commitPush, fetchBtn, pull, push);
    body.appendChild(row);
  }
  refresh();
}

// Compact project switcher for single-terminal mode: indicator + name, click switches.
function renderMiniRail() {
  const rail = $('#mini-rail');
  rail.innerHTML = '';
  for (const p of projects) {
    const btn = el('button', 'rail-btn');
    if (p.id === activeId) btn.classList.add('active');
    btn.title = p.name;
    const ind = el('span', 'pind ' + (projState.get(p.id) || 'quiet'));
    ind.dataset.id = p.id;
    btn.appendChild(ind);
    btn.appendChild(el('span', 'rail-name', p.name));
    btn.addEventListener('click', () => setActive(p.id));
    rail.appendChild(btn);
  }
}

async function openProjectDialog() {
  const picked = await lite.openProject();
  if (picked) openByPath(picked.path, picked.name);
}

function openByPath(p, name) {
  const dis = (STORE.dismissed || []); // re-opening clears a prior "closed" mark so scan keeps it
  if (dis.includes(p)) persist('dismissed', dis.filter((x) => x !== p));
  const existing = projects.find((x) => x.path === p);
  if (existing) { setActive(existing.id); pushRecent({ path: p, name: existing.name }); return; }
  const proj = { id: projId(p), name: name || baseName(p), path: p };
  projects.push(proj);
  saveProjects();
  setActive(proj.id);
  pushRecent({ path: p, name: proj.name });
}

function closeProject(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  showConfirm(
    `Закрыть проект «${proj.name}»?`,
    'Терминал этого проекта будет выгружен из редактора. Файлы на диске не изменятся.',
    'Закрыть проект',
    () => doCloseProject(id),
  );
}
function doCloseProject(id) {
  const closing = projects.find((p) => p.id === id);
  if (closing) { // remember the close so a scan-dir project doesn't reappear next launch
    const dis = new Set(STORE.dismissed || []); dis.add(closing.path); persist('dismissed', [...dis]);
  }
  if (closing && watchedRoot === closing.path) { lite.fs.unwatch(closing.path); watchedRoot = null; }
  lite.pty.kill(id);
  const rec = terms.get(id);
  if (rec) {
    clearTimeout(rec.idleTimer);
    try { rec.term.dispose(); } catch (_) {}
    rec.container.remove();
    terms.delete(id);
  }
  projState.delete(id);
  missing.delete(id);
  projFiles.delete(id);
  saveProjFiles();
  projects = projects.filter((p) => p.id !== id);
  saveProjects();
  if (activeId === id) {
    activeId = null;
    if (projects.length) setActive(projects[0].id);
    else { if (viewerOpen) setViewerOpen(false); renderProjects(); showActiveTerminal(); }
  } else {
    renderProjects();
  }
}

// Flag projects whose folder was deleted on disk so the user can close them.
async function checkProjectsExistence() {
  for (const p of projects) {
    if (await lite.fs.exists(p.path)) missing.delete(p.id);
    else missing.add(p.id);
  }
  renderProjects();
}

// ---------------------------------------------------------------- activity indicator
// Three states: busy (output flowing) · waiting (quiet, but wants your input) ·
// quiet (done/idle). The reliable "wants attention" signal is the terminal BELL
// (\x07) — agents/CLIs ring it on purpose; a normal shell/Claude prompt does not,
// so we must NOT treat trailing $, #, ❯ as "waiting" (that's just idle/ready).
// PROMPT_RE is a narrow backup for plain CLIs (git/ssh/sudo) that don't bell.
const PROMPT_RE = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|overwrite\?|password[^\n]{0,24}:|passphrase[^\n]{0,24}:|press\s+(?:enter|return|any key)|continue\?/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const stripAnsi = (str) => str.replace(ANSI_RE, '');
// A real "attention" bell vs the BEL that merely terminates an OSC title sequence
// (ESC ] 0 ; title BEL) — which bash/zsh/Claude emit on every prompt. Strip OSC
// first, then a leftover BEL is a genuine bell.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const hasRealBell = (s) => s.replace(OSC_RE, '').includes('\x07');

function setProjState(id, state) {
  projState.set(id, state);
  document.querySelectorAll(`.pind[data-id="${id}"]`).forEach((ind) => { ind.className = 'pind ' + state; });
  updateAttention();
}
function markActivity(id, data) {
  const rec = terms.get(id);
  if (!rec) return;
  const bell = !!(data && hasRealBell(data));
  if (bell) rec.sawBell = true;
  // Local echo of the user's own typing is tiny and arrives right after a keystroke —
  // that's not the agent working, so don't spin on it.
  const echoLike = !bell && data && data.length <= 8 && (Date.now() - (rec.lastInputAt || 0)) < 250;
  if (echoLike) return;
  rec.tail = stripAnsi((rec.tail || '') + (data || '')).slice(-400);
  rec.activitySeq = (rec.activitySeq || 0) + 1; // lets a pending settle detect that new output arrived
  if (projState.get(id) !== 'busy') { rec.busyStart = Date.now(); setProjState(id, 'busy'); }
  clearTimeout(rec.idleTimer);
  rec.idleTimer = setTimeout(() => settleProject(id), settings.idleMs);
}
// Output stopped — ask the OS whether the foreground process is waiting on input
// (universal, agent-agnostic) and fall back to text heuristics off Linux.
async function settleProject(id) {
  const rec = terms.get(id);
  if (!rec) return;
  const seq = rec.activitySeq;
  const kind = await lite.pty.foregroundState(id); // 'shell' | 'running' | 'waiting' | null
  if (!terms.has(id) || rec.activitySeq !== seq) return; // new output arrived during the await

  if (kind === 'running') { // a foreground program is computing silently → keep spinner, re-poll
    if (projState.get(id) !== 'busy') setProjState(id, 'busy');
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => settleProject(id), settings.idleMs);
    return;
  }
  let waiting;
  if (kind === 'waiting') waiting = true;          // agent alive & blocked on your input
  else if (kind === 'shell') waiting = false;      // back at a bare shell prompt → idle/done
  else waiting = PROMPT_RE.test((rec.tail || '').split('\n').pop().trim()); // non-Linux fallback
  if (rec.sawBell) waiting = true;                 // explicit bell always means "look at me"
  const worked = rec.sawBell || (Date.now() - (rec.busyStart || 0)) >= 1500; // skip trivial blips
  rec.sawBell = false;
  setProjState(id, waiting ? 'waiting' : 'quiet');
  if (worked && (id !== activeId || !document.hasFocus())) notifyAgent(id, waiting ? 'waiting' : 'quiet');
}

let lastNotifyAt = 0;
function notifyAgent(id, state) {
  if (!settings.notifications) return;
  const proj = projects.find((p) => p.id === id);
  if (!proj || Date.now() - lastNotifyAt < 1200) return;
  lastNotifyAt = Date.now();
  const title = state === 'waiting' ? `⏳ ${proj.name} — агент ждёт ответа` : `✓ ${proj.name} — агент закончил`;
  try {
    const n = new Notification(title, { body: proj.path, silent: !settings.sound, tag: 'lite-' + id });
    n.onclick = () => { lite.win.show(); setActive(id); };
  } catch (_) {}
}
// Count of agents waiting on input → titlebar badge + tray tooltip.
function updateAttention() {
  const n = [...projState.values()].filter((s) => s === 'waiting').length;
  const badge = $('#attention-badge');
  if (badge) { badge.textContent = String(n); badge.classList.toggle('show', n > 0); }
  lite.tray.update(n);
}

// ---------------------------------------------------------------- terminals
// Matches a path with an extension, optionally :line — e.g. src/app.js:42.
const FILELINK_RE = /(?:[a-zA-Z]:)?(?:\.{0,2}[\\/])?[\w.\-\\/]+\.[A-Za-z][\w]*(?::\d+)?/g;
function fileLinkProvider(term, projPath) {
  return {
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { cb(undefined); return; }
      const text = line.translateToString(true);
      const links = [];
      let m; FILELINK_RE.lastIndex = 0;
      while ((m = FILELINK_RE.exec(text))) {
        const raw = m[0];
        if (!/[\\/]/.test(raw) && !/^\w+\.\w+(:\d+)?$/.test(raw)) continue;
        const startX = m.index + 1;
        links.push({
          range: { start: { x: startX, y }, end: { x: startX + raw.length - 1, y } },
          text: raw,
          activate: () => openFromTerminal(projPath, raw),
        });
      }
      cb(links.length ? links : undefined);
    },
  };
}
async function openFromTerminal(projPath, raw) {
  const mm = raw.match(/^(.*?)(?::(\d+))?$/);
  let p = mm[1]; const line = mm[2] ? parseInt(mm[2], 10) : 0;
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) p = projPath.replace(/[\\/]$/, '') + '/' + p.replace(/^\.[\\/]/, '');
  if (!(await lite.fs.exists(p))) return;
  if (!viewerOpen) setViewerOpen(true);
  await openFile(p, line);
}

// True only for a real GPU — software WebGL (SwiftShader/llvmpipe) is slower than
// Canvas and stalls, so route those to the Canvas renderer instead.
function isHardwareWebgl() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    return !/swiftshader|llvmpipe|software|mesa offscreen/i.test(r);
  } catch (_) { return false; }
}
// Fast xterm renderer: WebGL on real GPU (smooth scroll), else Canvas. Both beat
// the default DOM renderer. On WebGL context loss → fall back to Canvas.
function loadFastRenderer(term) {
  if (isHardwareWebgl()) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch (_) {}
        try { term.loadAddon(new CanvasAddon()); } catch (_) {}
      });
      term.loadAddon(webgl);
      return;
    } catch (_) {}
  }
  try { term.loadAddon(new CanvasAddon()); } catch (_) {}
}

function ensureTerminal(proj) {
  if (terms.has(proj.id)) return terms.get(proj.id);
  const container = el('div', 'term-instance');
  $('#terminals').appendChild(container);
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 5000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
  term.open(container);
  loadFastRenderer(term); // GPU/Canvas renderer → плавный скролл вместо тормозного DOM-рендера
  fit.fit();
  term.registerLinkProvider(fileLinkProvider(term, proj.path)); // src/app.js:42 → viewer
  lite.pty.create({ id: proj.id, cwd: proj.path, cols: term.cols, rows: term.rows });
  term.onData((data) => {
    const r = terms.get(proj.id);
    if (r) r.lastInputAt = Date.now(); // mark typing so its echo isn't counted as agent activity
    lite.pty.write(proj.id, data);
  });
  term.onResize(({ cols, rows }) => lite.pty.resize(proj.id, cols, rows));

  // Ctrl+V → paste from OS clipboard (Ctrl+C left alone so it stays SIGINT).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      pasteInto(proj.id);
      return false;
    }
    if (e.type === 'keydown' && e.ctrlKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      openTermSearch();
      return false;
    }
    return true;
  });
  // right-click → copy/paste menu
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTermMenu(e.clientX, e.clientY, term, proj.id);
  });

  const rec = { term, fit, search, container, idleTimer: null, sawBell: false, tail: '', busyStart: 0, lastInputAt: 0, activitySeq: 0 };
  terms.set(proj.id, rec);
  return rec;
}
async function pasteInto(id) {
  const text = await lite.readClipboard();
  if (text) lite.pty.write(id, text);
}

function showActiveTerminal() {
  $('#empty-hint').style.display = activeId ? 'none' : 'flex';
  for (const [id, rec] of terms) rec.container.style.display = id === activeId ? 'block' : 'none';
  refitActiveTerminal(true);
}
function refitActiveTerminal(focusIt) {
  const rec = terms.get(activeId);
  if (!rec) return;
  requestAnimationFrame(() => {
    try { rec.fit.fit(); lite.pty.resize(activeId, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {}
  });
}
function clearTerminal(id) { const rec = terms.get(id || activeId); if (rec) { try { rec.term.clear(); } catch (_) {} rec.term.focus(); } }
function restartTerminal(id) {
  const pid = id || activeId;
  const proj = projects.find((p) => p.id === pid);
  const rec = terms.get(pid);
  if (!proj || !rec) return;
  try { rec.term.reset(); } catch (_) {}
  rec.sawBell = false; rec.tail = ''; rec.busyStart = Date.now();
  clearTimeout(rec.idleTimer);
  setProjState(pid, 'busy');
  lite.pty.restart({ id: pid, cwd: proj.path, cols: rec.term.cols, rows: rec.term.rows });
  rec.term.focus();
}

// ---------------------------------------------------------------- font size
let watchedRoot = null; // we live-watch only the active project to limit inotify use
function applyFontSize() {
  for (const rec of terms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
  document.documentElement.style.setProperty('--editor-fs', settings.fontSize + 'px');
  refitActiveTerminal();
}
function bumpFont(delta) {
  settings.fontSize = Math.max(9, Math.min(24, settings.fontSize + delta));
  saveSettings(); applyFontSize();
}

// ---------------------------------------------------------------- terminal search
function openTermSearch() {
  const rec = terms.get(activeId);
  if (!rec) return;
  const box = $('#term-search');
  box.classList.add('show');
  const input = $('#term-search-input');
  input.focus(); input.select();
}
function closeTermSearch() {
  $('#term-search').classList.remove('show');
  const rec = terms.get(activeId);
  if (rec) { try { rec.search.clearDecorations(); } catch (_) {} rec.term.focus(); }
}
function runTermSearch(dir) {
  const rec = terms.get(activeId);
  const q = $('#term-search-input').value;
  if (!rec || !q) return;
  const opts = { decorations: { matchOverviewRuler: '#e0af68', activeMatchColorOverviewRuler: '#3ddc84' } };
  if (dir < 0) rec.search.findPrevious(q, opts); else rec.search.findNext(q, opts);
}

// Don't lose unsaved viewer edits when switching away — ask first.
function guardDirty(proceed) {
  if (!dirty || !currentFile) { proceed(); return; }
  showConfirm(
    'Несохранённые изменения',
    `Файл «${baseName(currentFile)}» изменён. Сохранить перед переключением?`,
    'Сохранить',
    async () => { await saveCurrent(); proceed(); },
    'Не сохранять',
    () => { markDirty(false); proceed(); },
  );
}

function setActive(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  if (id === activeId) return;
  guardDirty(() => doSetActive(id));
}
function doSetActive(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  activeId = id;
  if (watchedRoot && watchedRoot !== proj.path) lite.fs.unwatch(watchedRoot);
  lite.fs.watch(proj.path); watchedRoot = proj.path;
  ensureTerminal(proj);
  renderProjects();
  showActiveTerminal();
  applyFontSize();
  if (viewerOpen) refreshViewerForActive();
}

// ---------------------------------------------------------------- viewer (CodeMirror)
const LANGS = {
  js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
  ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }),
  py: python, json, md: markdown, markdown, html, htm: html, css, scss: css,
};
function languageFor(file) {
  const make = LANGS[extOf(file)];
  return make ? make() : [];
}
function makeEditor() {
  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(), highlightActiveLine(), drawSelection(), history(),
      indentOnInput(), bracketMatching(), highlightSelectionMatches(), search({ top: true }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
      langComp.of([]),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { saveCurrent(); return true; } },
        indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => { if (u.docChanged && !loadingDoc) markDirty(true); }),
    ],
  });
  editor = new EditorView({ state, parent: $('#editor') });
}
function previewKind(file) {
  const e = extOf(file);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(e)) return 'image';
  if (['md', 'markdown'].includes(e)) return 'markdown';
  if (['html', 'htm'].includes(e)) return 'html';
  return null;
}
async function openFile(filePath, line) {
  if (diffMode) exitDiff(false);
  exitPreview();
  const kind = previewKind(filePath);
  $('#viewer-filename').textContent = baseName(filePath);
  $('#viewer-preview').style.display = (kind && kind !== 'image') ? '' : 'none'; // toggle only when there's source too
  document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
  const row = document.querySelector(`.tree-row[data-path="${cssEscape(filePath)}"]`);
  if (row) row.classList.add('open');

  if (kind === 'image') { // binary — no editable source
    currentFile = filePath;
    if (activeId) { projFiles.set(activeId, filePath); saveProjFiles(); }
    setEditorText('', []); markDirty(false);
    await showPreview('image', filePath, '');
    return;
  }
  const res = await lite.fs.readFile(filePath);
  if (res.error) { setEditorText(`// ${res.error}`, []); currentFile = null; return; }
  currentFile = filePath;
  if (activeId) { projFiles.set(activeId, filePath); saveProjFiles(); } // remember per project
  setEditorText(res.content, languageFor(filePath));
  markDirty(false);
  if (kind) await showPreview(kind, filePath, res.content); // md/html default to rendered preview
  else if (line && line > 0) requestAnimationFrame(() => gotoLine(line));
}

// ---------------------------------------------------------------- viewer preview (md/image/html)
async function showPreview(kind, file, content) {
  previewMode = true;
  const view = $('#preview-view');
  view.innerHTML = '';
  if (kind === 'image') {
    const res = await lite.fs.readDataUrl(file);
    if (res.error) view.appendChild(el('div', 'prev-empty', res.error));
    else { const img = el('img', 'prev-img'); img.src = res.url; view.appendChild(img); }
  } else if (kind === 'markdown') {
    const div = el('div', 'prev-md');
    try { div.innerHTML = marked.parse(content || '', { breaks: true }); } catch (_) { div.textContent = content || ''; }
    const base = dirName(file);
    div.querySelectorAll('img').forEach((im) => { // resolve relative image paths from the file's folder
      const s = im.getAttribute('src') || '';
      if (s && !/^(https?:|data:|file:|\/\/)/i.test(s)) im.src = fileUrl(base + '/' + s.replace(/^\.\//, ''));
    });
    div.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a && /^https?:/i.test(a.href)) { e.preventDefault(); lite.openExternal(a.href); } });
    view.appendChild(div);
  } else if (kind === 'html') {
    const frame = document.createElement('iframe');
    frame.className = 'prev-frame';
    // load from disk (not srcdoc) so relative css/js/img resolve against the project folder
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
    frame.src = fileUrl(file);
    view.appendChild(frame);
  }
  $('#editor').style.display = 'none';
  view.style.display = 'block';
  $('#viewer-preview').classList.add('on');
}
function exitPreview() {
  previewMode = false;
  const v = $('#preview-view');
  if (v) { v.style.display = 'none'; v.innerHTML = ''; }
  $('#editor').style.display = '';
  $('#viewer-preview').classList.remove('on');
}
function togglePreview() {
  if (previewMode) { exitPreview(); editor.focus(); return; }
  const kind = previewKind(currentFile);
  if (kind) showPreview(kind, currentFile, editor.state.doc.toString());
}
function gotoLine(line) {
  const doc = editor.state.doc;
  const pos = doc.line(Math.max(1, Math.min(line, doc.lines))).from;
  editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  editor.focus();
}
// Reload the open file from disk (agent changed it) — keep caret roughly put.
async function reloadCurrentFile() {
  if (!currentFile) return;
  const res = await lite.fs.readFile(currentFile);
  if (res.error) return;
  const head = editor.state.selection.main.head;
  setEditorText(res.content, languageFor(currentFile));
  markDirty(false);
  try { editor.dispatch({ selection: { anchor: Math.min(head, editor.state.doc.length) } }); } catch (_) {}
}
function setEditorText(text, lang) {
  loadingDoc = true;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, effects: langComp.reconfigure(lang) });
  loadingDoc = false;
}
function markDirty(v) { dirty = v; $('#viewer-dirty').classList.toggle('show', v); }
async function saveCurrent() {
  if (!currentFile || !dirty) return;
  const res = await lite.fs.writeFile(currentFile, editor.state.doc.toString());
  if (res.ok) markDirty(false);
  else toast(`Не удалось сохранить: ${res.error || 'ошибка записи'}`, { kind: 'err', ttl: 6000 });
}

// ---------------------------------------------------------------- git diff in the viewer
async function toggleDiff() {
  if (diffMode) { exitDiff(true); return; }
  if (!currentFile) return;
  const p = activeProject(); if (!p) return;
  const res = await lite.git.fileDiff(p.path, currentFile);
  showDiff(res && res.diff ? res.diff : '');
}
function showDiff(text) {
  diffMode = true;
  const view = $('#diff-view');
  view.innerHTML = '';
  if (!text.trim()) {
    view.appendChild(el('div', 'diff-empty', 'Нет изменений относительно HEAD (или это не git-репозиторий).'));
  } else {
    for (const ln of text.split('\n')) {
      let cls = '';
      if (ln.startsWith('@@')) cls = 'hunk';
      else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'meta';
      else if (ln.startsWith('+')) cls = 'add';
      else if (ln.startsWith('-')) cls = 'del';
      view.appendChild(el('div', 'diff-line ' + cls, ln || ' '));
    }
  }
  $('#editor').style.display = 'none';
  view.style.display = 'block';
  $('#viewer-diff').classList.add('on');
}
function exitDiff(refocus) {
  diffMode = false;
  $('#diff-view').style.display = 'none';
  $('#editor').style.display = '';
  $('#viewer-diff').classList.remove('on');
  if (refocus) editor.focus();
}

// ---------------------------------------------------------------- git status (tree decorations)
async function loadGitStatus(proj) {
  if (!proj) { gitFiles = {}; return; }
  const res = await lite.git.status(proj.path);
  gitFiles = res && res.files ? res.files : {};
}
function gitClassFor(p) {
  const c = gitFiles[p];
  if (!c) return '';
  if (c === '?' || c.includes('A')) return 'g-add';
  if (c.includes('D')) return 'g-del';
  return 'g-mod';
}
function dirGitClass(dirPath) {
  for (const k in gitFiles) {
    if (k.length > dirPath.length && k.startsWith(dirPath) && (k[dirPath.length] === '/' || k[dirPath.length] === '\\')) return 'g-mod';
  }
  return '';
}

// ---------------------------------------------------------------- toasts
function toast(msg, opts = {}) {
  const t = el('div', 'toast' + (opts.kind ? ' ' + opts.kind : ''));
  t.appendChild(el('span', 'toast-msg', msg));
  if (opts.actionLabel) {
    const b = el('button', 'toast-act', opts.actionLabel);
    b.onclick = () => { t.remove(); opts.action && opts.action(); };
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, opts.ttl || 4000);
}
function clearViewer() {
  currentFile = null;
  setEditorText('', []);
  $('#viewer-filename').textContent = '—';
  markDirty(false);
  document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
}
// Re-render the tree for the active project and reopen its last file (per-project memory).
async function refreshViewerForActive() {
  const p = activeProject();
  if (!p) return;
  await renderTree(p);
  loadProjectFile(p.id);
}
async function loadProjectFile(id) {
  const last = projFiles.get(id);
  if (last && (await lite.fs.exists(last))) openFile(last);
  else { projFiles.delete(id); saveProjFiles(); clearViewer(); }
}

function setViewerOpen(open) {
  if (open === viewerOpen) {
    if (open) refreshViewerForActive();
    renderProjects();
    return;
  }
  const delta = layout.viewer + layout.tree + GUTTER * 2;
  viewerOpen = open;
  $('#viewer-pane').classList.toggle('hidden', !open);
  $('#tree-pane').classList.toggle('hidden', !open);
  document.querySelectorAll('.gutter-v').forEach((g) => g.classList.toggle('hidden', !open));
  lite.win.growBy(open ? delta : -delta);
  renderProjects();
  if (open) refreshViewerForActive();
  setTimeout(refitActiveTerminal, 150);
}

// ---------------------------------------------------------------- file tree
const EXT_COLORS = {
  js: '#e8d44d', jsx: '#e8d44d', mjs: '#e8d44d', cjs: '#e8d44d',
  ts: '#4a9be0', tsx: '#4a9be0',
  py: '#5fa6dd', json: '#cbcb41', md: '#9fb3a9', markdown: '#9fb3a9',
  html: '#e3733b', htm: '#e3733b', css: '#9b6bd6', scss: '#cf6ba0',
  png: '#b07cd6', jpg: '#b07cd6', jpeg: '#b07cd6', gif: '#b07cd6', webp: '#b07cd6', svg: '#ffb13b',
  sh: '#89e051', bash: '#89e051', yml: '#dd6c6c', yaml: '#dd6c6c', toml: '#b07a4a',
  lock: '#7a8a82', txt: '#9fb3a9', env: '#e2c08d', sql: '#e38f3b', vue: '#41b883', go: '#4ad0e0', rs: '#dd8855',
};
function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function colorFor(name) { return EXT_COLORS[extOf(name)] || '#8aa79a'; }
function fileSvg(color) {
  return svgEl(`<svg class="ti" viewBox="0 0 16 16" width="14" height="14">
    <path fill="${color}" opacity="0.95" d="M3.5 1.4h5.1L13 5.3v9.3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V2.4a1 1 0 0 1 1-1z"/>
    <path fill="#06120c" opacity="0.4" d="M8.6 1.4 13 5.3H9.1a.5.5 0 0 1-.5-.5z"/></svg>`);
}
function folderSvg(open) {
  const c = open ? '#7fd9ad' : '#56b98a';
  return svgEl(`<svg class="ti" viewBox="0 0 16 16" width="14" height="14">
    <path fill="${c}" d="M1.4 3.6h4.2l1.2 1.5H14.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H1.4a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1z"/></svg>`);
}

async function renderTree(proj) {
  $('#tree-title').textContent = proj.name.toUpperCase();
  await loadGitStatus(proj);
  const root = $('#tree');
  root.innerHTML = '';
  await buildDir(proj.path, root, 0);
}
async function buildDir(dir, container, depth) {
  const entries = await lite.fs.readDir(dir);
  if (!Array.isArray(entries)) return;
  for (const ent of entries) {
    const indent = depth * 12 + 8;
    if (ent.dir) {
      const row = el('div', 'tree-row dir');
      row.style.paddingLeft = indent + 'px';
      row.dataset.path = ent.path;
      const chev = el('span', 'tree-chev', '▸');
      let icon = folderSvg(false);
      const name = el('span', 'tree-name', ent.name);
      const gc = dirGitClass(ent.path); if (gc) name.classList.add(gc);
      row.appendChild(chev); row.appendChild(icon); row.appendChild(name);
      const childBox = el('div', 'tree-children');
      childBox.style.display = 'none';
      const expand = async () => {
        if (childBox.childElementCount === 0) await buildDir(ent.path, childBox, depth + 1);
        childBox.style.display = 'block'; chev.textContent = '▾';
        const nx = folderSvg(true); icon.replaceWith(nx); icon = nx;
      };
      const collapse = () => {
        childBox.style.display = 'none'; chev.textContent = '▸';
        const nx = folderSvg(false); icon.replaceWith(nx); icon = nx;
      };
      row.addEventListener('click', async () => {
        if (expandedDirs.has(ent.path)) { expandedDirs.delete(ent.path); collapse(); }
        else { expandedDirs.add(ent.path); await expand(); }
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTreeMenu(e.clientX, e.clientY, { name: ent.name, path: ent.path, dir: true }); });
      container.appendChild(row); container.appendChild(childBox);
      if (expandedDirs.has(ent.path)) await expand(); // restore after a live refresh
    } else {
      const row = el('div', 'tree-row file');
      row.style.paddingLeft = indent + 'px';
      row.dataset.path = ent.path;
      row.appendChild(el('span', 'tree-chev', ''));
      row.appendChild(fileSvg(colorFor(ent.name)));
      const name = el('span', 'tree-name', ent.name);
      const gc = gitClassFor(ent.path); if (gc) name.classList.add(gc);
      row.appendChild(name);
      if (ent.path === currentFile) row.classList.add('open');
      row.addEventListener('click', () => {
        if (ent.path === currentFile && viewerOpen) return;
        if (!viewerOpen) setViewerOpen(true);
        guardDirty(() => openFile(ent.path));
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTreeMenu(e.clientX, e.clientY, { name: ent.name, path: ent.path, dir: false }); });
      container.appendChild(row);
    }
  }
}
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); }
const dirName = (p) => { const i = p.search(/[\\/][^\\/]*$/); return i >= 0 ? p.slice(0, i) : p; };
// absolute fs path → file:// URL (Windows C:\x → file:///C:/x), for preview resources
function fileUrl(p) { let u = String(p).replace(/\\/g, '/'); if (!u.startsWith('/')) u = '/' + u; return 'file://' + encodeURI(u); }

// small single-input prompt modal; onOk(value) may return {error} to keep the dialog open
function showPrompt(title, label, initial, onOk) {
  const { m, close } = makeModal(`
    <h2></h2>
    <div class="field"><label></label><input type="text" id="pr-in" autocomplete="off" spellcheck="false"></div>
    <div class="err" id="pr-err"></div>
    <div class="modal-actions"><button class="btn" id="pr-cancel">Отмена</button><button class="btn primary" id="pr-ok">Ок</button></div>`);
  m.querySelector('h2').textContent = title;
  m.querySelector('label').textContent = label;
  const inp = m.querySelector('#pr-in'); inp.value = initial || '';
  const err = m.querySelector('#pr-err');
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  m.querySelector('#pr-cancel').onclick = close;
  const ok = async () => {
    const v = inp.value.trim();
    if (!v) { err.textContent = 'Введи имя'; return; }
    const res = await onOk(v);
    if (res && res.error) { err.textContent = res.error; return; }
    close();
  };
  m.querySelector('#pr-ok').onclick = ok;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
}

// ---------------------------------------------------------------- tree file operations (#6)
async function refreshTree() { const p = activeProject(); if (p) await renderTree(p); }
function treeNewFile(parent) {
  showPrompt('Новый файл', 'Имя файла (можно путь: src/app.js)', '', async (name) => {
    const r = await lite.fs.create(parent, name, false);
    if (r && !r.error) { await refreshTree(); if (r.path) { if (!viewerOpen) setViewerOpen(true); openFile(r.path); } }
    return r;
  });
}
function treeNewFolder(parent) {
  showPrompt('Новая папка', 'Имя папки', '', async (name) => {
    const r = await lite.fs.create(parent, name, true);
    if (r && !r.error) { expandedDirs.add(parent); await refreshTree(); }
    return r;
  });
}
function treeRename(ent) {
  showPrompt('Переименовать', 'Новое имя', ent.name, async (name) => {
    const to = dirName(ent.path) + '/' + name;
    const r = await lite.fs.rename(ent.path, to);
    if (r && !r.error) {
      if (currentFile === ent.path) { currentFile = to; $('#viewer-filename').textContent = name; if (activeId) { projFiles.set(activeId, to); saveProjFiles(); } }
      await refreshTree();
    }
    return r;
  });
}
function treeDelete(ent) {
  showConfirm('Удалить?', `«${ent.name}» будет перемещён в корзину.`, 'Удалить', async () => {
    const r = await lite.fs.trash(ent.path);
    if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
    if (currentFile && (currentFile === ent.path || currentFile.startsWith(ent.path + '/'))) clearViewer();
    await refreshTree();
  });
}
function showTreeMenu(x, y, ent) {
  closeMenus();
  const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '190px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  if (ent.dir) {
    dd.appendChild(menuRow('📄', 'Новый файл…', () => { closeMenus(); treeNewFile(ent.path); }));
    dd.appendChild(menuRow('📁', 'Новая папка…', () => { closeMenus(); treeNewFolder(ent.path); }));
    dd.appendChild(el('div', 'menu-sep'));
  } else {
    dd.appendChild(menuRow('👁', 'Открыть', () => { closeMenus(); if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(ent.path)); }));
    if (['html', 'htm'].includes(extOf(ent.name))) dd.appendChild(menuRow('🌐', 'Открыть в браузере', () => { closeMenus(); lite.openInFileManager(ent.path); }));
    dd.appendChild(el('div', 'menu-sep'));
  }
  if (!ent.root) {
    dd.appendChild(menuRow('✎', 'Переименовать…', () => { closeMenus(); treeRename(ent); }));
    dd.appendChild(menuRow('🗑', 'Удалить…', () => { closeMenus(); treeDelete(ent); }, 'danger'));
  }
  dd.appendChild(menuRow('⧉', 'Копировать путь', () => { closeMenus(); lite.copyText(ent.path); toast('Путь скопирован'); }));
  placeMenu(dd, x, y);
}

// ---------------------------------------------------------------- gutters (resize)
function initGutters() {
  document.querySelectorAll('.gutter').forEach((g) => {
    const target = g.dataset.resize;
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = layout[target];
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let w = target === 'sidebar' ? startW + dx : startW - dx;
        layout[target] = Math.max(150, Math.min(1000, w));
        applyLayout();
        refitActiveTerminal();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        saveLayout();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---------------------------------------------------------------- window controls
function initWindowControls() {
  $('#win-min').onclick = () => lite.win.minimize();
  $('#win-max').onclick = () => lite.win.maximizeToggle();
  $('#win-full').onclick = () => lite.win.fullscreen();
  $('#win-close').onclick = () => lite.win.close();
  lite.win.onMaximizeChange((v) => $('#app').classList.toggle('is-max', !!v));
  lite.win.isMaximized().then((v) => $('#app').classList.toggle('is-max', !!v));
  $('#topbar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, #menubar, .win-tools')) return;
    lite.win.maximizeToggle();
  });
}

// ---------------------------------------------------------------- menu
let openMenuName = null;
function initMenubar() {
  document.querySelectorAll('.menu-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.menu;
      if (openMenuName === name) { closeMenus(); return; }
      openTopMenu(name, btn);
    });
  });
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
}
function closeMenus() {
  $('#menu-layer').innerHTML = '';
  document.querySelectorAll('.menu-item.open').forEach((b) => b.classList.remove('open'));
  openMenuName = null;
}
function placeMenu(dd, x, y) {
  $('#menu-layer').appendChild(dd);
  dd.style.left = x + 'px';
  dd.style.top = y + 'px';
  const r = dd.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) dd.style.left = (window.innerWidth - 8 - r.width) + 'px';
  if (r.bottom > window.innerHeight - 8) dd.style.top = (window.innerHeight - 8 - r.height) + 'px';
}
function openTopMenu(name, btn) {
  closeMenus();
  if (name === 'about') { showAbout(); return; }
  openMenuName = name;
  btn.classList.add('open');
  const dd = el('div', 'menu-dropdown');
  if (name === 'file') buildFileMenu(dd);
  else if (name === 'settings') buildSettingsMenu(dd);
  dd.addEventListener('click', (e) => e.stopPropagation());
  const r = btn.getBoundingClientRect();
  placeMenu(dd, r.left, r.bottom + 4);
}
function menuRow(icon, text, onClick, cls) {
  const row = el('div', 'menu-row' + (cls ? ' ' + cls : ''));
  const ic = el('span', null, icon); ic.style.width = '16px'; ic.style.textAlign = 'center';
  row.appendChild(ic); row.appendChild(el('span', null, text));
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
function buildFileMenu(dd) {
  dd.appendChild(menuRow('📂', 'Открыть папку', () => { closeMenus(); openProjectDialog(); }));
  dd.appendChild(menuRow('✚', 'Создать папку…', () => { closeMenus(); showCreateFolder(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(el('div', 'menu-label', 'Ранее открытые'));
  const recents = loadRecents();
  const list = el('div', 'recents');
  if (!recents.length) {
    list.appendChild(el('div', 'menu-row disabled', '— пусто —'));
  } else {
    for (const r of recents) {
      const row = el('div', 'recent-row');
      row.title = r.path;
      row.appendChild(el('div', 'recent-name', r.name));
      row.appendChild(el('div', 'recent-path', r.path));
      row.addEventListener('click', () => { closeMenus(); openByPath(r.path, r.name); });
      list.appendChild(row);
    }
  }
  dd.appendChild(list);
  if (recents.length) {
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(menuRow('🗑', 'Очистить список', () => { persist('recents', []); closeMenus(); }));
  }
}
function buildSettingsMenu(dd) {
  dd.appendChild(menuRow('🎚', 'Настройки…', () => { closeMenus(); showSettings(); }));
  dd.appendChild(menuRow('⌘', 'Палитра команд (Ctrl+K)', () => { closeMenus(); showPalette(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('🔍', 'Поиск в терминале (Ctrl+F)', () => { closeMenus(); openTermSearch(); }));
}

// terminal right-click menu
function showTermMenu(x, y, term, projId) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '160px';
  const hasSel = term.hasSelection && term.hasSelection();
  dd.appendChild(menuRow('⧉', 'Копировать', hasSel ? () => {
    closeMenus();
    lite.copyText(term.getSelection());
    if (term.clearSelection) term.clearSelection();
  } : null, hasSel ? '' : 'disabled'));
  dd.appendChild(menuRow('📋', 'Вставить', () => { closeMenus(); pasteInto(projId); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('🧹', 'Очистить', () => { closeMenus(); clearTerminal(projId); }));
  dd.appendChild(menuRow('⟳', 'Перезапустить', () => { closeMenus(); restartTerminal(projId); }));
  dd.addEventListener('click', (e) => e.stopPropagation());
  placeMenu(dd, x, y);
}

// ---------------------------------------------------------------- modals
function makeModal(innerHtml) {
  const overlay = el('div', 'modal-overlay');
  const m = el('div', 'modal');
  m.innerHTML = innerHtml;
  overlay.appendChild(m);
  $('#modal-root').appendChild(overlay);
  const close = () => { $('#modal-root').innerHTML = ''; };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return { overlay, m, close };
}
// Optional middle button (altLabel/onAlt) turns this into a 3-way prompt
// (e.g. Save / Don't save / Cancel).
function showConfirm(title, text, yesLabel, onYes, altLabel, onAlt) {
  const { m, close } = makeModal(`
    <h2 class="cm-title"></h2>
    <div class="about-desc cm-text"></div>
    <div class="modal-actions">
      <button class="btn" id="cm-no">Отмена</button>
      <button class="btn" id="cm-alt" style="display:none"></button>
      <button class="btn primary" id="cm-yes"></button>
    </div>`);
  m.querySelector('.cm-title').textContent = title;
  m.querySelector('.cm-text').textContent = text;
  m.querySelector('#cm-yes').textContent = yesLabel;
  m.querySelector('#cm-no').onclick = close;
  m.querySelector('#cm-yes').onclick = () => { close(); onYes(); };
  if (altLabel) {
    const alt = m.querySelector('#cm-alt');
    alt.style.display = ''; alt.textContent = altLabel;
    alt.onclick = () => { close(); onAlt && onAlt(); };
  }
  setTimeout(() => m.querySelector('#cm-yes').focus(), 30);
}
function showAbout() {
  closeMenus();
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">▍</span>LiteEditorAI</h2>
    <div class="about-desc">
      Лёгкий редактор для работы с ИИ-агентами прямо в терминале.
      У каждого проекта свой терминал, рядом — просмотр и правка файлов, дерево и git.
      Открыл папку — сразу работаешь с агентом (Claude&nbsp;Code, Codex, Qwen, Kimi и&nbsp;др.).<br><br>
      Заметки-промпты, темы, индикатор «агент ждёт ответа». Сделано на Electron.
    </div>
    <div class="about-ver">${APP_VERSION}</div>
    <div class="modal-actions"><button class="btn primary" id="ab-ok">Ок</button></div>`);
  m.querySelector('#ab-ok').onclick = close;
}
function showCreateFolder() {
  const { m, close } = makeModal(`
    <h2>✚ Создать папку</h2>
    <div class="field"><label>Название папки</label>
      <input type="text" id="cf-name" placeholder="my-project" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>Где создать</label>
      <div class="path-pick">
        <input type="text" id="cf-parent" placeholder="выбери расположение…" readonly>
        <button class="btn" id="cf-pick">Выбрать…</button>
      </div></div>
    <div class="err" id="cf-err"></div>
    <div class="modal-actions">
      <button class="btn" id="cf-cancel">Отмена</button>
      <button class="btn primary" id="cf-create">Создать и открыть</button>
    </div>`);
  const nameI = m.querySelector('#cf-name');
  const parentI = m.querySelector('#cf-parent');
  const err = m.querySelector('#cf-err');
  parentI.value = settings.workingDir || lastParent || ''; // working folder wins when set
  setTimeout(() => nameI.focus(), 30);
  m.querySelector('#cf-cancel').onclick = close;
  m.querySelector('#cf-pick').onclick = async () => {
    const d = await lite.pickDir();
    if (d) { parentI.value = d; lastParent = d; persist('lastParent', d); }
  };
  const create = async () => {
    const name = nameI.value.trim();
    const parent = parentI.value.trim();
    err.textContent = '';
    if (!name) { err.textContent = 'Введи название папки'; return; }
    if (!parent) { err.textContent = 'Выбери, где создать'; return; }
    const res = await lite.fs.mkdir(parent, name);
    if (res.error) { err.textContent = res.error; return; }
    close();
    openByPath(res.path, res.name);
  };
  m.querySelector('#cf-create').onclick = create;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
}

// ---------------------------------------------------------------- settings panel (small on purpose)
function showSettings() {
  const { m, close } = makeModal(`
    <h2>🎚 Настройки</h2>
    <label class="set-row"><span>Уведомления о завершении агента</span><input type="checkbox" id="st-notif"></label>
    <label class="set-row"><span>Звук уведомлений</span><input type="checkbox" id="st-sound"></label>
    <label class="set-row"><span>Тишина до «готов», мс</span><input type="number" id="st-idle" min="300" max="6000" step="100"></label>
    <label class="set-row"><span>Размер шрифта</span><input type="number" id="st-font" min="9" max="24"></label>
    <label class="set-row"><span>Тема</span><select id="st-theme"></select></label>
    <div class="set-row col"><span>Рабочая папка — куда создаются новые проекты</span>
      <div class="path-pick">
        <input type="text" id="st-wd" readonly placeholder="не задана">
        <button class="btn" id="st-wd-pick">Выбрать</button>
        <button class="btn" id="st-wd-clear" title="Очистить">✕</button>
      </div></div>
    <div class="set-row col"><span>Папки для скана — их подпапки добавляются как проекты при запуске</span>
      <div id="st-scan" class="scan-list"></div>
      <button class="btn" id="st-scan-add">＋ Добавить папку</button></div>
    <div class="modal-actions"><button class="btn primary" id="st-ok">Готово</button></div>`);
  const notif = m.querySelector('#st-notif'); notif.checked = settings.notifications;
  const sound = m.querySelector('#st-sound'); sound.checked = settings.sound;
  const idle = m.querySelector('#st-idle'); idle.value = settings.idleMs;
  const font = m.querySelector('#st-font'); font.value = settings.fontSize;
  const themeSel = m.querySelector('#st-theme');
  for (const [key, t] of Object.entries(THEMES)) { const o = document.createElement('option'); o.value = key; o.textContent = t.label; themeSel.appendChild(o); }
  themeSel.value = THEMES[settings.theme] ? settings.theme : 'emerald';
  themeSel.addEventListener('change', () => { settings.theme = themeSel.value; saveSettings(); applyTheme(); }); // live preview
  const wd = m.querySelector('#st-wd'); wd.value = settings.workingDir || '';
  let scan = [...(settings.scanDirs || [])];
  const scanBox = m.querySelector('#st-scan');
  const renderScan = () => {
    scanBox.innerHTML = '';
    if (!scan.length) { scanBox.appendChild(el('div', 'scan-empty', '— пусто —')); return; }
    scan.forEach((d, i) => {
      const r = el('div', 'scan-item');
      const path = el('span', 'scan-path', d); path.title = d;
      const x = el('button', 'scan-del', '✕');
      x.onclick = () => { scan.splice(i, 1); renderScan(); };
      r.append(path, x); scanBox.appendChild(r);
    });
  };
  renderScan();
  m.querySelector('#st-wd-pick').onclick = async () => { const d = await lite.pickDir(); if (d) wd.value = d; };
  m.querySelector('#st-wd-clear').onclick = () => { wd.value = ''; };
  m.querySelector('#st-scan-add').onclick = async () => { const d = await lite.pickDir(); if (d && !scan.includes(d)) { scan.push(d); renderScan(); } };
  m.querySelector('#st-ok').onclick = () => {
    settings.notifications = notif.checked;
    settings.sound = sound.checked;
    settings.idleMs = Math.max(300, Math.min(6000, parseInt(idle.value, 10) || 1200));
    settings.fontSize = Math.max(9, Math.min(24, parseInt(font.value, 10) || 13));
    settings.workingDir = wd.value || '';
    settings.scanDirs = scan;
    saveSettings(); applyFontSize(); close();
    scanProjects(); // pick up newly-added scan dirs right away
  };
}

// ---------------------------------------------------------------- command palette (Ctrl+K)
function paletteActions() {
  const acts = [];
  for (const p of projects) acts.push({ label: `Проект: ${p.name}`, hint: p.path, run: () => setActive(p.id) });
  acts.push({ label: 'Открыть папку…', run: openProjectDialog });
  acts.push({ label: 'Создать папку…', run: showCreateFolder });
  acts.push({ label: viewerOpen ? 'Закрыть вивер' : 'Открыть вивер', run: () => setViewerOpen(!viewerOpen) });
  acts.push({ label: 'Режим «один терминал»', run: toggleSingle });
  acts.push({ label: 'Поиск в терминале', run: openTermSearch });
  acts.push({ label: 'Очистить терминал', run: () => clearTerminal() });
  acts.push({ label: 'Перезапустить терминал', run: () => restartTerminal() });
  acts.push({ label: 'Настройки…', run: showSettings });
  if (currentFile) acts.push({ label: 'Показать дифф файла', run: toggleDiff });
  if (currentFile) acts.push({ label: 'Поиск в файле', run: () => { if (viewerOpen && !previewMode) openSearchPanel(editor); } });
  if (previewKind(currentFile || '')) acts.push({ label: 'Превью файла (вкл/выкл)', run: togglePreview });
  return acts;
}
function showPalette() {
  closeMenus();
  const all = paletteActions();
  const { m, close } = makeModal(`
    <input type="text" id="pal-input" class="pal-input" placeholder="Команда или проект…" autocomplete="off" spellcheck="false">
    <div class="pal-list" id="pal-list"></div>`);
  m.classList.add('palette');
  const input = m.querySelector('#pal-input');
  const list = m.querySelector('#pal-list');
  let sel = 0, shown = all;
  const render = () => {
    list.innerHTML = '';
    shown.forEach((a, i) => {
      const row = el('div', 'pal-row' + (i === sel ? ' sel' : ''));
      row.appendChild(el('span', 'pal-label', a.label));
      if (a.hint) row.appendChild(el('span', 'pal-hint', a.hint));
      row.addEventListener('click', () => { close(); a.run(); });
      list.appendChild(row);
    });
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((a) => (a.label + ' ' + (a.hint || '')).toLowerCase().includes(q)) : all;
    sel = 0; render();
  };
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const a = shown[sel]; if (a) { close(); a.run(); } }
  });
  render();
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- onboarding (first run)
function showOnboarding() {
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">▍</span>Добро пожаловать в LiteEditor</h2>
    <div class="about-desc">
      Терминал-ориентированное окружение для работы с агентами: у каждого проекта свой живой терминал,
      а вивер кода и дерево файлов прячутся одной кнопкой.<br><br>
      С чего начать:
      <ul style="margin:6px 0 0; padding-left:18px; line-height:1.7">
        <li><b>Открыть папку</b> — проект слева, справа поднимется его терминал.</li>
        <li>В <b>Настройках</b> задай рабочую папку и папки для авто-скана проектов.</li>
        <li><b>Ctrl+K</b> — палитра команд · <b>Ctrl+\\</b> — режим одного терминала.</li>
      </ul>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ob-settings">Настройки</button>
      <button class="btn primary" id="ob-open">Открыть папку</button>
      <button class="btn" id="ob-skip">Позже</button>
    </div>`);
  const done = () => { settings.onboarded = true; saveSettings(); close(); };
  m.querySelector('#ob-settings').onclick = () => { done(); showSettings(); };
  m.querySelector('#ob-open').onclick = () => { done(); openProjectDialog(); };
  m.querySelector('#ob-skip').onclick = done;
}

// ---------------------------------------------------------------- single-terminal toggle
function toggleSingle() {
  $('#app').classList.toggle('single');
  refitActiveTerminal();
}

// ---------------------------------------------------------------- init
function init() {
  makeEditor();
  applyLayout();
  applyTheme();
  initGutters();
  initWindowControls();
  initMenubar();

  // surface unexpected renderer errors instead of failing silently
  window.addEventListener('error', (e) => toast('Ошибка: ' + (e.message || (e.error && e.error.message) || 'см. F12'), { kind: 'err', ttl: 8000 }));
  window.addEventListener('unhandledrejection', (e) => toast('Ошибка: ' + ((e.reason && e.reason.message) || e.reason || 'промис'), { kind: 'err', ttl: 8000 }));

  lite.pty.onData(({ id, data }) => {
    const rec = terms.get(id);
    if (!rec) return;
    rec.term.write(data);
    markActivity(id, data);
  });
  lite.pty.onExit(({ id }) => {
    const rec = terms.get(id);
    if (rec) rec.term.write('\r\n\x1b[90m[процесс завершён — закрой и переоткрой проект]\x1b[0m\r\n');
    setProjState(id, 'quiet');
  });

  // Live disk changes for the active project: refresh tree (keeping expansion)
  // and reload the open file — or warn if you have unsaved edits.
  let fsTimer = null;
  lite.fs.onChange(({ root, files }) => {
    const p = activeProject();
    if (!p || p.path !== root) return;
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => {
      if (viewerOpen) renderTree(p);
      if (currentFile && files.includes(currentFile) && !diffMode) {
        if (!dirty) reloadCurrentFile();
        else toast(`«${baseName(currentFile)}» изменён на диске`, { actionLabel: 'Перечитать', action: reloadCurrentFile, ttl: 8000 });
      }
    }, 120);
  });

  $('#open-folder-btn').addEventListener('click', openProjectDialog);
  $('#btn-single').addEventListener('click', toggleSingle);
  $('#viewer-save').addEventListener('click', saveCurrent);
  $('#viewer-diff').addEventListener('click', toggleDiff);
  $('#viewer-preview').addEventListener('click', togglePreview);
  $('#viewer-close').addEventListener('click', () => setViewerOpen(false));
  $('#tree-refresh').addEventListener('click', () => { const p = activeProject(); if (p) renderTree(p); });
  $('#tree-new').addEventListener('click', (e) => { const p = activeProject(); if (p) showTreeMenu(e.clientX, e.clientY, { name: p.name, path: p.path, dir: true, root: true }); });
  $('#tree').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return; // row menus handle their own
    e.preventDefault();
    const p = activeProject(); if (p) showTreeMenu(e.clientX, e.clientY, { name: p.name, path: p.path, dir: true, root: true });
  });
  $('#term-clear').addEventListener('click', () => clearTerminal());
  $('#term-restart').addEventListener('click', () => restartTerminal());
  $('#attention-badge').addEventListener('click', () => {
    const id = [...projState.entries()].find(([, s]) => s === 'waiting');
    if (id) setActive(id[0]);
  });

  // terminal search box
  $('#term-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runTermSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
  });
  $('#term-search-next').addEventListener('click', () => runTermSearch(1));
  $('#term-search-prev').addEventListener('click', () => runTermSearch(-1));
  $('#term-search-close').addEventListener('click', closeTermSearch);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '\\') { e.preventDefault(); toggleSingle(); }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveCurrent(); }
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); showPalette(); }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); bumpFont(1); }
    if (e.ctrlKey && e.key === '-') { e.preventDefault(); bumpFont(-1); }
    if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleProject(e.shiftKey ? -1 : 1); }
    if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
      const p = projects[parseInt(e.key, 10) - 1];
      if (p) { e.preventDefault(); setActive(p.id); }
    }
  });

  // drag a folder onto the window to open it as a project
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = f.path || lite.pathForFile(f);
    if (p) openByPath(p, baseName(p));
  });

  let rezTimer;
  new ResizeObserver(() => { clearTimeout(rezTimer); rezTimer = setTimeout(() => refitActiveTerminal(), 80); }).observe($('#terminal-pane'));

  applyFontSize();
  projects = loadProjectsFromDisk();
  renderProjects();
  if (projects.length) setActive(projects[0].id);
  else showActiveTerminal();

  scanProjects();          // add subfolders of settings.scanDirs (non-blocking)
  checkProjectsExistence();
  window.addEventListener('focus', checkProjectsExistence); // re-check when returning to the app

  if (!settings.onboarded) setTimeout(showOnboarding, 200); // first-run welcome
}

function cycleProject(dir) {
  if (projects.length < 2) return;
  const i = projects.findIndex((p) => p.id === activeId);
  const next = projects[(i + dir + projects.length) % projects.length];
  if (next) setActive(next.id);
}

init();
