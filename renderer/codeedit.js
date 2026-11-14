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

// Спец-алиасы по имени/расширению поверх стандартного matchFilename (например, .env, .htaccess,
// Jenkinsfile, Vagrantfile, *.prisma, *.blade.php → PHP).
const SPECIAL_NAMES = {
  '.env': 'Shell', '.env.local': 'Shell', '.env.example': 'Shell', '.env.production': 'Shell',
  '.bashrc': 'Shell', '.zshrc': 'Shell', '.profile': 'Shell',
  '.gitignore': 'Shell', '.dockerignore': 'Shell', '.npmignore': 'Shell',
  'dockerfile': 'Dockerfile', 'containerfile': 'Dockerfile',
  'makefile': 'Spreadsheet', 'gnumakefile': 'Spreadsheet',
  '.prettierrc': 'JSON', '.eslintrc': 'JSON', '.babelrc': 'JSON', 'tsconfig.json': 'JSON', 'jsconfig.json': 'JSON',
};

export function langDescByName(name) {
  if (!name || name === 'Plain Text' || name === 'plain') return null;
  return LanguageDescription.matchLanguageName(LANG_REGISTRY, String(name), true);
}

export function langDescFor(file, overrideName) {
  if (overrideName === 'Plain Text' || overrideName === 'plain') return null;
  if (overrideName) {
    const byOverride = langDescByName(overrideName);
    if (byOverride) return byOverride;
  }
  const base = String(file || '').split(/[\\/]/).pop() || '';
  if (!base) return null;
  const low = base.toLowerCase();
  if (low.endsWith('.blade.php')) return langDescByName('PHP');
  if (low.endsWith('.vue')) return langDescByName('Vue') || langDescByName('HTML');
  if (low.endsWith('.svelte')) return langDescByName('HTML');
  if (low.endsWith('.prisma') || low.endsWith('.graphql') || low.endsWith('.gql')) return langDescByName('JavaScript');
  if (SPECIAL_NAMES[low] && SPECIAL_NAMES[low] !== 'Spreadsheet') return langDescByName(SPECIAL_NAMES[low]);
  if (low.startsWith('.env.')) return langDescByName('Shell');
  return LanguageDescription.matchFilename(LANG_REGISTRY, base)
    || LanguageDescription.matchFilename(LANG_REGISTRY, low);
}

function loadFromDesc(desc, onLoad) {
  if (!desc) return [];
  const cached = langCache.get(desc.name);
  if (cached) return cached;
  if (desc.support) { langCache.set(desc.name, desc.support); return desc.support; }
  desc.load().then((sup) => { langCache.set(desc.name, sup); if (onLoad) onLoad(sup); }).catch(() => {});
  return [];
}

function ensureFromDesc(desc) {
  if (!desc) return Promise.resolve([]);
  const cached = langCache.get(desc.name);
  if (cached) return Promise.resolve(cached);
  if (desc.support) { langCache.set(desc.name, desc.support); return Promise.resolve(desc.support); }
  return desc.load().then((sup) => { langCache.set(desc.name, sup); return sup; }).catch(() => []);
}

// Синхронный вариант: отдаёт язык из кэша (или готовый support дескриптора); если поддержка ещё
// не загружена — возвращает [] и грузит в фоне, по готовности зовёт onLoad(support).
export function languageFor(file, onLoad) {
  return loadFromDesc(langDescFor(file), onLoad);
}

export function languageForSpec(file, overrideName, onLoad) {
  return loadFromDesc(langDescFor(file, overrideName), onLoad);
}

// Await-вариант: дождаться загрузки поддержки языка (для MergeView/модалок, создаваемых один раз).
export function ensureLanguage(file) {
  return ensureFromDesc(langDescFor(file));
}

export function ensureLanguageForSpec(file, overrideName) {
  return ensureFromDesc(langDescFor(file, overrideName));
}

