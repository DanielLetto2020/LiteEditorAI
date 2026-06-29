// renderer/modules/textproc.js
// ============================================================================
// «Обработка текста» — изолированный модуль-ОКНО (module.html#doc). Документ-.md
// открывается СЛЕВА (CodeMirror-исходник + markdown/MathJax-превью), а общение с
// агентом — ПАНЕЛЬЮ СПРАВА (чат, а не модалка): «текст + общение».
//
// Возможности:
//  • Чат-панель: выделяешь фрагмент → он уходит в контекст справа → пишешь инструкцию →
//    локальный агент (Claude/Codex, headless `claude -p` / `codex exec`, по подписке, без
//    API-ключей) отвечает в ленту; ответ можно «Заменить выделенное»/«Вставить»/«Копировать».
//  • История изменений документа: каждый применённый AI-ответ снимает снапшот → можно откатить.
//  • MathJax (TeX→SVG, ленивая загрузка, строго в этом модуле) рендерит $…$ / $$…$$ в превью.
//  • Нумерация по абзацам (гаттер в исходнике + счётчик в превью).
//  • Закладки/маячки по документу для быстрого перехода.
//  • Панель форматирования (жирный/курсив/списки/заголовки/ссылки/таблицы/формулы…).
//
// ⚠️ ИЗОЛЯЦИЯ: модуль НЕ лезет во внутренности renderer.js. Вся связь — через host,
// переданный в initTextProc(host). MathJax импортируется ТОЛЬКО здесь и лениво.
// host = {
//   el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast, renderDiffInto?, // UI-хелперы
//   STORE, persist, settings, saveSettings,                                        // состояние
//   layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels,            // контракт панели
// }
// Экспортирует: { isOpen(), setOpen(open,opts), toggle(), showSettings() }.
// ============================================================================
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { Marked } from 'marked';

