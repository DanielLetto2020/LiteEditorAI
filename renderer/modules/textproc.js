// renderer/textproc.js
// ============================================================================
// «Обработка текста» — изолированная подсистема, ПАНЕЛЬ ПРАВОГО СЛОТА (как git/audit).
// Документы = файлы в ~/.LiteEditorAI/textproc/, показываются ВКЛАДКАМИ внутри панели
// (#doc-tabs); клик по вкладке открывает документ в редакторе панели, терминал — в центре.
//
// Главная фича: выделяешь любой фрагмент → над ним всплывает кнопка «AI» →
// модалка (системный промпт + заготовленный + свой) → фрагмент уходит ЛОКАЛЬНОМУ
// агенту (Claude/Codex, headless `claude -p` / `codex exec` — по подписке, без
// API-ключей) → возвращается кусок текста на замену. Несколько прогонов копятся
// версиями (◀ ▶), «Заменить» применяет выбранную к выделению.
//
// ⚠️ ИЗОЛЯЦИЯ: модуль НЕ лезет во внутренности renderer.js. Вся связь с редактором
// идёт через host-объект, переданный в initTextProc(host). Так фичу можно
// развивать отдельно. host = {
//   el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast,    // UI-хелперы
//   STORE, persist, settings, saveSettings,                          // состояние
//   layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, // контракт панели правого слота
// }
// Экспортирует: { isOpen(), setOpen(open,opts), toggle(), showSettings() }.
// ============================================================================
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { Marked } from 'marked';

