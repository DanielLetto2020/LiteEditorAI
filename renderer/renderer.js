// LiteEditor renderer — projects, per-project terminal, viewer, file tree,
// custom titlebar, menu, modals. Talks to the backend only via window.lite.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/atom-one-dark.css';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql';
import { showMinimap } from '@replit/codemirror-minimap';

const APP_VERSION = 'alpha v1.0.108';
const GUTTER = 5;
const SCRATCH_ID = '__scratch__'; // префикс id системных терминалов (домашняя папка), не привязаны к проектам
const isScratch = (id) => typeof id === 'string' && id.startsWith(SCRATCH_ID);

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
// ---------------------------------------------------------------- icon set
// One consistent line-icon family (Lucide-ish): 24-grid, currentColor stroke, rounded.
// Inner markup only; icon() wraps it. Fill-based glyphs set their own fill/stroke.
const ICONS = {
  star: '<path d="M12 3.2l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.48 6.8 19.21l.99-5.79-4.21-4.1 5.82-.85z"/>',
  'dots-v': '<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  'chevron-up': '<path d="M5 15l7-7 7 7"/>',
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17v3z"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  note: '<path d="M5.5 3.5h8L19 9v10.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13 3.5V9h5.5"/><path d="M8 13h7M8 16.5h4.5"/>',
  git: '<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><circle cx="17.5" cy="9" r="2.3"/><path d="M6.5 8.3v7.4M17.5 11.3c0 3.2-3.3 3.9-6.4 3.9"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2H18.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.3 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-3.6-3.6-6.7-9-6.7z"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1" fill="currentColor" stroke="none"/>',
  'arrow-right': '<path d="M4 12h15M13 6l6 6-6 6"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10M10 12h4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11.5a8 8 0 1 0-2.1 6.1"/><path d="M20 4.5v6h-6"/>',
  save: '<path d="M5.5 4.5h10L20 9v10.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M8 4.5v4.5h7M8 20v-5.5h8V20"/>',
  diff: '<path d="M12 4.5v7M8.5 8h7M6 19h12"/>',
  maximize: '<path d="M4 9V5.5a1 1 0 0 1 1-1H9M20 9V5.5a1 1 0 0 0-1-1H15M4 15v3.5a1 1 0 0 0 1 1H9M20 15v3.5a1 1 0 0 1-1 1H15"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l3 2.5-3 2.5M13 15h4"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M13 4.5v15"/>',
  eraser: '<path d="M15.5 5l3.5 3.5a1.8 1.8 0 0 1 0 2.6L12 18.5H7l-2.5-2.5a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0z"/><path d="M8.5 11.5l4 4M5 20.5h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7M6.5 7l.8 12.2a1 1 0 0 0 1 .95h7.4a1 1 0 0 0 1-.95L18.5 7"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="M20 20l-3.8-3.8"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  download: '<path d="M12 4v10.5M8 11l4 4 4-4M5 19.5h14"/>',
  upload: '<path d="M12 20V9.5M8 13l4-4 4 4M5 4.5h14"/>',
  sliders: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.1"/><circle cx="9" cy="16" r="2.1"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5.5a2 2 0 0 1 2-2H16"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  file: '<path d="M6 3.5h7L18.5 9v10.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M12.5 3.5V9H18"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>',
  clipboard: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><rect x="9" y="3" width="6" height="3.4" rx="1"/>',
  chat: '<path d="M4.5 5.5h15a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H9.5L5 19.5V16a1 1 0 0 1-1-1V6.5a1 1 0 0 1 .5-1z"/><path d="M8 9.5h8M8 12.5h5"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2.5 2.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  box: '<path d="M12 2.8l8.2 4.6v9.2L12 21.2 3.8 16.6V7.4z"/><path d="M3.8 7.4l8.2 4.6 8.2-4.6M12 12v9.2"/>',
  layers: '<path d="M12 3l8.5 4.5L12 12 3.5 7.5z"/><path d="M3.5 12L12 16.5 20.5 12M3.5 16.5L12 21l8.5-4.5"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6"/><path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3"/>',
  power: '<path d="M12 4v8"/><path d="M7.5 7.5a6.5 6.5 0 1 0 9 0"/>',
  flag: '<path d="M6 21V4.5h11l-2 4 2 4H6"/>',
};
function icon(name, size = 16) {
  return svgEl(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
}
// Button carrying a single icon (replaces the old emoji-in-textContent buttons).
function iconBtn(cls, name, title, size) {
  const b = el('button', cls);
  b.appendChild(icon(name, size));
  if (title) b.title = title;
  return b;
}
// Fill the static [data-icon] buttons defined in index.html (titlebar / pane toolbars).
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (node.querySelector('svg.ic')) return; // already done
    node.appendChild(icon(node.dataset.icon, +node.dataset.iconSize || 16));
  });
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
  for (const k of ['projects', 'layout', 'recents', 'settings']) {
    try { const raw = localStorage.getItem('lite.' + k); if (raw != null) { persist(k, JSON.parse(raw)); did = true; } } catch (_) {}
  }
  const lp = localStorage.getItem('lite.lastParent'); if (lp) persist('lastParent', lp);
  if (did) console.log('[LiteEditor] state migrated from localStorage → ~/.LiteEditor');
})();
// Stable id derived from the path, so categories/notes/favorites survive a rescan.
function projId(p) { let h = 5381; for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0; return 'p' + h.toString(36); }

// ---------------------------------------------------------------- settings (tiny on purpose)
const DEFAULT_SETTINGS = { notifications: true, sound: false, idleMs: 1200, fontSize: 13, workingDir: '', scanDirs: [], theme: 'neumorphism', onboarded: false, shell: '', minimap: true, notesSort: 'manual' };
function loadSettings() { return { ...DEFAULT_SETTINGS, ...(STORE.settings || {}) }; }
let settings = loadSettings();
function saveSettings() { persist('settings', settings); }

// ---------------------------------------------------------------- state
let projects = [];
let activeId = null;
const terms = new Map();          // sessionId -> { term, fit, search, container, projId, name, ... }
const tabsByProj = new Map();     // projId -> { sessions: [sessionId...], active: sessionId }
let sessionSeq = 0;
const projState = new Map(); // sessionId -> 'quiet' | 'busy' | 'waiting'
const missing = new Set();   // ids of projects whose folder no longer exists on disk
const expandedDirs = new Set(); // tree dir paths currently expanded (survives live refresh)
let gitFiles = {};           // active project: abs path -> git short status code
let noteCounts = STORE.noteCounts || {}; // project id -> number of notes (card badge)

// ---------------------------------------------------------------- OpenRouter chat state
// orCards: persisted list of {id, name, key, model, contextN}. Each renders as a card in
// its own «OpenRouter» section; clicking one shows the chat (instead of the terminal).
let orCards = Array.isArray(STORE.openrouter) ? STORE.openrouter : [];
let activeOrId = null;        // id of the OpenRouter card whose chat is shown (null → terminal mode)
const orChats = new Map();    // cardId -> { messages:[{role,content}], loaded, streaming, reqId }
const orModelsByKey = new Map(); // apiKey -> [{id,name}] (fetched once, cached for the session)
const orUsageByKey = new Map();  // apiKey -> {usage,limit,limit_remaining,label} | {loading} | {error}
const pendingOr = new Map();  // reqId -> { chunk, done, error } stream handlers
let orReqSeq = 0;
const OR_KEY = '__openrouter__'; // accordion/section key for the OpenRouter group
function saveOrCards() { persist('openrouter', orCards); }
function activeOrCard() { return orCards.find((c) => c.id === activeOrId) || null; }
function newOrId() { return 'or' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
function maskKey(k) { k = String(k || ''); return k.length <= 12 ? k : k.slice(0, 8) + '…' + k.slice(-4); }
function clamp(n, lo, hi) { n = parseInt(n, 10); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, n)); }
// Each card holds N sessions (separate conversations); a session = { id, name, messages }.
// Runtime st: { loaded, sessions:[], active:sessionId, streaming, reqId }. Persisted to
// orchats/<cardId>.json as { sessions, active } (legacy plain-array files migrate to one session).
function newSessId() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
function blankSession(name, contextN) { return { id: newSessId(), name: name || 'Сессия 1', messages: [], contextN: clamp(contextN || 10, 1, 100) }; }
function syncCtxInput() { const s = activeSession(); const i = $('#chat-ctx-input'); if (i) i.value = s ? clamp(s.contextN || 10, 1, 100) : 10; }
function getOrChat(id) {
  let st = orChats.get(id);
  if (!st) { st = { loaded: false, sessions: [], active: null, streaming: false, reqId: null }; orChats.set(id, st); }
  return st;
}
function ensureSession(st) {
  if (!st.sessions.length) { const s = blankSession('Сессия 1'); st.sessions.push(s); st.active = s.id; }
  if (!st.sessions.find((s) => s.id === st.active)) st.active = st.sessions[0].id;
  return st.sessions.find((s) => s.id === st.active);
}
function activeSession() {
  const c = activeOrCard(); if (!c) return null;
  const st = orChats.get(c.id); if (!st) return null;
  return st.sessions.find((s) => s.id === st.active) || null;
}
function saveOrHist(cardId) {
  const st = orChats.get(cardId); if (!st) return;
  lite.openrouter.histSet(cardId, { sessions: st.sessions, active: st.active });
}
// model cost/size formatting (pricing is USD per token → show per 1M tokens)
function fmtCtx(n) { n = parseInt(n, 10); if (!n) return ''; return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
function fmtPrice(p) {
  const v = parseFloat(p); if (!Number.isFinite(v)) return null;
  if (v === 0) return 'free';
  const per = v * 1e6;
  return '$' + (per >= 1 ? per.toFixed(2) : per.toPrecision(2));
}
function fmtUsd(v) { const n = Number(v); return '$' + (Number.isFinite(n) ? n : 0).toFixed(2); }
function usageText(key) {
  const u = orUsageByKey.get(key);
  if (!u || u.loading) return 'баланс: загрузка…';
  if (u.error) return 'баланс: —';
  const used = fmtUsd(u.usage);
  if (u.limit == null) return `израсходовано ${used} · лимит ∞`;
  return `${used} / ${fmtUsd(u.limit)}`;
}
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); }
function updateUsageDom(key) {
  const esc = cssEsc(key);
  document.querySelectorAll(`.or-usage-text[data-key="${esc}"]`).forEach((s) => { s.textContent = usageText(key); });
  const loading = (orUsageByKey.get(key) || {}).loading;
  document.querySelectorAll(`.or-refresh[data-key="${esc}"]`).forEach((b) => b.classList.toggle('spinning', !!loading));
}
async function fetchKeyInfo(key, force) {
  const cur = orUsageByKey.get(key);
  if (!force && cur) return;            // already have data (or loading) — auto-load runs once
  if (cur && cur.loading) return;       // a request is already in flight
  orUsageByKey.set(key, { loading: true });
  updateUsageDom(key);
  let r; try { r = await lite.openrouter.keyInfo(key); } catch (e) { r = { error: String(e) }; }
  if (r && !r.error) orUsageByKey.set(key, { usage: r.usage, limit: r.limit, limit_remaining: r.limit_remaining, label: r.label });
  else orUsageByKey.set(key, { error: (r && r.error) || 'ошибка' });
  updateUsageDom(key);
}
function modelMetaText(card) {
  const mm = card.modelMeta; if (!mm) return card.model || '';
  const parts = [card.model];
  const ctx = fmtCtx(mm.context); if (ctx) parts.push(ctx + ' ctx');
  const pin = fmtPrice(mm.pricing && mm.pricing.prompt); if (pin) parts.push('вход ' + pin + '/1M');
  const pout = fmtPrice(mm.pricing && mm.pricing.completion); if (pout) parts.push('выход ' + pout + '/1M');
  return parts.join(' · ');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Render assistant markdown to sanitized HTML (CSP already blocks scripts; we still strip
// dangerous tags / on*-handlers / javascript: urls as defense-in-depth).
function mdToSafeHtml(src) {
  let html;
  try { html = marked.parse(String(src || ''), { gfm: true, breaks: true }); } catch (_) { return escapeHtml(src); }
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((n) => {
    [...n.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) { n.removeAttribute(a.name); return; }
      if (name === 'href' || name === 'src') {
        // allowlist URL schemes: links → http(s)/mailto; img src → http(s)/data. Drop the rest.
        let proto = '';
        try { proto = new URL(a.value, location.href).protocol; } catch (_) { n.removeAttribute(a.name); return; }
        const ok = (name === 'src') ? ['http:', 'https:', 'data:'] : ['http:', 'https:', 'mailto:'];
        if (!ok.includes(proto)) n.removeAttribute(a.name);
      }
    });
  });
  return tpl.innerHTML;
}
function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const code = pre.querySelector('code');
    if (code) { // syntax highlight (highlight.js); keep the raw text for copy below
      const raw = code.textContent;
      const langCls = (code.className.match(/language-([\w+#-]+)/) || [])[1];
      try {
        const res = (langCls && hljs.getLanguage(langCls))
          ? hljs.highlight(raw, { language: langCls, ignoreIllegals: true })
          : hljs.highlightAuto(raw);
        code.innerHTML = res.value; // hljs returns sanitized HTML (no raw user HTML survives)
      } catch (_) {}
      code.classList.add('hljs');
    }
    const btn = el('button', 'code-copy', 'Копировать');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      lite.copyText(code ? code.textContent : pre.textContent); // textContent = original code, not highlighted markup
      btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1000);
    });
    pre.appendChild(btn);
  });
}
function renderMsgContent(bubble, role, text) {
  bubble.classList.remove('err');
  if (role === 'assistant') { bubble.innerHTML = mdToSafeHtml(text); enhanceCodeBlocks(bubble); }
  else bubble.textContent = text || '';
}
// Fullscreen image viewer with a download button (for generated/markdown images).
function openImageLightbox(src) {
  const ov = el('div', 'img-lightbox');
  const img = el('img', 'img-lb-img'); img.src = src;
  const bar = el('div', 'img-lb-bar');
  const dl = el('button', 'btn primary', 'Скачать');
  dl.addEventListener('click', (e) => { e.stopPropagation(); downloadImage(src); });
  const cl = el('button', 'btn', 'Закрыть');
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  cl.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  bar.appendChild(dl); bar.appendChild(cl);
  ov.appendChild(img); ov.appendChild(bar);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); }); // click backdrop to dismiss
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}
function downloadImage(src) {
  try {
    const a = document.createElement('a');
    a.href = src;
    const ext = (src.match(/^data:image\/(\w+)/) || [])[1] || 'png';
    a.download = 'openrouter-image-' + Date.now() + '.' + ext;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (_) {}
}

// ---------------------------------------------------------------- notes auto-queue
// Per-project queue that fires notes one-by-one: dispatch a note (text + Enter, so it
// actually submits — unlike the manual «В терминал»), then wait for the agent to finish
// its turn. The advance trigger is busy→waiting (янтарный): the agent is alive and back
// to waiting on your input. Runtime-only — survives the modal closing, not an app restart.
const queues = new Map(); // id -> { id, items:[{noteId,text}], running, pos, awaitingBusy, armed, onChange }
function getQueue(id) {
  let q = queues.get(id);
  if (!q) { q = { id, items: [], running: false, pos: -1, awaitingBusy: false, armed: false, onChange: null }; queues.set(id, q); }
  return q;
}
function queueBadgeText(q) {
  if (!q || !q.items.length) return '';
  if (!q.running) return `☰ ${q.items.length}`;
  return q.armed ? '▶ ждёт' : `▶ ${Math.min(q.pos + 1, q.items.length)}/${q.items.length}`;
}
function updateQueueBadge(id) {
  const q = queues.get(id);
  const txt = queueBadgeText(q);
  document.querySelectorAll(`.card-qbadge[data-id="${id}"]`).forEach((b) => {
    b.textContent = txt;
    b.classList.toggle('show', !!txt);
    b.classList.toggle('running', !!(q && q.running));
    b.classList.toggle('armed', !!(q && q.armed));
  });
}
// Notify any open modal + refresh the card badge after a queue state change.
function queueChanged(q) { try { q.onChange && q.onChange(); } catch (_) {} updateQueueBadge(q.id); }

function queueDispatchNext(id) {
  const q = queues.get(id);
  if (!q || !q.running) return;
  q.armed = false;
  q.pos += 1;
  if (q.pos >= q.items.length) { // reached the end → done
    q.running = false; q.pos = q.items.length; q.awaitingBusy = false;
    queueChanged(q);
    const p = projects.find((x) => x.id === id);
    toast(`✓ Очередь выполнена${p ? ' — ' + p.name : ''}`);
    return;
  }
  const proj = projects.find((x) => x.id === id);
  if (!proj) { q.running = false; queueChanged(q); return; }
  ensureProjectTabs(proj);
  const sid = (tabsByProj.get(id) || {}).active;
  q.sessionId = sid; // remember which tab the queue drives, so only its activity advances it
  lite.pty.write(sid, (q.items[q.pos].text || '') + '\r'); // '\r' = Enter → submits the prompt
  q.awaitingBusy = true; // ignore «waiting» until the agent actually starts working on this note
  queueChanged(q);
}
function queueStart(id) {
  const q = getQueue(id);
  if (!q.items.length) return;
  const proj = projects.find((x) => x.id === id);
  if (!proj) return;
  ensureProjectTabs(proj);
  setActive(id); // bring this project's terminal to the front when the run begins
  q.running = true; q.pos = -1; q.awaitingBusy = false; q.armed = false;
  queueDispatchNext(id); // first note goes immediately; the rest wait for «▶ Дальше»
}
function queueStop(id) {
  const q = queues.get(id);
  if (!q) return;
  q.running = false; q.awaitingBusy = false; q.armed = false;
  queueChanged(q);
}
// User-confirmed advance (semi-auto): «▶ Дальше» button, the armed notification's
// click, or the Ctrl+Shift+Enter hotkey all route here.
function queueAdvance(id) {
  const q = queues.get(id);
  if (!q || !q.running) return;
  queueDispatchNext(id);
}
// Called from settleProject. Amber (waiting) is ambiguous — the agent could be done OR
// asking a question / awaiting a permission. We can't tell from process state, so we DON'T
// auto-send: we «arm» the queue (surface «▶ Дальше» + a notification) and let the user decide.
function queueOnSettled(id, state) {
  const q = queues.get(id);
  if (!q || !q.running || q.awaitingBusy || q.armed) return;
  if (state !== 'waiting') return;
  // Complete when the last note's turn ended — OR when the queue was emptied mid-run.
  // The length check is essential: without it an empty q.items makes the comparison
  // `q.pos >= -1` (always true), so the queue would "complete" having sent nothing.
  if (!q.items.length || q.pos >= q.items.length - 1) {
    q.running = false; q.pos = q.items.length; q.armed = false;
    queueChanged(q);
    const p = projects.find((x) => x.id === id);
    toast(`✓ Очередь выполнена${p ? ' — ' + p.name : ''}`);
    return;
  }
  q.armed = true;
  queueChanged(q);
  queueNotifyArmed(id);
}
let lastQueueNotifyAt = 0;
function queueNotifyArmed(id) {
  const q = queues.get(id);
  const p = projects.find((x) => x.id === id);
  if (!q || !p) return;
  const next = Math.min(q.pos + 2, q.items.length); // 1-based number of the note «▶ Дальше» will send
  toast(`▶ ${p.name}: агент ждёт. Открой «Очередь» и нажми «Дальше» — заметка ${next}/${q.items.length}.`);
  if (!settings.notifications || Date.now() - lastQueueNotifyAt < 1200) return;
  if (id === activeId && document.hasFocus()) return; // foreground: toast + armed button is enough
  lastQueueNotifyAt = Date.now();
  try {
    const n = new Notification(`▶ ${p.name} — очередь ждёт`, { body: `Готов отправить заметку ${next} из ${q.items.length}. Клик — отправить.`, silent: !settings.sound, tag: 'lite-q-' + id });
    n.onclick = () => { lite.win.show(); setActive(id); queueAdvance(id); };
  } catch (_) {}
}
let viewerOpen = false;
let gitOpen = false;         // Git-модуль справа открыт (показывает активный проект)
let dockerOpen = false;      // модуль контейнеров (docker/podman) справа открыт
let dbOpen = false;          // модуль баз данных справа открыт
let scratchOpen = false;     // системный терминал справа открыт
const scratchTerms = new Map(); // scratchId -> { term, fit, search, container, name }
let scratchSessions = [];        // ordered scratch ids (tabs)
let scratchActiveId = null;
let scratchSeq = 0;
// RemoteHost-модуль (SSH-сессии к серверам): список профилей + живые сессии-вкладки
let rhOpen = false;
let rhConnsList = [], rhSecure = true;
let rhView = 'list';             // 'list' (менеджер подключений) | 'session' (открытый терминал)
const rhTerms = new Map();       // sessionId -> { term, fit, search, container, name, connId }
let rhSessions = [];             // ordered session ids (вкладки)
let rhActiveSession = null;
let rhSeq = 0, rhRenderSeq = 0;
let rhFiles = null;              // активный браузер файлов: { connId, name, type, path, entries, loading, file, error }
let rhUi = (STORE.rhUi && typeof STORE.rhUi === 'object') ? STORE.rhUi : {}; // { catCollapsed }
let currentFile = null;
let dirty = false;
let diffMode = false;        // viewer showing a git diff instead of the file
let previewMode = false;     // viewer showing a rendered preview (md/image/html) instead of source
let editor = null;
let loadingDoc = false;
const langComp = new Compartment();

const DEFAULT_LAYOUT = { sidebar: 240, viewer: 520, tree: 240, scratch: 420, git: 360, docker: 460, db: 560, rh: 520 };
let layout = loadLayout();
let lastParent = STORE.lastParent || '';

const TERM_THEME = {
  background: '#0d1116', foreground: '#cdd6e0', cursor: '#34d399',
  selectionBackground: '#1f3a4d',
  black: '#0d1116', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
};
// ---------------------------------------------------------------- themes (a curated few)
// Theme registry. The CSS does the heavy lifting via body[data-theme] (token contract
// in styles.css); here we carry the human label + per-theme terminal (xterm) colours.
// To add a theme: add a block in styles.css AND an entry here. Default = neumorphism.
const DEFAULT_THEME = 'neumorphism';
const THEMES = {
  neumorphism: { label: 'Неоморфизм', term: { background: '#161a20', foreground: '#cfd4db', cursor: '#34d399', selectionBackground: '#1f3a30' } },
  glass:       { label: 'Стекло',     term: { background: '#0b0f16', foreground: '#dbe5ee', cursor: '#5eead4', selectionBackground: '#13443c' } },
  material:    { label: 'Material',   term: { background: '#121212', foreground: '#e0e0e0', cursor: '#26a69a', selectionBackground: '#004d40' } },
  catppuccin:  { label: 'Catppuccin', term: { background: '#181825', foreground: '#cdd6f4', cursor: '#a6e3a1', selectionBackground: '#333b54' } },
  gruvbox:     { label: 'Gruvbox',    term: { background: '#282828', foreground: '#ebdbb2', cursor: '#fabd2f', selectionBackground: '#504945' } },
  aurora:      { label: 'Aurora',     term: { background: '#0a0f14', foreground: '#dbe7f0', cursor: '#2dd4bf', selectionBackground: '#0f4a44' } },
};
function termTheme() {
  const t = THEMES[settings.theme] || THEMES[DEFAULT_THEME];
  return { ...TERM_THEME, ...t.term };
}
function applyTheme() {
  const name = THEMES[settings.theme] ? settings.theme : DEFAULT_THEME;
  document.body.dataset.theme = name; // always set; index.html ships data-theme too so there's no flash
  for (const rec of terms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  for (const rec of scratchTerms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  if (dockerExecTerm) { try { dockerExecTerm.options.theme = termTheme(); } catch (_) {} }
}

const activeProject = () => projects.find((p) => p.id === activeId);

// ---------------------------------------------------------------- persistence
function saveProjects() { persist('projects', projects); }
function loadProjectsFromDisk() { return Array.isArray(STORE.projects) ? STORE.projects : []; }
function loadLayout() { return { ...DEFAULT_LAYOUT, ...(STORE.layout || {}) }; }
function saveLayout() { persist('layout', layout); }
// Whether the viewer / system terminal panes are open — part of the backed-up state,
// restored on startup (and on import) so the window reopens the way it was left.
function saveUiState() { persist('uiState', { viewerOpen, scratchOpen, gitOpen, dockerOpen, dbOpen, rhOpen }); }
function applyLayout() {
  $('#sidebar').style.flexBasis = layout.sidebar + 'px';
  $('#viewer-pane').style.flexBasis = layout.viewer + 'px';
  $('#tree-pane').style.flexBasis = layout.tree + 'px';
  $('#scratch-pane').style.flexBasis = layout.scratch + 'px';
  $('#git-pane').style.flexBasis = layout.git + 'px';
  $('#docker-pane').style.flexBasis = layout.docker + 'px';
  $('#db-pane').style.flexBasis = layout.db + 'px';
  $('#rh-pane').style.flexBasis = layout.rh + 'px';
}
function loadRecents() { return Array.isArray(STORE.recents) ? STORE.recents : []; }
function pushRecent(p) {
  const r = loadRecents().filter((x) => x.path !== p.path);
  r.unshift({ path: p.path, name: p.name });
  persist('recents', r.slice(0, 30));
}
// ---------------------------------------------------------------- projects column
const UNCATEGORIZED = 'Все';
const FAV_KEY = '__fav';
const ARCHIVE = 'Архив'; // спец-категория: всегда последняя, без перестановки стрелками, свёрнута по дефолту
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
  const hasArchive = loadCategories().includes(ARCHIVE);
  const cats = loadCategories().filter((c) => c !== ARCHIVE); // Архив раскладывается отдельно — всегда в самый конец
  const keys = [FAV_KEY, ...cats, UNCATEGORIZED];
  const stored = loadSectionOrder();
  let order;
  if (!stored) order = keys.slice();
  else {
    order = stored.filter((k) => keys.includes(k) && k !== ARCHIVE);
    for (const k of keys) {
      if (order.includes(k)) continue;
      if (k === UNCATEGORIZED) { order.push(k); continue; }
      const at = order.indexOf(UNCATEGORIZED);
      if (at >= 0) order.splice(at, 0, k); else order.push(k);
    }
  }
  if (hasArchive) order.push(ARCHIVE); // всегда последняя, позиция из стора игнорируется
  return order;
}
// Sections that actually render now, in display order (★ Избранное only when non-empty).
function buildSections() {
  const cats = loadCategories();
  const favs = projects.filter((p) => p.favorite);
  return effectiveOrder().map((key) => {
    if (key === FAV_KEY) return favs.length ? { key, label: 'Избранное', list: favs, pinned: true } : null;
    if (key === UNCATEGORIZED) return { key, label: UNCATEGORIZED, pinned: false, list: projects.filter((p) => !p.favorite && !cats.includes(p.category)) };
    if (key === ARCHIVE) { const list = projects.filter((p) => !p.favorite && p.category === ARCHIVE); return list.length ? { key, label: 'Архив', list, pinned: false } : null; }
    return { key, label: key, pinned: false, list: projects.filter((p) => !p.favorite && p.category === key) };
  }).filter(Boolean);
}
function moveSection(key, dir) {
  if (key === ARCHIVE) return;            // Архив зафиксирован последним
  const visible = buildSections().map((s) => s.key);
  const target = visible[visible.indexOf(key) + dir];
  if (target === undefined || target === ARCHIVE) return; // нельзя уйти ниже Архива
  const order = effectiveOrder();
  const a = order.indexOf(key), b = order.indexOf(target);
  [order[a], order[b]] = [order[b], order[a]];
  saveSectionOrder(order); renderProjects();
}

function renderProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  const sections = buildSections();
  sections.forEach((s, i) => box.appendChild(renderSection(s, i, sections)));
  box.appendChild(renderOrSection()); // always shown (even with 0 keys) — own «интеграции» strip
  renderMiniRail();
}
// OpenRouter section — fixed group (no reorder arrows), like a special category.
// Cards here aren't real projects: deletion lives only in the OpenRouter modal.
function renderOrSection() {
  const sec = el('div', 'pgroup or-group');
  sec.appendChild(el('div', 'or-divider', 'ИНТЕГРАЦИИ')); // visual strip separating it from project categories
  const collapsed = isCollapsed(OR_KEY);
  const head = el('div', 'pgroup-head');
  const chev = el('span', 'pgroup-chev');
  chev.appendChild(icon(collapsed ? 'chevron-right' : 'chevron-down', 15));
  head.appendChild(chev);
  head.appendChild(el('span', 'pgroup-name', 'OpenRouter'));
  head.appendChild(el('span', 'pgroup-count', String(orCards.length)));
  const tools = el('div', 'pgroup-tools');
  const cog = iconBtn('pgroup-arrow', 'sliders', 'Управление ключами');
  cog.style.opacity = '1';
  cog.addEventListener('click', (e) => { e.stopPropagation(); showOpenRouter(); });
  tools.appendChild(cog);
  head.appendChild(tools);
  const body = el('div', 'pgroup-body');
  if (collapsed) body.style.display = 'none';
  head.addEventListener('click', () => {
    const now = !isCollapsed(OR_KEY); setCollapsed(OR_KEY, now);
    body.style.display = now ? 'none' : 'block';
    chev.replaceChildren(icon(now ? 'chevron-right' : 'chevron-down', 15));
  });
  for (const c of orCards) body.appendChild(makeOrCard(c));
  sec.appendChild(head); sec.appendChild(body);
  return sec;
}
function makeOrCard(c) {
  const card = el('div', 'card or-card');
  card.dataset.orid = c.id;
  if (c.id === activeOrId) card.classList.add('active');
  const head = el('div', 'card-head');
  const ind = el('span', 'or-ind');
  ind.appendChild(icon('chat', 15));
  const title = el('span', 'card-title', c.name);
  title.title = c.name;
  head.appendChild(ind); head.appendChild(title); // no kebab — управление через ⚙ в шапке секции
  card.appendChild(head);
  const sub = el('div', 'or-key-row');
  sub.appendChild(icon('key', 12));
  sub.appendChild(el('span', 'or-key', maskKey(c.key)));
  if (c.model) { const mm = el('span', 'or-model', c.model); mm.title = c.model; sub.appendChild(mm); }
  card.appendChild(sub);
  // balance row: spent / limit + refresh
  const usage = el('div', 'or-usage');
  const uText = el('span', 'or-usage-text', usageText(c.key)); uText.dataset.key = c.key;
  const refresh = iconBtn('or-refresh', 'refresh', 'Обновить баланс ключа', 13); refresh.dataset.key = c.key;
  if ((orUsageByKey.get(c.key) || {}).loading) refresh.classList.add('spinning');
  refresh.addEventListener('click', (e) => { e.stopPropagation(); fetchKeyInfo(c.key, true); });
  usage.appendChild(uText); usage.appendChild(refresh);
  card.appendChild(usage);
  if (!orUsageByKey.has(c.key)) fetchKeyInfo(c.key, false); // lazy auto-load once per key
  card.addEventListener('click', () => openChat(c.id));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showOpenRouter(); });
  return card;
}
function renderSection(s, index, sections) {
  const total = sections.length;
  const { label, key, list, pinned } = s;
  const sec = el('div', 'pgroup' + (pinned ? ' pinned' : ''));
  const collapsed = isCollapsed(key);
  const head = el('div', 'pgroup-head');
  const chev = el('span', 'pgroup-chev');
  chev.appendChild(icon(collapsed ? 'chevron-right' : 'chevron-down', 15));
  head.appendChild(chev);
  head.appendChild(el('span', 'pgroup-name', label));
  head.appendChild(el('span', 'pgroup-count', String(list.length)));
  const tools = el('div', 'pgroup-tools');
  const isCustomCat = key !== FAV_KEY && key !== UNCATEGORIZED && key !== ARCHIVE;
  if (isCustomCat) { // видимая кнопка переименования (плюс ПКМ-меню)
    const ren = iconBtn('pgroup-arrow', 'pencil', 'Переименовать категорию');
    ren.addEventListener('click', (e) => { e.stopPropagation(); renameCategory(key); });
    tools.appendChild(ren);
  }
  const nextIsArchive = sections[index + 1] && sections[index + 1].key === ARCHIVE;
  const up = iconBtn('pgroup-arrow', 'chevron-up', 'Выше'); up.disabled = index === 0 || key === ARCHIVE;
  const down = iconBtn('pgroup-arrow', 'chevron-down', 'Ниже'); down.disabled = index === total - 1 || key === ARCHIVE || nextIsArchive;
  up.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, -1); });
  down.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, +1); });
  tools.appendChild(up); tools.appendChild(down);
  head.appendChild(tools);
  const body = el('div', 'pgroup-body');
  if (collapsed) body.style.display = 'none';
  head.addEventListener('click', () => {
    const now = !isCollapsed(key); setCollapsed(key, now);
    body.style.display = now ? 'none' : 'block';
    chev.replaceChildren(icon(now ? 'chevron-right' : 'chevron-down', 15));
  });
  if (key !== FAV_KEY && key !== UNCATEGORIZED && key !== ARCHIVE) // custom categories can be renamed/deleted (Архив — нет)
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); showCategoryMenu(e.clientX, e.clientY, key); });
  for (const p of list) body.appendChild(makeCard(p));
  sec.appendChild(head); sec.appendChild(body);
  return sec;
}
function makeCard(p) {
  const card = el('div', 'card');
  card.dataset.id = p.id;
  if (p.id === activeId && activeOrId === null) card.classList.add('active');
  if (missing.has(p.id)) card.classList.add('missing');
  if (p.accent) { card.classList.add('accented'); card.style.setProperty('--card-accent', p.accent); } // весь бордер + усиленная левая полоса

  const head = el('div', 'card-head');
  const ind = el('span', 'pind ' + projAggState(p.id));
  ind.dataset.id = p.id;
  ind.title = 'Спиннер — работает · янтарный — ждёт ответа · точка — готов';
  const title = el('span', 'card-title', p.name);
  title.title = p.path;
  const star = iconBtn('card-star' + (p.favorite ? ' on' : ''), 'star', p.favorite ? 'Убрать из избранного' : 'В избранное', 15);
  star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(p.id); });
  // module toggles (бывший футер) — компактные иконки сразу после «избранного», чтобы карточка была ниже
  const openViewer = iconBtn('card-act' + (p.id === activeId && viewerOpen ? ' on' : ''), 'eye', 'Открыть/закрыть вивер', 15);
  openViewer.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeId === p.id && viewerOpen) setViewerOpen(false);
    else { setActive(p.id); setViewerOpen(true); }
  });
  const notesBtn = iconBtn('card-act', 'note', 'Заметки', 15);
  const nc = noteCounts[p.id] || 0;
  if (nc) notesBtn.appendChild(el('span', 'act-badge', String(nc)));
  notesBtn.addEventListener('click', (e) => { e.stopPropagation(); showNotes(p); });
  const gitBtn = iconBtn('card-act' + (p.id === activeId && gitOpen ? ' on' : ''), 'git', 'Git — ветки, изменения, коммиты', 15);
  gitBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeId === p.id && gitOpen) setGitOpen(false);
    else openGitForProject(p.id);
  });
  const kebab = iconBtn('card-kebab', 'dots-v', 'Меню проекта', 18);
  kebab.addEventListener('click', (e) => { e.stopPropagation(); showCardMenu(e.clientX, e.clientY, p); });
  // авто-очередь заметок: бейдж в той же строке (виден только когда в очереди что-то есть)
  const qb = queues.get(p.id);
  const qtxt = queueBadgeText(qb);
  const qbadge = el('button', 'card-qbadge' + (qtxt ? ' show' : '') + (qb && qb.running ? ' running' : ''), qtxt);
  qbadge.dataset.id = p.id;
  qbadge.title = 'Авто-очередь заметок';
  qbadge.addEventListener('click', (e) => { e.stopPropagation(); showNotes(p); });
  const acts = el('div', 'card-acts');
  acts.append(qbadge, star, openViewer, notesBtn, gitBtn, kebab);
  // в покое — свёрнутая стрелка; по наведению на карточку кнопки выезжают, стрелка прячется
  const reveal = el('span', 'card-reveal');
  reveal.appendChild(icon('chevron-left', 15));
  reveal.title = 'Действия проекта';
  const tail = el('div', 'card-tail');
  tail.append(reveal, acts);
  head.append(ind, title, tail);
  card.appendChild(head);

  // путь не дублируем на карточке — он в тултипе имени и в ⋮-меню («Копировать путь»)
  if (missing.has(p.id)) {
    const w = el('div', 'card-missing'); w.appendChild(icon('warning', 13)); w.appendChild(el('span', null, 'папка удалена — закрой проект'));
    card.appendChild(w);
  }

  card.addEventListener('click', () => focusProject(p.id));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e.clientX, e.clientY, p); });
  return card;
}
// Switch from chat mode back to a project's terminal (or just select the project).
function focusProject(id) {
  if (activeOrId !== null) {
    activeOrId = null;
    if (id === activeId) { renderProjects(); showActiveTerminal(); if (viewerOpen) refreshViewerForActive(); return; }
  }
  setActive(id);
}

