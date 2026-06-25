// Shared xterm helpers for modules that embed a terminal (containers exec, remotehost SSH) —
// used by both the editor (renderer.js) and module windows (module-entry.js). No core deps.
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';

const lite = window.lite;

// Real GPU (not swiftshader/llvmpipe/mesa-offscreen) → WebGL renderer is safe & smooth.
export function isHardwareWebgl() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    return !/swiftshader|llvmpipe|software|mesa offscreen/i.test(r);
  } catch (_) { return false; }
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
