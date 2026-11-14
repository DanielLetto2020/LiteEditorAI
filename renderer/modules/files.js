// Модуль «Проект» (IDE-вивер LiteEditor):
//   - Мультибуферное ядро (BufferPool): независимые состояния Undo/Redo, скролл и выделение у каждого файла,
//     Preview-вкладки (курсивом по одиночному клику), закрепление (Pin), Drag&Drop, MRU-переключение (Ctrl+Tab),
//     разделение редактора вправо (Split Right) и виртуальные вкладки Git Diff / Сравнения;
//   - Умный анализ кода: индексатор символов по всему проекту (ProjectSymbolIndex), Go to Definition (F12 / Ctrl+Click)
//     по импортам и символам, Find Usages (Shift+F12), мультикурсорное переименование в файле, автодополнение путей,
//     сниппетов и символов проекта, синтаксическая валидация JSON/YAML и форматирование кода;
//   - Постоянные боковые панели (Поиск/Замена со стримингом gsearch, Структура, TODO/FIXME, Закладки);
//   - Дерево файлов IDE-класса (живой фильтр, Compact Middle Folders, инлайн-создание и переименование,
//     клавиатурная навигация, Copy/Cut/Paste/Duplicate);
//   - Встроенный Git: живой редактируемый Side-by-Side Diff, навигация F7/Shift+F7 и кликабельный Git-гаттер
//     в редакторе с инлайн-просмотром и откатом отдельного ханка в 1 клик.

import {
  el, icon, toast, showConfirm, baseName, extOf, fileTypeSvg, folderTypeSvg,
} from '../ui.js';
import {
  languageFor, ensureLanguage, langNameFor, mergeRoExtensions, mergeRwExtensions, liteEditorTheme,
} from '../codeedit.js';
import { t as tr } from '../i18n.js';
import { initGit } from './git.js';
import {
  createBufferPool, detectIndentSpec, convertIndentation, eolOfText, normEolText, toDiskEol, isVirtualTabId,
} from './files/buffer-pool.js';
import {
  extractFileSymbols, enclosingSymbolAtLine, SYMBOL_GLYPHS, wordAtOffset, findIdentifierRanges,
  extractImportSpecAtLine, resolveImportTarget, createProjectSymbolIndex, validateDocumentSyntax, formatCodeText,
} from './files/symbol-index.js';
import { createSmartCompletionExtension } from './files/smart-complete.js';
import { parseUnifiedDiff, findHunkAtLine, stepHunkAnchor } from './files/git-hunks.js';
import { createSidePanels } from './files/side-panels.js';
import {
  previewKindFor, safeMarkdownFragment, safeSvgFragment, createViewerOverlays,
} from './files/modals.js';