// ---------------------------------------------------------------- OpenRouter chat UI
// Open an OpenRouter card's chat in place of the terminal. Guards unsaved viewer edits
// (same as switching projects), loads the persisted history once, and shows the pane.
function openChat(id) {
  const card = orCards.find((c) => c.id === id);
  if (!card) return;
  guardDirty(async () => {
    // Opening the OpenRouter chat hides project-specific right modules — chat takes over.
    // Вивер оставляем открытым: он покажет заглушку «нет выбранного проекта» (см. refreshViewerForActive).
    if (gitOpen) setGitOpen(false);
    if (dockerOpen) setDockerOpen(false);
    if (dbOpen) setDbOpen(false);
    if (scratchOpen) setScratchOpen(false);
    activeOrId = id;
    const st = getOrChat(id);
    renderProjects();        // refresh card highlights (active OR card, deselect projects)
    if (viewerOpen) refreshViewerForActive(); // chat mode → вивер показывает заглушку
    showActiveTerminal();    // single source of pane visibility → reveals #chat-pane
    $('#chat-title').textContent = card.name;
    $('#chat-model-btn').textContent = card.model || 'Выбрать модель…';
    $('#chat-model-btn').title = card.model ? modelMetaText(card) : '';
    $('#chat-model-pop').classList.add('hidden');
    $('#chat-session-pop').classList.add('hidden');
    setChatSending(st.streaming);
    if (!st.loaded) { // pull history from disk on first open of this card
      let doc = null;
      try { doc = await lite.openrouter.histGet(id); } catch (_) {}
      if (Array.isArray(doc)) st.sessions = doc.length ? [{ id: newSessId(), name: 'Сессия 1', messages: doc }] : []; // legacy
      else if (doc && Array.isArray(doc.sessions)) { st.sessions = doc.sessions; st.active = doc.active; }
      // backfill per-session contextN (older data kept it per-card) so the setting binds to the session
      for (const s of st.sessions) if (s.contextN == null) s.contextN = clamp(card.contextN || 10, 1, 100);
      st.loaded = true;
    }
    if (activeOrId !== id) return; // user switched away during the async load
    ensureSession(st);
    updateSessionBtn();
    syncCtxInput();
    renderChatLog();
    setTimeout(() => { const ta = $('#chat-input'); if (ta) ta.focus(); }, 30);
  });
}
function updateSessionBtn() { const s = activeSession(); const b = $('#chat-session-btn'); if (b) b.textContent = '☰ ' + (s ? s.name : 'Сессия'); }
function renderChatLog() {
  const log = $('#chat-log');
  log.innerHTML = '';
  const sess = activeSession();
  if (!sess || !sess.messages.length) {
    log.appendChild(el('div', 'chat-empty', 'Выбери модель вверху и напиши первое сообщение.'));
    return;
  }
  for (const msg of sess.messages) appendChatMsg(msg.role, msg.content);
  scrollChat();
}
function appendChatMsg(role, text, streaming) {
  const log = $('#chat-log');
  const empty = log.querySelector('.chat-empty'); if (empty) empty.remove();
  const wrap = el('div', 'chat-msg ' + (role === 'user' ? 'me' : 'bot'));
  wrap.dataset.raw = text || ''; // raw source (markdown for assistant) — what the copy button yields
  // sticky header so the copy button stays in view while a long message scrolls
  const head = el('div', 'chat-msg-head');
  head.appendChild(el('span', 'msg-role', role === 'user' ? 'Вы' : 'Ассистент'));
  const copy = iconBtn('msg-copy', 'copy', 'Копировать сообщение', 15);
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    lite.copyText(wrap.dataset.raw || '');
    copy.replaceChildren(icon('check', 15)); setTimeout(() => copy.replaceChildren(icon('copy', 15)), 900);
  });
  head.appendChild(copy);
  const bubble = el('div', 'chat-bubble');
  if (streaming) bubble.textContent = text || ''; // plain while streaming; finalized to markdown on done
  else renderMsgContent(bubble, role, text);
  wrap.appendChild(head);
  wrap.appendChild(bubble);
  log.appendChild(wrap);
  scrollChat();
  return wrap;
}
function scrollChat() { const log = $('#chat-log'); if (log) log.scrollTop = log.scrollHeight; }
function setChatSending(on) {
  const btn = $('#chat-send'); if (!btn) return;
  btn.textContent = on ? '■' : '▶';
  btn.classList.toggle('sending', on);
  btn.title = on ? 'Остановить' : 'Отправить';
}
function onSendClick() {
  const card = activeOrCard(); if (!card) return;
  const st = orChats.get(card.id);
  if (st && st.streaming) { if (st.reqId) lite.openrouter.chatAbort(st.reqId); return; }
  sendChat();
}
function sendChat() {
  const card = activeOrCard(); if (!card) return;
  if (!card.model) { toast('Сначала выбери модель вверху'); return; }
  const ta = $('#chat-input');
  const text = ta.value.trim();
  if (!text) return;
  const st = getOrChat(card.id);
  if (st.streaming) return;
  const sess = ensureSession(st);
  ta.value = ''; ta.style.height = 'auto';
  sess.messages.push({ role: 'user', content: text });
  appendChatMsg('user', text);
  saveOrHist(card.id);
  const n = clamp(sess.contextN || 10, 1, 100); // context window is per-session
  const ctx = sess.messages.slice(-n).map((m) => ({ role: m.role, content: m.content }));
  const wrap = appendChatMsg('assistant', '…', true);
  const bubble = wrap.querySelector('.chat-bubble');
  const reqId = 'orq' + (++orReqSeq);
  st.streaming = true; st.reqId = reqId;
  setChatSending(true);
  let acc = '';
  let rich = false; // once an image arrives, render markdown live (don't dump the data: URL as text)
  const finish = (errMsg) => {
    pendingOr.delete(reqId);
    st.streaming = false; st.reqId = null;
    wrap.dataset.raw = acc;
    renderMsgContent(bubble, 'assistant', acc || (errMsg ? '' : '(пустой ответ)'));
    if (errMsg) { bubble.classList.add('err'); bubble.appendChild(el('div', 'chat-err', '⚠ Ошибка: ' + errMsg)); }
    if (acc) { sess.messages.push({ role: 'assistant', content: acc }); saveOrHist(card.id); }
    if (activeOrId === card.id) setChatSending(false);
    scrollChat();
  };
  pendingOr.set(reqId, {
    chunk: (d) => {
      acc += d;
      if (!rich && d.includes('![image](')) rich = true;
      if (rich) renderMsgContent(bubble, 'assistant', acc); else bubble.textContent = acc;
      scrollChat();
    },
    done: () => finish(null),
    error: (msg) => finish(msg),
  });
  lite.openrouter.chatStart({ reqId, key: card.key, model: card.model, messages: ctx });
}
// ---------------------------------------------------------------- chat sessions (per key)
function toggleSessionPop() {
  const pop = $('#chat-session-pop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  renderSessionList();
  pop.classList.remove('hidden');
}
function renderSessionList() {
  const pop = $('#chat-session-pop'); pop.innerHTML = '';
  const card = activeOrCard(); if (!card) return;
  const st = getOrChat(card.id);
  const add = el('div', 'sess-row sess-add');
  add.appendChild(icon('plus', 14)); add.appendChild(el('span', null, 'Новая сессия'));
  add.addEventListener('click', () => newSession(card.id));
  pop.appendChild(add);
  for (const s of st.sessions) {
    const row = el('div', 'sess-row' + (s.id === st.active ? ' on' : ''));
    row.appendChild(el('span', 'sess-name', s.name));
    const ren = iconBtn('sess-mini', 'pencil', 'Переименовать', 12);
    ren.addEventListener('click', (e) => { e.stopPropagation(); renameSession(card.id, s.id); });
    row.appendChild(ren);
    if (st.sessions.length > 1) {
      const del = iconBtn('sess-mini', 'trash', 'Удалить сессию', 12);
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(card.id, s.id); });
      row.appendChild(del);
    }
    row.addEventListener('click', () => switchSession(card.id, s.id));
    pop.appendChild(row);
  }
}
function newSession(cardId) {
  const st = getOrChat(cardId);
  const cur = st.sessions.find((s) => s.id === st.active); // inherit the current session's context size
  const s = blankSession('Сессия ' + (st.sessions.length + 1), cur ? cur.contextN : 10);
  st.sessions.push(s); st.active = s.id; saveOrHist(cardId);
  $('#chat-session-pop').classList.add('hidden');
  updateSessionBtn(); syncCtxInput(); renderChatLog();
  setTimeout(() => { const ta = $('#chat-input'); if (ta) ta.focus(); }, 20);
}
function switchSession(cardId, sid) {
  const st = getOrChat(cardId); if (!st.sessions.find((s) => s.id === sid)) return;
  st.active = sid; saveOrHist(cardId);
  $('#chat-session-pop').classList.add('hidden');
  updateSessionBtn(); syncCtxInput(); renderChatLog();
}
function renameSession(cardId, sid) {
  const st = getOrChat(cardId); const s = st.sessions.find((x) => x.id === sid); if (!s) return;
  showPrompt('Переименовать сессию', 'Название', s.name, (v) => {
    const t = (v || '').trim(); if (!t) return;
    s.name = t; saveOrHist(cardId); renderSessionList(); updateSessionBtn();
  });
}
function deleteSession(cardId, sid) {
  const st = getOrChat(cardId); if (st.sessions.length <= 1) return; // keep ≥1
  showConfirm('Удалить сессию?', 'История этой сессии будет удалена без возможности восстановления.', 'Удалить', () => {
    const wasActive = st.active === sid;
    st.sessions = st.sessions.filter((s) => s.id !== sid);
    if (wasActive) st.active = st.sessions[0].id;
    saveOrHist(cardId);
    renderSessionList(); updateSessionBtn();
    if (wasActive) renderChatLog();
  });
}
// Model picker dropdown — fetched once per key, filtered by the search box.
async function toggleModelPop() {
  const pop = $('#chat-model-pop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  const card = activeOrCard(); if (!card) return;
  pop.classList.remove('hidden');
  const search = $('#chat-model-search');
  search.value = ''; search.focus();
  const list = $('#chat-model-list');
  list.innerHTML = '<div class="chat-model-loading">Загрузка моделей…</div>';
  let models = orModelsByKey.get(card.key);
  if (!models) {
    const r = await lite.openrouter.models(card.key);
    if (r.error) { list.innerHTML = ''; list.appendChild(el('div', 'chat-model-loading', 'Ошибка: ' + r.error)); return; }
    models = r.models || []; orModelsByKey.set(card.key, models);
  }
  if (activeOrId !== card.id || pop.classList.contains('hidden')) return;
  renderModelList('');
}
function renderModelList(filter) {
  const card = activeOrCard(); if (!card) return;
  const list = $('#chat-model-list');
  const models = orModelsByKey.get(card.key) || [];
  const q = (filter || '').toLowerCase();
  const shown = (q ? models.filter((m) => (m.id + ' ' + m.name).toLowerCase().includes(q)) : models).slice(0, 300);
  list.innerHTML = '';
  if (!shown.length) { list.appendChild(el('div', 'chat-model-loading', 'Ничего не найдено')); return; }
  for (const m of shown) {
    const row = el('div', 'chat-model-row' + (m.id === card.model ? ' on' : ''));
    row.appendChild(el('div', 'cm-name', m.name));
    row.appendChild(el('div', 'cm-id', m.id));
    const meta = el('div', 'cm-meta');
    const ctx = fmtCtx(m.context); if (ctx) meta.appendChild(el('span', 'cm-chip', ctx + ' ctx'));
    const pin = fmtPrice(m.pricing && m.pricing.prompt); if (pin) meta.appendChild(el('span', 'cm-chip', 'вход ' + pin + '/1M'));
    const pout = fmtPrice(m.pricing && m.pricing.completion); if (pout) meta.appendChild(el('span', 'cm-chip', 'выход ' + pout + '/1M'));
    if (meta.childNodes.length) row.appendChild(meta);
    row.addEventListener('click', () => {
      card.model = m.id;
      card.modelMeta = { context: m.context, pricing: m.pricing };
      saveOrCards();
      $('#chat-model-btn').textContent = m.id;
      $('#chat-model-btn').title = modelMetaText(card);
      $('#chat-model-pop').classList.add('hidden');
      renderProjects(); // model shown on the card
    });
    list.appendChild(row);
  }
}
// ---------------------------------------------------------------- OpenRouter keys modal
function deleteOrCard(id) {
  const st = orChats.get(id);
  if (st && st.streaming && st.reqId) { try { lite.openrouter.chatAbort(st.reqId); } catch (_) {} pendingOr.delete(st.reqId); }
  orCards = orCards.filter((c) => c.id !== id);
  saveOrCards();
  orChats.delete(id);
  try { lite.openrouter.histSet(id, []); } catch (_) {}
  if (activeOrId === id) { activeOrId = null; showActiveTerminal(); }
  renderProjects();
}
function showOpenRouter() {
  closeMenus();
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">🔑</span> OpenRouter</h2>
    <div class="about-desc or-intro">
      Добавь свой API-ключ OpenRouter — он появится отдельной плашкой в колонке слева
      (категория «OpenRouter»). Клик по плашке открывает чат вместо терминала: вверху
      выбираешь любую модель из OpenRouter, ниже — общаешься как в обычном чате.<br><br>
      Купить ключ и следить за балансом удобно на <a href="#" id="or-site">apisell.ru</a>
      или через телеграм-бота <a href="#" id="or-bot">@openrouter_store_bot</a>.
    </div>
    <div class="or-list" id="or-list"></div>
    <div class="or-add">
      <div class="field"><label>API-ключ OpenRouter</label>
        <input type="text" id="or-key" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label>Название (как подписать плашку)</label>
        <input type="text" id="or-name" placeholder="например: Рабочий ключ" autocomplete="off" spellcheck="false"></div>
      <div class="err" id="or-err"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="or-close">Закрыть</button>
      <button class="btn primary" id="or-add">Добавить ключ</button>
    </div>`);
  m.querySelector('#or-site').onclick = (e) => { e.preventDefault(); lite.openExternal('https://apisell.ru'); };
  m.querySelector('#or-bot').onclick = (e) => { e.preventDefault(); lite.openExternal('https://t.me/openrouter_store_bot'); };
  const listBox = m.querySelector('#or-list');
  const err = m.querySelector('#or-err');
  function renderList() {
    listBox.innerHTML = '';
    if (!orCards.length) { listBox.appendChild(el('div', 'or-empty', 'Пока нет ключей — добавь первый ниже.')); return; }
    for (const c of orCards) {
      const row = el('div', 'or-row');
      const info = el('div', 'or-row-info');
      info.appendChild(el('div', 'or-row-name', c.name));
      info.appendChild(el('div', 'or-row-key', maskKey(c.key) + (c.model ? '  ·  ' + c.model : '')));
      row.appendChild(info);
      const ren = iconBtn('icon-btn', 'pencil', 'Переименовать');
      ren.addEventListener('click', () => showPrompt('Название ключа', 'Название', c.name, (v) => {
        const t = (v || '').trim(); if (!t) return;
        c.name = t; saveOrCards(); renderList(); renderProjects();
        if (activeOrId === c.id) $('#chat-title').textContent = t;
      }));
      const del = iconBtn('icon-btn', 'trash', 'Удалить ключ');
      del.addEventListener('click', () => showConfirm('Удалить ключ?',
        `Плашка «${c.name}» и история её чата будут удалены без возможности восстановления.`,
        'Удалить', () => { deleteOrCard(c.id); renderList(); }));
      row.appendChild(ren); row.appendChild(del);
      listBox.appendChild(row);
    }
  }
  renderList();
  m.querySelector('#or-close').onclick = close;
  m.querySelector('#or-add').onclick = () => {
    const key = m.querySelector('#or-key').value.trim();
    const name = m.querySelector('#or-name').value.trim();
    if (!key) { err.textContent = 'Вставь API-ключ OpenRouter'; return; }
    orCards.push({ id: newOrId(), name: name || ('Ключ ' + (orCards.length + 1)), key, model: '', contextN: 10 });
    saveOrCards();
    m.querySelector('#or-key').value = ''; m.querySelector('#or-name').value = ''; err.textContent = '';
    renderList(); renderProjects();
  };
  setTimeout(() => m.querySelector('#or-key').focus(), 30);
}
// ---------------------------------------------------------------- remote pult modal
function showRemote() {
  closeMenus();
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">📱</span> Удалённый пульт</h2>
    <div class="about-desc">
      Управляй терминалом и вкладками ПК с Android-планшета через интернет.
      Зарегистрируй аккаунт здесь, в редакторе, затем в приложении-пульте войди
      тем же логином и паролем — токены вводить не нужно. Пультов можно подключить
      несколько.
    </div>
    <div class="or-add" id="rmt-body"></div>
    <div class="modal-actions"><button class="btn" id="rmt-close">Закрыть</button></div>`);
  const realClose = () => { clearInterval(timer); close(); };
  m.querySelector('#rmt-close').onclick = realClose;
  const body = m.querySelector('#rmt-body');

  function field(labelText, type) {
    const f = el('div', 'field');
    f.appendChild(el('label', '', labelText));
    const inp = document.createElement('input');
    inp.type = type; inp.autocomplete = 'off'; inp.spellcheck = false;
    f.appendChild(inp);
    return { f, inp };
  }

  let mode = null;      // 'auth' | 'account' — перестраиваем только при СМЕНЕ режима
  let statusEl = null;  // строка статуса в режиме «вошли» — её обновляем по таймеру (без пересборки полей)

  function statusText(st) { return st.connected ? '● На связи' : (st.enabled ? '○ Подключение…' : '○ Выключено'); }

  function buildAuth() {
    body.innerHTML = '';
    const login = field('Логин', 'text');
    const pass = field('Пароль', 'password');
    const err = el('div', 'err');
    const actions = el('div', 'modal-actions');
    const reg = el('button', 'btn', 'Зарегистрироваться');
    const inb = el('button', 'btn primary', 'Войти');
    actions.appendChild(reg); actions.appendChild(inb);
    body.appendChild(login.f); body.appendChild(pass.f); body.appendChild(err); body.appendChild(actions);
    const run = async (fn) => {
      err.textContent = '';
      const l = login.inp.value.trim(), p = pass.inp.value;
      if (l.length < 3 || p.length < 4) { err.textContent = 'Логин ≥3, пароль ≥4 символа'; return; }
      reg.disabled = inb.disabled = true;
      let res; try { res = await fn(l, p); } catch (_) { res = { ok: false, error: 'Нет связи с релеем' }; }
      reg.disabled = inb.disabled = false;
      if (res.ok) { toast('Пульт: вошли как ' + res.status.login); tick(); }
      else err.textContent = res.error || 'Ошибка';
    };
    inb.onclick = () => run((l, p) => lite.remote.login(l, p));
    reg.onclick = () => run((l, p) => lite.remote.register(l, p));
    pass.inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inb.click(); });
    setTimeout(() => login.inp.focus(), 30);
  }

  function buildAccount(st) {
    body.innerHTML = '';
    const who = el('div', 'rmt-info');
    who.appendChild(el('span', '', 'Вошли как: '));
    who.appendChild(el('b', '', st.login));
    statusEl = el('div', '', statusText(st));
    statusEl.style.color = st.connected ? 'var(--green-bright)' : 'var(--warn)';
    statusEl.style.margin = '8px 0';
    const tgl = el('label', '');
    tgl.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin:8px 0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = st.enabled;
    tgl.appendChild(cb); tgl.appendChild(el('span', '', 'Пульт включён'));
    cb.onchange = async () => { await lite.remote.setEnabled(cb.checked); tick(); };
    const hint = el('div', 'about-desc');
    hint.appendChild(el('span', '', 'На планшете в приложении «LiteEditor Пульт» войди логином '));
    hint.appendChild(el('b', '', st.login));
    hint.appendChild(el('span', '', ' и тем же паролем. Открой здесь хотя бы один терминал, чтобы он появился на пульте.'));
    // Безопасность: «выйти на всех устройствах» — на случай потери планшета. Снимает одобрение
    // со всех пультов аккаунта (потребуют повторного одобрения); этот ПК остаётся в системе.
    const sec = el('div', 'about-desc');
    sec.style.marginTop = '6px';
    sec.appendChild(el('span', '', 'Потеряли планшет с пультом? Отключите все устройства — свои переодобрите заново.'));
    const revoke = el('button', 'btn', '⎋ Выйти на всех устройствах');
    revoke.style.cssText = 'margin-top:6px;color:var(--danger);border-color:var(--danger)';
    revoke.onclick = () => showConfirm(
      'Выйти на всех устройствах?',
      'Все одобренные пульты будут отключены и потребуют повторного одобрения на ПК. Используйте при потере устройства. Этот ПК останется в системе.',
      'Выйти везде',
      async () => {
        const r = await lite.remote.revokeAllDevices();
        toast(r && r.ok ? 'Все устройства отключены — переодобрите свои заново' : 'Ошибка: ' + ((r && r.error) || ''));
      },
    );
    const actions = el('div', 'modal-actions');
    const out = el('button', 'btn', 'Выйти');
    out.onclick = async () => { await lite.remote.logout(); tick(); };
    actions.appendChild(out);
    body.appendChild(who); body.appendChild(statusEl); body.appendChild(tgl); body.appendChild(hint);
    body.appendChild(sec); body.appendChild(revoke); body.appendChild(actions);
  }

  async function tick() {
    if (!document.body.contains(body)) { clearInterval(timer); return; }
    let st; try { st = await lite.remote.status(); } catch (_) { return; }
    if (!document.body.contains(body)) return;
    const want = st.loggedIn ? 'account' : 'auth';
    if (want !== mode) {
      mode = want;
      statusEl = null;
      if (want === 'auth') buildAuth(); else buildAccount(st);
    } else if (mode === 'account' && statusEl) {
      // Тот же режим — НЕ пересобираем (иначе терялся бы фокус/ввод), только статус.
      statusEl.textContent = statusText(st);
      statusEl.style.color = st.connected ? 'var(--green-bright)' : 'var(--warn)';
    }
  }
  const timer = setInterval(tick, 2500);
  tick();
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
// «В архив»: создаём спец-категорию Архив (свёрнутой по дефолту), если её ещё нет, и переносим проект.
function archiveProject(id) {
  const cats = loadCategories();
  if (!cats.includes(ARCHIVE)) { saveCategories([...cats, ARCHIVE]); setCollapsed(ARCHIVE, true); }
  moveToCategory(id, ARCHIVE);
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
  dd.appendChild(menuRow('folder', 'Открыть в проводнике', () => { closeMenus(); lite.openInFileManager(p.path); }));
  dd.appendChild(menuRow('git', 'Git', () => { closeMenus(); openGitForProject(p.id); }));
  dd.appendChild(menuRow('note', 'Заметки', () => { closeMenus(); showNotes(p); }));
  dd.appendChild(menuRow('copy', 'Копировать путь', () => { closeMenus(); lite.copyText(p.path); toast('Путь скопирован'); }));
  dd.appendChild(menuRow('star', p.favorite ? 'Убрать из избранного' : 'В избранное', () => { closeMenus(); toggleFavorite(p.id); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('pencil', 'Переименовать проект…', () => { closeMenus(); renameProject(p.id); }));
  dd.appendChild(menuRow('palette', 'Цвет проекта…', () => buildCardMenuColor(dd, p)));
  dd.appendChild(menuRow('arrow-right', 'Переместить в категорию…', () => buildCardMenuMove(dd, p)));
  if (p.category === ARCHIVE)
    dd.appendChild(menuRow('archive', 'Вернуть из архива', () => { closeMenus(); moveToCategory(p.id, null); }));
  else
    dd.appendChild(menuRow('archive', 'В архив', () => { closeMenus(); archiveProject(p.id); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('x', 'Закрыть проект', () => { closeMenus(); closeProject(p.id); }, 'danger'));
}
const ACCENTS = ['#2fbf71', '#3dc8dc', '#7aa2f7', '#a98cf0', '#e06fae', '#e0af68', '#f7768e', '#8aa79a'];
function buildCardMenuColor(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('chevron-left', 'Назад', () => buildCardMenuMain(dd, p), 'muted'));
  dd.appendChild(el('div', 'menu-label', 'Цвет проекта'));
  const sw = el('div', 'accent-swatches');
  for (const c of ACCENTS) {
    const b = el('button', 'accent-sw' + (p.accent === c ? ' on' : ''));
    b.style.background = c;
    b.onclick = () => { closeMenus(); setAccent(p.id, c); };
    sw.appendChild(b);
  }
  dd.appendChild(sw);
  dd.appendChild(menuRow('x', 'Сбросить цвет', () => { closeMenus(); setAccent(p.id, null); }, 'muted'));
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
  dd.appendChild(menuRow('pencil', 'Переименовать категорию…', () => { closeMenus(); renameCategory(name); }));
  dd.appendChild(menuRow('trash', 'Удалить категорию', () => { closeMenus(); deleteCategory(name); }, 'danger'));
  placeMenu(dd, x, y);
}
function renameCategory(old) {
  showPrompt('Переименовать категорию', 'Название', old, (name) => {
    if (name === old || name === UNCATEGORIZED || name === ARCHIVE) return;
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
  dd.appendChild(menuRow('chevron-left', 'Назад', () => buildCardMenuMain(dd, p), 'muted'));
  dd.appendChild(el('div', 'menu-label', 'Переместить в'));
  const cats = loadCategories();
  const opts = [UNCATEGORIZED, ...cats.filter((c) => c !== ARCHIVE)]; // Архив — через отдельный пункт «В архив»
  for (const c of opts) {
    const here = c === UNCATEGORIZED ? !cats.includes(p.category) : p.category === c;
    dd.appendChild(menuRow(here ? 'check' : null, c, () => { closeMenus(); moveToCategory(p.id, c === UNCATEGORIZED ? null : c); }));
  }
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('plus', 'Создать новую…', () => { closeMenus(); showCreateCategory(p.id); }));
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
    if (!name || name === UNCATEGORIZED || name === ARCHIVE) { close(); return; }
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
// Статусы и важность задачи (TODO-модель поверх старых заметок {id,text}).
const TODO_STATUS = ['todo', 'doing', 'done']; // цикл по клику
const TODO_STATUS_LABEL = { todo: 'К выполнению', doing: 'В работе', done: 'Выполнено' };
const TODO_PRIO_LABEL = ['Обычная', 'Важная', 'Срочная'];
async function showNotes(p) {
  let notes = await lite.store.notesGet(p.id);
  if (!Array.isArray(notes)) notes = [];
  // Миграция без потери данных: старым заметкам {id,text} проставляем дефолты status/prio.
  notes.forEach((n) => { if (!TODO_STATUS.includes(n.status)) n.status = 'todo'; if (typeof n.prio !== 'number') n.prio = 0; });
  const q = getQueue(p.id);
  // Порядок отображения: ручной (как в массиве) либо сортировка по важности/статусу.
  // Операции над задачами идут по note (id), а не по индексу показа — сортировка ничего не ломает.
  const sortedView = () => {
    const mode = settings.notesSort || 'manual';
    if (mode === 'manual') return notes.slice();
    const rank = { todo: 0, doing: 1, done: 2 };
    return notes.map((n, idx) => ({ n, idx })).sort((a, b) =>
      mode === 'prio' ? (b.n.prio - a.n.prio) || (a.idx - b.idx)
        : (rank[a.n.status] - rank[b.n.status]) || (b.n.prio - a.n.prio) || (a.idx - b.idx)
    ).map((x) => x.n);
  };
  // Detach the live-update callback on ANY close (button/Esc/backdrop) so the dismissed
  // modal + its listeners don't linger in memory until the next queue event fires.
  const { m, close } = makeModal(`
    <h2>✅ Задачи — <span class="nm-proj"></span></h2>
    <div class="nm-tabs">
      <button class="nm-tab active" data-tab="notes">Задачи</button>
      <button class="nm-tab" data-tab="queue">▶ Очередь<span class="nm-qbadge" id="nm-qbadge"></span></button>
    </div>
    <div class="nm-pane" id="nm-pane-notes">
      <div class="nm-toolbar">
        <label class="nm-sort">Сортировка
          <select id="nm-sort">
            <option value="manual">Вручную</option>
            <option value="prio">По важности</option>
            <option value="status">По статусу</option>
          </select>
        </label>
        <button class="btn nm-add" id="nm-add">＋ Новая задача</button>
      </div>
      <div class="nm-hint">Слева — статус (клик меняет: ☐ к выполнению → ◐ в работе → ☑ готово) и важность (флажок). Задачи не удаляются при отметке «готово» — просто помечаются. «➤» — в терминал, «→» — в авто-очередь.</div>
      <div class="nm-list" id="nm-list"></div>
    </div>
    <div class="nm-pane" id="nm-pane-queue" hidden></div>
    <div class="modal-actions"><button class="btn primary" id="nm-close">Готово</button></div>`,
    () => { q.onChange = null; });
  m.classList.add('notes-modal');
  m.querySelector('.nm-proj').textContent = p.name;
  const list = m.querySelector('#nm-list');
  const qpane = m.querySelector('#nm-pane-queue');
  const updateTabBadge = () => {
    const b = m.querySelector('#nm-qbadge');
    b.textContent = q.items.length ? String(q.items.length) : '';
    b.classList.toggle('show', q.items.length > 0);
  };
  // Persist notes; keep queued snapshots in sync with edits and drop queued items
  // whose underlying note was deleted (queue references notes by id).
  const save = () => {
    lite.store.notesSet(p.id, notes); noteCounts[p.id] = notes.filter((n) => n.status !== 'done').length;
    // Capture the running queue's cursor BY ID before refiltering, so deleting a note
    // mid-run can't shift q.pos onto the wrong item (which would skip a note or make
    // queueOnSettled finish early). doneIds = items already sent (before the cursor).
    const running = q.running && q.pos >= 0 && q.pos < q.items.length;
    const curId = running ? q.items[q.pos].noteId : null;
    const doneIds = running ? new Set(q.items.slice(0, q.pos).map((it) => it.noteId)) : null;
    q.items = q.items
      .filter((it) => notes.some((n) => n.id === it.noteId))
      .map((it) => ({ noteId: it.noteId, text: (notes.find((n) => n.id === it.noteId) || {}).text || '' }));
    if (running) {
      const ci = q.items.findIndex((it) => it.noteId === curId);
      // current survived → its new index; current was deleted → sit just before the first
      // remaining pending item so the next advance dispatches it instead of skipping it.
      q.pos = ci >= 0 ? ci : q.items.filter((it) => doneIds.has(it.noteId)).length - 1;
    }
    updateTabBadge();
    renderProjects();
  };
  let dragFrom = null;
  let editing = null; // { note, ta } — открытый редактор карточки
  // Снять текст из открытого редактора в заметку (для авто-сохранения по «Готово»).
  const flushEdit = () => { if (editing) { editing.note.text = editing.ta.value; editing = null; save(); } };
  // Переставить карточку: свап с соседом (стрелки ▲/▼). flushEdit — не потерять правку при перерисовке.
  const moveNote = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= notes.length) return;
    flushEdit();
    [notes[i], notes[j]] = [notes[j], notes[i]];
    save(); render();
  };

  function editNote(row, note) {
    row.innerHTML = '';
    row.classList.add('editing');
    const ta = el('textarea', 'note-edit'); ta.value = note.text || '';
    editing = { note, ta };
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
    editing = null; // перерисовка закрывает любой открытый редактор
    list.innerHTML = '';
    const manual = (settings.notesSort || 'manual') === 'manual';
    sortedView().forEach((note) => {
      const realIdx = notes.indexOf(note); // индекс в массиве (для ручного порядка/перетаскивания)
      const row = el('div', 'todo-row st-' + note.status + ' pr-' + note.prio + (note.status === 'done' ? ' done' : ''));
      row.dataset.id = note.id;
      if (manual) { row.draggable = true; row.dataset.i = String(realIdx); }
      // статус: клик циклит ☐ к выполнению → ◐ в работе → ☑ готово
      const chk = el('button', 'todo-check st-' + note.status);
      chk.title = 'Статус: ' + TODO_STATUS_LABEL[note.status] + ' (клик — сменить)';
      if (note.status === 'done') chk.appendChild(icon('check', 13));
      chk.addEventListener('click', () => { flushEdit(); note.status = TODO_STATUS[(TODO_STATUS.indexOf(note.status) + 1) % TODO_STATUS.length]; save(); render(); });
      // важность: клик циклит обычная → важная → срочная
      const flag = el('button', 'todo-flag pr-' + note.prio);
      flag.title = 'Важность: ' + TODO_PRIO_LABEL[note.prio] + ' (клик — сменить)';
      flag.appendChild(icon('flag', 13));
      flag.addEventListener('click', () => { flushEdit(); note.prio = (note.prio + 1) % 3; save(); render(); });
      // текст задачи
      const txt = el('div', 'todo-text', note.text || '(пусто)');
      txt.title = 'Двойной клик — редактировать';
      txt.addEventListener('dblclick', () => editNote(row, note));
      // действия — иконки-кнопки в стиле плашек проекта, всегда видимые
      const acts = el('div', 'todo-acts');
      const qi = q.items.findIndex((it) => it.noteId === note.id);
      const queued = qi >= 0;
      const qBtn = iconBtn('todo-act' + (queued ? ' on' : ''), 'arrow-right', '', 14);
      qBtn.disabled = q.running;
      qBtn.title = q.running ? 'Очередь выполняется — состав менять нельзя' : (queued ? `В авто-очереди · ${qi + 1} (клик — убрать)` : 'Добавить в авто-очередь');
      qBtn.addEventListener('click', () => {
        if (q.running) return;
        flushEdit();
        const idx = q.items.findIndex((it) => it.noteId === note.id);
        if (idx >= 0) q.items.splice(idx, 1); else q.items.push({ noteId: note.id, text: note.text || '' });
        queueChanged(q); updateTabBadge(); render();
      });
      const send = iconBtn('todo-act', 'terminal', 'В терминал (без Enter)', 14);
      send.addEventListener('click', () => { flushEdit(); sendNoteToTerminal(p, note.text); close(); });
      const edit = iconBtn('todo-act', 'pencil', 'Редактировать', 14);
      edit.addEventListener('click', () => editNote(row, note));
      const del = iconBtn('todo-act danger', 'trash', 'Удалить задачу', 14);
      del.addEventListener('click', () => { showConfirm('Удалить задачу?', 'Удалить совсем (а не пометить выполненной)?', 'Удалить', () => { const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1); save(); render(); }); });
      acts.append(qBtn, send, edit, del);
      if (manual) { // перестановка только в ручном режиме (в сортировках индексы показа не равны порядку)
        const up = iconBtn('todo-act', 'chevron-up', 'Выше', 14); up.disabled = realIdx === 0; up.addEventListener('click', () => moveNote(realIdx, -1));
        const down = iconBtn('todo-act', 'chevron-down', 'Ниже', 14); down.disabled = realIdx === notes.length - 1; down.addEventListener('click', () => moveNote(realIdx, +1));
        acts.append(up, down);
      }
      row.append(chk, flag, txt, acts);
      if (manual) {
        row.addEventListener('dragstart', () => { dragFrom = realIdx; row.classList.add('dragging'); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => e.preventDefault());
        row.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom == null || dragFrom === realIdx) return; const [moved] = notes.splice(dragFrom, 1); notes.splice(realIdx, 0, moved); dragFrom = null; save(); render(); });
      }
      list.appendChild(row);
    });
    if (!notes.length) list.appendChild(el('div', 'nm-empty', 'Пока пусто — добавь задачу кнопкой «＋ Новая задача».'));
  }
  const sortSel = m.querySelector('#nm-sort');
  sortSel.value = settings.notesSort || 'manual';
  sortSel.addEventListener('change', () => { settings.notesSort = sortSel.value; saveSettings(); render(); });
  m.querySelector('#nm-add').addEventListener('click', () => {
    const note = { id: 'n' + Date.now().toString(36), text: '', status: 'todo', prio: 0 };
    notes.push(note); save(); render();
    const row = list.querySelector(`.todo-row[data-id="${note.id}"]`);
    if (row) editNote(row, note);
  });

  // ---- Queue tab ----
  function swapQueue(i, j) {
    if (j < 0 || j >= q.items.length) return;
    [q.items[i], q.items[j]] = [q.items[j], q.items[i]];
    queueChanged(q); renderQueue();
  }
  function renderQueue() {
    qpane.innerHTML = '';
    const bar = el('div', 'q-bar');
    const status = el('div', 'q-status');
    const next = Math.min(q.pos + 2, q.items.length);
    if (!q.items.length) status.textContent = 'Очередь пуста — добавь карточки кнопкой «＋ в очередь».';
    else if (q.armed) { status.textContent = `▶ Агент ждёт — нажми «Дальше» для заметки ${next} из ${q.items.length}`; status.classList.add('armed'); }
    else if (q.running) { status.textContent = `Выполняется ${Math.min(q.pos + 1, q.items.length)} из ${q.items.length} — ждём, пока агент закончит ход…`; status.classList.add('run'); }
    else status.textContent = `${q.items.length} в очереди — нажми «Старт».`;
    bar.appendChild(status);
    const ctrls = el('div', 'q-ctrls');
    if (!q.running) {
      const start = el('button', 'note-btn primary', '▶ Старт'); start.disabled = !q.items.length;
      start.addEventListener('click', () => { queueStart(p.id); renderQueue(); });
      ctrls.appendChild(start);
    } else {
      const adv = el('button', 'note-btn primary' + (q.armed ? ' armed' : ''), '▶ Дальше');
      adv.title = 'Отправить следующую заметку (Ctrl+Shift+Enter)';
      adv.addEventListener('click', () => { queueAdvance(p.id); renderQueue(); });
      const stop = el('button', 'note-btn danger', '⏹ Стоп');
      stop.addEventListener('click', () => { queueStop(p.id); renderQueue(); });
      ctrls.append(adv, stop);
    }
    const clear = el('button', 'note-btn', '🗑 Очистить'); clear.disabled = !q.items.length;
    clear.addEventListener('click', () => { q.items = []; q.running = false; q.pos = -1; q.awaitingBusy = false; q.armed = false; queueChanged(q); updateTabBadge(); renderQueue(); });
    ctrls.appendChild(clear);
    bar.appendChild(ctrls);
    qpane.appendChild(bar);
    qpane.appendChild(el('div', 'nm-hint', 'Первая карточка уходит сразу при старте (с Enter). Следующая — НЕ автоматически: когда агент закончит ход и индикатор станет янтарным, прилетит уведомление, а тут загорится «▶ Дальше» (или Ctrl+Shift+Enter в активном проекте). Так агент успевает задать вопрос, а ты решаешь, слать ли следующую.'));
    const qlist = el('div', 'nm-list');
    q.items.forEach((it, i) => {
      let cls = 'pending';
      if (q.running) { if (i < q.pos) cls = 'done'; else if (i === q.pos) cls = 'current'; }
      const row = el('div', 'q-card q-' + cls);
      const num = el('span', 'q-num', cls === 'done' ? '✓' : cls === 'current' ? '▶' : String(i + 1));
      const txt = el('div', 'q-text', it.text || '(пусто)');
      const acts = el('div', 'note-acts');
      const up = el('button', 'note-btn nudge', '▲'); up.title = 'Выше'; up.disabled = i === 0 || q.running;
      up.addEventListener('click', () => swapQueue(i, i - 1));
      const down = el('button', 'note-btn nudge', '▼'); down.title = 'Ниже'; down.disabled = i === q.items.length - 1 || q.running;
      down.addEventListener('click', () => swapQueue(i, i + 1));
      const rm = el('button', 'note-btn danger', '✕'); rm.title = 'Убрать из очереди'; rm.disabled = q.running;
      rm.addEventListener('click', () => { q.items.splice(i, 1); queueChanged(q); updateTabBadge(); renderQueue(); });
      acts.append(up, down, rm);
      row.append(num, txt, acts);
      qlist.appendChild(row);
    });
    if (!q.items.length) qlist.appendChild(el('div', 'nm-empty', 'Пусто.'));
    qpane.appendChild(qlist);
  }

  // ---- tabs + live sync ----
  const panes = { notes: m.querySelector('#nm-pane-notes'), queue: qpane };
  const tabs = m.querySelectorAll('.nm-tab');
  function setTab(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    Object.entries(panes).forEach(([k, pane]) => { pane.hidden = k !== name; });
    if (name === 'queue') renderQueue(); else render();
  }
  tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  // Background auto-advance keeps the open modal live (and detaches itself once closed).
  q.onChange = () => {
    if (!m.isConnected) { q.onChange = null; return; }
    updateTabBadge();
    if (!qpane.hidden) renderQueue();
  };

  m.querySelector('#nm-close').onclick = () => { flushEdit(); close(); }; // close() nulls q.onChange via onClose
  updateTabBadge();
  render();
}
function sendNoteToTerminal(p, text) {
  if (!text) return;
  const proj = projects.find((x) => x.id === p.id);
  if (!proj) return;
  ensureProjectTabs(proj);
  setActive(proj.id);
  const sid = (tabsByProj.get(proj.id) || {}).active;
  if (sid) lite.pty.write(sid, text); // no trailing newline — review, then press Enter yourself
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

// Compact project switcher for single-terminal mode: indicator + name, click switches.
function renderMiniRail() {
  const rail = $('#mini-rail');
  rail.innerHTML = '';
  for (const p of projects) {
    const btn = el('button', 'rail-btn');
    if (p.id === activeId) btn.classList.add('active');
    btn.title = p.name;
    const ind = el('span', 'pind ' + projAggState(p.id));
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
  // Closing the project whose unsaved file is open in the viewer would silently drop those
  // edits — run the save/discard prompt first, then re-enter (dirty is false → falls through).
  if (dirty && currentFile && activeId === id) { guardDirty(() => doCloseProject(id)); return; }
  const closing = projects.find((p) => p.id === id);
  if (closing) { // remember the close so a scan-dir project doesn't reappear next launch
    const dis = new Set(STORE.dismissed || []); dis.add(closing.path); persist('dismissed', [...dis]);
  }
  if (closing && watchedRoot === closing.path) { lite.fs.unwatch(closing.path); watchedRoot = null; }
  const tabs = tabsByProj.get(id);
  if (tabs) {
    for (const sid of tabs.sessions) {
      lite.pty.kill(sid);
      const rec = terms.get(sid);
      if (rec) { clearTimeout(rec.idleTimer); try { rec.term.dispose(); } catch (_) {} rec.container.remove(); terms.delete(sid); }
      projState.delete(sid);
    }
    tabsByProj.delete(id);
  }
  const pt = { ...(STORE.projTabs || {}) }; delete pt[id]; persist('projTabs', pt);
  missing.delete(id);
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

function setProjState(sid, state) {
  projState.set(sid, state);
  const rec = terms.get(sid);
  document.querySelectorAll(`.tab[data-sid="${sid}"] .tab-dot`).forEach((d) => { d.className = 'tab-dot pind ' + state; });
  if (rec) refreshProjIndicator(rec.projId); // card/rail show the project aggregate
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
  const q = queues.get(rec.projId); if (q && q.running && q.sessionId === id) q.awaitingBusy = false; // dispatched note now running
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
  const pid = rec.projId;
  const q = queues.get(pid);
  const qTargets = !!(q && q.running && q.sessionId === id); // this session is the queue's target tab
  if (qTargets) queueOnSettled(pid, waiting ? 'waiting' : 'quiet');
  // a running queue posts its own «Дальше» notification; notify per project on a non-visible tab
  if (!qTargets && worked && (id !== activeSessionId() || !document.hasFocus())) notifyAgent(pid, waiting ? 'waiting' : 'quiet');
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
// xterm ships Unicode V6 width tables, which lack newer emoji ranges (📁 U+1F4C1, ⏰ U+23F0…)
// → they're treated as width 1 and overlap neighbouring text (e.g. Claude Code's status line).
// The unicode11 addon adds the Unicode 11 width tables; activeVersion='11' switches to them.
function applyUnicode11(term) {
  try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'; } catch (_) {}
}

// ---- terminal sessions (tabs) ----
// Each project owns ≥1 SESSION (tab) = its own PTY + xterm. `terms` is keyed by sessionId;
// `tabsByProj` keeps per-project order + active session. Tab NAMES persist across restarts
// (projTabs store); PTYs don't, so tabs are recreated empty on next launch.
function activeSessionId() { const t = tabsByProj.get(activeId); return t ? t.active : null; }
function projSessions(projId) { const t = tabsByProj.get(projId); return t ? t.sessions : []; }
function projAggState(projId) {
  const ss = projSessions(projId).map((s) => projState.get(s));
  return ss.includes('busy') ? 'busy' : ss.includes('waiting') ? 'waiting' : 'quiet';
}
function refreshProjIndicator(projId) {
  const st = projAggState(projId);
  document.querySelectorAll(`.pind[data-id="${projId}"]`).forEach((i) => { i.className = 'pind ' + st; });
}
function saveProjTabs() {
  const out = {};
  for (const [pid, t] of tabsByProj) {
    out[pid] = { names: t.sessions.map((s) => (terms.get(s) || {}).name || 'Терминал'), active: t.sessions.indexOf(t.active) };
  }
  persist('projTabs', out);
}
function createSession(proj, name) {
  const id = proj.id + '::t' + (++sessionSeq);
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
  applyUnicode11(term);
  term.open(container);
  loadFastRenderer(term);
  fit.fit();
  term.registerLinkProvider(fileLinkProvider(term, proj.path));
  lite.pty.create({ id, cwd: proj.path, cols: term.cols, rows: term.rows });
  term.onData((data) => {
    const r = terms.get(id);
    if (r) { r.lastInputAt = Date.now(); if (r.remoteSized) reclaimTermSize(id); }   // печатаю на ПК → забираю владение размером у пульта
    lite.pty.write(id, data);
  });
  term.onResize(({ cols, rows }) => lite.pty.resize(id, cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Match by physical key (e.code), NOT e.key — so Ctrl+C/V/F etc. work in ANY keyboard
    // layout (in Russian layout Ctrl+V gives e.key='м', which the old e.key check missed).
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { addTab(); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { const s = activeSessionId(); if (s) closeTab(s); return false; }
    if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleTab(e.key === 'PageDown' ? 1 : -1); return false; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term); // copied → swallow; else SIGINT
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteInto(id); return false; } // preventDefault — иначе xterm вставит ещё раз нативно (дубль)
    if (e.ctrlKey && !e.altKey && e.code === 'KeyF') { openTermSearch(); return false; }
    // Ctrl+Enter — перенос строки в вводе (продолжение команды), а не выполнение: \ + CR для bash/zsh, LF для ConPTY/PSReadLine (Win)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') { lite.pty.write(id, lite.platform === 'win32' ? '\n' : '\\\r'); return false; }
    if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
      const q = queues.get(proj.id);
      if (q && q.running) { queueAdvance(proj.id); return false; }
    }
    return true;
  });
  container.addEventListener('contextmenu', (e) => { e.preventDefault(); showTermMenu(e.clientX, e.clientY, term, id); });
  const rec = { term, fit, search, container, projId: proj.id, name, idleTimer: null, sawBell: false, tail: '', busyStart: 0, lastInputAt: 0, activitySeq: 0, remoteSized: false };
  terms.set(id, rec);
  tabsByProj.get(proj.id).sessions.push(id);
  return id;
}
// Ensure a project's sessions exist (restoring saved tab names on first open).
function ensureProjectTabs(proj) {
  if (tabsByProj.has(proj.id)) return;
  tabsByProj.set(proj.id, { sessions: [], active: null });
  const saved = (STORE.projTabs || {})[proj.id];
  const names = saved && Array.isArray(saved.names) && saved.names.length ? saved.names : ['Терминал 1'];
  names.forEach((n) => createSession(proj, n));
  const t = tabsByProj.get(proj.id);
  const ai = saved && Number.isInteger(saved.active) ? saved.active : 0;
  t.active = t.sessions[Math.max(0, Math.min(ai, t.sessions.length - 1))] || t.sessions[0];
  saveProjTabs();
}
function renderTabBar() {
  const header = $('#term-header');
  const bar = $('#term-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const t = tabsByProj.get(activeId);
  if (!activeId || !t || !t.sessions.length) { if (header) header.style.display = 'none'; return; }
  if (header) header.style.display = 'flex';
  t.sessions.forEach((sid) => {
    const rec = terms.get(sid); if (!rec) return;
    const tab = el('div', 'tab' + (sid === t.active ? ' active' : ''));
    tab.dataset.sid = sid;
    tab.appendChild(el('span', 'tab-dot pind ' + (projState.get(sid) || 'quiet')));
    tab.appendChild(el('span', 'tab-name', rec.name));
    if (t.sessions.length > 1) {
      const x = iconBtn('tab-close', 'x', 'Закрыть вкладку (Ctrl+Shift+W)', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(sid); });
      tab.appendChild(x);
    }
    tab.addEventListener('click', () => switchTab(sid));
    tab.addEventListener('dblclick', () => renameTab(sid));
    bar.appendChild(tab);
  });
  const add = iconBtn('tab-add', 'plus', 'Новая вкладка (Ctrl+Shift+T)', 15);
  add.addEventListener('click', () => addTab());
  bar.appendChild(add);
}
function switchTab(sid) {
  const t = tabsByProj.get(activeId);
  if (!t || !terms.has(sid)) return;
  t.active = sid; saveProjTabs(); showActiveTerminal();
}
function addTab() {
  const proj = activeProject(); if (!proj) return;
  ensureProjectTabs(proj);
  const t = tabsByProj.get(proj.id);
  const sid = createSession(proj, 'Терминал ' + (t.sessions.length + 1));
  t.active = sid; saveProjTabs(); showActiveTerminal();
}
function closeTab(sid) {
  const t = tabsByProj.get(activeId); if (!t || t.sessions.length <= 1) return; // keep ≥1 tab
  lite.pty.kill(sid);
  const rec = terms.get(sid);
  if (rec) { clearTimeout(rec.idleTimer); try { rec.term.dispose(); } catch (_) {} rec.container.remove(); terms.delete(sid); }
  projState.delete(sid);
  const i = t.sessions.indexOf(sid);
  t.sessions.splice(i, 1);
  if (t.active === sid) t.active = t.sessions[Math.max(0, i - 1)];
  saveProjTabs(); showActiveTerminal();
  refreshProjIndicator(activeId); updateAttention();
}
function cycleTab(dir) {
  const t = tabsByProj.get(activeId); if (!t || t.sessions.length < 2) return;
  let i = t.sessions.indexOf(t.active) + dir;
  if (i < 0) i = t.sessions.length - 1; if (i >= t.sessions.length) i = 0;
  switchTab(t.sessions[i]);
}
function renameTab(sid) {
  const rec = terms.get(sid); if (!rec) return;
  showPrompt('Переименовать вкладку', 'Название', rec.name, (v) => { rec.name = v; saveProjTabs(); renderTabBar(); });
}
async function pasteInto(id) {
  const text = await lite.readClipboard();
  if (text) lite.pty.write(id, text);
  // Reading the clipboard is async (IPC round-trip) and the right-click menu steals
  // focus — without this the terminal looks "frozen" until clicked. Refocus the xterm.
  const rec = scratchTerms.get(id) || terms.get(id);
  if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
}
// Smart Ctrl+C: if there's a non-empty selection, copy it (and clear, so the next
// Ctrl+C can still send SIGINT) and report handled; otherwise return false so the
// keypress falls through to the PTY as the interrupt signal. Mirrors the menu's copy.
function copySelection(term) {
  if (term.hasSelection && term.hasSelection()) {
    const sel = term.getSelection();
    if (sel) { lite.copyText(sel); if (term.clearSelection) term.clearSelection(); return true; }
  }
  return false;
}

function showActiveTerminal() {
  const chatMode = activeOrId !== null;
  $('#chat-pane').classList.toggle('hidden', !chatMode);
  $('#terminals').style.display = chatMode ? 'none' : '';
  if (chatMode) { // chat replaces the terminal; hide tabs/terminals/hint
    $('#empty-hint').style.display = 'none';
    $('#term-header').style.display = 'none';
    reportRemoteActive(null);
    return;
  }
  const asid = activeSessionId();
  $('#empty-hint').style.display = activeId ? 'none' : 'flex';
  for (const [sid, rec] of terms) rec.container.style.display = sid === asid ? 'block' : 'none';
  renderTabBar();
  refitActiveTerminal(true);
  reportRemoteActive(asid);
}
// Сообщаем main, какая вкладка активна на десктопе → пульт синхронизирует выделение.
let lastReportedActive;
function reportRemoteActive(sid) {
  if (sid === lastReportedActive) return;
  lastReportedActive = sid;
  try { lite.remote.activeChanged(sid || ''); } catch (_) {}
}
// Пульт выбрал вкладку → переключаем десктоп на неё (если такая сессия есть локально).
function handleRemoteSelect(sid) {
  if (!sid) return;
  const rec = terms.get(sid);
  if (!rec) return; // удалённо открытый/неизвестный терминал — десктоп не следует
  const t = tabsByProj.get(rec.projId);
  if (t) t.active = sid;
  if (rec.projId !== activeId) doSetActive(rec.projId);
  else { saveProjTabs(); showActiveTerminal(); }
}
// Пульт нажал «＋» у проекта → открываем настоящую вкладку на десктопе (= и на пульте).
function handleRemoteOpen(projId) {
  const proj = projects.find((p) => p.id === projId);
  if (!proj) return;
  // Если у проекта ещё НЕТ терминалов — doSetActive сам создаст «Терминал 1» (ensureProjectTabs).
  // Только если терминалы уже были, «＋» с пульта открывает ДОПОЛНИТЕЛЬНУЮ вкладку. Иначе
  // получалось 2 терминала сразу (авто-первый + addTab) и пульт зацикливался на переключении.
  const hadTabs = tabsByProj.has(projId) && (tabsByProj.get(projId).sessions || []).length > 0;
  doSetActive(projId);
  if (hadTabs) addTab();
}
// Пульт прислал «Создать папку» → создаём её на ПК в рабочем каталоге и открываем
// проектом (новая вкладка-терминал прилетит обратно на пульт через состояние).
async function handleRemoteNewFolder(name) {
  name = String(name || '').trim();
  if (!name) return;
  const parent = (settings && settings.workingDir) || lastParent || '';
  if (!parent) { toast('Пульт: задай рабочий каталог в Настройках, чтобы создавать папки'); return; }
  try {
    const res = await lite.fs.mkdir(parent, name);
    if (res && res.error) { toast('Пульт: ' + res.error); return; }
    if (res && res.path) { openByPath(res.path, res.name); toast(`Папка «${res.name}» создана (с пульта)`); }
  } catch (e) { toast('Пульт: не удалось создать папку'); }
}
// Пульт просит одобрить устройство (pairing) → модалка с именем устройства и проверочным
// кодом. Одобрять только своё устройство, у которого код на экране совпадает.
function handleRemotePairRequest(info) {
  info = info || {};
  const device = info.device || '';
  if (!device) return;
  const name = info.name || 'Неизвестное устройство';
  const code = info.code ? `\n\nКод на устройстве: ${info.code}` : '';
  showConfirm(
    `Подключить устройство «${name}»?`,
    `Устройство запрашивает доступ к терминалу через пульт. Одобряйте ТОЛЬКО если это ваше устройство и код ниже совпадает с показанным на нём.${code}`,
    '✓ Одобрить',
    () => { try { lite.remote.pairApprove(device); toast(`Устройство «${name}» одобрено`); } catch (_) {} },
    '✕ Отклонить',
    () => { try { lite.remote.pairDeny(device); toast(`Устройство «${name}» отклонено`); } catch (_) {} },
  );
}
// Пульт закрыл вкладку (×) → закрываем её на десктопе (closeTab работает по активному проекту).
function handleRemoteClose(sid) {
  const rec = terms.get(sid);
  if (!rec) return;
  if (rec.projId !== activeId) doSetActive(rec.projId);
  closeTab(sid);
}
function refitActiveTerminal(focusIt) {
  if (dockerExecFit && dockerView === 'detail' && dockerDetailTab === 'term') { try { dockerExecFit.fit(); } catch (_) {} }
  const asid = activeSessionId();
  const rec = asid ? terms.get(asid) : null;
  if (!rec) return;
  // Пульт владеет размером этой сессии (подключён и задал свою сетку): ПК зеркалит её
  // (letterbox) и НЕ навязывает свой fit, иначе PTY дёргается туда-сюда и пульт «сыпется».
  if (rec.remoteSized) { if (focusIt) { try { rec.term.focus(); } catch (_) {} } return; }
  requestAnimationFrame(() => {
    try { rec.fit.fit(); lite.pty.resize(asid, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {}
  });
}
// Пульт задал размер сессии → ПК подгоняет свой xterm под ту же сетку (без пере-фита).
function applyRemoteTermSize(id, cols, rows) {
  const rec = terms.get(id);
  if (!rec || !cols || !rows) return;
  rec.remoteSized = true;
  try { if (rec.term.cols !== cols || rec.term.rows !== rows) rec.term.resize(cols, rows); } catch (_) {}
}
// ПК забирает владение размером назад (пульт отключился ИЛИ юзер печатает на ПК) → обычный fit.
function reclaimTermSize(id) {
  const rec = id ? terms.get(id) : null;
  if (id && rec) rec.remoteSized = false;
  else for (const r of terms.values()) r.remoteSized = false;
  refitActiveTerminal();
}
function clearTerminal(id) {
  if (isScratch(id)) { const r = scratchTerms.get(id) || scratchTerms.get(scratchActiveId); if (r) { try { r.term.clear(); } catch (_) {} r.term.focus(); } return; }
  const sid = (id && terms.has(id)) ? id : activeSessionId();
  const rec = terms.get(sid); if (rec) { try { rec.term.clear(); } catch (_) {} rec.term.focus(); }
}
function restartTerminal(id) {
  if (isScratch(id)) { restartScratch(id); return; }
  const sid = (id && terms.has(id)) ? id : activeSessionId();
  const rec = terms.get(sid);
  const proj = rec && projects.find((p) => p.id === rec.projId);
  if (!proj || !rec) return;
  try { rec.term.reset(); } catch (_) {}
  rec.sawBell = false; rec.tail = ''; rec.busyStart = Date.now();
  clearTimeout(rec.idleTimer);
  setProjState(sid, 'busy');
  lite.pty.restart({ id: sid, cwd: proj.path, cols: rec.term.cols, rows: rec.term.rows });
  rec.term.focus();
}

// ---------------------------------------------------------------- system terminals (module)
// System terminals aren't tied to any project (cwd = home dir; main falls back to os.homedir()
// when no cwd is given). Now a right-slot MODULE with its own TABS — several independent shells.
// PTY ids are `__scratch__::tN`.
function newScratchId() { return SCRATCH_ID + '::t' + (++scratchSeq); }
function createScratchSession(name) {
  const id = newScratchId();
  const container = el('div', 'term-instance');
  $('#scratch-term').appendChild(container);
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 5000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
  applyUnicode11(term);
  term.open(container);
  loadFastRenderer(term);
  fit.fit();
  lite.pty.create({ id, cols: term.cols, rows: term.rows }); // no cwd → ~ (os.homedir)
  term.onData((data) => lite.pty.write(id, data));
  term.onResize(({ cols, rows }) => lite.pty.resize(id, cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { addScratchTab(); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { closeScratchTab(scratchActiveId); return false; }
    if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleScratchTab(e.key === 'PageDown' ? 1 : -1); return false; }
    // match by physical key so copy/paste work in any layout (Russian incl.)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term); // copied → swallow; else SIGINT
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteInto(id); return false; }
    // Ctrl+Enter — перенос строки в вводе (продолжение команды): \ + CR для bash/zsh, LF для ConPTY/PSReadLine (Win)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') { lite.pty.write(id, lite.platform === 'win32' ? '\n' : '\\\r'); return false; }
    return true;
  });
  container.addEventListener('contextmenu', (e) => { e.preventDefault(); showTermMenu(e.clientX, e.clientY, term, id); });
  scratchTerms.set(id, { term, fit, search, container, name: name || ('Терминал ' + (scratchSessions.length + 1)) });
  scratchSessions.push(id);
  return id;
}
function ensureScratch() { if (!scratchSessions.length) scratchActiveId = createScratchSession('Терминал 1'); }
function showActiveScratch() {
  for (const [sid, rec] of scratchTerms) rec.container.style.display = sid === scratchActiveId ? 'block' : 'none';
  renderScratchTabs();
  refitScratch(true);
}
function renderScratchTabs() {
  const bar = $('#scratch-tabs'); if (!bar) return;
  bar.innerHTML = '';
  scratchSessions.forEach((sid) => {
    const rec = scratchTerms.get(sid); if (!rec) return;
    const tab = el('div', 'tab' + (sid === scratchActiveId ? ' active' : ''));
    tab.appendChild(el('span', 'tab-name', rec.name));
    if (scratchSessions.length > 1) {
      const x = iconBtn('tab-close', 'x', 'Закрыть вкладку (Ctrl+Shift+W)', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); closeScratchTab(sid); });
      tab.appendChild(x);
    }
    tab.addEventListener('click', () => switchScratchTab(sid));
    tab.addEventListener('dblclick', () => renameScratchTab(sid));
    bar.appendChild(tab);
  });
  const add = iconBtn('tab-add', 'plus', 'Новый системный терминал (Ctrl+Shift+T)', 15);
  add.addEventListener('click', () => addScratchTab());
  bar.appendChild(add);
}
function switchScratchTab(sid) { if (!scratchTerms.has(sid)) return; scratchActiveId = sid; showActiveScratch(); }
function addScratchTab() { scratchActiveId = createScratchSession('Терминал ' + (scratchSessions.length + 1)); showActiveScratch(); }
function closeScratchTab(sid) {
  if (scratchSessions.length <= 1) return; // keep ≥1
  lite.pty.kill(sid);
  const rec = scratchTerms.get(sid);
  if (rec) { try { rec.term.dispose(); } catch (_) {} rec.container.remove(); scratchTerms.delete(sid); }
  const i = scratchSessions.indexOf(sid); scratchSessions.splice(i, 1);
  if (scratchActiveId === sid) scratchActiveId = scratchSessions[Math.max(0, i - 1)];
  showActiveScratch();
}
function cycleScratchTab(dir) {
  if (scratchSessions.length < 2) return;
  let i = scratchSessions.indexOf(scratchActiveId) + dir;
  if (i < 0) i = scratchSessions.length - 1; if (i >= scratchSessions.length) i = 0;
  switchScratchTab(scratchSessions[i]);
}
function renameScratchTab(sid) {
  const rec = scratchTerms.get(sid); if (!rec) return;
  showPrompt('Переименовать вкладку', 'Название', rec.name, (v) => { rec.name = v; renderScratchTabs(); });
}
function refitScratch(focusIt) {
  if (!scratchOpen || !scratchActiveId) return;
  const rec = scratchTerms.get(scratchActiveId); if (!rec) return;
  requestAnimationFrame(() => {
    try { rec.fit.fit(); lite.pty.resize(scratchActiveId, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {}
  });
}
function setScratchOpen(open, opts = {}) {
  if (open === scratchOpen) { if (open) refitScratch(true); return; }
  // System terminals are a right-slot module now → mutually exclusive with viewer/git/docker/db/rh.
  if (open) { if (viewerOpen) setViewerOpen(false); if (gitOpen) setGitOpen(false); if (dockerOpen) setDockerOpen(false); if (dbOpen) setDbOpen(false); if (rhOpen) setRhOpen(false); }
  const delta = layout.scratch + GUTTER;
  scratchOpen = open;
  $('#scratch-pane').classList.toggle('hidden', !open);
  $('#gutter-scratch').classList.toggle('hidden', !open);
  $('#btn-scratch').classList.toggle('on', open);
  if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
  saveUiState();
  if (open) { ensureScratch(); setTimeout(() => showActiveScratch(), 60); }
  setTimeout(refitActiveTerminal, 160);
}
function toggleScratch() { setScratchOpen(!scratchOpen); }
function restartScratch(id) {
  const sid = (id && scratchTerms.has(id)) ? id : scratchActiveId;
  const rec = scratchTerms.get(sid); if (!rec) return;
  try { rec.term.reset(); } catch (_) {}
  lite.pty.restart({ id: sid, cols: rec.term.cols, rows: rec.term.rows }); // no cwd → ~
  rec.term.focus();
}

// ================================================================ RemoteHost module (SSH)
// Менеджер профилей подключений + живые SSH-сессии-вкладки (ssh2 shell ↔ xterm).
// Два вида внутри панели: 'list' (список хостов) и 'session' (открытый терминал). Вкладки
// сессий живут поверх обоих видов; «+» возвращает к списку для нового подключения.
function setRhOpen(open, opts = {}) {
  if (open === rhOpen) { if (open) renderRhPanel(); return; }
  // Right slot holds one module — opening RemoteHost closes the others (chat is separate).
  if (open) { if (viewerOpen) setViewerOpen(false); if (gitOpen) setGitOpen(false); if (dockerOpen) setDockerOpen(false); if (dbOpen) setDbOpen(false); if (scratchOpen) setScratchOpen(false); }
  if (!open && rhFiles) { try { lite.rh.fsClose(rhFiles.connId); } catch (_) {} rhFiles = null; if (rhView === 'files') rhView = rhSessions.length ? 'session' : 'list'; }
  const delta = layout.rh + GUTTER;
  rhOpen = open;
  $('#rh-pane').classList.toggle('hidden', !open);
  $('#gutter-rh').classList.toggle('hidden', !open);
  if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
  saveUiState();
  if (open) renderRhPanel();
  setTimeout(refitActiveTerminal, 150);
}
function saveRhUi() { persist('rhUi', rhUi); }

async function renderRhPanel() {
  const seq = ++rhRenderSeq;
  renderRhTabs(); // вкладки терминал-сессий видны во всех видах
  $('#rh-back').style.display = (rhView !== 'list') ? '' : 'none';
  const showSession = rhView === 'session' && rhActiveSession && rhTerms.has(rhActiveSession);
  $('#rh-conns').style.display = showSession ? 'none' : '';
  $('#rh-term').style.display = showSession ? 'block' : 'none';
  if (showSession) { $('#rh-title').textContent = rhTerms.get(rhActiveSession).name; showActiveRhSession(); return; }
  if (rhView === 'files' && rhFiles) { renderRhFiles(); return; }
  $('#rh-title').textContent = 'Удалённые хосты';
  const body = $('#rh-conns');
  body.innerHTML = '<div class="git-loading">Загрузка подключений…</div>';
  try { const r = await lite.rh.list(); rhConnsList = r.connections || []; rhSecure = r.secure !== false; }
  catch (_) { rhConnsList = []; }
  if (seq !== rhRenderSeq || !rhOpen) return;
  renderRhConnections(body);
}
// Вернуться к списку хостов; если был открыт браузер файлов — закрыть его соединение.
function rhGoList() { if (rhFiles) { try { lite.rh.fsClose(rhFiles.connId); } catch (_) {} rhFiles = null; } rhView = 'list'; renderRhPanel(); }
function renderRhConnections(body) {
  body.innerHTML = '';
  const top = el('div', 'db-topbar');
  top.appendChild(el('span', 'db-topbar-title', 'Подключения'));
  const add = iconBtn('drow-act', 'plus', 'Новое подключение', 16); add.onclick = () => rhConnModal(null);
  top.appendChild(add);
  body.appendChild(top);
  if (!rhSecure) body.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — секреты шифруются слабее (base64).'));
  if (!rhConnsList.length) { body.appendChild(el('div', 'docker-empty', 'Нет подключений. Добавь сервер по кнопке +')); return; }
  const groups = {};
  for (const c of rhConnsList) { const g = c.category || 'Все'; (groups[g] = groups[g] || []).push(c); }
  const cats = Object.keys(groups).sort((a, b) => (a === 'Все' ? -1 : b === 'Все' ? 1 : a.localeCompare(b)));
  for (const cat of cats) body.appendChild(rhCatBlock(cat, groups[cat]));
}
function rhCatBlock(cat, list) {
  const block = el('div', 'docker-group-block');
  const head = el('div', 'docker-group-head');
  const hue = dbCatHue(cat);
  head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
  head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
  const collapsed = !!(rhUi.catCollapsed && rhUi.catCollapsed[cat]);
  const chev = icon(collapsed ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
  head.append(chev, el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(list.length)));
  const bodyEl = el('div', 'docker-group-body');
  if (collapsed) bodyEl.style.display = 'none';
  for (const c of list) bodyEl.appendChild(rhConnRow(c));
  head.onclick = () => {
    rhUi.catCollapsed = rhUi.catCollapsed || {}; rhUi.catCollapsed[cat] = !rhUi.catCollapsed[cat]; saveRhUi();
    const col = rhUi.catCollapsed[cat]; bodyEl.style.display = col ? 'none' : '';
    const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev'); head.replaceChild(nc, head.firstChild);
  };
  block.append(head, bodyEl);
  return block;
}
function rhConnRow(c) {
  const row = el('div', 'db-conn-row clickable');
  row.appendChild(icon('globe', 16));
  const main = el('div', 'drow-main');
  const nameLine = el('div', 'rh-name-line');
  nameLine.appendChild(el('span', 'drow-name', c.name || '(без имени)'));
  if (rhSessions.some((sid) => { const r = rhTerms.get(sid); return r && r.connId === c.id; })) nameLine.appendChild(el('span', 'rh-live', 'на связи'));
  main.appendChild(nameLine);
  const proto = c.type === 'ftp' ? 'FTP' : c.type === 'sftp' ? 'SFTP' : 'SSH';
  const defPort = c.type === 'ftp' ? 21 : 22;
  const sub = `${proto} · ${c.user ? c.user + '@' : ''}${c.host || '—'}:${c.port || defPort}${c.auth && c.auth !== 'password' ? ' · без пароля' : ''}${c.keepalive && c.type !== 'ftp' ? ' · keepalive ' + (c.keepaliveSeconds || 30) + 'с' : ''}`;
  main.appendChild(el('span', 'drow-sub', sub));
  row.appendChild(main);
  const acts = el('div', 'drow-acts');
  const browse = iconBtn('drow-act', 'folder', 'Файлы (просмотр)', 14); browse.onclick = (e) => { e.stopPropagation(); rhOpenFiles(c); };
  const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13); edit.onclick = (e) => { e.stopPropagation(); rhConnModal(c); };
  const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
  del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить подключение?', `«${c.name}» удалится из списка.`, 'Удалить', async () => { await lite.rh.delete(c.id); renderRhPanel(); }); };
  acts.append(browse, edit, del); row.appendChild(acts);
  // один клик: SSH → терминал, SFTP/FTP → файлы (терминала у них нет)
  row.addEventListener('click', () => { if (c.type === 'ftp' || c.type === 'sftp') rhOpenFiles(c); else rhConnect(c); });
  return row;
}

// ---- add/edit connection modal (SSH, безопасно: пароль/ключ/passphrase, keepalive)
function rhConnModal(existing) {
  const c = existing ? { ...existing } : { type: 'ssh', auth: 'password', category: 'Все', port: 22, keepalive: true, keepaliveSeconds: 30 };
  const { m, close } = makeModal(`<h2>${existing ? 'Изменить' : 'Новое'} подключение</h2><div id="rhf" class="db-form"></div>`);
  m.classList.add('db-modal');
  const f = m.querySelector('#rhf');
  const field = (label, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, label)); w.appendChild(node); f.appendChild(w); return node; };
  const mk = (lbl, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, lbl)); w.appendChild(node); return w; };
  const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };

  const name = field('Имя', inp(c.name, 'Мой сервер'));
  const cat = field('Категория', inp(c.category || 'Все', 'Все'));
  // protocol
  const typeSel = el('select');
  for (const [k, v] of [['ssh', 'SSH — терминал + файлы (SFTP)'], ['sftp', 'SFTP — только файлы'], ['ftp', 'FTP — только файлы']]) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === (c.type || 'ssh')) o.selected = true; typeSel.appendChild(o); }
  field('Протокол', typeSel);
  // host group
  const hostWrap = el('div', 'db-group');
  const host = inp(c.host || '', 'example.com или IP');
  const port = inp(c.port || 22, '22', 'number');
  const user = inp(c.user || '', 'root');
  hostWrap.append(mk('Хост', host), mk('Порт', port), mk('Пользователь', user));
  f.appendChild(hostWrap);
  // auth method (SSH/SFTP — пароль или ключ; FTP — только пароль)
  const authSel = el('select');
  for (const [k, v] of [['password', 'Пароль'], ['agent', 'Без пароля (SSH-ключ из системы)']]) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === (c.auth || 'password')) o.selected = true; authSel.appendChild(o); }
  const authWrap = el('div', 'db-field'); authWrap.append(el('label', null, 'Аутентификация'), authSel); f.appendChild(authWrap);
  // password (режим «Пароль»)
  const passWrap = el('div', 'db-group');
  const pass = inp('', existing && c.hasPass ? '(сохранён — оставь пустым)' : 'пароль', 'password');
  passWrap.append(mk('Пароль', pass));
  f.appendChild(passWrap);
  // agent hint (режим «Без пароля») — ничего вводить не нужно
  const agentHint = el('div', 'rh-hint', 'Вход по SSH-ключу из системы (агент или ~/.ssh) — пароль и ключ вводить не нужно, как при `ssh user@host` в терминале.');
  f.appendChild(agentHint);
  // FTPS (TLS) — только для FTP
  const ftps = el('input'); ftps.type = 'checkbox'; ftps.checked = !!c.ftps;
  const ftpsLabel = el('label', 'db-check'); ftpsLabel.append(ftps, document.createTextNode(' FTPS — шифровать соединение (TLS)'));
  f.appendChild(ftpsLabel);
  const ftpsIns = el('input'); ftpsIns.type = 'checkbox'; ftpsIns.checked = !!c.ftpsInsecure;
  const ftpsInsLabel = el('label', 'db-check db-check-warn'); ftpsInsLabel.append(ftpsIns, document.createTextNode(' Доверять самоподписанному сертификату (небезопасно)'));
  f.appendChild(ftpsInsLabel);
  // keepalive (как в phpStorm: галочка + интервал) — для SSH/SFTP
  const kaOn = el('input'); kaOn.type = 'checkbox'; kaOn.checked = c.keepalive !== false;
  const kaLabel = el('label', 'db-check'); kaLabel.append(kaOn, document.createTextNode(' Держать соединение живым (keepalive)'));
  f.appendChild(kaLabel);
  const kaWrap = el('div', 'db-group');
  const kaSec = inp(c.keepaliveSeconds || 30, '30', 'number');
  kaWrap.append(mk('Слать запрос каждые, сек', kaSec));
  f.appendChild(kaWrap);

  const syncType = () => {
    const isFtp = typeSel.value === 'ftp';
    const isAgent = !isFtp && authSel.value === 'agent';
    authWrap.style.display = isFtp ? 'none' : '';      // FTP — только пароль
    passWrap.style.display = isAgent ? 'none' : '';
    agentHint.style.display = isAgent ? '' : 'none';
    ftpsLabel.style.display = isFtp ? '' : 'none';
    ftpsInsLabel.style.display = (isFtp && ftps.checked) ? '' : 'none';
    kaLabel.style.display = isFtp ? 'none' : '';        // FTP keepalive не нужен
    kaWrap.style.display = (!isFtp && kaOn.checked) ? '' : 'none';
  };
  typeSel.onchange = () => { const def = typeSel.value === 'ftp' ? 21 : 22; if (!port.value || port.value == 21 || port.value == 22) port.value = def; syncType(); };
  authSel.onchange = syncType; kaOn.onchange = syncType; ftps.onchange = syncType; syncType();

  const collect = () => {
    const isFtp = typeSel.value === 'ftp';
    const o = { id: c.id, name: name.value.trim(), category: cat.value.trim() || 'Все', type: typeSel.value, host: host.value.trim(), port: +port.value || (isFtp ? 21 : 22), user: user.value.trim(), auth: isFtp ? 'password' : authSel.value, keepalive: !isFtp && kaOn.checked, keepaliveSeconds: Math.max(2, +kaSec.value || 30) };
    if (isFtp) { o.ftps = ftps.checked; o.ftpsInsecure = ftps.checked && ftpsIns.checked; }
    if (o.auth === 'password' && pass.value) o.password = pass.value;
    return o;
  };
  const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
  const status = el('span', 'db-test-status');
  const test = el('button', 'btn', 'Тест');
  test.onclick = async () => { const o = collect(); if (!o.host) { status.textContent = '✕ укажи хост'; status.className = 'db-test-status err'; return; } status.textContent = 'Проверяю…'; status.className = 'db-test-status'; const r = await lite.rh.test(o); if (r.ok) { status.textContent = '✓ подключение успешно'; status.classList.add('ok'); } else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); } };
  const save = el('button', 'btn primary', 'Сохранить');
  save.onclick = async () => { const o = collect(); if (!o.name) { toast('Введи имя', { kind: 'err' }); return; } if (!o.host) { toast('Введи хост', { kind: 'err' }); return; } const r = await lite.rh.save(o); if (r && r.error) { toast(r.error, { kind: 'err' }); return; } close(); renderRhPanel(); };
  const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
  row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
}

