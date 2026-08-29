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
