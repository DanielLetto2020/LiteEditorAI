// Shared CodeMirror helpers used by BOTH the editor (renderer.js) and module windows
// (module-entry.js → git и др. модули, которым нужен встроенный редактор/дифф). Самодостаточно:
// свои импорты CM, без зависимостей от ядра рендерера (граф DAG: codeedit ← renderer/modules).
import { EditorView, keymap, lineNumbers, drawSelection, Decoration } from '@codemirror/view';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, LanguageDescription } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { languages as LANG_REGISTRY } from '@codemirror/language-data';

// Полный реестр языков CodeMirror (@codemirror/language-data): PHP, Go, Rust, YAML, Shell и
// сотни других через lezer-пакеты + legacy-modes. Дескрипторы матчатся по имени файла
// (расширения + спец-имена вроде Dockerfile). ⚠️ Весь языковой корпус инлайнится esbuild'ом в
// module-bundle (iife без code-splitting): import() лишь откладывает ПОСТРОЕНИЕ LanguageSupport
// (резолв — следующий микротаск), а не загрузку кода — это осознанный трейдофф ради подсветки
// любых файлов офлайн.
const langCache = new Map();                    // desc.name -> LanguageSupport
function langDescFor(file) {
  const base = String(file || '').split(/[\\/]/).pop() || '';
  if (!base) return null;
  // matchFilename регистрозависим по расширению (реестр — в нижнем), а имена файлов приходят
  // всякие (NOTES.MD, Main.PY). Сначала матчим как есть (спец-имена вроде Dockerfile), затем в
  // нижнем регистре.
  return LanguageDescription.matchFilename(LANG_REGISTRY, base)
    || LanguageDescription.matchFilename(LANG_REGISTRY, base.toLowerCase());
}
// Синхронный вариант: отдаёт язык из кэша (или готовый support дескриптора); если поддержка ещё
// не загружена — возвращает [] и грузит в фоне, по готовности зовёт onLoad(support) (вызывающий
// сам переконфигурирует редактор). Для одноразовых вьюх без reconfigure — ensureLanguage ниже.
export function languageFor(file, onLoad) {
  const desc = langDescFor(file);
  if (!desc) return [];
  const cached = langCache.get(desc.name);
  if (cached) return cached;
  if (desc.support) { langCache.set(desc.name, desc.support); return desc.support; }
  desc.load().then((sup) => { langCache.set(desc.name, sup); if (onLoad) onLoad(sup); }).catch(() => {});
  return [];
}
// Await-вариант: дождаться загрузки поддержки языка (для MergeView/модалок, создаваемых один раз).
export function ensureLanguage(file) {
  const desc = langDescFor(file);
  if (!desc) return Promise.resolve([]);
  const cached = langCache.get(desc.name);
  if (cached) return Promise.resolve(cached);
  if (desc.support) { langCache.set(desc.name, desc.support); return Promise.resolve(desc.support); }
  return desc.load().then((sup) => { langCache.set(desc.name, sup); return sup; }).catch(() => []);
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
