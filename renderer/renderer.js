// LiteEditor renderer — projects, per-project terminal, viewer, file tree,
// custom titlebar, menu, modals. Talks to the backend only via window.lite.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';

const APP_VERSION = 'alpha v1.0.0';
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

// ---------------------------------------------------------------- settings (tiny on purpose)
const DEFAULT_SETTINGS = { notifications: true, sound: false, idleMs: 1200, fontSize: 13 };
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('lite.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
let settings = loadSettings();
function saveSettings() { localStorage.setItem('lite.settings', JSON.stringify(settings)); }

// ---------------------------------------------------------------- state
let projects = [];
let activeId = null;
const terms = new Map();
const projState = new Map(); // id -> 'quiet' | 'busy' | 'waiting'
const missing = new Set();   // ids of projects whose folder no longer exists on disk
const projFiles = loadProjFiles(); // id -> last file opened in the viewer
const expandedDirs = new Set(); // tree dir paths currently expanded (survives live refresh)
let gitFiles = {};           // active project: abs path -> git short status code
let viewerOpen = false;
let currentFile = null;
let dirty = false;
let diffMode = false;        // viewer showing a git diff instead of the file
let editor = null;
let loadingDoc = false;
const langComp = new Compartment();

const DEFAULT_LAYOUT = { sidebar: 240, viewer: 520, tree: 240 };
let layout = loadLayout();
let lastParent = localStorage.getItem('lite.lastParent') || '';

const TERM_THEME = {
  background: '#0a120d', foreground: '#cfe6d9', cursor: '#3ddc84',
  selectionBackground: '#1f4a36',
  black: '#0a120d', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
};

const activeProject = () => projects.find((p) => p.id === activeId);

// ---------------------------------------------------------------- persistence
function saveProjects() { localStorage.setItem('lite.projects', JSON.stringify(projects)); }
function loadProjectsFromDisk() {
  try { return JSON.parse(localStorage.getItem('lite.projects') || '[]'); } catch { return []; }
}
function loadLayout() {
  try { return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem('lite.layout') || '{}') }; }
  catch { return { ...DEFAULT_LAYOUT }; }
}
function saveLayout() { localStorage.setItem('lite.layout', JSON.stringify(layout)); }
function applyLayout() {
  $('#sidebar').style.flexBasis = layout.sidebar + 'px';
  $('#viewer-pane').style.flexBasis = layout.viewer + 'px';
  $('#tree-pane').style.flexBasis = layout.tree + 'px';
}
function loadRecents() { try { return JSON.parse(localStorage.getItem('lite.recents') || '[]'); } catch { return []; } }
function pushRecent(p) {
  const r = loadRecents().filter((x) => x.path !== p.path);
  r.unshift({ path: p.path, name: p.name });
  localStorage.setItem('lite.recents', JSON.stringify(r.slice(0, 30)));
}
function loadProjFiles() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem('lite.projFiles') || '{}'))); }
  catch { return new Map(); }
}
function saveProjFiles() { localStorage.setItem('lite.projFiles', JSON.stringify(Object.fromEntries(projFiles))); }