import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  gutter, GutterMarker, rectangularSelection, crosshairCursor, Decoration,
  highlightWhitespace, highlightTrailingWhitespace, scrollPastEnd,
} from '@codemirror/view';
import {
  EditorState, EditorSelection, Compartment, StateField, StateEffect, RangeSet, Prec,
} from '@codemirror/state';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, moveLineUp, moveLineDown,
  copyLineUp, copyLineDown, deleteLine, toggleComment, toggleBlockComment, selectParentSyntax,
} from '@codemirror/commands';
import {
  syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching,
  foldGutter, codeFolding, foldKeymap, foldService, indentUnit,
} from '@codemirror/language';
import {
  search, searchKeymap, highlightSelectionMatches, selectNextOccurrence, openSearchPanel,
} from '@codemirror/search';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { MergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { showMinimap } from '@replit/codemirror-minimap';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';

const lite = window.lite;
const $ = (sel) => document.querySelector(sel);

const VIEWER_UI_LS_KEY = 'lite.viewerUi';
const AUTOSAVE_MS = 420;
const MIRROR_MAX = 400000;
const WORDCHAR_RE = /[\p{L}\p{N}]/u;

// Помощники работы с путями (кроссплатформенные)
function normSlash(p) { return String(p || '').replace(/\\/g, '/'); }
function trimTrail(p) { return normSlash(p).replace(/\/+$/, ''); }
function joinPath(dir, name) { return trimTrail(dir) + '/' + String(name || '').replace(/^\/+/, ''); }
function dirName(p) {
  const s = trimTrail(p);
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : (i === 0 ? '/' : s);
}
function pathInside(child, parent) {
  const c = trimTrail(child), p = trimTrail(parent);
  return c === p || c.startsWith(p + '/');
}
function relTo(root, abs) {
  const r = trimTrail(root), a = normSlash(abs);
  return (r && a.startsWith(r + '/')) ? a.slice(r.length + 1) : a;
}
function fileUrl(absPath) {
  const s = normSlash(absPath);
  return 'file://' + (s.startsWith('/') ? '' : '/') + encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["\\])/g, '\\$1');
}

function loadViewerUiState(store) {
  try {
    const raw = localStorage.getItem(VIEWER_UI_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return (store && store.viewerUi && typeof store.viewerUi === 'object') ? { ...store.viewerUi } : {};
}

export function initFiles(host) {
  const { menuRow, placeMenu, closeMenus } = host;
  const activeProject = () => host.activeProject();
  const settings = host.settings;

  // ---- Состояние воркспейса и пула буферов
  const pool = createBufferPool();
  let viewerUi = loadViewerUiState(host.STORE);
  let wsSaveTimer = null;

  let viewerOpen = false;
  let mounted = false;
  let curSection = 'files';         // 'files' | 'commit' | 'search' | 'outline' | 'todos' | 'bookmarks' | null (свёрнута)
  let logOpen = false;              // нижняя панель Git
  let activeGroup = 'primary';      // 'primary' | 'split'
  let splitRatio = 0.5;             // доля ширины правой сплит-панели (0.2..0.8)

  // Главный и сплит-редакторы CodeMirror
  let editor = null;
  let splitEditor = null;
  let syncingMirrorChange = false;  // защита от рекурсивного эха при редактировании одного файла в обоих сплитах
  let openSeq = 0;

  // Автосейв по путям буферов: filePath -> timerId / Promise
  const autosaveTimers = new Map();
  const savingPromises = new Map();

  // Дерево и ФС
  let gitFiles = {};
  const expandedDirs = new Set();
  const dirEntriesCache = new Map(); // dirPath -> entries[] (для мгновенной фильтрации и Compact Folders)
  let treeFilter = '';
  let fileListCache = null;          // { root, files: rel[] }
  let dragSrcPath = null;
  let treeClipboard = null;          // { mode: 'copy' | 'cut', path: string }
  let cmpFirst = null;               // первый файл для сравнения двух файлов

  // Git, Дифф, Превью, Агент, Blame
  let git = null;
  let sidePanels = null;
  let overlays = null;
  let activeMergeView = null;
  let currentDiffUnified = '';
  let currentDiffParsed = { headerLines: [], hunks: [], marks: [] };
  let diffUnifiedViewMode = false;   // false = Side-by-Side MergeView, true = единый текстовый патч
  let hunkPopEl = null;

  let splitPreviewMode = false;      // сплит «Код + Превью» (Markdown / HTML / SVG)
  let splitPreviewTimer = null;
  let lastPreviewFile = null;

  let blameActive = false;
  let blameMap = null;               // Map<line1, { hash, author, time, summary, uncommitted }>
  let agentMode = false;
  const authorshipByFile = new Map();// filePath -> Map<line1, 'user' | 'agent'>

  let statusBranch = null;
  let currentDiagError = null;       // { line, col, message } для активного буфера

  // Индекс символов проекта
  const symbolIndex = createProjectSymbolIndex({
    readFile: (abs) => lite.fs.readFile(abs),
    listAll: (root) => getAllProjectFiles(root),
  });

  // ================================================================ Персист состояния воркспейса
  function saveViewerUiNow() {
    const p = activeProject();
    if (p && p.path) {
      if (!viewerUi.workspaces) viewerUi.workspaces = {};
      viewerUi.workspaces[p.path] = {
        ...pool.serializeWorkspace(p.path),
        expandedDirs: [...expandedDirs].filter((d) => pathInside(d, p.path)),
        curSection: curSection || 'files',
        splitRatio,
      };
    }
    try { localStorage.setItem(VIEWER_UI_LS_KEY, JSON.stringify(viewerUi)); } catch (_) {}
    if (host.persist) host.persist('viewerUi', viewerUi);
  }

  function scheduleSaveWorkspace() {
    clearTimeout(wsSaveTimer);
    wsSaveTimer = setTimeout(saveViewerUiNow, 500);
  }

  // ================================================================ Закладки (STORE.bookmarks)
  const bookmarksMap = (host.STORE && host.STORE.bookmarks && typeof host.STORE.bookmarks === 'object')
    ? { ...host.STORE.bookmarks }
    : {};

  function bmList() {
    const p = activeProject();
    if (!p) return [];
    if (!Array.isArray(bookmarksMap[p.path])) bookmarksMap[p.path] = [];
    return bookmarksMap[p.path];
  }

  function saveBookmarks() {
    if (host.persist) host.persist('bookmarks', bookmarksMap);
    if (sidePanels && curSection === 'bookmarks') sidePanels.refreshActive();
  }

  // ================================================================ CodeMirror: Поля, Гаттеры и Компартменты
  const setGitGutterEffect = StateEffect.define();
  const setBookmarksEffect = StateEffect.define();
  const setBlameEffect = StateEffect.define();
  const setAuthorEffect = StateEffect.define();
  const setDiagEffect = StateEffect.define();
  const setMirrorHlEffect = StateEffect.define();
  const setCtrlHoverEffect = StateEffect.define();

  class GitBarMarker extends GutterMarker {
    constructor(kind) { super(); this.kind = kind; }
    eq(other) { return other.kind === this.kind; }
    toDOM() { return el('div', 'cm-git-' + this.kind); }
  }
  const gitMarkers = {
    add: new GitBarMarker('add'),
    mod: new GitBarMarker('mod'),
    del: new GitBarMarker('del'),
  };

  const gitGutterField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setGitGutterEffect)) {
          const items = [];
          const doc = tr.state.doc;
          for (const m of (e.value || [])) {
            if (m.line >= 1 && m.line <= doc.lines && gitMarkers[m.type]) {
              items.push(gitMarkers[m.type].range(doc.line(m.line).from));
            }
          }
          items.sort((a, b) => a.from - b.from);
          set = RangeSet.of(items, true);
        }
      }
      return set;
    },
  });

  class BookmarkDotMarker extends GutterMarker {
    constructor(label) { super(); this.label = label || ''; }
    eq(other) { return other.label === this.label; }
    toDOM() {
      const d = el('div', 'cm-bm-dot', '★');
      d.title = this.label ? `Закладка: ${this.label}` : 'Закладка (Ctrl+F2 снять)';
      return d;
    }
  }

  const bookmarkField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setBookmarksEffect)) {
          const items = [];
          const doc = tr.state.doc;
          for (const b of (e.value || [])) {
            if (b.line >= 1 && b.line <= doc.lines) {
              items.push(new BookmarkDotMarker(b.label).range(doc.line(b.line).from));
            }
          }
          items.sort((a, b) => a.from - b.from);
          set = RangeSet.of(items, true);
        }
      }
      return set;
    },
  });

  class BlameLineMarker extends GutterMarker {
    constructor(text, tip) { super(); this.text = text; this.tip = tip; }
    eq(other) { return other.text === this.text; }
    toDOM() {
      const s = el('span', 'cm-blame-lbl', this.text);
      if (this.tip) s.title = this.tip;
      return s;
    }
  }

  const blameField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setBlameEffect)) {
          if (!e.value) { set = RangeSet.empty; continue; }
          const items = [];
          const doc = tr.state.doc;
          for (const [ln, info] of e.value.entries()) {
            if (ln >= 1 && ln <= doc.lines) {
              const shortAuthor = (info.uncommitted ? 'Вы (не закоммичено)' : (info.author || '').slice(0, 14));
              const tip = info.uncommitted
                ? 'Незакоммиченные правки'
                : `${info.hash} · ${info.author}\n${info.summary || ''}`;
              items.push(new BlameLineMarker(shortAuthor, tip).range(doc.line(ln).from));
            }
          }
          items.sort((a, b) => a.from - b.from);
          set = RangeSet.of(items, true);
        }
      }
      return set;
    },
  });

  class AuthorBarMarker extends GutterMarker {
    constructor(who) { super(); this.who = who; }
    eq(other) { return other.who === this.who; }
    toDOM() {
      const d = el('div', 'cm-auth-' + this.who);
      d.title = this.who === 'agent' ? 'Изменено агентом на диске' : 'Изменено вами в редакторе';
      return d;
    }
  }

  const authorField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setAuthorEffect)) {
          if (!e.value) { set = RangeSet.empty; continue; }
          const items = [];
          const doc = tr.state.doc;
          for (const [ln, who] of e.value.entries()) {
            if (ln >= 1 && ln <= doc.lines) {
              items.push(new AuthorBarMarker(who).range(doc.line(ln).from));
            }
          }
          items.sort((a, b) => a.from - b.from);
          set = RangeSet.of(items, true);
        }
      }
      return set;
    },
  });

  // Синтаксическая диагностика (волнистая красная линия на строке ошибки JSON/YAML)
  const diagDecoField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setDiagEffect)) {
          const errs = e.value || [];
          if (!errs.length) { deco = Decoration.none; continue; }
          const doc = tr.state.doc;
          const ranges = [];
          for (const err of errs) {
            const ln = Math.max(1, Math.min(doc.lines, err.line || 1));
            const lineObj = doc.line(ln);
            ranges.push(Decoration.line({ attributes: { class: 'cm-diag-err-line', title: err.message } }).range(lineObj.from));
          }
          deco = Decoration.set(ranges, true);
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Зеркальная подсветка выделения для Markdown Split
  const mirrorDecoField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setMirrorHlEffect)) {
          const v = e.value;
          if (!v || v.from >= v.to || v.to > tr.state.doc.length) deco = Decoration.none;
          else deco = Decoration.set([Decoration.mark({ class: 'cm-mirror-hl' }).range(v.from, v.to)]);
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Подчёркивание кликабельного символа / пути импорта при зажатом Ctrl
  const ctrlLinkField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setCtrlHoverEffect)) {
          const v = e.value;
          if (!v || v.from >= v.to || v.to > tr.state.doc.length) deco = Decoration.none;
          else deco = Decoration.set([Decoration.mark({ class: 'cm-ctrl-link' }).range(v.from, v.to)]);
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Markdown заголовки: code folding от # до следующего заголовка того же/верхнего уровня
  const markdownHeadingFold = foldService.of((state, lineStart) => {
    const first = state.doc.lineAt(lineStart);
    const m = first.text.match(/^(#{1,6})\s+/);
    if (!m) return null;
    const lvl = m[1].length;
    let endPos = first.to;
    for (let ln = first.number + 1; ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln);
      const hm = line.text.match(/^(#{1,6})\s+/);
      if (hm && hm[1].length <= lvl) break;
      endPos = line.to;
    }
    return endPos > first.to ? { from: first.to, to: endPos } : null;
  });

  // Компартменты динамических настроек редактора
  const langComp = new Compartment();
  const roComp = new Compartment();
  const indentComp = new Compartment();
  const wrapComp = new Compartment();
  const wsComp = new Compartment();
  const minimapComp = new Compartment();
  const keymapPresetComp = new Compartment();
  const typoComp = new Compartment();
  const blameGutterComp = new Compartment();
  const authorGutterComp = new Compartment();

  function buildTypoExtension() {
    const sz = Math.max(10, Math.min(28, Number(settings.viewerFontSize || settings.fontSize) || 13));
    const lh = Number(settings.viewerLineHeight) || 1.55;
    const lig = settings.viewerLigatures !== false;
    return EditorView.theme({
      '&': { fontSize: sz + 'px' },
      '.cm-content, .cm-gutters': {
        lineHeight: String(lh),
        fontVariantLigatures: lig ? 'contextual common-ligatures' : 'none',
      },
    });
  }

  function buildIndentExtension(indentSpec) {
    const spec = indentSpec || { unit: '  ', tabSize: 2, useTabs: false };
    return [
      EditorState.tabSize.of(spec.tabSize || 2),
      indentUnit.of(spec.useTabs ? '\t' : ' '.repeat(spec.tabSize || 2)),
    ];
  }

  function buildWrapExtension() {
    return settings.viewerWordWrap ? EditorView.lineWrapping : [];
  }

  function buildWhitespaceExtension() {
    const exts = [highlightTrailingWhitespace()];
    if (settings.viewerShowWhitespace) exts.push(highlightWhitespace());
    return exts;
  }

  function buildMinimapExtension() {
    if (!settings.minimap) return [];
    return showMinimap.compute(['doc'], () => ({
      create: () => ({ dom: el('div', 'cm-minimap-inner') }),
      displayText: 'blocks',
      showOverlay: 'mouse-over',
    }));
  }

  function buildPresetKeymap() {
    const preset = settings.viewerKeymap === 'jetbrains' ? 'jetbrains' : 'vscode';
    if (preset === 'jetbrains') {
      return Prec.high(keymap.of([
        { key: 'Mod-d', run: copyLineDown },
        { key: 'Mod-y', run: deleteLine },
        { key: 'Alt-j', run: selectNextOccurrence },
        { key: 'Mod-Alt-l', run: () => { formatActiveDocument(); return true; } },
        { key: 'Shift-F6', run: () => { renameSymbolInActiveEditor(); return true; } },
        { key: 'Mod-w', run: selectParentSyntax },
      ]));
    }
    return Prec.high(keymap.of([
      { key: 'Mod-d', run: selectNextOccurrence },
      { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
      { key: 'Shift-Alt-ArrowUp', run: copyLineUp },
      { key: 'Shift-Mod-k', run: deleteLine },
      { key: 'Shift-Alt-f', run: () => { formatActiveDocument(); return true; } },
      { key: 'F2', run: () => { renameSymbolInActiveEditor(); return true; } },
    ]));
  }

  function buildBlameGutterExt() {
    if (!blameActive) return [];
    return gutter({
      class: 'cm-blame-gutter',
      markers: (v) => v.state.field(blameField),
    });
  }

  function buildAuthorGutterExt() {
    if (!agentMode) return [];
    return gutter({
      class: 'cm-author-gutter',
      markers: (v) => v.state.field(authorField),
    });
  }

  function buildReadOnlyExt(ro) {
    return ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
  }

  // Умное автодополнение (пути, сниппеты, символы проекта и буферы)
  const smartCompletionExt = createSmartCompletionExtension({
    getCurrentFile: () => getActiveBufferFile(),
    getProjectRoot: () => activeProject()?.path || null,
    getAllRelFiles: () => (fileListCache && fileListCache.root === activeProject()?.path) ? fileListCache.files : [],
    symbolIndex,
    getOpenDocsText: () => {
      const texts = [];
      const cur = getActiveBufferFile();
      for (const b of pool.allBuffers()) {
        if (b.kind !== 'file' || b.id === cur || !b.state) continue;
        if (b.state.doc.length <= 150000) texts.push(b.state.doc.toString());
      }
      return texts;
    },
  });

  function syncSettingsEffectsForBuf(buf) {
    return [
      typoComp.reconfigure(buildTypoExtension()),
      wrapComp.reconfigure(buildWrapExtension()),
      wsComp.reconfigure(buildWhitespaceExtension()),
      minimapComp.reconfigure(buildMinimapExtension()),
      keymapPresetComp.reconfigure(buildPresetKeymap()),
      blameGutterComp.reconfigure(buildBlameGutterExt()),
      authorGutterComp.reconfigure(buildAuthorGutterExt()),
      roComp.reconfigure(buildReadOnlyExt(buf ? buf.readOnly : false)),
      indentComp.reconfigure(buildIndentExtension(buf ? buf.indent : null)),
    ];
  }

  function reconfigureLiveEditors() {
    const b1 = getGroupFileBuffer('primary');
    if (editor && b1) editor.dispatch({ effects: syncSettingsEffectsForBuf(b1) });
    const b2 = getGroupFileBuffer('split');
    if (splitEditor && b2) splitEditor.dispatch({ effects: syncSettingsEffectsForBuf(b2) });
    updateWrapButton();
    updateKeymapStatus();
  }

  // Создаёт полный набор расширений CodeMirror для конкретного файлового буфера
  function createExtensionsForBuffer(buf, groupHint = 'primary') {
    const filePath = buf.path;
    const onLangLoaded = (sup) => {
      const targetView = getGroupActiveId('primary') === filePath ? editor
        : (getGroupActiveId('split') === filePath ? splitEditor : null);
      if (targetView) targetView.dispatch({ effects: langComp.reconfigure(sup) });
    };

    return [
      lineNumbers({
        domEventHandlers: {
          contextmenu: (view, line, event) => {
            event.preventDefault();
            const lineNum = view.state.doc.lineAt(line.from).number;
            showGutterContextMenu(event.clientX, event.clientY, filePath, lineNum);
            return true;
          },
        },
      }),
      gutter({
        class: 'cm-git-gutter',
        markers: (v) => v.state.field(gitGutterField),
        domEventHandlers: {
          mousedown: (view, line, event) => {
            const lineNum = view.state.doc.lineAt(line.from).number;
            if (openInlineHunkPopover(filePath, lineNum, event.clientX, event.clientY)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      }),
      gutter({
        class: 'cm-bm-gutter',
        markers: (v) => v.state.field(bookmarkField),
        domEventHandlers: {
          mousedown: (view, line, event) => {
            if (event.button !== 0) return false;
            const lineNum = view.state.doc.lineAt(line.from).number;
            toggleBookmarkAt(filePath, lineNum);
            event.preventDefault();
            return true;
          },
        },
      }),
      blameGutterComp.of(buildBlameGutterExt()),
      authorGutterComp.of(buildAuthorGutterExt()),
      gitGutterField,
      bookmarkField,
      blameField,
      authorField,
      diagDecoField,
      mirrorDecoField,
      ctrlLinkField,
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      codeFolding(),
      foldGutter({ openText: '▾', closedText: '▸' }),
      markdownHeadingFold,
      indentationMarkers({ highlightActiveBlock: true, thickness: 1 }),
      history({ minDepth: 250 }),
      search({ top: true }),
      highlightSelectionMatches(),
      autocompletion({ activateOnTyping: true, maxRenderedOptions: 60 }),
      smartCompletionExt,
      scrollPastEnd(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      liteEditorTheme,
      typoComp.of(buildTypoExtension()),
      indentComp.of(buildIndentExtension(buf.indent)),
      wrapComp.of(buildWrapExtension()),
      wsComp.of(buildWhitespaceExtension()),
      minimapComp.of(buildMinimapExtension()),
      roComp.of(buildReadOnlyExt(buf.readOnly)),
      langComp.of(languageFor(filePath, onLangLoaded, buf.langOverride)),
      keymapPresetComp.of(buildPresetKeymap()),
      keymap.of([
        { key: 'Mod-s', run: () => { saveBufferNow(filePath, true); return true; } },
        { key: 'Mod-/', run: toggleComment },
        { key: 'Shift-Alt-a', run: toggleBlockComment },
        { key: 'Alt-ArrowUp', run: moveLineUp },
        { key: 'Alt-ArrowDown', run: moveLineDown },
        { key: 'F12', run: (view) => { goToDefinitionFromView(view, filePath); return true; } },
        { key: 'Shift-F12', run: (view) => { findUsagesFromView(view, filePath); return true; } },
        { key: 'F7', run: (view) => { jumpGitHunkInView(view, filePath, 1); return true; } },
        { key: 'Shift-F7', run: (view) => { jumpGitHunkInView(view, filePath, -1); return true; } },
        indentWithTab,
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({
        focus: () => {
          setActiveGroup(editor && editor.state === buf.state ? 'primary' : (splitEditor && splitEditor.state === buf.state ? 'split' : groupHint));
        },
        mousemove: (event, view) => {
          if (!event.ctrlKey && !event.metaKey) {
            if (view.state.field(ctrlLinkField, false) !== Decoration.none) {
              view.dispatch({ effects: setCtrlHoverEffect.of(null) });
            }
            return false;
          }
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          const imp = extractImportSpecAtLine(line.text, pos - line.from);
          if (imp) {
            const idx = line.text.indexOf(imp);
            if (idx >= 0) {
              view.dispatch({ effects: setCtrlHoverEffect.of({ from: line.from + idx, to: line.from + idx + imp.length }) });
              return false;
            }
          }
          const w = wordAtOffset(view.state.doc.toString(), pos);
          view.dispatch({ effects: setCtrlHoverEffect.of(w ? { from: w.from, to: w.to } : null) });
          return false;
        },
        mouseleave: (_e, view) => {
          if (view.state.field(ctrlLinkField, false) !== Decoration.none) {
            view.dispatch({ effects: setCtrlHoverEffect.of(null) });
          }
          return false;
        },
        mousedown: (event, view) => {
          if (event.button === 0 && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos != null) {
              event.preventDefault();
              view.dispatch({ selection: { anchor: pos }, effects: setCtrlHoverEffect.of(null) });
              goToDefinitionFromView(view, filePath);
              return true;
            }
          }
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        // Синхронизируем ссылку состояния в записи буфера
        if (u.view === editor && getGroupActiveId('primary') === filePath) buf.state = u.state;
        else if (u.view === splitEditor && getGroupActiveId('split') === filePath) buf.splitState = u.state;

        if (u.docChanged) {
          onBufferDocChanged(buf, u);
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const ln = u.state.doc.lineAt(head);
          buf.cursorLine = ln.number;
          buf.cursorCol = head - ln.from + 1;
          if (isFocusedEditorView(u.view)) {
            updateStatusFromState(u.state, buf);
            updateBreadcrumbs(u.state, buf);
            if (sidePanels) sidePanels.onCursorLine(ln.number);
            if (splitPreviewMode && u.view === editor) scheduleMirrorFromSource();
          }
        }
      }),
    ];
  }

  function isFocusedEditorView(view) {
    if (activeGroup === 'split' && splitEditor && view === splitEditor) return true;
    if (activeGroup === 'primary' && editor && view === editor) return true;
    return view === editor && !splitEditor;
  }

  function getGroupActiveId(group) {
    return pool.groupState(group).active;
  }

  function getGroupFileBuffer(group) {
    const id = getGroupActiveId(group);
    if (!id || isVirtualTabId(id)) return null;
    return pool.getBuffer(id);
  }

  function getActiveBuffer() {
    return getGroupFileBuffer(activeGroup) || getGroupFileBuffer('primary');
  }

  function getActiveBufferFile() {
    const b = getActiveBuffer();
    return b ? b.path : null;
  }

  function getActiveEditorView() {
    if (activeGroup === 'split' && splitEditor && getGroupFileBuffer('split')) return splitEditor;
    return editor;
  }

  function setActiveGroup(group) {
    if (activeGroup === group) return;
    activeGroup = group;
    $('#editor-main-wrap')?.classList.toggle('is-focused-group', group === 'primary');
    $('#editor-split-pane')?.classList.toggle('is-focused-group', group === 'split');
    const b = getActiveBuffer();
    const v = getActiveEditorView();
    if (b && v) {
      updateStatusFromState(v.state, b);
      updateBreadcrumbs(v.state, b);
      updateHeaderForBuffer(b);
      if (sidePanels) sidePanels.onFileOpened(b.path);
    }
  }

  // ================================================================ Обработка изменений документа, Автосейв и Валидация
  let diagTimer = null;

  function onBufferDocChanged(buf, update) {
    // Превью-вкладка промоутится в постоянную при первой же правке!
    pool.promotePreview(buf.id);

    // Зеркалирование, если тот же самый файл открыт во второй группе сплита
    if (!syncingMirrorChange) {
      syncingMirrorChange = true;
      try {
        if (update.view === editor && splitEditor && getGroupActiveId('split') === buf.id) {
          splitEditor.dispatch({ changes: update.changes });
          buf.splitState = splitEditor.state;
        } else if (update.view === splitEditor && editor && getGroupActiveId('primary') === buf.id) {
          editor.dispatch({ changes: update.changes });
          buf.state = editor.state;
        }
      } finally {
        syncingMirrorChange = false;
      }
    }

    const curText = update.state.doc.toString();
    const isDirty = buf.diskBase !== null && curText !== buf.diskBase;
    setBufferDirty(buf, isDirty);

    // Слой авторства строк (в режиме агента помечаем строки пользователя)
    if (agentMode) {
      let map = authorshipByFile.get(buf.path);
      if (!map) { map = new Map(); authorshipByFile.set(buf.path, map); }
      update.changes.iterChangedRanges((_fA, _tA, fromB, toB) => {
        const l1 = update.state.doc.lineAt(fromB).number;
        const l2 = update.state.doc.lineAt(toB).number;
        for (let l = l1; l <= l2; l++) map.set(l, 'user');
      });
      update.view.dispatch({ effects: setAuthorEffect.of(map) });
    }

    // Обновляем сплит-превью Markdown/SVG
    if (splitPreviewMode && getGroupActiveId('primary') === buf.id) {
      clearTimeout(splitPreviewTimer);
      splitPreviewTimer = setTimeout(() => refreshSplitPreview(), 180);
    }

    // Синтаксическая валидация JSON/YAML + обновление индекса символов
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => {
      runBufferDiagnostics(buf, update.view);
      const p = activeProject();
      if (p && pathInside(buf.path, p.path)) {
        symbolIndex.updateFromOpenBuffer(relTo(p.path, buf.path), curText);
      }
      if (sidePanels && curSection === 'outline') sidePanels.onDocChanged();
    }, 220);

    // Автосохранение (если нет конфликта на диске и не только для чтения)
    if (isDirty && !buf.readOnly && !buf.conflictOnDisk && settings.viewerAutosave !== false) {
      scheduleAutosave(buf.path);
    }
  }

  function setBufferDirty(buf, v) {
    if (buf.dirty === v) return;
    buf.dirty = v;
    if (getActiveBufferFile() === buf.path) {
      $('#viewer-dirty')?.classList.toggle('show', v);
    }
    renderAllTabBars();
  }

  function runBufferDiagnostics(buf, targetView) {
    if (!buf) return;
    const view = targetView || (getGroupActiveId('primary') === buf.id ? editor : (getGroupActiveId('split') === buf.id ? splitEditor : null));
    if (!view) return;
    const text = view.state.doc.toString();
    const errs = validateDocumentSyntax(text, extOf(buf.path));
    view.dispatch({ effects: setDiagEffect.of(errs) });
    if (getActiveBufferFile() === buf.path) {
      currentDiagError = errs[0] || null;
      const diagBtn = $('#vs-diag');
      if (diagBtn) {
        if (currentDiagError) {
          diagBtn.classList.remove('hidden');
          diagBtn.textContent = `⚠ Стр. ${currentDiagError.line}`;
          diagBtn.title = `${currentDiagError.message} (клик — перейти)`;
        } else {
          diagBtn.classList.add('hidden');
          diagBtn.textContent = '';
        }
      }
    }
  }

  function scheduleAutosave(filePath) {
    if (autosaveTimers.has(filePath)) clearTimeout(autosaveTimers.get(filePath));
    const t = setTimeout(() => {
      autosaveTimers.delete(filePath);
      saveBufferNow(filePath, false);
    }, AUTOSAVE_MS);
    autosaveTimers.set(filePath, t);
  }

  async function cancelAutosaveFor(filePath) {
    if (autosaveTimers.has(filePath)) {
      clearTimeout(autosaveTimers.get(filePath));
      autosaveTimers.delete(filePath);
    }
    if (savingPromises.has(filePath)) {
      try { await savingPromises.get(filePath); } catch (_) {}
    }
  }

  async function saveBufferNow(filePath, explicitUserSave = false) {
    const buf = pool.getBuffer(filePath);
    if (!buf || buf.kind !== 'file' || buf.readOnly) return true;
    if (!explicitUserSave && buf.conflictOnDisk) return false;
    if (autosaveTimers.has(filePath)) {
      clearTimeout(autosaveTimers.get(filePath));
      autosaveTimers.delete(filePath);
    }
    if (savingPromises.has(filePath)) {
      try { await savingPromises.get(filePath); } catch (_) {}
    }

    const view = getGroupActiveId('primary') === filePath ? editor
      : (getGroupActiveId('split') === filePath ? splitEditor : null);
    let currentState = view ? view.state : buf.state;
    if (!currentState) return true;

    // Опция: убирать хвостовые пробелы при явном сохранении Ctrl+S (или если включено в настройках)
    if ((explicitUserSave || settings.trimTrailingOnSave) && settings.trimTrailingOnSave) {
      const raw = currentState.doc.toString();
      const cleaned = formatCodeText(raw, extOf(filePath), buf.indent, true);
      if (cleaned !== raw && view) {
        const head = Math.min(cleaned.length, view.state.selection.main.head);
        view.dispatch({ changes: { from: 0, to: raw.length, insert: cleaned }, selection: { anchor: head } });
        currentState = view.state;
      }
    }

    const docText = currentState.doc.toString();
    if (!buf.dirty && !explicitUserSave) return true;

    const p = (async () => {
      const res = await lite.fs.writeFile(filePath, toDiskEol(docText, buf.docEol));
      if (res && res.error) {
        toast(res.error, { kind: 'err', ttl: 6000 });
        return false;
      }
      buf.diskBase = docText;
      buf.conflictOnDisk = false;
      setBufferDirty(buf, false);
      if (getActiveBufferFile() === filePath) hideReloadBar();
      updateGitGutterForBuffer(buf);
      refreshGitMarks();
      if (explicitUserSave) toast('Сохранено: ' + baseName(filePath), { ttl: 1400 });
      return true;
    })();

    savingPromises.set(filePath, p);
    try {
      return await p;
    } finally {
      if (savingPromises.get(filePath) === p) savingPromises.delete(filePath);
    }
  }

  async function flushAllDirtyBuffers() {
    const dirtyBufs = pool.allBuffers().filter((b) => b.kind === 'file' && b.dirty && !b.readOnly && !b.conflictOnDisk);
    for (const b of dirtyBufs) {
      await saveBufferNow(b.path, false);
    }
  }

  // ================================================================ Инициализация EditorView (основной и сплит)
  function ensureMainEditor() {
    if (editor) return editor;
    editor = new EditorView({
      state: EditorState.create({ doc: '', extensions: [oneDark, liteEditorTheme] }),
      parent: $('#editor'),
    });
    editor.contentDOM.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const b = getGroupFileBuffer('primary');
      if (b) showEditorContextMenu(e.clientX, e.clientY, editor, b);
    });
    editor.scrollDOM.addEventListener('scroll', () => {
      const b = getGroupFileBuffer('primary');
      if (b) {
        b.scrollTop = editor.scrollDOM.scrollTop;
        b.scrollLeft = editor.scrollDOM.scrollLeft;
      }
      if (splitPreviewMode) syncScrollFrom(editor.scrollDOM, $('#preview-view'));
      closeInlineHunkPopover();
    }, { passive: true });
    return editor;
  }

  function ensureSplitEditor() {
    if (splitEditor) return splitEditor;
    splitEditor = new EditorView({
      state: EditorState.create({ doc: '', extensions: [oneDark, liteEditorTheme] }),
      parent: $('#editor-split'),
    });
    splitEditor.contentDOM.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const b = getGroupFileBuffer('split');
      if (b) showEditorContextMenu(e.clientX, e.clientY, splitEditor, b);
    });
    splitEditor.scrollDOM.addEventListener('scroll', () => {
      const b = getGroupFileBuffer('split');
      if (b) {
        b.splitScrollTop = splitEditor.scrollDOM.scrollTop;
        b.splitScrollLeft = splitEditor.scrollDOM.scrollLeft;
      }
      closeInlineHunkPopover();
    }, { passive: true });
    return splitEditor;
  }

  // ================================================================ Открытие файлов и переключение вкладок
  async function openFileInViewer(filePath, line = null, opts = {}) {
    if (!filePath) return;
    const normPath = normSlash(filePath);
    const targetGroup = opts.group || (activeGroup === 'split' && pool.groupState('split').tabs.length ? 'split' : 'primary');
    const preview = opts.preview === true;

    if (!viewerOpen) setViewerOpen(true);
    ensureMainEditor();

    const seq = ++openSeq;
    closeInlineHunkPopover();

    // Сохраняем позицию текущей вкладки в историю навигации перед переходом
    if (!opts.fromNav) recordCurrentNavPoint(targetGroup);

    const kind = previewKindFor(normPath);

    // 1. Картинки (PNG/JPG/WEBP/GIF/ICO) — бинарное превью как полноценная вкладка
    if (kind === 'image') {
      pool.ensureBuffer(normPath, {
        kind: 'file',
        title: baseName(normPath),
        path: normPath,
        viewMode: 'image',
        readOnly: true,
      });
      pool.openTabInGroup('primary', normPath, { preview });
      activateTabInGroup('primary', normPath, { fromNav: opts.fromNav });
      highlightTreeActive(normPath);
      scheduleSaveWorkspace();
      return;
    }

    // 2. Текстовый файл: если уже загружен в BufferPool — переключаем мгновенно (0 IPC)!
    let buf = pool.getBuffer(normPath);
    if (!buf || !buf.state) {
      const res = await lite.fs.readFile(normPath);
      if (seq !== openSeq && targetGroup === 'primary') return;
      if (!res || res.error) {
        toast((res && res.error) || 'Не удалось открыть файл', { kind: 'err' });
        return;
      }
      const docEol = eolOfText(res.content);
      const cleanDoc = normEolText(res.content);
      const indent = detectIndentSpec(cleanDoc);
      buf = pool.ensureBuffer(normPath, {
        kind: 'file',
        title: baseName(normPath),
        path: normPath,
        docEol,
        diskBase: cleanDoc,
        readOnly: !!res.notUtf8,
        indent,
        viewMode: 'code',
      });
      buf.docEol = docEol;
      buf.diskBase = cleanDoc;
      buf.readOnly = !!res.notUtf8;
      buf.indent = indent;
      buf.state = EditorState.create({
        doc: cleanDoc,
        extensions: createExtensionsForBuffer(buf, targetGroup),
      });
      if (res.notUtf8) {
        toast('Файл не в UTF-8 — открыт только для чтения', { kind: 'warn', ttl: 5000 });
      }
    }

    pool.openTabInGroup(targetGroup, normPath, { preview });
    activateTabInGroup(targetGroup, normPath, { line, col: opts.col || 1, fromNav: opts.fromNav, focus: opts.focus !== false });
    highlightTreeActive(normPath);
    scheduleSaveWorkspace();
  }

  function activateTabInGroup(group, tabId, opts = {}) {
    if (!tabId) return;
    closeInlineHunkPopover();

    // Сохраняем скролл предыдущего буфера этой группы
    const prevId = getGroupActiveId(group);
    if (prevId && prevId !== tabId && !isVirtualTabId(prevId)) {
      const prevBuf = pool.getBuffer(prevId);
      const v = group === 'split' ? splitEditor : editor;
      if (prevBuf && v) {
        if (group === 'split') {
          prevBuf.splitState = v.state;
          prevBuf.splitScrollTop = v.scrollDOM.scrollTop;
          prevBuf.splitScrollLeft = v.scrollDOM.scrollLeft;
        } else {
          prevBuf.state = v.state;
          prevBuf.scrollTop = v.scrollDOM.scrollTop;
          prevBuf.scrollLeft = v.scrollDOM.scrollLeft;
        }
      }
    }

    pool.openTabInGroup(group, tabId, { preview: undefined, activate: true });
    setActiveGroup(group);

    const buf = pool.getBuffer(tabId);
    if (!buf) {
      renderAllTabBars();
      syncEmptyState();
      return;
    }

    // Виртуальные вкладки (Diff / Commit Diff / Compare) живут в основной области (#diff-view)
    if (isVirtualTabId(tabId)) {
      renderVirtualDiffBuffer(buf);
      renderAllTabBars();
      syncSplitVisibility();
      syncEmptyState();
      if (!opts.fromNav) recordCurrentNavPoint('primary');
      return;
    }

    // Обычный файл в правой сплит-группе
    if (group === 'split') {
      const sv = ensureSplitEditor();
      if (!buf.splitState) {
        const docStr = buf.state ? buf.state.doc.toString() : (buf.diskBase || '');
        buf.splitState = EditorState.create({
          doc: docStr,
          extensions: createExtensionsForBuffer(buf, 'split'),
        });
      }
      sv.setState(buf.splitState);
      sv.dispatch({ effects: syncSettingsEffectsForBuf(buf) });
      syncSplitVisibility();
      requestAnimationFrame(() => {
        if (opts.line && opts.line > 0) gotoLineColInView(sv, opts.line, opts.col || 1, opts.focus !== false);
        else {
          sv.scrollDOM.scrollTop = buf.splitScrollTop || 0;
          sv.scrollDOM.scrollLeft = buf.splitScrollLeft || 0;
          if (opts.focus !== false) sv.focus();
        }
      });
      updateGitGutterForBuffer(buf, sv);
      refreshBookmarksForBuffer(buf, sv);
      runBufferDiagnostics(buf, sv);
      updateHeaderForBuffer(buf);
      updateStatusFromState(sv.state, buf);
      updateBreadcrumbs(sv.state, buf);
      renderAllTabBars();
      syncEmptyState();
      if (!opts.fromNav) recordCurrentNavPoint('split');
      return;
    }

    // Обычный файл в основной группе ('primary')
    teardownActiveDiffDom();

    if (buf.viewMode === 'image') {
      $('#editor').style.display = 'none';
      $('#preview-view').style.display = 'block';
      fillPreviewPane('image', buf.path, '');
      updateHeaderForBuffer(buf);
      updateStatusForImage(buf.path);
      renderAllTabBars();
      syncSplitVisibility();
      syncEmptyState();
      return;
    }

    const mv = ensureMainEditor();
    mv.setState(buf.state);
    mv.dispatch({ effects: syncSettingsEffectsForBuf(buf) });

    // Применяем режим просмотра буфера (code / split / preview) для md/html/svg
    applyBufferViewMode(buf);

    requestAnimationFrame(() => {
      if (opts.line && opts.line > 0) {
        gotoLineColInView(mv, opts.line, opts.col || 1, opts.focus !== false);
      } else {
        mv.scrollDOM.scrollTop = buf.scrollTop || 0;
        mv.scrollDOM.scrollLeft = buf.scrollLeft || 0;
        if (opts.focus !== false && buf.viewMode !== 'preview') mv.focus();
      }
    });

    updateGitGutterForBuffer(buf, mv);
    refreshBookmarksForBuffer(buf, mv);
    if (blameActive) loadBlameForFile(buf.path);
    runBufferDiagnostics(buf, mv);
    updateHeaderForBuffer(buf);
    updateStatusFromState(mv.state, buf);
    updateBreadcrumbs(mv.state, buf);
    if (buf.conflictOnDisk) showReloadBar(); else hideReloadBar();
    if (sidePanels) sidePanels.onFileOpened(buf.path);

    renderAllTabBars();
    syncSplitVisibility();
    syncEmptyState();
    if (!opts.fromNav) recordCurrentNavPoint('primary');
  }

  function gotoLineColInView(view, line, col = 1, focus = true) {
    if (!view) return;
    const doc = view.state.doc;
    const lnObj = doc.line(Math.max(1, Math.min(line || 1, doc.lines)));
    const pos = Math.min(lnObj.to, lnObj.from + Math.max(0, (col || 1) - 1));
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    if (focus) view.focus();
  }

  function gotoLineColActive(line, col = 1) {
    const buf = getActiveBuffer();
    if (buf && buf.viewMode === 'preview') setViewMode('original');
    if (isVirtualTabId(getGroupActiveId('primary')) && activeGroup === 'primary' && buf) {
      activateTabInGroup('primary', buf.id, { line, col });
      return;
    }
    const v = getActiveEditorView();
    if (v) gotoLineColInView(v, line, col, true);
  }

  // ================================================================ Вкладки (Top Bar, Split Bar и Left Bar) + Split Right
  function isTopTabsMode() {
    return settings.viewerTabsPos !== 'left';
  }

  function renderAllTabBars() {
    const topMode = isTopTabsMode();
    const primarySt = pool.groupState('primary');
    const splitSt = pool.groupState('split');

    // 1. Горизонтальная полоса сверху (по умолчанию)
    const topBar = $('#editor-tabs-bar');
    const topList = $('#editor-tabs-list');
    const leftPane = $('#tabs-pane');

    if (topMode) {
      leftPane?.classList.add('empty');
      if (topBar && topList) {
        const hasAny = primarySt.tabs.length > 0;
        topBar.classList.toggle('hidden', !hasAny);
        fillHorizontalTabList(topList, 'primary', primarySt);
      }
    } else {
      topBar?.classList.add('hidden');
      renderVerticalLeftTabs(primarySt);
    }

    // 2. Полоса вкладок правой сплит-группы
    const splitList = $('#split-tabs-list');
    if (splitList && splitSt.tabs.length) {
      fillHorizontalTabList(splitList, 'split', splitSt);
    }
  }

  function disambiguateTabLabels(tabIds) {
    const counts = new Map();
    for (const id of tabIds) {
      const b = pool.getBuffer(id);
      const name = b ? b.title : baseName(id);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const labels = new Map();
    for (const id of tabIds) {
      const b = pool.getBuffer(id);
      const name = b ? b.title : baseName(id);
      if (!isVirtualTabId(id) && (counts.get(name) || 0) > 1) {
        const parent = baseName(dirName(id));
        labels.set(id, parent ? `${name} — ${parent}` : name);
      } else {
        labels.set(id, name);
      }
    }
    return labels;
  }

  let draggedTabInfo = null; // { group, tabId }

  function fillHorizontalTabList(listEl, group, st) {
    listEl.replaceChildren();
    const labels = disambiguateTabLabels(st.tabs);

    for (const tabId of st.tabs) {
      const buf = pool.getBuffer(tabId);
      const isAct = st.active === tabId;
      const isPin = st.pinned.has(tabId);
      const isPrev = st.previewTab === tabId;
      const isDirty = !!(buf && buf.dirty);
      const gc = !isVirtualTabId(tabId) ? gitClassFor(tabId) : '';

      const tab = el('div', 'etab'
        + (isAct ? ' active' : '')
        + (isPin ? ' pinned' : '')
        + (isPrev ? ' preview' : '')
        + (isDirty ? ' dirty' : ''));
      tab.dataset.tabId = tabId;
      tab.draggable = true;
      tab.title = isVirtualTabId(tabId) ? (buf?.title || tabId) : (tabId + (isPrev ? ' (превью — двойной клик чтобы закрепить)' : ''));

      if (isVirtualTabId(tabId)) tab.appendChild(icon('diff', 13));
      else tab.appendChild(fileTypeSvg(tabId));

      const lbl = el('span', 'etab-name' + (gc ? ' ' + gc : ''), labels.get(tabId) || baseName(tabId));
      tab.appendChild(lbl);

      if (isPin) {
        const pinIc = el('span', 'etab-pin');
        pinIc.appendChild(icon('pin', 11));
        pinIc.title = 'Открепить вкладку';
        pinIc.onclick = (e) => { e.stopPropagation(); pool.togglePin(group, tabId); renderAllTabBars(); scheduleSaveWorkspace(); };
        tab.appendChild(pinIc);
      }

      const closeBtn = el('button', 'etab-close');
      closeBtn.type = 'button';
      closeBtn.title = 'Закрыть (Ctrl+W / средняя кнопка мыши)';
      closeBtn.appendChild(icon('x', 12));
      closeBtn.onclick = (e) => { e.stopPropagation(); requestCloseTab(group, tabId); };
      tab.appendChild(closeBtn);

      tab.addEventListener('click', () => activateTabInGroup(group, tabId));
      tab.addEventListener('dblclick', () => {
        if (st.previewTab === tabId) {
          pool.promotePreview(tabId);
          renderAllTabBars();
          scheduleSaveWorkspace();
        }
      });
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); requestCloseTab(group, tabId); }
      });
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, group, tabId);
      });

      // Drag & Drop перестановка вкладок (внутри и между сплитами)
      tab.addEventListener('dragstart', (e) => {
        draggedTabInfo = { group, tabId };
        tab.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', tabId); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      });
      tab.addEventListener('dragend', () => {
        draggedTabInfo = null;
        tab.classList.remove('dragging');
        listEl.querySelectorAll('.etab.drop-target').forEach((n) => n.classList.remove('drop-target'));
      });
      tab.addEventListener('dragover', (e) => {
        if (!draggedTabInfo) return;
        e.preventDefault();
        tab.classList.add('drop-target');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        tab.classList.remove('drop-target');
        if (!draggedTabInfo) return;
        const src = draggedTabInfo;
        draggedTabInfo = null;
        if (src.group === group) {
          const toIdx = st.tabs.indexOf(tabId);
          pool.reorderTab(group, src.tabId, toIdx);
          renderAllTabBars();
          scheduleSaveWorkspace();
        } else if (!isVirtualTabId(src.tabId)) {
          moveTabBetweenGroups(src.group, group, src.tabId);
        }
      });

      listEl.appendChild(tab);
      if (isAct) {
        requestAnimationFrame(() => {
          try { tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
        });
      }
    }
  }

  function renderVerticalLeftTabs(st) {
    const pane = $('#tabs-pane');
    const list = $('#tabs-list');
    if (!pane || !list) return;
    pane.classList.toggle('empty', st.tabs.length === 0);
    $('#tabs-count').textContent = st.tabs.length ? String(st.tabs.length) : '';
    list.replaceChildren();
    const labels = disambiguateTabLabels(st.tabs);
    for (const tabId of st.tabs) {
      const buf = pool.getBuffer(tabId);
      const isAct = st.active === tabId;
      const isPin = st.pinned.has(tabId);
      const isPrev = st.previewTab === tabId;
      const gc = !isVirtualTabId(tabId) ? gitClassFor(tabId) : '';
      const row = el('div', 'ftab'
        + (isAct ? ' active' : '')
        + (isPin ? ' pinned' : '')
        + (isPrev ? ' preview' : '')
        + (buf?.dirty ? ' dirty' : ''));
      row.title = tabId;
      row.appendChild(isVirtualTabId(tabId) ? icon('diff', 14) : fileTypeSvg(tabId));
      row.appendChild(el('span', 'ftab-name' + (gc ? ' ' + gc : ''), labels.get(tabId) || baseName(tabId)));
      const x = el('button', 'ftab-x');
      x.type = 'button';
      x.appendChild(icon('x', 12));
      x.onclick = (e) => { e.stopPropagation(); requestCloseTab('primary', tabId); };
      row.appendChild(x);
      row.onclick = () => activateTabInGroup('primary', tabId);
      row.oncontextmenu = (e) => { e.preventDefault(); showTabContextMenu(e.clientX, e.clientY, 'primary', tabId); };
      list.appendChild(row);
    }
  }

  function syncSplitVisibility() {
    const splitTabs = pool.groupState('split').tabs;
    const hasSplit = splitTabs.length > 0;
    const pane = $('#editor-split-pane');
    const gut = $('#editor-split-gutter');
    const body = $('#viewer-body');
    if (!pane || !gut || !body) return;
    pane.classList.toggle('hidden', !hasSplit);
    gut.classList.toggle('hidden', !hasSplit);
    body.classList.toggle('has-code-split', hasSplit);
    if (hasSplit) {
      body.style.setProperty('--code-split-ratio', `${Math.round(splitRatio * 100)}%`);
    } else if (activeGroup === 'split') {
      setActiveGroup('primary');
    }
  }

  function openInSplitRight(filePath) {
    const target = filePath || getActiveBufferFile();
    if (!target || isVirtualTabId(target)) {
      toast('Откройте текстовый файл, чтобы разделить редактор');
      return;
    }
    if (splitPreviewMode) exitSplitPreview();
    openFileInViewer(target, null, { group: 'split', preview: false });
  }

  function moveTabBetweenGroups(fromGroup, toGroup, tabId) {
    if (fromGroup === toGroup || isVirtualTabId(tabId)) return;
    const nextInFrom = pool.closeTabInGroup(fromGroup, tabId);
    if (fromGroup === 'primary') {
      if (nextInFrom) activateTabInGroup('primary', nextInFrom, { focus: false });
      else clearPrimarySurface();
    } else if (nextInFrom) {
      activateTabInGroup('split', nextInFrom, { focus: false });
    }
    openFileInViewer(tabId, null, { group: toGroup, preview: false });
    syncSplitVisibility();
    renderAllTabBars();
  }

  function closeSplitPane() {
    const tabs = [...pool.groupState('split').tabs];
    for (const id of tabs) pool.closeTabInGroup('split', id);
    syncSplitVisibility();
    renderAllTabBars();
    scheduleSaveWorkspace();
  }

  async function requestCloseTab(group, tabId) {
    const buf = pool.getBuffer(tabId);
    // Проверяем, остаётся ли файл открыт в другой группе сплита
    const otherGroup = group === 'primary' ? 'split' : 'primary';
    const alsoInOther = pool.groupState(otherGroup).tabs.includes(tabId);

    const doClose = () => {
      const nextId = pool.closeTabInGroup(group, tabId);
      if (group === 'split') {
        if (nextId) activateTabInGroup('split', nextId);
        else syncSplitVisibility();
      } else if (nextId) {
        activateTabInGroup('primary', nextId);
      } else {
        clearPrimarySurface();
      }
      renderAllTabBars();
      syncEmptyState();
      scheduleSaveWorkspace();
    };

    if (!alsoInOther && buf && buf.kind === 'file' && buf.dirty) {
      if (!buf.readOnly && !buf.conflictOnDisk) {
        await saveBufferNow(buf.path, false);
        doClose();
      } else {
        showConfirm(
          'Закрыть без сохранения?',
          `В файле «${buf.title}» есть несохранённые правки (конфликт с диском).`,
          'Не сохранять',
          () => { setBufferDirty(buf, false); doClose(); },
        );
      }
      return;
    }
    doClose();
  }

  function clearPrimarySurface() {
    teardownActiveDiffDom();
    exitSplitPreview();
    $('#preview-view').style.display = 'none';
    $('#preview-view').innerHTML = '';
    $('#editor').style.display = '';
    if (editor) {
      editor.setState(EditorState.create({ doc: '', extensions: [oneDark, liteEditorTheme] }));
    }
    $('#viewer-crumbs')?.classList.add('hidden');
    $('#viewer-filename').textContent = '—';
    $('#viewer-dirty')?.classList.remove('show');
    $('#view-modes').style.display = 'none';
    hideReloadBar();
    syncEmptyState();
  }

  // Переключатель вкладок по MRU (Ctrl+Tab / Ctrl+Shift+Tab)
  function stepMruTab(delta = 1) {
    const mru = pool.mruTabs(activeGroup);
    if (mru.length < 2) return;
    const cur = getGroupActiveId(activeGroup);
    const idx = Math.max(0, mru.indexOf(cur));
    const next = mru[(idx + delta + mru.length) % mru.length];
    if (next) activateTabInGroup(activeGroup, next);
  }

  function showAllOpenTabsMenu(x, y) {
    closeMenus();
    const st = pool.groupState('primary');
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '240px';
    dd.style.maxHeight = '380px';
    dd.style.overflowY = 'auto';
    if (!st.tabs.length) {
      dd.appendChild(menuRow(null, 'Нет открытых вкладок', null, 'disabled'));
    } else {
      for (const id of st.tabs) {
        const b = pool.getBuffer(id);
        const r = menuRow(null, b ? b.title : baseName(id), () => {
          closeMenus();
          activateTabInGroup('primary', id);
        }, st.active === id ? 'active' : '');
        r.firstChild.replaceWith(isVirtualTabId(id) ? icon('diff', 14) : fileTypeSvg(id));
        if (b?.dirty) r.appendChild(el('span', 'menu-kbd', '●'));
        dd.appendChild(r);
      }
    }
    placeMenu(dd, x, y);
  }

  function showTabContextMenu(x, y, group, tabId) {
    closeMenus();
    const st = pool.groupState(group);
    const isVirt = isVirtualTabId(tabId);
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '230px';
    dd.addEventListener('click', (e) => e.stopPropagation());

    const add = (ic, label, fn, keys) => {
      const r = menuRow(ic, label, () => { closeMenus(); fn(); });
      if (keys) r.appendChild(el('span', 'menu-kbd', keys));
      dd.appendChild(r);
    };
    const sep = () => dd.appendChild(el('div', 'menu-sep'));

    add('x', 'Закрыть вкладку', () => requestCloseTab(group, tabId), 'Ctrl+W');
    add('x', 'Закрыть другие', () => {
      for (const id of [...st.tabs]) if (id !== tabId && !st.pinned.has(id)) requestCloseTab(group, id);
    });
    add('x', 'Закрыть вкладки справа', () => {
      const idx = st.tabs.indexOf(tabId);
      if (idx >= 0) for (const id of st.tabs.slice(idx + 1)) if (!st.pinned.has(id)) requestCloseTab(group, id);
    });
    add('x', 'Закрыть сохранённые (чистые)', () => {
      for (const id of [...st.tabs]) {
        const b = pool.getBuffer(id);
        if (!st.pinned.has(id) && !(b && b.dirty)) requestCloseTab(group, id);
      }
    });
    add('x', 'Закрыть все незакреплённые', () => {
      for (const id of [...st.tabs]) if (!st.pinned.has(id)) requestCloseTab(group, id);
    });

    sep();
    add('pin', st.pinned.has(tabId) ? 'Открепить вкладку' : 'Закрепить вкладку', () => {
      pool.togglePin(group, tabId);
      renderAllTabBars();
      scheduleSaveWorkspace();
    });

    if (!isVirt) {
      if (group === 'primary') {
        add('split-right', 'Открыть справа в сплите', () => openInSplitRight(tabId), 'Ctrl+\\');
        if (pool.groupState('split').tabs.length) {
          add('arrow-right', 'Перенести в правую группу', () => moveTabBetweenGroups('primary', 'split', tabId));
        }
      } else {
        add('chevron-left', 'Перенести в основную группу', () => moveTabBetweenGroups('split', 'primary', tabId));
      }
      sep();
      add('locate', 'Показать в дереве проекта', () => revealInTree(tabId));
      const p = activeProject();
      if (p && pathInside(tabId, p.path)) {
        add('copy', 'Копировать относительный путь', () => {
          lite.copyText(relTo(p.path, tabId));
          toast('Скопирован относительный путь');
        });
      }
      add('copy', 'Копировать полный путь', () => { lite.copyText(tabId); toast('Путь скопирован'); });
      add('terminal', 'Отправить @файл в терминал', () => sendFileRefToTerminal(tabId));
      add('folder', 'Показать в проводнике', () => lite.showItemInFolder(tabId));
    }

    placeMenu(dd, x, y);
  }

  // ================================================================ Навигация Назад / Вперёд по позициям курсора
  function recordCurrentNavPoint(group = activeGroup) {
    const id = getGroupActiveId(group);
    if (!id) return;
    const b = pool.getBuffer(id);
    pool.pushNav({
      group,
      tabId: id,
      line: b?.cursorLine || 1,
      col: b?.cursorCol || 1,
    });
    updateNavButtons();
  }

  function updateNavButtons() {
    const back = $('#viewer-back'), fwd = $('#viewer-fwd');
    if (back) back.disabled = !pool.canNavBack();
    if (fwd) fwd.disabled = !pool.canNavFwd();
  }

  function navBack() {
    const entry = pool.stepNav(-1);
    updateNavButtons();
    if (!entry) return;
    if (isVirtualTabId(entry.tabId)) {
      if (pool.hasBuffer(entry.tabId)) activateTabInGroup('primary', entry.tabId, { fromNav: true });
    } else {
      openFileInViewer(entry.tabId, entry.line, { col: entry.col, group: entry.group || 'primary', fromNav: true });
    }
  }

  function navFwd() {
    const entry = pool.stepNav(1);
    updateNavButtons();
    if (!entry) return;
    if (isVirtualTabId(entry.tabId)) {
      if (pool.hasBuffer(entry.tabId)) activateTabInGroup('primary', entry.tabId, { fromNav: true });
    } else {
      openFileInViewer(entry.tabId, entry.line, { col: entry.col, group: entry.group || 'primary', fromNav: true });
    }
  }

  // ================================================================ Хлебные крошки с быстрым меню соседних файлов и символов
  function updateHeaderForBuffer(buf) {
    if (!buf) return;
    const kind = previewKindFor(buf.path);
    const showModes = kind === 'markdown' || kind === 'html' || kind === 'svg';
    const vm = $('#view-modes');
    if (vm) vm.style.display = showModes ? '' : 'none';
    updateViewModeButtons(buf);
    $('#viewer-dirty')?.classList.toggle('show', !!buf.dirty);
  }

  function updateBreadcrumbs(state, buf) {
    const crumbs = $('#viewer-crumbs');
    const fnameEl = $('#viewer-filename');
    if (!crumbs || !fnameEl || !buf || buf.kind !== 'file') return;

    const p = activeProject();
    crumbs.replaceChildren();
    crumbs.classList.remove('hidden');
    fnameEl.classList.add('hidden');

    const rootPath = p ? trimTrail(p.path) : '';
    const rel = (rootPath && pathInside(buf.path, rootPath)) ? relTo(rootPath, buf.path) : normSlash(buf.path);
    const parts = rel.split('/').filter(Boolean);

    // Сегменты папок: клик открывает выпадающее меню соседних папок и файлов этого уровня!
    let accum = rootPath;
    parts.forEach((seg, idx) => {
      const isLast = idx === parts.length - 1;
      accum = accum ? joinPath(accum, seg) : '/' + seg;
      const segPath = accum;

      if (idx > 0) crumbs.appendChild(el('span', 'crumb-sep', '›'));
      const btn = el('button', 'crumb-seg' + (isLast ? ' is-file' : ''));
      btn.type = 'button';
      if (isLast) btn.appendChild(fileTypeSvg(seg));
      btn.appendChild(el('span', null, seg));
      btn.title = isLast
        ? 'Клик — соседние файлы папки · ПКМ — показать в дереве'
        : `${segPath} (клик — содержимое папки, ПКМ — показать в дереве)`;
      btn.onclick = (e) => {
        e.stopPropagation();
        const parentDir = isLast ? dirName(buf.path) : segPath;
        openBreadcrumbDirMenu(parentDir, btn, buf.path);
      };
      btn.oncontextmenu = (e) => {
        e.preventDefault(); e.stopPropagation();
        revealInTree(segPath, !isLast);
      };
      crumbs.appendChild(btn);
    });

    // Текущий символ под курсором (с исправленным расчётом вложенности endLine!)
    if (state) {
      const syms = extractFileSymbols(state.doc.toString(), extOf(buf.path));
      const curLine = state.doc.lineAt(state.selection.main.head).number;
      const curSym = enclosingSymbolAtLine(syms, curLine);
      if (curSym) {
        crumbs.appendChild(el('span', 'crumb-sep', '›'));
        const symBtn = el('button', 'crumb-seg is-sym');
        symBtn.type = 'button';
        symBtn.append(
          el('span', 'ov-kind ov-' + curSym.kind, SYMBOL_GLYPHS[curSym.kind] || 'ƒ'),
          el('span', null, curSym.name),
        );
        symBtn.title = 'Перейти к другому символу файла';
        symBtn.onclick = (e) => {
          e.stopPropagation();
          openBreadcrumbSymbolMenu(syms, symBtn, curSym);
        };
        crumbs.appendChild(symBtn);
      }
    }
  }

  async function openBreadcrumbDirMenu(dirPath, anchorEl, activeFilePath) {
    closeMenus();
    const res = await lite.fs.readDir(dirPath);
    if (!res || !Array.isArray(res.entries)) return;
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '220px';
    dd.style.maxHeight = '360px';
    dd.style.overflowY = 'auto';
    dd.addEventListener('click', (e) => e.stopPropagation());

    for (const ent of res.entries) {
      const r = menuRow(null, ent.name, () => {
        closeMenus();
        if (ent.dir) revealInTree(ent.path, true);
        else openFileInViewer(ent.path, null, { preview: false });
      }, ent.path === activeFilePath ? 'active' : '');
      r.firstChild.replaceWith(ent.dir ? folderTypeSvg(false, ent.name) : fileTypeSvg(ent.name));
      dd.appendChild(r);
    }
    const rect = anchorEl.getBoundingClientRect();
    placeMenu(dd, rect.left, rect.bottom + 4);
  }

  function openBreadcrumbSymbolMenu(syms, anchorEl, curSym) {
    closeMenus();
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '230px';
    dd.style.maxHeight = '360px';
    dd.style.overflowY = 'auto';
    dd.addEventListener('click', (e) => e.stopPropagation());
    for (const s of syms) {
      const r = menuRow(null, s.name, () => {
        closeMenus();
        gotoLineColActive(s.line, 1);
      }, curSym && curSym.line === s.line && curSym.name === s.name ? 'active' : '');
      r.firstChild.replaceWith(el('span', 'ov-kind ov-' + s.kind, SYMBOL_GLYPHS[s.kind] || '·'));
      r.appendChild(el('span', 'menu-kbd', ':' + s.line));
      dd.appendChild(r);
    }
    const rect = anchorEl.getBoundingClientRect();
    placeMenu(dd, rect.left, rect.bottom + 4);
  }

  // ================================================================ Интерактивный Статус-бар
  function updateStatusFromState(state, buf) {
    if (!state || !buf) return;
    const sel = state.selection.main;
    const ln = state.doc.lineAt(sel.head);
    const col = sel.head - ln.from + 1;
    const multiCount = state.selection.ranges.length;

    $('#vs-pos').textContent = multiCount > 1
      ? `Стр ${ln.number}, Стб ${col} (${multiCount} курс.)`
      : `Стр ${ln.number}, Стб ${col}`;

    if (!sel.empty) {
      const chars = Math.abs(sel.to - sel.from);
      const l1 = state.doc.lineAt(sel.from).number;
      const l2 = state.doc.lineAt(sel.to).number;
      const spanLines = l2 - l1 + 1;
      $('#vs-sel').textContent = spanLines > 1 ? `(${chars} симв., ${spanLines} стр.)` : `(${chars} симв.)`;
    } else {
      $('#vs-sel').textContent = '';
    }

    const ind = buf.indent || { tabSize: 2, useTabs: false };
    $('#st-indent').textContent = ind.useTabs ? `Табы: ${ind.tabSize}` : `Пробелы: ${ind.tabSize}`;
    $('#st-enc').textContent = buf.readOnly ? 'RO' : 'UTF-8';
    $('#st-eol').textContent = buf.docEol === '\r\n' ? 'CRLF' : 'LF';
    $('#vs-lang').textContent = langNameFor(buf.path, buf.langOverride);

    if (blameActive && blameMap) {
      const bi = blameMap.get(ln.number);
      $('#vs-blame').textContent = bi
        ? (bi.uncommitted ? '• Не закоммичено' : `${bi.author} · ${bi.summary || bi.hash}`)
        : '';
    } else {
      $('#vs-blame').textContent = '';
    }
  }

  function updateStatusForImage(filePath) {
    $('#vs-pos').textContent = 'Изображение';
    $('#vs-sel').textContent = '';
    $('#st-indent').textContent = '';
    $('#st-enc').textContent = extOf(filePath).toUpperCase();
    $('#st-eol').textContent = '';
    $('#vs-lang').textContent = 'Image';
  }

  function updateKeymapStatus() {
    const elKm = $('#st-keymap');
    if (!elKm) return;
    const isJb = settings.viewerKeymap === 'jetbrains';
    elKm.textContent = isJb ? 'JetBrains' : 'VS Code';
  }

  function updateWrapButton() {
    $('#viewer-wrap')?.classList.toggle('active', !!settings.viewerWordWrap);
  }

  function showIndentMenu(x, y) {
    const buf = getActiveBuffer();
    const view = getActiveEditorView();
    if (!buf || !view) return;
    closeMenus();
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '240px';
    dd.addEventListener('click', (e) => e.stopPropagation());

    const applySpec = (useTabs, tabSize, convertDoc = false) => {
      closeMenus();
      buf.indent = { unit: useTabs ? '\t' : ' '.repeat(tabSize), tabSize, useTabs };
      const effects = [indentComp.reconfigure(buildIndentExtension(buf.indent))];
      if (convertDoc && !buf.readOnly) {
        const oldText = view.state.doc.toString();
        const nextText = convertIndentation(oldText, buf.indent);
        if (nextText !== oldText) {
          view.dispatch({ changes: { from: 0, to: oldText.length, insert: nextText }, effects });
          updateStatusFromState(view.state, buf);
          toast('Отступы в файле сконвертированы');
          return;
        }
      }
      view.dispatch({ effects });
      updateStatusFromState(view.state, buf);
    };

    dd.appendChild(menuRow(null, 'Отступ: 2 пробела', () => applySpec(false, 2)));
    dd.appendChild(menuRow(null, 'Отступ: 4 пробела', () => applySpec(false, 4)));
    dd.appendChild(menuRow(null, 'Отступ: Табуляция (4)', () => applySpec(true, 4)));
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(menuRow('wand', 'Конвертировать файл в 2 пробела', () => applySpec(false, 2, true)));
    dd.appendChild(menuRow('wand', 'Конвертировать файл в 4 пробела', () => applySpec(false, 4, true)));
    dd.appendChild(menuRow('wand', 'Конвертировать файл в табы', () => applySpec(true, 4, true)));
    placeMenu(dd, x, y);
  }

  function toggleBufferEol() {
    const buf = getActiveBuffer();
    if (!buf || buf.readOnly) return;
    buf.docEol = buf.docEol === '\r\n' ? '\n' : '\r\n';
    setBufferDirty(buf, true);
    saveBufferNow(buf.path, false);
    const v = getActiveEditorView();
    if (v) updateStatusFromState(v.state, buf);
    toast(`Концы строк переключены на ${buf.docEol === '\r\n' ? 'CRLF' : 'LF'}`);
  }

  function setActiveLanguageOverride(langName) {
    const buf = getActiveBuffer();
    const view = getActiveEditorView();
    if (!buf || !view) return;
    buf.langOverride = langName || null;
    const sup = languageFor(buf.path, (loaded) => {
      if (getActiveBufferFile() === buf.path) view.dispatch({ effects: langComp.reconfigure(loaded) });
    }, buf.langOverride);
    view.dispatch({ effects: langComp.reconfigure(sup) });
    updateStatusFromState(view.state, buf);
  }

  // ================================================================ Go to Definition, Find Usages, Rename, Format
  async function goToDefinitionFromView(view, filePath) {
    const p = activeProject();
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const colOff = pos - line.from;

    // 1. Клик / F12 по строке импорта (import ... from './foo', require('...'), @/... )
    const impSpec = extractImportSpecAtLine(line.text, colOff);
    if (impSpec && p) {
      const allRel = await getAllProjectFiles(p.path);
      const targetAbs = resolveImportTarget(p.path, filePath, impSpec, allRel);
      if (targetAbs) {
        openFileInViewer(targetAbs, 1, { preview: false });
        return;
      }
    }

    // 2. Поиск определения идентификатора под курсором
    const fullText = view.state.doc.toString();
    const w = wordAtOffset(fullText, pos);
    if (!w) {
      toast('Поставьте курсор на имя функции, класса или путь импорта');
      return;
    }

    // Сначала символы текущего файла
    const localSyms = extractFileSymbols(fullText, extOf(filePath)).filter((s) => s.name === w.word);
    if (localSyms.length === 1 && localSyms[0].line !== line.number) {
      recordCurrentNavPoint();
      gotoLineColInView(view, localSyms[0].line, 1, true);
      return;
    }

    // Затем глобальный индекс символов проекта
    if (p) {
      const defs = symbolIndex.findDefinitions(w.word);
      const root = trimTrail(p.path);
      if (defs.length === 1) {
        openFileInViewer(joinPath(root, defs[0].rel), defs[0].line, { preview: false });
        return;
      }
      if (defs.length > 1) {
        overlays.openQuickOpen('#' + w.word);
        return;
      }
    }

    if (localSyms.length >= 1) {
      gotoLineColInView(view, localSyms[0].line, 1, true);
      return;
    }
    toast(`Определение «${w.word}» не найдено — используйте Shift+F12 для поиска по тексту`);
  }

  function findUsagesFromView(view, _filePath) {
    const pos = view.state.selection.main.head;
    const sel = view.state.selection.main;
    const selected = !sel.empty ? view.state.sliceDoc(sel.from, sel.to).trim() : '';
    const word = selected || (wordAtOffset(view.state.doc.toString(), pos)?.word || '');
    if (!word) {
      openSideSection('search');
      return;
    }
    openSideSection('search');
    sidePanels.openSearch({ query: word, wholeWord: !/\W/.test(word) });
  }

  function renameSymbolInActiveEditor() {
    const view = getActiveEditorView();
    const buf = getActiveBuffer();
    if (!view || !buf || buf.readOnly) return;
    const text = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    const w = wordAtOffset(text, pos);
    if (!w) { toast('Поставьте курсор на идентификатор для переименования'); return; }
    const ranges = findIdentifierRanges(text, w.word);
    if (!ranges.length) return;
    let primaryIdx = ranges.findIndex((r) => pos >= r.from && pos <= r.to);
    if (primaryIdx < 0) primaryIdx = 0;
    const cmRanges = ranges.map((r) => EditorSelection.range(r.from, r.to));
    view.dispatch({ selection: EditorSelection.create(cmRanges, primaryIdx) });
    view.focus();
    toast(`Выделено вхождений «${w.word}»: ${ranges.length} — введите новое имя (Esc — сброс курсоров)`, { ttl: 3200 });
  }

  function formatActiveDocument() {
    const view = getActiveEditorView();
    const buf = getActiveBuffer();
    if (!view || !buf || buf.readOnly) return;
    const oldText = view.state.doc.toString();
    const formatted = formatCodeText(oldText, extOf(buf.path), buf.indent, true);
    if (formatted === oldText) {
      toast('Документ уже отформатирован', { ttl: 1500 });
      return;
    }
    const head = Math.min(formatted.length, view.state.selection.main.head);
    view.dispatch({
      changes: { from: 0, to: oldText.length, insert: formatted },
      selection: { anchor: head },
    });
    toast('Документ отформатирован');
  }

  // ================================================================ Живой Git Diff, F7/Shift+F7 и Инлайн-попап Ханков
  async function updateGitGutterForBuffer(buf, targetView) {
    if (!buf || buf.kind !== 'file') return;
    const p = activeProject();
    if (!p || !statusBranch || !pathInside(buf.path, p.path)) {
      buf.gitHunks = [];
      return;
    }
    const res = await lite.git.diff(p.path, buf.path);
    if (!res || res.error) return;
    const parsed = parseUnifiedDiff(res.diff || '');
    buf.gitHunks = parsed.hunks;
    buf.gitHeaderLines = parsed.headerLines;

    const views = [];
    if (targetView) views.push(targetView);
    else {
      if (editor && getGroupActiveId('primary') === buf.id) views.push(editor);
      if (splitEditor && getGroupActiveId('split') === buf.id) views.push(splitEditor);
    }
    for (const v of views) {
      v.dispatch({ effects: setGitGutterEffect.of(parsed.marks) });
    }
  }

  function jumpGitHunkInView(view, filePath, dir) {
    const buf = pool.getBuffer(filePath);
    if (!buf || !buf.gitHunks || !buf.gitHunks.length) {
      toast('В файле нет незакоммиченных изменений git');
      return;
    }
    const curLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    const nextLine = stepHunkAnchor(buf.gitHunks, curLine, dir);
    if (nextLine) gotoLineColInView(view, nextLine, 1, true);
  }

  function closeInlineHunkPopover() {
    if (hunkPopEl) {
      hunkPopEl.remove();
      hunkPopEl = null;
    }
  }

  function openInlineHunkPopover(filePath, lineNum, clientX, clientY) {
    closeInlineHunkPopover();
    const buf = pool.getBuffer(filePath);
    const p = activeProject();
    if (!buf || !p || !buf.gitHunks || !buf.gitHunks.length) return false;
    const hit = findHunkAtLine(buf.gitHunks, lineNum);
    if (!hit) return false;
    const { hunk, index } = hit;

    const pop = el('div', 'git-hunk-pop');
    pop.addEventListener('mousedown', (e) => e.stopPropagation());

    const head = el('div', 'git-hunk-pop-head');
    head.appendChild(el('span', 'git-hunk-pop-title', `Изменение ${index + 1} из ${buf.gitHunks.length} (${hunk.type === 'add' ? 'добавлено' : hunk.type === 'del' ? 'удалено' : 'изменено'})`));

    const navActs = el('div', 'git-hunk-pop-acts');
    const prevB = el('button', 'gm-mini'); prevB.type = 'button'; prevB.title = 'Предыдущее изменение (Shift+F7)'; prevB.appendChild(icon('arrow-up', 12));
    const nextB = el('button', 'gm-mini'); nextB.type = 'button'; nextB.title = 'Следующее изменение (F7)'; nextB.appendChild(icon('arrow-down', 12));
    const diffB = el('button', 'git-tool'); diffB.type = 'button'; diffB.append(icon('diff', 13), el('span', null, 'Весь дифф'));
    const copyOldB = el('button', 'git-tool'); copyOldB.type = 'button'; copyOldB.append(icon('copy', 13), el('span', null, 'Копировать было'));
    const revB = el('button', 'git-tool danger'); revB.type = 'button'; revB.append(icon('corner-up-left', 13), el('span', null, 'Откатить ханк'));
    const closeB = el('button', 'gm-mini'); closeB.type = 'button'; closeB.appendChild(icon('x', 12));

    prevB.onclick = () => {
      closeInlineHunkPopover();
      const v = getActiveEditorView();
      if (v) jumpGitHunkInView(v, filePath, -1);
    };
    nextB.onclick = () => {
      closeInlineHunkPopover();
      const v = getActiveEditorView();
      if (v) jumpGitHunkInView(v, filePath, 1);
    };
    diffB.onclick = () => {
      closeInlineHunkPopover();
      showGitDiff(p.path, filePath, { name: baseName(filePath) });
    };
    copyOldB.onclick = () => {
      lite.copyText(hunk.oldExcerpt || '');
      toast('Скопирован старый фрагмент из HEAD');
    };
    revB.onclick = async () => {
      closeInlineHunkPopover();
      await revertSingleHunk(p.path, filePath, hunk.patch);
    };
    closeB.onclick = closeInlineHunkPopover;

    if (hunk.oldExcerpt) navActs.appendChild(copyOldB);
    navActs.append(revB, diffB, prevB, nextB, closeB);
    head.appendChild(navActs);
    pop.appendChild(head);

    const codeBox = el('pre', 'git-hunk-pop-code');
    if (hunk.oldExcerpt) {
      const delBlock = el('div', 'git-hunk-old', hunk.oldExcerpt);
      codeBox.appendChild(delBlock);
    } else {
      codeBox.appendChild(el('div', 'git-hunk-empty', 'Новые строки (в HEAD этого участка не было)'));
    }
    pop.appendChild(codeBox);

    document.body.appendChild(pop);
    hunkPopEl = pop;
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(12, Math.min(clientX, window.innerWidth - rect.width - 12)) + 'px';
    pop.style.top = Math.max(36, Math.min(clientY + 10, window.innerHeight - rect.height - 12)) + 'px';
    return true;
  }

  document.addEventListener('mousedown', (e) => {
    if (hunkPopEl && !hunkPopEl.contains(e.target)) closeInlineHunkPopover();
  });

  async function revertSingleHunk(projPath, filePath, patch) {
    await cancelAutosaveFor(filePath);
    const buf = pool.getBuffer(filePath);
    if (buf && buf.dirty) await saveBufferNow(filePath, false);

    const r = await lite.git.revertHunk(projPath, patch);
    if (!r || !r.ok) {
      toast((r && r.error) || 'Не удалось откатить ханк', { kind: 'err', ttl: 7000 });
      return;
    }
    toast('Ханк откачен');
    await reloadBufferFromDisk(filePath, true);
    refreshGitMarks();
    gitRender();
    try { lite.editorBus.refreshProjects(); } catch (_) {}

    // Если сейчас открыта вкладка диффа этого файла — обновим и её!
    const diffTabId = `diff:${filePath}`;
    if (getGroupActiveId('primary') === diffTabId) {
      await showGitDiff(projPath, filePath, { name: baseName(filePath) });
    }
  }

  // ---- Полноэкранные вкладки Git Diff / Commit Diff / Raw Diff / Compare
  function teardownActiveDiffDom() {
    if (activeMergeView) {
      try { activeMergeView.destroy(); } catch (_) {}
      activeMergeView = null;
    }
    const dv = $('#diff-view');
    if (dv) {
      dv.style.display = 'none';
      dv.replaceChildren();
    }
  }

  async function fetchWorkingDiffData(projPath, filePath) {
    // Гарантируем, что свежие правки буфера записаны на диск перед чтением git diff
    const buf = pool.getBuffer(filePath);
    if (buf && buf.dirty && !buf.readOnly && !buf.conflictOnDisk) {
      await saveBufferNow(filePath, false);
    }
    const [dRes, pairRes] = await Promise.all([
      lite.git.diff(projPath, filePath),
      lite.git.fileVersions(projPath, filePath),
      ensureLanguage(filePath),
    ]);
    return {
      unified: (dRes && dRes.diff) || '',
      pair: (pairRes && !pairRes.error && !pairRes.binary && !pairRes.tooBig)
        ? { oldText: pairRes.oldText ?? '', newText: pairRes.newText ?? '' }
        : null,
    };
  }

  async function showGitDiff(projPath, filePath, labelObj) {
    if (!viewerOpen) setViewerOpen(true);
    const normPath = normSlash(filePath);
    const tabId = `diff:${normPath}`;
    const data = await fetchWorkingDiffData(projPath, normPath);
    const title = `Дифф: ${(labelObj && labelObj.name) || baseName(normPath)}`;

    const vBuf = pool.ensureBuffer(tabId, {
      kind: 'diff',
      title,
      path: normPath,
      meta: { projPath, filePath: normPath, editableRight: true, unified: data.unified, pair: data.pair },
    });
    vBuf.title = title;
    vBuf.meta = { projPath, filePath: normPath, editableRight: true, unified: data.unified, pair: data.pair };
    pool.openTabInGroup('primary', tabId, { preview: true });
    activateTabInGroup('primary', tabId);
  }

  async function showCommitDiff(projPath, hash, relFile, labelObj) {
    if (!viewerOpen) setViewerOpen(true);
    const shortHash = String(hash).slice(0, 7);
    const tabId = `cdiff:${shortHash}:${relFile}`;
    const absHint = joinPath(projPath, relFile);
    const [dRes, pairRes] = await Promise.all([
      lite.git.commitFileDiff(projPath, hash, relFile, false),
      lite.git.commitFileVersions ? lite.git.commitFileVersions(projPath, hash, relFile, false) : Promise.resolve(null),
      ensureLanguage(absHint),
    ]);
    const pair = (pairRes && !pairRes.error && !pairRes.binary && !pairRes.tooBig)
      ? { oldText: pairRes.oldText ?? '', newText: pairRes.newText ?? '' }
      : null;
    const title = `${(labelObj && labelObj.name) || baseName(relFile)} @ ${shortHash}`;
    const vBuf = pool.ensureBuffer(tabId, {
      kind: 'cdiff',
      title,
      path: absHint,
      meta: { projPath, filePath: absHint, hash: shortHash, editableRight: false, unified: (dRes && dRes.diff) || '', pair },
    });
    vBuf.meta = { projPath, filePath: absHint, hash: shortHash, editableRight: false, unified: (dRes && dRes.diff) || '', pair };
    pool.openTabInGroup('primary', tabId, { preview: true });
    activateTabInGroup('primary', tabId);
  }

  function showRawDiff(label, unifiedDiff) {
    if (!viewerOpen) setViewerOpen(true);
    const tabId = `rawdiff:${label}`;
    const vBuf = pool.ensureBuffer(tabId, {
      kind: 'rawdiff',
      title: label,
      path: null,
      meta: { editableRight: false, unified: unifiedDiff || '', pair: null },
    });
    vBuf.meta = { editableRight: false, unified: unifiedDiff || '', pair: null };
    pool.openTabInGroup('primary', tabId, { preview: true });
    activateTabInGroup('primary', tabId);
  }

  async function runCompareTwoFiles(fileA, fileB) {
    if (!viewerOpen) setViewerOpen(true);
    const [r, ra, rb] = await Promise.all([
      lite.fs.diffPair(fileA, fileB),
      lite.fs.readFile(fileA),
      lite.fs.readFile(fileB),
      ensureLanguage(fileB),
    ]);
    if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
    const tabId = `cmp:${fileA}::${fileB}`;
    const title = `${baseName(fileA)} ↔ ${baseName(fileB)}`;
    const pair = (!ra.error && !rb.error && !ra.notUtf8 && !rb.notUtf8)
      ? { oldText: normEolText(ra.content || ''), newText: normEolText(rb.content || '') }
      : null;
    const vBuf = pool.ensureBuffer(tabId, {
      kind: 'cmp',
      title,
      path: fileB,
      meta: { editableRight: false, unified: (r && r.diff) || '', pair, filePath: fileB, leftLabel: baseName(fileA), rightLabel: baseName(fileB) },
    });
    vBuf.meta = { editableRight: false, unified: (r && r.diff) || '', pair, filePath: fileB, leftLabel: baseName(fileA), rightLabel: baseName(fileB) };
    pool.openTabInGroup('primary', tabId, { preview: false });
    activateTabInGroup('primary', tabId);
  }

  function renderVirtualDiffBuffer(vBuf) {
    teardownActiveDiffDom();
    exitSplitPreview();
    $('#editor').style.display = 'none';
    $('#preview-view').style.display = 'none';
    $('#view-modes').style.display = 'none';
    $('#viewer-crumbs')?.classList.add('hidden');
    const fnameEl = $('#viewer-filename');
    if (fnameEl) {
      fnameEl.classList.remove('hidden');
      fnameEl.textContent = vBuf.title;
    }

    const dv = $('#diff-view');
    dv.style.display = 'flex';
    dv.replaceChildren();

    const meta = vBuf.meta || {};
    currentDiffUnified = meta.unified || '';
    currentDiffParsed = parseUnifiedDiff(currentDiffUnified);
    const hunks = currentDiffParsed.hunks;

    // Шапка управления диффом: счётчик ханков, Пред/След (Shift+F7 / F7), переключение Side-by-Side / Unified, Открыть файл
    const bar = el('div', 'diff-toolbar');
    const countLbl = el('span', 'diff-hunk-count', hunks.length ? `Изменений: ${hunks.length}` : 'Различий нет');
    bar.appendChild(countLbl);

    let curHunkIdx = 0;
    const jumpDiffHunk = (delta) => {
      if (!hunks.length) return;
      curHunkIdx = (curHunkIdx + delta + hunks.length) % hunks.length;
      const h = hunks[curHunkIdx];
      countLbl.textContent = `Ханк ${curHunkIdx + 1} / ${hunks.length}`;
      if (activeMergeView && activeMergeView.b) {
        gotoLineColInView(activeMergeView.b, h.anchorLine, 1, false);
      }
    };

    if (hunks.length) {
      const prevBtn = el('button', 'git-tool'); prevBtn.type = 'button';
      prevBtn.title = 'Предыдущее изменение (Shift+F7)';
      prevBtn.append(icon('arrow-up', 13), el('span', null, 'Пред.'));
      prevBtn.onclick = () => jumpDiffHunk(-1);

      const nextBtn = el('button', 'git-tool'); nextBtn.type = 'button';
      nextBtn.title = 'Следующее изменение (F7)';
      nextBtn.append(icon('arrow-down', 13), el('span', null, 'След.'));
      nextBtn.onclick = () => jumpDiffHunk(1);
      bar.append(prevBtn, nextBtn);
    }

    if (meta.editableRight) {
      const editHint = el('span', 'diff-live-badge', '✎ Правая панель редактируема');
      bar.appendChild(editHint);
    }

    bar.appendChild(el('div', 'drag-space-static'));

    if (meta.pair) {
      const modeToggle = el('button', 'git-tool');
      modeToggle.type = 'button';
      modeToggle.textContent = diffUnifiedViewMode ? 'Две колонки (Side-by-Side)' : 'Единый патч (Unified)';
      modeToggle.onclick = () => {
        diffUnifiedViewMode = !diffUnifiedViewMode;
        renderVirtualDiffBuffer(vBuf);
      };
      bar.appendChild(modeToggle);
    }

    if (meta.filePath && vBuf.kind !== 'rawdiff') {
      const openBtn = el('button', 'git-tool primary');
      openBtn.type = 'button';
      openBtn.title = 'Открыть исходный файл в редакторе (F4)';
      openBtn.append(icon('file-text', 13), el('span', null, 'Открыть файл'));
      openBtn.onclick = () => openFileInViewer(meta.filePath, hunks[curHunkIdx]?.anchorLine || 1, { preview: false });
      bar.appendChild(openBtn);
    }

    dv.appendChild(bar);

    const contentWrap = el('div', 'diff-body-wrap');
    dv.appendChild(contentWrap);

    if (!meta.pair && !currentDiffUnified.trim()) {
      contentWrap.appendChild(el('div', 'diff-empty-msg', 'Файлы идентичны — изменений нет.'));
      return;
    }

    // 1. Side-by-Side MergeView (живой редактируемый справа для рабочего файла!)
    if (meta.pair && !diffUnifiedViewMode) {
      const colHead = el('div', 'diff-col-headers');
      colHead.append(
        el('span', null, meta.leftLabel || (vBuf.kind === 'cdiff' ? `${meta.hash}~1 (было)` : 'HEAD (было)')),
        el('span', null, meta.rightLabel || (meta.editableRight ? 'Рабочая копия (можно редактировать)' : 'Стало')),
      );
      contentWrap.appendChild(colHead);

      const mvHost = el('div', 'diff-mv-host');
      contentWrap.appendChild(mvHost);

      const fileHint = meta.filePath || 'file.txt';
      const roExts = mergeRoExtensions(fileHint);
      let rightSaveTimer = null;

      const rightExts = meta.editableRight
        ? mergeRwExtensions(fileHint, null, [
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const newTxt = u.state.doc.toString();
            // Синхронизируем с открытым буфером файла, если он есть в пуле
            const fBuf = pool.getBuffer(meta.filePath);
            if (fBuf && fBuf.state) {
              const oldBufTxt = fBuf.state.doc.toString();
              if (oldBufTxt !== newTxt) {
                fBuf.state = fBuf.state.update({ changes: { from: 0, to: oldBufTxt.length, insert: newTxt } }).state;
              }
            }
            clearTimeout(rightSaveTimer);
            rightSaveTimer = setTimeout(async () => {
              const eol = fBuf ? fBuf.docEol : '\n';
              await lite.fs.writeFile(meta.filePath, toDiskEol(newTxt, eol));
              if (fBuf) { fBuf.diskBase = newTxt; setBufferDirty(fBuf, false); }
              refreshGitMarks();
            }, AUTOSAVE_MS);
          }),
        ])
        : roExts;

      activeMergeView = new MergeView({
        a: { doc: normEolText(meta.pair.oldText || ''), extensions: roExts },
        b: { doc: normEolText(meta.pair.newText || ''), extensions: rightExts },
        parent: mvHost,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 4, minSize: 6 },
      });

      // Полоса быстрых кнопок отката отдельных ханков под тулбаром (для рабочего диффа)
      if (meta.editableRight && hunks.length) {
        const hunksStrip = el('div', 'diff-hunks-strip');
        hunksStrip.appendChild(el('span', 'diff-hunks-lbl', 'Откат ханка:'));
        hunks.forEach((h, idx) => {
          const hb = el('button', 'diff-hunk-chip');
          hb.type = 'button';
          hb.title = `Откатить ханк #${idx + 1} (строка ${h.anchorLine})`;
          hb.textContent = `↶ #${idx + 1} (:стр.${h.anchorLine})`;
          hb.onclick = () => revertSingleHunk(meta.projPath, meta.filePath, h.patch);
          hunksStrip.appendChild(hb);
        });
        dv.insertBefore(hunksStrip, contentWrap);
      }
      return;
    }

    // 2. Unified текстовый патч с подсветкой строк +/- и кнопками отката на каждом @@ ханке
    const uniBox = el('div', 'diff-unified-box');
    const lines = currentDiffUnified.split('\n');
    let hunkIdx = -1;
    for (const ln of lines) {
      const row = el('div', 'diff-u-line');
      if (ln.startsWith('@@')) {
        hunkIdx++;
        row.classList.add('hunk-hdr');
        row.appendChild(el('span', null, ln));
        if (meta.editableRight && hunks[hunkIdx]) {
          const targetHunk = hunks[hunkIdx];
          const rb = el('button', 'git-tool danger diff-u-rev', '↶ Откатить ханк');
          rb.type = 'button';
          rb.onclick = () => revertSingleHunk(meta.projPath, meta.filePath, targetHunk.patch);
          row.appendChild(rb);
        }
      } else if (ln.startsWith('+') && !ln.startsWith('+++')) {
        row.classList.add('add');
        row.textContent = ln;
      } else if (ln.startsWith('-') && !ln.startsWith('---')) {
        row.classList.add('del');
        row.textContent = ln;
      } else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('---') || ln.startsWith('+++')) {
        row.classList.add('meta');
        row.textContent = ln;
      } else {
        row.textContent = ln;
      }
      uniBox.appendChild(row);
    }
    contentWrap.appendChild(uniBox);
  }

  function toggleDiffForCurrentFile() {
    const p = activeProject();
    const curId = getGroupActiveId('primary');
    if (curId && curId.startsWith('diff:')) {
      const filePath = curId.slice(5);
      requestCloseTab('primary', curId);
      openFileInViewer(filePath, null, { preview: false });
      return;
    }
    const f = getActiveBufferFile();
    if (!p || !f) { toast('Нет открытого файла проекта'); return; }
    showGitDiff(p.path, f, { name: baseName(f) });
  }

  // ================================================================ Превью Markdown / HTML / SVG и Зеркальный сплит
  async function fillPreviewPane(kind, file, content) {
    const view = $('#preview-view');
    if (!view) return;
    const keepScroll = (kind === 'markdown' && file === lastPreviewFile) ? view.scrollTop : 0;
    clearPreviewMirror();
    view.replaceChildren();

    if (kind === 'image') {
      const res = await lite.fs.readDataUrl(file);
      if (res && res.error) view.appendChild(el('div', 'prev-empty', res.error));
      else if (res && res.url) {
        const wrap = el('div', 'prev-img-wrap');
        const img = el('img', 'prev-img');
        img.src = res.url;
        wrap.appendChild(img);
        view.appendChild(wrap);
      }
    } else if (kind === 'svg') {
      const wrap = el('div', 'prev-img-wrap prev-svg-wrap');
      const frag = safeSvgFragment(content);
      if (frag) wrap.appendChild(frag);
      view.appendChild(wrap);
    } else if (kind === 'markdown') {
      const div = el('div', 'prev-md');
      const frag = safeMarkdownFragment(content);
      if (frag) div.replaceChildren(...frag.childNodes);
      else div.textContent = content || '';
      const base = dirName(file);
      div.querySelectorAll('img').forEach((im) => {
        const s = im.getAttribute('src') || '';
        if (s && !/^(https?:|data:|file:|\/\/)/i.test(s)) {
          im.src = fileUrl(joinPath(base, s.replace(/^\.\//, '')));
        }
      });
      div.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (a && /^https?:/i.test(a.href)) { e.preventDefault(); lite.openExternal(a.href); }
      });
      view.appendChild(div);
    } else if (kind === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'prev-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
      frame.src = fileUrl(file);
      view.appendChild(frame);
    }

    lastPreviewFile = file;
    if (keepScroll) {
      if (editor) claimSync(editor.scrollDOM);
      view.scrollTop = keepScroll;
    }
  }

  function applyBufferViewMode(buf) {
    const kind = previewKindFor(buf.path);
    const mode = (kind && buf.viewMode && buf.viewMode !== 'image') ? buf.viewMode : 'code';
    const edEl = $('#editor');
    const pvEl = $('#preview-view');

    if (mode === 'preview' && kind) {
      exitSplitPreview();
      edEl.style.display = 'none';
      pvEl.style.display = 'block';
      fillPreviewPane(kind, buf.path, buf.state ? buf.state.doc.toString() : '');
    } else if (mode === 'split' && (kind === 'markdown' || kind === 'html' || kind === 'svg')) {
      splitPreviewMode = true;
      document.body.classList.add('preview-split');
      edEl.style.display = '';
      pvEl.style.display = 'block';
      fillPreviewPane(kind, buf.path, buf.state ? buf.state.doc.toString() : '');
    } else {
      exitSplitPreview();
      pvEl.style.display = 'none';
      edEl.style.display = '';
    }
    updateViewModeButtons(buf);
  }

  function exitSplitPreview() {
    if (!splitPreviewMode) return;
    splitPreviewMode = false;
    document.body.classList.remove('preview-split');
    clearPreviewMirror();
    clearSourceMirror();
  }

  function refreshSplitPreview() {
    const buf = getGroupFileBuffer('primary');
    if (!splitPreviewMode || !buf || !editor) return;
    const kind = previewKindFor(buf.path);
    if (kind === 'markdown' || kind === 'html' || kind === 'svg') {
      fillPreviewPane(kind, buf.path, editor.state.doc.toString());
    }
  }

  async function setViewMode(mode) {
    const buf = getGroupFileBuffer('primary');
    if (!buf) return;
    if (buf.dirty) await saveBufferNow(buf.path, false);
    buf.viewMode = mode === 'original' ? 'code' : mode;
    applyBufferViewMode(buf);
    if (editor) editor.requestMeasure();
  }

  function updateViewModeButtons(buf) {
    const m = (buf && buf.viewMode) || 'code';
    $('#viewer-original')?.classList.toggle('active', m === 'code');
    $('#viewer-split')?.classList.toggle('active', m === 'split');
    $('#viewer-preview')?.classList.toggle('active', m === 'preview');
  }

  // Синхронизация прокрутки и зеркало выделения Markdown
  let syncSrc = null, syncSrcTimer = null;
  function claimSync(elm) {
    syncSrc = elm;
    clearTimeout(syncSrcTimer);
    syncSrcTimer = setTimeout(() => { syncSrc = null; }, 140);
  }
  function syncScrollFrom(from, to) {
    if (!from || !to || (syncSrc && syncSrc !== from)) return;
    claimSync(from);
    const fm = from.scrollHeight - from.clientHeight;
    const tm = to.scrollHeight - to.clientHeight;
    if (fm > 0 && tm > 0) to.scrollTop = (from.scrollTop / fm) * tm;
  }

  function normIndex(s) {
    const out = [], map = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (WORDCHAR_RE.test(c)) { out.push(c.toLowerCase()); map.push(i); }
    }
    return { text: out.join(''), map };
  }
  function blankMdUrls(src) { return src.replace(/\]\(([^)\n]*)\)/g, (_m, u) => '](' + ' '.repeat(u.length) + ')'); }
  function normPos(map, orig) {
    let lo = 0, hi = map.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (map[mid] < orig) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function findNearest(hay, needle, expected) {
    let best = -1, bestD = Infinity, i = -1, guard = 0;
    while ((i = hay.indexOf(needle, i + 1)) !== -1 && guard++ < 200) {
      const d = Math.abs(i - expected);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function collectPreviewText() {
    const md = $('#preview-view')?.querySelector('.prev-md');
    if (!md) return null;
    const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
    const nodes = [], starts = [];
    let text = '', n;
    while ((n = walker.nextNode())) { nodes.push(n); starts.push(text.length); text += n.nodeValue; }
    return { md, nodes, starts, text };
  }
  function posToNode(pv, pos) {
    let lo = 0, hi = pv.starts.length - 1, idx = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pv.starts[mid] <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    const node = pv.nodes[idx];
    return node ? { node, off: Math.min(pos - pv.starts[idx], node.nodeValue.length) } : null;
  }
  function clearPreviewMirror() { try { if (window.CSS && CSS.highlights) CSS.highlights.delete('lite-mirror'); } catch (_) {} }
  function clearSourceMirror() { if (editor) { try { editor.dispatch({ effects: setMirrorHlEffect.of(null) }); } catch (_) {} } }

  let srcSelTimer = null;
  function scheduleMirrorFromSource() { clearTimeout(srcSelTimer); srcSelTimer = setTimeout(mirrorFromSource, 120); }
  function mirrorFromSource() {
    const b = getGroupFileBuffer('primary');
    if (!splitPreviewMode || !editor || !b || previewKindFor(b.path) !== 'markdown') return;
    const sel = editor.state.selection.main;
    if (sel.empty) { clearPreviewMirror(); return; }
    const srcRaw = editor.state.doc.toString();
    if (srcRaw.length > MIRROR_MAX) return;
    const src = normIndex(blankMdUrls(srcRaw));
    const a = normPos(src.map, sel.from), z = normPos(src.map, sel.to);
    const needle = src.text.slice(a, z);
    if (needle.length < 3) { clearPreviewMirror(); return; }
    const pv = collectPreviewText();
    if (!pv || pv.text.length > MIRROR_MAX) return;
    const prev = normIndex(pv.text);
    const hit = findNearest(prev.text, needle, prev.text.length * (a / Math.max(1, src.text.length)));
    if (hit < 0) { clearPreviewMirror(); return; }
    if (window.CSS && CSS.highlights) {
      const sp = posToNode(pv, prev.map[hit]);
      const ep = posToNode(pv, prev.map[hit + needle.length - 1] + 1);
      if (sp && ep) {
        const range = document.createRange();
        range.setStart(sp.node, sp.off); range.setEnd(ep.node, ep.off);
        CSS.highlights.set('lite-mirror', new Highlight(range));
      }
    }
  }

  // ================================================================ Git Blame, Закладки и Режим Агента
  async function loadBlameForFile(filePath) {
    const p = activeProject();
    if (!p || !filePath || !pathInside(filePath, p.path)) return;
    const r = await lite.git.blame(p.path, filePath);
    if (!r || !r.ok || !Array.isArray(r.lines)) return;
    const map = new Map();
    r.lines.forEach((info, i) => map.set(i + 1, info));
    blameMap = map;
    const v = getActiveEditorView();
    if (v && getActiveBufferFile() === filePath) {
      v.dispatch({ effects: setBlameEffect.of(map) });
      updateStatusFromState(v.state, getActiveBuffer());
    }
  }

  function toggleBlame() {
    blameActive = !blameActive;
    $('#viewer-blame')?.classList.toggle('active', blameActive);
    reconfigureLiveEditors();
    const f = getActiveBufferFile();
    if (blameActive && f) loadBlameForFile(f);
    else {
      blameMap = null;
      if (editor) editor.dispatch({ effects: setBlameEffect.of(null) });
      if (splitEditor) splitEditor.dispatch({ effects: setBlameEffect.of(null) });
      $('#vs-blame').textContent = '';
    }
  }

  function refreshBookmarksForBuffer(buf, targetView) {
    if (!buf || buf.kind !== 'file') return;
    const list = bmList().filter((b) => normSlash(b.file) === buf.path);
    const views = targetView ? [targetView] : [editor, splitEditor].filter(Boolean);
    for (const v of views) {
      if (v === editor && getGroupActiveId('primary') !== buf.id) continue;
      if (v === splitEditor && getGroupActiveId('split') !== buf.id) continue;
      v.dispatch({ effects: setBookmarksEffect.of(list) });
    }
  }

  function toggleBookmarkAt(filePath, lineNum) {
    const list = bmList();
    const norm = normSlash(filePath);
    const idx = list.findIndex((b) => normSlash(b.file) === norm && b.line === lineNum);
    if (idx >= 0) list.splice(idx, 1);
    else list.push({ file: norm, line: lineNum, label: '' });
    list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    saveBookmarks();
    const buf = pool.getBuffer(norm);
    if (buf) refreshBookmarksForBuffer(buf);
  }

  function toggleBookmarkHere() {
    const v = getActiveEditorView();
    const f = getActiveBufferFile();
    if (!v || !f) return;
    const ln = v.state.doc.lineAt(v.state.selection.main.head).number;
    toggleBookmarkAt(f, ln);
  }

  function stepBookmark(delta = 1) {
    const list = bmList();
    if (!list.length) { toast('Закладок нет (Ctrl+F2 — поставить на текущей строке)'); return; }
    const f = getActiveBufferFile();
    const v = getActiveEditorView();
    const curLn = v ? v.state.doc.lineAt(v.state.selection.main.head).number : 0;
    let idx = list.findIndex((b) => normSlash(b.file) === f && (delta > 0 ? b.line > curLn : b.line < curLn));
    if (idx < 0) idx = delta > 0 ? 0 : list.length - 1;
    const target = list[idx];
    openFileInViewer(target.file, target.line, { preview: false });
  }

  function toggleAgentMode() {
    agentMode = !agentMode;
    $('#viewer-agent')?.classList.toggle('on', agentMode);
    document.body.classList.toggle('agent-mode', agentMode);
    reconfigureLiveEditors();
    updateAgentReviewBadge();
    if (agentMode) {
      const f = getActiveBufferFile();
      const map = f ? authorshipByFile.get(f) : null;
      if (editor && map) editor.dispatch({ effects: setAuthorEffect.of(map) });
      toast('Режим ревью агента: цветной слой авторства строк и счётчик правок агента');
    }
  }

  async function updateAgentReviewBadge() {
    const btn = $('#viewer-agent');
    if (!btn) return;
    let badge = btn.querySelector('.agent-badge');
    if (!agentMode) { if (badge) badge.remove(); return; }
    const p = activeProject();
    if (!p) { if (badge) badge.style.display = 'none'; return; }
    const n = Object.keys(gitFiles).length;
    if (!badge) { badge = el('span', 'agent-badge'); btn.appendChild(badge); }
    badge.textContent = String(n);
    badge.style.display = n ? '' : 'none';
  }

  // ================================================================ Контекстные меню Кода и Гаттера + Интеграция с Терминалом
  function sendFileRefToTerminal(filePath, fromLine = null, toLine = null) {
    const p = activeProject();
    const rel = (p && pathInside(filePath, p.path)) ? relTo(p.path, filePath) : baseName(filePath);
    const ref = fromLine
      ? (toLine && toLine !== fromLine ? `@${rel}:${fromLine}-${toLine} ` : `@${rel}:${fromLine} `)
      : `@${rel} `;
    try {
      lite.editorBus.sendToTerminal(ref);
      toast(`Вставлено в терминал: ${ref.trim()}`);
    } catch (_) {
      toast('Не удалось отправить в терминал', { kind: 'err' });
    }
  }

  function sendAiPromptToTerminal(view, filePath, action) {
    const sel = view.state.selection.main;
    if (sel.empty) { toast('Сначала выделите фрагмент кода'); return; }
    const p = activeProject();
    const rel = (p && pathInside(filePath, p.path)) ? relTo(p.path, filePath) : baseName(filePath);
    const l1 = view.state.doc.lineAt(sel.from).number;
    const l2 = view.state.doc.lineAt(sel.to).number;
    const code = view.state.sliceDoc(sel.from, sel.to);
    const prompts = {
      explain: `Объясни подробно логику кода из ${rel} (строки ${l1}–${l2}):`,
      refactor: `Отрефактори код из ${rel} (строки ${l1}–${l2}), сохранив поведение:`,
      bugs: `Проверь на потенциальные баги и крайние случаи код из ${rel} (строки ${l1}–${l2}):`,
      tests: `Напиши модульные тесты для кода из ${rel} (строки ${l1}–${l2}):`,
    };
    const text = `${prompts[action]}\n\n\`\`\`\n${code}\n\`\`\`\n`;
    try {
      lite.editorBus.sendToTerminal(text);
      toast('Промпт отправлен в активный терминал');
    } catch (_) {
      toast('Не удалось отправить в терминал', { kind: 'err' });
    }
  }

  function showEditorContextMenu(x, y, view, buf) {
    closeMenus();
    const sel = view.state.selection.main;
    const hasSel = !sel.empty;
    const l1 = view.state.doc.lineAt(sel.from).number;
    const l2 = view.state.doc.lineAt(sel.to).number;
    const p = activeProject();
    const rel = (p && pathInside(buf.path, p.path)) ? relTo(p.path, buf.path) : baseName(buf.path);

    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '255px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    const add = (ic, label, fn, keys) => {
      const r = menuRow(ic, label, () => { closeMenus(); fn(); });
      if (keys) r.appendChild(el('span', 'menu-kbd', keys));
      dd.appendChild(r);
    };
    const sep = () => dd.appendChild(el('div', 'menu-sep'));

    add('locate', 'Перейти к определению', () => goToDefinitionFromView(view, buf.path), 'F12');
    add('search', 'Найти использования в проекте', () => findUsagesFromView(view, buf.path), 'Shift+F12');
    if (!buf.readOnly) {
      add('wand', 'Переименовать символ в файле', () => renameSymbolInActiveEditor(), settings.viewerKeymap === 'jetbrains' ? 'Shift+F6' : 'F2');
    }

    sep();
    if (!buf.readOnly && hasSel) {
      add('scissors', 'Вырезать', () => { view.focus(); document.execCommand('cut'); }, 'Ctrl+X');
    }
    add('copy', 'Копировать', () => { view.focus(); document.execCommand('copy'); }, 'Ctrl+C');
    if (!buf.readOnly) {
      add('clipboard', 'Вставить', () => { view.focus(); document.execCommand('paste'); }, 'Ctrl+V');
    }
    add('copy', `Скопировать ссылку @${baseName(buf.path)}:${l1}`, () => {
      const ref = hasSel && l2 !== l1 ? `@${rel}:${l1}-${l2}` : `@${rel}:${l1}`;
      lite.copyText(ref);
      toast(`Скопировано: ${ref}`);
    });

    if (!buf.readOnly) {
      sep();
      add('code', 'Закомментировать / раскомментировать', () => { toggleComment(view); view.focus(); }, 'Ctrl+/');
      add('wand', 'Форматировать документ', () => formatActiveDocument(), settings.viewerKeymap === 'jetbrains' ? 'Ctrl+Alt+L' : 'Shift+Alt+F');
    }

    sep();
    // Интеграция с ИИ-агентом в терминале — доступна ВСЕГДА в 1 клик!
    add('terminal', 'Вставить @файл:строки в терминал', () => sendFileRefToTerminal(buf.path, l1, hasSel ? l2 : l1));
    if (hasSel) {
      add('sparkles', 'Агент: объяснить выделенный код', () => sendAiPromptToTerminal(view, buf.path, 'explain'));
      add('wrench', 'Агент: отрефакторить выделение', () => sendAiPromptToTerminal(view, buf.path, 'refactor'));
      add('bug', 'Агент: проверить на баги', () => sendAiPromptToTerminal(view, buf.path, 'bugs'));
      add('check', 'Агент: написать тесты', () => sendAiPromptToTerminal(view, buf.path, 'tests'));
    }

    sep();
    add('split-right', 'Разделить редактор вправо', () => openInSplitRight(buf.path), 'Ctrl+\\');
    add('diff', 'Git: Показать изменения файла', () => { if (p) showGitDiff(p.path, buf.path, { name: buf.title }); });
    add('users', blameActive ? 'Git: Скрыть авторов строк (Blame)' : 'Git: Показать авторов строк (Blame)', () => toggleBlame());
    add('history', 'Локальная история файла…', () => overlays.showLocalHistoryModal(buf.path));
    add('folder', 'Показать файл в дереве', () => revealInTree(buf.path));

    placeMenu(dd, x, y);
  }

  function showGutterContextMenu(x, y, filePath, lineNum) {
    closeMenus();
    const p = activeProject();
    const rel = (p && pathInside(filePath, p.path)) ? relTo(p.path, filePath) : baseName(filePath);
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '230px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    dd.appendChild(menuRow('bookmark', `Закладка на строке ${lineNum}`, () => { closeMenus(); toggleBookmarkAt(filePath, lineNum); }));
    dd.appendChild(menuRow('copy', `Копировать ${rel}:${lineNum}`, () => { closeMenus(); lite.copyText(`${rel}:${lineNum}`); toast('Скопировано'); }));
    dd.appendChild(menuRow('terminal', `Отправить @${baseName(filePath)}:${lineNum} в терминал`, () => { closeMenus(); sendFileRefToTerminal(filePath, lineNum); }));
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(menuRow('users', blameActive ? 'Скрыть Git Blame' : 'Показать Git Blame', () => { closeMenus(); toggleBlame(); }));
    placeMenu(dd, x, y);
  }

  // ================================================================ Обновление с диска (fs:changed) и Конфликты
  function showReloadBar() { $('#viewer-reload-bar')?.classList.remove('hidden'); }
  function hideReloadBar() { $('#viewer-reload-bar')?.classList.add('hidden'); }

  function diffLineNums(oldTxt, newTxt) {
    const a = oldTxt.split('\n'), b = newTxt.split('\n');
    const changed = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i] && i < b.length) changed.push(i + 1);
    }
    return changed;
  }

  async function reloadBufferFromDisk(filePath, forceDiscardLocal = false) {
    const normPath = normSlash(filePath);
    const buf = pool.getBuffer(normPath);
    if (!buf || buf.kind !== 'file') return;

    if (buf.viewMode === 'image') {
      if (getGroupActiveId('primary') === normPath) fillPreviewPane('image', normPath, '');
      return;
    }

    const res = await lite.fs.readFile(normPath);
    if (!res || res.error) return;
    const diskClean = normEolText(res.content || '');
    buf.docEol = eolOfText(res.content || '');

    // Эхо нашего собственного автосохранения — ничего не перерисовываем (сохраняем фолдинг и курсоры!)
    if (!forceDiscardLocal && buf.diskBase === diskClean && !buf.dirty) {
      updateGitGutterForBuffer(buf);
      return;
    }

    // Если в буфере есть несохранённые ручные правки и диск изменился иначе — показываем плашку конфликта!
    if (!forceDiscardLocal && buf.dirty && buf.state && buf.state.doc.toString() !== diskClean) {
      buf.conflictOnDisk = true;
      if (getActiveBufferFile() === normPath) showReloadBar();
      return;
    }

    const oldDoc = buf.state ? buf.state.doc.toString() : '';
    buf.diskBase = diskClean;
    buf.conflictOnDisk = false;
    buf.readOnly = !!res.notUtf8;
    setBufferDirty(buf, false);

    // Аккуратно обновляем открытые представления или фоновый стейт с сохранением позиции курсора
    const applyNewTextToView = (v, isPrimary) => {
      const curStr = v.state.doc.toString();
      if (curStr !== diskClean) {
        const head = Math.min(diskClean.length, v.state.selection.main.head);
        syncingMirrorChange = true;
        try {
          v.dispatch({
            changes: { from: 0, to: curStr.length, insert: diskClean },
            selection: { anchor: head },
          });
        } finally {
          syncingMirrorChange = false;
        }
      }
      if (isPrimary) buf.state = v.state;
      else buf.splitState = v.state;
    };

    const inPrimary = editor && getGroupActiveId('primary') === normPath;
    const inSplit = splitEditor && getGroupActiveId('split') === normPath;
    if (inPrimary) applyNewTextToView(editor, true);
    else if (buf.state) {
      const curStr = buf.state.doc.toString();
      if (curStr !== diskClean) {
        buf.state = buf.state.update({ changes: { from: 0, to: curStr.length, insert: diskClean } }).state;
      }
    }
    if (inSplit) applyNewTextToView(splitEditor, false);
    else if (buf.splitState) {
      const curStr = buf.splitState.doc.toString();
      if (curStr !== diskClean) {
        buf.splitState = buf.splitState.update({ changes: { from: 0, to: curStr.length, insert: diskClean } }).state;
      }
    }

    if (agentMode && oldDoc && oldDoc !== diskClean) {
      const ch = diffLineNums(oldDoc, diskClean);
      if (ch.length) {
        let map = authorshipByFile.get(normPath);
        if (!map) { map = new Map(); authorshipByFile.set(normPath, map); }
        for (const ln of ch) map.set(ln, 'agent');
        if (inPrimary) editor.dispatch({ effects: setAuthorEffect.of(map) });
      }
    }

    if (getActiveBufferFile() === normPath) {
      hideReloadBar();
      if (buf.viewMode === 'preview' || buf.viewMode === 'split') {
        const kind = previewKindFor(normPath);
        if (kind) fillPreviewPane(kind, normPath, diskClean);
      }
    }
    updateGitGutterForBuffer(buf);
  }

  // ================================================================ Дерево файлов IDE-класса
  function gitClassFor(absPath) {
    const code = gitFiles[absPath];
    if (!code) return '';
    if (code === '?' || code.includes('A')) return 'g-add';
    if (code.includes('D')) return 'g-del';
    return 'g-mod';
  }

  function dirGitClass(dirPath) {
    const prefix = trimTrail(dirPath) + '/';
    let hasMod = false, hasAdd = false;
    for (const [k, code] of Object.entries(gitFiles)) {
      if (!k.startsWith(prefix)) continue;
      if (code !== '?' && !code.includes('A')) hasMod = true;
      else hasAdd = true;
    }
    return hasMod ? 'g-mod' : hasAdd ? 'g-add' : '';
  }

  async function getAllProjectFiles(root) {
    if (fileListCache && fileListCache.root === root) return fileListCache.files;
    const res = await lite.fs.listAll(root);
    const files = (res && Array.isArray(res.files)) ? res.files.map(normSlash) : [];
    fileListCache = { root, files };
    return files;
  }

  async function readDirCached(dirPath, force = false) {
    if (!force && dirEntriesCache.has(dirPath)) return dirEntriesCache.get(dirPath);
    const res = await lite.fs.readDir(dirPath);
    const entries = (res && Array.isArray(res.entries))
      ? res.entries.map((e) => ({ ...e, path: normSlash(e.path) }))
      : [];
    dirEntriesCache.set(dirPath, entries);
    return entries;
  }

  function highlightTreeActive(absPath) {
    const norm = normSlash(absPath);
    document.querySelectorAll('#tree .tree-row').forEach((r) => {
      r.classList.toggle('active', r.dataset.path === norm);
    });
  }

  let treeRenderSeq = 0;

  async function renderTree(proj, opts = {}) {
    const treeEl = $('#tree');
    if (!treeEl) return;
    const p = proj || activeProject();
    if (!p) {
      treeEl.replaceChildren(el('div', 'tree-empty', 'Проект не выбран'));
      return;
    }

    const seq = ++treeRenderSeq;
    const keepScroll = treeEl.scrollTop;
    const rootNorm = trimTrail(p.path);

    if (opts.invalidateDirs) {
      for (const d of opts.invalidateDirs) dirEntriesCache.delete(normSlash(d));
    } else if (!opts.preserveCache) {
      dirEntriesCache.clear();
    }

    // Параллельно обновляем git-статус
    const stRes = await lite.git.status(rootNorm).catch(() => null);
    if (seq !== treeRenderSeq) return;
    gitFiles = (stRes && stRes.files) ? stRes.files : {};
    updateGitStatusBar();
    updateAgentReviewBadge();

    const filterQ = treeFilter.trim().toLowerCase();

    // Если введён фильтр дерева — показываем быстрые совпадения по всему проекту!
    if (filterQ) {
      const allRel = await getAllProjectFiles(rootNorm);
      if (seq !== treeRenderSeq) return;
      const matched = allRel.filter((rel) => rel.toLowerCase().includes(filterQ)).slice(0, 200);
      const frag = document.createDocumentFragment();
      if (!matched.length) {
        frag.appendChild(el('div', 'tree-empty', 'Нет файлов по фильтру'));
      } else {
        for (const rel of matched) {
          const abs = joinPath(rootNorm, rel);
          const name = baseName(rel);
          const parentRel = dirName(rel) === rel ? '' : dirName(rel);
          const row = buildTreeRowDom({ name, path: abs, dir: false }, 0, parentRel);
          frag.appendChild(row);
        }
      }
      treeEl.replaceChildren(frag);
      return;
    }

    const frag = document.createDocumentFragment();
    await appendDirChildrenDom(rootNorm, 0, frag, seq);
    if (seq !== treeRenderSeq) return;

    treeEl.replaceChildren(frag);
    treeEl.scrollTop = keepScroll;
  }

  async function appendDirChildrenDom(dirPath, depth, container, seq) {
    const entries = await readDirCached(dirPath);
    if (seq !== treeRenderSeq) return;
    const compact = settings.compactFolders !== false;

    for (const ent of entries) {
      if (ent.dir) {
        let displayLabel = ent.name;
        let leafDirEnt = ent;

        // Compact Middle Folders (как в PhpStorm / VS Code): цепочка одиночных папок a/b/c в одну строку!
        if (compact && expandedDirs.has(ent.path)) {
          let curEnt = ent;
          let guard = 0;
          while (guard++ < 12) {
            const sub = await readDirCached(curEnt.path);
            if (seq !== treeRenderSeq) return;
            if (sub.length === 1 && sub[0].dir) {
              curEnt = sub[0];
              expandedDirs.add(curEnt.path);
              displayLabel += '/' + curEnt.name;
              leafDirEnt = curEnt;
            } else break;
          }
        }

        const isOpen = expandedDirs.has(leafDirEnt.path);
        const row = buildTreeRowDom({ ...leafDirEnt, displayLabel, topChainPath: ent.path }, depth);
        container.appendChild(row);
        if (isOpen) {
          const subBox = el('div', 'tree-children');
          container.appendChild(subBox);
          await appendDirChildrenDom(leafDirEnt.path, depth + 1, subBox, seq);
          if (seq !== treeRenderSeq) return;
        }
      } else {
        container.appendChild(buildTreeRowDom(ent, depth));
      }
    }
  }

  function buildTreeRowDom(ent, depth, subHint = '') {
    const isDir = !!ent.dir;
    const isOpen = isDir && expandedDirs.has(ent.path);
    const activeFile = getActiveBufferFile();
    const row = el('div', 'tree-row ' + (isDir ? ('dir' + (isOpen ? ' open' : '')) : 'file') + (ent.path === activeFile ? ' active' : ''));
    row.dataset.path = ent.path;
    row.dataset.dir = isDir ? '1' : '0';
    row.style.paddingLeft = (depth * 14 + 8) + 'px';
    row.draggable = true;

    if (isDir) {
      const chev = el('span', 'tree-chev');
      chev.appendChild(icon(isOpen ? 'chevron-down' : 'chevron-right', 12));
      row.appendChild(chev);
      row.appendChild(folderTypeSvg(isOpen, ent.name));
    } else {
      row.appendChild(el('span', 'tree-chev-spacer'));
      row.appendChild(fileTypeSvg(ent.name));
    }

    const gc = isDir ? dirGitClass(ent.path) : gitClassFor(ent.path);
    const nameSpan = el('span', 'tree-name' + (gc ? ' ' + gc : ''), ent.displayLabel || ent.name);
    row.appendChild(nameSpan);
    if (subHint) row.appendChild(el('span', 'tree-subhint', subHint));
    if (treeClipboard && treeClipboard.mode === 'cut' && treeClipboard.path === ent.path) {
      row.classList.add('is-cut');
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      $('#tree')?.focus({ preventScroll: true });
      if (isDir) {
        toggleTreeDir(ent);
      } else {
        // Одиночный клик открывает preview-вкладку (курсивом), Ctrl+Click — справа в сплите!
        if (e.ctrlKey || e.metaKey) openFileInViewer(ent.path, null, { group: 'split', preview: false });
        else openFileInViewer(ent.path, null, { preview: true });
      }
    });

    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (!isDir) {
        openFileInViewer(ent.path, null, { preview: false });
        pool.promotePreview(ent.path);
        renderAllTabBars();
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showTreeContextMenu(e.clientX, e.clientY, ent);
    });

    // Drag & Drop файлов в дереве
    row.addEventListener('dragstart', (e) => {
      dragSrcPath = ent.path;
      try { e.dataTransfer.setData('text/plain', ent.path); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    });
    row.addEventListener('dragend', () => { dragSrcPath = null; clearDropHL(); });
    if (isDir) {
      row.addEventListener('dragover', (e) => {
        if (dragSrcPath && (dragSrcPath === ent.path || pathInside(ent.path, dragSrcPath))) return;
        e.preventDefault(); e.stopPropagation();
        setDropHL(row);
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        handleTreeDrop(e, ent.path);
      });
    }

    return row;
  }

  function toggleTreeDir(ent) {
    const p = activeProject();
    if (!p) return;
    if (expandedDirs.has(ent.path)) {
      expandedDirs.delete(ent.path);
      if (ent.topChainPath && ent.topChainPath !== ent.path) expandedDirs.delete(ent.topChainPath);
    } else {
      expandedDirs.add(ent.path);
      if (ent.topChainPath) expandedDirs.add(ent.topChainPath);
    }
    renderTree(p, { preserveCache: true });
    scheduleSaveWorkspace();
  }

  // Инлайн-создание файла / папки (с поддержкой вложенных путей a/b/file.ts) и инлайн-переименование
  function startInlineCreate(parentDir, isFolder) {
    const p = activeProject();
    if (!p) return;
    const normParent = normSlash(parentDir);
    if (normParent !== trimTrail(p.path)) expandedDirs.add(normParent);

    renderTree(p, { preserveCache: true }).then(() => {
      const treeEl = $('#tree');
      if (!treeEl) return;
      let anchor = treeEl.querySelector(`.tree-row[data-path="${cssEscape(normParent)}"]`);
      const row = el('div', 'tree-row tree-inline-row');
      const depth = anchor ? Math.round((parseInt(anchor.style.paddingLeft, 10) || 8) / 14) + 1 : 0;
      row.style.paddingLeft = (depth * 14 + 8) + 'px';
      row.appendChild(isFolder ? folderTypeSvg(false) : fileTypeSvg('file.txt'));
      const inp = el('input', 'tree-inline-inp');
      inp.type = 'text';
      inp.placeholder = isFolder ? 'имя/папки…' : 'имя файла (можно dir/file.js)…';
      inp.spellcheck = false;
      row.appendChild(inp);

      if (anchor && anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('tree-children')) {
        anchor.nextElementSibling.prepend(row);
      } else if (anchor) {
        anchor.after(row);
      } else {
        treeEl.prepend(row);
      }

      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const val = inp.value.trim().replace(/^\/+|\/+$/g, '');
        row.remove();
        if (!commit || !val) return;

        const parts = val.split('/').filter(Boolean);
        if (isFolder) {
          let cur = normParent;
          for (const seg of parts) {
            const r = await lite.fs.mkdir(cur, seg);
            if (r && r.error && !/exist/i.test(r.error)) { toast(r.error, { kind: 'err' }); break; }
            cur = joinPath(cur, seg);
            expandedDirs.add(cur);
          }
          fileListCache = null;
          renderTree(p);
        } else {
          const fileName = parts.pop();
          let cur = normParent;
          for (const seg of parts) {
            await lite.fs.mkdir(cur, seg);
            cur = joinPath(cur, seg);
            expandedDirs.add(cur);
          }
          const cr = await lite.fs.create(cur, fileName, false);
          if (cr && cr.error) { toast(cr.error, { kind: 'err' }); return; }
          fileListCache = null;
          const createdPath = normSlash(cr.path || joinPath(cur, fileName));
          await renderTree(p);
          openFileInViewer(createdPath, 1, { preview: false });
        }
      };

      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
      inp.focus();
    });
  }

  function startInlineRename(ent) {
    const p = activeProject();
    if (!p || ent.root) return;
    const row = document.querySelector(`#tree .tree-row[data-path="${cssEscape(ent.path)}"]`);
    const nameSpan = row?.querySelector('.tree-name');
    if (!row || !nameSpan) return;

    const inp = el('input', 'tree-inline-inp');
    inp.type = 'text';
    inp.value = ent.name;
    inp.spellcheck = false;
    nameSpan.replaceWith(inp);

    const dotIdx = !ent.dir ? ent.name.lastIndexOf('.') : -1;
    inp.focus();
    if (dotIdx > 0) inp.setSelectionRange(0, dotIdx);
    else inp.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const newName = inp.value.trim();
      if (!commit || !newName || newName === ent.name) {
        inp.replaceWith(nameSpan);
        return;
      }
      const rr = await lite.fs.rename(ent.path, newName);
      if (rr && rr.error) {
        toast(rr.error, { kind: 'err' });
        inp.replaceWith(nameSpan);
        return;
      }
      const newPath = normSlash(rr.path || joinPath(dirName(ent.path), newName));
      pool.remapPaths(ent.path, newPath);
      if (expandedDirs.has(ent.path)) { expandedDirs.delete(ent.path); expandedDirs.add(newPath); }
      fileListCache = null;
      symbolIndex.invalidate();
      await renderTree(p);
      renderAllTabBars();
      scheduleSaveWorkspace();
    };

    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('blur', () => finish(true));
  }

  async function duplicateTreeFile(ent) {
    const p = activeProject();
    if (!p || ent.dir) return;
    const parent = dirName(ent.path);
    const dot = ent.name.lastIndexOf('.');
    const stem = dot > 0 ? ent.name.slice(0, dot) : ent.name;
    const ext = dot > 0 ? ent.name.slice(dot) : '';
    const copyName = `${stem}.copy${ext}`;
    const src = await lite.fs.readFile(ent.path);
    if (!src || src.error) { toast((src && src.error) || 'Не удалось прочитать файл', { kind: 'err' }); return; }
    const cr = await lite.fs.create(parent, copyName, false);
    if (!cr || cr.error) { toast((cr && cr.error) || 'Не удалось создать копию', { kind: 'err' }); return; }
    await lite.fs.writeFile(cr.path, src.content || '');
    fileListCache = null;
    await renderTree(p);
    openFileInViewer(cr.path, 1, { preview: false });
    startInlineRename({ name: copyName, path: normSlash(cr.path), dir: false });
  }

  async function pasteIntoTreeDir(destDir) {
    const p = activeProject();
    if (!p || !treeClipboard) return;
    const { mode, path: srcPath } = treeClipboard;
    if (mode === 'cut') {
      const r = await lite.fs.move(srcPath, destDir);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      const newPath = normSlash(r.path || joinPath(destDir, baseName(srcPath)));
      pool.remapPaths(srcPath, newPath);
      treeClipboard = null;
      toast('Перемещено: ' + baseName(newPath));
    } else {
      const r = await lite.fs.importPath(srcPath, destDir);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      toast('Скопировано в ' + baseName(destDir));
    }
    fileListCache = null;
    symbolIndex.invalidate();
    await renderTree(p);
    renderAllTabBars();
  }

  function deleteTreeEntry(ent) {
    const p = activeProject();
    if (!p || ent.root) return;
    showConfirm('Удалить?', `«${ent.name}» будет безвозвратно удалён с диска.`, 'Удалить', async () => {
      const r = await lite.fs.delete(ent.path);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      const affected = pool.dropUnder(ent.path);
      if (affected.primaryClosedActive) {
        if (affected.primaryNext) activateTabInGroup('primary', affected.primaryNext);
        else clearPrimarySurface();
      }
      if (affected.splitClosedActive) {
        if (affected.splitNext) activateTabInGroup('split', affected.splitNext);
        else syncSplitVisibility();
      }
      fileListCache = null;
      symbolIndex.invalidate();
      await renderTree(p);
      renderAllTabBars();
      scheduleSaveWorkspace();
    });
  }

  function showTreeContextMenu(x, y, ent) {
    closeMenus();
    const p = activeProject();
    const targetDir = ent.dir ? ent.path : dirName(ent.path);
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '235px';
    dd.addEventListener('click', (e) => e.stopPropagation());

    const add = (ic, label, fn, keys, cls) => {
      const r = menuRow(ic, label, () => { closeMenus(); fn(); }, cls);
      if (keys) r.appendChild(el('span', 'menu-kbd', keys));
      dd.appendChild(r);
    };
    const sep = () => dd.appendChild(el('div', 'menu-sep'));

    add('file-plus', 'Новый файл…', () => startInlineCreate(targetDir, false));
    add('folder-plus', 'Новая папка…', () => startInlineCreate(targetDir, true));

    if (!ent.root) {
      sep();
      if (!ent.dir) {
        add('file-text', 'Открыть', () => openFileInViewer(ent.path, null, { preview: false }), 'Enter');
        add('split-right', 'Открыть справа в сплите', () => openInSplitRight(ent.path));
        add('copy', 'Дублировать файл', () => duplicateTreeFile(ent));
      } else {
        add('search', 'Найти в этой папке…', () => {
          openSideSection('search');
          if (p) sidePanels.openSearch({ filesMask: relTo(p.path, ent.path) + '/**' });
        });
      }

      sep();
      add('copy', 'Копировать', () => { treeClipboard = { mode: 'copy', path: ent.path }; toast('Скопировано: ' + ent.name); }, 'Ctrl+C');
      add('scissors', 'Вырезать', () => { treeClipboard = { mode: 'cut', path: ent.path }; renderTree(p, { preserveCache: true }); }, 'Ctrl+X');
    }
    if (treeClipboard) {
      add('clipboard', `Вставить «${baseName(treeClipboard.path)}»`, () => pasteIntoTreeDir(targetDir), 'Ctrl+V');
    }

    if (!ent.root) {
      sep();
      if (!ent.dir) {
        if (cmpFirst && cmpFirst !== ent.path) {
          add('columns', `Сравнить с «${baseName(cmpFirst)}»`, () => {
            const a = cmpFirst; cmpFirst = null;
            runCompareTwoFiles(a, ent.path);
          });
        } else {
          add('columns', 'Выбрать для сравнения…', () => {
            cmpFirst = ent.path;
            toast(`Выбран «${ent.name}» — ПКМ по второму файлу → «Сравнить»`);
          });
        }
        if (statusBranch && gitFiles[ent.path]) {
          add('diff', 'Git: Изменения файла', () => showGitDiff(p.path, ent.path, { name: ent.name }));
        }
        add('history', 'Локальная история…', () => overlays.showLocalHistoryModal(ent.path));
        sep();
      }
      if (p && pathInside(ent.path, p.path)) {
        add('copy', 'Копировать относительный путь', () => { lite.copyText(relTo(p.path, ent.path)); toast('Скопировано'); });
      }
      add('copy', 'Копировать полный путь', () => { lite.copyText(ent.path); toast('Путь скопирован'); });
      add('terminal', 'Отправить @путь в терминал', () => sendFileRefToTerminal(ent.path));
      add('folder', 'Показать в проводнике', () => lite.showItemInFolder(ent.path));
      sep();
      add('edit', 'Переименовать…', () => startInlineRename(ent), 'F2');
      add('trash', 'Удалить…', () => deleteTreeEntry(ent), 'Del', 'danger');
    }

    placeMenu(dd, x, y);
  }

  function showTreeOptionsMenu(x, y) {
    closeMenus();
    const p = activeProject();
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '240px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    const compact = settings.compactFolders !== false;
    dd.appendChild(menuRow(compact ? 'check' : 'square', 'Схлопывать одиночные папки (Compact)', () => {
      closeMenus();
      settings.compactFolders = !compact;
      host.saveSettings();
      if (p) renderTree(p, { preserveCache: true });
    }));
    const topTabs = isTopTabsMode();
    dd.appendChild(menuRow(topTabs ? 'check' : 'square', 'Вкладки сверху (горизонтально)', () => {
      closeMenus();
      settings.viewerTabsPos = topTabs ? 'left' : 'top';
      host.saveSettings();
      renderAllTabBars();
    }));
    placeMenu(dd, x, y);
  }

  // Drag & Drop хелперы дерева
  let dropTargetEl = null;
  function setDropHL(elNode) {
    if (dropTargetEl === elNode) return;
    if (dropTargetEl) dropTargetEl.classList.remove('drop-target');
    dropTargetEl = elNode;
    if (dropTargetEl) dropTargetEl.classList.add('drop-target');
    $('#tree')?.classList.remove('drag-over-root');
  }
  function clearDropHL() {
    setDropHL(null);
    $('#tree')?.classList.remove('drag-over-root');
  }

  async function handleTreeDrop(e, destDir) {
    clearDropHL();
    const p = activeProject();
    if (!p) return;
    if (dragSrcPath) {
      const src = dragSrcPath;
      dragSrcPath = null;
      if (src === destDir || dirName(src) === destDir || pathInside(destDir, src)) return;
      const r = await lite.fs.move(src, destDir);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      const newPath = normSlash(r.path || joinPath(destDir, baseName(src)));
      pool.remapPaths(src, newPath);
      fileListCache = null;
      symbolIndex.invalidate();
      await renderTree(p);
      renderAllTabBars();
      return;
    }
    const extFiles = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
    for (const f of extFiles) {
      const fp = lite.pathForFile ? lite.pathForFile(f) : f.path;
      if (fp) await lite.fs.importPath(fp, destDir);
    }
    if (extFiles.length) {
      fileListCache = null;
      renderTree(p);
    }
  }

  async function revealInTree(targetPath, expandSelf = false) {
    const p = activeProject();
    const norm = normSlash(targetPath);
    if (!p || !norm || !pathInside(norm, p.path)) return;
    if (curSection !== 'files') openSideSection('files');
    if (expandSelf && norm !== trimTrail(p.path)) expandedDirs.add(norm);
    for (let d = dirName(norm), guard = 0; d && d !== trimTrail(p.path) && pathInside(d, p.path) && guard < 64; guard++) {
      expandedDirs.add(d);
      const up = dirName(d);
      if (up === d) break;
      d = up;
    }
    await renderTree(p, { preserveCache: true });
    const row = document.querySelector(`#tree .tree-row[data-path="${cssEscape(norm)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1100);
    }
  }

  // Клавиатурная навигация по дереву (#tree)
  function wireTreeKeyboard() {
    const treeEl = $('#tree');
    if (!treeEl) return;
    treeEl.addEventListener('keydown', (e) => {
      const p = activeProject();
      if (!p) return;
      const rows = [...treeEl.querySelectorAll('.tree-row:not(.tree-inline-row)')];
      if (!rows.length) return;
      let curIdx = rows.findIndex((r) => r.classList.contains('kb-focus'));
      if (curIdx < 0) curIdx = rows.findIndex((r) => r.classList.contains('active'));
      if (curIdx < 0) curIdx = 0;

      const setKbFocus = (idx) => {
        const clamped = Math.max(0, Math.min(rows.length - 1, idx));
        rows.forEach((r, i) => r.classList.toggle('kb-focus', i === clamped));
        rows[clamped]?.scrollIntoView({ block: 'nearest' });
      };

      const curRow = rows[curIdx];
      const ent = curRow ? {
        path: curRow.dataset.path,
        name: baseName(curRow.dataset.path),
        dir: curRow.dataset.dir === '1',
      } : null;

      if (e.key === 'ArrowDown') { e.preventDefault(); setKbFocus(curIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setKbFocus(curIdx - 1); }
      else if (e.key === 'ArrowRight' && ent) {
        e.preventDefault();
        if (ent.dir && !expandedDirs.has(ent.path)) {
          expandedDirs.add(ent.path);
          renderTree(p, { preserveCache: true });
        } else setKbFocus(curIdx + 1);
      } else if (e.key === 'ArrowLeft' && ent) {
        e.preventDefault();
        if (ent.dir && expandedDirs.has(ent.path)) {
          expandedDirs.delete(ent.path);
          renderTree(p, { preserveCache: true });
        } else {
          const parentPath = dirName(ent.path);
          const pIdx = rows.findIndex((r) => r.dataset.path === parentPath);
          if (pIdx >= 0) setKbFocus(pIdx);
        }
      } else if (e.key === 'Enter' && ent) {
        e.preventDefault();
        if (ent.dir) toggleTreeDir(ent);
        else openFileInViewer(ent.path, null, { preview: false });
      } else if (e.key === 'F2' && ent) {
        e.preventDefault();
        startInlineRename(ent);
      } else if (e.key === 'Delete' && ent) {
        e.preventDefault();
        deleteTreeEntry(ent);
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC' && ent) {
        e.preventDefault();
        treeClipboard = { mode: 'copy', path: ent.path };
        toast('Скопировано: ' + ent.name);
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyX' && ent) {
        e.preventDefault();
        treeClipboard = { mode: 'cut', path: ent.path };
        renderTree(p, { preserveCache: true });
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        e.preventDefault();
        const dest = ent ? (ent.dir ? ent.path : dirName(ent.path)) : trimTrail(p.path);
        pasteIntoTreeDir(dest);
      }
    });
  }

  // ================================================================ Секции левой панели, Нижняя панель Git и Меню «Ещё»
  function openSideSection(sectionName, toggleIfSame = false) {
    if (sectionName === 'branches') {
      toggleLogPane();
      return;
    }
    if (toggleIfSame && curSection === sectionName) {
      curSection = null; // Свернуть левую боковую колонку целиком (максимум места коду!)
    } else {
      curSection = sectionName;
    }

    document.body.classList.toggle('side-collapsed', !curSection);
    $('#tree-pane')?.classList.toggle('hidden', curSection !== 'files');
    $('#commit-pane')?.classList.toggle('hidden', curSection !== 'commit');
    $('#side-search-pane')?.classList.toggle('hidden', curSection !== 'search');
    $('#side-outline-pane')?.classList.toggle('hidden', curSection !== 'outline');
    $('#side-todos-pane')?.classList.toggle('hidden', curSection !== 'todos');
    $('#side-bookmarks-pane')?.classList.toggle('hidden', curSection !== 'bookmarks');

    if (sidePanels) {
      if (curSection === 'search') sidePanels.openSearch();
      else if (curSection === 'outline') sidePanels.openOutline();
      else if (curSection === 'todos') sidePanels.openTodos();
      else if (curSection === 'bookmarks') sidePanels.openBookmarks();
      else sidePanels.setActivePanel(null);
    }
    if (curSection === 'commit') gitRender();
    updateStripButtons();
    scheduleSaveWorkspace();
  }

  function updateStripButtons() {
    document.querySelectorAll('.vcs-strip .strip-btn[data-section]').forEach((b) => {
      const s = b.dataset.section;
      b.classList.toggle('active', s === 'branches' ? logOpen : s === curSection);
    });
  }

  const LOG_H_DEFAULT = 280, LOG_MIN = 140, LOG_MAX = 640;
  function setLogHeight(h) { $('#module-root')?.style.setProperty('--log-h', h + 'px'); }

  function openLogPane(subTab = null) {
    if (!logOpen) {
      logOpen = true;
      $('#log-pane')?.classList.remove('hidden');
      const saved = host.STORE && host.STORE.mwLogH;
      setLogHeight(Math.max(LOG_MIN, Math.min(LOG_MAX, saved || LOG_H_DEFAULT)));
    }
    updateStripButtons();
    if (git) git.renderPanel(activeProject(), { commit: curSection === 'commit', log: true, sub: subTab || undefined });
  }

  function closeLogPane() {
    if (!logOpen) return;
    logOpen = false;
    $('#log-pane')?.classList.add('hidden');
    updateStripButtons();
  }

  function toggleLogPane() {
    if (logOpen) closeLogPane();
    else openLogPane();
  }

  function gitRender() {
    if (git) git.renderPanel(activeProject(), { commit: curSection === 'commit', log: logOpen });
  }

  let gitMarksSeq = 0;
  async function refreshGitMarks() {
    const p = activeProject();
    if (!p) return;
    const seq = ++gitMarksSeq;
    const res = await lite.git.status(p.path).catch(() => null);
    if (seq !== gitMarksSeq || activeProject() !== p || !res || res.error) return;
    gitFiles = res.files || {};
    updateGitStatusBar();
    updateAgentReviewBadge();
    document.querySelectorAll('#tree .tree-row').forEach((row) => {
      const name = row.querySelector('.tree-name');
      if (!name || !row.dataset.path) return;
      name.classList.remove('g-add', 'g-mod', 'g-del');
      const gc = row.dataset.dir === '1' ? dirGitClass(row.dataset.path) : gitClassFor(row.dataset.path);
      if (gc) name.classList.add(gc);
    });
    renderAllTabBars();
  }

  function updateGitStatusBar() {
    const n = Object.keys(gitFiles).length;
    const badge = $('#strip-commit-badge');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', !n);
    }
    const br = $('#st-branch'), ch = $('#st-changes');
    if (br) {
      br.classList.toggle('hidden', !statusBranch);
      $('#st-branch-name').textContent = statusBranch || '';
    }
    if (ch) {
      ch.classList.toggle('hidden', !statusBranch);
      ch.textContent = n ? tr('Изменено: {0}', n) : tr('Чисто');
      ch.classList.toggle('has', !!n);
    }
  }

  // ================================================================ Пустое состояние, Меню настроек редактора и Палитра команд
  function syncEmptyState() {
    const box = $('#viewer-empty');
    if (!box) return;
    const hasPrimary = !!getGroupActiveId('primary');
    box.classList.toggle('hidden', hasPrimary);
    $('#viewer-pane')?.classList.toggle('no-file', !hasPrimary);
    $('#editor')?.classList.toggle('is-empty', !hasPrimary);
    if (!hasPrimary) renderEmptyState(box);
  }

  function renderEmptyState(box) {
    const p = activeProject();
    box.replaceChildren();
    const card = el('div', 've-card');
    card.append(
      el('div', 've-title', p ? p.name : 'Проект не выбран'),
      el('div', 've-sub', p ? 'Быстрый старт и горячие клавиши IDE-редактора:' : 'Выберите проект в главном окне LiteEditor.'),
    );
    if (p) {
      const acts = el('div', 've-actions');
      const addAct = (ic, label, kbdTxt, fn) => {
        const b = el('button', 've-act'); b.type = 'button';
        b.append(icon(ic, 15), el('span', 've-act-lbl', label), el('kbd', null, kbdTxt));
        b.onclick = fn;
        acts.appendChild(b);
      };
      addAct('search', 'Перейти к файлу или символу', 'Ctrl+P', () => overlays.openQuickOpen(''));
      addAct('wand', 'Палитра всех команд', 'Ctrl+Shift+P', () => overlays.openCommandPalette());
      addAct('search', 'Поиск и замена в проекте', 'Ctrl+Shift+F', () => openSideSection('search'));
      if (statusBranch) {
        addAct('check', 'Коммит изменённых файлов', 'Alt+2', () => openSideSection('commit'));
        addAct('git', 'История и граф коммитов', 'Alt+9', () => openLogPane('history'));
      }
      card.appendChild(acts);

      const recent = pool.recentFiles().filter((f) => pathInside(f, p.path)).slice(0, 7);
      if (recent.length) {
        card.appendChild(el('div', 've-head', 'Недавние файлы'));
        const list = el('div', 've-recent');
        for (const f of recent) {
          const r = el('button', 've-file'); r.type = 'button'; r.title = f;
          const rel = relTo(p.path, f);
          r.append(
            fileTypeSvg(f),
            el('span', 've-file-name', baseName(f)),
            el('span', 've-file-dir', dirName(rel) === rel ? '' : dirName(rel)),
          );
          r.onclick = () => openFileInViewer(f, null, { preview: false });
          list.appendChild(r);
        }
        card.appendChild(list);
      }
    }
    box.appendChild(card);
  }

  function toggleWordWrap() {
    settings.viewerWordWrap = !settings.viewerWordWrap;
    host.saveSettings();
    reconfigureLiveEditors();
  }

  function toggleWhitespace() {
    settings.viewerShowWhitespace = !settings.viewerShowWhitespace;
    host.saveSettings();
    reconfigureLiveEditors();
  }

  function toggleMinimap() {
    settings.minimap = !settings.minimap;
    host.saveSettings();
    reconfigureLiveEditors();
  }

  function toggleLigatures() {
    settings.viewerLigatures = settings.viewerLigatures === false;
    host.saveSettings();
    reconfigureLiveEditors();
  }

  function adjustEditorZoom(delta) {
    const cur = Number(settings.viewerFontSize || settings.fontSize) || 13;
    settings.viewerFontSize = delta === 0 ? (Number(settings.fontSize) || 13) : Math.max(10, Math.min(26, cur + delta));
    host.saveSettings();
    reconfigureLiveEditors();
    toast(`Размер шрифта кода: ${settings.viewerFontSize}px`, { ttl: 1200 });
  }

  function toggleZenMode() {
    document.body.classList.toggle('viewer-zen');
    if (editor) editor.requestMeasure();
  }

  function toggleKeymapPreset() {
    settings.viewerKeymap = settings.viewerKeymap === 'jetbrains' ? 'vscode' : 'jetbrains';
    host.saveSettings();
    reconfigureLiveEditors();
    toast(`Раскладка клавиш: ${settings.viewerKeymap === 'jetbrains' ? 'JetBrains (PhpStorm)' : 'VS Code'}`, { ttl: 2000 });
  }

  function showMoreMenu(x, y) {
    closeMenus();
    const buf = getActiveBuffer();
    const f = buf?.path || null;
    const kind = previewKindFor(f);
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '270px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    const add = (ic, label, fn, keys) => {
      const r = menuRow(ic, label, () => { closeMenus(); fn(); });
      if (keys) r.appendChild(el('span', 'menu-kbd', keys));
      dd.appendChild(r);
    };
    const sep = () => dd.appendChild(el('div', 'menu-sep'));

    add('wand', 'Палитра команд…', () => overlays.openCommandPalette(), 'Ctrl+Shift+P');
    if (f) {
      add('save', 'Сохранить файл', () => saveBufferNow(f, true), 'Ctrl+S');
      add('wand', 'Форматировать документ', () => formatActiveDocument(), settings.viewerKeymap === 'jetbrains' ? 'Ctrl+Alt+L' : 'Shift+Alt+F');
      add('split-right', 'Разделить редактор вправо', () => openInSplitRight(f), 'Ctrl+\\');
    }
    sep();
    add(settings.viewerWordWrap ? 'check' : 'square', 'Перенос длинных строк', toggleWordWrap, 'Alt+Z');
    add(settings.viewerShowWhitespace ? 'check' : 'square', 'Показывать пробелы и табы', toggleWhitespace);
    add(settings.minimap ? 'check' : 'square', 'Миникарта кода', toggleMinimap);
    add(settings.viewerLigatures !== false ? 'check' : 'square', 'Лигатуры шрифта (JetBrains Mono)', toggleLigatures);
    add(settings.trimTrailingOnSave ? 'check' : 'square', 'Удалять пробелы в конце строк при сохранении', () => {
      settings.trimTrailingOnSave = !settings.trimTrailingOnSave;
      host.saveSettings();
    });
    add('sliders', `Хоткеи: ${settings.viewerKeymap === 'jetbrains' ? 'JetBrains' : 'VS Code'} (переключить)`, toggleKeymapPreset);
    add(document.body.classList.contains('viewer-zen') ? 'check' : 'square', 'Режим «Только код» (Zen)', toggleZenMode, 'Esc');

    if (kind === 'html' && f) {
      sep();
      add('globe', 'Открыть HTML в браузере', () => lite.openInBrowser(f));
    }
    if (f && extOf(f) === 'sql') {
      sep();
      add('database', 'Выполнить SQL в модуле «Базы данных»…', async () => {
        const v = getActiveEditorView();
        if (v) lite.editorBus.openSqlInDb({ sql: v.state.doc.toString(), file: f });
      });
    }
    placeMenu(dd, x, y);
  }

  function getCommandList() {
    const isJb = settings.viewerKeymap === 'jetbrains';
    return [
      { category: 'Навигация', label: 'Перейти к файлу', keys: 'Ctrl+P', icon: 'search', run: () => overlays.openQuickOpen('') },
      { category: 'Навигация', label: 'Перейти к строке и столбцу', keys: 'Ctrl+G', icon: 'arrow-right', run: () => overlays.openGotoLine() },
      { category: 'Навигация', label: 'Перейти к символу в файле', keys: 'Ctrl+Shift+O', icon: 'braces', run: () => overlays.openSymbolOutlineOverlay() },
      { category: 'Навигация', label: 'Найти символ во всём проекте', keys: 'Ctrl+T', icon: 'braces', run: () => overlays.openProjectSymbolOverlay() },
      { category: 'Навигация', label: 'Перейти к определению (Go to Definition)', keys: 'F12', icon: 'locate', run: () => { const v = getActiveEditorView(), f = getActiveBufferFile(); if (v && f) goToDefinitionFromView(v, f); } },
      { category: 'Навигация', label: 'Найти использования (Find Usages)', keys: 'Shift+F12', icon: 'search', run: () => { const v = getActiveEditorView(), f = getActiveBufferFile(); if (v && f) findUsagesFromView(v, f); } },
      { category: 'Поиск', label: 'Поиск в проекте', keys: 'Ctrl+Shift+F', icon: 'search', run: () => openSideSection('search') },
      { category: 'Поиск', label: 'Замена в проекте', keys: 'Ctrl+Shift+R', icon: 'replace', run: () => { openSideSection('search'); sidePanels.openSearch({ replace: true }); } },
      { category: 'Поиск', label: 'Поиск в текущем файле', keys: 'Ctrl+F', icon: 'search', run: () => { const v = getActiveEditorView(); if (v) openSearchPanel(v); } },
      { category: 'Код', label: 'Форматировать документ', keys: isJb ? 'Ctrl+Alt+L' : 'Shift+Alt+F', icon: 'wand', run: formatActiveDocument },
      { category: 'Код', label: 'Переименовать символ в файле', keys: isJb ? 'Shift+F6' : 'F2', icon: 'edit', run: renameSymbolInActiveEditor },
      { category: 'Код', label: 'Выбрать подсветку синтаксиса…', icon: 'code', run: () => overlays.openLanguagePicker(getActiveBuffer()?.langOverride) },
      { category: 'Код', label: 'Переключить концы строк LF / CRLF', icon: 'code', run: toggleBufferEol },
      { category: 'Вид', label: 'Разделить редактор вправо (Split Right)', keys: 'Ctrl+\\', icon: 'split-right', run: () => openInSplitRight() },
      { category: 'Вид', label: 'Закрыть правую панель сплита', icon: 'x', run: closeSplitPane },
      { category: 'Вид', label: 'Перенос длинных строк (Word Wrap)', keys: 'Alt+Z', icon: 'wrap-text', run: toggleWordWrap },
      { category: 'Вид', label: 'Показать/скрыть пробелы и табы', icon: 'eye', run: toggleWhitespace },
      { category: 'Вид', label: 'Показать/скрыть миникарту кода', icon: 'map', run: toggleMinimap },
      { category: 'Вид', label: 'Увеличить шрифт редактора', keys: 'Ctrl+=', icon: 'plus', run: () => adjustEditorZoom(1) },
      { category: 'Вид', label: 'Уменьшить шрифт редактора', keys: 'Ctrl+-', icon: 'minus', run: () => adjustEditorZoom(-1) },
      { category: 'Вид', label: 'Сбросить масштаб шрифта', keys: 'Ctrl+0', icon: 'refresh', run: () => adjustEditorZoom(0) },
      { category: 'Вид', label: 'Режим «Только код» (Zen Mode)', icon: 'maximize', run: toggleZenMode },
      { category: 'Вид', label: 'Переключить раскладку хоткеев (VS Code / JetBrains)', icon: 'sliders', run: toggleKeymapPreset },
      { category: 'Вид', label: 'Расположение вкладок: сверху / слева', icon: 'columns', run: () => { settings.viewerTabsPos = isTopTabsMode() ? 'left' : 'top'; host.saveSettings(); renderAllTabBars(); } },
      { category: 'Панели', label: 'Файлы проекта', keys: 'Alt+1', icon: 'folder', run: () => openSideSection('files', true) },
      { category: 'Панели', label: 'Коммит (Git статус)', keys: 'Alt+2', icon: 'check', run: () => openSideSection('commit', true) },
      { category: 'Панели', label: 'Структура файла (Outline)', keys: 'Alt+4', icon: 'braces', run: () => openSideSection('outline', true) },
      { category: 'Панели', label: 'TODO и FIXME по проекту', keys: 'Alt+5', icon: 'flag', run: () => openSideSection('todos', true) },
      { category: 'Панели', label: 'Закладки проекта', keys: 'Alt+6', icon: 'bookmark', run: () => openSideSection('bookmarks', true) },
      { category: 'Навигация', label: 'Следующая закладка', keys: 'Alt+F2', icon: 'bookmark', run: () => stepBookmark(1) },
      { category: 'Навигация', label: 'Предыдущая закладка', keys: 'Shift+Alt+F2', icon: 'bookmark', run: () => stepBookmark(-1) },
      { category: 'Git', label: 'История коммитов, ветки и Stash', keys: 'Alt+9', icon: 'git', run: toggleLogPane },
      { category: 'Git', label: 'Изменения текущего файла (Git Diff)', icon: 'diff', run: toggleDiffForCurrentFile },
      { category: 'Git', label: 'Следующее изменение в файле', keys: 'F7', icon: 'arrow-down', run: () => { const v = getActiveEditorView(), f = getActiveBufferFile(); if (v && f) jumpGitHunkInView(v, f, 1); } },
      { category: 'Git', label: 'Предыдущее изменение в файле', keys: 'Shift+F7', icon: 'arrow-up', run: () => { const v = getActiveEditorView(), f = getActiveBufferFile(); if (v && f) jumpGitHunkInView(v, f, -1); } },
      { category: 'Git', label: 'Авторы строк (Git Blame)', icon: 'users', run: toggleBlame },
      { category: 'Git', label: 'История текущего файла в Git…', icon: 'history', run: () => overlays.showFileGitHistoryOverlay(getActiveBufferFile()) },
      { category: 'Файл', label: 'Локальная история версий файла…', icon: 'clock', run: () => overlays.showLocalHistoryModal(getActiveBufferFile()) },
      { category: 'Файл', label: 'Показать открытый файл в дереве', icon: 'locate', run: () => { const f = getActiveBufferFile(); if (f) revealInTree(f); } },
      { category: 'Файл', label: 'Переиндексировать символы проекта', icon: 'refresh', run: () => { const p = activeProject(); if (p) { fileListCache = null; symbolIndex.startIndex(p.path); toast('Индексация символов запущена'); } } },
    ];
  }

  // ================================================================ Ресайз панелей (левая колонка, нижняя Git, сплит редактора)
  function wireResizers() {
    // 1. Левая колонка (--mw-left)
    const mwGut = $('#mw-gutter');
    const savedLeft = host.STORE && host.STORE.mwLeft;
    if (savedLeft) $('#module-root')?.style.setProperty('--mw-left', Math.max(180, Math.min(560, savedLeft)) + 'px');

    mwGut?.addEventListener('dblclick', () => {
      $('#module-root')?.style.setProperty('--mw-left', '260px');
      if (host.persist) host.persist('mwLeft', 260);
    });
    mwGut?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const root = $('#module-root');
      const curW = parseInt(getComputedStyle(root).getPropertyValue('--mw-left'), 10) || 260;
      let lastW = curW;
      const onMove = (ev) => {
        lastW = Math.max(180, Math.min(620, curW + (ev.clientX - startX)));
        root.style.setProperty('--mw-left', lastW + 'px');
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (host.persist) host.persist('mwLeft', lastW);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // 2. Нижняя панель Git (--log-h)
    $('#log-resize')?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const root = $('#module-root');
      const curH = parseInt(getComputedStyle(root).getPropertyValue('--log-h'), 10) || LOG_H_DEFAULT;
      let lastH = curH;
      const onMove = (ev) => {
        lastH = Math.max(LOG_MIN, Math.min(LOG_MAX, curH - (ev.clientY - startY)));
        setLogHeight(lastH);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (host.persist) host.persist('mwLogH', lastH);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // 3. Разделитель правого сплита редактора
    const spGut = $('#editor-split-gutter');
    spGut?.addEventListener('dblclick', () => {
      splitRatio = 0.5;
      syncSplitVisibility();
      scheduleSaveWorkspace();
    });
    spGut?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const body = $('#viewer-body');
      const rect = body.getBoundingClientRect();
      const onMove = (ev) => {
        const rel = 1 - (ev.clientX - rect.left) / Math.max(200, rect.width);
        splitRatio = Math.max(0.2, Math.min(0.8, rel));
        body.style.setProperty('--code-split-ratio', `${Math.round(splitRatio * 100)}%`);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        scheduleSaveWorkspace();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // ================================================================ Смена активного проекта и восстановление воркспейса
  async function refreshViewerForActiveProject() {
    const p = activeProject();
    $('#tb-project-name').textContent = p ? p.name : '—';
    fileListCache = null;
    dirEntriesCache.clear();
    teardownActiveDiffDom();
    exitSplitPreview();
    closeInlineHunkPopover();

    if (!p) {
      pool.resetAll();
      expandedDirs.clear();
      clearPrimarySurface();
      renderTree(null);
      gitRender();
      return;
    }

    // Сбрасываем пул от предыдущего проекта и восстанавливаем воркспейс нового проекта
    pool.resetAll();
    expandedDirs.clear();
    const savedWs = viewerUi.workspaces && viewerUi.workspaces[p.path];
    if (savedWs) {
      for (const d of (savedWs.expandedDirs || [])) {
        if (pathInside(d, p.path)) expandedDirs.add(normSlash(d));
      }
      if (typeof savedWs.splitRatio === 'number') splitRatio = savedWs.splitRatio;
    }

    // Запускаем неблокирующий фоновый индекс символов проекта
    symbolIndex.startIndex(p.path);

    await renderTree(p);
    gitRender();

    // Восстанавливаем открытые вкладки проекта из персиста
    if (savedWs && Array.isArray(savedWs.tabs) && savedWs.tabs.length) {
      const validTabs = [];
      for (const abs of savedWs.tabs.slice(0, 15)) {
        const norm = normSlash(abs);
        if (!pathInside(norm, p.path)) continue;
        validTabs.push(norm);
      }
      for (const norm of validTabs) {
        await openFileInViewer(norm, savedWs.cursors?.[norm]?.line || null, { preview: false, focus: false });
        if ((savedWs.pinned || []).includes(norm)) pool.togglePin('primary', norm);
      }
      if (savedWs.active && pool.groupState('primary').tabs.includes(normSlash(savedWs.active))) {
        activateTabInGroup('primary', normSlash(savedWs.active));
      }
    } else {
      clearPrimarySurface();
    }
    renderAllTabBars();
    syncEmptyState();
  }

  let fsChangeTimer = null;
  let pendingChangedFiles = new Set();

  function onFsChange(proj, files = []) {
    const p = proj || activeProject();
    if (!p) return;
    for (const f of (files || [])) pendingChangedFiles.add(normSlash(f));
    clearTimeout(fsChangeTimer);
    fsChangeTimer = setTimeout(async () => {
      const changed = [...pendingChangedFiles];
      pendingChangedFiles.clear();
      fileListCache = null;

      // 1. Инкрементально инвалидируем кэш только затронутых папок дерева
      const dirsToInvalidate = new Set([trimTrail(p.path)]);
      for (const relOrAbs of changed) {
        const abs = relOrAbs.startsWith('/') ? relOrAbs : joinPath(p.path, relOrAbs);
        dirsToInvalidate.add(dirName(abs));
        // Если этот файл сейчас загружен в BufferPool — перечитываем его с диска!
        if (pool.hasBuffer(abs)) {
          await reloadBufferFromDisk(abs, false);
        }
      }

      // 2. Инкрементально обновляем индекс символов проекта
      const relList = changed.map((f) => relTo(p.path, f.startsWith('/') ? f : joinPath(p.path, f)));
      symbolIndex.onFilesChanged(p.path, relList);

      // 3. Обновляем дерево (с сохранением скролла) и открытые Git-панели
      await renderTree(p, { invalidateDirs: dirsToInvalidate });
      if (curSection === 'commit' || logOpen) gitRender();
    }, 180);
  }

  // ================================================================ Монтирование DOM и глобальных хоткеев
  function mount() {
    if (mounted) return;
    mounted = true;

    ensureMainEditor();

    sidePanels = createSidePanels({
      activeProject,
      openFile: (abs, line, opts) => openFileInViewer(abs, line, opts || { preview: true }),
      getCurrentFile: () => getActiveBufferFile(),
      getEditorText: () => {
        const v = getActiveEditorView();
        return v ? v.state.doc.toString() : '';
      },
      getBookmarks: () => bmList(),
      toggleBookmarkHere,
      saveBookmarks: () => {
        saveBookmarks();
        const b = getActiveBuffer();
        if (b) refreshBookmarksForBuffer(b);
      },
      onReplaced: () => {
        fileListCache = null;
        const p = activeProject();
        if (p) renderTree(p);
      },
    });
    sidePanels.mount({
      search: $('#side-search-pane'),
      outline: $('#side-outline-pane'),
      todos: $('#side-todos-pane'),
      bookmarks: $('#side-bookmarks-pane'),
    });

    overlays = createViewerOverlays({
      activeProject,
      getAllFiles: (root) => getAllProjectFiles(root),
      getRecentFiles: () => pool.recentFiles(),
      getOpenFiles: () => pool.groupState('primary').tabs.filter((id) => !isVirtualTabId(id)),
      getCurrentFile: () => getActiveBufferFile(),
      getCurrentSymbols: () => {
        const v = getActiveEditorView(), f = getActiveBufferFile();
        return (v && f) ? extractFileSymbols(v.state.doc.toString(), extOf(f)) : [];
      },
      symbolIndex,
      getCommands: getCommandList,
      openFile: (abs, line, opts) => openFileInViewer(abs, line, opts),
      gotoLineCol: (ln, col) => gotoLineColActive(ln, col),
      setLanguageOverride: setActiveLanguageOverride,
      showCommitDiff: (projPath, hash, rel, lbl) => showCommitDiff(projPath, hash, rel, lbl),
      cancelAutosaveFor,
      reloadCurrentIfMatch: (file) => reloadBufferFromDisk(file, true),
    });

    git = initGit({
      activeProject,
      getActiveId: host.getActiveId,
      renderProjects: () => { try { lite.editorBus.refreshProjects(); } catch (_) {} },
      refreshTree: () => { const p = activeProject(); if (p) renderTree(p); },
      createCodeEditor: host.createCodeEditor,
      STORE: host.STORE,
      persist: host.persist,
      settings,
      saveSettings: host.saveSettings,
      gitDiff: (projPath, file, label) => showGitDiff(projPath, file, label),
      commitDiff: (projPath, hash, file, label) => showCommitDiff(projPath, hash, file, label),
      showRawDiff: (label, diff) => showRawDiff(label, diff),
      showCommitPane: () => openSideSection('commit', false),
      openLogTab: (sub) => openLogPane(sub),
      fileIcon: (name) => fileTypeSvg(name),
      folderIcon: (open = false) => folderTypeSvg(open),
      openFile: (abs, line) => openFileInViewer(abs, line, { preview: false }),
      menuRow, placeMenu, closeMenus,
      onInfo: (info) => {
        statusBranch = info && info.repo ? info.branch : null;
        updateGitStatusBar();
        if (info && info.repo) refreshGitMarks();
        syncEmptyState();
      },
    });
    git.setContainers({ topbar: $('#vcs-git'), commit: $('#commit-body'), branchlog: $('#branchlog-body') });

    // Полоса инструментов слева (клик по уже активной секции сворачивает/разворачивает боковую панель)
    document.querySelectorAll('.vcs-strip .strip-btn[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => openSideSection(btn.dataset.section, true));
    });
    $('#viewer-find')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSideSection('search', false);
      sidePanels.openSearch({ replace: true });
    });
    $('#viewer-agent')?.addEventListener('click', toggleAgentMode);

    // Верхний тулбар
    $('#tb-project')?.addEventListener('click', () => openSideSection('files', true));
    $('#tb-search')?.addEventListener('click', () => overlays.openQuickOpen(''));
    $('#tb-palette')?.addEventListener('click', () => overlays.openCommandPalette());
    $('#log-close')?.addEventListener('click', closeLogPane);

    // Полосы вкладок и сплита
    const tabsListEl = $('#editor-tabs-list');
    tabsListEl?.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        tabsListEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    $('#editor-tabs-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showAllOpenTabsMenu(Math.max(8, r.right - 240), r.bottom + 4);
    });
    $('#viewer-split-right')?.addEventListener('click', () => openInSplitRight());
    $('#editor-tabs-close')?.addEventListener('click', () => {
      const st = pool.groupState('primary');
      for (const id of [...st.tabs]) if (!st.pinned.has(id)) requestCloseTab('primary', id);
    });
    $('#tabs-close-all')?.addEventListener('click', () => {
      const st = pool.groupState('primary');
      for (const id of [...st.tabs]) if (!st.pinned.has(id)) requestCloseTab('primary', id);
    });
    $('#split-close-pane')?.addEventListener('click', closeSplitPane);

    // Кнопки шапки редактора
    $('#viewer-back')?.addEventListener('click', navBack);
    $('#viewer-fwd')?.addEventListener('click', navFwd);
    $('#viewer-wrap')?.addEventListener('click', toggleWordWrap);
    $('#viewer-diff')?.addEventListener('click', toggleDiffForCurrentFile);
    $('#viewer-blame')?.addEventListener('click', toggleBlame);
    $('#viewer-hist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const f = getActiveBufferFile();
      if (!f) { toast('Нет открытого файла'); return; }
      closeMenus();
      const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '230px';
      dd.appendChild(menuRow('clock', 'Локальная история версий…', () => { closeMenus(); overlays.showLocalHistoryModal(f); }));
      dd.appendChild(menuRow('git', 'История коммитов файла в Git…', () => { closeMenus(); overlays.showFileGitHistoryOverlay(f); }));
      const r = e.currentTarget.getBoundingClientRect();
      placeMenu(dd, Math.max(8, r.right - 230), r.bottom + 4);
    });
    $('#viewer-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showMoreMenu(Math.max(8, r.right - 270), r.bottom + 4);
    });
    $('#viewer-original')?.addEventListener('click', () => setViewMode('original'));
    $('#viewer-split')?.addEventListener('click', () => setViewMode('split'));
    $('#viewer-preview')?.addEventListener('click', () => setViewMode('preview'));

    // Плашка конфликта на диске
    $('#viewer-reload-apply')?.addEventListener('click', () => {
      const f = getActiveBufferFile();
      if (f) reloadBufferFromDisk(f, true);
    });
    $('#viewer-reload-diff')?.addEventListener('click', async () => {
      const buf = getActiveBuffer();
      if (!buf) return;
      const disk = await lite.fs.readFile(buf.path);
      if (!disk || disk.error) return;
      const vBuf = pool.ensureBuffer(`cmp:disk:${buf.path}`, {
        kind: 'cmp',
        title: `Конфликт: ${buf.title} (Диск ↔ Мои правки)`,
        path: buf.path,
        meta: {
          editableRight: false,
          unified: '',
          pair: { oldText: normEolText(disk.content || ''), newText: buf.state ? buf.state.doc.toString() : '' },
          filePath: buf.path,
          leftLabel: 'На диске (внешняя правка)',
          rightLabel: 'В памяти редактора',
        },
      });
      pool.openTabInGroup('primary', vBuf.id, { preview: true });
      activateTabInGroup('primary', vBuf.id);
    });
    $('#viewer-reload-dismiss')?.addEventListener('click', hideReloadBar);

    // Дерево файлов и фильтр дерева
    $('#tree-new')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = activeProject();
      if (p) showTreeContextMenu(e.clientX, e.clientY, { name: p.name, path: normSlash(p.path), dir: true, root: true });
    });
    $('#tree-locate')?.addEventListener('click', () => {
      const f = getActiveBufferFile();
      if (f) revealInTree(f); else toast('Нет открытого файла');
    });
    $('#tree-collapse')?.addEventListener('click', () => {
      expandedDirs.clear();
      const p = activeProject();
      if (p) renderTree(p, { preserveCache: true });
    });
    $('#tree-refresh')?.addEventListener('click', () => {
      fileListCache = null;
      const p = activeProject();
      if (p) renderTree(p);
    });
    $('#tree-opts')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showTreeOptionsMenu(Math.max(8, r.right - 240), r.bottom + 4);
    });

    const tfInp = $('#tree-filter');
    const tfClr = $('#tree-filter-clear');
    tfInp?.addEventListener('input', () => {
      treeFilter = tfInp.value;
      tfClr?.classList.toggle('hidden', !treeFilter);
      const p = activeProject();
      if (p) renderTree(p, { preserveCache: true });
    });
    tfInp?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && treeFilter) {
        e.preventDefault();
        treeFilter = '';
        tfInp.value = '';
        tfClr?.classList.add('hidden');
        const p = activeProject();
        if (p) renderTree(p, { preserveCache: true });
      }
    });
    tfClr?.addEventListener('click', () => {
      treeFilter = '';
      if (tfInp) tfInp.value = '';
      tfClr.classList.add('hidden');
      const p = activeProject();
      if (p) renderTree(p, { preserveCache: true });
    });

    $('#tree')?.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return;
      e.preventDefault();
      const p = activeProject();
      if (p) showTreeContextMenu(e.clientX, e.clientY, { name: p.name, path: normSlash(p.path), dir: true, root: true });
    });
    $('#tree')?.addEventListener('dragover', (e) => {
      if (!activeProject()) return;
      e.preventDefault(); e.stopPropagation();
      setDropHL(null);
      $('#tree')?.classList.add('drag-over-root');
    });
    $('#tree')?.addEventListener('drop', (e) => {
      const p = activeProject();
      if (!p) return;
      e.preventDefault(); e.stopPropagation();
      handleTreeDrop(e, normSlash(p.path));
    });
    window.addEventListener('drop', clearDropHL);

    wireTreeKeyboard();
    wireResizers();

    // Интерактивный статус-бар
    $('#st-branch')?.addEventListener('click', toggleLogPane);
    $('#st-changes')?.addEventListener('click', () => openSideSection('commit', false));
    $('#vs-diag')?.addEventListener('click', () => {
      if (currentDiagError) gotoLineColActive(currentDiagError.line, currentDiagError.col || 1);
    });
    $('#vs-pos')?.addEventListener('click', () => overlays.openGotoLine());
    $('#st-indent')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showIndentMenu(Math.max(8, r.right - 240), Math.max(8, r.top - 220));
    });
    $('#st-eol')?.addEventListener('click', toggleBufferEol);
    $('#vs-lang')?.addEventListener('click', () => overlays.openLanguagePicker(getActiveBuffer()?.langOverride));
    $('#st-keymap')?.addEventListener('click', toggleKeymapPreset);

    updateWrapButton();
    updateKeymapStatus();

    // Глобальные горячие клавиши окна «Проект» (используем e.code для независимости от русской раскладки!)
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        if (hunkPopEl) { e.preventDefault(); closeInlineHunkPopover(); return; }
        if (document.body.classList.contains('viewer-zen')) { e.preventDefault(); toggleZenMode(); return; }
      }

      // Ctrl+P / Ctrl+Shift+P — Quick Open / Палитра команд
      if (mod && !e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        if (e.shiftKey) overlays.openCommandPalette();
        else overlays.openQuickOpen('');
        return;
      }
      // Ctrl+G — Перейти к строке:столбцу
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault();
        overlays.openGotoLine();
        return;
      }
      // Ctrl+Shift+O — Символы файла; Ctrl+T — Символы проекта
      if (mod && e.shiftKey && !e.altKey && e.code === 'KeyO') {
        e.preventDefault();
        overlays.openSymbolOutlineOverlay();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        overlays.openProjectSymbolOverlay();
        return;
      }
      // Ctrl+Shift+F / Ctrl+Shift+R — Боковая панель поиска и замены по проекту
      if (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        const v = getActiveEditorView();
        const sel = v && !v.state.selection.main.empty ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : '';
        openSideSection('search', false);
        if (sel && !sel.includes('\n')) sidePanels.openSearch({ query: sel });
        return;
      }
      if (mod && e.shiftKey && !e.altKey && e.code === 'KeyR') {
        e.preventDefault();
        openSideSection('search', false);
        sidePanels.openSearch({ replace: true });
        return;
      }
      // F4 / Shift+F4 — следующий/предыдущий результат поиска по проекту; из диффа — открыть файл
      if (!mod && !e.altKey && e.key === 'F4') {
        if (curSection === 'search' && sidePanels.stepSearchResult(e.shiftKey ? -1 : 1)) {
          e.preventDefault();
          return;
        }
        const actId = getGroupActiveId('primary');
        if (actId && isVirtualTabId(actId)) {
          const vb = pool.getBuffer(actId);
          if (vb?.meta?.filePath) {
            e.preventDefault();
            openFileInViewer(vb.meta.filePath, 1, { preview: false });
            return;
          }
        }
      }
      // Ctrl+W — закрыть активную вкладку (в раскладке VS Code; в JetBrains Ctrl+W расширяет выделение)
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyW' && settings.viewerKeymap !== 'jetbrains') {
        const cur = getGroupActiveId(activeGroup);
        if (cur) { e.preventDefault(); requestCloseTab(activeGroup, cur); return; }
      }
      // Ctrl+Tab / Ctrl+Shift+Tab — переключение вкладок по MRU
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        stepMruTab(e.shiftKey ? -1 : 1);
        return;
      }
      // Ctrl+\ — Разделить редактор вправо
      if (mod && !e.altKey && e.code === 'Backslash') {
        e.preventDefault();
        openInSplitRight();
        return;
      }
      // Alt+Z — Перенос длинных строк
      if (e.altKey && !mod && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        toggleWordWrap();
        return;
      }
      // Ctrl+= / Ctrl+- / Ctrl+0 — Зум шрифта редактора
      if (mod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault(); adjustEditorZoom(1); return;
      }
      if (mod && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault(); adjustEditorZoom(-1); return;
      }
      if (mod && !e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault(); adjustEditorZoom(0); return;
      }
      // Alt+1..6, Alt+9 — Быстрое переключение инструментальных окон (как в PhpStorm!)
      if (e.altKey && !mod && !e.shiftKey) {
        if (e.code === 'Digit1') { e.preventDefault(); openSideSection('files', true); return; }
        if (e.code === 'Digit2') { e.preventDefault(); openSideSection('commit', true); return; }
        if (e.code === 'Digit3') { e.preventDefault(); openSideSection('search', true); return; }
        if (e.code === 'Digit4') { e.preventDefault(); openSideSection('outline', true); return; }
        if (e.code === 'Digit5') { e.preventDefault(); openSideSection('todos', true); return; }
        if (e.code === 'Digit6') { e.preventDefault(); openSideSection('bookmarks', true); return; }
        if (e.code === 'Digit9') { e.preventDefault(); toggleLogPane(); return; }
        if (e.code === 'ArrowLeft') { e.preventDefault(); navBack(); return; }
        if (e.code === 'ArrowRight') { e.preventDefault(); navFwd(); return; }
      }
      // Закладки: Ctrl+F2 поставить, Alt+F2 / Shift+Alt+F2 навигация по закладкам
      if (mod && e.code === 'F2') {
        e.preventDefault();
        toggleBookmarkHere();
        return;
      }
      if (!mod && e.altKey && e.code === 'F2') {
        e.preventDefault();
        stepBookmark(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && !e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        const f = getActiveBufferFile();
        if (f) saveBufferNow(f, true);
      }
    });

    window.addEventListener('beforeunload', () => {
      saveViewerUiNow();
    });
  }

  function setViewerOpen(open) {
    viewerOpen = !!open;
    $('#viewer-pane')?.classList.toggle('hidden', !viewerOpen);
    if (viewerOpen) {
      openSideSection(curSection || 'files', false);
      refreshViewerForActiveProject();
    }
  }

  function setOpen(open) {
    if (!open) {
      if (host.closeWindow) host.closeWindow();
      else setViewerOpen(false);
      return;
    }
    if (!mounted) mount();
    if (viewerOpen) {
      saveViewerUiNow();
      flushAllDirtyBuffers().then(() => refreshViewerForActiveProject());
      return;
    }
    setViewerOpen(true);
  }

  // Внешний контракт модуля окна «Проект» (100% обратная совместимость с module-entry.js и главным окном)
  return {
    setOpen,
    openFile: (abs, line) => openFileInViewer(abs, line, { preview: false }),
    renderTree: (p) => renderTree(p),
    onFsChange,
    applyFontSize: () => reconfigureLiveEditors(),
    confirmClose: async (proceed) => {
      saveViewerUiNow();
      await flushAllDirtyBuffers();
      const conflicted = pool.allBuffers().filter((b) => b.kind === 'file' && b.dirty && b.conflictOnDisk);
      if (conflicted.length) {
        showConfirm(
          'Закрыть окно «Проект»?',
          `Несохранённые правки с конфликтом на диске: ${conflicted.map((b) => b.title).join(', ')}.`,
          'Закрыть без сохранения',
          proceed,
        );
      } else {
        proceed();
      }
    },
    quitCheck: async () => {
      try { if (git && git.flushDraft) git.flushDraft(); } catch (_) {}
      saveViewerUiNow();
      await flushAllDirtyBuffers();
      return pool.allBuffers()
        .filter((b) => b.kind === 'file' && b.dirty)
        .map((b) => b.title);
    },
    focusGit: () => {
      if (!viewerOpen) setViewerOpen(true);
      openSideSection('commit', false);
    },
  };
}
