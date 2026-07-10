// LiteEditor — stateless DOM/UI helpers shared by the core and the modules.
// No imports from renderer.js (keeps the dependency graph a DAG: ui.js ← modules ← core).
// Everything here is pure DOM: no core state, no window.lite calls.

import hljs from 'highlight.js/lib/common';

const $ = (sel) => document.querySelector(sel);

// Расширение → id языка highlight.js (только из lite-набора common). Неизвестное → null (без подсветки).
const DIFF_LANGS = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cs: 'csharp', kt: 'kotlin', swift: 'swift', lua: 'lua', pl: 'perl',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml',
  xml: 'xml', svg: 'xml', md: 'markdown', markdown: 'markdown', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', ini: 'ini',
  toml: 'ini', make: 'makefile', dockerfile: 'dockerfile', r: 'r',
};
// Язык по имени файла или строке заголовка диффа ('+++ b/path.ext\t...').
export function langForName(s) {
  if (!s) return null;
  const name = String(s).replace(/^[+\-]{3}\s+/, '').split('\t')[0].trim();
  const m = name.match(/\.([a-zA-Z0-9]+)$/);
  return (m && DIFF_LANGS[m[1].toLowerCase()]) || null;
}
// Подсветить кусок кода (sanitized HTML от hljs); при неизвестном языке/ошибке вернуть null.
export function highlightCode(text, lang) {
  if (!lang || !text || !hljs.getLanguage(lang)) return null;
  try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
  catch (_) { return null; }
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
// basename that survives both POSIX and Windows separators (for the Windows build).
export function baseName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p); }
export function svgEl(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
// ---------------------------------------------------------------- icon set
// One consistent line-icon family (Lucide-ish): 24-grid, currentColor stroke, rounded.
// Inner markup only; icon() wraps it. Fill-based glyphs set their own fill/stroke.
// Exported: ядру нужен сам словарь (menuRow проверяет «glyph — имя иконки или текст?»).
export const ICONS = {
  star: '<path d="M12 3.2l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.48 6.8 19.21l.99-5.79-4.21-4.1 5.82-.85z"/>',
  users: '<path d="M16 19v-1.5a4 4 0 0 0-4-4H6.5a4 4 0 0 0-4 4V19"/><circle cx="9.25" cy="7" r="3.5"/><path d="M21.5 19v-1.5a4 4 0 0 0-3-3.87"/><path d="M16.5 3.63a4 4 0 0 1 0 7.74"/>',
  'dots-v': '<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  'chevron-up': '<path d="M5 15l7-7 7 7"/>',
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17v3z"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M9.9 5.2A9.3 9.3 0 0 1 12 5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.6M6.4 7.4A16 16 0 0 0 2.5 12S6 18.5 12 18.5a8.7 8.7 0 0 0 3.5-.7"/><path d="M9.8 9.9a3 3 0 0 0 4.2 4.2"/>',
  note: '<path d="M5.5 3.5h8L19 9v10.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13 3.5V9h5.5"/><path d="M8 13h7M8 16.5h4.5"/>',
  git: '<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><circle cx="17.5" cy="9" r="2.3"/><path d="M6.5 8.3v7.4M17.5 11.3c0 3.2-3.3 3.9-6.4 3.9"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2H18.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.3 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-3.6-3.6-6.7-9-6.7z"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1" fill="currentColor" stroke="none"/>',
  'arrow-right': '<path d="M4 12h15M13 6l6 6-6 6"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10M10 12h4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
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
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  skip: '<path d="M6 5l9 7-9 7z" fill="currentColor" stroke="none"/><rect x="16.5" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  compress: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
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
  graph: '<rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="3" y="15" width="6" height="5" rx="1.5"/><rect x="15" y="9.5" width="6" height="5" rx="1.5"/><path d="M9 6.5h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5M9 17.5h2.5a1.5 1.5 0 0 0 1.5-1.5v-2.5M13 12h2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.3a2.6 2.6 0 1 1 3.6 2.4c-.85.35-1.1 1-1.1 1.8"/><circle cx="12" cy="16.7" r="1" fill="currentColor" stroke="none"/>',
  scissors: '<circle cx="6" cy="6.5" r="2.4"/><circle cx="6" cy="17.5" r="2.4"/><path d="M8.1 7.9L20 18M8.1 16.1L20 6M13.5 12.4l-1.8 1.6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.3-.3-2.3z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M5 18l4.5-4.5 3 3L16 13l3 3.5"/>',
  braces: '<path d="M8 4.5c-2 0-2.5 1-2.5 3v1.5C5.5 10.5 5 11 3.5 11M3.5 11c1.5 0 2 .5 2 2v3c0 2 .5 3 2.5 3"/><path d="M16 4.5c2 0 2.5 1 2.5 3v1.5c0 1.5.5 2 2 2M20.5 11c-1.5 0-2 .5-2 2v3c0 2-.5 3-2.5 3"/>',
  // --- «Обработка текста»: панель форматирования / закладки / история / формулы ---
  bold: '<path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7zM7 12h7.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h7M7 19h7M14.5 5l-5 14"/>',
  underline: '<path d="M6 4.5v6.5a6 6 0 0 0 12 0V4.5"/><path d="M5 19.5h14"/>',
  'align-left': '<path d="M4 6h16M4 12h10M4 18h14"/>',
  'align-center': '<path d="M4 6h16M7 12h10M6 18h12"/>',
  'align-right': '<path d="M4 6h16M10 12h10M6 18h14"/>',
  strikethrough: '<path d="M4 12h16"/><path d="M7.5 8c0-2 2-3.2 4.5-3.2 2 0 3.4.7 4 2M16 15c0 2.2-1.8 3.6-4.6 3.6-2 0-3.5-.6-4.3-1.8"/>',
  heading: '<path d="M6 5v14M18 5v14M6 12h12"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  'list-ordered': '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5h1.4v3.7M3.7 8.7h1.7"/><path d="M3.6 14.4c0-.6.5-1 1.1-1s1.1.4 1.1 1c0 1-2.1 1.4-2.1 2.6h2.2"/>',
  quote: '<path d="M5 5v14M9 8h10M9 12h10M9 16h6"/>',
  link: '<path d="M9.5 14.5l5-5M8 11.5l-1.8 1.8a3.5 3.5 0 0 0 5 5l1.8-1.8M16 12.5l1.8-1.8a3.5 3.5 0 0 0-5-5L11 7.5"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15"/>',
  code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  sigma: '<path d="M16.5 5h-9l5 7-5 7h9.5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 8v4.2l3 1.8"/>',
  minus: '<path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/>',
  sparkles: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  unfold: '<path d="M8 4h8M8 20h8"/><path d="M12 9.5l-2.5-2.5M12 9.5l2.5-2.5"/><path d="M12 14.5l-2.5 2.5M12 14.5l2.5 2.5"/>',
  fold: '<path d="M8 12h8"/><path d="M12 6.5l-2.5 2.5M12 6.5l2.5 2.5"/><path d="M12 17.5l-2.5-2.5M12 17.5l2.5-2.5"/>',
  pin: '<path d="M12 16.5V22M8.5 4.5h7l-1 5 2.5 2.5H7l2.5-2.5z"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10h3"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  send: '<path d="M3 20.5l18-8.5L3 3.5 3 10l12 2-12 2z" fill="currentColor"/>',
  formula: '<path d="M6 4h9M6 4l3.5 8L6 20h9M14 9l4 4M18 9l-4 4"/>',
  'drag-handle': '<circle cx="9" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  'align-justify': '<path d="M4 6h16M4 12h16M4 18h16"/>',
  'columns-2': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  'table-insert': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><path d="M11 11h2v2h-2z" fill="currentColor"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  'list-ol': '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 6h1v4M4 10h2M4 14h2l-2 2h2M4 18v-2l2 2"/>',
  'check-square': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2.5 2.5L16 9"/>',
  'text-color': '<path d="M5 20h14M9 16L12 4l3 12M10 12h4"/>',
  'highlighter': '<path d="M14 4l6 6-7 7-6-6 7-7zM7 11l-3 3v3h3l3-3M4 21h16"/>',
  square: '<rect x="3" y="3" width="18" height="18" rx="3"/>',
  'obs-new-file': '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  'obs-new-folder': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14h6"/>',
  'obs-sort': '<path d="M6 3v18"/><path d="M3 6l3-3 3 3"/><path d="M12 6h8"/><path d="M12 12h6"/><path d="M12 18h4"/>',
  'obs-collapse': '<rect x="5" y="8" width="14" height="8" rx="1.5"/><path d="M5 4h14M5 20h14"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4L7 20M17 4l-3 16"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};
export function icon(name, size = 16) {
  return svgEl(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
}
// Button carrying a single icon (replaces the old emoji-in-textContent buttons).
export function iconBtn(cls, name, title, size) {
  const b = el('button', cls);
  b.appendChild(icon(name, size));
  if (title) b.title = title;
  return b;
}
// Fill the static [data-icon] buttons defined in index.html (titlebar / pane toolbars).
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (node.querySelector('svg.ic')) return; // already done
    node.appendChild(icon(node.dataset.icon, +node.dataset.iconSize || 16));
  });
}

