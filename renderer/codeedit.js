// Shared CodeMirror helpers used by BOTH the editor (renderer.js) and module windows
// (module-entry.js → git и др. модули, которым нужен встроенный редактор/дифф). Самодостаточно:
// свои импорты CM, без зависимостей от ядра рендерера (граф DAG: codeedit ← renderer/modules).
import { EditorView, keymap, lineNumbers, drawSelection, Decoration } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, LanguageDescription,
  foldGutter, codeFolding, foldKeymap, foldAll, unfoldAll } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { languages as LANG_REGISTRY } from '@codemirror/language-data';

// Полный реестр языков CodeMirror (@codemirror/language-data): PHP, Go, Rust, YAML, Shell и
// сотни других через lezer-пакеты + legacy-modes. Дескрипторы матчатся по имени файла
// (расширения + спец-имена вроде Dockerfile). Сборка — ESM с разбиением на чанки (build.js):
// грамматика языка лежит в своём чанке рядом с бандлом и грузится import() при первом открытии
// файла этого языка — локально, без сети, так что подсветка любых файлов офлайн сохраняется.
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

// Оформление редактора кода из палитры «Оформления» (CSS-переменные темы): фон, поля с номерами строк,
// выделение, курсор, подсказки и панели поиска перекрашиваются вместе с редактором и лежат на
// полупрозрачном фоне окна. Цвета подсветки синтаксиса остаются от One Dark — это опознавательный
// признак языка, как цвета значков файлов. Приоритет повышен (Prec.high): при равном весе селекторов
// CodeMirror отдаёт победу теме, подключённой раньше, а oneDark в списках расширений стоит первым.
// Поле номеров плотное (цвет панели): при горизонтальной прокрутке код уезжает под него.
const mix = (tok, pct) => `color-mix(in srgb, var(--${tok}) ${pct}%, transparent)`;
export const liteEditorTheme = Prec.high(EditorView.theme({
  '&': { color: 'var(--text2)', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: mix('accent', 26) },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--text-mute)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover-2)', color: 'var(--text)' },
  '.cm-selectionMatch': { backgroundColor: mix('accent', 14) },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: mix('accent', 30) },
  '.cm-searchMatch': { backgroundColor: mix('warn', 30), outline: '1px solid ' + mix('warn', 60) },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: mix('accent', 40) },
  '.cm-foldPlaceholder': { color: 'var(--text-dim)' },
  '.cm-panels': { backgroundColor: 'var(--bg-pop)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-strong)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-strong)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-pop)', color: 'var(--text)', border: '1px solid var(--border-strong)' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--bg-pop)', borderBottomColor: 'var(--bg-pop)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
}, { dark: true }));

// Read-only набор расширений для панелей MergeView (дифф «было / стало»). Вынесен сюда из
// files.js, чтобы им мог пользоваться и модуль «Контекст»: модулю нельзя импортировать другой
// модуль (граф зависимостей — DAG ui.js ← modules ← core), а общие хелперы живут здесь.
export function mergeRoExtensions(file, onLangLoad) {
  return [
    EditorState.readOnly.of(true), EditorView.editable.of(false),
    lineNumbers(), drawSelection(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, liteEditorTheme,
    ...(file ? [].concat(languageFor(file, onLangLoad)) : []),
  ];
}

// Lightweight read/write CodeMirror instance with line-marking + scroll helpers. Used for git
// diffs (read-only, marked add/del lines) and any module needing a code view.
export function createCodeEditor(parent, opts = {}) {
  const exts = [
    lineNumbers(), drawSelection(), history(), indentOnInput(), bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, liteEditorTheme, marksField,
    opts.language || [],
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
  ];
  // wrap — длинные строки переносятся вместо горизонтальной прокрутки (читать конфиги удобнее);
  // fold — колонка со стрелками сворачивания блоков (объекты/массивы JSON, разделы markdown).
  if (opts.wrap) exts.push(EditorView.lineWrapping);
  if (opts.fold) exts.push(codeFolding(), foldGutter());
  if (opts.readOnly) exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  if (opts.onChange) exts.push(EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange(u.state.doc.toString()); }));
  const view = new EditorView({ state: EditorState.create({ doc: opts.doc || '', extensions: exts }), parent });
  return {
    view,
    getValue: () => view.state.doc.toString(),
    foldAll: () => foldAll(view),
    unfoldAll: () => unfoldAll(view),
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
