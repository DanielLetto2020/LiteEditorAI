// Files module (v1.1+): code viewer (CodeMirror) + file tree.
// Изначально вивер+дерево жили прямо в ядре (renderer.js). Вынесены сюда как модуль `initFiles(host)`,
// чтобы (как остальные модули) уехать в отдельное окно. Вивер и дерево делят ИЗМЕНЯЕМОЕ состояние
// (currentFile/gitFiles/expandedDirs/dirty), поэтому живут вместе в одном модуле.
//
// Шаг 1 (embedded-first): редактор зовёт initFiles(host) и mount() — вивер работает как раньше,
// встроенно в #viewer-pane/#tree-pane index.html. Связь с ядром — только через host-колбэки
// (right-slot-машинерия: growBy/closeOtherPanels/renderProjects/saveUiState/refitActiveTerminal/меню).
// Шаг 2 — флип в окно: те же #viewer-pane/#tree-pane переедут в module.html, host станет window-host.
import { el, svgEl, toast, showConfirm, showPrompt, baseName } from '../ui.js';
import { languageFor } from '../codeedit.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, RangeSet } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { showMinimap } from '@replit/codemirror-minimap';
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
  const langComp = new Compartment();
  let openSeq = 0;                   // монотонный токен открытия — против гонки при быстром переключении файлов
  let dragSrcPath = null;            // путь перетаскиваемого узла (внутренний drag дерево→дерево)
  let dropHLRow = null;              // подсвеченная папка-приёмник
  let fsTimer = null;
  let mounted = false;               // mount() идемпотентен (окно строит редактор один раз)

  // ---------------------------------------------------------------- viewer (CodeMirror)
  // Миникарта (VSCode-стиль): уменьшенная копия кода справа с индикатором области и кликом-прыжком.
  const minimapExt = showMinimap.compute([], () => ({
    create: () => ({ dom: document.createElement('div') }),
    displayText: 'blocks',     // быстрый блочный рендер вместо посимвольного
    showOverlay: 'always',     // всегда показывать рамку текущей области
  }));
  const minimapComp = new Compartment(); // вкл/выкл миникарты без пересоздания редактора
  function toggleMinimap() {
    settings.minimap = !settings.minimap;
    host.saveSettings();
    if (editor) {
      editor.dispatch({ effects: minimapComp.reconfigure(settings.minimap ? minimapExt : []) });
      // При включении миникарта пустая, пока редактор не пере-замерит геометрию. Сработать заставляет только
      // реальное изменение размера панели вивера (ResizeObserver редактора) — повторяем это: на миг дёргаем
      // ширину панели на 1px и возвращаем (визуально незаметно).
      if (settings.minimap) {
        const pane = $('#viewer-pane'); const base = host.layout.viewer;
        pane.style.flexBasis = (base + 1) + 'px';
        setTimeout(() => { pane.style.flexBasis = base + 'px'; }, 60);
      }
    }
    $('#viewer-minimap').classList.toggle('on', settings.minimap);
  }
  function makeEditor() {
    const state = EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(), gitGutterField, gitGutterExt, highlightActiveLine(), drawSelection(), history(),
        indentOnInput(), bracketMatching(), highlightSelectionMatches(), search({ top: true }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
        minimapComp.of(settings.minimap ? minimapExt : []),
        langComp.of([]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { saveCurrent(); return true; } },
          indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => { if (u.docChanged && !loadingDoc) markDirty(true); }),
      ],
    });
    editor = new EditorView({ state, parent: $('#editor') });
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
    $('#viewer-preview').style.display = (kind && kind !== 'image') ? '' : 'none'; // toggle only when there's source too
    $('#viewer-full').style.display = (kind === 'html') ? '' : 'none'; // «на весь экран» только для HTML-вёрстки
    document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
    const row = document.querySelector(`.tree-row[data-path="${cssEscape(filePath)}"]`);
    if (row) row.classList.add('open');
  }
  async function openFile(filePath, line) {
    const seq = ++openSeq;
    if (diffMode) exitDiff(false);
    exitPreview();
    hideReloadBar();
    const kind = previewKind(filePath);

    if (kind === 'image') { // binary — no editable source
      currentFile = filePath;
      commitOpenUI(filePath, kind);
      setEditorText('', []); markDirty(false); clearGitGutter();
      await showPreview('image', filePath, '');
      return;
    }
    const res = await lite.fs.readFile(filePath);
    if (seq !== openSeq) return; // обогнал более свежий openFile — выходим, не затирая его результат
    if (res.error) { toast(res.error, { kind: 'err', ttl: 6000 }); return; } // оставляем текущий файл нетронутым
    currentFile = filePath;
    commitOpenUI(filePath, kind);
    setEditorText(res.content, languageFor(filePath));
    markDirty(false);
    updateGitGutter(filePath);
    // md/html по умолчанию открываются рендером; но если явно просили строку (переход из аудита/поиска) —
    // показываем исходник и прыгаем на строку, иначе номер строки потерялся бы в превью.
    if (kind && !(line && line > 0)) await showPreview(kind, filePath, res.content);
    else if (line && line > 0) requestAnimationFrame(() => { if (seq === openSeq) gotoLine(line); }); // не прыгать в чужом доке, если уже открыли другой файл
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
  async function showPreview(kind, file, content) {
    if (diffMode) exitDiff(false); // diff и preview взаимоисключающие — иначе оба оверлея накладываются
    previewMode = true;
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
    $('#editor').style.display = 'none';
    view.style.display = 'block';
    $('#viewer-preview').classList.add('on');
  }
  function exitPreview() {
    exitPreviewFull(); // на всякий случай свернуть полноэкранный режим
    previewMode = false;
    const v = $('#preview-view');
    if (v) { v.style.display = 'none'; v.innerHTML = ''; }
    $('#editor').style.display = '';
    $('#viewer-preview').classList.remove('on');
  }
  function togglePreview() {
    if (previewMode) { exitPreview(); editor.focus(); return; }
    const kind = previewKind(currentFile);
    if (kind) showPreview(kind, currentFile, editor.state.doc.toString());
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
    setEditorText(res.content, languageFor(currentFile));
    markDirty(false);
    hideReloadBar();
    updateGitGutter(currentFile);
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
  }
  function markDirty(v) { dirty = v; $('#viewer-dirty').classList.toggle('show', v); }
  // Плашка-конфликт: файл изменился на диске, пока у нас есть несохранённые правки (агент тронул открытый файл).
  // Постоянная (в отличие от тоста) — пока пользователь не решит: перечитать с диска или оставить своё.
  function showReloadBar() { $('#viewer-reload-bar').classList.remove('hidden'); }
  function hideReloadBar() { $('#viewer-reload-bar').classList.add('hidden'); }
  // Returns true when the file is safely on disk (or there was nothing to save), false on a
  // failed write. Callers that gate a destructive next step (guardDirty) must NOT proceed on
  // false, or the unsaved edits are lost.
  async function saveCurrent() {
    if (!currentFile || !dirty) return true;
    let res;
    try { res = await lite.fs.writeFile(currentFile, editor.state.doc.toString()); }
    catch (e) { res = { error: String(e) }; }
    if (res && res.ok) { markDirty(false); hideReloadBar(); updateGitGutter(currentFile); return true; }
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
      for (const ln of text.split('\n')) {
        let cls = '';
        if (ln.startsWith('@@')) cls = 'hunk';
        else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'meta';
        else if (ln.startsWith('+')) cls = 'add';
        else if (ln.startsWith('-')) cls = 'del';
        view.appendChild(el('div', 'diff-line ' + cls, ln || ' '));
      }
    }
    $('#editor').style.display = 'none';
    view.style.display = 'block';
    $('#viewer-diff').classList.add('on');
  }
  function exitDiff(refocus) {
    diffMode = false;
    $('#diff-view').style.display = 'none';
    $('#editor').style.display = '';
    $('#viewer-diff').classList.remove('on');
    if (refocus) editor.focus();
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
    exitPreview();
    currentFile = null;
    setEditorText('', []);
    clearGitGutter();
    hideReloadBar();
    $('#viewer-filename').textContent = '—';
    markDirty(false);
    document.querySelectorAll('.tree-row.open').forEach((r) => r.classList.remove('open'));
  }
  // Re-render the tree for the active project; viewer starts empty (no auto-reopen).
  // Switching/opening a project always gives a clean viewer — open files from the tree.
  // Нет выбранного проекта (открыта категория) → показываем заглушку вивера.
  async function refreshViewerForActive() {
    const p = activeProject();
    if (!p) { showViewerPlaceholder(); return; }
    await renderTree(p);
    clearViewer();
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
        await refreshTree();
      }
      return r;
    });
  }
  function treeDelete(ent) {
    showConfirm('Удалить?', `«${ent.name}» будет перемещён в корзину.`, 'Удалить', async () => {
      const r = await lite.fs.trash(ent.path);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      if (currentFile && pathInside(currentFile, ent.path)) clearViewer();
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
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => {
      if (viewerOpen) renderTree(p);
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

  // ---- DOM-биндинги (вивер + дерево). В embedded-режиме элементы живут в index.html;
  // после флипа в окно — те же id будут в module.html, mount() не меняется.
  function mount() {
    if (mounted) return;
    mounted = true;
    makeEditor();
    $('#viewer-save').addEventListener('click', saveCurrent);
    $('#viewer-diff').addEventListener('click', toggleDiff);
    $('#viewer-preview').addEventListener('click', togglePreview);
    $('#viewer-full').addEventListener('click', togglePreviewFull);
    $('#viewer-minimap').addEventListener('click', toggleMinimap);
    $('#viewer-minimap').classList.toggle('on', settings.minimap);
    // В окне (window-host) #viewer-close закрывает само окно; в иных хостах — сворачивает панель.
    $('#viewer-close').addEventListener('click', () => { if (host.closeWindow) host.closeWindow(); else setViewerOpen(false); });
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
      if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); if (!(editor && editor.hasFocus)) saveCurrent(); }
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
    openFileSearch: () => { if (viewerOpen && !previewMode) openSearchPanel(editor); },
  };
}
