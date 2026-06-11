// LiteEditor — stateless DOM/UI helpers shared by the core and the modules.
// No imports from renderer.js (keeps the dependency graph a DAG: ui.js ← modules ← core).
// Everything here is pure DOM: no core state, no window.lite calls.

const $ = (sel) => document.querySelector(sel);

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
export function toast(msg, opts = {}) {
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
export function renderDiffInto(view, text) {
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
    $('#modal-root').innerHTML = '';
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