// ---------------------------------------------------------------- toasts
// Сборщик ошибок фронта: ядро прокидывает сюда lite.log (см. renderer.js), чтобы КАЖДЫЙ
// error-тост любого модуля попадал в лог редактора без правок в модулях. ui.js при этом
// остаётся чистым DOM (window.lite не импортируется — колбэк инъектируется сверху). DAG цел.
let _errSink = null;
export function setErrorSink(fn) { _errSink = typeof fn === 'function' ? fn : null; }

export function toast(msg, opts = {}) {
  if (opts.kind === 'err' && _errSink && !opts.silent) { try { _errSink(String(msg)); } catch (_) {} }
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

// Render a unified diff string into a container, line-classed like the viewer's diff.
// fileName (optional) задаёт язык подсветки; иначе берётся из строки '+++ ' в диффе.
export function renderDiffInto(view, text, fileName) {
  view.innerHTML = '';
  if (!text || !text.trim()) { view.appendChild(el('div', 'diff-empty', 'Нет изменений относительно HEAD.')); return; }
  let lang = fileName ? langForName(fileName) : null;
  for (const ln of text.split('\n')) {
    let cls = '';
    if (ln.startsWith('@@')) cls = 'hunk';
    else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('\\')) {
      cls = 'meta';
      if (!lang && ln.startsWith('+++')) lang = langForName(ln);
    } else if (ln.startsWith('+')) cls = 'add';
    else if (ln.startsWith('-')) cls = 'del';
    const row = el('div', 'diff-line ' + cls);
    if (cls === 'add' || cls === 'del' || cls === '') { // содержимое кода — подсветить, маркер +/-/пробел отдельно
      row.appendChild(el('span', 'diff-mark', ln.slice(0, 1) || ' '));
      const code = el('span', 'diff-code');
      const body = ln.slice(1);
      const hl = highlightCode(body, lang);
      if (hl != null) code.innerHTML = hl; else code.textContent = body;
      row.appendChild(code);
    } else row.textContent = ln || ' ';
    view.appendChild(row);
  }
}

