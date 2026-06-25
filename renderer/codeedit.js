// Shared CodeMirror helpers used by BOTH the editor (renderer.js) and module windows
// (module-entry.js → git и др. модули, которым нужен встроенный редактор/дифф). Самодостаточно:
// свои импорты CM, без зависимостей от ядра рендерера (граф DAG: codeedit ← renderer/modules).
import { EditorView, keymap, lineNumbers, drawSelection, Decoration } from '@codemirror/view';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';

function extOf(name) { if (!name) return ''; const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }

const LANGS = {
  js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
  ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }),
  py: python, json, md: markdown, markdown, html, htm: html, css, scss: css,
};
export function languageFor(file) {
  const make = LANGS[extOf(file)];
  return make ? make() : [];
}

const setMarksEffect = StateEffect.define();
const marksField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarksEffect)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Lightweight read/write CodeMirror instance with line-marking + scroll helpers. Used for git
// diffs (read-only, marked add/del lines) and any module needing a code view.
export function createCodeEditor(parent, opts = {}) {
  const exts = [
    lineNumbers(), drawSelection(), history(), indentOnInput(), bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, marksField,
    opts.language || [],
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
  ];
  if (opts.readOnly) exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  if (opts.onChange) exts.push(EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange(u.state.doc.toString()); }));
  const view = new EditorView({ state: EditorState.create({ doc: opts.doc || '', extensions: exts }), parent });
  return {
    view,
    getValue: () => view.state.doc.toString(),
    // specs: [{ fromLine, toLine, cls }] — 1-based включительно; подсвечивает целые строки.
    setMarks: (specs) => {
      const total = view.state.doc.lines;
      const deco = [];
      for (const s of (specs || [])) {
        for (let ln = Math.max(1, s.fromLine); ln <= Math.min(total, s.toLine); ln++) {
          deco.push(Decoration.line({ class: s.cls }).range(view.state.doc.line(ln).from));
        }
      }
      deco.sort((a, b) => a.from - b.from);
      view.dispatch({ effects: setMarksEffect.of(Decoration.set(deco, true)) });
    },
    scrollToLine: (ln) => {
      const total = view.state.doc.lines;
      const pos = view.state.doc.line(Math.max(1, Math.min(total, ln))).from;
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    },
    destroy: () => view.destroy(),
  };
}
