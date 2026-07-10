// Files module (v1.1+): code viewer (CodeMirror) + file tree.
// Изначально вивер+дерево жили прямо в ядре (renderer.js). Вынесены сюда как модуль `initFiles(host)`,
// чтобы (как остальные модули) уехать в отдельное окно. Вивер и дерево делят ИЗМЕНЯЕМОЕ состояние
// (currentFile/gitFiles/expandedDirs/dirty), поэтому живут вместе в одном модуле.
//
// Шаг 1 (embedded-first): редактор зовёт initFiles(host) и mount() — вивер работает как раньше,
// встроенно в #viewer-pane/#tree-pane index.html. Связь с ядром — только через host-колбэки
// (right-slot-машинерия: growBy/closeOtherPanels/renderProjects/saveUiState/refitActiveTerminal/меню).
// Шаг 2 — флип в окно: те же #viewer-pane/#tree-pane переедут в module.html, host станет window-host.
import { el, svgEl, icon, toast, showConfirm, showPrompt, baseName } from '../ui.js';
import { languageFor } from '../codeedit.js';
import { initGit } from './git.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, gutter, GutterMarker, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, RangeSet } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, toggleComment, toggleBlockComment } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, codeFolding, foldKeymap, foldService } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { showMinimap } from '@replit/codemirror-minimap';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { marked } from 'marked';

const lite = window.lite;
const $ = (sel) => document.querySelector(sel);

