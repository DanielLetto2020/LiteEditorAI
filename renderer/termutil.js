// Shared xterm helpers for modules that embed a terminal (containers exec, remotehost SSH) —
// used by both the editor (renderer.js) and module windows (module-entry.js). No core deps.
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';

const lite = window.lite;

// Real GPU (not swiftshader/llvmpipe/mesa-offscreen) → WebGL renderer is safe & smooth.
// Ответ не меняется в пределах сессии, поэтому считаем его ОДИН раз, а контекст пробы сразу
// отпускаем: живых WebGL-контекстов на вкладку немного (порядка 16), и xterm забирает свой на
// КАЖДЫЙ терминал. Раньше проба выполнялась на каждое создание терминала и оставляла свой
// контекст висеть до сборки мусора — десяток вкладок выедал лимит, браузер начинал гасить
// самые старые контексты, и живые терминалы теряли WebGL-рендерер.
let hwWebgl = null;
export function isHardwareWebgl() {
  if (hwWebgl !== null) return hwWebgl;
  hwWebgl = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      hwWebgl = !/swiftshader|llvmpipe|software|mesa offscreen/i.test(r);
      try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (_) {}
    }
  } catch (_) { hwWebgl = false; }
  return hwWebgl;
}

// Fast xterm renderer: WebGL on real GPU (smooth scroll), else Canvas. Both beat the default DOM
// renderer. On WebGL context loss → fall back to Canvas.
export function loadFastRenderer(term) {
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

// ── WebGL только у недавно показанных терминалов (окно редактора) ─────────────────────────────
// Живых WebGL-контекстов на окно у Chromium около 16, а вкладки всех открывавшихся за день
// проектов живут до закрытия проекта. Раньше WebGL получал КАЖДЫЙ терминал при создании: сверх
// лимита браузер гасил старые контексты (в реестре — CONTEXT_LOST и «object does not belong to
// this context»), и терминалы съезжали на Canvas. Скрытому терминалу GPU-отрисовка не нужна: xterm
// его не рисует, пока он не виден. Поэтому WebGL навешивается при показе и держится у WEBGL_KEEP
// последних показанных терминалов, у остальных снимается (xterm сам возвращается к DOM-рендереру,
// а вывод в буфер идёт как шёл). Без настоящего GPU — Canvas всем сразу, как было.
const WEBGL_KEEP = 4;
const webglLru = [];   // [{ term, addon }] — последний показанный в конце

function dropWebgl(entry) {
  const i = webglLru.indexOf(entry);
  if (i !== -1) webglLru.splice(i, 1);
  try { entry.addon.dispose(); } catch (_) {}
}

// Отрисовщик для нового терминала окна редактора: без GPU — Canvas сразу; с GPU — ничего,
// WebGL придёт при первом показе (activateRenderer).
export function prepareRenderer(term) {
  if (!isHardwareWebgl()) { try { term.loadAddon(new CanvasAddon()); } catch (_) {} }
}

// Терминал стал видимым — ему WebGL (или просто «освежить» место в очереди).
export function activateRenderer(term) {
  if (!term || term.__liteCanvas || !isHardwareWebgl()) return;
  const have = webglLru.find((e) => e.term === term);
  if (have) { webglLru.splice(webglLru.indexOf(have), 1); webglLru.push(have); return; }
  let addon;
  try { addon = new WebglAddon(); } catch (_) { return; }
  const entry = { term, addon };
  addon.onContextLoss(() => {
    // Контекст отняли (сброс GPU, чужой перебор лимита): этому терминалу — Canvas насовсем, как раньше.
    dropWebgl(entry);
    term.__liteCanvas = true;
    try { term.loadAddon(new CanvasAddon()); } catch (_) {}
  });
  try { term.loadAddon(addon); } catch (_) { return; }
  webglLru.push(entry);
  while (webglLru.length > WEBGL_KEEP) dropWebgl(webglLru[0]);
}

// Терминал закрывается — снять его из очереди (dispose терминала сам освободит аддон).
export function releaseRenderer(term) {
  const e = webglLru.find((x) => x.term === term);
  if (e) webglLru.splice(webglLru.indexOf(e), 1);
}

// Размер PTY вслед за xterm, но без бури. Каждое изменение числа колонок — SIGWINCH программе в
// терминале, и TUI (Claude Code / Ink) перерисовывает весь экран. При перетаскивании разделителя
// fit срабатывает на каждое движение мыши — десятки перерисовок в секунду. Поэтому: первое
// изменение после паузы уходит сразу (разовый ресайз не ждёт), серия изменений — одним итоговым
// вызовом через PTY_RESIZE_MS после последнего; тот же размер повторно не шлём.
const PTY_RESIZE_MS = 150;
export function ptyResizer(id, term) {
  let lastCall = 0, timer = null, sentCols = 0, sentRows = 0;
  const send = () => {
    timer = null;
    const { cols, rows } = term;
    if (!(cols > 0 && rows > 0) || (cols === sentCols && rows === sentRows)) return;
    sentCols = cols; sentRows = rows;
    lite.pty.resize(id, cols, rows);
  };
  return () => {
    const now = Date.now();
    const quiet = now - lastCall > PTY_RESIZE_MS;
    lastCall = now;
    if (timer) clearTimeout(timer);
    if (quiet) send();
    else timer = setTimeout(send, PTY_RESIZE_MS);
  };
}

// xterm ships Unicode V6 width tables; the unicode11 addon adds Unicode 11 tables so newer emoji
// (📁 U+1F4C1, ⏰ U+23F0…) get width 2 and stop overlapping neighbouring text.
export function applyUnicode11(term) {
  try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'; } catch (_) {}
}

// Copy the terminal's current selection to the OS clipboard; returns true if something was copied.
export function copySelection(term) {
  if (term.hasSelection && term.hasSelection()) {
    const sel = term.getSelection();
    if (sel) { lite.copyText(sel); if (term.clearSelection) term.clearSelection(); return true; }
  }
  return false;
}