// ---------------------------------------------------------------- projects column
function renderProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  for (const p of projects) {
    const card = el('div', 'card');
    card.dataset.id = p.id;
    if (p.id === activeId) card.classList.add('active');
    if (missing.has(p.id)) card.classList.add('missing');

    const head = el('div', 'card-head');
    const ind = el('span', 'pind ' + (projState.get(p.id) || 'quiet'));
    ind.dataset.id = p.id;
    ind.title = 'Индикатор: спиннер — в терминале идёт вывод, точка — тихо';
    const title = el('span', 'card-title', p.name);
    const closeBtn = el('button', 'card-close', '✕');
    closeBtn.title = 'Закрыть проект';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeProject(p.id); });
    head.appendChild(ind); head.appendChild(title); head.appendChild(closeBtn);
    card.appendChild(head);

    const pathRow = el('div', 'card-path-row');
    const pathEl = el('div', 'card-path', p.path);
    pathEl.title = p.path;
    const copyBtn = el('button', 'card-copy', '⧉');
    copyBtn.title = 'Скопировать полный путь';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      lite.copyText(p.path);
      copyBtn.textContent = '✓'; copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = '⧉'; copyBtn.classList.remove('copied'); }, 1100);
    });
    pathRow.appendChild(pathEl); pathRow.appendChild(copyBtn);
    card.appendChild(pathRow);

    if (missing.has(p.id)) card.appendChild(el('div', 'card-missing', '⚠ папка удалена — закрой проект'));

    const actions = el('div', 'card-actions');
    const openFs = el('button', null, '📁');
    openFs.title = 'Открыть в проводнике';
    openFs.addEventListener('click', (e) => { e.stopPropagation(); lite.openInFileManager(p.path); });
    const openViewer = el('button', null, '👁');
    openViewer.title = 'Открыть вивер';
    if (p.id === activeId && viewerOpen) openViewer.classList.add('on');
    openViewer.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeId === p.id && viewerOpen) setViewerOpen(false);
      else { setActive(p.id); setViewerOpen(true); }
    });
    actions.appendChild(openFs); actions.appendChild(openViewer);
    card.appendChild(actions);

    card.addEventListener('click', () => setActive(p.id));
    box.appendChild(card);
  }
  renderMiniRail();
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
  const existing = projects.find((x) => x.path === p);
  if (existing) { setActive(existing.id); pushRecent({ path: p, name: existing.name }); return; }
  const proj = { id: 'p' + Math.random().toString(36).slice(2, 9), name: name || p.split('/').filter(Boolean).pop() || p, path: p };
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
// Three states: busy (output flowing) · waiting (quiet, but looks like it wants
// input) · quiet (done/idle). Heuristic — the terminal bell and trailing prompt
// patterns are the tells that an agent is waiting on you.
const PROMPT_RE = /(\?|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|press\s+enter|continue|proceed|overwrite|password:|passphrase:|❯|›|\$\s|#\s)\s*$/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const stripAnsi = (str) => str.replace(ANSI_RE, '');

function setProjState(id, state) {
  projState.set(id, state);
  document.querySelectorAll(`.pind[data-id="${id}"]`).forEach((ind) => { ind.className = 'pind ' + state; });
  updateAttention();
}
function markActivity(id, data) {
  const rec = terms.get(id);
  if (!rec) return;
  if (data && data.includes('\x07')) rec.sawBell = true; // BEL — common "look at me" signal
  rec.tail = stripAnsi((rec.tail || '') + (data || '')).slice(-400);
  if (projState.get(id) !== 'busy') { rec.busyStart = Date.now(); setProjState(id, 'busy'); }
  clearTimeout(rec.idleTimer);
  rec.idleTimer = setTimeout(() => settleProject(id), settings.idleMs);
}
function settleProject(id) {
  const rec = terms.get(id);
  if (!rec) return;
  const tail = rec.tail || '';
  const lastLine = tail.split('\n').pop().trim();
  const waiting = rec.sawBell || PROMPT_RE.test(lastLine);
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

function ensureTerminal(proj) {
  if (terms.has(proj.id)) return terms.get(proj.id);
  const container = el('div', 'term-instance');
  $('#terminals').appendChild(container);
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: TERM_THEME, scrollback: 5000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
  term.open(container);
  fit.fit();
  term.registerLinkProvider(fileLinkProvider(term, proj.path)); // src/app.js:42 → viewer
  lite.pty.create({ id: proj.id, cwd: proj.path, cols: term.cols, rows: term.rows });
  term.onData((data) => lite.pty.write(proj.id, data));
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

  const rec = { term, fit, search, container, idleTimer: null, sawBell: false, tail: '', busyStart: 0 };
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
  refitActiveTerminal();
}
function refitActiveTerminal() {
  const rec = terms.get(activeId);
  if (!rec) return;
  requestAnimationFrame(() => {
    try { rec.fit.fit(); lite.pty.resize(activeId, rec.term.cols, rec.term.rows); rec.term.focus(); } catch (_) {}
  });
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
      indentOnInput(), bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
      langComp.of([]),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { saveCurrent(); return true; } },
        indentWithTab, ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => { if (u.docChanged && !loadingDoc) markDirty(true); }),
    ],
  });
  editor = new EditorView({ state, parent: $('#editor') });
}
async function openFile(filePath, line) {
  if (diffMode) exitDiff(false);
  const res = await lite.fs.readFile(filePath);
  $('#viewer-filename').textContent = baseName(filePath);
  if (res.error) { setEditorText(`// ${res.error}`, []); currentFile = null; return; }
  currentFile = filePath;
  if (activeId) { projFiles.set(activeId, filePath); saveProjFiles(); } // remember per project
  setEditorText(res.content, languageFor(filePath));
  markDirty(false);
  document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
  const row = document.querySelector(`.tree-row[data-path="${cssEscape(filePath)}"]`);
  if (row) row.classList.add('open');
  if (line && line > 0) requestAnimationFrame(() => gotoLine(line));
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
      container.appendChild(row);
    }
  }
}
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

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
    dd.appendChild(menuRow('🗑', 'Очистить список', () => { localStorage.removeItem('lite.recents'); closeMenus(); }));
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
    <h2><span style="color:var(--green-bright)">▍</span>LiteEditor</h2>
    <div class="about-desc">
      Лёгкое десктоп-окружение для работы с агентами (Claude&nbsp;Code и&nbsp;т.п.).
      Главный гражданин — терминал; вивер кода и дерево файлов прячутся одной кнопкой
      (<b>Ctrl&nbsp;+&nbsp;\\</b>). У каждого открытого проекта свой живой терминал.<br><br>
      Сделано на Electron · xterm.js · node-pty · CodeMirror&nbsp;6.
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
  if (lastParent) parentI.value = lastParent;
  setTimeout(() => nameI.focus(), 30);
  m.querySelector('#cf-cancel').onclick = close;
  m.querySelector('#cf-pick').onclick = async () => {
    const d = await lite.pickDir();
    if (d) { parentI.value = d; lastParent = d; localStorage.setItem('lite.lastParent', d); }
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
    <div class="modal-actions"><button class="btn primary" id="st-ok">Готово</button></div>`);
  const notif = m.querySelector('#st-notif'); notif.checked = settings.notifications;
  const sound = m.querySelector('#st-sound'); sound.checked = settings.sound;
  const idle = m.querySelector('#st-idle'); idle.value = settings.idleMs;
  const font = m.querySelector('#st-font'); font.value = settings.fontSize;
  m.querySelector('#st-ok').onclick = () => {
    settings.notifications = notif.checked;
    settings.sound = sound.checked;
    settings.idleMs = Math.max(300, Math.min(6000, parseInt(idle.value, 10) || 1200));
    settings.fontSize = Math.max(9, Math.min(24, parseInt(font.value, 10) || 13));
    saveSettings(); applyFontSize(); close();
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
  acts.push({ label: 'Настройки…', run: showSettings });
  if (currentFile) acts.push({ label: 'Показать дифф файла', run: toggleDiff });
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

// ---------------------------------------------------------------- single-terminal toggle
function toggleSingle() {
  $('#app').classList.toggle('single');
  refitActiveTerminal();
}

// ---------------------------------------------------------------- init
function init() {
  makeEditor();
  applyLayout();
  initGutters();
  initWindowControls();
  initMenubar();

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
  $('#viewer-close').addEventListener('click', () => setViewerOpen(false));
  $('#tree-refresh').addEventListener('click', () => { const p = activeProject(); if (p) renderTree(p); });
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

  new ResizeObserver(() => refitActiveTerminal()).observe($('#terminal-pane'));

  applyFontSize();
  projects = loadProjectsFromDisk();
  renderProjects();
  if (projects.length) setActive(projects[0].id);
  else showActiveTerminal();

  checkProjectsExistence();
  window.addEventListener('focus', checkProjectsExistence); // re-check when returning to the app
}

function cycleProject(dir) {
  if (projects.length < 2) return;
  const i = projects.findIndex((p) => p.id === activeId);
  const next = projects[(i + dir + projects.length) % projects.length];
  if (next) setActive(next.id);
}

init();