// Человекочитаемое имя синтаксиса для статус-бара (35+ языков из реестра CM6 + точные метки расширений).
const EXT_DISPLAY = {
  js: 'JavaScript', mjs: 'JavaScript (ESM)', cjs: 'JavaScript (CJS)', jsx: 'JSX',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TSX',
  php: 'PHP', phtml: 'PHP', py: 'Python', pyw: 'Python',
  go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', cs: 'C#', c: 'C', h: 'C / C++', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  html: 'HTML', htm: 'HTML', vue: 'Vue', svelte: 'Svelte', xml: 'XML', svg: 'SVG (XML)',
  css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  json: 'JSON', jsonc: 'JSONC', yml: 'YAML', yaml: 'YAML', toml: 'TOML', ini: 'INI', conf: 'Config',
  md: 'Markdown', markdown: 'Markdown', sql: 'SQL',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Shell',
  lua: 'Lua', pl: 'Perl', r: 'R', dart: 'Dart', dockerfile: 'Dockerfile',
  diff: 'Diff', patch: 'Diff', proto: 'Protobuf', graphql: 'GraphQL', gql: 'GraphQL',
};

export function langNameFor(file, overrideName) {
  if (overrideName === 'Plain Text' || overrideName === 'plain') return '';
  if (overrideName) {
    const d = langDescByName(overrideName);
    return d ? d.name : String(overrideName);
  }
  const base = String(file || '').split(/[\\/]/).pop() || '';
  const low = base.toLowerCase();
  if (low === 'dockerfile' || low.startsWith('dockerfile.')) return 'Dockerfile';
  if (low === 'makefile' || low === 'gnumakefile') return 'Makefile';
  if (low.endsWith('.blade.php')) return 'PHP (Blade)';
  if (low === '.env' || low.startsWith('.env.')) return 'ENV';
  const dot = low.lastIndexOf('.');
  const ext = dot > 0 ? low.slice(dot + 1) : '';
  if (ext && EXT_DISPLAY[ext]) return EXT_DISPLAY[ext];
  const desc = langDescFor(file);
  return desc ? desc.name : '';
}

// Список популярных языков для пикера синтаксиса в статус-баре.
export const POPULAR_LANGUAGES = [
  'Plain Text',
  'JavaScript', 'JSX', 'TypeScript', 'TSX',
  'PHP', 'Python', 'Go', 'Rust',
  'HTML', 'Vue', 'CSS', 'SCSS', 'Less',
  'JSON', 'YAML', 'TOML', 'XML',
  'SQL', 'Markdown', 'Shell', 'Dockerfile',
  'C', 'C++', 'C#', 'Java', 'Kotlin', 'Swift',
  'Ruby', 'Lua', 'Perl', 'Protobuf', 'Diff',
];