// Markdown-превью БЕЗ проброса «сырого» HTML и БЕЗ опасных схем в ссылках/картинках.
const tpEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tpSafeHref = (h) => /^(https?:|mailto:|#|\/|\.)/i.test(h || '');
const tpSafeImg = (h) => /^(https?:|\/|\.)/i.test(h || '');
const mdRender = new Marked({ gfm: true, breaks: true });
mdRender.use({ renderer: {
  html: () => '',
  link(token) {
    const text = this.parser.parseInline(token.tokens);
    if (!tpSafeHref(token.href)) return text;
    return `<a href="${tpEsc(token.href)}"${token.title ? ` title="${tpEsc(token.title)}"` : ''}>${text}</a>`;
  },
  image(token) {
    if (!tpSafeImg(token.href)) return tpEsc(token.text || '');
    return `<img src="${tpEsc(token.href)}" alt="${tpEsc(token.text || '')}">`;
  },
} });

// ---- MathJax: лениво (грузится только при первом превью с формулой; строго в этом модуле) ----
let mjReady = null;
function ensureMathJax() {
  if (mjReady) return mjReady;
  mjReady = (async () => {
    const [{ mathjax }, { TeX }, { SVG }, { browserAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/browserAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
    ]);
    const adaptor = browserAdaptor();
    RegisterHTMLHandler(adaptor);
    // MathJax v3 по умолчанию НЕ ловит $…$ — включаем явно (как в научных текстах).
    const tex = new TeX({ packages: AllPackages, inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] });
    const svg = new SVG({ fontCache: 'none' });
    return { mathjax, tex, svg };
  })().catch((e) => { mjReady = null; throw e; });
  return mjReady;
}
// Защищаем формулы от markdown: вырезаем в плейсхолдеры ДО парсинга, возвращаем (экранированными) ПОСЛЕ.
function protectMath(src) {
  const store = [];
  const ph = (m) => { const i = store.length; store.push(m); return 'xMATHJAXx' + i + 'x'; };
  let s = String(src || '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (m) => ph(m))
    .replace(/\\\[([\s\S]+?)\\\]/g, (m) => ph(m))
    .replace(/\\\(([\s\S]+?)\\\)/g, (m) => ph(m))
    .replace(/(?<![\\$])\$(?!\s)([^\n$]+?)(?<![\s\\])\$(?!\$)/g, (m) => ph(m));
  return { s, store };
}

const $ = (s) => document.querySelector(s);

export function initTextProc(host) {
  const { el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast,
          STORE, persist, settings, saveSettings,
          layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;
  const lite = window.lite;

  // ---- состояние панели ----
  let docOpen = false;
  let curDocId = null;

  // ---------------------------------------------------------------- state
  let docs = Array.isArray(STORE.textproc) ? STORE.textproc : [];      // [{id,name,file,md,bookmarks?}]
  let prompts = normPrompts(STORE.tpPrompts);                          // {system:[],user:[]}
  let histStore = (STORE.tpHistory && typeof STORE.tpHistory === 'object') ? STORE.tpHistory : {}; // {docId:[{ts,label,before}]}
  let tpDir = '';
  lite.tp.dir().then((d) => { tpDir = d || ''; }).catch(() => {});

  let editor = null;
  let loadedId = null;
  let loadingDoc = false;
  let dirty = false;
  let saveTimer = null;
  let curMd = false;
  let mdView = 'split';        // 'raw' | 'rendered' | 'split'
  let lastSel = null;          // {from,to,text} последнего непустого выделения
  let selPinned = false;       // закреплён ли фрагмент в чате
  let paraNum = false;         // нумерация по абзацам включена
  let aiSeq = 0;
  let wired = false;

  // ---- чат ----
  let chat = [];               // [{role:'user'|'agent', text?, sel?, versions?:[], cur?, busy?, error?, reqId?, off?}]
  let chatAgent = settings.tpAgent === 'codex' ? 'codex' : 'claude';
  let chatSysId = null;        // выбранный системный промпт в чате

  function normPrompts(p) {
    p = p && typeof p === 'object' ? p : {};
    return { system: Array.isArray(p.system) ? p.system : [], user: Array.isArray(p.user) ? p.user : [] };
  }
  function saveDocs() { persist('textproc', docs); }
  function savePrompts() { persist('tpPrompts', prompts); }
  function saveHist() { persist('tpHistory', histStore); }
  function uid(pfx) { return pfx + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
  function isMdFile(f) { return /\.(md|markdown)$/i.test(f || ''); }
  function docPath(doc) { return tpDir + '/' + doc.file; }
  function slugFile(name) {
    let s = String(name).trim().toLowerCase().replace(/[^\wа-яё.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!s) s = 'doc-' + Date.now().toString(36);
    if (!/\.[a-z0-9]+$/i.test(s)) s += '.md';
    return s;
  }
  async function uniqueFile(file) {
    let f = file, i = 1;
    const has = async (n) => { try { return await lite.fs.exists(tpDir + '/' + n); } catch { return false; } };
    while (await has(f)) { const dot = file.lastIndexOf('.'); f = dot > 0 ? file.slice(0, dot) + '-' + i + file.slice(dot) : file + '-' + i; i++; }
    return f;
  }
  function curDoc() { return docs.find((d) => d.id === loadedId) || null; }

  // ================================================================ вкладки документов
  function renderDocTabs() {
    const bar = $('#doc-tabs'); if (!bar) return;
    bar.innerHTML = '';
    for (const d of docs) {
      const tab = el('div', 'tab' + (d.id === curDocId ? ' active' : ''));
      tab.dataset.docid = d.id;
      tab.appendChild(el('span', 'tab-name', d.name));
      tab.title = d.name + '  ·  ' + d.file + '  (двойной клик — переименовать)';
      const x = iconBtn('tab-close', 'x', 'Удалить документ', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); delDoc(d); });
      tab.appendChild(x);
      tab.addEventListener('click', () => openDoc(d.id));
      tab.addEventListener('dblclick', () => renameDoc(d));
      bar.appendChild(tab);
    }
    const add = iconBtn('tab-add', 'plus', 'Новый документ', 15);
    add.addEventListener('click', () => newDoc());
    bar.appendChild(add);
  }

  // ---- doc CRUD ----
  function newDoc() {
    showPrompt('Новый документ', 'Название (станет заголовком и именем файла)', '', async (name) => {
      const t = (name || '').trim(); if (!t) return;
      if (!tpDir) tpDir = await lite.tp.dir();
      const file = await uniqueFile(slugFile(t));
      const r = await lite.fs.writeFile(tpDir + '/' + file, '');
      if (r && r.error) { toast('Не удалось создать файл: ' + r.error, { kind: 'err', ttl: 6000 }); return; }
      const doc = { id: uid('doc'), name: t, file, md: isMdFile(file), bookmarks: [] };
      docs.push(doc); saveDocs(); renderDocTabs();
      openDoc(doc.id);
    });
  }
  function renameDoc(doc) {
    showPrompt('Переименовать заголовок', 'Заголовок (файл на диске не меняется)', doc.name, (v) => {
      const t = (v || '').trim(); if (!t) return;
      doc.name = t; saveDocs(); renderDocTabs();
      if (doc.id === curDocId) { const ttl = $('#doc-title'); if (ttl) ttl.textContent = t; }
    });
  }
  function delDoc(doc) {
    showConfirm('Удалить документ?', `«${doc.name}» (${doc.file}) будет перемещён в корзину.`, 'Удалить', async () => {
      try { await lite.fs.trash(tpDir + '/' + doc.file); } catch (_) {}
      docs = docs.filter((d) => d.id !== doc.id); saveDocs();
      delete histStore[doc.id]; saveHist();
      if (doc.id === curDocId) { loadedId = null; curDocId = null; if (docOpen) showDocPlaceholder(); }
      renderDocTabs();
    });
  }

  // ================================================================ CodeMirror: гаттеры абзацев и закладок
  // Карта «номер строки → номер абзаца» (0 = не начало абзаца). Пересчёт на каждое изменение.
  const paraField = StateField.define({
    create: computeParas,
    update: (v, tr) => (tr.docChanged ? computeParas(tr.state) : v),
  });
  function computeParas(state) {
    const arr = [0]; let para = 0, inPara = false;
    const doc = state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const t = doc.line(i).text;
      if (!t.trim()) { inPara = false; arr[i] = 0; }
      else if (!inPara) { para++; inPara = true; arr[i] = para; }
      else arr[i] = 0;
    }
    return arr;
  }
  class NumMarker extends GutterMarker { constructor(n) { super(); this.n = n; } toDOM() { return document.createTextNode(String(this.n)); } }
  const paraGutter = gutter({
    class: 'cm-para-gutter',
    lineMarker(view, line) {
      const arr = view.state.field(paraField, false); if (!arr) return null;
      const ln = view.state.doc.lineAt(line.from).number;
      return arr[ln] ? new NumMarker(arr[ln]) : null;
    },
    lineMarkerChange: (u) => u.docChanged,
  });
  const lineNumComp = new Compartment(); // lineNumbers() ↔ paraGutter

  // Закладки: гаттер-маркер на отмеченных строках (пересобирается через компартмент при изменении).
  class BmMarker extends GutterMarker { toDOM() { const s = document.createElement('span'); s.className = 'cm-bm-dot'; s.appendChild(icon('bookmark', 12)); return s; } }
  const bmComp = new Compartment();
  function buildBmGutter() {
    const doc = curDoc();
    const lines = new Set((doc && doc.bookmarks || []).map((b) => b.line));
    if (!lines.size) return [];
    return gutter({
      class: 'cm-bm-gutter',
      lineMarker(view, line) {
        const ln = view.state.doc.lineAt(line.from).number;
        return lines.has(ln) ? new BmMarker() : null;
      },
    });
  }
  function refreshBmGutter() { if (editor) editor.dispatch({ effects: bmComp.reconfigure(buildBmGutter()) }); }

  // ================================================================ editor / view
  const langComp = new Compartment();
  function ensureEditor() {
    if (editor) return;
    const state = EditorState.create({
      doc: '',
      extensions: [
        paraField,
        lineNumComp.of(lineNumbers()),
        bmComp.of([]),
        highlightActiveLine(), drawSelection(), history(),
        indentOnInput(), bracketMatching(), highlightSelectionMatches(), search({ top: true }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
        langComp.of([]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { flushSave(); return true; } },
          { key: 'Mod-b', preventDefault: true, run: () => { wrapSel('**', '**'); return true; } },
          { key: 'Mod-i', preventDefault: true, run: () => { wrapSel('*', '*'); return true; } },
          indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !loadingDoc) { markDirty(true); scheduleSave(); if (mdVisible()) updatePreview(); }
          if (u.selectionSet || u.docChanged) { refreshAiBtn(); }
        }),
      ],
    });
    editor = new EditorView({ state, parent: $('#doc-editor') });
    if (!wired) {
      wired = true;
      const ed = $('#doc-editor');
      ed.addEventListener('scroll', hideAi, true);
      const btn = $('#doc-ai-btn');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (lastSel) { setChatOpen(true); focusChatInput(); } });
      wireChat();
      wireChatGutter();
    }
  }
  function setText(text) {
    loadingDoc = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text || '' }, effects: langComp.reconfigure(curMd ? markdown() : []) });
    loadingDoc = false;
  }
  function markDirty(v) {
    dirty = v;
    const s = $('#doc-saved'); if (!s) return;
    s.textContent = v ? '● не сохранено' : 'сохранено';
    s.classList.toggle('dirty', v);
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600); }
  async function flushSave() {
    clearTimeout(saveTimer);
    if (!editor || loadedId == null || !dirty) return;
    const doc = curDoc(); if (!doc) return;
    try { const r = await lite.fs.writeFile(docPath(doc), editor.state.doc.toString()); if (r && r.ok) markDirty(false); }
    catch (_) {}
  }
  async function loadDoc(id) {
    const doc = docs.find((d) => d.id === id); if (!doc) return;
    loadedId = id;
    curMd = doc.md != null ? !!doc.md : isMdFile(doc.file);
    mdView = 'split';
    if (!Array.isArray(doc.bookmarks)) doc.bookmarks = [];
    let content = '';
    const res = await lite.fs.readFile(docPath(doc));
    if (res && res.content != null) content = res.content;
    else if (res && res.error) toast('Не открыть «' + doc.file + '»: ' + res.error, { kind: 'err', ttl: 6000 });
    setText(content);
    markDirty(false);
    refreshBmGutter();
    resetChat();
    renderFormatBar(); renderToolbar();
    applyView();
    hideAi();
  }

  function sync(id) {
    if (id == null) { flushSave(); hideAi(); return; }
    ensureEditor();
    if (id !== loadedId) { flushSave(); loadDoc(id); }
    else { renderFormatBar(); renderToolbar(); applyView(); }
    setTimeout(() => { try { editor.focus(); } catch (_) {} requestMeasure(); }, 30);
  }
  function requestMeasure() { try { editor && editor.requestMeasure(); } catch (_) {} }

  // ================================================================ панель (окно)
  function showDocPlaceholder() {
    const ttl = $('#doc-title'); if (ttl) ttl.textContent = 'Обработка текста';
    const bar = $('#doc-modes'); if (bar) bar.innerHTML = '';
    const fb = $('#doc-format'); if (fb) fb.innerHTML = '';
    const s = $('#doc-saved'); if (s) { s.textContent = ''; s.classList.remove('dirty'); }
    if (editor) setText('');
    resetChat(); hideAi();
  }
  function setDocOpen(open, opts = {}) {
    if (open === docOpen) { if (open) { if (curDocId) sync(curDocId); else showDocPlaceholder(); } return; }
    if (open) closeOtherPanels('doc');
    const delta = layout.doc + GUTTER;
    docOpen = open;
    $('#doc-pane').classList.toggle('hidden', !open);
    $('#gutter-doc').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) {
      applyChatLayout();
      renderDocTabs(); ensureEditor();
      if (curDocId) sync(curDocId); else showDocPlaceholder();
    } else { flushSave(); hideAi(); }
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleDoc() { setDocOpen(!docOpen); }
  function openDoc(id) {
    curDocId = id;
    renderDocTabs();
    if (!docOpen) setDocOpen(true);
    else sync(id);
  }

  // ---- toolbar: режимы (Текст/MD, виды, нумерация, AI) ----
  function renderToolbar() {
    const bar = $('#doc-modes'); if (!bar) return; bar.innerHTML = '';
    const doc = curDoc();
    const ttl = $('#doc-title'); if (ttl) ttl.textContent = doc ? doc.name : '';
    bar.appendChild(modeBtn('Текст', !curMd, () => setKind(false)));
    bar.appendChild(modeBtn('MD', curMd, () => setKind(true)));
    if (curMd) {
      bar.appendChild(el('span', 'doc-sep'));
      bar.appendChild(modeBtn('Сырой', mdView === 'raw', () => setMdView('raw')));
      bar.appendChild(modeBtn('Оформленный', mdView === 'rendered', () => setMdView('rendered')));
      bar.appendChild(modeBtn('Совместно', mdView === 'split', () => setMdView('split')));
    }
    bar.appendChild(el('span', 'doc-sep'));
    bar.appendChild(modeBtn('№ абзацы', paraNum, () => setParaNum(!paraNum)));
    const aiOn = !$('#doc-pane').classList.contains('chat-collapsed');
    bar.appendChild(modeBtn('✦ AI', aiOn, () => setChatOpen(!aiOn)));
  }
  function modeBtn(label, on, fn) { const b = el('button', 'doc-mode' + (on ? ' on' : ''), label); b.onclick = fn; return b; }
  function setKind(md) {
    if (curMd === md) return;
    curMd = md;
    const doc = curDoc(); if (doc) { doc.md = md; saveDocs(); }
    if (editor) editor.dispatch({ effects: langComp.reconfigure(md ? markdown() : []) });
    if (md) mdView = 'split';
    renderToolbar(); applyView();
  }
  function setMdView(v) { mdView = v; renderToolbar(); applyView(); requestMeasure(); }
  function setParaNum(on) {
    paraNum = on;
    if (editor) editor.dispatch({ effects: lineNumComp.reconfigure(on ? paraGutter : lineNumbers()) });
    const pv = $('#doc-preview'); if (pv) pv.classList.toggle('numbered', on);
    renderToolbar();
  }

  function mdVisible() { return curMd && (mdView === 'rendered' || mdView === 'split'); }
  function applyView() {
    const ed = $('#doc-editor'), pv = $('#doc-preview'), body = $('#doc-body');
    if (!ed || !pv || !body) return;
    const showPrev = curMd && (mdView === 'rendered' || mdView === 'split');
    const showEd = !curMd || mdView === 'raw' || mdView === 'split';
    ed.style.display = showEd ? '' : 'none';
    pv.style.display = showPrev ? '' : 'none';
    pv.classList.toggle('numbered', paraNum);
    body.classList.toggle('split', curMd && mdView === 'split');
    if (showPrev) updatePreview();
    if (!showEd) hideAi();
  }
  function updatePreview() {
    const pv = $('#doc-preview'); if (!pv || !editor) return;
    const src = editor.state.doc.toString();
    const { s, store } = protectMath(src);
    let html;
    try { html = mdRender.parse(s || ''); } catch (_) { pv.textContent = src; return; }
    if (store.length) html = html.replace(/xMATHJAXx(\d+)x/g, (_m, i) => tpEsc(store[+i] || ''));
    pv.innerHTML = html;
    if (store.length) typesetMath(pv);
  }
  async function typesetMath(pv) {
    try {
      const { mathjax, tex, svg } = await ensureMathJax();
      const mjDoc = mathjax.document(document, { InputJax: tex, OutputJax: svg });
      mjDoc.findMath({ elements: [pv] }).compile().getMetrics().typeset().updateDocument();
    } catch (e) { /* формулы остаются как текст */ }
  }

  // ================================================================ панель форматирования (п.8)
  function curRange() { const s = editor.state.selection.main; return { from: s.from, to: s.to }; }
  function wrapSel(b, a) {
    a = a == null ? b : a;
    const st = editor.state; const { from, to } = st.selection.main;
    const text = st.sliceDoc(from, to);
    if (text.startsWith(b) && text.endsWith(a) && text.length >= b.length + a.length) {
      const insert = text.slice(b.length, text.length - a.length);
      editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from, head: from + insert.length } });
    } else {
      const insert = b + text + a;
      editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + b.length, head: from + b.length + text.length } });
    }
    editor.focus();
  }
  function prefixLines(prefix, ordered) {
    const st = editor.state; const { from, to } = st.selection.main;
    const a = st.doc.lineAt(from).number, z = st.doc.lineAt(Math.max(from, to)).number;
    const changes = []; let n = 1;
    for (let i = a; i <= z; i++) { const line = st.doc.line(i); changes.push({ from: line.from, to: line.from, insert: ordered ? (n++) + '. ' : prefix }); }
    editor.dispatch({ changes }); editor.focus();
  }
  function setHeading(level) {
    const st = editor.state; const line = st.doc.lineAt(st.selection.main.from);
    const text = line.text.replace(/^#{1,6}\s*/, '');
    const insert = level === 0 ? text : '#'.repeat(level) + ' ' + text;
    editor.dispatch({ changes: { from: line.from, to: line.to, insert } }); editor.focus();
  }
  function insertBlock(text) {
    const st = editor.state; const line = st.doc.lineAt(st.selection.main.from);
    const at = line.to;
    editor.dispatch({ changes: { from: at, to: at, insert: '\n' + text + '\n' }, selection: { anchor: at + 1 + text.length } });
    editor.focus();
  }
  function insertLink() {
    const st = editor.state; const { from, to } = st.selection.main; const text = st.sliceDoc(from, to) || 'текст';
    showPrompt('Ссылка', 'URL', 'https://', (url) => {
      const u = (url || '').trim() || 'https://';
      editor.dispatch({ changes: { from, to, insert: `[${text}](${u})` } }); editor.focus();
    });
  }
  function insertImage() {
    const st = editor.state; const { from, to } = st.selection.main; const alt = st.sliceDoc(from, to) || 'картинка';
    showPrompt('Картинка', 'URL изображения', 'https://', (url) => {
      const u = (url || '').trim() || 'https://';
      editor.dispatch({ changes: { from, to, insert: `![${alt}](${u})` } }); editor.focus();
    });
  }
  function renderFormatBar() {
    const bar = $('#doc-format'); if (!bar) return; bar.innerHTML = '';
    const grp = () => { const g = el('div', 'fmt-grp'); bar.appendChild(g); return g; };
    const add = (g, name, title, fn, size) => { const b = iconBtn('fmt-btn', name, title, size || 16); b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; g.appendChild(b); return b; };
    const lbl = (g, text, title, fn) => { const b = el('button', 'fmt-btn fmt-txt', text); b.title = title; b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; g.appendChild(b); return b; };

    let g = grp();
    add(g, 'bold', 'Жирный (Ctrl+B)', () => wrapSel('**', '**'));
    add(g, 'italic', 'Курсив (Ctrl+I)', () => wrapSel('*', '*'));
    add(g, 'strikethrough', 'Зачёркнутый', () => wrapSel('~~', '~~'));
    add(g, 'code', 'Код в строке', () => wrapSel('`', '`'));

    g = grp();
    lbl(g, 'H1', 'Заголовок 1', () => setHeading(1));
    lbl(g, 'H2', 'Заголовок 2', () => setHeading(2));
    lbl(g, 'H3', 'Заголовок 3', () => setHeading(3));
    lbl(g, '¶', 'Обычный абзац (снять заголовок)', () => setHeading(0));

    g = grp();
    add(g, 'list', 'Маркированный список', () => prefixLines('- '));
    add(g, 'list-ordered', 'Нумерованный список', () => prefixLines(null, true));
    add(g, 'quote', 'Цитата', () => prefixLines('> '));
    add(g, 'braces', 'Блок кода', () => insertBlock('```\n\n```'));

    g = grp();
    add(g, 'link', 'Ссылка', insertLink);
    add(g, 'image', 'Картинка', insertImage);
    add(g, 'table', 'Таблица', () => insertBlock('| Колонка | Колонка |\n| --- | --- |\n| ячейка | ячейка |'));
    add(g, 'minus', 'Горизонтальная линия', () => insertBlock('---'));

    g = grp();
    lbl(g, 'ƒx', 'Формула в строке  $…$', () => wrapSel('$', '$'));
    add(g, 'sigma', 'Блок формулы  $$…$$', () => insertBlock('$$\n\n$$'));

    g = grp();
    add(g, 'bookmark', 'Поставить закладку на текущей строке', addBookmarkHere);
  }

  // ---- floating «AI» над выделением ----
  function refreshAiBtn() {
    if (!editor) return hideAi();
    if (!selPinned) captureSel();
    if (curMd && mdView === 'rendered') return hideAi();
    const sel = editor.state.selection.main;
    if (sel.empty) return hideAi();
    const text = editor.state.sliceDoc(sel.from, sel.to);
    if (!text.trim()) return hideAi();
    renderChatCtx();
    const coords = editor.coordsAtPos(sel.head) || editor.coordsAtPos(sel.from);
    const body = $('#doc-body'); if (!coords || !body) return hideAi();
    const box = body.getBoundingClientRect();
    const btn = $('#doc-ai-btn');
    btn.style.display = '';
    let top = coords.top - box.top - 30;
    if (top < 2) top = coords.bottom - box.top + 6;
    btn.style.left = Math.max(4, Math.min(coords.left - box.left, box.width - 48)) + 'px';
    btn.style.top = top + 'px';
  }
  function hideAi() { const b = $('#doc-ai-btn'); if (b) b.style.display = 'none'; }
  function captureSel() {
    if (!editor) return;
    const sel = editor.state.selection.main;
    if (sel.empty) return;
    const text = editor.state.sliceDoc(sel.from, sel.to);
    if (text.trim()) { lastSel = { from: sel.from, to: sel.to, text }; renderChatCtx(); }
  }

  // ================================================================ ЗАКЛАДКИ (п.7)
  function addBookmarkHere() {
    const doc = curDoc(); if (!doc || !editor) return;
    const line = editor.state.doc.lineAt(editor.state.selection.main.from);
    const def = (line.text.trim().slice(0, 40)) || ('Строка ' + line.number);
    showPrompt('Закладка', 'Название', def, (name) => {
      const t = (name || '').trim() || def;
      doc.bookmarks = (doc.bookmarks || []).filter((b) => b.line !== line.number);
      doc.bookmarks.push({ id: uid('bm'), name: t, line: line.number });
      doc.bookmarks.sort((a, b) => a.line - b.line);
      saveDocs(); refreshBmGutter();
      toast('Закладка поставлена', { ttl: 1500 });
    });
  }
  function jumpToBookmark(b) {
    if (!editor) return;
    const ln = Math.min(b.line, editor.state.doc.lines);
    const line = editor.state.doc.line(ln);
    editor.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    editor.focus();
  }
  function openBookmarksMenu(anchor) {
    closePopover();
    const doc = curDoc();
    const pop = el('div', 'doc-popover');
    pop.appendChild(el('div', 'doc-pop-title', 'Закладки'));
    const list = (doc && doc.bookmarks) || [];
    if (!list.length) pop.appendChild(el('div', 'doc-pop-empty', 'Пока нет. Поставьте закладку кнопкой 🔖 на панели форматирования.'));
    for (const b of list) {
      const row = el('div', 'doc-pop-row');
      const go = el('button', 'doc-pop-go');
      go.appendChild(icon('bookmark', 13));
      go.appendChild(el('span', 'doc-pop-name', b.name));
      go.appendChild(el('span', 'doc-pop-line', '#' + b.line));
      go.onclick = () => { jumpToBookmark(b); closePopover(); };
      const rm = iconBtn('icon-btn doc-pop-rm', 'trash', 'Удалить', 13);
      rm.onclick = (e) => { e.stopPropagation(); doc.bookmarks = doc.bookmarks.filter((x) => x.id !== b.id); saveDocs(); refreshBmGutter(); openBookmarksMenu(anchor); };
      row.appendChild(go); row.appendChild(rm); pop.appendChild(row);
    }
    placePopover(pop, anchor);
  }

  // мини-поповер у кнопки шапки (для закладок/истории)
  let popEl = null, popAway = null;
  function placePopover(pop, anchor) {
    document.body.appendChild(pop); popEl = pop;
    const r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    popAway = (e) => { if (popEl && !popEl.contains(e.target) && e.target !== anchor) closePopover(); };
    setTimeout(() => document.addEventListener('mousedown', popAway), 0);
  }
  function closePopover() { if (popEl) { popEl.remove(); popEl = null; } if (popAway) { document.removeEventListener('mousedown', popAway); popAway = null; } }

  // ================================================================ ИСТОРИЯ ИЗМЕНЕНИЙ (п.4)
  function histList() { return (loadedId && histStore[loadedId]) || []; }
  function pushHistory(label) {
    if (!editor || loadedId == null) return;
    const arr = histStore[loadedId] || (histStore[loadedId] = []);
    arr.push({ ts: Date.now(), label: String(label || 'AI-правка').slice(0, 80), before: editor.state.doc.toString() });
    if (arr.length > 20) arr.splice(0, arr.length - 20);
    saveHist();
  }
  function revertTo(entry) {
    showConfirm('Откатить документ?', 'Текст вернётся к состоянию перед «' + entry.label + '». Текущее содержимое сохранится в истории.', 'Откатить', () => {
      pushHistory('перед откатом');
      setText(entry.before);
      markDirty(true); scheduleSave(); if (mdVisible()) updatePreview();
      closePopover();
      toast('Откат выполнен', { ttl: 1500 });
    });
  }
  function fmtTime(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + p(d.getDate()) + '.' + p(d.getMonth() + 1); }
  function openHistoryMenu(anchor) {
    closePopover();
    const pop = el('div', 'doc-popover doc-pop-hist');
    pop.appendChild(el('div', 'doc-pop-title', 'История AI-правок'));
    const arr = histList();
    if (!arr.length) pop.appendChild(el('div', 'doc-pop-empty', 'Пока пусто. Применённые ответы агента появятся здесь — их можно откатить.'));
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      const row = el('div', 'doc-pop-row');
      const info = el('div', 'doc-pop-go doc-hist-info');
      info.appendChild(el('span', 'doc-pop-name', e.label));
      info.appendChild(el('span', 'doc-pop-line', fmtTime(e.ts)));
      const rev = el('button', 'btn doc-hist-rev', 'Откатить'); rev.onclick = () => revertTo(e);
      row.appendChild(info); row.appendChild(rev); pop.appendChild(row);
    }
    placePopover(pop, anchor);
  }

  // ================================================================ ЧАТ С АГЕНТОМ (п.1,2,3)
  function wireChat() {
    const send = $('#doc-chat-send'); if (send) send.onclick = sendChat;
    const ta = $('#doc-chat-text');
    if (ta) ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    const coll = $('#doc-chat-collapse'); if (coll) coll.onclick = () => setChatOpen(false);
    renderChatAgents();
  }
  function wireChatGutter() {
    const g = $('#gutter-doc-chat'), pane = $('#doc-chat'); if (!g || !pane) return;
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = pane.getBoundingClientRect().width;
      const onMove = (ev) => {
        let w = startW + (startX - ev.clientX);
        w = Math.max(260, Math.min(680, w));
        pane.style.flexBasis = w + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
        settings.tpChatW = parseInt(pane.style.flexBasis, 10) || 360; saveSettings();
        requestMeasure();
      };
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    });
  }
  function applyChatLayout() {
    const pane = $('#doc-chat'); if (pane && settings.tpChatW) pane.style.flexBasis = settings.tpChatW + 'px';
    const collapsed = !!settings.tpChatCollapsed;
    $('#doc-pane').classList.toggle('chat-collapsed', collapsed);
  }
  function setChatOpen(open) {
    settings.tpChatCollapsed = !open; saveSettings();
    $('#doc-pane').classList.toggle('chat-collapsed', !open);
    renderToolbar();
    setTimeout(requestMeasure, 60);
    if (open) focusChatInput();
  }
  function focusChatInput() { const ta = $('#doc-chat-text'); if (ta) setTimeout(() => ta.focus(), 30); }

  function renderChatAgents() {
    const box = $('#doc-chat-agents'); if (!box) return; box.innerHTML = '';
    for (const [id, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
      const b = el('button', 'tp-chip sm' + (chatAgent === id ? ' on' : ''), label);
      b.onclick = () => { chatAgent = id; settings.tpAgent = id; saveSettings(); renderChatAgents(); };
      box.appendChild(b);
    }
  }
  function renderChatCtx() {
    const box = $('#doc-chat-ctx'); if (!box) return; box.innerHTML = '';
    const hasSel = lastSel && lastSel.text;
    const head = el('div', 'doc-ctx-head');
    head.appendChild(el('span', 'doc-ctx-label', hasSel ? 'Фрагмент' : 'Контекст'));
    if (hasSel) {
      const pin = el('button', 'doc-ctx-pin' + (selPinned ? ' on' : ''));
      pin.appendChild(icon('pin', 13)); pin.title = selPinned ? 'Открепить (следить за выделением)' : 'Закрепить фрагмент';
      pin.onclick = () => { selPinned = !selPinned; renderChatCtx(); };
      head.appendChild(pin);
    }
    box.appendChild(head);
    const body = el('div', 'doc-ctx-body');
    body.textContent = hasSel ? lastSel.text : 'Выдели фрагмент в тексте — он попадёт сюда. Без выделения агент работает со всем документом.';
    if (!hasSel) body.classList.add('dim');
    box.appendChild(body);
    renderChatPresets();
  }
  function renderChatPresets() {
    const box = $('#doc-chat-presets'); if (!box) return; box.innerHTML = '';
    const sysRow = el('div', 'doc-preset-row');
    sysRow.appendChild(el('span', 'doc-preset-cap', 'Роль:'));
    const none = el('button', 'tp-chip sm' + (chatSysId == null ? ' on' : ''), 'Без роли');
    none.onclick = () => { chatSysId = null; renderChatPresets(); };
    sysRow.appendChild(none);
    for (const p of prompts.system) {
      const b = el('button', 'tp-chip sm' + (chatSysId === p.id ? ' on' : ''), p.name); b.title = p.text;
      b.onclick = () => { chatSysId = chatSysId === p.id ? null : p.id; renderChatPresets(); };
      sysRow.appendChild(b);
    }
    box.appendChild(sysRow);
    if (prompts.user.length) {
      const uRow = el('div', 'doc-preset-row');
      uRow.appendChild(el('span', 'doc-preset-cap', 'Задачи:'));
      for (const p of prompts.user) {
        const b = el('button', 'tp-chip sm add', p.name); b.title = p.text;
        b.onclick = () => { const ta = $('#doc-chat-text'); if (ta) { ta.value = p.text; ta.focus(); } };
        uRow.appendChild(b);
      }
      box.appendChild(uRow);
    }
  }

  function resetChat() {
    for (const m of chat) { try { m.off && m.off(); } catch (_) {} }
    chat = [];
    selPinned = false;
    renderChatAgents(); renderChatCtx(); renderChatLog();
  }
  function selForChat() {
    if (lastSel && lastSel.text) return { from: lastSel.from, to: lastSel.to, text: lastSel.text, whole: false };
    const text = editor ? editor.state.doc.toString() : '';
    return { from: 0, to: text.length, text, whole: true };
  }
  function composePrompt(sel, instruction) {
    const parts = [];
    if (chatSysId != null) { const sp = prompts.system.find((p) => p.id === chatSysId); if (sp && sp.text.trim()) parts.push(sp.text.trim()); }
    // приклеиваем предыдущие ходы по этому же фрагменту — чат-контекст
    const prior = chat.filter((m) => m.role === 'user').slice(-4);
    if (prior.length > 1) {
      const hist = [];
      for (const m of chat) {
        if (m.role === 'user') hist.push('Пользователь: ' + m.text);
        else if (m.role === 'agent' && m.versions && m.versions[m.cur] != null) hist.push('Ассистент: ' + m.versions[m.cur]);
      }
      if (hist.length) parts.push('Предыдущий ход диалога:\n' + hist.slice(-6).join('\n'));
    }
    if (instruction && instruction.trim()) parts.push(instruction.trim());
    parts.push('Ниже — ' + (sel.whole ? 'весь документ' : 'фрагмент текста') + ', который нужно обработать по инструкции выше. Верни ТОЛЬКО итоговый текст для замены: без пояснений, без приветствий, без ограждающих кавычек или ```-блоков.');
    parts.push('===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
    return parts.join('\n\n');
  }
  function sendChat() {
    const ta = $('#doc-chat-text'); if (!ta) return;
    const instruction = ta.value.trim();
    if (!instruction && chatSysId == null) { toast('Напиши инструкцию или выбери роль', { kind: 'err', ttl: 2500, silent: true }); return; }
    const sel = selForChat();
    if (!sel.text || !sel.text.trim()) { toast('Документ пуст — нечего обрабатывать', { kind: 'err', ttl: 2500, silent: true }); return; }
    ta.value = '';
    chat.push({ role: 'user', text: instruction || '(роль без доп. инструкции)', sel });
    const am = { role: 'agent', sel, versions: [], cur: -1, busy: true, error: null, reqId: null, off: null };
    chat.push(am);
    runAgent(am, sel, instruction);
    renderChatLog();
  }
  function runAgent(am, sel, instruction) {
    const reqId = 'tpq' + (++aiSeq);
    am.reqId = reqId; am.busy = true; am.error = null;
    try { am.off && am.off(); } catch (_) {}
    const offDone = lite.tp.onDone(({ reqId: r, text }) => { if (r !== reqId) return; cleanup(); am.busy = false; am.versions.push(text || ''); am.cur = am.versions.length - 1; renderChatLog(); });
    const offErr = lite.tp.onError(({ reqId: r, error }) => { if (r !== reqId) return; cleanup(); am.busy = false; am.error = String(error || 'ошибка'); toast('Агент: ' + am.error, { kind: 'err', ttl: 6000 }); renderChatLog(); });
    const cleanup = () => { try { offDone(); offErr(); } catch (_) {} am.off = null; };
    am.off = cleanup;
    lite.tp.run({ reqId, agent: chatAgent, prompt: composePrompt(sel, instruction) });
  }
  function retry(am) {
    // повторяем по инструкции последнего пользовательского хода перед этим ответом
    const idx = chat.indexOf(am);
    let instruction = '';
    for (let i = idx - 1; i >= 0; i--) { if (chat[i].role === 'user') { instruction = chat[i].text; break; } }
    am.busy = true; renderChatLog();
    runAgent(am, am.sel, instruction === '(роль без доп. инструкции)' ? '' : instruction);
  }
  function abortAgent(am) { if (am.reqId) { try { lite.tp.abort(am.reqId); } catch (_) {} } try { am.off && am.off(); } catch (_) {} am.busy = false; am.error = 'отменено'; renderChatLog(); }

  function applyResult(am, mode) {
    const text = am.versions[am.cur]; if (text == null) return;
    const sel = am.sel;
    const docLen = editor.state.doc.length;
    let from = sel.from, to = sel.to;
    const stale = !sel.whole && (to > docLen || editor.state.sliceDoc(from, to) !== sel.text);
    if (stale && mode === 'replace') {
      toast('Фрагмент изменился — вставляю в текущую позицию курсора', { ttl: 3500 });
      const c = editor.state.selection.main.from; from = c; to = c;
    }
    pushHistory((chatLabel(am) || 'AI-правка'));
    if (mode === 'after') { const at = sel.whole ? docLen : to; editor.dispatch({ changes: { from: at, to: at, insert: '\n' + text } }); }
    else { editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length } }); }
    markDirty(true); scheduleSave(); if (mdVisible()) updatePreview();
    toast(mode === 'after' ? 'Вставлено' : 'Заменено', { ttl: 1500 });
  }
  function chatLabel(am) {
    const idx = chat.indexOf(am);
    for (let i = idx - 1; i >= 0; i--) { if (chat[i].role === 'user') return chat[i].text; }
    return 'AI-правка';
  }

  function renderChatLog() {
    const log = $('#doc-chat-log'); if (!log) return;
    log.innerHTML = '';
    if (!chat.length) {
      log.appendChild(el('div', 'doc-chat-empty', 'Выдели фрагмент текста и напиши, что с ним сделать. Ответ агента можно будет заменить в документе.'));
      return;
    }
    for (const m of chat) {
      if (m.role === 'user') {
        const b = el('div', 'doc-msg user');
        b.appendChild(el('div', 'doc-msg-text', m.text));
        log.appendChild(b);
        continue;
      }
      const b = el('div', 'doc-msg agent');
      if (m.busy) {
        const busy = el('div', 'doc-msg-busy');
        busy.appendChild(el('span', 'doc-spin'));
        busy.appendChild(el('span', null, 'агент обрабатывает…'));
        const cancel = el('button', 'doc-msg-cancel', 'Отмена'); cancel.onclick = () => abortAgent(m);
        busy.appendChild(cancel);
        b.appendChild(busy);
      } else if (m.error) {
        b.classList.add('err');
        b.appendChild(el('div', 'doc-msg-text', '⚠ ' + m.error));
        const re = el('button', 'btn sm', 'Ещё раз'); re.onclick = () => retry(m); b.appendChild(re);
      } else {
        b.appendChild(el('div', 'doc-msg-text', m.versions[m.cur] || '(пустой ответ)'));
        if (m.versions.length > 1) {
          const ver = el('div', 'doc-msg-ver');
          const prev = el('button', 'tp-vbtn', '‹'); prev.disabled = m.cur <= 0; prev.onclick = () => { m.cur--; renderChatLog(); };
          ver.appendChild(prev);
          ver.appendChild(el('span', 'tp-vlbl', (m.cur + 1) + ' / ' + m.versions.length));
          const next = el('button', 'tp-vbtn', '›'); next.disabled = m.cur >= m.versions.length - 1; next.onclick = () => { m.cur++; renderChatLog(); };
          ver.appendChild(next);
          b.appendChild(ver);
        }
        const acts = el('div', 'doc-msg-acts');
        const rep = el('button', 'btn primary sm', m.sel.whole ? 'Заменить документ' : 'Заменить выделенное'); rep.onclick = () => applyResult(m, 'replace');
        const aft = el('button', 'btn sm', 'Вставить ниже'); aft.onclick = () => applyResult(m, 'after');
        const cp = iconBtn('icon-btn sm', 'copy', 'Копировать', 14); cp.onclick = () => { try { navigator.clipboard.writeText(m.versions[m.cur] || ''); toast('Скопировано', { ttl: 1200 }); } catch (_) {} };
        const re = iconBtn('icon-btn sm', 'refresh', 'Ещё раз', 14); re.onclick = () => retry(m);
        acts.appendChild(rep); acts.appendChild(aft); acts.appendChild(cp); acts.appendChild(re);
        b.appendChild(acts);
      }
      log.appendChild(b);
    }
    log.scrollTop = log.scrollHeight;
  }

  // ---- мини-редактор промпта (имя + текст) ----
  function editPrompt(kind, id, after) {
    const list = kind === 'system' ? prompts.system : prompts.user;
    const ex = id != null ? list.find((p) => p.id === id) : null;
    const titleWord = kind === 'system' ? 'системный промпт' : 'заготовку';
    const { m, close } = makeModal(`
      <h2>${ex ? 'Изменить' : 'Новый'} ${titleWord}</h2>
      <div class="tp-field"><label>Название</label><input id="tp-pn" type="text" spellcheck="false" placeholder="как подписать"></div>
      <div class="tp-field"><label>Текст промпта</label><textarea id="tp-pt" rows="6" spellcheck="false" placeholder="${kind === 'system' ? 'Ты — научный редактор…' : 'Перепиши понятнее, сохрани смысл'}"></textarea></div>
      <div class="err" id="tp-pe"></div>
      <div class="modal-actions"><button class="btn" id="tp-pc">Отмена</button><button class="btn primary" id="tp-ps">Сохранить</button></div>`);
    if (ex) { m.querySelector('#tp-pn').value = ex.name; m.querySelector('#tp-pt').value = ex.text; }
    m.querySelector('#tp-pc').onclick = close;
    m.querySelector('#tp-ps').onclick = () => {
      const name = m.querySelector('#tp-pn').value.trim();
      const text = m.querySelector('#tp-pt').value.trim();
      if (!name || !text) { m.querySelector('#tp-pe').textContent = 'Заполни название и текст'; return; }
      if (ex) { ex.name = name; ex.text = text; } else { list.push({ id: uid('pr'), name, text }); }
      savePrompts(); close(); if (after) after();
      renderChatPresets();
    };
    setTimeout(() => m.querySelector('#tp-pn').focus(), 40);
  }

  // ---- модалка управления (агент по умолчанию + списки промптов) ----
  function showSettings() {
    const { m, close } = makeModal(`
      <h2><span style="color:var(--green-bright)">✎</span> Обработка текста</h2>
      <div class="about-desc tp-intro">
        Документы лежат файлами в <code>~/.LiteEditorAI/textproc/</code>. Выделите фрагмент в
        тексте — он попадёт в чат справа; обработка идёт локальным агентом (Claude или Codex) по
        вашей подписке, без API-ключей. Здесь — агент по умолчанию и библиотека промптов.
      </div>
      <div class="tp-field"><label>Агент по умолчанию</label><div class="tp-chips" id="tps-agent"></div></div>
      <div class="tp-field"><label>Системные промпты <span class="tp-dim">(роль/инструкция ИИ)</span></label><div class="tp-plist" id="tps-sys"></div></div>
      <div class="tp-field"><label>Заготовленные промпты <span class="tp-dim">(частые задачи)</span></label><div class="tp-plist" id="tps-user"></div></div>
      <div class="modal-actions"><button class="btn primary" id="tps-close">Готово</button></div>`);
    function renderAgent() {
      const box = m.querySelector('#tps-agent'); box.innerHTML = '';
      const cur = settings.tpAgent === 'codex' ? 'codex' : 'claude';
      for (const [id, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
        const b = el('button', 'tp-chip' + (cur === id ? ' on' : ''), label);
        b.onclick = () => { settings.tpAgent = id; chatAgent = id; saveSettings(); renderAgent(); renderChatAgents(); };
        box.appendChild(b);
      }
    }
    function renderList(kind) {
      const box = m.querySelector(kind === 'system' ? '#tps-sys' : '#tps-user'); box.innerHTML = '';
      const list = kind === 'system' ? prompts.system : prompts.user;
      for (const p of list) {
        const row = el('div', 'tp-prow');
        const info = el('div', 'tp-prow-info');
        info.appendChild(el('div', 'tp-prow-name', p.name));
        info.appendChild(el('div', 'tp-prow-text', p.text));
        row.appendChild(info);
        const ed = iconBtn('icon-btn', 'pencil', 'Изменить', 14);
        ed.onclick = () => editPrompt(kind, p.id, () => renderList(kind));
        const rm = iconBtn('icon-btn', 'trash', 'Удалить', 14);
        rm.onclick = () => { (kind === 'system' ? prompts.system : prompts.user).splice(list.indexOf(p), 1); savePrompts(); renderList(kind); renderChatPresets(); };
        row.appendChild(ed); row.appendChild(rm);
        box.appendChild(row);
      }
      const add = el('button', 'btn tp-padd', kind === 'system' ? '+ системный промпт' : '+ заготовка');
      add.onclick = () => editPrompt(kind, null, () => renderList(kind));
      box.appendChild(add);
    }
    renderAgent(); renderList('system'); renderList('user');
    m.querySelector('#tps-close').onclick = close;
  }

  // кнопки шапки, которые модуль вешает сам (settings вешает module-entry через wire)
  function bindHeadButtons() {
    const h = $('#doc-history'); if (h) h.onclick = () => openHistoryMenu(h);
    const b = $('#doc-bookmarks'); if (b) b.onclick = () => openBookmarksMenu(b);
  }
  bindHeadButtons();

  return {
    isOpen: () => docOpen,
    setOpen: setDocOpen,
    toggle: toggleDoc,
    showSettings,
    refit: requestMeasure,
  };
}