export function initFiles(host) {
  // host: { activeProject, layout, GUTTER, settings, saveSettings, growBy, closeOtherPanels,
  //         renderProjects, saveUiState, refitActiveTerminal, menuRow, placeMenu, closeMenus }
  const { menuRow, placeMenu, closeMenus } = host;
  const activeProject = () => host.activeProject();
  const settings = host.settings;

  // ---- state (вивер + дерево делят его)
  let gitFiles = {};                 // active project: abs path -> git short status code
  const expandedDirs = new Set();    // tree dir paths currently expanded (survives live refresh)
  let viewerOpen = false;
  let currentFile = null;
  let dirty = false;
  let diffMode = false;              // viewer showing a git diff instead of the file
  let previewMode = false;           // viewer showing a rendered preview (md/image/html) instead of source
  let editor = null;
  let loadingDoc = false;
  let autosaveTimer = null;          // debounce автосохранения (PhpStorm-style, через AUTOSAVE_MS после ввода)
  const AUTOSAVE_MS = 400;
  const langComp = new Compartment();
  let openSeq = 0;                   // монотонный токен открытия — против гонки при быстром переключении файлов
  let dragSrcPath = null;            // путь перетаскиваемого узла (внутренний drag дерево→дерево)
  // ---- навигация/поиск/закладки вивера (этапы «привычного»)
  let navStack = [];                 // история открытых файлов (как назад/вперёд в IDE)
  let navIdx = -1;                   // позиция в navStack
  let navJumping = false;            // открытие вызвано back/fwd → не пушим новую запись
  const recentFiles = [];            // недавние файлы (LRU) — показываются в Ctrl+P при пустом запросе
  let fileListCache = null;          // { projPath, files[] } — кэш рекурсивного листинга для Ctrl+P
  let cmpFirst = null;               // первый файл для «Сравнить два файла»
  let openTabs = [];                 // открытые файлы — вертикальная колонка табов между деревом и вивером
  const pinnedTabs = new Set();      // закреплённые табы (рендерятся первыми, не закрываются «другие/справа/все»)
  const bookmarks = (host.STORE && host.STORE.bookmarks) || {}; // projId -> [{file, line}] (персист)
  // ---- встроенный Git (вместо отдельного окна): стрип-секции + дифф в центре вивера
  let git = null;                    // git-компонент (initGit), монтируется в mount()
  let curSection = 'files';          // активная секция левой колонки: 'files' | 'commit'
  let logOpen = false;               // нижняя панель «Ветки · История» (#log-pane) открыта
  let agentMode = false;             // C-режим агента: ревью правок (C18) + слой авторства (C21) + «спросить агента» (C20)
  let dropHLRow = null;              // подсвеченная папка-приёмник
  let fsTimer = null;
  let mounted = false;               // mount() идемпотентен (окно строит редактор один раз)

  // ---------------------------------------------------------------- viewer (CodeMirror)
  // Миникарта (VSCode-стиль): уменьшенная копия кода справа с индикатором области и кликом-прыжком.
  const minimapExt = showMinimap.compute(['doc'], () => ({
    create: () => ({ dom: document.createElement('div') }),
    displayText: 'blocks',     // быстрый блочный рендер вместо посимвольного
    showOverlay: 'always',     // всегда показывать рамку текущей области
  }));
  const minimapComp = new Compartment(); // вкл/выкл миникарты без пересоздания редактора
  // Аддон @replit/codemirror-minimap считает ширину гаттера и рисует канвас ТОЛЬКО в render(), а render()
  // вызывается лишь по docChanged/selectionSet/смене темы/folds (см. shouldUpdate). При включении минимапа
  // через reconfigure компартмента ни одно из этих условий не выполняется → render не запускается, гаттер
  // остаётся width:0 и канвас не нарисован (особенно если на старте clientWidth редактора был 0). Форсим
  // render безопасным no-op диспатчем текущего выделения (selectionSet=true). rAF — чтобы раскладка успела.
  function kickMinimap() {
    if (!editor) return;
    requestAnimationFrame(() => { try { editor.dispatch({ selection: editor.state.selection }); } catch (_) {} });
  }
  // B16: Zen-режим — скрыть всё кроме кода (дерево/табы/стрип/git/лог); Esc или повтор кнопки — выход.
  function toggleZen() {
    const on = document.body.classList.toggle('viewer-zen');
    $('#viewer-zen').classList.toggle('on', on);
    setTimeout(() => { try { editor && editor.requestMeasure(); } catch (_) {} if (settings.minimap) kickMinimap(); }, 60);
  }
  function exitZen() { if (document.body.classList.contains('viewer-zen')) toggleZen(); }
  function toggleMinimap() {
    settings.minimap = !settings.minimap;
    host.saveSettings();
    if (editor) {
      editor.dispatch({ effects: minimapComp.reconfigure(settings.minimap ? minimapExt : []) });
      if (settings.minimap) kickMinimap();   // включили → форсим первый render (иначе гаттер width:0)
    }
    $('#viewer-minimap').classList.toggle('on', settings.minimap);
  }
  // A10: сворачивание парных маркеров #region/#endregion (поверх стандартного codeFolding по скобкам).
  // foldService спрашивается на старте каждой строки; начало региона → ищем парный конец с учётом вложенности.
  const REGION_START = /^\s*(?:(?:\/\/|\/\*|<!--|--|;|%)\s*)?#\s?region\b/i;
  const REGION_END = /^\s*(?:(?:\/\/|\/\*|<!--|--|;|%)\s*)?#\s?end\s?region\b/i;
  const regionFoldService = foldService.of((state, lineStart, lineEnd) => {
    const startLine = state.doc.lineAt(lineStart);
    if (!REGION_START.test(startLine.text)) return null;
    let depth = 1;
    for (let n = startLine.number + 1; n <= state.doc.lines; n++) {
      const t = state.doc.line(n).text;
      if (REGION_START.test(t)) depth++;
      else if (REGION_END.test(t)) { depth--; if (depth === 0) return { from: lineEnd, to: state.doc.line(n).to }; }
    }
    return null;
  });
  // B11: инлайн-превью цвета — квадрат-свотч перед hex/rgb/hsl; клик открывает нативный пикер и заменяет значение.
  const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\brgba?\([^)]{1,60}?\)|\bhsla?\([^)]{1,60}?\)/g;
  function colorToHex(color) {
    try { const d = document.createElement('div'); d.style.color = color; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove();
      const m = c.match(/\d+/g); if (!m) return null; return '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join(''); } catch (_) { return null; }
  }
  class ColorSwatch extends WidgetType {
    constructor(color, from, to) { super(); this.color = color; this.from = from; this.to = to; }
    eq(o) { return o.color === this.color && o.from === this.from && o.to === this.to; }
    toDOM(view) {
      const s = document.createElement('span'); s.className = 'cm-color-swatch'; s.style.background = this.color;
      s.title = this.color + ' — клик, чтобы изменить';
      s.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const inp = document.createElement('input'); inp.type = 'color'; inp.value = colorToHex(this.color) || '#000000';
        inp.style.position = 'fixed'; inp.style.left = '-9999px'; document.body.appendChild(inp);
        inp.addEventListener('change', () => { try { view.dispatch({ changes: { from: this.from, to: this.to, insert: inp.value } }); } catch (_) {} inp.remove(); });
        inp.click();
      });
      return s;
    }
    ignoreEvent() { return false; }
  }
  const colorPreview = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
    build(view) {
      const widgets = [];
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to); let m; COLOR_RE.lastIndex = 0;
        while ((m = COLOR_RE.exec(text))) {
          const col = m[0]; if (!(window.CSS && CSS.supports && CSS.supports('color', col))) continue;
          const start = from + m.index;
          widgets.push(Decoration.widget({ widget: new ColorSwatch(col, start, start + col.length), side: -1 }).range(start));
        }
      }
      widgets.sort((a, b) => a.from - b.from);
      return Decoration.set(widgets);
    }
  }, { decorations: (v) => v.decorations });

  // B12: подсветка TODO/FIXME/HACK/XXX/BUG/NOTE в коде (+ сбор по проекту — showTodos()).
  const TODO_RE = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\b/g;
  const todoMarkCache = {};
  function todoMark(kind) { return (todoMarkCache[kind] = todoMarkCache[kind] || Decoration.mark({ class: 'cm-todo cm-todo-' + kind.toLowerCase() })); }
  const todoHighlight = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
    build(view) {
      const marks = [];
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to); let m; TODO_RE.lastIndex = 0;
        while ((m = TODO_RE.exec(text))) { const s = from + m.index; marks.push(todoMark(m[1]).range(s, s + m[1].length)); }
      }
      marks.sort((a, b) => a.from - b.from);
      return Decoration.set(marks);
    }
  }, { decorations: (v) => v.decorations });

  // C21: слой авторства — гаттер, где строки, тронутые агентом (правки с диска при live-reload) и тобой
  // (правки в редакторе) помечены разными красками + таймстампом по ховеру. Включается режимом агента.
  const authComp = new Compartment();
  const setAuthorEffect = StateEffect.define();   // { marks:[{line,who,time}] } — добавить/перекрыть пометки строк
  class AuthorMarker extends GutterMarker {
    constructor(who, time) { super(); this.who = who; this.time = time; }
    eq(o) { return o.who === this.who && o.time === this.time; }
    toDOM() { const d = document.createElement('div'); d.className = 'cm-auth-mark auth-' + this.who; d.title = (this.who === 'agent' ? 'Агент' : 'Вы') + ' · ' + new Date(this.time).toLocaleTimeString(); return d; }
  }
  const authorField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setAuthorEffect)) continue;
        const doc = tr.state.doc;
        const byPos = new Map();
        const it = set.iter(); while (it.value) { byPos.set(it.from, it.value); it.next(); }   // существующие
        for (const m of e.value.marks) if (m.line >= 1 && m.line <= doc.lines) byPos.set(doc.line(m.line).from, new AuthorMarker(m.who, m.time)); // новые перекрывают
        set = RangeSet.of([...byPos.entries()].sort((a, b) => a[0] - b[0]).map(([from, mk]) => mk.range(from)), true);
      }
      return set;
    },
  });
  const authorGutter = gutter({ class: 'cm-auth-gutter', markers: (v) => v.state.field(authorField, false) || RangeSet.empty });
  function markAuthor(lines, who) {
    if (!agentMode || !editor || !lines.length) return;
    const t = Date.now();
    editor.dispatch({ effects: setAuthorEffect.of({ marks: lines.map((l) => ({ line: l, who, time: t })) }) });
  }
  function updateAuthorshipGutter() {
    if (!editor) return;
    editor.dispatch({ effects: authComp.reconfigure(agentMode ? [authorField, authorGutter] : []) });
  }
  // diff концов: общий префикс/суффикс строк → изменённый блок в НОВОМ тексте (для пометки правок агента).
  function diffChangedLines(oldText, newText) {
    const a = oldText.split('\n'), b = newText.split('\n');
    let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length - 1, eb = b.length - 1;
    while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
    const lines = []; for (let i = s; i <= eb; i++) lines.push(i + 1);
    return lines;
  }

  function makeEditor() {
    const state = EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(), bmGutterField, bmGutterExt, gitGutterField, gitGutterExt, highlightActiveLine(), highlightActiveLineGutter(),
        codeFolding(), foldGutter(), regionFoldService, indentationMarkers({ hideFirstIndent: true, highlightActiveBlock: false }),
        drawSelection(), history(),
        // мульти-курсоры + колоночное (Alt+клик добавляет курсор, Alt+drag — прямоугольное выделение)
        EditorState.allowMultipleSelections.of(true), rectangularSelection(), crosshairCursor(),
        indentOnInput(), bracketMatching(), highlightSelectionMatches(), search({ top: true }),
        colorPreview, todoHighlight,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
        minimapComp.of(settings.minimap ? minimapExt : []),
        authComp.of([]),
        langComp.of([]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { saveCurrent(); return true; } },
          // операции со строками + комментарии (явные биндинги — устойчивы к раскладке и порядку keymap'ов)
          { key: 'Mod-d', run: copyLineDown },                       // дублировать строку/выделение вниз (VS Code-style)
          { key: 'Mod-/', run: toggleComment },                     // переключить строчный комментарий
          { key: 'Shift-Alt-a', run: toggleBlockComment },          // блочный комментарий
          { key: 'Alt-ArrowUp', run: moveLineUp }, { key: 'Alt-ArrowDown', run: moveLineDown },
          { key: 'Shift-Alt-ArrowUp', run: copyLineUp }, { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
          { key: 'Mod-Shift-k', run: deleteLine },
          indentWithTab, ...foldKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !loadingDoc) { markDirty(true); scheduleAutosave(); }
          if (u.docChanged && !loadingDoc && agentMode) {   // C21: пометить твои правки в гаттере авторства
            const ls = new Set();
            u.changes.iterChangedRanges((fA, tA, fB, tB) => { const a = u.state.doc.lineAt(fB).number, b = u.state.doc.lineAt(tB).number; for (let n = a; n <= b; n++) ls.add(n); });
            if (ls.size) queueMicrotask(() => markAuthor([...ls], 'you'));
          }
          if (u.docChanged) { symCacheFile = null; remapBookmarks(u); }
          if (u.docChanged || u.selectionSet) { updateStatus(u.state); updateBreadcrumb(u.state); updateSticky(); }
          if (u.docChanged && splitMode) { clearTimeout(splitTimer); splitTimer = setTimeout(refreshSplitPreview, 300); } // B15: живой рендер сплита

        }),
      ],
    });
    editor = new EditorView({ state, parent: $('#editor') });
    editor.scrollDOM.addEventListener('scroll', updateSticky);   // A6: пересчитывать sticky-заголовок на скролле
    if (settings.minimap) kickMinimap();   // минимап включён на старте → форсим первый render после раскладки
  }
  // Метки языка для статус-строки (по расширению; '' → «Текст»).
  const LANG_LABEL = {
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
    py: 'Python', json: 'JSON', md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML',
    css: 'CSS', scss: 'SCSS', sql: 'SQL', sh: 'Shell', yml: 'YAML', yaml: 'YAML',
  };
  // --- A7: git blame (тогл) — автор/дата/коммит текущей строки в статус-баре ---
  let blameOn = false, blameData = null;
  function fmtAgo(ts) {
    if (!ts) return '';
    const d = Math.floor(Date.now() / 1000) - ts;
    if (d < 60) return 'только что';
    const mn = Math.floor(d / 60); if (mn < 60) return mn + ' мин назад';
    const hr = Math.floor(mn / 60); if (hr < 24) return hr + ' ч назад';
    const dy = Math.floor(hr / 24); if (dy < 30) return dy + ' дн назад';
    const mo = Math.floor(dy / 30); if (mo < 12) return mo + ' мес назад';
    return Math.floor(mo / 12) + ' г назад';
  }
  async function loadBlame() {
    if (!currentFile) { blameData = null; return; }
    const p = activeProject(); if (!p) { blameData = null; return; }
    const f = currentFile;
    const r = await lite.git.blame(p.path, f);
    if (f !== currentFile) return;                       // переключили файл за время await
    blameData = (r && r.ok) ? r.lines : null;
    if (r && r.error) { blameData = null; toast(r.error, { kind: 'err', ttl: 5000 }); }
  }
  async function toggleBlame() {
    blameOn = !blameOn;
    $('#viewer-blame').classList.toggle('on', blameOn);
    if (blameOn) await loadBlame(); else blameData = null;
    if (editor) updateStatus(editor.state);
  }
  function refreshBlameIfOn() { if (blameOn) loadBlame().then(() => { if (editor) updateStatus(editor.state); }); }
  // Нижняя статус-строка вивера: позиция курсора (строка:колонка), число строк, выделение, blame, язык.
  function updateStatus(state) {
    const bar = $('#viewer-status'); if (!bar) return;
    if (!currentFile || previewMode || diffMode) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    const col = sel.head - line.from + 1;
    const selLen = sel.to - sel.from;
    const posEl = $('#vs-pos'), selEl = $('#vs-sel'), langEl = $('#vs-lang'), blameEl = $('#vs-blame');
    if (posEl) posEl.textContent = `Стр ${line.number}, кол ${col}`;
    if (selEl) selEl.textContent = selLen ? `(выбрано ${selLen})` : '';
    if (langEl) langEl.textContent = (LANG_LABEL[extOf(currentFile)] || 'Текст') + ' · ' + state.doc.lines + ' стр';
    if (blameEl) {
      const b = (blameOn && blameData) ? blameData[line.number - 1] : null;
      blameEl.textContent = !b ? '' : (b.uncommitted ? '● не закоммичено' : `● ${b.author || '?'} · ${fmtAgo(b.time)} · ${(b.summary || '').slice(0, 42)}`);
      blameEl.title = b && !b.uncommitted ? (b.hash + ' · ' + (b.summary || '')) : '';
    }
  }
  // ---- git-маркеры в гаттере вивера: цветная полоса слева для строк, изменённых относительно HEAD.
  // Данные берём из `git diff HEAD -- file` (тот же источник, что diff-режим), парсим ханки в пер-строчные метки.
  const setGitGutterEffect = StateEffect.define(); // value: [{ line, type }] — line 1-based, type: added|modified|deleted
  class GitGutterMarker extends GutterMarker {
    constructor(type) { super(); this.type = type; }
    eq(o) { return o.type === this.type; }
    toDOM() { const d = document.createElement('div'); d.className = 'cm-git-mark git-' + this.type; return d; }
  }
  const gitGutterField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setGitGutterEffect)) continue;
        const doc = tr.state.doc, ranges = [];
        for (const m of e.value) {
          if (m.line >= 1 && m.line <= doc.lines) ranges.push(new GitGutterMarker(m.type).range(doc.line(m.line).from));
        }
        ranges.sort((a, b) => a.from - b.from);
        set = RangeSet.of(ranges, true);
      }
      return set;
    },
  });
  const gitGutterExt = gutter({
    class: 'cm-git-gutter',
    markers: (view) => view.state.field(gitGutterField),
  });
  // ---- гаттер закладок: звёздочка слева на отмеченных строках (клик по звезде — снять закладку).
  const setBookmarkGutterEffect = StateEffect.define(); // value: [lineNumbers] (1-based)
  class BookmarkMarker extends GutterMarker {
    toDOM() { const d = document.createElement('div'); d.className = 'cm-bm-mark'; d.textContent = '★'; return d; }
  }
  const bmGutterField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setBookmarkGutterEffect)) continue;
        const doc = tr.state.doc, ranges = [];
        for (const ln of e.value) if (ln >= 1 && ln <= doc.lines) ranges.push(new BookmarkMarker().range(doc.line(ln).from));
        ranges.sort((a, b) => a.from - b.from);
        set = RangeSet.of(ranges, true);
      }
      return set;
    },
  });
  const bmGutterExt = gutter({
    class: 'cm-bm-gutter',
    markers: (view) => view.state.field(bmGutterField),
    domEventHandlers: {
      click: (view, block) => { const ln = view.state.doc.lineAt(block.from).number; toggleBookmarkAt(ln); return true; },
    },
  });
  // Unified diff → пер-строчные метки для НОВОЙ версии файла (что лежит в редакторе).
  // Блок «-…+…» = modified; одиночные «+» = added; «-» без последующих «+» = deleted (треугольник на стыке).
  function parseDiffToMarks(diff) {
    const marks = [];
    if (!diff) return marks;
    let newLine = 0, del = 0;
    const flushDel = (at) => { if (del > 0) { marks.push({ line: Math.max(1, at), type: 'deleted' }); del = 0; } };
    for (const ln of diff.split('\n')) {
      if (ln.startsWith('@@')) {
        flushDel(newLine);
        const m = ln.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) newLine = parseInt(m[1], 10);
        del = 0; continue;
      }
      if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ') ||
          ln.startsWith('new file') || ln.startsWith('deleted file') || ln.startsWith('\\') || ln.startsWith('Binary')) continue;
      const c = ln[0];
      if (c === '+') { marks.push({ line: newLine, type: del > 0 ? 'modified' : 'added' }); if (del > 0) del--; newLine++; }
      else if (c === '-') { del++; }
      else { flushDel(newLine); newLine++; }            // контекст (' ') или хвостовая пустая строка
    }
    flushDel(newLine);
    return marks;
  }
  // Пересчитать git-гаттер для открытого файла (fire-and-forget; гонки гасим сверкой currentFile).
  async function updateGitGutter(file) {
    if (!editor) return;
    if (!file || previewKind(file) === 'image') { clearGitGutter(); return; }
    const p = activeProject(); if (!p) { clearGitGutter(); return; }
    let res; try { res = await lite.git.fileDiff(p.path, file); } catch (_) { return; }
    if (file !== currentFile) return;                   // переключили файл за время await
    editor.dispatch({ effects: setGitGutterEffect.of(parseDiffToMarks(res && res.diff ? res.diff : '')) });
  }
  function clearGitGutter() { if (editor) editor.dispatch({ effects: setGitGutterEffect.of([]) }); }
  function previewKind(file) {
    const e = extOf(file);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(e)) return 'image';
    if (['md', 'markdown'].includes(e)) return 'markdown';
    if (['html', 'htm'].includes(e)) return 'html';
    return null;
  }
  // Commit the viewer chrome (filename, preview/fullscreen buttons, tree highlight) for an
  // open file. Вынесено из openFile, чтобы ставить эти метки ТОЛЬКО после успешного чтения —
  // иначе при ошибке вивер показывал имя/подсветку файла без живого currentFile (рассинхрон).
  function commitOpenUI(filePath, kind) {
    $('#viewer-filename').textContent = baseName(filePath);
    updatePreviewBar(kind);
    document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
    const row = document.querySelector(`.tree-row[data-path="${cssEscape(filePath)}"]`);
    if (row) row.classList.add('open');
  }
  // Контекст-бар просмотра (низ колонки табов): Превью/Рядом для md·html, Во весь экран·В браузере — только html.
  // Картинки не рендерятся как исходник — у них превью и так единственный вид, тогглы не нужны → бар скрыт.
  function updatePreviewBar(kind) {
    const foot = $('#tabs-foot'); if (!foot) return;
    const showable = kind === 'markdown' || kind === 'html';
    foot.style.display = showable ? '' : 'none';
    $('#viewer-preview').style.display = showable ? '' : 'none';
    $('#viewer-split').style.display = showable ? '' : 'none';
    $('#viewer-full').style.display = (kind === 'html') ? '' : 'none';
    $('#viewer-browser').style.display = (kind === 'html') ? '' : 'none';
  }
  async function openFile(filePath, line) {
    const seq = ++openSeq;
    clearGitDiff();                  // открываем реальный файл — это больше не git-дифф в центре
    if (diffMode) exitDiff(false);
    exitPreview();
    hideReloadBar();
    const kind = previewKind(filePath);

    if (kind === 'image') { // binary — no editable source
      currentFile = filePath;
      commitOpenUI(filePath, kind);
      afterOpen(filePath);
      setEditorText('', []); markDirty(false); clearGitGutter();
      await showPreview('image', filePath, '');
      return;
    }
    const res = await lite.fs.readFile(filePath);
    if (seq !== openSeq) return; // обогнал более свежий openFile — выходим, не затирая его результат
    if (res.error) { toast(res.error, { kind: 'err', ttl: 6000 }); return; } // оставляем текущий файл нетронутым
    currentFile = filePath;
    commitOpenUI(filePath, kind);
    afterOpen(filePath);
    setEditorText(res.content, languageFor(filePath));
    markDirty(false);
    updateGitGutter(filePath);
    refreshBlameIfOn();                              // A7: подгрузить blame нового файла, если режим включён
    if (splitMode) { const k = previewKind(filePath); if (k === 'markdown' || k === 'html') refreshSplitPreview(); else exitSplit(); } // B15: сплит следует за файлом
    // md/html открываем КОДОМ (исходником) — превью включается вручную кнопкой в баре под табами.
    // Раньше открывали сразу рендером, что мешало правке. Картинки — отдельной веткой выше (исходника нет).
    if (line && line > 0) requestAnimationFrame(() => { if (seq === openSeq) gotoLine(line); }); // не прыгать в чужом доке, если уже открыли другой файл
  }

  // ---------------------------------------------------------------- viewer preview (md/image/html)
  // Чистим распарсенный markdown ПЕРЕД вставкой в DOM. CSP уже блокирует исполнение инлайн-скриптов,
  // это второй рубеж (и страховка, если CSP когда-нибудь ослабят): убираем активные узлы и обработчики.
  function sanitizePreviewHtml(root) {
    root.querySelectorAll('script, iframe, frame, object, embed, base, link, meta').forEach((n) => n.remove());
    root.querySelectorAll('*').forEach((n) => {
      for (const attr of [...n.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) n.removeAttribute(attr.name); // инлайн-обработчики (onerror/onclick/…)
        else if (/^(href|src|xlink:href)$/.test(name) && /^\s*javascript:/i.test(attr.value)) n.removeAttribute(attr.name);
      }
    });
  }
  // Наполнить #preview-view рендером (без переключения display/previewMode) — переиспользуется полным превью и сплитом.
  async function fillPreview(kind, file, content) {
    const view = $('#preview-view');
    view.innerHTML = '';
    if (kind === 'image') {
      const res = await lite.fs.readDataUrl(file);
      if (file !== currentFile) return; // обогнали более свежим open — не дорисовываем в чужой view (гонка)
      if (res.error) view.appendChild(el('div', 'prev-empty', res.error));
      else { const img = el('img', 'prev-img'); img.src = res.url; view.appendChild(img); }
    } else if (kind === 'markdown') {
      const div = el('div', 'prev-md');
      try { div.innerHTML = marked.parse(content || '', { breaks: true }); } catch (_) { div.textContent = content || ''; }
      sanitizePreviewHtml(div); // defense-in-depth поверх CSP: вырезать <script>/iframe/инлайн-обработчики/javascript:
      const base = dirName(file);
      div.querySelectorAll('img').forEach((im) => { // resolve relative image paths from the file's folder
        const s = im.getAttribute('src') || '';
        if (s && !/^(https?:|data:|file:|\/\/)/i.test(s)) im.src = fileUrl(base + '/' + s.replace(/^\.\//, ''));
      });
      div.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a && /^https?:/i.test(a.href)) { e.preventDefault(); lite.openExternal(a.href); } });
      view.appendChild(div);
    } else if (kind === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'prev-frame';
      // load from disk (not srcdoc) so relative css/js/img resolve against the project folder
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
      frame.src = fileUrl(file);
      view.appendChild(frame);
    }
  }
  async function showPreview(kind, file, content) {
    if (diffMode) exitDiff(false); // diff и preview взаимоисключающие — иначе оба оверлея накладываются
    if (splitMode) exitSplit();    // полное превью заменяет сплит
    previewMode = true;
    await fillPreview(kind, file, content);
    if (file !== currentFile) { previewMode = false; return; } // за время await (image: readDataUrl) открыли другой файл — не трогаем видимость
    $('#editor').style.display = 'none';
    $('#preview-view').style.display = 'block';
    $('#viewer-preview').classList.add('on');
    updateStatus(editor.state);
  }
  function exitPreview() {
    exitPreviewFull(); // на всякий случай свернуть полноэкранный режим
    previewMode = false;
    const v = $('#preview-view');
    if (v && !splitMode) { v.style.display = 'none'; v.innerHTML = ''; }
    $('#editor').style.display = '';
    $('#viewer-preview').classList.remove('on');
    updateStatus(editor.state);
  }
  function togglePreview() {
    if (previewMode) { exitPreview(); editor.focus(); return; }
    const kind = previewKind(currentFile);
    if (kind) showPreview(kind, currentFile, editor.state.doc.toString());
  }
  // B15: превью рядом с кодом (split) — редактор слева, живой рендер справа. Markdown обновляется по вводу,
  // HTML перезагружается из файла (после автосейва). Esc/повтор кнопки — выход.
  let splitMode = false, splitTimer = null;
  function exitSplit() {
    if (!splitMode) return;
    splitMode = false;
    document.body.classList.remove('preview-split');
    $('#viewer-split').classList.remove('on');
    const v = $('#preview-view'); if (v && !previewMode) { v.style.display = 'none'; v.innerHTML = ''; }
    setTimeout(() => { try { editor.requestMeasure(); } catch (_) {} }, 50);
  }
  function refreshSplitPreview() {
    if (!splitMode || !currentFile) return;
    const kind = previewKind(currentFile);
    if (kind === 'markdown' || kind === 'html') fillPreview(kind, currentFile, editor.state.doc.toString());
  }
  function togglePreviewSplit() {
    if (splitMode) { exitSplit(); editor.focus(); return; }
    const kind = previewKind(currentFile);
    if (kind !== 'markdown' && kind !== 'html') { toast('Сплит-превью — для Markdown и HTML'); return; }
    if (previewMode) exitPreview();
    if (diffMode) exitDiff(false);
    splitMode = true;
    document.body.classList.add('preview-split');
    $('#viewer-split').classList.add('on');
    $('#editor').style.display = '';
    $('#preview-view').style.display = 'block';
    fillPreview(kind, currentFile, editor.state.doc.toString());
    setTimeout(() => { try { editor.requestMeasure(); } catch (_) {} }, 50);
  }
  // «Превью HTML на весь экран» — оверлей поверх всего окна для быстрой проверки вёрстки (Esc / ✕ — выход).
  async function enterPreviewFull() {
    if (previewKind(currentFile) !== 'html') return;
    if (!previewMode) await showPreview('html', currentFile, editor.state.doc.toString()); // включить превью, если смотрели исходник
    if (!$('#preview-full-exit')) {
      const btn = el('button', 'pf-exit', '✕ Esc');
      btn.id = 'preview-full-exit';
      btn.title = 'Выйти из полноэкранного превью (Esc)';
      btn.addEventListener('click', exitPreviewFull);
      document.body.appendChild(btn);
    }
    $('#preview-full-exit').style.display = '';
    document.body.classList.add('preview-full');
  }
  function exitPreviewFull() {
    if (!document.body.classList.contains('preview-full')) return;
    document.body.classList.remove('preview-full');
    const btn = $('#preview-full-exit');
    if (btn) btn.style.display = 'none';
  }
  function togglePreviewFull() {
    if (document.body.classList.contains('preview-full')) exitPreviewFull();
    else enterPreviewFull();
  }
  function gotoLine(line) {
    const doc = editor.state.doc;
    const pos = doc.line(Math.max(1, Math.min(line, doc.lines))).from;
    editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    editor.focus();
  }
  // Reload the open file from disk (agent changed it) — keep caret roughly put.
  async function reloadCurrentFile() {
    if (!currentFile) return;
    const kind = previewKind(currentFile);
    if (kind === 'image') { // бинарник: исходника нет — обновляем только открытое превью
      if (previewMode) await showPreview('image', currentFile, '');
      return;
    }
    const f = currentFile;
    const res = await lite.fs.readFile(f);
    if (f !== currentFile) return; // за время чтения открыли другой файл — не подменяем его содержимым этого
    if (res.error) return;
    const head = editor.state.selection.main.head;
    const oldText = editor.state.doc.toString();        // C21: до подмены — чтобы пометить, что тронул агент
    if (res.content === oldText) { markDirty(false); hideReloadBar(); return; } // эхо нашего же автосейва — не перезаливаем док (иначе сброс folds/курсора)
    setEditorText(res.content, languageFor(currentFile));
    markDirty(false);
    hideReloadBar();
    updateGitGutter(currentFile);
    if (agentMode) { const ch = diffChangedLines(oldText, res.content); if (ch.length) markAuthor(ch, 'agent'); } // живой reload = правка агента
    try { editor.dispatch({ selection: { anchor: Math.min(head, editor.state.doc.length) } }); } catch (_) {}
    if (previewMode && kind) await showPreview(kind, currentFile, res.content); // перерисовать рендер md/html
  }
  // Перезапросить дифф открытого файла, когда он изменился на диске (агент правит, а мы смотрим дифф).
  // Read-only: трогаем только #diff-view, редактор/несохранённые правки не задеваем.
  async function reloadCurrentDiff() {
    if (!currentFile || !diffMode) return;
    const p = activeProject(); if (!p) return;
    const res = await lite.git.fileDiff(p.path, currentFile);
    if (!diffMode || !currentFile) return; // режим мог смениться за время await
    showDiff(res && res.diff ? res.diff : '');
  }
  function setEditorText(text, lang) {
    loadingDoc = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, effects: langComp.reconfigure(lang) });
    loadingDoc = false;
    symCacheFile = null;
    updateStatus(editor.state);
    updateBreadcrumb(editor.state);
    refreshBookmarkGutter();          // канонический момент загрузки дока → маркеры закладок по НОВОМУ содержимому
  }
  function markDirty(v) { dirty = v; $('#viewer-dirty').classList.toggle('show', v); }
  // Автосохранение (PhpStorm-style): через AUTOSAVE_MS тишины после правки тихо пишем файл на диск.
  // Не сохраняем в превью/диффе, при конфликте на диске (открыта reload-плашка) и при загрузке дока —
  // там пишет/решает другой путь. Сохраняет ровно текущий файл; stale-таймер после смены файла безвреден
  // (markDirty(false) на open делает его no-op'ом).
  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (!dirty || !currentFile || previewMode || diffMode) return;
      if (!$('#viewer-reload-bar').classList.contains('hidden')) return; // конфликт с диском — ждём решения пользователя
      saveCurrent();
    }, AUTOSAVE_MS);
  }
  function cancelAutosave() { if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; } }
  // Плашка-конфликт: файл изменился на диске, пока у нас есть несохранённые правки (агент тронул открытый файл).
  // Постоянная (в отличие от тоста) — пока пользователь не решит: перечитать с диска или оставить своё.
  function showReloadBar() { $('#viewer-reload-bar').classList.remove('hidden'); }
  function hideReloadBar() { $('#viewer-reload-bar').classList.add('hidden'); }
  // Returns true when the file is safely on disk (or there was nothing to save), false on a
  // failed write. Callers that gate a destructive next step (guardDirty) must NOT proceed on
  // false, or the unsaved edits are lost.
  async function saveCurrent() {
    cancelAutosave();                                  // ручной/guardDirty save гасит pending-дебаунс автосейва
    if (!currentFile || !dirty) return true;
    let res;
    try { res = await lite.fs.writeFile(currentFile, editor.state.doc.toString()); }
    catch (e) { res = { error: String(e) }; }
    if (res && res.ok) { markDirty(false); hideReloadBar(); updateGitGutter(currentFile); refreshBlameIfOn(); return true; }
    toast(`Не удалось сохранить: ${(res && res.error) || 'ошибка записи'}`, { kind: 'err', ttl: 6000 });
    return false;
  }

  // ---------------------------------------------------------------- git diff in the viewer
  async function toggleDiff() {
    if (diffMode) { exitDiff(true); return; }
    if (!currentFile) return;
    const p = activeProject(); if (!p) return;
    const file = currentFile;
    const res = await lite.git.fileDiff(p.path, file);
    if (currentFile !== file) return; // переключили файл за время await — не показываем устаревший дифф
    diffRevertTarget = null;          // дифф-кнопка из режима редактирования — не показываем откат ханка (стейл от «Коммита» сбрасываем)
    showDiff(res && res.diff ? res.diff : '');
  }
  function showDiff(text) {
    if (previewMode) exitPreview(); // preview и diff взаимоисключающие — иначе оба оверлея накладываются
    diffMode = true;
    const view = $('#diff-view');
    view.innerHTML = '';
    if (!text.trim()) {
      view.appendChild(el('div', 'diff-empty', 'Нет изменений относительно HEAD (или это не git-репозиторий).'));
    } else {
      const lines = text.split('\n');
      // C18: откат ханка доступен только для ЖИВОГО diff'а рабочего файла vs HEAD (gitDiffFile) в режиме агента.
      const canRevert = agentMode && diffRevertTarget;
      let firstHunk = lines.findIndex((l) => l.startsWith('@@')); if (firstHunk < 0) firstHunk = lines.length;
      const header = lines.slice(0, firstHunk);
      lines.forEach((ln, i) => {
        let cls = '';
        if (ln.startsWith('@@')) cls = 'hunk';
        else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'meta';
        else if (ln.startsWith('+')) cls = 'add';
        else if (ln.startsWith('-')) cls = 'del';
        const row = el('div', 'diff-line ' + cls, ln || ' ');
        if (cls === 'hunk' && canRevert) {
          const btn = el('button', 'diff-hunk-revert'); btn.title = 'Откатить этот ханк (вернуть к версии до агента)';
          btn.appendChild(icon('eraser', 12));
          btn.addEventListener('click', (e) => { e.stopPropagation(); revertHunk(header, lines, i); });
          row.appendChild(btn);
        }
        view.appendChild(row);
      });
    }
    $('#editor').style.display = 'none';
    view.style.display = 'block';
    $('#viewer-diff').classList.add('on');
    updateStatus(editor.state);
  }
  function exitDiff(refocus) {
    diffMode = false;
    $('#diff-view').style.display = 'none';
    $('#editor').style.display = '';
    $('#viewer-diff').classList.remove('on');
    if (refocus) editor.focus();
    updateStatus(editor.state);
  }

  // ---------------------------------------------------------------- git status (tree decorations)
  async function loadGitStatus(proj) {
    if (!proj) { gitFiles = {}; return; }
    const res = await lite.git.status(proj.path);
    gitFiles = res && res.files ? res.files : {};
    // освежить гаттер после внешних git-операций (коммит/checkout → tree refresh); только при чистом буфере —
    // иначе перерисовали бы метки по диск-vs-HEAD, не совпадающие с несохранёнными правками в редакторе
    if (currentFile && !dirty) updateGitGutter(currentFile);
  }
  function gitClassFor(p) {
    const c = gitFiles[p];
    if (!c) return '';
    if (c === '?' || c.includes('A')) return 'g-add';
    if (c.includes('D')) return 'g-del';
    return 'g-mod';
  }
  function dirGitClass(dirPath) {
    for (const k in gitFiles) {
      if (k.length > dirPath.length && k.startsWith(dirPath) && (k[dirPath.length] === '/' || k[dirPath.length] === '\\')) return 'g-mod';
    }
    return '';
  }

  function clearViewer() {
    if (diffMode) exitDiff(false); // иначе оверлей диффа/превью старого файла остаётся висеть при смене проекта/чате/удалении
    exitSplit();
    exitPreview();
    currentFile = null;
    clearGitDiff();
    setEditorText('', []);          // setEditorText сам обновит гаттер закладок (currentFile=null → пусто)
    clearGitGutter();
    hideReloadBar();
    $('#viewer-filename').textContent = '—';
    markDirty(false);
    openTabs = []; pinnedTabs.clear(); renderTabs();    // смена проекта/закрытие → сбросить колонку табов
    document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
  }
  // Re-render the tree for the active project; viewer starts empty (no auto-reopen).
  // Switching/opening a project always gives a clean viewer — open files from the tree.
  // Нет выбранного проекта (открыта категория) → показываем заглушку вивера.
  async function refreshViewerForActive() {
    const p = activeProject();
    if (!p) { showViewerPlaceholder(); if (git) git.renderPanel(null); return; }
    await renderTree(p);
    clearViewer();
    // VCS-полоса нужна всегда; тяжёлые секции (коммит/лог) рендерим лениво — только если открыты.
    if (git) git.renderPanel(p, { commit: curSection === 'commit', log: logOpen });
  }
  // Заглушка вивера, когда нет выбранного проекта (открыта категория/чат OpenRouter).
  function showViewerPlaceholder() {
    $('#tree-title').textContent = 'ДЕРЕВО';
    const root = $('#tree');
    root.innerHTML = '';
    root.appendChild(el('div', 'tree-empty', 'Нужно выбрать проект для отображения файлов'));
    clearViewer();
  }

  // Возвращает промис первичной отрисовки (renderTree + clearViewer), чтобы вызывающий мог
  // дождаться её и лишь потом грузить файл — иначе clearViewer() затрёт свежезагруженный файл.
  function setViewerOpen(open, opts = {}) {
    if (open === viewerOpen) {
      const p = open ? refreshViewerForActive() : null;
      host.renderProjects();
      return p;
    }
    // Right slot holds one module — opening the viewer closes the others (chat is separate).
    if (open) host.closeOtherPanels('files');
    else exitPreviewFull(); // закрытие вивера (в т.ч. через closeOtherPanels) должно снять плавающую «✕ Esc» полноэкранного превью
    const delta = host.layout.viewer + host.layout.tree + host.GUTTER * 2;
    viewerOpen = open;
    $('#viewer-pane').classList.toggle('hidden', !open);
    $('#tree-pane').classList.toggle('hidden', !open);
    document.querySelectorAll('.gutter-v').forEach((g) => g.classList.toggle('hidden', !open));
    if (opts.grow !== false) host.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts these panes
    host.saveUiState();
    host.renderProjects();
    const pending = open ? refreshViewerForActive() : null;
    setTimeout(host.refitActiveTerminal, 150);
    return pending;
  }

  // Don't lose unsaved viewer edits when switching away — ask first.
  function guardDirty(proceed) {
    if (!dirty || !currentFile) { proceed(); return; }
    showConfirm(
      'Несохранённые изменения',
      `Файл «${baseName(currentFile)}» изменён. Сохранить перед переключением?`,
      'Сохранить',
      async () => { if (await saveCurrent()) proceed(); }, // failed save → stay put, don't lose edits
      'Не сохранять',
      () => { markDirty(false); proceed(); },
    );
  }

  // ---------------------------------------------------------------- file tree
  const EXT_COLORS = {
    js: '#e8d44d', jsx: '#e8d44d', mjs: '#e8d44d', cjs: '#e8d44d',
    ts: '#4a9be0', tsx: '#4a9be0',
    py: '#5fa6dd', json: '#cbcb41', md: '#9fb3a9', markdown: '#9fb3a9',
    html: '#e3733b', htm: '#e3733b', css: '#9b6bd6', scss: '#cf6ba0',
    png: '#b07cd6', jpg: '#b07cd6', jpeg: '#b07cd6', gif: '#b07cd6', webp: '#b07cd6', svg: '#ffb13b',
    sh: '#89e051', bash: '#89e051', yml: '#dd6c6c', yaml: '#dd6c6c', toml: '#b07a4a',
    lock: '#7a8a82', txt: '#9fb3a9', env: '#e2c08d', sql: '#e38f3b', vue: '#41b883', go: '#4ad0e0', rs: '#dd8855',
  };
  function extOf(name) { if (!name) return ''; const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
  function colorFor(name) { return EXT_COLORS[extOf(name)] || '#8aa79a'; }
  function fileSvg(color) {
    return svgEl(`<svg class="ti" viewBox="0 0 16 16" width="14" height="14">
      <path fill="${color}" opacity="0.95" d="M3.5 1.4h5.1L13 5.3v9.3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V2.4a1 1 0 0 1 1-1z"/>
      <path fill="#06120c" opacity="0.4" d="M8.6 1.4 13 5.3H9.1a.5.5 0 0 1-.5-.5z"/></svg>`);
  }
  function folderSvg(open) {
    const c = open ? '#7fd9ad' : '#56b98a';
    return svgEl(`<svg class="ti" viewBox="0 0 16 16" width="14" height="14">
      <path fill="${c}" d="M1.4 3.6h4.2l1.2 1.5H14.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H1.4a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1z"/></svg>`);
  }

  async function renderTree(proj) {
    $('#tree-title').textContent = proj.name.toUpperCase();
    await loadGitStatus(proj);
    const root = $('#tree');
    root.innerHTML = '';
    await buildDir(proj.path, root, 0);
  }
  // ---- drag-and-drop в дереве: перемещение узлов (move) + втягивание файлов извне (copy из ОС)
  function setDropHL(row) { if (dropHLRow && dropHLRow !== row) dropHLRow.classList.remove('drag-over'); dropHLRow = row; if (row) row.classList.add('drag-over'); }
  function clearDropHL() { if (dropHLRow) { dropHLRow.classList.remove('drag-over'); dropHLRow = null; } $('#tree').classList.remove('drag-over-root'); }
  // Любую строку (файл/папку) можно «взять» мышью.
  function makeRowDraggable(row, srcPath) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragSrcPath = srcPath;
      e.dataTransfer.effectAllowed = 'copyMove';
      try { e.dataTransfer.setData('text/plain', srcPath); } catch (_) {}
      e.stopPropagation();
    });
    row.addEventListener('dragend', () => { dragSrcPath = null; clearDropHL(); });
  }
  // Папка-строка — приёмник: внутренний move кладёт узел внутрь; внешний drop из ОС — копирует файлы внутрь.
  function makeRowDropTarget(row, destDir) {
    row.addEventListener('dragover', (e) => {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = dragSrcPath ? 'move' : 'copy';
      setDropHL(row);
    });
    row.addEventListener('dragleave', (e) => { if (e.target === row && dropHLRow === row) clearDropHL(); });
    row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); handleTreeDrop(e, destDir); });
  }
  async function handleTreeDrop(e, destDir) {
    clearDropHL();
    if (!destDir) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {            // внешний drop из файлового менеджера ОС → копируем внутрь
      dragSrcPath = null;
      const srcs = Array.from(files).map((f) => f.path || lite.pathForFile(f)).filter(Boolean);
      let ok = 0;
      for (const src of srcs) {
        const r = await lite.fs.importPath(src, destDir);
        if (r && r.error) toast(r.error, { kind: 'err' }); else ok++;
      }
      if (ok) { expandedDirs.add(destDir); await refreshTree(); toast(ok > 1 ? `Добавлено файлов: ${ok}` : 'Файл добавлен'); }
      return;
    }
    const src = dragSrcPath; dragSrcPath = null;     // внутренний move дерево→дерево
    if (!src) return;
    if (src === destDir || dirName(src) === destDir) return;   // сам на себя / та же папка — тихий no-op
    if (pathInside(destDir, src)) { toast('Нельзя переместить папку внутрь себя', { kind: 'err' }); return; }
    const r = await lite.fs.move(src, destDir);
    if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
    if (currentFile && pathInside(currentFile, src) && r.path) {   // ремап открытого файла после переноса
      currentFile = r.path + currentFile.slice(src.length);
      $('#viewer-filename').textContent = baseName(currentFile);
    }
    if (r.path) remapTabs(src, r.path);                            // и пути табов под новым префиксом
    expandedDirs.add(destDir);
    await refreshTree();
  }
  async function buildDir(dir, container, depth) {
    const entries = await lite.fs.readDir(dir);
    if (!Array.isArray(entries)) return;
    for (const ent of entries) {
      const indent = depth * 12 + 8;
      if (ent.dir) {
        const row = el('div', 'tree-row dir');
        row.style.paddingLeft = indent + 'px';
        row.dataset.path = ent.path;
        const chev = el('span', 'tree-chev', '▸');
        let icon = folderSvg(false);
        const name = el('span', 'tree-name', ent.name);
        const gc = dirGitClass(ent.path); if (gc) name.classList.add(gc);
        row.appendChild(chev); row.appendChild(icon); row.appendChild(name);
        const childBox = el('div', 'tree-children');
        childBox.style.display = 'none';
        const expand = async () => {
          if (childBox.childElementCount === 0) await buildDir(ent.path, childBox, depth + 1);
          childBox.style.display = 'block'; chev.textContent = '▾';
          const nx = folderSvg(true); icon.replaceWith(nx); icon = nx;
        };
        const collapse = () => {
          childBox.style.display = 'none'; chev.textContent = '▸';
          const nx = folderSvg(false); icon.replaceWith(nx); icon = nx;
        };
        row.addEventListener('click', async () => {
          if (expandedDirs.has(ent.path)) { expandedDirs.delete(ent.path); collapse(); }
          else { expandedDirs.add(ent.path); await expand(); }
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTreeMenu(e.clientX, e.clientY, { name: ent.name, path: ent.path, dir: true }); });
        makeRowDraggable(row, ent.path); makeRowDropTarget(row, ent.path); // папку можно тащить и в неё можно класть
        container.appendChild(row); container.appendChild(childBox);
        if (expandedDirs.has(ent.path)) await expand(); // restore after a live refresh
      } else {
        const row = el('div', 'tree-row file');
        row.style.paddingLeft = indent + 'px';
        row.dataset.path = ent.path;
        row.appendChild(el('span', 'tree-chev', ''));
        row.appendChild(fileSvg(colorFor(ent.name)));
        const name = el('span', 'tree-name', ent.name);
        const gc = gitClassFor(ent.path); if (gc) name.classList.add(gc);
        row.appendChild(name);
        if (ent.path === currentFile) row.classList.add('open');
        row.addEventListener('click', () => {
          if (ent.path === currentFile && viewerOpen) return;
          if (!viewerOpen) setViewerOpen(true);
          guardDirty(() => openFile(ent.path));
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTreeMenu(e.clientX, e.clientY, { name: ent.name, path: ent.path, dir: false }); });
        makeRowDraggable(row, ent.path); makeRowDropTarget(row, dirName(ent.path)); // тащить файл; drop на него = в его папку
        container.appendChild(row);
      }
    }
  }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); }
  const dirName = (p) => { const i = p.search(/[\\/][^\\/]*$/); return i >= 0 ? p.slice(0, i) : p; };
  // child == parent или лежит внутри него — учитывает оба сепаратора (важно для Windows-путей)
  const pathInside = (child, parent) => child === parent || (child.startsWith(parent) && (child[parent.length] === '/' || child[parent.length] === '\\'));
  // absolute fs path → file:// URL (Windows C:\x → file:///C:/x), for preview resources
  // encodeURI не трогает % # ? — без этого пути с такими символами ломают src iframe/img (всё после # = фрагмент). % первым, иначе двойное экранирование.
  function fileUrl(p) { let u = String(p).replace(/\\/g, '/'); if (!u.startsWith('/')) u = '/' + u; return 'file://' + encodeURI(u).replace(/%(?![0-9A-Fa-f]{2})/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F'); }

  // ---------------------------------------------------------------- tree file operations
  async function refreshTree() { const p = activeProject(); if (p) await renderTree(p); }
  function treeNewFile(parent) {
    showPrompt('Новый файл', 'Имя файла (можно путь: src/app.js)', '', async (name) => {
      const r = await lite.fs.create(parent, name, false);
      if (r && !r.error) { await refreshTree(); if (r.path) { if (!viewerOpen) setViewerOpen(true); openFile(r.path); } }
      return r;
    });
  }
  function treeNewFolder(parent) {
    showPrompt('Новая папка', 'Имя папки', '', async (name) => {
      const r = await lite.fs.create(parent, name, true);
      if (r && !r.error) { expandedDirs.add(parent); await refreshTree(); }
      return r;
    });
  }
  function treeRename(ent) {
    showPrompt('Переименовать', 'Новое имя', ent.name, async (name) => {
      const to = dirName(ent.path) + '/' + name;
      const r = await lite.fs.rename(ent.path, to);
      if (r && !r.error) {
        // ремап открытого файла: и сам файл, и случай переименования папки-предка (иначе stale-путь → запись мимо)
        if (currentFile && pathInside(currentFile, ent.path)) {
          currentFile = to + currentFile.slice(ent.path.length);
          $('#viewer-filename').textContent = baseName(currentFile);
        }
        remapTabs(ent.path, to);
        await refreshTree();
      }
      return r;
    });
  }
  function treeDelete(ent) {
    showConfirm('Удалить?', `«${ent.name}» будет перемещён в корзину.`, 'Удалить', async () => {
      const r = await lite.fs.trash(ent.path);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      dropTabsUnder(ent.path);   // закрыть табы удалённого файла/папки (и переключить редактор, если был активен)
      await refreshTree();
    });
  }
  function showTreeMenu(x, y, ent) {
    closeMenus();
    const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '190px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    if (ent.dir) {
      dd.appendChild(menuRow('file', 'Новый файл…', () => { closeMenus(); treeNewFile(ent.path); }));
      dd.appendChild(menuRow('folder', 'Новая папка…', () => { closeMenus(); treeNewFolder(ent.path); }));
      dd.appendChild(el('div', 'menu-sep'));
    } else {
      dd.appendChild(menuRow('eye', 'Открыть', () => { closeMenus(); if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(ent.path)); }));
      if (['html', 'htm'].includes(extOf(ent.name))) dd.appendChild(menuRow('globe', 'Открыть в браузере', () => { closeMenus(); lite.openInBrowser(ent.path).then((r) => { if (r && r.error) toast(r.error, { kind: 'err' }); }); }));
      dd.appendChild(compareMenuRow(ent));
      dd.appendChild(el('div', 'menu-sep'));
    }
    if (!ent.root) {
      dd.appendChild(menuRow('pencil', 'Переименовать…', () => { closeMenus(); treeRename(ent); }));
      dd.appendChild(menuRow('trash', 'Удалить…', () => { closeMenus(); treeDelete(ent); }, 'danger'));
    }
    dd.appendChild(menuRow('copy', 'Копировать путь', () => { closeMenus(); lite.copyText(ent.path); toast('Путь скопирован'); }));
    dd.appendChild(menuRow('file', 'Копировать файл', () => { closeMenus(); copyEntryFile(ent.path); }));
    dd.appendChild(menuRow('folder', 'Показать в проводнике', () => { closeMenus(); revealEntry(ent.path); }));
    placeMenu(dd, x, y);
  }
  // Положить файл/папку в системный буфер обмена ОС — вставить как файл в файловом менеджере.
  async function copyEntryFile(p) {
    const r = await lite.copyFile(p);
    if (!r || r.ok === false) { toast((r && r.error) || 'Не удалось скопировать файл', { kind: 'err' }); return; }
    toast(r.mode === 'path'
      ? 'Скопирован путь (копирование файла не поддержано этой ОС)'
      : `«${baseName(p)}» в буфере — вставьте в файловом менеджере`);
  }
  // Показать файл/папку в системном файловом менеджере с выделением (reveal-in-folder).
  async function revealEntry(p) {
    const r = await lite.showItemInFolder(p);
    if (!r || r.ok === false) toast((r && r.error) || 'Не удалось открыть папку', { kind: 'err' });
  }

  // ---- сборка live-обновления диска для активного проекта (агент тронул файл)
  function onFsChange(p, files) {
    fileListCache = null;                               // дерево менялось на диске → пересобрать листинг для Ctrl+P
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => {
      if (viewerOpen) renderTree(p);
      if (agentMode) updateReviewBadge();               // C18: агент тронул диск → освежить счётчик изменённых файлов
      // живой git-дифф в центре: показанный файл изменился на диске (агент правит) → перечитать дифф
      if (gitDiffFile && diffMode && gitDiffProj && files.includes(gitDiffFile)) {
        const f = gitDiffFile;
        lite.git.fileDiff(gitDiffProj, f).then((r) => { if (gitDiffFile === f && diffMode) showDiff(r && r.diff ? r.diff : ''); });
      }
      if (currentFile && files.includes(currentFile)) {
        if (diffMode) reloadCurrentDiff();              // в режиме диффа — обновляем дифф (редактор не трогаем)
        else if (!dirty) reloadCurrentFile();           // нет правок — молча перечитываем (вивер всегда = диск)
        else showReloadBar();                           // есть несохранённые правки — постоянная плашка-конфликт
      }
    }, 120);
  }
  // Убрать из expandedDirs пути чужих проектов (вызывается ядром при смене активного проекта).
  function pruneExpandedDirs(projPath) {
    for (const d of expandedDirs) if (!pathInside(d, projPath)) expandedDirs.delete(d);
  }

  // ================================================================ «привычное» (этапы 2–7)
  // --- пути (нормализуем сепараторы к '/'; основные платформы — linux/mac) ---
  function relTo(base, file) { const r = file.startsWith(base) ? file.slice(base.length) : file; return r.replace(/^[/\\]+/, '').replace(/\\/g, '/'); }
  function joinPath(base, rel) { return base.replace(/[/\\]+$/, '') + '/' + rel; }

  // --- структура файла (символы) по эвристикам-регэкспам; кэш на текущий файл ---
  let symCacheFile = null, symCache = [];
  function currentSymbols() {
    if (symCacheFile === currentFile) return symCache;  // кэшируем и пустой результат (symCacheFile=null на каждой правке/загрузке инвалидирует)
    symCache = currentFile ? extractSymbols(editor.state.doc.toString(), extOf(currentFile)) : [];
    symCacheFile = currentFile;
    return symCache;
  }
  function extractSymbols(text, ext) {
    const syms = [], lines = text.split('\n');
    const push = (line, name, kind) => { if (name) syms.push({ line, name, kind }); };
    if (ext === 'md' || ext === 'markdown') {
      for (let i = 0; i < lines.length; i++) { const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i]); if (m) push(i + 1, m[2].trim(), 'h' + m[1].length); }
      return syms;
    }
    if (ext === 'py') {
      for (let i = 0; i < lines.length; i++) { const m = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(lines[i]); if (m) push(i + 1, m[3], m[2].includes('class') ? 'class' : 'fn'); }
      return syms;
    }
    if (ext === 'css' || ext === 'scss') {
      for (let i = 0; i < lines.length; i++) { if (/^\s*@(media|keyframes|supports|import|font-face)/.test(lines[i])) continue; const m = /^([.#&:\[a-zA-Z][^{};]*?)\s*\{/.exec(lines[i]); if (m) push(i + 1, m[1].trim().slice(0, 60), 'rule'); }
      return syms;
    }
    // JS/TS/JSX и прочие C-подобные
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]; let m;
      if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(ln))) push(i + 1, m[1], 'fn');
      else if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(ln))) push(i + 1, m[1], 'class');
      else if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(ln))) push(i + 1, m[1], 'fn');
      else if ((m = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(ln)) && !/^(if|for|while|switch|catch|return|function|do|else)$/.test(m[1])) push(i + 1, m[1], 'method');
    }
    return syms;
  }
  function kindGlyph(k) { return k === 'class' ? 'C' : k === 'method' ? 'm' : k === 'fn' ? 'ƒ' : k === 'rule' ? '{}' : /^h\d$/.test(k) ? k.toUpperCase() : '•'; }

  // --- хлебные крошки: путь от корня проекта + текущий символ по позиции курсора ---
  function updateBreadcrumb(state) {
    const bar = $('#viewer-crumbs'); if (!bar) return;
    if (!currentFile || previewMode || diffMode) { bar.classList.add('hidden'); bar.replaceChildren(); return; }
    bar.classList.remove('hidden');
    const p = activeProject();
    const rel = p ? relTo(p.path, currentFile) : baseName(currentFile);
    const segs = rel.split('/');
    bar.replaceChildren();
    segs.forEach((s, i) => { if (i) bar.appendChild(el('span', 'crumb-sep', '›')); bar.appendChild(el('span', 'crumb' + (i === segs.length - 1 ? ' crumb-file' : ''), s)); });
    const ln = state.doc.lineAt(state.selection.main.head).number;
    let cur = null; for (const s of currentSymbols()) { if (s.line <= ln) cur = s; else break; }
    if (cur) { bar.appendChild(el('span', 'crumb-sep', '›')); bar.appendChild(el('span', 'crumb crumb-sym', cur.name)); }
  }

  // --- A6: sticky scroll — заголовок области (функция/класс), чей заголовок ушёл вверх за экран, закреплён сверху.
  let stickyEl = null;
  function ensureSticky() {
    if (stickyEl) return stickyEl;
    stickyEl = el('div', 'cm-sticky-header hidden');
    stickyEl.addEventListener('click', () => { if (stickyEl._line) gotoLine(stickyEl._line); });
    $('#editor').appendChild(stickyEl);
    return stickyEl;
  }
  function updateSticky() {
    const s = ensureSticky();
    if (!currentFile || previewMode || diffMode || !editor) { s.classList.add('hidden'); return; }
    const syms = currentSymbols();
    if (!syms.length) { s.classList.add('hidden'); return; }
    let firstLine;
    try { const top = editor.scrollDOM.scrollTop; firstLine = editor.state.doc.lineAt(editor.lineBlockAtHeight(top + 1).from).number; } catch (_) { s.classList.add('hidden'); return; }
    // охватывающий символ = последний, чей заголовок выше первой видимой строки (т.е. уехал за верх экрана)
    let cur = null; for (const sym of syms) { if (sym.line < firstLine) cur = sym; else break; }
    if (!cur) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden'); s._line = cur.line;
    s.replaceChildren(el('span', 'sticky-kind ov-' + cur.kind, kindGlyph(cur.kind)), el('span', 'sticky-name', cur.name));
  }

  // --- универсальный оверлей со списком и фильтром (палитра Ctrl+P, структура, закладки) ---
  let _overlay = null;
  function closeOverlay() { document.querySelectorAll('.viewer-ov').forEach((n) => n.remove()); _overlay = null; }
  function openListOverlay(o) {
    closeOverlay();
    const root = el('div', 'viewer-ov'), box = el('div', 'viewer-ov-box' + (o.wide ? ' wide' : ''));
    const inp = el('input', 'viewer-ov-input'); inp.placeholder = o.placeholder || ''; inp.spellcheck = false;
    const list = el('div', 'viewer-ov-list');
    box.appendChild(inp); box.appendChild(list); root.appendChild(box); document.body.appendChild(root); _overlay = root;
    let items = [], active = 0;
    const highlight = () => { [...list.children].forEach((c, i) => c.classList.toggle('active', i === active)); const a = list.children[active]; if (a) a.scrollIntoView({ block: 'nearest' }); };
    const pick = (i) => { const it = items[i]; closeOverlay(); if (it) o.onPick(it); };
    function render(q) {
      items = o.filter(q) || []; active = 0; list.replaceChildren();
      items.slice(0, 500).forEach((it, i) => {
        const row = el('div', 'viewer-ov-row'); o.renderRow(row, it);
        row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
        row.addEventListener('mouseenter', () => { active = i; highlight(); });
        list.appendChild(row);
      });
      highlight();
    }
    inp.addEventListener('input', () => render(inp.value.trim()));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
    });
    root.addEventListener('mousedown', (e) => { if (e.target === root) closeOverlay(); });
    render(''); inp.focus();
  }
  // нечёткий ранкинг путей (подпоследовательность + бонусы за имя файла/смежность)
  function fuzzyScore(str, q) {
    let si = 0, score = 0, streak = 0;
    const base = str.slice(str.lastIndexOf('/') + 1);
    if (base.includes(q)) score += 50;
    for (let qi = 0; qi < q.length; qi++) { const idx = str.indexOf(q[qi], si); if (idx === -1) return -1; streak = idx === si ? streak + 1 : 0; score += 1 + streak; si = idx + 1; }
    return score - str.length * 0.01;
  }
  function fuzzyRank(listArr, q) {
    const ql = q.toLowerCase(), scored = [];
    for (const s of listArr) { const sc = fuzzyScore(s.toLowerCase(), ql); if (sc > -1) scored.push([sc, s]); }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.map((x) => x[1]);
  }

  // --- Ctrl+P: быстрое открытие файла (рекурсивный листинг проекта, кэш на проект) ---
  async function openPalette() {
    const p = activeProject(); if (!p) { toast('Нет активного проекта'); return; }
    if (!fileListCache || fileListCache.projPath !== p.path) {
      const r = await lite.fs.listAll(p.path);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      fileListCache = { projPath: p.path, files: ((r && r.files) || []).map((f) => f.replace(/\\/g, '/')) };
      if (r && r.capped) toast('Очень большой проект — показаны не все файлы', { ttl: 5000 });
    }
    const all = fileListCache.files;
    openListOverlay({
      placeholder: 'Открыть файл…  (часть имени или пути)',
      filter: (q) => {
        if (!q) { const rec = recentFiles.map((f) => relTo(p.path, f)).filter((r) => all.includes(r)); return [...new Set([...rec, ...all])].slice(0, 200); }
        return fuzzyRank(all, q).slice(0, 200);
      },
      renderRow: (row, rel) => { const segs = rel.split('/'); row.appendChild(el('span', 'ov-name', segs[segs.length - 1])); if (segs.length > 1) row.appendChild(el('span', 'ov-path', segs.slice(0, -1).join('/'))); },
      onPick: (rel) => { const abs = joinPath(p.path, rel); if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(abs)); },
    });
  }

  // --- Ctrl+Shift+F: поиск по всему проекту (grep на бэкенде) ---
  function openProjectSearch() {
    const p = activeProject(); if (!p) { toast('Нет активного проекта'); return; }
    closeOverlay();
    const root = el('div', 'viewer-ov'), box = el('div', 'viewer-ov-box wide');
    const inp = el('input', 'viewer-ov-input'); inp.placeholder = 'Найти в проекте…  (Enter — искать)'; inp.spellcheck = false;
    const csCb = el('input'); csCb.type = 'checkbox';
    const rxCb = el('input'); rxCb.type = 'checkbox';
    const cs = el('label', 'search-opt'); cs.title = 'Учитывать регистр'; cs.appendChild(csCb); cs.appendChild(el('span', null, 'Aa'));
    const rx = el('label', 'search-opt'); rx.title = 'Регулярное выражение'; rx.appendChild(rxCb); rx.appendChild(el('span', null, '.*'));
    const opts = el('div', 'search-opts'); opts.appendChild(cs); opts.appendChild(rx);
    const head = el('div', 'search-head'); head.appendChild(inp); head.appendChild(opts);
    const info = el('div', 'search-info');
    const list = el('div', 'viewer-ov-list search-list');
    box.appendChild(head); box.appendChild(info); box.appendChild(list); root.appendChild(box); document.body.appendChild(root); _overlay = root;
    let seq = 0, t;
    async function run() {
      const q = inp.value; if (!q) { list.replaceChildren(); info.textContent = ''; return; }
      const my = ++seq; info.textContent = 'Поиск…';
      const r = await lite.fs.search(p.path, q, { caseSensitive: csCb.checked, regex: rxCb.checked });
      if (my !== seq) return;
      if (r && r.error) { info.textContent = r.error; list.replaceChildren(); return; }
      const matches = (r && r.matches) || [];
      info.textContent = matches.length ? `Совпадений: ${matches.length}${r.capped ? '+ (показаны первые)' : ''}` : 'Ничего не найдено';
      list.replaceChildren();
      matches.forEach((mt) => {
        const file = mt.file.replace(/\\/g, '/');
        const row = el('div', 'viewer-ov-row search-row');
        row.appendChild(el('span', 'sr-loc', file + ':' + mt.line));
        row.appendChild(el('span', 'sr-text', mt.text.trim().slice(0, 200)));
        row.addEventListener('mousedown', (e) => { e.preventDefault(); closeOverlay(); const abs = joinPath(p.path, file); if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(abs, mt.line)); });
        list.appendChild(row);
      });
    }
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); run(); } else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); } });
    csCb.addEventListener('change', run); rxCb.addEventListener('change', run);
    root.addEventListener('mousedown', (e) => { if (e.target === root) closeOverlay(); });
    inp.focus();
  }

  // --- B12: список TODO/FIXME по проекту (grep на бэкенде) ---
  function showTodos() {
    const p = activeProject(); if (!p) { toast('Нет активного проекта'); return; }
    lite.fs.search(p.path, '\\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\\b', { regex: true, caseSensitive: true }).then((r) => {
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      const matches = ((r && r.matches) || []).map((mt) => ({ ...mt, file: mt.file.replace(/\\/g, '/') }));
      if (!matches.length) { toast('TODO/FIXME в проекте не найдены'); return; }
      openListOverlay({
        placeholder: `TODO / FIXME по проекту (${matches.length})…`,
        wide: true,
        filter: (q) => { const ql = q.toLowerCase(); return q ? matches.filter((it) => (it.file + ':' + it.line + ' ' + it.text).toLowerCase().includes(ql)) : matches; },
        renderRow: (row, mt) => {
          const kind = ((mt.text.match(/\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\b/i) || [])[1] || 'TODO').toUpperCase();
          row.appendChild(el('span', 'ov-kind ov-todo-' + kind.toLowerCase(), kind[0]));
          row.appendChild(el('span', 'ov-name', mt.text.trim().slice(0, 90)));
          row.appendChild(el('span', 'ov-path', mt.file + ':' + mt.line));
        },
        onPick: (mt) => { const abs = joinPath(p.path, mt.file); if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(abs, mt.line)); },
      });
    });
  }

  // ================================================================ C: режим агента (общий тогл)
  function toggleAgentMode() {
    agentMode = !agentMode;
    $('#viewer-agent').classList.toggle('on', agentMode);
    document.body.classList.toggle('agent-mode', agentMode);
    updateAuthorshipGutter();   // C21: показать/снять слой авторства
    updateReviewBadge();        // C18: показать/снять бейдж ревью
    if (agentMode) toast('Режим агента включён: ревью правок агента, слой авторства, «спросить агента» в меню кода');
  }

  // --- C20: «спросить агента про выделение» — собрать промпт и отправить в активный терминал (без Enter) ---
  function selectedCode() {
    if (!editor) return null;
    const sel = editor.state.selection.main;
    if (sel.empty) return null;
    return { text: editor.state.sliceDoc(sel.from, sel.to), fromLine: editor.state.doc.lineAt(sel.from).number, toLine: editor.state.doc.lineAt(sel.to).number };
  }
  function askAgent(action) {
    const sc = selectedCode(); if (!sc) { toast('Сначала выделите код'); return; }
    const p = activeProject();
    const rel = (p && currentFile) ? relTo(p.path, currentFile) : (currentFile ? baseName(currentFile) : 'файл');
    const verbs = { explain: 'Объясни, что делает', refactor: 'Отрефактори (улучшить читаемость и структуру, не меняя поведение)', test: 'Напиши тесты для' };
    const prompt = `${verbs[action]} следующий код из ${rel} (строки ${sc.fromLine}–${sc.toLine}):\n\n\`\`\`\n${sc.text}\n\`\`\`\n`;
    try { lite.editorBus.sendToTerminal(prompt); toast('Промпт отправлен в терминал — проверьте и нажмите Enter'); } catch (_) { toast('Не удалось отправить в терминал', { kind: 'err' }); }
  }
  function showEditorContextMenu(x, y) {
    const sc = selectedCode();
    closeMenus();
    const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '210px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    if (agentMode && sc) {
      dd.appendChild(menuRow('chat', 'Агент: объяснить код', () => { closeMenus(); askAgent('explain'); }));
      dd.appendChild(menuRow('wrench', 'Агент: отрефакторить', () => { closeMenus(); askAgent('refactor'); }));
      dd.appendChild(menuRow('check', 'Агент: написать тест', () => { closeMenus(); askAgent('test'); }));
      dd.appendChild(el('div', 'menu-sep'));
    }
    dd.appendChild(menuRow('copy', 'Копировать', () => { closeMenus(); try { document.execCommand('copy'); } catch (_) {} }));
    if (!agentMode) dd.appendChild(menuRow('terminal', 'Включить режим агента', () => { closeMenus(); toggleAgentMode(); }));
    placeMenu(dd, x, y);
  }

  // --- C18: ревью правок агента — бейдж «N изменённых файлов» + откат ханка в диффе ---
  async function updateReviewBadge() {
    const btn = $('#viewer-agent'); if (!btn) return;
    let badge = btn.querySelector('.agent-badge');
    if (!agentMode) { if (badge) badge.remove(); return; }
    const p = activeProject(); if (!p) { if (badge) badge.style.display = 'none'; return; }
    const st = await lite.git.status(p.path);
    const n = (st && st.files) ? Object.keys(st.files).length : 0;
    if (!badge) { badge = el('span', 'agent-badge'); btn.appendChild(badge); }
    badge.textContent = String(n); badge.style.display = n ? '' : 'none';
    btn.title = n ? `Режим агента — агент изменил ${n} файлов (клик по файлу в «Коммите» → дифф → откат ханка)` : 'Режим агента';
  }
  async function revertHunk(header, lines, hunkStart) {
    let end = lines.length;
    for (let i = hunkStart + 1; i < lines.length; i++) { if (lines[i].startsWith('@@')) { end = i; break; } }
    const patch = header.concat(lines.slice(hunkStart, end)).join('\n') + '\n';
    const proj = diffRevertTarget && diffRevertTarget.proj, f = diffRevertTarget && diffRevertTarget.file;
    if (!proj || !f) return;
    const r = await lite.git.revertHunk(proj, patch);
    if (!r || !r.ok) { toast((r && r.error) || 'не удалось откатить ханк', { kind: 'err', ttl: 8000 }); return; }
    toast('Ханк откачен');
    const rr = await lite.git.fileDiff(proj, f);
    if (diffMode && diffRevertTarget && diffRevertTarget.file === f) {
      if (rr && rr.diff && rr.diff.trim()) showDiff(rr.diff);
      else { exitDiff(false); clearGitDiff(); $('#viewer-filename').textContent = '—'; toast('Файл полностью возвращён к HEAD'); }
    }
    const p = activeProject(); if (p) renderTree(p);
    try { lite.editorBus.refreshProjects(); } catch (_) {}
    updateReviewBadge();
  }

  // --- структура файла (Ctrl+Shift+O / кнопка) ---
  function showOutline() {
    if (!currentFile) { toast('Нет открытого файла'); return; }
    const syms = currentSymbols();
    if (!syms.length) { toast('Символы в этом файле не распознаны'); return; }
    openListOverlay({
      placeholder: 'Перейти к символу…',
      filter: (q) => { const ql = q.toLowerCase(); return q ? syms.filter((s) => s.name.toLowerCase().includes(ql)) : syms; },
      renderRow: (row, s) => { row.appendChild(el('span', 'ov-kind ov-' + s.kind, kindGlyph(s.kind))); row.appendChild(el('span', 'ov-name', s.name)); row.appendChild(el('span', 'ov-path', ':' + s.line)); },
      onPick: (s) => { if (previewMode) exitPreview(); if (diffMode) exitDiff(true); gotoLine(s.line); },
    });
  }

  // --- история назад/вперёд + недавние ---
  function afterOpen(filePath) {
    addRecent(filePath); pushHistory(filePath); addTab(filePath); // гаттер закладок обновит setEditorText после загрузки дока
  }

  // --- колонка табов открытых файлов (вертикальная, между деревом и вивером; крестик справа закрывает) ---
  function addTab(filePath) {
    if (!openTabs.includes(filePath)) openTabs.push(filePath);
    renderTabs();
  }
  function closeTab(filePath) {
    const i = openTabs.indexOf(filePath);
    if (i < 0) return;
    const wasCurrent = filePath === currentFile;
    const proceed = () => {
      // соседний таб берём из ВИЗУАЛЬНОГО порядка (закреплённые впереди), а не из порядка открытия
      const ord = orderedTabs(); const vi = ord.indexOf(filePath);
      const next = ord[vi + 1] || ord[vi - 1] || null;
      const j = openTabs.indexOf(filePath);
      if (j >= 0) openTabs.splice(j, 1);
      if (wasCurrent) { if (next) openFile(next); else clearViewer(); } // нет больше табов → пустой редактор
      renderTabs();
    };
    // Закрываем активный с несохранённым — спросить (автосейв обычно уже сохранил, но подстрахуемся).
    if (wasCurrent) guardDirty(proceed); else proceed();
  }
  // Удаление файла/папки → закрыть её табы + выкинуть из истории/недавних; активный среди них → переключить.
  function dropTabsUnder(prefix) {
    const hadCurrent = currentFile && pathInside(currentFile, prefix);
    openTabs = openTabs.filter((t) => !pathInside(t, prefix));
    navStack = navStack.filter((t) => !pathInside(t, prefix)); navIdx = Math.min(navIdx, navStack.length - 1); updateNavButtons();
    for (let i = recentFiles.length - 1; i >= 0; i--) if (pathInside(recentFiles[i], prefix)) recentFiles.splice(i, 1);
    if (hadCurrent) { if (openTabs.length) openFile(openTabs[openTabs.length - 1]); else clearViewer(); }
    else renderTabs();
  }
  // Перенос/переименование задели открытый файл → подменить пути табов/истории/недавних под новый префикс.
  function remapTabs(oldPrefix, newPrefix) {
    const remap = (t) => (pathInside(t, oldPrefix) ? newPrefix + t.slice(oldPrefix.length) : t);
    const before = openTabs.join('\0');
    openTabs = openTabs.map(remap);
    navStack = navStack.map(remap);
    for (let i = 0; i < recentFiles.length; i++) recentFiles[i] = remap(recentFiles[i]);
    if (openTabs.join('\0') !== before) renderTabs();
  }
  // B17: закреплённые табы идут первыми (в порядке открытия), затем остальные.
  function orderedTabs() { return [...openTabs.filter((t) => pinnedTabs.has(t)), ...openTabs.filter((t) => !pinnedTabs.has(t))]; }
  function togglePin(t) { if (pinnedTabs.has(t)) pinnedTabs.delete(t); else pinnedTabs.add(t); renderTabs(); }
  // Массовое закрытие (закреплённые не трогаем). Активный среди закрываемых → guardDirty + переключение.
  function closeTabsList(paths) {
    const set = new Set(paths.filter((t) => !pinnedTabs.has(t)));
    if (!set.size) return;
    const closingCurrent = currentFile && set.has(currentFile);
    const apply = () => {
      openTabs = openTabs.filter((t) => !set.has(t));
      for (const t of set) pinnedTabs.delete(t);
      if (closingCurrent) { const next = openTabs[openTabs.length - 1]; if (next) openFile(next); else clearViewer(); }
      renderTabs();
    };
    if (closingCurrent) guardDirty(apply); else apply();
  }
  function closeOtherTabs(keep) { closeTabsList(openTabs.filter((t) => t !== keep)); }
  function closeTabsToRight(t) { const ord = orderedTabs(); const i = ord.indexOf(t); if (i < 0) return; closeTabsList(ord.slice(i + 1)); }
  function closeAllTabs() { closeTabsList([...openTabs]); }
  function showTabMenu(x, y, t) {
    closeMenus();
    const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '190px';
    dd.addEventListener('click', (e) => e.stopPropagation());
    dd.appendChild(menuRow(pinnedTabs.has(t) ? 'x' : 'flag', pinnedTabs.has(t) ? 'Открепить' : 'Закрепить', () => { closeMenus(); togglePin(t); }));
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(menuRow('x', 'Закрыть', () => { closeMenus(); closeTab(t); }));
    dd.appendChild(menuRow('eraser', 'Закрыть другие', () => { closeMenus(); closeOtherTabs(t); }));
    dd.appendChild(menuRow('chevron-down', 'Закрыть справа', () => { closeMenus(); closeTabsToRight(t); }));
    dd.appendChild(menuRow('trash', 'Закрыть все', () => { closeMenus(); closeAllTabs(); }, 'danger'));
    placeMenu(dd, x, y);
  }
  function renderTabs() {
    const pane = $('#tabs-pane'); if (!pane) return;
    const list = $('#tabs-list') || pane;   // табы — в список; футер-бар просмотра (#tabs-foot) НЕ трогаем
    const root = $('#module-root');
    list.replaceChildren();
    for (const t of [...pinnedTabs]) if (!openTabs.includes(t)) pinnedTabs.delete(t);  // прунинг исчезнувших
    // Колонку показываем только когда есть открытые файлы; иначе ширина 0 (грид-колонка схлопывается).
    if (root) root.style.setProperty('--tabs-w', openTabs.length ? '184px' : '0px');
    pane.classList.toggle('empty', !openTabs.length);
    for (const t of orderedTabs()) {
      const tab = el('div', 'ftab' + (t === currentFile ? ' active' : '') + (pinnedTabs.has(t) ? ' pinned' : ''));
      tab.title = t;
      const gc = gitClassFor(t); // та же цветовая кодировка статуса, что и в дереве
      const nm = el('span', 'ftab-name' + (gc ? ' ' + gc : ''), baseName(t));
      tab.appendChild(fileSvg(colorFor(t)));
      tab.appendChild(nm);
      const x = el('button', 'ftab-x'); x.title = pinnedTabs.has(t) ? 'Закреплён (ПКМ — меню)' : 'Закрыть';
      x.appendChild(icon(pinnedTabs.has(t) ? 'flag' : 'x', 12));
      x.addEventListener('click', (e) => { e.stopPropagation(); if (pinnedTabs.has(t)) togglePin(t); else closeTab(t); });
      tab.appendChild(x);
      tab.addEventListener('click', () => { if (t === currentFile) return; if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(t)); });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } }); // средняя кнопка — закрыть
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTabMenu(e.clientX, e.clientY, t); });
      list.appendChild(tab);
    }
  }
  function addRecent(p) { const i = recentFiles.indexOf(p); if (i >= 0) recentFiles.splice(i, 1); recentFiles.unshift(p); if (recentFiles.length > 30) recentFiles.pop(); }
  function pushHistory(p) {
    if (navJumping) return;
    if (navStack[navIdx] === p) return;
    navStack = navStack.slice(0, navIdx + 1); navStack.push(p);
    if (navStack.length > 100) navStack.shift();
    navIdx = navStack.length - 1; updateNavButtons();
  }
  function navOpenCurrent() { navJumping = true; const done = () => { navJumping = false; updateNavButtons(); }; openFile(navStack[navIdx]).then(done, done); }
  function navBack() { if (navIdx <= 0) return; guardDirty(() => { navIdx--; navOpenCurrent(); }); }
  function navFwd() { if (navIdx >= navStack.length - 1) return; guardDirty(() => { navIdx++; navOpenCurrent(); }); }
  function updateNavButtons() { const b = $('#viewer-back'), f = $('#viewer-fwd'); if (b) b.disabled = navIdx <= 0; if (f) f.disabled = navIdx >= navStack.length - 1; }

  // --- закладки (персист по проекту) ---
  function bmList() { const p = activeProject(); if (!p) return []; if (!bookmarks[p.id]) bookmarks[p.id] = []; return bookmarks[p.id]; }
  function saveBookmarks() { if (host.persist) host.persist('bookmarks', bookmarks); }
  function toggleBookmarkAt(line) {
    if (!currentFile) return;
    const list = bmList();
    const i = list.findIndex((b) => b.file === currentFile && b.line === line);
    if (i >= 0) list.splice(i, 1); else list.push({ file: currentFile, line });
    saveBookmarks(); refreshBookmarkGutter();
  }
  function refreshBookmarkGutter() {
    if (!editor) return;
    const lines = currentFile ? bmList().filter((b) => b.file === currentFile).map((b) => b.line) : [];
    editor.dispatch({ effects: setBookmarkGutterEffect.of(lines) });
  }
  // Правки сдвигают строки → хранимые номера закладок текущего файла маппим вслед за изменениями дока,
  // иначе клик по визуально-сместившейся звезде не найдёт закладку (и поставит дубль). Гаттер маппится сам.
  function remapBookmarks(u) {
    if (!currentFile || loadingDoc) return;          // на полной перезагрузке файла не маппим
    const old = u.startState.doc;
    let changed = false;
    for (const b of bmList()) {
      if (b.file !== currentFile || b.line < 1 || b.line > old.lines) continue;
      const newLine = u.state.doc.lineAt(u.changes.mapPos(old.line(b.line).from, 1)).number;
      if (newLine !== b.line) { b.line = newLine; changed = true; }
    }
    if (changed) saveBookmarks();
  }
  function toggleBookmarkHere() { if (!currentFile) { toast('Нет открытого файла'); return; } toggleBookmarkAt(editor.state.doc.lineAt(editor.state.selection.main.head).number); }
  function nextBookmark(dir) {
    if (!currentFile) return;
    const here = bmList().filter((b) => b.file === currentFile).map((b) => b.line).sort((a, b) => a - b);
    if (!here.length) { toast('В этом файле нет закладок'); return; }
    const cur = editor.state.doc.lineAt(editor.state.selection.main.head).number;
    let target;
    if (dir > 0) { target = here.find((l) => l > cur); if (target == null) target = here[0]; }
    else { const prev = here.filter((l) => l < cur); target = prev.length ? prev[prev.length - 1] : here[here.length - 1]; }
    gotoLine(target);
  }
  function showBookmarks() {
    const list = bmList();
    if (!list.length) { toast('Закладок нет. Поставьте на строке (Ctrl+F2)'); return; }
    const p = activeProject();
    openListOverlay({
      placeholder: 'Закладки проекта…',
      filter: (q) => { const ql = q.toLowerCase(); const items = list.map((b) => ({ ...b, rel: p ? relTo(p.path, b.file) : b.file })); return q ? items.filter((it) => (it.rel + ':' + it.line).toLowerCase().includes(ql)) : items; },
      renderRow: (row, b) => { row.appendChild(el('span', 'ov-name', baseName(b.file) + ':' + b.line)); row.appendChild(el('span', 'ov-path', b.rel)); },
      onPick: (b) => { if (!viewerOpen) setViewerOpen(true); guardDirty(() => openFile(b.file, b.line)); },
    });
  }

  // --- сравнение двух файлов (через git diff --no-index) ---
  function compareMenuRow(ent) {
    if (cmpFirst && cmpFirst !== ent.path) return menuRow('columns', `Сравнить с «${baseName(cmpFirst)}»`, () => { closeMenus(); const a = cmpFirst; cmpFirst = null; runCompare(a, ent.path); });
    return menuRow('columns', 'Выбрать для сравнения', () => { closeMenus(); cmpFirst = ent.path; toast(`«${baseName(ent.path)}» выбран — ПКМ по второму файлу → «Сравнить с…»`, { ttl: 6000 }); });
  }
  async function runCompare(a, b) {
    if (!viewerOpen) setViewerOpen(true);
    guardDirty(async () => {                         // не затереть несохранённые правки открытого файла
      const seq = ++openSeq;                         // токен гонки: за время diffPair могли открыть другой файл
      const r = await lite.fs.diffPair(a, b);
      if (seq !== openSeq) return;                   // обогнал более свежий open/дифф — не затираем его
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      currentFile = null; clearGitDiff();            // это сравнение, не редактируемый файл
      $('#viewer-filename').textContent = `${baseName(a)} ↔ ${baseName(b)}`;
      setEditorText('', []); markDirty(false); clearGitGutter();
      showDiff(r && r.diff ? r.diff : '');
      if (!(r && r.diff && r.diff.trim())) toast('Файлы идентичны');
    });
  }

  // ================================================================ встроенный Git (секции вивера)
  // Стрип: «Файлы»/«Коммит» — радио для ЛЕВОЙ колонки; «Ветки·История» — тогл НИЖНЕЙ панели (#log-pane).
  // Коммит (слева) и лог (снизу) могут быть открыты одновременно — git.renderPanel рендерит обе по флагам.
  function applySection(name) {
    if (name === 'branches') { toggleLog(); return; }
    curSection = name;
    // уходим на «Файлы», а в центре висит git-дифф/сравнение (currentFile===null) — снять его
    if (name === 'files' && diffMode && !currentFile) { exitDiff(false); clearGitDiff(); $('#viewer-filename').textContent = '—'; }
    $('#tree-pane').classList.toggle('hidden', name !== 'files');
    $('#commit-pane').classList.toggle('hidden', name !== 'commit');
    updateStrip();
  }
  function updateStrip() {
    document.querySelectorAll('.vcs-strip .strip-btn').forEach((b) => {
      const s = b.dataset.section;
      b.classList.toggle('active', s === 'branches' ? logOpen : s === curSection);
    });
  }
  // Перерисовать открытые git-секции (коммит и/или лог) по текущему состоянию.
  function gitRender() { if (git) git.renderPanel(activeProject(), { commit: curSection === 'commit', log: logOpen }); }
  function showSection(name) {
    if (name === 'branches') { openLog(); return; }
    applySection(name);
    gitRender();
  }
  function showCommitPane() { applySection('commit'); }  // для goCommitView из git-компонента (рендер делает вызвавший)

  // ---- нижняя панель «Ветки · История» (#log-pane): тогл + ресайз высоты (персист mwLogH)
  const LOG_H_DEFAULT = 280, LOG_MIN = 140, LOG_MAX = 620;
  function setLogHeight(h) { $('#module-root').style.setProperty('--log-h', h + 'px'); }
  function openLog() {
    if (!logOpen) {
      logOpen = true;
      $('#log-pane').classList.remove('hidden');
      const saved = host.STORE && host.STORE.mwLogH;
      setLogHeight(Math.max(LOG_MIN, Math.min(LOG_MAX, saved || LOG_H_DEFAULT)));
    }
    updateStrip();
    gitRender();
  }
  function closeLog() { logOpen = false; $('#log-pane').classList.add('hidden'); setLogHeight(0); updateStrip(); }
  function toggleLog() { if (logOpen) closeLog(); else openLog(); }
  // Дифф выбранного в гите файла — в ЦЕНТРЕ вивера (как в PhpStorm), переиспользуя diff-режим вивера.
  // gitDiffFile/gitDiffProj запоминаем, чтобы перечитывать дифф вживую при изменении файла на диске.
  let gitDiffFile = null, gitDiffProj = null;
  // C18: цель отката ханка — ЛЮБОЙ дифф «рабочее дерево vs HEAD» (из секции «Коммит» ИЛИ кнопки «дифф»),
  // но НЕ compare/commit-дифф. Отдельно от gitDiffFile (та — про live-reload показанного диффа).
  let diffRevertTarget = null;
  async function showGitDiff(projPath, file, label) {
    if (!viewerOpen) setViewerOpen(true);
    // guardDirty: не затереть несохранённые правки открытого файла молча (показ диффа очищает редактор).
    guardDirty(async () => {
      const seq = ++openSeq;                         // общий с openFile токен гонки «дифф ↔ открытие файла»
      gitDiffFile = file; gitDiffProj = projPath;
      const r = await lite.git.fileDiff(projPath, file);
      if (seq !== openSeq || gitDiffFile !== file) return; // обогнал более свежий показ/открытие
      currentFile = null;                            // это дифф, не редактируемый файл
      diffRevertTarget = { proj: projPath, file };   // HEAD-vs-working → откат ханка доступен
      $('#viewer-filename').textContent = (label && label.name) || baseName(file);
      setEditorText('', []); markDirty(false); clearGitGutter();
      showDiff(r && r.diff ? r.diff : '');
    });
  }
  function clearGitDiff() { gitDiffFile = null; gitDiffProj = null; diffRevertTarget = null; }

  // Показать произвольный текст диффа в центре вивера (для «Show Diff with Working Tree» по ветке и т.п.).
  function showRawDiff(label, diff) {
    if (!viewerOpen) setViewerOpen(true);
    guardDirty(() => {
      const seq = ++openSeq; clearGitDiff();
      void seq;
      currentFile = null;
      $('#viewer-filename').textContent = label || 'diff';
      setEditorText('', []); markDirty(false); clearGitGutter();
      showDiff(diff || '');
    });
  }

  // Дифф файла в КОНКРЕТНОМ коммите (клик в дереве файлов лога) — в центре вивера. Исторический,
  // без live-tracking (clearGitDiff): файл коммита на диске не меняется.
  async function showCommitDiff(projPath, hash, file, label) {
    if (!viewerOpen) setViewerOpen(true);
    guardDirty(async () => {
      const seq = ++openSeq;
      clearGitDiff();
      const r = await lite.git.commitFileDiff(projPath, hash, file);
      if (seq !== openSeq) return;
      currentFile = null;
      $('#viewer-filename').textContent = ((label && label.name) || baseName(file)) + ' @ ' + String(hash).slice(0, 8);
      setEditorText('', []); markDirty(false); clearGitGutter();
      showDiff(r && r.diff ? r.diff : '');
    });
  }

  // Ресайз левой колонки (дерево/коммит) перетаскиванием разделителя; ширина персистится.
  function wireLeftResize() {
    const g = $('#mw-gutter'), root = $('#module-root'); if (!g || !root) return;
    const STRIP_W = 42, MIN = 180, MAX = 640;
    const saved = host.STORE && host.STORE.mwLeft;
    if (saved) root.style.setProperty('--mw-left', Math.max(MIN, Math.min(MAX, saved)) + 'px');
    let dragging = false;
    g.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(MIN, Math.min(MAX, e.clientX - STRIP_W));
      root.style.setProperty('--mw-left', w + 'px');
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
      const w = parseInt(getComputedStyle(root).getPropertyValue('--mw-left'), 10) || 300;
      if (host.persist) host.persist('mwLeft', w);
    });
  }
  // Ресайз высоты нижней панели лога перетаскиванием верхней ручки; высота персистится (mwLogH).
  function wireLogResize() {
    const g = $('#log-resize'), root = $('#module-root'); if (!g || !root) return;
    let dragging = false;
    g.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const h = Math.max(LOG_MIN, Math.min(LOG_MAX, window.innerHeight - e.clientY));
      setLogHeight(h);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
      const h = parseInt(getComputedStyle(root).getPropertyValue('--log-h'), 10) || LOG_H_DEFAULT;
      if (host.persist) host.persist('mwLogH', h);
    });
  }

  // ---- DOM-биндинги (вивер + дерево). В embedded-режиме элементы живут в index.html;
  // после флипа в окно — те же id будут в module.html, mount() не меняется.
  function mount() {
    if (mounted) return;
    mounted = true;
    makeEditor();
    // встроенный Git: рендерит в VCS-полосу + секции; дифф файла — в центр вивера (showGitDiff).
    git = initGit({
      activeProject, getActiveId: host.getActiveId,
      renderProjects: () => { try { lite.editorBus.refreshProjects(); } catch (_) {} }, // обновить git-бейджи в сайдбаре редактора
      refreshTree: () => { const p = activeProject(); if (p) renderTree(p); },             // прямой рендер дерева (без IPC-петли)
      createCodeEditor: host.createCodeEditor, languageFor: host.languageFor,
      STORE: host.STORE, persist: host.persist,
      gitDiff: (projPath, file, label) => showGitDiff(projPath, file, label),
      commitDiff: (projPath, hash, file, label) => showCommitDiff(projPath, hash, file, label), // дифф файла из коммита (дерево лога)
      showRawDiff: (label, diff) => showRawDiff(label, diff), // произвольный дифф в центре (diff ветки vs рабочее дерево)
      showCommitPane: () => showCommitPane(),         // git-компонент просит показать секцию коммита (после merge/resolve)
      fileIcon: (name) => fileSvg(colorFor(name)),    // иконки типов файлов для дерева изменённых файлов коммита
      folderIcon: () => folderSvg(false),
    });
    git.setContainers({ topbar: $('#vcs-topbar'), commit: $('#commit-body'), branchlog: $('#branchlog-body') });
    document.querySelectorAll('.vcs-strip .strip-btn').forEach((b) => b.addEventListener('click', () => showSection(b.dataset.section)));
    $('#log-close').addEventListener('click', closeLog);
    wireLeftResize();
    wireLogResize();
    $('#viewer-save').addEventListener('click', saveCurrent);
    $('#viewer-back').addEventListener('click', navBack);
    $('#viewer-fwd').addEventListener('click', navFwd);
    $('#viewer-find').addEventListener('click', openProjectSearch);
    $('#viewer-outline').addEventListener('click', showOutline);
    $('#viewer-todos').addEventListener('click', showTodos);
    $('#viewer-blame').addEventListener('click', toggleBlame);
    $('#viewer-zen').addEventListener('click', toggleZen);
    $('#viewer-agent').addEventListener('click', toggleAgentMode);
    // C20: контекстное меню кода (агентские действия по выделению + копировать)
    editor.contentDOM.addEventListener('contextmenu', (e) => { e.preventDefault(); showEditorContextMenu(e.clientX, e.clientY); });
    $('#viewer-bookmark').addEventListener('click', toggleBookmarkHere);
    $('#viewer-bookmark').addEventListener('contextmenu', (e) => { e.preventDefault(); showBookmarks(); });
    $('#viewer-diff').addEventListener('click', toggleDiff);
    // Контекст-бар просмотра под колонкой табов: строим «иконка + подпись» в JS (иконка идёт ПЕРЕД текстом).
    for (const [sel, ic, label] of [['#viewer-preview', 'eye', 'Превью'], ['#viewer-split', 'grid', 'Рядом'],
      ['#viewer-full', 'maximize', 'Во весь экран'], ['#viewer-browser', 'globe', 'В браузере']]) {
      const b = $(sel); if (b) b.append(icon(ic, 15), el('span', 'tfoot-lbl', label));
    }
    $('#viewer-preview').addEventListener('click', togglePreview);
    $('#viewer-split').addEventListener('click', togglePreviewSplit);
    $('#viewer-full').addEventListener('click', togglePreviewFull);
    $('#viewer-browser').addEventListener('click', () => { if (currentFile) lite.openInBrowser(currentFile).then((r) => { if (r && r.error) toast(r.error, { kind: 'err' }); }); });
    $('#viewer-minimap').addEventListener('click', toggleMinimap);
    $('#viewer-minimap').classList.toggle('on', settings.minimap);
    $('#viewer-reload-apply').addEventListener('click', () => { hideReloadBar(); reloadCurrentFile(); });
    $('#viewer-reload-dismiss').addEventListener('click', () => hideReloadBar());
    $('#tree-refresh').addEventListener('click', () => { const p = activeProject(); if (p) renderTree(p); });
    $('#tree-new').addEventListener('click', (e) => { const p = activeProject(); if (p) showTreeMenu(e.clientX, e.clientY, { name: p.name, path: p.path, dir: true, root: true }); });
    $('#tree').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return; // row menus handle their own
      e.preventDefault();
      const p = activeProject(); if (p) showTreeMenu(e.clientX, e.clientY, { name: p.name, path: p.path, dir: true, root: true });
    });
    // Корневая зона drop: пустая область дерева = корень проекта (строки-папки перехватывают событие сами).
    $('#tree').addEventListener('dragover', (e) => {
      const p = activeProject(); if (!p) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = dragSrcPath ? 'move' : 'copy';
      setDropHL(null); $('#tree').classList.add('drag-over-root');
    });
    $('#tree').addEventListener('dragleave', (e) => { if (e.target === $('#tree')) $('#tree').classList.remove('drag-over-root'); });
    $('#tree').addEventListener('drop', (e) => {
      const p = activeProject(); if (!p) return;
      e.preventDefault(); e.stopPropagation();
      handleTreeDrop(e, p.path);
    });
    // Страховка от залипшей подсветки: внешний drag из ОС не шлёт dragend, и если его бросили мимо/вне окна,
    // рамка приёмника могла бы остаться. Снимаем её при выходе курсора за окно и на любом drop.
    window.addEventListener('drop', clearDropHL);
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDropHL(); });
    // Горячие клавиши окна вивера: Esc — выход из полноэкранного превью; Ctrl+S — сохранить (если фокус не
    // в редакторе — там сохраняет keymap Mod-s). e.code, не e.key — иначе в русской раскладке Ctrl+S → 'ы'.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('preview-full')) { e.preventDefault(); exitPreviewFull(); return; }
      if (e.key === 'Escape' && document.body.classList.contains('viewer-zen')) { e.preventDefault(); exitZen(); return; }
      if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); if (!(editor && editor.hasFocus)) saveCurrent(); return; }
      // Ctrl+P — открыть файл; Ctrl+Shift+F — поиск в проекте; Ctrl+Shift+O — структура файла.
      // e.code (а не e.key) — иначе в русской раскладке буквы не совпадут.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyP') { e.preventDefault(); openPalette(); return; }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); openProjectSearch(); return; }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyO') { e.preventDefault(); showOutline(); return; }
      // Alt+←/→ — назад/вперёд по истории файлов.
      if (e.altKey && e.code === 'ArrowLeft') { e.preventDefault(); navBack(); return; }
      if (e.altKey && e.code === 'ArrowRight') { e.preventDefault(); navFwd(); return; }
      // Ctrl+F2 — поставить/снять закладку; F2/Shift+F2 — следующая/предыдущая закладка в файле.
      if (e.ctrlKey && e.code === 'F2') { e.preventDefault(); toggleBookmarkHere(); return; }
      if (!e.ctrlKey && !e.altKey && e.key === 'F2') { e.preventDefault(); nextBookmark(e.shiftKey ? -1 : 1); return; }
    });
  }

  // Контракт окна модуля (module-entry зовёт setOpen при загрузке и при смене активного проекта).
  // Первый вызов строит редактор и рендерит вивер; повторный (смена проекта) — с защитой несохранённого.
  function setOpen(open, opts = {}) {
    if (!open) { if (host.closeWindow) host.closeWindow(); else setViewerOpen(false); return; }
    if (!mounted) mount();
    if (viewerOpen) { // окно уже открыто → это смена активного проекта: защитить правки и перерисовать
      guardDirty(() => { const p = activeProject(); pruneExpandedDirs(p ? p.path : ''); refreshViewerForActive(); });
      return;
    }
    return setViewerOpen(true, opts);
  }

  return {
    mount, setOpen,
    // состояние для ядра
    isOpen: () => viewerOpen,
    isDirty: () => dirty,
    currentFilePath: () => currentFile,
    editorHasFocus: () => !!(editor && editor.hasFocus),
    previewKindOfCurrent: () => previewKind(currentFile || ''),
    // действия
    setViewerOpen, openFile, guardDirty, saveCurrent, clearViewer,
    renderTree, refreshTree, refreshViewerForActive,
    toggleDiff, togglePreview, exitPreviewFull,
    showTreeMenu, onFsChange, pruneExpandedDirs,
    // dirty-guard на закрытие окна вивера: несохранённый файл → спросить (сохранить/не сохранять).
    confirmClose: (proceed) => { cancelAutosave(); clearTimeout(splitTimer); clearTimeout(fsTimer); guardDirty(proceed); },
    // «Git» из редактора → переключить левую секцию на «Коммит».
    focusGit: () => { if (!viewerOpen) setViewerOpen(true); showSection('commit'); },
  };
}