// Markdown-превью БЕЗ проброса «сырого» HTML и БЕЗ опасных схем в ссылках/картинках.
// Документы могут быть вставлены из внешних источников (научные статьи), поэтому:
//  • raw-HTML выкидываем (renderer.html → '') — вектор HTML-инъекции закрыт на корню;
//  • в ссылках/картинках допускаем только безопасные схемы (http/https/mailto/относительные/якорь),
//    иначе href вырождается в текст — режем `javascript:`/`data:`-навигацию.
// Исполнение и так блокирует строгий CSP (script-src 'self') — это defense-in-depth без DOMPurify.
// Структурный markdown (заголовки/таблицы/формулы) сохраняется.
const tpEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tpSafeHref = (h) => /^(https?:|mailto:|#|\/|\.)/i.test(h || '');
const tpSafeImg = (h) => /^(https?:|\/|\.)/i.test(h || '');
const mdRender = new Marked({ gfm: true, breaks: true });
mdRender.use({ renderer: {
  html: () => '',
  link(token) {
    const text = this.parser.parseInline(token.tokens);
    if (!tpSafeHref(token.href)) return text; // небезопасная схема → только текст ссылки
    return `<a href="${tpEsc(token.href)}"${token.title ? ` title="${tpEsc(token.title)}"` : ''}>${text}</a>`;
  },
  image(token) {
    if (!tpSafeImg(token.href)) return tpEsc(token.text || '');
    return `<img src="${tpEsc(token.href)}" alt="${tpEsc(token.text || '')}">`;
  },
} });

const $ = (s) => document.querySelector(s);

export function initTextProc(host) {
  const { el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast,
          STORE, persist, settings, saveSettings,
          layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;
  const lite = window.lite;

  // ---- состояние панели правого слота ----
  let docOpen = false;    // открыта ли панель «Обработка текста» в правом слоте
  let curDocId = null;    // id документа, выбранного для показа в панели (внутреннее состояние модуля)

  // ---------------------------------------------------------------- state
  let docs = Array.isArray(STORE.textproc) ? STORE.textproc : [];      // [{id,name,file,md}]
  let prompts = normPrompts(STORE.tpPrompts);                          // {system:[],user:[]}
  let tpDir = '';
  lite.tp.dir().then((d) => { tpDir = d || ''; }).catch(() => {});

  let editor = null;      // CodeMirror исходника документа
  let loadedId = null;    // id документа, который сейчас в редакторе
  let loadingDoc = false; // подавляет автосейв во время программной загрузки
  let dirty = false;
  let saveTimer = null;
  let curMd = false;      // текущий документ трактуется как markdown
  let mdView = 'split';   // 'raw' | 'rendered' | 'split'
  let lastSel = null;     // {from,to,text} последнего непустого выделения
  let aiSeq = 0;
  let wired = false;      // обработчики #doc-pane навешены один раз

  function normPrompts(p) {
    p = p && typeof p === 'object' ? p : {};
    return { system: Array.isArray(p.system) ? p.system : [], user: Array.isArray(p.user) ? p.user : [] };
  }
  function saveDocs() { persist('textproc', docs); }
  function savePrompts() { persist('tpPrompts', prompts); }
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

  // ================================================================ вкладки панели
  // По одной вкладке на документ. Клик — открыть/переключить, двойной клик — переименовать,
  // «×» — удалить (в корзину, с подтверждением), «+» — новый документ.
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
      const doc = { id: uid('doc'), name: t, file, md: isMdFile(file) };
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
      if (doc.id === curDocId) { loadedId = null; curDocId = null; if (docOpen) showDocPlaceholder(); }
      renderDocTabs();
    });
  }

  // ================================================================ editor / view
  const langComp = new Compartment();
  function ensureEditor() {
    if (editor) return;
    const state = EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(), highlightActiveLine(), drawSelection(), history(),
        indentOnInput(), bracketMatching(), highlightSelectionMatches(), search({ top: true }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
        langComp.of([]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { flushSave(); return true; } },
          indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !loadingDoc) { markDirty(true); scheduleSave(); if (mdVisible()) updatePreview(); }
          if (u.selectionSet || u.docChanged) refreshAiBtn();
        }),
      ],
    });
    editor = new EditorView({ state, parent: $('#doc-editor') });
    if (!wired) {
      wired = true;
      const ed = $('#doc-editor');
      ed.addEventListener('scroll', hideAi, true);
      const btn = $('#doc-ai-btn');
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // не сбрасывать выделение
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (lastSel) openAiModal(lastSel); });
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
    const doc = docs.find((d) => d.id === loadedId); if (!doc) return;
    try { const r = await lite.fs.writeFile(docPath(doc), editor.state.doc.toString()); if (r && r.ok) markDirty(false); }
    catch (_) {}
  }
  async function loadDoc(id) {
    const doc = docs.find((d) => d.id === id); if (!doc) return;
    loadedId = id;
    curMd = doc.md != null ? !!doc.md : isMdFile(doc.file);
    mdView = 'split';
    let content = '';
    const res = await lite.fs.readFile(docPath(doc));
    if (res && res.content != null) content = res.content;
    else if (res && res.error) toast('Не открыть «' + doc.file + '»: ' + res.error, { kind: 'err', ttl: 6000 });
    setText(content);
    markDirty(false);
    renderToolbar();
    applyView();
    hideAi();
  }

  // показать документ id в панели (null — спрятать редактор, дописав на диск)
  function sync(id) {
    if (id == null) { flushSave(); hideAi(); return; }
    ensureEditor();
    if (id !== loadedId) { flushSave(); loadDoc(id); } // сначала дописать прошлый документ (debounce мог не сработать)
    else { renderToolbar(); applyView(); }
    setTimeout(() => { try { editor.focus(); } catch (_) {} requestMeasure(); }, 30);
  }
  function requestMeasure() { try { editor && editor.requestMeasure(); } catch (_) {} }

  // ================================================================ панель правого слота
  // Заглушка, когда панель открыта, но документ не выбран (или удалён).
  function showDocPlaceholder() {
    const ttl = $('#doc-title'); if (ttl) ttl.textContent = 'Обработка текста';
    const bar = $('#doc-modes'); if (bar) bar.innerHTML = '';
    const s = $('#doc-saved'); if (s) { s.textContent = ''; s.classList.remove('dirty'); }
    if (editor) setText('');
    hideAi();
  }
  // Канонический setOpen панели (по образцу git/audit): взаимоисключение + рост окна + сохранение.
  function setDocOpen(open, opts = {}) {
    if (open === docOpen) { if (open) { if (curDocId) sync(curDocId); else showDocPlaceholder(); } return; }
    if (open) closeOtherPanels('doc');
    const delta = layout.doc + GUTTER;
    docOpen = open;
    $('#doc-pane').classList.toggle('hidden', !open);
    $('#gutter-doc').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false на restore — сохранённая ширина уже учла панель
    saveUiState();
    if (open) { renderDocTabs(); ensureEditor(); if (curDocId) sync(curDocId); else showDocPlaceholder(); }
    else { flushSave(); hideAi(); }
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleDoc() { setDocOpen(!docOpen); }
  // Открыть документ id (клик по вкладке): выбрать + раскрыть панель.
  function openDoc(id) {
    curDocId = id;
    renderDocTabs();           // подсветка активной вкладки
    if (!docOpen) setDocOpen(true);
    else sync(id);
  }

  // ---- toolbar ----
  function renderToolbar() {
    const bar = $('#doc-modes'); if (!bar) return; bar.innerHTML = '';
    const doc = docs.find((d) => d.id === loadedId);
    const ttl = $('#doc-title'); if (ttl) ttl.textContent = doc ? doc.name : '';
    bar.appendChild(modeBtn('Текст', !curMd, () => setKind(false)));
    bar.appendChild(modeBtn('MD', curMd, () => setKind(true)));
    if (curMd) {
      bar.appendChild(el('span', 'doc-sep'));
      bar.appendChild(modeBtn('Сырой', mdView === 'raw', () => setMdView('raw')));
      bar.appendChild(modeBtn('Оформленный', mdView === 'rendered', () => setMdView('rendered')));
      bar.appendChild(modeBtn('Совместно', mdView === 'split', () => setMdView('split')));
    }
  }
  function modeBtn(label, on, fn) { const b = el('button', 'doc-mode' + (on ? ' on' : ''), label); b.onclick = fn; return b; }
  function setKind(md) {
    if (curMd === md) return;
    curMd = md;
    const doc = docs.find((d) => d.id === loadedId); if (doc) { doc.md = md; saveDocs(); }
    if (editor) editor.dispatch({ effects: langComp.reconfigure(md ? markdown() : []) });
    if (md) mdView = 'split';
    renderToolbar(); applyView();
  }
  function setMdView(v) { mdView = v; renderToolbar(); applyView(); requestMeasure(); }

  function mdVisible() { return curMd && (mdView === 'rendered' || mdView === 'split'); }
  function applyView() {
    const ed = $('#doc-editor'), pv = $('#doc-preview'), body = $('#doc-body');
    if (!ed || !pv || !body) return;
    const showPrev = curMd && (mdView === 'rendered' || mdView === 'split');
    const showEd = !curMd || mdView === 'raw' || mdView === 'split';
    ed.style.display = showEd ? '' : 'none';
    pv.style.display = showPrev ? '' : 'none';
    body.classList.toggle('split', curMd && mdView === 'split');
    if (showPrev) updatePreview();
    if (!showEd) hideAi();
  }
  function updatePreview() {
    const pv = $('#doc-preview'); if (!pv || !editor) return;
    const src = editor.state.doc.toString();
    try { pv.innerHTML = mdRender.parse(src || ''); } catch (_) { pv.textContent = src; }
  }

  // ---- floating «AI» button над выделением ----
  function refreshAiBtn() {
    if (!editor) return hideAi();
    if (curMd && mdView === 'rendered') return hideAi(); // нет редактируемого исходника
    const sel = editor.state.selection.main;
    if (sel.empty) return hideAi();
    const text = editor.state.sliceDoc(sel.from, sel.to);
    if (!text.trim()) return hideAi();
    lastSel = { from: sel.from, to: sel.to, text };
    const coords = editor.coordsAtPos(sel.head) || editor.coordsAtPos(sel.from);
    const body = $('#doc-body'); if (!coords || !body) return hideAi();
    const box = body.getBoundingClientRect();
    const btn = $('#doc-ai-btn');
    btn.style.display = '';
    let top = coords.top - box.top - 30;
    if (top < 2) top = coords.bottom - box.top + 6; // выделение у верхней кромки → показать снизу
    btn.style.left = Math.max(4, Math.min(coords.left - box.left, box.width - 48)) + 'px';
    btn.style.top = top + 'px';
  }
  function hideAi() { const b = $('#doc-ai-btn'); if (b) b.style.display = 'none'; }

  // ================================================================ AI-модалка
  function openAiModal(sel) {
    flushSave();
    let agent = settings.tpAgent === 'codex' ? 'codex' : 'claude';
    let sysId = null;
    const results = [];     // версии результата
    let curRes = -1;
    let runningReq = null;
    let offDone = null, offErr = null;

    const { m, close } = makeModal(`
      <h2><span style="color:var(--green-bright)">✦</span> Обработка фрагмента</h2>
      <div class="tp-modal">
        <div class="tp-field"><label>Выделенный фрагмент</label>
          <div class="tp-selbox" id="tp-sel"></div></div>
        <div class="tp-field"><label>Агент <span class="tp-dim">(локально, по подписке — без API-ключа)</span></label>
          <div class="tp-chips" id="tp-agents"></div></div>
        <div class="tp-field"><label>Системный промпт <span class="tp-dim">(роль ИИ — необязательно)</span></label>
          <div class="tp-chips" id="tp-sys"></div></div>
        <div class="tp-field"><label>Заготовленные промпты <span class="tp-dim">(клик подставит в поле ниже)</span></label>
          <div class="tp-chips" id="tp-user"></div></div>
        <div class="tp-field"><label>Свой промпт</label>
          <textarea id="tp-custom" rows="3" placeholder="Что сделать с фрагментом…" spellcheck="false"></textarea></div>
        <div class="tp-result" id="tp-result" style="display:none">
          <div class="tp-result-head"><span>Результат</span><div class="tp-ver" id="tp-ver"></div></div>
          <div class="tp-resbox" id="tp-resbox"></div>
        </div>
        <div class="err" id="tp-err"></div>
      </div>
      <div class="modal-actions" id="tp-actions"></div>`,
      () => { detach(); if (runningReq) { try { lite.tp.abort(runningReq); } catch (_) {} } });

    m.querySelector('#tp-sel').textContent = sel.text;
    const errBox = m.querySelector('#tp-err');
    const custom = m.querySelector('#tp-custom');
    custom.addEventListener('input', updateRun);

    function detach() { try { offDone && offDone(); offErr && offErr(); } catch (_) {} offDone = offErr = null; }
    function valid() { return sysId != null || custom.value.trim().length > 0; }

    function renderAgents() {
      const box = m.querySelector('#tp-agents'); box.innerHTML = '';
      for (const [id, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
        const b = el('button', 'tp-chip' + (agent === id ? ' on' : ''), label);
        b.onclick = () => { agent = id; settings.tpAgent = id; saveSettings(); renderAgents(); };
        box.appendChild(b);
      }
    }
    function renderSys() {
      const box = m.querySelector('#tp-sys'); box.innerHTML = '';
      const none = el('button', 'tp-chip' + (sysId == null ? ' on' : ''), 'Без системного');
      none.onclick = () => { sysId = null; renderSys(); updateRun(); };
      box.appendChild(none);
      for (const p of prompts.system) {
        const b = el('button', 'tp-chip' + (sysId === p.id ? ' on' : ''), p.name); b.title = p.text;
        b.onclick = () => { sysId = sysId === p.id ? null : p.id; renderSys(); updateRun(); };
        box.appendChild(b);
      }
      const add = el('button', 'tp-chip add', '+ новый'); add.onclick = () => editPrompt('system', null, renderSys); box.appendChild(add);
    }
    function renderUser() {
      const box = m.querySelector('#tp-user'); box.innerHTML = '';
      if (!prompts.user.length) box.appendChild(el('span', 'tp-dim', 'пока нет'));
      for (const p of prompts.user) {
        const b = el('button', 'tp-chip', p.name); b.title = p.text;
        b.onclick = () => { custom.value = p.text; updateRun(); custom.focus(); };
        box.appendChild(b);
      }
      const add = el('button', 'tp-chip add', '+ заготовка'); add.onclick = () => editPrompt('user', null, renderUser); box.appendChild(add);
    }
    renderAgents(); renderSys(); renderUser();

    function composePrompt() {
      const parts = [];
      if (sysId != null) { const sp = prompts.system.find((p) => p.id === sysId); if (sp && sp.text.trim()) parts.push(sp.text.trim()); }
      const task = custom.value.trim(); if (task) parts.push(task);
      parts.push('Ниже — фрагмент текста, который нужно обработать по инструкции выше. Верни ТОЛЬКО итоговый текст для замены: без пояснений, без приветствий, без ограждающих кавычек или ```-блоков.');
      parts.push('===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
      return parts.join('\n\n');
    }
    function run() {
      if (!valid()) return;
      errBox.textContent = '';
      detach();
      const reqId = 'tpq' + (++aiSeq);
      runningReq = reqId;
      setBusy(true);
      offDone = lite.tp.onDone(({ reqId: r, text }) => { if (r !== reqId) return; runningReq = null; detach(); pushResult(text || ''); });
      offErr = lite.tp.onError(({ reqId: r, error }) => { if (r !== reqId) return; runningReq = null; detach(); setBusy(false); errBox.textContent = 'Ошибка агента: ' + error; });
      lite.tp.run({ reqId, agent, prompt: composePrompt() });
    }
    function pushResult(text) {
      results.push(text); curRes = results.length - 1;
      m.querySelector('#tp-result').style.display = '';
      setBusy(false); renderResult();
    }
    function renderResult() {
      const box = m.querySelector('#tp-resbox'); box.textContent = results[curRes] || '(пустой ответ)';
      const ver = m.querySelector('#tp-ver'); ver.innerHTML = '';
      if (results.length > 1) {
        const prev = el('button', 'tp-vbtn', '‹'); prev.disabled = curRes <= 0; prev.onclick = () => { curRes--; renderResult(); };
        const lbl = el('span', 'tp-vlbl', (curRes + 1) + ' / ' + results.length);
        const next = el('button', 'tp-vbtn', '›'); next.disabled = curRes >= results.length - 1; next.onclick = () => { curRes++; renderResult(); };
        ver.appendChild(prev); ver.appendChild(lbl); ver.appendChild(next);
      }
    }
    function setBusy(on) {
      const box = m.querySelector('#tp-actions'); box.innerHTML = '';
      if (on) {
        const c = el('button', 'btn', 'Отмена'); c.onclick = () => { if (runningReq) { try { lite.tp.abort(runningReq); } catch (_) {} } close(); };
        box.appendChild(c);
        box.appendChild(el('span', 'tp-busy', '⏳ агент обрабатывает…'));
        return;
      }
      const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close; box.appendChild(cancel);
      if (results.length) {
        const again = el('button', 'btn', 'Попробовать ещё'); again.onclick = run; box.appendChild(again);
        const repl = el('button', 'btn primary', 'Заменить'); repl.onclick = applyReplace; box.appendChild(repl);
      } else {
        const go = el('button', 'btn primary', 'Обработать'); go.id = 'tp-go'; go.disabled = !valid(); go.onclick = run; box.appendChild(go);
      }
    }
    function updateRun() { const go = m.querySelector('#tp-go'); if (go) go.disabled = !valid(); }
    function applyReplace() {
      const text = results[curRes]; if (text == null) return;
      editor.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } });
      markDirty(true); scheduleSave(); if (mdVisible()) updatePreview();
      close();
    }
    setBusy(false);
    setTimeout(() => custom.focus(), 40);
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
    };
    setTimeout(() => m.querySelector('#tp-pn').focus(), 40);
  }

  // ---- модалка управления (агент по умолчанию + списки промптов) ----
  function showSettings() {
    const { m, close } = makeModal(`
      <h2><span style="color:var(--green-bright)">✎</span> Обработка текста</h2>
      <div class="about-desc tp-intro">
        Документы лежат файлами в <code>~/.LiteEditorAI/textproc/</code>. Выделите фрагмент в
        тексте — над ним появится кнопка «AI». Обработка идёт локальным агентом (Claude или
        Codex) по вашей подписке, без API-ключей. Здесь — агент по умолчанию и библиотека промптов.
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
        b.onclick = () => { settings.tpAgent = id; saveSettings(); renderAgent(); };
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
        rm.onclick = () => { (kind === 'system' ? prompts.system : prompts.user).splice(list.indexOf(p), 1); savePrompts(); renderList(kind); };
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

  return {
    isOpen: () => docOpen,
    setOpen: setDocOpen,
    toggle: toggleDoc,
    showSettings,
  };
}