// ---------------------------------------------------------------- modals
// onClose runs on EVERY close path (button, Esc, overlay-click) exactly once — so
// callers can release listeners/refs they attached (e.g. a queue's onChange) without
// leaking when the user dismisses via Esc or backdrop instead of the explicit button.
export function makeModal(innerHtml, onClose) {
  const overlay = el('div', 'modal-overlay');
  const m = el('div', 'modal');
  m.innerHTML = innerHtml;
  overlay.appendChild(m);
  $('#modal-root').appendChild(overlay);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();   // только СВОЙ оверлей — иначе закрытие вложенной модалки снесло бы родителя мимо его close()/onClose (#modal-root:empty прячет контейнер сам)
    if (onClose) { try { onClose(); } catch (_) {} }
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return { overlay, m, close };
}
// Optional middle button (altLabel/onAlt) turns this into a 3-way prompt
// (e.g. Save / Don't save / Cancel).
export function showConfirm(title, text, yesLabel, onYes, altLabel, onAlt) {
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

// small single-input prompt modal; onOk(value) may return {error} to keep the dialog open
export function showPrompt(title, label, initial, onOk) {
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
export function convertLayout(text) {
  let lat = 0, cyr = 0;
  for (const ch of text) { if (/[a-z]/i.test(ch)) lat++; else if (/[а-яё]/i.test(ch)) cyr++; }
  const map = lat >= cyr ? US_RU : RU_US;
  let out = '';
  for (const ch of text) out += (map[ch] || ch);
  return out;
}
export function applyLayoutSwap(ta) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s !== e) { // convert only the selection if there is one
    ta.value = ta.value.slice(0, s) + convertLayout(ta.value.slice(s, e)) + ta.value.slice(e);
    ta.setSelectionRange(s, e);
  } else {
    ta.value = convertLayout(ta.value);
  }
  ta.focus();
}