// ---- sessions (live SSH terminals as tabs)
async function rhConnect(c) {
  const sessionId = 'rh::' + c.id + '::t' + (++rhSeq);
  const rec = createRhTerminal(sessionId, c.name || c.host, c.id);
  rhSessions.push(sessionId);
  rhActiveSession = sessionId;
  rhView = 'session';
  renderRhPanel();
  rec.term.write(`\x1b[90mПодключение к ${c.user ? c.user + '@' : ''}${c.host}:${c.port || 22}…\x1b[0m\r\n`);
  const r = await lite.rh.open(sessionId, c.id, rec.term.cols, rec.term.rows);
  if (r && r.error) rec.term.write(`\r\n\x1b[31m${r.error}\x1b[0m\r\n`);
}
function createRhTerminal(sessionId, name, connId) {
  const container = el('div', 'term-instance');
  $('#rh-term').appendChild(container);
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 8000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
  applyUnicode11(term);
  term.open(container);
  loadFastRenderer(term);
  fit.fit();
  term.onData((data) => lite.rh.write(sessionId, data));
  term.onResize(({ cols, rows }) => lite.rh.resize(sessionId, cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { closeRhSession(rhActiveSession); return false; }
    if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleRhTab(e.key === 'PageDown' ? 1 : -1); return false; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term);
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteRh(sessionId); return false; }
    return true;
  });
  const rec = { term, fit, search, container, name: name || 'SSH', connId };
  rhTerms.set(sessionId, rec);
  return rec;
}
async function pasteRh(sessionId) {
  const text = await lite.readClipboard();
  if (text) lite.rh.write(sessionId, text);
  const rec = rhTerms.get(sessionId); if (rec) { try { rec.term.focus(); } catch (_) {} }
}
function renderRhTabs() {
  const bar = $('#rh-tabs'); if (!bar) return;
  bar.style.display = rhSessions.length ? 'flex' : 'none';
  bar.innerHTML = '';
  rhSessions.forEach((sid) => {
    const rec = rhTerms.get(sid); if (!rec) return;
    const tab = el('div', 'tab' + (sid === rhActiveSession && rhView === 'session' ? ' active' : ''));
    tab.appendChild(el('span', 'rh-tab-dot'));
    tab.appendChild(el('span', 'tab-name', rec.name));
    const x = iconBtn('tab-close', 'x', 'Закрыть сессию (Ctrl+Shift+W)', 12);
    x.addEventListener('click', (e) => { e.stopPropagation(); closeRhSession(sid); });
    tab.appendChild(x);
    tab.addEventListener('click', () => switchRhTab(sid));
    bar.appendChild(tab);
  });
  const add = iconBtn('tab-add', 'plus', 'Подключиться к другому хосту', 15);
  add.addEventListener('click', () => rhGoList());
  bar.appendChild(add);
}
function switchRhTab(sid) { if (!rhTerms.has(sid)) return; rhActiveSession = sid; rhView = 'session'; renderRhPanel(); }
function showActiveRhSession() {
  for (const [sid, rec] of rhTerms) rec.container.style.display = sid === rhActiveSession ? 'block' : 'none';
  refitRhSession(true);
}
function refitRhSession(focusIt) {
  if (!rhOpen || rhView !== 'session' || !rhActiveSession) return;
  const rec = rhTerms.get(rhActiveSession); if (!rec) return;
  requestAnimationFrame(() => { try { rec.fit.fit(); lite.rh.resize(rhActiveSession, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {} });
}
function cycleRhTab(dir) {
  if (rhSessions.length < 2) return;
  let i = rhSessions.indexOf(rhActiveSession) + dir;
  if (i < 0) i = rhSessions.length - 1; if (i >= rhSessions.length) i = 0;
  switchRhTab(rhSessions[i]);
}
function closeRhSession(sid) {
  if (!sid) return;
  lite.rh.close(sid);
  const rec = rhTerms.get(sid);
  if (rec) { try { rec.term.dispose(); } catch (_) {} rec.container.remove(); rhTerms.delete(sid); }
  const i = rhSessions.indexOf(sid); if (i >= 0) rhSessions.splice(i, 1);
  if (rhActiveSession === sid) rhActiveSession = rhSessions[Math.max(0, i - 1)] || null;
  if (!rhSessions.length || !rhActiveSession) rhView = 'list';
  renderRhPanel();
}

// ---- file browser (read-only): SFTP (ssh/sftp) или FTP
function rhHumanSize(n) { if (!n && n !== 0) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB'; }
function rhJoin(base, name) {
  if (name === '..') { const b = String(base).replace(/\/+$/, ''); const i = b.lastIndexOf('/'); return i <= 0 ? '/' : b.slice(0, i); }
  return (base === '/' ? '' : String(base).replace(/\/+$/, '')) + '/' + name;
}
async function rhOpenFiles(c) {
  rhFiles = { connId: c.id, name: c.name || c.host, type: c.type || 'ssh', path: '~', entries: null, loading: true, file: null, error: null };
  rhView = 'files';
  renderRhPanel();
  await rhLoadDir('~');
}
async function rhLoadDir(p) {
  if (!rhFiles) return;
  const connId = rhFiles.connId;
  rhFiles.loading = true; rhFiles.file = null; rhFiles.error = null; renderRhFiles();
  const r = await lite.rh.fsList(connId, p);
  if (!rhFiles || rhFiles.connId !== connId || rhView !== 'files') return;
  rhFiles.loading = false;
  if (r.error) rhFiles.error = r.error;
  else { rhFiles.path = r.path; rhFiles.entries = r.entries; }
  renderRhFiles();
}
async function rhOpenFile(name) {
  if (!rhFiles) return;
  const connId = rhFiles.connId;
  const full = rhJoin(rhFiles.path, name);
  rhFiles.loading = true; renderRhFiles();
  const r = await lite.rh.fsRead(connId, full);
  if (!rhFiles || rhFiles.connId !== connId || rhView !== 'files') return;
  rhFiles.loading = false;
  rhFiles.file = { name, path: full, error: r.error, binary: r.binary, content: r.content, size: r.size };
  renderRhFiles();
}
function renderRhFiles() {
  if (!rhFiles) return;
  $('#rh-title').textContent = rhFiles.name;
  $('#rh-back').style.display = '';
  const body = $('#rh-conns');
  body.innerHTML = '';
  const bar = el('div', 'rh-fbar');
  const up = iconBtn('drow-act', 'chevron-up', 'Вверх', 14); up.onclick = () => rhLoadDir(rhJoin(rhFiles.path, '..'));
  const pathEl = el('span', 'rh-fpath', rhFiles.path || ''); pathEl.title = rhFiles.path || '';
  const refresh = iconBtn('drow-act', 'refresh', 'Обновить', 14); refresh.onclick = () => rhLoadDir(rhFiles.path);
  bar.append(up, pathEl, refresh);
  body.appendChild(bar);
  if (rhFiles.file) { renderRhFileContent(body); return; }
  if (rhFiles.loading) { body.appendChild(el('div', 'git-loading', 'Загрузка…')); return; }
  if (rhFiles.error) { body.appendChild(el('div', 'db-warn', '⚠ ' + rhFiles.error)); return; }
  const list = el('div', 'rh-flist');
  if (!rhFiles.entries || !rhFiles.entries.length) list.appendChild(el('div', 'docker-empty', 'Пусто'));
  for (const e of (rhFiles.entries || [])) {
    const r = el('div', 'rh-frow');
    r.appendChild(icon(e.dir ? 'folder' : 'file', 15));
    r.appendChild(el('span', 'rh-fname', e.name));
    if (!e.dir) r.appendChild(el('span', 'rh-fsize', rhHumanSize(e.size)));
    r.onclick = () => e.dir ? rhLoadDir(rhJoin(rhFiles.path, e.name)) : rhOpenFile(e.name);
    list.appendChild(r);
  }
  body.appendChild(list);
}
function renderRhFileContent(body) {
  const f = rhFiles.file;
  const head = el('div', 'rh-fchead');
  const back = iconBtn('drow-act', 'chevron-left', 'К списку файлов', 14); back.onclick = () => { rhFiles.file = null; renderRhFiles(); };
  head.append(back, icon('file', 14), el('span', 'rh-fcname', f.name));
  if (f.size != null) head.appendChild(el('span', 'rh-fsize', rhHumanSize(f.size)));
  body.appendChild(head);
  if (rhFiles.loading) { body.appendChild(el('div', 'git-loading', 'Загрузка…')); return; }
  if (f.error) { body.appendChild(el('div', 'db-warn', '⚠ ' + f.error)); return; }
  if (f.binary) { body.appendChild(el('div', 'docker-empty', 'Бинарный файл — просмотр недоступен')); return; }
  const pre = el('pre', 'rh-fview'); pre.textContent = f.content || '';
  body.appendChild(pre);
}

// ---------------------------------------------------------------- font size
let watchedRoot = null; // we live-watch only the active project to limit inotify use
function applyFontSize() {
  for (const rec of terms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
  for (const rec of scratchTerms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
  for (const rec of rhTerms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
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
    async () => { if (await saveCurrent()) proceed(); }, // failed save → stay put, don't lose edits
    'Не сохранять',
    () => { markDirty(false); proceed(); },
  );
}

function setActive(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  if (id === activeId && activeOrId === null) return;
  guardDirty(() => doSetActive(id));
}
function doSetActive(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  activeId = id;
  activeOrId = null; // selecting a project always leaves chat mode
  if (watchedRoot && watchedRoot !== proj.path) lite.fs.unwatch(watchedRoot);
  lite.fs.watch(proj.path); watchedRoot = proj.path;
  ensureProjectTabs(proj);
  renderProjects();
  showActiveTerminal();
  applyFontSize();
  if (viewerOpen) refreshViewerForActive();
  if (gitOpen) renderGitPanel(proj); // Git module follows the active project
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
// Миникарта (VSCode-стиль): уменьшенная копия кода справа с индикатором области и кликом-прыжком.
const minimapExt = showMinimap.compute([], () => ({
  create: () => ({ dom: document.createElement('div') }),
  displayText: 'blocks',     // быстрый блочный рендер вместо посимвольного
  showOverlay: 'always',     // всегда показывать рамку текущей области
}));
const minimapComp = new Compartment(); // вкл/выкл миникарты без пересоздания редактора
function toggleMinimap() {
  settings.minimap = !settings.minimap;
  saveSettings();
  if (editor) {
    editor.dispatch({ effects: minimapComp.reconfigure(settings.minimap ? minimapExt : []) });
    // При включении миникарта пустая, пока редактор не пере-замерит геометрию. Сработать заставляет только
    // реальное изменение размера панели вивера (ResizeObserver редактора) — повторяем это: на миг дёргаем
    // ширину панели на 1px и возвращаем (визуально незаметно).
    if (settings.minimap) {
      const pane = $('#viewer-pane'); const base = layout.viewer;
      pane.style.flexBasis = (base + 1) + 'px';
      setTimeout(() => { pane.style.flexBasis = base + 'px'; }, 60);
    }
  }
  $('#viewer-minimap').classList.toggle('on', settings.minimap);
}
function makeEditor() {
  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(), highlightActiveLine(), drawSelection(), history(),
      indentOnInput(), bracketMatching(), highlightSelectionMatches(), search({ top: true }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
      minimapComp.of(settings.minimap ? minimapExt : []),
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
  $('#viewer-full').style.display = (kind === 'html') ? '' : 'none'; // «на весь экран» только для HTML-вёрстки
  document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
  const row = document.querySelector(`.tree-row[data-path="${cssEscape(filePath)}"]`);
  if (row) row.classList.add('open');

  if (kind === 'image') { // binary — no editable source
    currentFile = filePath;
    setEditorText('', []); markDirty(false);
    await showPreview('image', filePath, '');
    return;
  }
  const res = await lite.fs.readFile(filePath);
  if (res.error) { setEditorText(`// ${res.error}`, []); currentFile = null; return; }
  currentFile = filePath;
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
  exitPreviewFull(); // на всякий случай свернуть полноэкранный режим
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
// «Превью HTML на весь экран» — оверлей поверх всего окна для быстрой проверки вёрстки (Esc / ✕ — выход).
async function enterPreviewFull() {
  if (previewKind(currentFile) !== 'html') return;
  if (!previewMode) await showPreview('html', currentFile, editor.state.doc.toString()); // включить превью, если смотрели исходник
  if (!$('#preview-full-exit')) {
    const btn = el('button', 'pf-exit', '✕ Esc');
    btn.id = 'preview-full-exit';
    btn.title = 'Выйти из полноэкранного превью (Esc)';
    btn.addEventListener('click', exitPreviewFull);
    document.body.appendChild(btn);
  }
  $('#preview-full-exit').style.display = '';
  document.body.classList.add('preview-full');
}
function exitPreviewFull() {
  if (!document.body.classList.contains('preview-full')) return;
  document.body.classList.remove('preview-full');
  const btn = $('#preview-full-exit');
  if (btn) btn.style.display = 'none';
}
function togglePreviewFull() {
  if (document.body.classList.contains('preview-full')) exitPreviewFull();
  else enterPreviewFull();
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
// Returns true when the file is safely on disk (or there was nothing to save), false on a
// failed write. Callers that gate a destructive next step (guardDirty) must NOT proceed on
// false, or the unsaved edits are lost.
async function saveCurrent() {
  if (!currentFile || !dirty) return true;
  let res;
  try { res = await lite.fs.writeFile(currentFile, editor.state.doc.toString()); }
  catch (e) { res = { error: String(e) }; }
  if (res && res.ok) { markDirty(false); return true; }
  toast(`Не удалось сохранить: ${(res && res.error) || 'ошибка записи'}`, { kind: 'err', ttl: 6000 });
  return false;
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
// Re-render the tree for the active project; viewer starts empty (no auto-reopen).
// Switching/opening a project always gives a clean viewer — open files from the tree.
// В режиме чата OpenRouter (activeOrId !== null) «выбранного проекта» нет → показываем заглушку.
async function refreshViewerForActive() {
  const p = (activeOrId === null) ? activeProject() : null;
  if (!p) { showViewerPlaceholder(); return; }
  await renderTree(p);
  clearViewer();
}
// Заглушка вивера, когда нет выбранного проекта (открыта категория/чат OpenRouter).
function showViewerPlaceholder() {
  $('#tree-title').textContent = 'ДЕРЕВО';
  const root = $('#tree');
  root.innerHTML = '';
  root.appendChild(el('div', 'tree-empty', 'Нужно выбрать проект для отображения файлов'));
  clearViewer();
}

function setViewerOpen(open, opts = {}) {
  if (open === viewerOpen) {
    if (open) refreshViewerForActive();
    renderProjects();
    return;
  }
  // Right slot holds one module — opening the viewer closes the others (chat is separate).
  if (open) { if (gitOpen) setGitOpen(false); if (dockerOpen) setDockerOpen(false); if (dbOpen) setDbOpen(false); if (scratchOpen) setScratchOpen(false); if (rhOpen) setRhOpen(false); }
  const delta = layout.viewer + layout.tree + GUTTER * 2;
  viewerOpen = open;
  $('#viewer-pane').classList.toggle('hidden', !open);
  $('#tree-pane').classList.toggle('hidden', !open);
  document.querySelectorAll('.gutter-v').forEach((g) => g.classList.toggle('hidden', !open));
  if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts these panes
  saveUiState();
  renderProjects();
  if (open) refreshViewerForActive();
  setTimeout(refitActiveTerminal, 150);
}

// ================================================================ right module slot
// One module open at a time in the right slot. NOT modules: terminals (project + scratch ~)
// and the OpenRouter chat (it replaces the terminal, its cards live in the project column).
// Modules: 'files' (viewer), 'git'. Mutual exclusion is enforced at each module's open path.
// Entry point used by the «Модули» menu.
function openModule(id) {
  if (id === 'files') { if (!viewerOpen) setViewerOpen(true); }
  else if (id === 'git') setGitOpen(true);
  else if (id === 'docker') setDockerOpen(true);
  else if (id === 'db') setDbOpen(true);
  else if (id === 'rh') setRhOpen(true);
  else if (id === 'scratch') setScratchOpen(true);
}

// ---------------------------------------------------------------- Git module (right pane)
function setGitOpen(open, opts = {}) {
  if (open && !activeProject() && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
  if (open === gitOpen) { if (open) renderGitPanel(activeProject()); return; }
  // Right slot holds one module — opening Git closes the others (chat is separate).
  if (open) { if (viewerOpen) setViewerOpen(false); if (dockerOpen) setDockerOpen(false); if (dbOpen) setDbOpen(false); if (scratchOpen) setScratchOpen(false); if (rhOpen) setRhOpen(false); }
  const delta = layout.git + GUTTER;
  gitOpen = open;
  $('#git-pane').classList.toggle('hidden', !open);
  $('#gutter-git').classList.toggle('hidden', !open);
  if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
  saveUiState();
  renderProjects();
  if (open) renderGitPanel(activeProject());
  setTimeout(refitActiveTerminal, 150);
}
function toggleGit() { setGitOpen(!gitOpen); }
// Open Git for a specific project: guard unsaved viewer edits, switch project FIRST, then
// open — so setGitOpen never runs against the old activeId while a save-prompt is up.
function openGitForProject(id) {
  guardDirty(() => { if (id !== activeId || activeOrId !== null) doSetActive(id); setGitOpen(true); });
}

// Render a unified diff string into a container, line-classed like the viewer's diff.
function renderDiffInto(view, text) {
  view.innerHTML = '';
  if (!text || !text.trim()) { view.appendChild(el('div', 'diff-empty', 'Нет изменений относительно HEAD.')); return; }
  for (const ln of text.split('\n')) {
    let cls = '';
    if (ln.startsWith('@@')) cls = 'hunk';
    else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'meta';
    else if (ln.startsWith('+')) cls = 'add';
    else if (ln.startsWith('-')) cls = 'del';
    view.appendChild(el('div', 'diff-line ' + cls, ln || ' '));
  }
}

// PhpStorm-style Git panel for project `p`. Bound to the active project; re-rendered on
// project switch (see doSetActive). Reuses lite.git.* — no new backend except git:log.
let gitRenderSeq = 0; // bumped on every render; a stale render (older seq) bails after its awaits
// Compact pill button for the Git toolbar (icon + optional label). Variants: 'primary' | 'ico' | 'danger'.
function gitTool(iconName, label, title, variant) {
  const b = el('button', 'git-tool' + (variant ? ' ' + variant : ''));
  b.appendChild(icon(iconName, 14));
  if (label) b.appendChild(el('span', null, label));
  if (title) b.title = title;
  return b;
}
async function renderGitPanel(p) {
  const body = $('#git-body');
  $('#git-proj').textContent = p ? `⎇ ${p.name}` : 'Git';
  if (!p) { body.innerHTML = ''; return; }
  const reqPath = p.path;
  const seq = ++gitRenderSeq;
  // Bail if a newer render started, Git closed, or the active project changed during an await.
  const stale = () => seq !== gitRenderSeq || !gitOpen || activeProject()?.path !== reqPath;
  body.innerHTML = '<div class="git-loading">Загрузка…</div>';
  const info = await lite.git.info(p.path);
  if (stale()) return;
  body.innerHTML = '';

  if (!info.repo) { // not a git repo → init / clone (same as the old modal)
    body.appendChild(el('div', 'gm-norepo', 'Это не git-репозиторий.'));
    const row = el('div', 'gm-actions');
    const init = el('button', 'btn primary', '⎇ git init');
    init.onclick = async () => {
      const r = await lite.git.init(p.path);
      if (r.ok) { toast('git init готов'); renderGitPanel(p); renderProjects(); }
      else toast(r.error || 'ошибка init', { kind: 'err', ttl: 7000 });
    };
    row.append(init); body.appendChild(row);
    body.appendChild(el('div', 'gm-or', 'или клонировать репозиторий в эту папку'));
    const cloneRow = el('div', 'gm-actions');
    const url = el('input', 'gm-cloneurl'); url.type = 'text';
    url.placeholder = 'URL репозитория (https://… или git@…)';
    const clone = el('button', 'btn', '⬇ git clone');
    const doClone = async () => {
      const u = url.value.trim();
      if (!u) { toast('Введи URL репозитория', { kind: 'err' }); return; }
      clone.disabled = true; const lbl = clone.textContent; clone.textContent = 'Клонирую…';
      const r = await lite.git.clone(p.path, u);
      clone.disabled = false; clone.textContent = lbl;
      if (r.ok) { toast('Репозиторий склонирован'); renderGitPanel(p); renderProjects(); if (p.id === activeId) refreshTree(); }
      else toast(r.error || 'ошибка clone', { kind: 'err', ttl: 9000 });
    };
    clone.onclick = doClone;
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doClone(); });
    cloneRow.append(url, clone); body.appendChild(cloneRow);
    return;
  }

  // --- Branch row: switch + manager + ahead/behind
  const head = el('div', 'gm-branch');
  const sel = el('select', 'gm-branchsel');
  const brs = info.branches && info.branches.length ? info.branches : [info.branch];
  for (const b of brs) { const o = document.createElement('option'); o.value = b; o.textContent = '⎇ ' + b; if (b === info.branch) o.selected = true; sel.appendChild(o); }
  sel.onchange = async () => {
    const r = await lite.git.checkout(p.path, sel.value);
    if (r.ok) toast('Ветка: ' + sel.value); else toast(r.error || 'не удалось переключить', { kind: 'err', ttl: 8000 });
    renderGitPanel(p); renderProjects();
  };
  head.appendChild(sel);
  const mgr = el('button', 'gm-mini', '⎇'); mgr.title = 'Ветки: переключить · обновить без перехода · новая от ветки';
  mgr.onclick = () => showBranches(body, p, () => renderGitPanel(p));
  head.appendChild(mgr);
  if (info.upstream && (info.ahead || info.behind)) head.appendChild(el('span', 'gm-track', `↑${info.ahead} ↓${info.behind}`));
  body.appendChild(head);

  // --- Changes section (click a file → inline diff)
  const st = await lite.git.status(p.path);
  if (stale()) return;
  const files = (st && st.files) ? st.files : {};
  const keys = Object.keys(files);
  const chHead = el('div', 'git-sec git-sec-row');
  chHead.appendChild(el('span', null, 'Изменения' + (keys.length ? ` · ${keys.length}` : '')));
  if (keys.length) {
    const discAll = gitTool('eraser', null, 'Откатить все правки (git checkout -- .)', 'ico danger');
    discAll.onclick = () => showConfirm('Откатить все правки?', 'Изменения во всех отслеживаемых файлах будут отменены. Новые (неотслеживаемые) файлы останутся на месте.', 'Откатить всё', async () => {
      const rr = await lite.git.discardAll(p.path);
      if (rr.ok) { toast('Правки откачены'); renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
    });
    chHead.appendChild(discAll);
  }
  body.appendChild(chHead);
  const diffView = el('div', 'git-diff'); diffView.style.display = 'none';
  const changes = el('div', 'gm-changes');
  if (!keys.length) changes.appendChild(el('div', 'gm-clean', '✓ Рабочее дерево чистое.'));
  else for (const f of keys) {
    const r = el('div', 'gm-file'); r.title = f;
    r.appendChild(el('span', 'gm-code ' + gitCodeClass(files[f]), files[f]));
    const name = el('span', 'gm-fname', baseName(f)); r.appendChild(name);
    const disc = el('button', 'gm-mini gm-disc', '↩'); disc.title = 'Откатить изменения файла';
    disc.onclick = (e) => { e.stopPropagation(); showConfirm('Откатить файл?', `Изменения в «${baseName(f)}» будут отменены (git checkout --).`, 'Откатить', async () => {
      const rr = await lite.git.discardFile(p.path, f);
      if (rr.ok) { renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
    }); };
    r.appendChild(disc);
    r.addEventListener('click', async () => {
      const wasOpen = r.classList.contains('open');
      changes.querySelectorAll('.gm-file.open').forEach((x) => x.classList.remove('open'));
      if (wasOpen) { diffView.style.display = 'none'; return; }
      r.classList.add('open');
      diffView.style.display = 'block';
      diffView.innerHTML = '<div class="git-loading">Загрузка диффа…</div>';
      const d = await lite.git.fileDiff(p.path, f);
      renderDiffInto(diffView, d && d.diff);
    });
    changes.appendChild(r);
  }
  body.appendChild(changes);
  body.appendChild(diffView);

  // --- Commit box
  const msg = el('textarea', 'gm-msg'); msg.placeholder = 'Сообщение коммита…';
  body.appendChild(msg);
  // commit row: compact primary + push variant
  const commitRow = el('div', 'git-tools');
  const commit = gitTool('check', 'Commit', 'Закоммитить все изменения', 'primary');
  const commitPush = gitTool('upload', 'Commit & Push', 'Закоммитить и сразу запушить');
  commit.disabled = !keys.length; commitPush.disabled = !keys.length;
  const doCommit = async (withPush) => {
    const message = msg.value.trim();
    if (!message) { toast('Введи сообщение коммита', { kind: 'err' }); return; }
    const r = await lite.git.commit(p.path, message, withPush);
    if (r.ok) { toast(withPush ? 'Закоммичено и запушено' : 'Закоммичено'); msg.value = ''; renderGitPanel(p); renderProjects(); }
    else toast(r.error || 'ошибка коммита', { kind: 'err', ttl: 8000 });
  };
  commit.onclick = () => doCommit(false);
  commitPush.onclick = () => doCommit(true);
  commitRow.append(commit, commitPush);
  body.appendChild(commitRow);

  // sync row: fetch / pull / push, then stash group — neat icon pills
  const syncRow = el('div', 'git-tools');
  const fetchBtn = gitTool('refresh', 'Fetch', 'git fetch --all --prune');
  const pull = gitTool('download', 'Pull', 'git pull --ff-only');
  const push = gitTool('upload', 'Push', 'git push');
  const stash = gitTool('layers', 'Stash', 'Спрятать все изменения (git stash -u)');
  const stashPop = gitTool('archive', 'Pop', 'Вернуть последний stash (git stash pop)');
  stash.disabled = !keys.length;
  fetchBtn.onclick = async () => { const r = await lite.git.fetch(p.path); toast(r.ok ? 'Fetch готов' : (r.error || 'fetch не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); };
  push.onclick = async () => { const r = await lite.git.push(p.path); toast(r.ok ? 'Запушено' : (r.error || 'push не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); };
  pull.onclick = async () => { const r = await lite.git.pull(p.path); toast(r.ok ? 'Pull готов' : (r.error || 'pull не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); };
  stash.onclick = async () => { const r = await lite.git.stash(p.path); toast(r.ok ? 'Изменения спрятаны в stash' : (r.error || 'stash не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); };
  stashPop.onclick = async () => { const r = await lite.git.stashPop(p.path); toast(r.ok ? 'Stash возвращён' : (r.error || 'нет stash или конфликт'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); };
  syncRow.append(fetchBtn, pull, push, el('span', 'git-tsep'), stash, stashPop);
  body.appendChild(syncRow);

  // --- Commit history log (git:log)
  body.appendChild(el('div', 'git-sec', 'История'));
  const logBox = el('div', 'git-log');
  logBox.appendChild(el('div', 'git-loading', 'Загрузка истории…'));
  body.appendChild(logBox);
  const lg = await lite.git.log(p.path, 40);
  if (stale()) return;
  logBox.innerHTML = '';
  const commits = (lg && lg.commits) ? lg.commits : [];
  if (!commits.length) logBox.appendChild(el('div', 'gm-clean', 'Пока нет коммитов.'));
  else for (const c of commits) {
    const cr = el('div', 'git-commit'); cr.title = `${c.subject}\n${c.hash} · клик — скопировать хеш`;
    cr.appendChild(el('span', 'gm-hash', c.hash));
    cr.appendChild(el('span', 'git-csubj', c.subject));
    cr.appendChild(el('span', 'gm-meta', `${c.when} · ${c.author}`));
    if (c.refs) cr.appendChild(el('span', 'git-refs', c.refs));
    cr.addEventListener('click', () => { lite.copyText(c.hash); toast('Хеш скопирован: ' + c.hash); });
    logBox.appendChild(cr);
  }
}

// ================================================================ Containers module (docker/podman)
// System-wide (not per-project) right-pane manager: tabs Docker|Podman, accordion sections for
// containers (grouped by compose project), pods (podman), images, volumes, with lifecycle actions.
let dockerEngine = 'docker';   // active tab
let dockerDetect = null;        // cached {docker:{cli,compose,composePlugin}, podman:{...}}
let dockerRenderSeq = 0;        // stale-render guard
const dockerAcc = { containers: true, pods: true, images: false, volumes: false }; // accordion open state
// Persisted per-engine group order + collapse: { order:{engine:[names]}, collapsed:{'engine:name':bool} }
let dockerUi = (STORE.dockerUi && typeof STORE.dockerUi === 'object') ? STORE.dockerUi : {};
let dockerView = 'list';        // 'list' | 'detail'
let dockerDetail = null;        // { id, name, engine, state } when viewing one container
let dockerDetailTab = 'logs';   // 'logs' | 'term'
let dockerLogId = null, dockerExecId = null, dockerExecTerm = null, dockerExecFit = null;
const dockerDetailUnsub = [];   // IPC listener cleanups for the open detail view

function dockerGroupOrder(engine, names) { // saved order first, new groups appended (alpha)
  const saved = (dockerUi.order && dockerUi.order[engine]) || [];
  const head = saved.filter((n) => names.includes(n));
  const tail = names.filter((n) => !head.includes(n)).sort((a, b) => a.localeCompare(b));
  return [...head, ...tail];
}
function moveDockerGroup(engine, name, dir, allNames) {
  const order = dockerGroupOrder(engine, allNames);
  const i = order.indexOf(name), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  dockerUi.order = dockerUi.order || {}; dockerUi.order[engine] = order; persist('dockerUi', dockerUi);
  renderDockerPanel();
}
function dockerGroupCollapsed(engine, name) { return !!(dockerUi.collapsed && dockerUi.collapsed[engine + ':' + name]); }
function toggleDockerGroup(engine, name) {
  dockerUi.collapsed = dockerUi.collapsed || {}; const k = engine + ':' + name;
  dockerUi.collapsed[k] = !dockerUi.collapsed[k]; persist('dockerUi', dockerUi);
}
function dockerGroupHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
// Strip ANSI/OSC so container logs render cleanly in a <pre>.
function stripAnsiSeq(s) { return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); }

function setDockerOpen(open, opts = {}) {
  if (open === dockerOpen) { if (open) renderDockerPanel(); return; }
  if (!open) { closeDockerDetail(); dockerView = 'list'; } // tear down logs/exec on close
  // Right slot holds one module — opening Docker closes the others (chat is separate).
  if (open) { if (viewerOpen) setViewerOpen(false); if (gitOpen) setGitOpen(false); if (dbOpen) setDbOpen(false); if (scratchOpen) setScratchOpen(false); if (rhOpen) setRhOpen(false); }
  const delta = layout.docker + GUTTER;
  dockerOpen = open;
  $('#docker-pane').classList.toggle('hidden', !open);
  $('#gutter-docker').classList.toggle('hidden', !open);
  if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
  saveUiState();
  if (open) renderDockerPanel();
  setTimeout(refitActiveTerminal, 150);
}
function toggleDocker() { setDockerOpen(!dockerOpen); }

function renderDockerTabs() {
  const t = $('#docker-tabs'); t.innerHTML = '';
  for (const e of ['docker', 'podman']) {
    const installed = dockerDetect ? !!(dockerDetect[e] && dockerDetect[e].cli) : true;
    const tab = el('button', 'docker-tab' + (e === dockerEngine ? ' on' : '') + (installed ? '' : ' off'));
    tab.appendChild(icon('box', 15));
    tab.appendChild(el('span', null, e === 'docker' ? 'Docker' : 'Podman'));
    tab.onclick = () => { if (e !== dockerEngine) { dockerEngine = e; renderDockerPanel(); } };
    t.appendChild(tab);
  }
}
// Versions strip for the active engine: cli + compose plugin (no dash) + legacy compose (dash).
function renderDockerEnv(eng) {
  const box = el('div', 'docker-env');
  const rows = dockerEngine === 'docker'
    ? [['docker', eng.cli], ['docker compose', eng.composePlugin], ['docker-compose', eng.compose]]
    : [['podman', eng.cli], ['podman compose', eng.composePlugin], ['podman-compose', eng.compose]];
  for (const [label, ver] of rows) {
    const r = el('div', 'docker-env-row');
    r.appendChild(el('span', 'denv-k', label));
    r.appendChild(el('span', 'denv-v' + (ver ? '' : ' missing'), ver || 'не установлено'));
    box.appendChild(r);
  }
  return box;
}
function dStateClass(s) {
  s = String(s || '').toLowerCase();
  if (s.includes('run')) return 'run';
  if (s.includes('paus')) return 'pause';
  if (s.includes('dead')) return 'dead';
  return 'stop';
}
// Collapsible section with a count badge; `fill(inner)` populates the body.
function dockerAccordion(key, iconName, title, count, fill) {
  const sec = el('div', 'docker-sec');
  const head = el('button', 'docker-sec-head');
  const chev = icon(dockerAcc[key] ? 'chevron-down' : 'chevron-right', 14); chev.classList.add('dsec-chev');
  head.appendChild(chev);
  head.appendChild(icon(iconName, 15));
  head.appendChild(el('span', 'dsec-title', title));
  head.appendChild(el('span', 'dsec-count', String(count)));
  const inner = el('div', 'docker-sec-body');
  if (!dockerAcc[key]) inner.style.display = 'none';
  fill(inner);
  head.onclick = () => {
    dockerAcc[key] = !dockerAcc[key];
    inner.style.display = dockerAcc[key] ? '' : 'none';
    const nc = icon(dockerAcc[key] ? 'chevron-down' : 'chevron-right', 14); nc.classList.add('dsec-chev');
    head.replaceChild(nc, head.firstChild);
  };
  sec.append(head, inner);
  return sec;
}
async function dockerDo(kind, action, id, label) {
  let r;
  try { r = await lite.containers.action(dockerEngine, kind, action, id); } catch (e) { r = { ok: false, error: String(e) }; }
  if (r && r.ok) { toast((label || 'Готово') + ' ✓'); renderDockerPanel(); }
  else toast((r && r.error) || 'Команда не выполнена', { kind: 'err', ttl: 8000 });
}
function dActBtn(kind, action, iconName, title, id, size) {
  const b = iconBtn('drow-act', iconName, title, size || 14);
  b.onclick = (e) => { e.stopPropagation(); dockerDo(kind, action, id, title); };
  return b;
}
function dRemoveBtn(kind, id, label, force, extra) {
  const b = iconBtn('drow-act danger', 'trash', 'Удалить', 14);
  b.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить?', `«${label}» будет удалён${force ? ' (принудительно — объект запущен)' : ''}.${extra || ''}`, 'Удалить', () => dockerDo(kind, 'remove', id, 'Удаление')); };
  return b;
}
function dockerContainerRow(c) {
  const row = el('div', 'docker-row');
  const dot = el('span', 'dstate dstate-' + dStateClass(c.state)); dot.title = c.status || c.state || '';
  row.appendChild(dot);
  const main = el('div', 'drow-main');
  main.appendChild(el('span', 'drow-name', c.service || c.name || String(c.id).slice(0, 12)));
  main.appendChild(el('span', 'drow-sub', [c.image, c.ports].filter(Boolean).join('   ·   ')));
  row.appendChild(main);
  const acts = el('div', 'drow-acts');
  const running = c.state === 'running', paused = c.state === 'paused';
  if (running) {
    acts.appendChild(dActBtn('container', 'pause', 'pause', 'Пауза', c.id));
    acts.appendChild(dActBtn('container', 'restart', 'refresh', 'Перезапуск', c.id));
    acts.appendChild(dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
  } else if (paused) {
    acts.appendChild(dActBtn('container', 'unpause', 'play', 'Возобновить', c.id));
    acts.appendChild(dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
  } else {
    acts.appendChild(dActBtn('container', 'start', 'play', 'Старт', c.id));
  }
  acts.appendChild(dRemoveBtn('container', c.id, c.service || c.name || c.id, running));
  row.appendChild(acts);
  row.classList.add('clickable'); row.title = 'Открыть: логи и терминал';
  row.addEventListener('click', () => openDockerDetail(c));
  return row;
}
function dockerPodRow(p) {
  const row = el('div', 'docker-row');
  const dot = el('span', 'dstate dstate-' + dStateClass(p.status)); dot.title = p.status || '';
  row.appendChild(dot);
  const main = el('div', 'drow-main');
  main.appendChild(el('span', 'drow-name', p.name || String(p.id).slice(0, 12)));
  main.appendChild(el('span', 'drow-sub', `${p.containers} контейнер(ов)   ·   ${p.status || ''}`));
  row.appendChild(main);
  const acts = el('div', 'drow-acts');
  const running = p.status === 'running' || p.status === 'degraded';
  if (running) acts.appendChild(dActBtn('pod', 'stop', 'stop', 'Стоп пода', p.id));
  else acts.appendChild(dActBtn('pod', 'start', 'play', 'Старт пода', p.id));
  acts.appendChild(dRemoveBtn('pod', p.id, p.name || p.id, running));
  row.appendChild(acts);
  return row;
}
function dockerImageRow(im) {
  const row = el('div', 'docker-row');
  row.appendChild(icon('layers', 15));
  const main = el('div', 'drow-main');
  main.appendChild(el('span', 'drow-name', (im.repo || '<none>') + (im.tag ? ':' + im.tag : '')));
  main.appendChild(el('span', 'drow-sub', [im.size, im.created].filter(Boolean).join('   ·   ')));
  row.appendChild(main);
  const acts = el('div', 'drow-acts');
  acts.appendChild(dRemoveBtn('image', im.id, (im.repo || '<none>') + (im.tag ? ':' + im.tag : ''), false));
  row.appendChild(acts);
  return row;
}
function dockerVolumeRow(vo) {
  const row = el('div', 'docker-row');
  row.appendChild(icon('database', 15));
  const main = el('div', 'drow-main');
  main.appendChild(el('span', 'drow-name', vo.name));
  main.appendChild(el('span', 'drow-sub', vo.driver || ''));
  row.appendChild(main);
  const acts = el('div', 'drow-acts');
  acts.appendChild(dRemoveBtn('volume', vo.name, vo.name, false, ' Данные тома будут потеряны.'));
  row.appendChild(acts);
  return row;
}
function dockerSectionList(box, payload, iconName, title, key, rowFn, emptyText) {
  const items = (payload && payload.items) || [];
  box.appendChild(dockerAccordion(key, iconName, title, items.length, (inner) => {
    if (payload && payload.error) { inner.appendChild(el('div', 'docker-err', payload.error)); return; }
    if (!items.length) { inner.appendChild(el('div', 'docker-empty', emptyText)); return; }
    for (const it of items) inner.appendChild(rowFn(it));
  }));
}
async function dockerBulk(engine, action, ids, label) {
  if (!ids.length) return;
  let r; try { r = await lite.containers.bulk(engine, action, ids); } catch (e) { r = { ok: false, error: String(e) }; }
  if (r && r.ok) { toast((label || 'Готово') + ' ✓'); renderDockerPanel(); }
  else toast((r && r.error) || 'Не выполнено', { kind: 'err', ttl: 9000 });
}
function dGroupAct(action, iconName, title, engine, ids) {
  const b = iconBtn('drow-act', iconName, title, 13);
  b.onclick = (e) => { e.stopPropagation(); dockerBulk(engine, action, ids, title); };
  return b;
}
// One compose group: gradient header (collapsible) + bulk actions + sort arrows + container rows.
function dockerGroupBlock(engine, name, list, allNames) {
  const block = el('div', 'docker-group-block');
  const head = el('div', 'docker-group-head');
  const hue = dockerGroupHue(name || 'misc');
  head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
  head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
  const chev = icon(dockerGroupCollapsed(engine, name) ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
  head.appendChild(chev);
  head.appendChild(el('span', 'dgrp-name', name || 'Без группы'));
  head.appendChild(el('span', 'dgrp-count', String(list.length)));
  const acts = el('div', 'dgrp-acts');
  const ids = list.map((c) => c.id);
  acts.appendChild(dGroupAct('start', 'play', 'Старт всех', engine, ids));
  acts.appendChild(dGroupAct('pause', 'pause', 'Пауза всех', engine, ids));
  acts.appendChild(dGroupAct('stop', 'stop', 'Стоп всех', engine, ids));
  const rm = iconBtn('drow-act danger', 'trash', 'Удалить всю группу', 13);
  rm.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить группу?', `Все контейнеры группы «${name || 'без группы'}» (${list.length} шт.) будут удалены принудительно.`, 'Удалить', () => dockerBulk(engine, 'remove', ids, 'Удаление группы')); };
  acts.appendChild(rm);
  if (name) { // sort arrows only for real compose groups (ungrouped stays last)
    const up = iconBtn('drow-act', 'chevron-up', 'Поднять группу', 13); up.onclick = (e) => { e.stopPropagation(); moveDockerGroup(engine, name, -1, allNames); };
    const dn = iconBtn('drow-act', 'chevron-down', 'Опустить группу', 13); dn.onclick = (e) => { e.stopPropagation(); moveDockerGroup(engine, name, 1, allNames); };
    acts.append(up, dn);
  }
  head.appendChild(acts);
  const body = el('div', 'docker-group-body');
  if (dockerGroupCollapsed(engine, name)) body.style.display = 'none';
  for (const c of list) body.appendChild(dockerContainerRow(c));
  head.onclick = () => {
    toggleDockerGroup(engine, name);
    const col = dockerGroupCollapsed(engine, name);
    body.style.display = col ? 'none' : '';
    const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev');
    head.replaceChild(nc, head.firstChild);
  };
  block.append(head, body);
  return block;
}
function renderDockerDisk(df) {
  const box = el('div', 'docker-disk');
  box.appendChild(icon('database', 13));
  const parts = [['Образы', df.images], ['Контейнеры', df.containers], ['Тома', df.volumes], ['Кэш', df.cache]].filter((p) => p[1]);
  if (!parts.length) { box.appendChild(el('span', 'ddisk-k', 'диск: н/д')); return box; }
  for (const [k, v] of parts) { const seg = el('span', 'ddisk-seg'); seg.appendChild(el('span', 'ddisk-k', k)); seg.appendChild(el('span', 'ddisk-v', v)); box.appendChild(seg); }
  return box;
}
function renderDockerSections(box, data) {
  if (data.df && !data.df.error) box.appendChild(renderDockerDisk(data.df));
  const cont = (data.containers && data.containers.items) || [];
  box.appendChild(dockerAccordion('containers', 'box', 'Контейнеры', cont.length, (inner) => {
    if (data.containers && data.containers.error) { inner.appendChild(el('div', 'docker-err', data.containers.error)); return; }
    if (!cont.length) { inner.appendChild(el('div', 'docker-empty', 'Нет контейнеров.')); return; }
    const groups = {};
    for (const c of cont) { const g = c.project || ''; (groups[g] = groups[g] || []).push(c); }
    const named = Object.keys(groups).filter((g) => g);
    const order = dockerGroupOrder(dockerEngine, named);
    for (const g of order) inner.appendChild(dockerGroupBlock(dockerEngine, g, groups[g], order));
    if (groups['']) inner.appendChild(dockerGroupBlock(dockerEngine, '', groups[''], order)); // ungrouped last
  }));
  if (dockerEngine === 'podman') dockerSectionList(box, data.pods, 'grid', 'Поды', 'pods', dockerPodRow, 'Нет подов.');
  dockerSectionList(box, data.images, 'layers', 'Образы', 'images', dockerImageRow, 'Нет образов.');
  dockerSectionList(box, data.volumes, 'database', 'Тома', 'volumes', dockerVolumeRow, 'Нет томов.');
}
// --- container detail view (live logs + interactive exec terminal), inside the module pane
function openDockerDetail(c) {
  closeDockerDetail();
  dockerDetail = { id: c.id, name: c.service || c.name || String(c.id).slice(0, 12), engine: dockerEngine, state: c.state };
  dockerView = 'detail';
  dockerDetailTab = 'logs';
  renderDockerDetail();
}
function closeDockerDetail() { // stop streams, kill exec PTY, dispose xterm, drop listeners
  for (const u of dockerDetailUnsub.splice(0)) { try { u(); } catch (_) {} }
  if (dockerLogId) { try { lite.containers.logsStop(dockerLogId); } catch (_) {} dockerLogId = null; }
  if (dockerExecId) { try { lite.containers.execKill(dockerExecId); } catch (_) {} dockerExecId = null; }
  if (dockerExecTerm) { try { dockerExecTerm.dispose(); } catch (_) {} dockerExecTerm = null; dockerExecFit = null; }
  dockerDetail = null;
}
function backToDockerList() { closeDockerDetail(); dockerView = 'list'; renderDockerPanel(); }
function startDockerLogs(view) {
  view.innerHTML = '';
  const pre = el('pre', 'docker-logs'); view.appendChild(pre);
  const d = dockerDetail; if (!d) return;
  const sid = 'log' + (++dockerRenderSeq) + Date.now().toString(36); dockerLogId = sid;
  const unData = lite.containers.onLogsData((p) => {
    if (p.streamId !== sid) return;
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.appendChild(document.createTextNode(stripAnsiSeq(p.data)));
    while (pre.childNodes.length > 3000) pre.removeChild(pre.firstChild);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  });
  const unExit = lite.containers.onLogsExit((p) => { if (p.streamId === sid) pre.appendChild(document.createTextNode('\n— поток логов завершён —\n')); });
  dockerDetailUnsub.push(unData, unExit);
  lite.containers.logsStart(d.engine, d.id, sid, 800).then((r) => { if (r && r.error) pre.appendChild(document.createTextNode('[ошибка: ' + r.error + ']')); });
}
function startDockerExec(view) {
  view.innerHTML = '';
  const wrap = el('div', 'docker-term'); view.appendChild(wrap);
  const d = dockerDetail; if (!d) return;
  const term = new Terminal({ fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace', fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 3000 });
  const fit = new FitAddon(); term.loadAddon(fit);
  applyUnicode11(term);
  term.open(wrap);
  loadFastRenderer(term);
  try { fit.fit(); } catch (_) {}
  dockerExecTerm = term; dockerExecFit = fit;
  const xid = 'cx' + (++dockerRenderSeq) + Date.now().toString(36); dockerExecId = xid;
  const unData = lite.containers.onExecData((p) => { if (p.execId === xid) term.write(p.data); });
  const unExit = lite.containers.onExecExit((p) => { if (p.execId === xid) term.write('\r\n\x1b[33m— сеанс завершён —\x1b[0m\r\n'); });
  dockerDetailUnsub.push(unData, unExit);
  term.onData((data) => lite.containers.execWrite(xid, data));
  term.onResize(({ cols, rows }) => lite.containers.execResize(xid, cols, rows));
  lite.containers.execStart(d.engine, d.id, xid, term.cols, term.rows).then((r) => { if (r && r.error) term.write('\r\n\x1b[31m' + r.error + '\x1b[0m\r\n'); });
  setTimeout(() => { try { fit.fit(); term.focus(); } catch (_) {} }, 40);
}
function renderDockerDetail() {
  const d = dockerDetail; if (!d) { dockerView = 'list'; renderDockerPanel(); return; }
  $('#docker-tabs').style.display = 'none';
  const body = $('#docker-body'); body.innerHTML = '';
  const head = el('div', 'docker-detail-head');
  const back = iconBtn('drow-act', 'chevron-left', 'Назад к списку', 16);
  back.onclick = backToDockerList;
  head.appendChild(back);
  head.appendChild(el('span', 'dstate dstate-' + dStateClass(d.state)));
  head.appendChild(el('span', 'docker-detail-name', d.name));
  body.appendChild(head);
  const tabsEl = el('div', 'docker-subtabs');
  const logsView = el('div', 'docker-detail-view');
  const termView = el('div', 'docker-detail-view');
  let logsStarted = false, execStarted = false;
  const show = (k) => {
    dockerDetailTab = k;
    tabsEl.querySelectorAll('.docker-subtab').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    logsView.style.display = k === 'logs' ? '' : 'none';
    termView.style.display = k === 'term' ? '' : 'none';
    if (k === 'logs' && !logsStarted) { logsStarted = true; startDockerLogs(logsView); }
    else if (k === 'term' && !execStarted) { execStarted = true; startDockerExec(termView); }
    else if (k === 'term' && dockerExecFit) setTimeout(() => { try { dockerExecFit.fit(); dockerExecTerm && dockerExecTerm.focus(); } catch (_) {} }, 30);
  };
  for (const [k, label] of [['logs', 'Логи'], ['term', 'Терминал']]) {
    const t = el('button', 'docker-subtab'); t.dataset.k = k; t.textContent = label; t.onclick = () => show(k); tabsEl.appendChild(t);
  }
  body.append(tabsEl, logsView, termView);
  show(dockerDetailTab || 'logs');
}
async function renderDockerPanel() {
  if (dockerView === 'detail') { closeDockerDetail(); dockerView = 'list'; }
  $('#docker-tabs').style.display = '';
  const seq = ++dockerRenderSeq;
  const body = $('#docker-body');
  if (!dockerDetect) { // probe both engines once (cached; ⟳ resets it)
    body.innerHTML = '<div class="git-loading">Поиск Docker / Podman…</div>';
    try { dockerDetect = await lite.containers.detect(); } catch (_) { dockerDetect = { docker: {}, podman: {} }; }
    if (seq !== dockerRenderSeq || !dockerOpen) return;
  }
  renderDockerTabs();
  const eng = dockerDetect[dockerEngine] || {};
  body.innerHTML = '';
  body.appendChild(renderDockerEnv(eng));
  if (!eng.cli) { // engine CLI not found
    const notice = el('div', 'docker-notice');
    notice.appendChild(icon('warning', 26));
    notice.appendChild(el('div', 'docker-notice-t', (dockerEngine === 'docker' ? 'Docker' : 'Podman') + ' не установлен'));
    notice.appendChild(el('div', 'docker-notice-s', 'CLI не найден в системе. Установи и нажми ⟳ для повторной проверки.'));
    body.appendChild(notice);
    return;
  }
  const listBox = el('div', 'docker-list');
  listBox.appendChild(el('div', 'git-loading', 'Считываю объекты…'));
  body.appendChild(listBox);
  let data;
  try { data = await lite.containers.list(dockerEngine); } catch (e) { data = { containers: { error: String(e) } }; }
  if (seq !== dockerRenderSeq || !dockerOpen) return;
  listBox.innerHTML = '';
  if (data.error) { listBox.appendChild(el('div', 'docker-err', data.error)); return; }
  renderDockerSections(listBox, data);
}

// ================================================================ Database module (Postgres/MySQL/SQLite)
// Right-pane lightweight DB client: connections grouped by category, schema tree, table data
// grid, SQL console (CodeMirror) and CSV/JSON/SQL export. Drivers live in main (lib/db.js).
let dbConnsList = [], dbSecure = true;
let dbActiveId = null, dbActiveConn = null, dbSchema = null;
let dbWsTab = 'tree', dbTableSel = null, dbSqlEditor = null, dbLastResult = null, dbRenderSeq = 0;
let dbUi = (STORE.dbUi && typeof STORE.dbUi === 'object') ? STORE.dbUi : {}; // {catCollapsed, treeOpen, lastSql}
const DB_TYPES = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', sqlite: 'SQLite' };
const DB_DEF_PORT = { postgres: 5432, mysql: 3306, sqlite: 0 };

function setDbOpen(open, opts = {}) {
  if (open === dbOpen) { if (open) renderDbPanel(); return; }
  if (open) { if (viewerOpen) setViewerOpen(false); if (gitOpen) setGitOpen(false); if (dockerOpen) setDockerOpen(false); if (scratchOpen) setScratchOpen(false); if (rhOpen) setRhOpen(false); }
  else dbDispose();
  const delta = layout.db + GUTTER;
  dbOpen = open;
  $('#db-pane').classList.toggle('hidden', !open);
  $('#gutter-db').classList.toggle('hidden', !open);
  if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
  saveUiState();
  if (open) renderDbPanel();
  setTimeout(refitActiveTerminal, 150);
}
function toggleDb() { setDbOpen(!dbOpen); }
function dbDispose() { if (dbSqlEditor) { try { dbSqlEditor.destroy(); } catch (_) {} dbSqlEditor = null; } }
function saveDbUi() { persist('dbUi', dbUi); }
function dbCatHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }

async function renderDbPanel() {
  const seq = ++dbRenderSeq;
  const body = $('#db-body');
  if (!dbActiveId) {
    body.innerHTML = '<div class="git-loading">Загрузка подключений…</div>';
    try { const r = await lite.db.list(); dbConnsList = r.connections || []; dbSecure = r.secure !== false; }
    catch (_) { dbConnsList = []; }
    if (seq !== dbRenderSeq || !dbOpen) return;
    renderDbConnections(body);
  } else {
    renderDbWorkspace(body);
  }
}

// ---- connections list (grouped by category, accordion + gradient, default «Все»)
function renderDbConnections(body) {
  body.innerHTML = '';
  const top = el('div', 'db-topbar');
  top.appendChild(el('span', 'db-topbar-title', 'Подключения'));
  const add = iconBtn('drow-act', 'plus', 'Новое подключение', 16); add.onclick = () => dbConnModal(null);
  top.appendChild(add);
  body.appendChild(top);
  if (!dbSecure) body.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — пароли шифруются слабее.'));
  if (!dbConnsList.length) { body.appendChild(el('div', 'docker-empty', 'Нет подключений. Добавь первое кнопкой ＋.')); return; }
  const groups = {};
  for (const c of dbConnsList) { const g = c.category || 'Все'; (groups[g] = groups[g] || []).push(c); }
  const cats = Object.keys(groups).sort((a, b) => (a === 'Все' ? -1 : b === 'Все' ? 1 : a.localeCompare(b)));
  for (const cat of cats) body.appendChild(dbCatBlock(cat, groups[cat]));
}
function dbCatBlock(cat, list) {
  const block = el('div', 'docker-group-block');
  const head = el('div', 'docker-group-head');
  const hue = dbCatHue(cat);
  head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
  head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
  const collapsed = !!(dbUi.catCollapsed && dbUi.catCollapsed[cat]);
  const chev = icon(collapsed ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
  head.append(chev, el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(list.length)));
  const bodyEl = el('div', 'docker-group-body');
  if (collapsed) bodyEl.style.display = 'none';
  for (const c of list) bodyEl.appendChild(dbConnRow(c));
  head.onclick = () => {
    dbUi.catCollapsed = dbUi.catCollapsed || {}; dbUi.catCollapsed[cat] = !dbUi.catCollapsed[cat]; saveDbUi();
    const col = dbUi.catCollapsed[cat]; bodyEl.style.display = col ? 'none' : '';
    const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev'); head.replaceChild(nc, head.firstChild);
  };
  block.append(head, bodyEl);
  return block;
}
function dbConnRow(c) {
  const row = el('div', 'db-conn-row clickable');
  row.appendChild(icon('database', 16));
  const main = el('div', 'drow-main');
  main.appendChild(el('span', 'drow-name', c.name || '(без имени)'));
  const sub = c.type === 'sqlite' ? (c.file || c.database || 'файл не задан')
    : `${DB_TYPES[c.type] || c.type} · ${c.host || 'localhost'}:${c.port || DB_DEF_PORT[c.type] || ''}${c.sshEnabled ? ' · SSH' : ''}${c.readOnly ? ' · RO' : ''}`;
  main.appendChild(el('span', 'drow-sub', sub));
  row.appendChild(main);
  const acts = el('div', 'drow-acts');
  const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13); edit.onclick = (e) => { e.stopPropagation(); dbConnModal(c); };
  const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
  del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить подключение?', `«${c.name}» удалится из списка (сама БД не трогается).`, 'Удалить', async () => { await lite.db.delete(c.id); renderDbPanel(); }); };
  acts.append(edit, del); row.appendChild(acts);
  row.addEventListener('click', () => { dbActiveId = c.id; dbActiveConn = c; dbSchema = null; dbTableSel = null; dbWsTab = 'tree'; renderDbPanel(); });
  return row;
}

// ---- add/edit connection modal (host + SSH, безопасно)
function dbConnModal(existing) {
  const c = existing ? { ...existing } : { type: 'postgres', category: 'Все', port: 5432 };
  const { m, close } = makeModal(`<h2>${existing ? 'Изменить' : 'Новое'} подключение</h2><div id="dbf" class="db-form"></div>`);
  m.classList.add('db-modal');
  const f = m.querySelector('#dbf');
  const field = (label, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, label)); w.appendChild(node); f.appendChild(w); return node; };
  const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
  const name = field('Имя', inp(c.name, 'Моя база'));
  const typeSel = el('select'); for (const [k, v] of Object.entries(DB_TYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === c.type) o.selected = true; typeSel.appendChild(o); }
  field('Тип', typeSel);
  const cat = field('Категория', inp(c.category || 'Все', 'Все'));
  // host group
  const hostWrap = el('div', 'db-group');
  const host = inp(c.host || '', 'localhost'); const port = inp(c.port || DB_DEF_PORT[c.type] || '', '5432', 'number');
  const user = inp(c.user || '', 'пользователь'); const pass = inp('', existing ? '(без изменений)' : 'пароль', 'password');
  const database = inp(c.database || '', 'имя базы (опц.)');
  const ssl = el('input'); ssl.type = 'checkbox'; ssl.checked = !!c.ssl;
  const sslIns = el('input'); sslIns.type = 'checkbox'; sslIns.checked = !!c.sslInsecure;
  const mk = (lbl, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, lbl)); w.appendChild(node); return w; };
  const sslLabel = (() => { const w = el('label', 'db-check'); w.append(ssl, document.createTextNode(' Использовать SSL/TLS')); return w; })();
  const sslInsLabel = (() => { const w = el('label', 'db-check db-check-warn'); w.append(sslIns, document.createTextNode(' Доверять самоподписанному сертификату (небезопасно)')); return w; })();
  ssl.onchange = () => { sslInsLabel.style.display = ssl.checked ? '' : 'none'; };
  hostWrap.append(mk('Хост', host), mk('Порт', port), mk('Пользователь', user), mk('Пароль', pass), mk('База', database), sslLabel, sslInsLabel);
  f.appendChild(hostWrap);
  // sqlite group
  const sqliteWrap = el('div', 'db-group');
  const file = inp(c.file || c.database || '', '/путь/к/базе.sqlite');
  sqliteWrap.append(mk('Файл БД', file));
  f.appendChild(sqliteWrap);
  // SSH group
  const sshOn = el('input'); sshOn.type = 'checkbox'; sshOn.checked = !!c.sshEnabled;
  const sshLabel = el('label', 'db-check'); sshLabel.append(sshOn, document.createTextNode(' Подключаться через SSH-туннель'));
  f.appendChild(sshLabel);
  const sshWrap = el('div', 'db-group');
  const sshHost = inp(c.sshHost || '', 'ssh-хост'); const sshPort = inp(c.sshPort || 22, '22', 'number');
  const sshUser = inp(c.sshUser || '', 'ssh-пользователь'); const sshPass = inp('', existing ? '(без изменений)' : 'пароль/passphrase', 'password');
  sshWrap.append(mk('SSH хост', sshHost), mk('SSH порт', sshPort), mk('SSH пользователь', sshUser), mk('SSH пароль', sshPass));
  f.appendChild(sshWrap);
  // read-only
  const ro = el('input'); ro.type = 'checkbox'; ro.checked = !!c.readOnly;
  const roLabel = el('label', 'db-check'); roLabel.append(ro, document.createTextNode(' Только чтение (запрет изменяющих запросов)'));
  f.appendChild(roLabel);
  // visibility by type
  const syncType = () => {
    const t = typeSel.value;
    hostWrap.style.display = t === 'sqlite' ? 'none' : '';
    sqliteWrap.style.display = t === 'sqlite' ? '' : 'none';
    sshLabel.style.display = t === 'sqlite' ? 'none' : '';
    sshWrap.style.display = (t !== 'sqlite' && sshOn.checked) ? '' : 'none';
    sslInsLabel.style.display = (t !== 'sqlite' && ssl.checked) ? '' : 'none';
  };
  typeSel.onchange = () => { if (!port.value || port.value == DB_DEF_PORT[c.type]) port.value = DB_DEF_PORT[typeSel.value] || ''; syncType(); };
  sshOn.onchange = syncType; syncType();
  // collect form → conn object (passwords only if typed)
  const collect = () => {
    const o = { id: c.id, name: name.value.trim(), type: typeSel.value, category: cat.value.trim() || 'Все', readOnly: ro.checked };
    if (typeSel.value === 'sqlite') { o.file = file.value.trim(); o.database = o.file; }
    else { o.host = host.value.trim(); o.port = +port.value || DB_DEF_PORT[typeSel.value]; o.user = user.value.trim(); o.database = database.value.trim(); o.ssl = ssl.checked; o.sslInsecure = sslIns.checked; o.sshEnabled = sshOn.checked; o.sshHost = sshHost.value.trim(); o.sshPort = +sshPort.value || 22; o.sshUser = sshUser.value.trim(); if (sshPass.value) o.sshPassword = sshPass.value; }
    if (pass.value) o.password = pass.value;
    return o;
  };
  // buttons
  const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
  const status = el('span', 'db-test-status');
  const test = el('button', 'btn', 'Тест');
  test.onclick = async () => { status.textContent = 'Проверяю…'; status.className = 'db-test-status'; const r = await lite.db.test(collect()); if (r.ok) { status.textContent = '✓ ' + (r.version || 'подключение успешно'); status.classList.add('ok'); } else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); } };
  const save = el('button', 'btn primary', 'Сохранить');
  save.onclick = async () => { const o = collect(); if (!o.name) { toast('Введи имя', { kind: 'err' }); return; } const r = await lite.db.save(o); if (r && r.error) { toast(r.error, { kind: 'err' }); return; } close(); renderDbPanel(); };
  const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
  row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
}

// ---- workspace (active connection): tabs «Объекты» / «SQL»
function renderDbWorkspace(body) {
  body.innerHTML = '';
  const head = el('div', 'db-ws-head');
  const back = iconBtn('drow-act', 'chevron-left', 'К подключениям', 16);
  back.onclick = () => { dbActiveId = null; dbActiveConn = null; dbSchema = null; dbTableSel = null; dbDispose(); renderDbPanel(); };
  head.append(back, icon('database', 15), el('span', 'db-ws-name', dbActiveConn.name));
  if (dbActiveConn.readOnly) head.appendChild(el('span', 'db-ro-badge', 'только чтение'));
  body.appendChild(head);
  const tabs = el('div', 'docker-subtabs');
  for (const [k, label] of [['tree', 'Объекты'], ['sql', 'SQL']]) {
    const t = el('button', 'docker-subtab' + (dbWsTab === k ? ' on' : '')); t.textContent = label;
    t.onclick = () => { if (dbWsTab !== k) { dbWsTab = k; renderDbWorkspace(body); } };
    tabs.appendChild(t);
  }
  body.appendChild(tabs);
  const view = el('div', 'db-ws-view'); body.appendChild(view);
  if (dbWsTab === 'tree') renderDbTree(view); else renderDbSql(view);
}

async function renderDbTree(view) {
  dbDispose(); // no SQL editor needed on the objects tab — release the lingering CodeMirror
  if (dbTableSel) { renderDbTableView(view); return; }
  const seq = ++dbRenderSeq;
  view.innerHTML = '<div class="git-loading">Чтение схемы…</div>';
  if (!dbSchema) { const r = await lite.db.schema(dbActiveId); if (seq !== dbRenderSeq) return; if (r.error) { view.innerHTML = ''; view.appendChild(el('div', 'docker-err', r.error)); return; } dbSchema = r; }
  view.innerHTML = '';
  if (!dbSchema.schemas || !dbSchema.schemas.length) { view.appendChild(el('div', 'docker-empty', 'Нет таблиц.')); return; }
  for (const sch of dbSchema.schemas) view.appendChild(dbSchemaBlock(sch));
}
function dbSchemaBlock(sch) {
  const block = el('div', 'docker-sec');
  const k = dbActiveId + ':' + sch.name;
  const open = !(dbUi.treeOpen && dbUi.treeOpen[k] === false); // default open
  const head = el('button', 'docker-sec-head');
  const chev = icon(open ? 'chevron-down' : 'chevron-right', 13); chev.classList.add('dsec-chev');
  head.append(chev, icon('grid', 14), el('span', 'dsec-title', sch.name), el('span', 'dsec-count', String(sch.tables.length)));
  const list = el('div', 'docker-sec-body'); if (!open) list.style.display = 'none';
  for (const t of sch.tables) {
    const r = el('div', 'db-table-row clickable');
    r.append(icon(t.view ? 'eye' : 'box', 13), el('span', 'db-table-name', t.name));
    r.onclick = () => { dbTableSel = { schema: sch.name, table: t.name, view: t.view, page: 0 }; renderDbPanel(); };
    list.appendChild(r);
  }
  head.onclick = () => {
    dbUi.treeOpen = dbUi.treeOpen || {}; const cur = !(dbUi.treeOpen[k] === false); dbUi.treeOpen[k] = !cur; saveDbUi();
    list.style.display = dbUi.treeOpen[k] ? '' : 'none';
    const nc = icon(dbUi.treeOpen[k] ? 'chevron-down' : 'chevron-right', 13); nc.classList.add('dsec-chev'); head.replaceChild(nc, head.firstChild);
  };
  block.append(head, list);
  return block;
}

const DB_PAGE = 200;
async function renderDbTableView(view) {
  const sel = dbTableSel;
  view.innerHTML = '';
  const bar = el('div', 'db-tablebar');
  const back = iconBtn('drow-act', 'chevron-left', 'К объектам', 15); back.onclick = () => { dbTableSel = null; renderDbPanel(); };
  bar.append(back, el('span', 'db-table-title', sel.table));
  bar.appendChild(dbExportBar(() => dbLastResult, sel.table));
  view.appendChild(bar);
  const grid = el('div', 'db-grid-wrap'); grid.innerHTML = '<div class="git-loading">Загрузка…</div>'; view.appendChild(grid);
  const pager = el('div', 'db-pager'); view.appendChild(pager);
  const seq = ++dbRenderSeq;
  const r = await lite.db.tableData(dbActiveId, sel.schema, sel.table, { limit: DB_PAGE, offset: sel.page * DB_PAGE });
  if (seq !== dbRenderSeq) return;
  grid.innerHTML = '';
  if (r.error) { grid.appendChild(el('div', 'docker-err', r.error)); return; }
  dbLastResult = r;
  grid.appendChild(dbGrid(r.columns, r.rows));
  const total = r.total != null && !Number.isNaN(r.total) ? r.total : '?';
  pager.appendChild(el('span', 'db-pageinfo', `${r.rows.length ? sel.page * DB_PAGE + 1 : 0}–${sel.page * DB_PAGE + r.rows.length} из ${total}`));
  const prev = iconBtn('drow-act', 'chevron-left', 'Назад', 13); prev.disabled = sel.page <= 0; prev.onclick = () => { if (sel.page > 0) { sel.page--; renderDbPanel(); } };
  const next = iconBtn('drow-act', 'chevron-right', 'Вперёд', 13); next.disabled = r.rows.length < DB_PAGE; next.onclick = () => { sel.page++; renderDbPanel(); };
  pager.append(prev, next);
}

function dbGrid(columns, rows) {
  const wrap = el('div', 'db-grid');
  const tbl = document.createElement('table');
  const thead = document.createElement('thead'); const htr = document.createElement('tr');
  for (const c of columns) { const th = document.createElement('th'); th.textContent = c; htr.appendChild(th); }
  thead.appendChild(htr); tbl.appendChild(thead);
  const tb = document.createElement('tbody');
  for (const rowv of rows) {
    const tr = document.createElement('tr');
    for (const v of rowv) {
      const td = document.createElement('td');
      if (v === null || v === undefined) { td.textContent = 'NULL'; td.className = 'db-null'; }
      else { let s = typeof v === 'object' ? JSON.stringify(v) : String(v); if (s.length > 400) s = s.slice(0, 400) + '…'; td.textContent = s; td.title = s; }
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  tbl.appendChild(tb); wrap.appendChild(tbl);
  return wrap;
}

// ---- SQL console (CodeMirror + run + results + export/import)
function dbDialect() { return dbActiveConn.type === 'mysql' ? MySQL : dbActiveConn.type === 'sqlite' ? SQLite : PostgreSQL; }
function renderDbSql(view) {
  view.innerHTML = '';
  const edWrap = el('div', 'db-sql-editor'); view.appendChild(edWrap);
  const bar = el('div', 'db-sql-bar');
  const run = el('button', 'btn primary db-run', '▶ Выполнить'); run.title = 'Ctrl+Enter'; run.onclick = dbRunSql;
  bar.appendChild(run);
  const imp = el('button', 'btn db-imp', '⬇ Импорт'); imp.title = 'Загрузить SQL-файл в редактор';
  imp.onclick = async () => { const r = await lite.db.openText(); if (r && r.ok && dbSqlEditor) dbSqlEditor.dispatch({ changes: { from: 0, to: dbSqlEditor.state.doc.length, insert: r.content } }); else if (r && r.error) toast(r.error, { kind: 'err' }); };
  bar.appendChild(imp);
  bar.appendChild(dbExportBar(() => dbLastResult, 'query'));
  view.appendChild(bar);
  const res = el('div', 'db-sql-result'); res.id = 'db-sql-result'; view.appendChild(res);
  if (dbSqlEditor) { try { dbSqlEditor.destroy(); } catch (_) {} dbSqlEditor = null; }
  const initial = (dbUi.lastSql && dbUi.lastSql[dbActiveId]) || '';
  const state = EditorState.create({
    doc: initial,
    extensions: [
      lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle), sql({ dialect: dbDialect() }), oneDark,
      keymap.of([{ key: 'Ctrl-Enter', run: () => { dbRunSql(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => { if (u.docChanged) { dbUi.lastSql = dbUi.lastSql || {}; dbUi.lastSql[dbActiveId] = u.state.doc.toString(); } }),
    ],
  });
  dbSqlEditor = new EditorView({ state, parent: edWrap });
}
async function dbRunSql() {
  if (!dbSqlEditor) return;
  const text = dbSqlEditor.state.doc.toString().trim();
  if (!text) return;
  saveDbUi();
  const res = $('#db-sql-result'); if (!res) return;
  res.innerHTML = '<div class="git-loading">Выполняю…</div>';
  const seq = ++dbRenderSeq;
  const r = await lite.db.query(dbActiveId, text);
  if (seq !== dbRenderSeq || !document.getElementById('db-sql-result')) return;
  res.innerHTML = '';
  if (r.error) { res.appendChild(el('div', 'docker-err', r.error)); return; }
  dbLastResult = r;
  if (r.columns && r.columns.length) { res.appendChild(el('div', 'db-result-info', `${r.rows.length} строк`)); res.appendChild(dbGrid(r.columns, r.rows)); dbSchema = null; }
  else { res.appendChild(el('div', 'db-result-info', `Готово${r.rowCount != null ? ` · затронуто строк: ${r.rowCount}` : ''}`)); dbSchema = null; }
}

// ---- export (CSV / JSON / SQL) — three small buttons
function dbExportBar(getResult, name) {
  const wrap = el('div', 'db-export');
  for (const fmt of ['csv', 'json', 'sql']) {
    const b = el('button', 'db-exp-btn', fmt.toUpperCase());
    b.title = 'Экспорт в ' + fmt.toUpperCase();
    b.onclick = (e) => { e.stopPropagation(); dbDoExport(getResult(), name, fmt); };
    wrap.appendChild(b);
  }
  return wrap;
}
async function dbDoExport(result, name, fmt) {
  if (!result || !result.columns || !result.columns.length) { toast('Нет данных для экспорта'); return; }
  const { columns, rows } = result;
  let text = '', ext = fmt;
  if (fmt === 'csv') { const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); text = [columns.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n'); }
  else if (fmt === 'json') { text = JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2); }
  else { const qv = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'"; text = rows.map((r) => `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${r.map(qv).join(', ')});`).join('\n'); }
  const r = await lite.db.saveText(`${name}.${ext}`, text);
  if (r && r.ok) toast('Сохранено: ' + r.path, { ttl: 7000 });
  else if (r && r.error) toast(r.error, { kind: 'err' });
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
function extOf(name) { if (!name) return ''; const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
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
      if (currentFile === ent.path) { currentFile = to; $('#viewer-filename').textContent = name; }
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
    dd.appendChild(menuRow('file', 'Новый файл…', () => { closeMenus(); treeNewFile(ent.path); }));
    dd.appendChild(menuRow('folder', 'Новая папка…', () => { closeMenus(); treeNewFolder(ent.path); }));
    dd.appendChild(el('div', 'menu-sep'));
  } else {
    dd.appendChild(menuRow('eye', 'Открыть', () => { closeMenus(); if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(ent.path)); }));
    if (['html', 'htm'].includes(extOf(ent.name))) dd.appendChild(menuRow('globe', 'Открыть в браузере', () => { closeMenus(); lite.openInFileManager(ent.path); }));
    dd.appendChild(el('div', 'menu-sep'));
  }
  if (!ent.root) {
    dd.appendChild(menuRow('pencil', 'Переименовать…', () => { closeMenus(); treeRename(ent); }));
    dd.appendChild(menuRow('trash', 'Удалить…', () => { closeMenus(); treeDelete(ent); }, 'danger'));
  }
  dd.appendChild(menuRow('copy', 'Копировать путь', () => { closeMenus(); lite.copyText(ent.path); toast('Путь скопирован'); }));
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
  $('#win-close').onclick = () => lite.win.close(); // fullscreen — по F11 (кнопку убрали, стандартные 3 кнопки)
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
  else if (name === 'modules') buildModulesMenu(dd);
  dd.addEventListener('click', (e) => e.stopPropagation());
  const r = btn.getBoundingClientRect();
  placeMenu(dd, r.left, r.bottom + 4);
}
// `glyph` is an ICONS name (rendered as SVG); a non-icon string falls back to text; falsy → empty slot.
function menuRow(glyph, text, onClick, cls) {
  const row = el('div', 'menu-row' + (cls ? ' ' + cls : ''));
  const ic = el('span', 'menu-ic');
  if (glyph && ICONS[glyph]) ic.appendChild(icon(glyph, 16));
  else if (glyph) ic.textContent = glyph;
  row.appendChild(ic); row.appendChild(el('span', null, text));
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
// Back up the whole editor state to one JSON file, then offer to open its folder.
async function exportSettings() {
  closeMenus();
  const r = await lite.settings.export();
  if (!r || r.canceled) return;
  if (r.error) { toast('Ошибка экспорта: ' + r.error); return; }
  toast('Настройки экспортированы', { actionLabel: 'Открыть папку', action: () => lite.openInFileManager(r.dir), ttl: 8000 });
}
// Restore from a backup. Overwrites the current state, so confirm first; reload to apply.
async function importSettings() {
  closeMenus();
  showConfirm(
    'Импорт настроек',
    'Импорт перезапишет текущие настройки, проекты, категории и заметки данными из файла. Открытые терминалы не затрагиваются. Продолжить?',
    'Импортировать',
    async () => {
      const r = await lite.settings.import();
      if (!r || r.canceled) return;
      if (r.error) { toast('Ошибка импорта: ' + r.error); return; }
      if (r.partial) {
        const parts = [];
        if (r.failedKeys && r.failedKeys.length) parts.push(`настройки: ${r.failedKeys.join(', ')}`);
        if (r.failedNotes) parts.push(`заметок: ${r.failedNotes}`);
        toast('Импорт частичный — не записано: ' + parts.join('; ') + '. Перезагружаю…', { ttl: 9000 });
      } else {
        toast('Настройки импортированы — перезагружаю…');
      }
      setTimeout(() => location.reload(), r.partial ? 1500 : 700);
    });
}
function buildFileMenu(dd) {
  dd.appendChild(menuRow('folder', 'Открыть папку', () => { closeMenus(); openProjectDialog(); }));
  dd.appendChild(menuRow('plus', 'Создать папку…', () => { closeMenus(); showCreateFolder(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('download', 'Экспорт настроек…', exportSettings));
  dd.appendChild(menuRow('upload', 'Импорт настроек…', importSettings));
  dd.appendChild(menuRow('clipboard', 'Логи…', () => { closeMenus(); showLogs(); }));
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
    dd.appendChild(menuRow('trash', 'Очистить список', () => { persist('recents', []); closeMenus(); }));
  }
}
function buildSettingsMenu(dd) {
  dd.appendChild(menuRow('sliders', 'Настройки…', () => { closeMenus(); showSettings(); }));
  dd.appendChild(menuRow('grid', 'Палитра команд (Ctrl+K)', () => { closeMenus(); showPalette(); }));
  dd.appendChild(menuRow('search', 'Поиск в терминале (Ctrl+F)', () => { closeMenus(); openTermSearch(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('globe', 'Пульт (Android)', () => { closeMenus(); showRemote(); }));
}
// «Модули» — функциональные панели справа от терминала (терминалы и OpenRouter-чат — НЕ модули).
function buildModulesMenu(dd) {
  dd.appendChild(menuRow('eye', 'Вивер — файлы выбранного проекта', () => { closeMenus(); openModule('files'); }));
  dd.appendChild(menuRow('git', 'Git — выбранного проекта', () => { closeMenus(); openModule('git'); }));
  dd.appendChild(menuRow('box', 'Контейнеры — Docker / Podman', () => { closeMenus(); openModule('docker'); }));
  dd.appendChild(menuRow('database', 'Базы данных — Postgres / MySQL / SQLite', () => { closeMenus(); openModule('db'); }));
  dd.appendChild(menuRow('globe', 'Удалённые хосты — SSH-сессии к серверам', () => { closeMenus(); openModule('rh'); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('terminal', 'Системный терминал (вне проектов)', () => { closeMenus(); openModule('scratch'); }));
}

// terminal right-click menu
function showTermMenu(x, y, term, projId) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '160px';
  const hasSel = term.hasSelection && term.hasSelection();
  dd.appendChild(menuRow('copy', 'Копировать', hasSel ? () => {
    closeMenus();
    lite.copyText(term.getSelection());
    if (term.clearSelection) term.clearSelection();
  } : null, hasSel ? '' : 'disabled'));
  dd.appendChild(menuRow('clipboard', 'Вставить', () => { closeMenus(); pasteInto(projId); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('eraser', 'Очистить', () => { closeMenus(); clearTerminal(projId); }));
  dd.appendChild(menuRow('refresh', 'Перезапустить', () => { closeMenus(); restartTerminal(projId); }));
  dd.addEventListener('click', (e) => e.stopPropagation());
  placeMenu(dd, x, y);
}

// ---------------------------------------------------------------- modals
// onClose runs on EVERY close path (button, Esc, overlay-click) exactly once — so
// callers can release listeners/refs they attached (e.g. a queue's onChange) without
// leaking when the user dismisses via Esc or backdrop instead of the explicit button.
function makeModal(innerHtml, onClose) {
  const overlay = el('div', 'modal-overlay');
  const m = el('div', 'modal');
  m.innerHTML = innerHtml;
  overlay.appendChild(m);
  $('#modal-root').appendChild(overlay);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    $('#modal-root').innerHTML = '';
    if (onClose) { try { onClose(); } catch (_) {} }
  };
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
      Когда код всё чаще пишет агент, а не ты сам, привычный редактор встаёт с ног на голову:
      в центре уже не файл, а разговор. LiteEditor построен вокруг этого — главный здесь
      твой терминал с агентом, а просмотр кода, дерево и git живут рядом и прячутся одной
      кнопкой, когда не нужны.<br><br>
      Это нарочно лёгкий и тихий инструмент: открыл папку — и сразу за дело, без долгой
      настройки. Он старается не мешать и держаться в стороне, пока ты направляешь работу,
      а не выстукиваешь каждую строку руками.<br><br>
      Маленький проект для себя и тех, кто проводит день в диалоге с ИИ и хочет, чтобы вокруг
      этого диалога было спокойно и удобно.
    </div>
    <div class="about-ver">${APP_VERSION} <span id="ab-upd-status" class="about-upd"></span></div>
    <div class="about-meta">Максим&nbsp;Кузьминский · <a href="#" id="ab-src">исходники на GitHub</a></div>
    <div class="modal-actions">
      <button class="btn" id="ab-check">Проверить обновление</button>
      <button class="btn primary" id="ab-ok">Ок</button>
    </div>`);
  m.querySelector('#ab-ok').onclick = close;
  m.querySelector('#ab-src').onclick = (e) => { e.preventDefault(); lite.openExternal('https://github.com/DanielLetto2020/LiteEditorAI'); };
  const st = m.querySelector('#ab-upd-status');
  const setSt = (txt, cls) => { if (st) { st.textContent = txt; st.className = 'about-upd' + (cls ? ' ' + cls : ''); } };
  // Reflect a known result immediately; otherwise prompt to check.
  if (updateInfo) setSt('— доступна ' + updateInfo.tag, 'has');
  m.querySelector('#ab-check').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; setSt('— проверяю…');
    const r = await checkForUpdate({ manual: true });
    btn.disabled = false;
    if (r && r.error) setSt('— не удалось проверить', 'err');
    else if (verNewer(r.tag, APP_VERSION)) {
      // Build with DOM methods (tag comes from the API) — no innerHTML.
      setSt('— доступна ', 'has');
      const dl = el('a', null, (r.tag || 'новая версия') + ' (скачать)');
      dl.href = '#';
      dl.onclick = (ev) => { ev.preventDefault(); lite.openExternal(r.url || 'https://github.com/DanielLetto2020/LiteEditorAI/releases/latest'); };
      st.appendChild(dl);
    } else setSt('— у вас последняя версия', 'ok');
  };
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

// ---------------------------------------------------------------- logs viewer
// In-app reader for ~/.LiteEditorAI/logs/*.log with level highlighting. Read-only.
// Renders lines via textContent (never innerHTML) — log text is untrusted input.
function showLogs() {
  closeMenus();
  const { m } = makeModal(`
    <h2>🗒 Логи приложения</h2>
    <div class="logs-wrap">
      <div class="logs-files" id="logs-files"></div>
      <div class="logs-main">
        <div class="logs-bar">
          <span class="logs-name" id="logs-curname">—</span>
          <span class="drag-space-static"></span>
          <label class="logs-chk"><input type="checkbox" id="logs-erronly"> только ошибки</label>
          <button class="icon-btn" id="logs-copy" title="Скопировать файл">⧉</button>
          <button class="icon-btn" id="logs-refresh" title="Обновить">⟳</button>
        </div>
        <div class="logs-view" id="logs-view"></div>
      </div>
    </div>`);
  const filesBox = m.querySelector('#logs-files');
  const view = m.querySelector('#logs-view');
  const curName = m.querySelector('#logs-curname');
  const errOnly = m.querySelector('#logs-erronly');
  let current = null, raw = '';
  const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const levelOf = (line) => /\[(FATAL|ERROR)\]/.test(line) ? 'err' : /\[WARN\]/.test(line) ? 'warn' : /\[INFO\]/.test(line) ? 'info' : null;
  function render() {
    view.innerHTML = '';
    if (!current) { view.appendChild(el('div', 'logs-empty', 'Выбери файл слева')); return; }
    let lines = raw.split('\n');
    if (errOnly.checked) lines = lines.filter((l) => { const k = levelOf(l); return k === 'err' || k === 'warn'; });
    const MAXL = 2500;
    if (lines.length > MAXL) { view.appendChild(el('div', 'logs-note', `…последние ${MAXL} строк из ${lines.length}`)); lines = lines.slice(-MAXL); }
    if (!lines.length) { view.appendChild(el('div', 'logs-empty', errOnly.checked ? 'Ошибок и предупреждений нет 🎉' : 'Файл пуст')); return; }
    const frag = document.createDocumentFragment();
    for (const line of lines) { const k = levelOf(line); frag.appendChild(el('div', 'logs-line' + (k ? ' ll-' + k : ''), line || ' ')); }
    view.appendChild(frag);
  }
  async function load(name) {
    current = name; curName.textContent = name;
    filesBox.querySelectorAll('.logs-file').forEach((r) => r.classList.toggle('active', r.dataset.name === name));
    view.innerHTML = ''; view.appendChild(el('div', 'logs-empty', 'Загрузка…'));
    let res; try { res = await lite.logs.read(name); } catch (e) { res = { error: String(e) }; }
    if (!res || res.error) { view.innerHTML = ''; view.appendChild(el('div', 'logs-empty', 'Ошибка: ' + ((res && res.error) || '—'))); return; }
    raw = (res.truncated ? '…(показан конец файла)\n' : '') + (res.content || '');
    render();
  }
  async function refresh() {
    filesBox.innerHTML = '';
    let res; try { res = await lite.logs.list(); } catch (e) { res = { error: String(e), files: [] }; }
    const files = (res && res.files) || [];
    if (!files.length) { filesBox.appendChild(el('div', 'logs-empty', 'Логов пока нет')); view.innerHTML = ''; return; }
    for (const f of files) {
      const row = el('div', 'logs-file'); row.dataset.name = f.name;
      row.appendChild(el('div', 'logs-fname', f.name));
      row.appendChild(el('div', 'logs-fmeta', fmtSize(f.size)));
      row.addEventListener('click', () => load(f.name));
      filesBox.appendChild(row);
    }
    load((current && files.some((f) => f.name === current)) ? current : files[0].name); // newest day first
  }
  errOnly.onchange = render;
  m.querySelector('#logs-refresh').onclick = refresh;
  m.querySelector('#logs-copy').onclick = () => { if (raw) { lite.copyText(raw); toast('Лог скопирован в буфер'); } };
  refresh();
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
    <div class="set-row col"><span>Оболочка терминала — применяется к новым терминалам (старые — ⟳)</span>
      <div class="path-pick">
        <select id="st-shell"></select>
        <input type="text" id="st-shell-path" placeholder="путь к исполняемому файлу" spellcheck="false" style="display:none">
      </div></div>
    <div class="set-row col"><span>Рабочая папка — куда создаются новые проекты</span>
      <div class="path-pick">
        <input type="text" id="st-wd" readonly placeholder="не задана">
        <button class="btn" id="st-wd-pick">Выбрать</button>
        <button class="btn" id="st-wd-clear" title="Очистить">✕</button>
      </div></div>
    <div class="set-row col"><span>Папки для скана — их подпапки добавляются как проекты при запуске</span>
      <div id="st-scan" class="scan-list"></div>
      <button class="btn" id="st-scan-add">＋ Добавить папку</button></div>
    <div class="set-row col"><span>Доступ с пульта — папки, которые можно смотреть/скачивать с планшета (только чтение). «Стор» доступен всегда.</span>
      <div id="st-shares" class="scan-list"></div>
      <button class="btn" id="st-share-add">＋ Открыть папку пульту</button></div>
    <div class="modal-actions"><button class="btn primary" id="st-ok">Готово</button></div>`);
  const notif = m.querySelector('#st-notif'); notif.checked = settings.notifications;
  const sound = m.querySelector('#st-sound'); sound.checked = settings.sound;
  const idle = m.querySelector('#st-idle'); idle.value = settings.idleMs;
  const font = m.querySelector('#st-font'); font.value = settings.fontSize;
  const themeSel = m.querySelector('#st-theme');
  for (const [key, t] of Object.entries(THEMES)) { const o = document.createElement('option'); o.value = key; o.textContent = t.label; themeSel.appendChild(o); }
  themeSel.value = THEMES[settings.theme] ? settings.theme : DEFAULT_THEME;
  themeSel.addEventListener('change', () => { settings.theme = themeSel.value; saveSettings(); applyTheme(); }); // live preview
  // Выбор оболочки терминала — платформо-зависимо (Windows: PowerShell/cmd/свой; Linux: bash/свой).
  const shellSel = m.querySelector('#st-shell');
  const shellPath = m.querySelector('#st-shell-path');
  const isWin = (lite.platform === 'win32');
  const shellOpts = isWin
    ? [['', 'PowerShell (по умолчанию)'], ['cmd', 'cmd'], ['__custom__', 'Свой путь…']]
    : [['', 'bash (по умолчанию)'], ['__custom__', 'Свой путь…']];
  for (const [v, t] of shellOpts) { const o = document.createElement('option'); o.value = v; o.textContent = t; shellSel.appendChild(o); }
  const shellPresets = isWin ? ['', 'cmd'] : [''];
  const curShell = settings.shell || '';
  const shellCustom = curShell && !shellPresets.includes(curShell);
  shellSel.value = shellCustom ? '__custom__' : curShell;
  shellPath.style.display = shellCustom ? '' : 'none';
  shellPath.value = shellCustom ? curShell : '';
  shellSel.addEventListener('change', () => { shellPath.style.display = shellSel.value === '__custom__' ? '' : 'none'; });
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
  // Доступ с пульта (shares) — список папок {path,name}; «Стор» неявно всегда доступен.
  let shares = [...(STORE.shares || [])];
  const sharesBox = m.querySelector('#st-shares');
  const renderShares = () => {
    sharesBox.innerHTML = '';
    if (!shares.length) { sharesBox.appendChild(el('div', 'scan-empty', '— только «Стор» —')); return; }
    shares.forEach((s, i) => {
      const r = el('div', 'scan-item');
      const path = el('span', 'scan-path', s.path); path.title = s.path;
      const x = el('button', 'scan-del', '✕');
      x.onclick = () => { shares.splice(i, 1); renderShares(); };
      r.append(path, x); sharesBox.appendChild(r);
    });
  };
  renderShares();
  m.querySelector('#st-share-add').onclick = async () => {
    const d = await lite.pickDir();
    if (d && !shares.some((s) => s.path === d)) { shares.push({ path: d, name: d.split('/').filter(Boolean).pop() || d }); renderShares(); }
  };
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
    settings.shell = shellSel.value === '__custom__' ? shellPath.value.trim() : shellSel.value;
    persist('shares', shares);   // доступ с пульта (main читает свежим при каждом запросе)
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
  acts.push({ label: gitOpen ? 'Закрыть Git' : 'Открыть Git', run: toggleGit });
  acts.push({ label: dockerOpen ? 'Закрыть контейнеры' : 'Контейнеры (Docker / Podman)', run: toggleDocker });
  acts.push({ label: dbOpen ? 'Закрыть базы данных' : 'Базы данных (Postgres / MySQL / SQLite)', run: toggleDb });
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

// ---------------------------------------------------------------- update check
// Pull a version triple out of «alpha v1.0.97» or a tag «v1.0.97-alpha».
function parseVer(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
function verNewer(a, b) { // is version a strictly newer than b?
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}
let updateInfo = null; // {tag,url,notes,name} when a newer release exists
// Ask main to fetch the latest GitHub release and compare with APP_VERSION.
// Silent on failure / when up to date (so a startup auto-check never nags);
// `manual` = user pressed «Проверить обновление» → toast the result either way.
async function checkForUpdate({ manual = false } = {}) {
  let r;
  try { r = await lite.update.check(); } catch (_) { r = { error: 'нет связи' }; }
  if (!r || r.error) {
    if (manual) toast('Не удалось проверить обновление: ' + ((r && r.error) || 'нет связи'), { kind: 'err' });
    return r || { error: 'нет связи' };
  }
  if (verNewer(r.tag, APP_VERSION)) {
    updateInfo = r;
    const b = $('#update-badge');
    if (b) {
      b.hidden = false;
      b.textContent = '↑ ' + (r.tag || 'обновление');
      b.title = 'Доступна ' + (r.tag || 'новая версия') + ' — открыть страницу загрузки';
      b.onclick = () => lite.openExternal(r.url || 'https://github.com/DanielLetto2020/LiteEditorAI/releases/latest');
    }
    if (manual) toast('Доступна новая версия ' + r.tag, { ttl: 5000 });
  } else {
    updateInfo = null;
    const b = $('#update-badge'); if (b) b.hidden = true;
    if (manual) toast('У вас последняя версия');
  }
  return r;
}

// ---------------------------------------------------------------- init
function init() {
  hydrateIcons(); // fill the static [data-icon] buttons (titlebar / pane toolbars) with SVG
  { const av = $('#app-ver'); if (av) av.textContent = APP_VERSION; } // version label in the titlebar
  makeEditor();
  applyLayout();
  applyTheme();
  initGutters();
  initWindowControls();
  initMenubar();

  // surface unexpected renderer errors instead of failing silently — toast for
  // the user, and forward to the main-process file log so crashes are diagnosable
  const logErr = (...a) => { try { lite.log('error', ...a); } catch (_) {} };
  window.addEventListener('error', (e) => {
    logErr('window.error', (e.error && e.error.stack) || e.message || '', e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '');
    toast('Ошибка: ' + (e.message || (e.error && e.error.message) || 'см. F12'), { kind: 'err', ttl: 8000 });
  });
  window.addEventListener('unhandledrejection', (e) => {
    logErr('unhandledrejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
    toast('Ошибка: ' + ((e.reason && e.reason.message) || e.reason || 'промис'), { kind: 'err', ttl: 8000 });
  });
  try { lite.log('info', `UI ${APP_VERSION} started`); } catch (_) {}

  // Auto-check for a newer release shortly after startup (non-blocking, silent on
  // failure). The badge next to the version lights up if one is available.
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 3000);

  lite.pty.onData(({ id, data }) => {
    if (isScratch(id)) { const r = scratchTerms.get(id); if (r) r.term.write(data); return; }
    const rec = terms.get(id);
    if (!rec) return;
    rec.term.write(data);
    markActivity(id, data);
  });
  lite.pty.onExit(({ id }) => {
    if (isScratch(id)) { const r = scratchTerms.get(id); if (r) r.term.write('\r\n\x1b[90m[шелл завершён — ⟳ для нового]\x1b[0m\r\n'); return; }
    const rec = terms.get(id);
    if (rec) rec.term.write('\r\n\x1b[90m[процесс завершён — закрой и переоткрой проект]\x1b[0m\r\n');
    setProjState(id, 'quiet');
  });
  // RemoteHost — SSH-сессии (отдельный канал, не PTY): пишем вывод в соответствующий xterm.
  lite.rh.onData(({ id, data }) => { const rec = rhTerms.get(id); if (rec) rec.term.write(data); });
  lite.rh.onExit(({ id }) => { const rec = rhTerms.get(id); if (rec) rec.term.write('\r\n\x1b[90m[соединение закрыто — закрой вкладку или подключись заново]\x1b[0m\r\n'); });
  // Пульт задал размер сессии → зеркалим его сетку на ПК (letterbox), не навязываем свою.
  try { if (lite.pty.onRemoteSize) lite.pty.onRemoteSize(({ id, cols, rows }) => { try { applyRemoteTermSize(id, cols, rows); } catch (_) {} }); } catch (_) {}
  // Пульт отключился → ПК возвращает себе размер (обычный fit всех сессий).
  try { if (lite.pty.onRemoteRelease) lite.pty.onRemoteRelease(() => { try { reclaimTermSize(); } catch (_) {} }); } catch (_) {}

  // Пульт выбрал вкладку → синхронизируем активную на десктопе.
  try { if (lite.remote && lite.remote.onSelect) lite.remote.onSelect((sid) => { try { handleRemoteSelect(sid); } catch (_) {} }); } catch (_) {}
  // Пульт открыл терминал проекта → создаём вкладку на десктопе.
  try { if (lite.remote && lite.remote.onOpenProject) lite.remote.onOpenProject((projId) => { try { handleRemoteOpen(projId); } catch (_) {} }); } catch (_) {}
  // Пульт закрыл вкладку → закрываем на десктопе.
  try { if (lite.remote && lite.remote.onCloseTab) lite.remote.onCloseTab((sid) => { try { handleRemoteClose(sid); } catch (_) {} }); } catch (_) {}
  // Пульт: «Создать папку» → создаём на десктопе.
  try { if (lite.remote && lite.remote.onNewFolder) lite.remote.onNewFolder((name) => { try { handleRemoteNewFolder(name); } catch (_) {} }); } catch (_) {}
  // Пульт просит одобрить устройство (pairing) → модалка одобрения.
  try { if (lite.remote && lite.remote.onPairRequest) lite.remote.onPairRequest((info) => { try { handleRemotePairRequest(info); } catch (_) {} }); } catch (_) {}

  // OpenRouter streaming → route SSE events to the live request's handlers (by reqId).
  lite.openrouter.onChunk(({ reqId, delta }) => { const h = pendingOr.get(reqId); if (h) h.chunk(delta); });
  lite.openrouter.onDone(({ reqId }) => { const h = pendingOr.get(reqId); if (h) h.done(); });
  lite.openrouter.onError(({ reqId, error }) => { const h = pendingOr.get(reqId); if (h) h.error(error); });

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

  $('#btn-single').addEventListener('click', toggleSingle);
  $('#btn-scratch').addEventListener('click', toggleScratch);
  $('#scratch-restart').addEventListener('click', () => restartScratch());
  $('#scratch-close').addEventListener('click', () => setScratchOpen(false));
  $('#viewer-save').addEventListener('click', saveCurrent);
  $('#viewer-diff').addEventListener('click', toggleDiff);
  $('#viewer-preview').addEventListener('click', togglePreview);
  $('#viewer-full').addEventListener('click', togglePreviewFull);
  $('#viewer-minimap').addEventListener('click', toggleMinimap);
  $('#viewer-minimap').classList.toggle('on', settings.minimap);
  $('#viewer-close').addEventListener('click', () => setViewerOpen(false));
  $('#git-close').addEventListener('click', () => setGitOpen(false));
  $('#git-refresh').addEventListener('click', () => { if (gitOpen) renderGitPanel(activeProject()); });
  $('#docker-close').addEventListener('click', () => setDockerOpen(false));
  $('#docker-refresh').addEventListener('click', () => { dockerDetect = null; if (dockerOpen) renderDockerPanel(); });
  $('#db-close').addEventListener('click', () => setDbOpen(false));
  $('#db-refresh').addEventListener('click', () => { dbSchema = null; if (dbOpen) renderDbPanel(); });
  $('#rh-close').addEventListener('click', () => setRhOpen(false));
  $('#rh-refresh').addEventListener('click', () => { if (rhOpen) renderRhPanel(); });
  $('#rh-back').addEventListener('click', () => rhGoList());
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
    const e = [...projState.entries()].find(([, s]) => s === 'waiting');
    const rec = e && terms.get(e[0]);
    if (rec) { setActive(rec.projId); switchTab(e[0]); }
  });

  // terminal search box
  $('#term-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runTermSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
  });
  $('#term-search-next').addEventListener('click', () => runTermSearch(1));
  $('#term-search-prev').addEventListener('click', () => runTermSearch(-1));
  $('#term-search-close').addEventListener('click', closeTermSearch);

  // OpenRouter chat controls
  $('#chat-send').addEventListener('click', onSendClick);
  $('#chat-model-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleModelPop(); });
  $('#chat-model-search').addEventListener('input', (e) => renderModelList(e.target.value));
  $('#chat-model-pop').addEventListener('click', (e) => e.stopPropagation());
  $('#chat-session-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleSessionPop(); });
  $('#chat-session-pop').addEventListener('click', (e) => e.stopPropagation());
  $('#chat-log').addEventListener('click', (e) => {
    const img = e.target.closest('img'); // generated/markdown image → open in a lightbox
    if (img && img.src) { e.preventDefault(); openImageLightbox(img.src); return; }
    const a = e.target.closest('a[href]'); if (!a) return; // links in messages open in the system browser
    e.preventDefault();
    // model output is untrusted — only open http(s); never file:/custom schemes via openExternal
    try { const u = new URL(a.getAttribute('href'), location.href); if (u.protocol === 'http:' || u.protocol === 'https:') lite.openExternal(u.href); } catch (_) {}
  });
  $('#chat-ctx-input').addEventListener('change', (e) => {
    const card = activeOrCard(); if (!card) return;
    const s = activeSession(); if (!s) return;
    const v = clamp(e.target.value, 1, 100); e.target.value = v; s.contextN = v; // bind to the active session
    saveOrHist(card.id);
  });
  const chatInput = $('#chat-input');
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } // Enter sends; sendChat no-ops while streaming (use ■ to stop)
  });
  chatInput.addEventListener('input', () => { // auto-grow the textarea up to a cap
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  });
  document.addEventListener('click', () => {
    for (const sel of ['#chat-model-pop', '#chat-session-pop']) { const p = $(sel); if (p && !p.classList.contains('hidden')) p.classList.add('hidden'); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('preview-full')) { e.preventDefault(); exitPreviewFull(); return; }
    if (e.ctrlKey && e.key === '\\') { e.preventDefault(); toggleSingle(); }
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); saveCurrent(); }   // e.code, не e.key — иначе в русской раскладке не сработает (Ctrl+S → e.key='ы')
    if (e.ctrlKey && e.code === 'KeyK') { e.preventDefault(); showPalette(); }   // то же: Ctrl+K → e.key='л' в русской раскладке
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
  let scratchRezTimer;
  new ResizeObserver(() => { clearTimeout(scratchRezTimer); scratchRezTimer = setTimeout(() => refitScratch(), 80); }).observe($('#scratch-pane'));
  let rhRezTimer; new ResizeObserver(() => { clearTimeout(rhRezTimer); rhRezTimer = setTimeout(() => refitRhSession(), 80); }).observe($('#rh-pane'));

  applyFontSize();
  projects = loadProjectsFromDisk();
  renderProjects();
  if (projects.length) setActive(projects[0].id);
  else showActiveTerminal();

  // Restore which panes were open last time (viewer / system terminal). grow:false —
  // the saved window width already includes them, so reveal in place without resizing.
  const ui = STORE.uiState || {};
  // Right-slot modules are mutually exclusive — restore at most one (saved state has ≤1 open).
  if (ui.viewerOpen) setViewerOpen(true, { grow: false });
  if (ui.scratchOpen && !viewerOpen) setScratchOpen(true, { grow: false });
  // allowEmpty so Git returns even before a project is active — matching the viewer, so window width fits.
  if (ui.gitOpen && !viewerOpen && !scratchOpen) setGitOpen(true, { grow: false, allowEmpty: true });
  if (ui.dockerOpen && !viewerOpen && !scratchOpen && !gitOpen) setDockerOpen(true, { grow: false });
  if (ui.dbOpen && !viewerOpen && !scratchOpen && !gitOpen && !dockerOpen) setDbOpen(true, { grow: false });
  if (ui.rhOpen && !viewerOpen && !scratchOpen && !gitOpen && !dockerOpen && !dbOpen) setRhOpen(true, { grow: false });

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