/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/view').DecorationSet>} */
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
// выделение, курсор, подсказки, автокомплит с цветными значками типов, диагностика и панели поиска
// гармонизированы с полупрозрачным фоном окна «Графит», а токены синтаксиса идут от One Dark.
const mix = (tok, pct) => `color-mix(in srgb, var(--${tok}) ${pct}%, transparent)`;
export const liteEditorTheme = Prec.high(EditorView.theme({
  '&': { color: 'var(--text2)', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0 36px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: mix('accent', 26),
  },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--text-mute)', border: 'none', userSelect: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '34px' },
  '.cm-activeLine': { backgroundColor: mix('hover', 78) },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover-2)', color: 'var(--text-hi)' },
  '.cm-selectionMatch': { backgroundColor: mix('accent', 16), borderRadius: '2px', outline: '1px solid ' + mix('accent', 32) },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: mix('accent', 28), outline: '1px solid ' + mix('accent', 55), borderRadius: '2px', color: 'var(--text-hi)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: mix('danger', 30), outline: '1px solid var(--danger)', borderRadius: '2px' },
  '.cm-searchMatch': { backgroundColor: mix('warn', 30), outline: '1px solid ' + mix('warn', 60), borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: mix('accent', 42), outline: '1px solid var(--accent)' },
  '.cm-foldPlaceholder': { color: 'var(--text-dim)', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: '4px', padding: '0 6px' },
  '.cm-panels': { backgroundColor: 'var(--bg-pop)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-strong)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-strong)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-pop)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '8px', boxShadow: 'var(--card-shadow)', overflow: 'hidden' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--bg-pop)', borderBottomColor: 'var(--bg-pop)' },
  '.cm-tooltip-autocomplete': { minWidth: '280px', maxWidth: '520px' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: '12.5px', maxHeight: '260px', padding: '4px' },
  '.cm-tooltip-autocomplete > ul > li': { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '5px', lineHeight: '1.35' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text-hi)' },
  '.cm-completionLabel': { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-completionMatchedText': { color: 'var(--green-bright)', textDecoration: 'none', fontWeight: '700' },
  '.cm-completionDetail': { marginLeft: 'auto', color: 'var(--text-mute)', fontStyle: 'normal', fontSize: '11px', paddingLeft: '10px', maxWidth: '210px', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-completionIcon': { width: '16px', height: '16px', lineHeight: '16px', fontSize: '10px', fontWeight: '700', textAlign: 'center', borderRadius: '4px', opacity: '0.95', padding: '0', flex: '0 0 16px' },
  '.cm-completionIcon-function, .cm-completionIcon-method': { color: '#c084fc', backgroundColor: 'rgba(192,132,252,0.14)' },
  '.cm-completionIcon-class, .cm-completionIcon-interface, .cm-completionIcon-type': { color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.14)' },
  '.cm-completionIcon-variable, .cm-completionIcon-property, .cm-completionIcon-constant': { color: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.14)' },
  '.cm-completionIcon-keyword': { color: '#f472b6', backgroundColor: 'rgba(244,114,182,0.14)' },
  '.cm-completionIcon-text': { color: 'var(--text-dim)', backgroundColor: 'var(--surface-2)' },
  '.cm-specialChar': { color: 'var(--text-mute)' },
}, { dark: true }));

// Read-only набор расширений для панелей MergeView (дифф «было / стало»). Вынесен сюда из
// files.js, чтобы им мог пользоваться и модуль «Контекст»: модулю нельзя импортировать другой
// модуль (граф зависимостей — DAG ui.js ← modules ← core), а общие хелперы живут здесь.
export function mergeRoExtensions(file, onLangLoad) {
  return [
    EditorState.readOnly.of(true), EditorView.editable.of(false),
    lineNumbers(), drawSelection(),
    oneDark, syntaxHighlighting(defaultHighlightStyle, { fallback: true }), liteEditorTheme,
    ...(file ? [].concat(languageFor(file, onLangLoad)) : []),
  ];
}

// Набор расширений для РЕДАКТИРУЕМОЙ правой панели MergeView (рабочий файл против HEAD в вивере).
export function mergeRwExtensions(file, onLangLoad, extraExts = []) {
  return [
    lineNumbers(), drawSelection(), history(), indentOnInput(), bracketMatching(),
    codeFolding(), foldGutter(),
    oneDark, syntaxHighlighting(defaultHighlightStyle, { fallback: true }), liteEditorTheme,
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
    ...(file ? [].concat(languageFor(file, onLangLoad)) : []),
    ...extraExts,
  ];
}

// Lightweight read/write CodeMirror instance with line-marking + scroll helpers. Used for git
// diffs (read-only, marked add/del lines) and any module needing a code view.
export function createCodeEditor(parent, opts = {}) {
  const exts = [
    lineNumbers(), drawSelection(), history(), indentOnInput(), bracketMatching(),
    oneDark, syntaxHighlighting(defaultHighlightStyle, { fallback: true }), liteEditorTheme, marksField,
    opts.language || [],
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
  ];
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
