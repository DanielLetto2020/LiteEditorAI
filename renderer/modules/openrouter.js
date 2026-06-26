// LiteEditor — модуль «OpenRouter» (чат по своим ключам; ключи = вкладки внутри панели).
// ПАНЕЛЬ ПРАВОГО СЛОТА (как git/audit): терминал остаётся в центре, чат открывается справа.
// Активный ключ (activeCardId) — внутреннее состояние модуля. Ключи показываются ВКЛАДКАМИ
// внутри панели (#chat-tabs), клик переключает активный ключ. host: { STORE, persist, settings,
//   closeMenus, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels }.
// Экспортирует: { isOpen(), setOpen(open,opts), toggle(), bindStream(), bindControls() }.
import { el, icon, iconBtn, makeModal, showConfirm, showPrompt, toast } from '../ui.js';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/atom-one-dark.css';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initOpenRouter(host) {
  const { STORE, persist, settings, closeMenus,
          layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  // ---- состояние панели правого слота ----
  let chatOpen = false;       // открыта ли панель чата в правом слоте
  let activeCardId = null;    // id карточки-ключа, чат которой показан в панели (внутреннее состояние модуля)

  // orCards: persisted list of {id, name, key, model, contextN}. Each renders as a card in
  // its own «OpenRouter» section; clicking one opens the chat panel on the right.
  let orCards = Array.isArray(STORE.openrouter) ? STORE.openrouter : [];
  const orChats = new Map();    // cardId -> { messages:[{role,content}], loaded, streaming, reqId }
  const orModelsByKey = new Map(); // apiKey -> [{id,name}] (fetched once, cached for the session)
  const orUsageByKey = new Map();  // apiKey -> {usage,limit,limit_remaining,label} | {loading} | {error}
  const pendingOr = new Map();  // reqId -> { chunk, done, error } stream handlers
  let orReqSeq = 0;

  function saveOrCards() { persist('openrouter', orCards); }
  function activeOrCard() { return orCards.find((c) => c.id === activeCardId) || null; }
  function newOrId() { return 'or' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
  function maskKey(k) { k = String(k || ''); return k.length <= 12 ? k : k.slice(0, 8) + '…' + k.slice(-4); }
  function clamp(n, lo, hi) { n = parseInt(n, 10); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, n)); }
  // Each card holds N sessions (separate conversations); a session = { id, name, messages }.
  // Runtime st: { loaded, sessions:[], active:sessionId, streaming, reqId }. Persisted to
  // orchats/<cardId>.json as { sessions, active } (legacy plain-array files migrate to one session).
  function newSessId() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function blankSession(name, contextN) { return { id: newSessId(), name: name || 'Сессия 1', messages: [], contextN: clamp(contextN || 10, 1, 100) }; }
  function syncCtxInput() { const s = activeSession(); const i = $('#chat-ctx-input'); if (i) i.value = s ? clamp(s.contextN || 10, 1, 100) : 10; }
  function getOrChat(id) {
    let st = orChats.get(id);
    if (!st) { st = { loaded: false, sessions: [], active: null, streaming: false, reqId: null }; orChats.set(id, st); }
    return st;
  }
  function ensureSession(st) {
    if (!st.sessions.length) { const s = blankSession('Сессия 1'); st.sessions.push(s); st.active = s.id; }
    if (!st.sessions.find((s) => s.id === st.active)) st.active = st.sessions[0].id;
    return st.sessions.find((s) => s.id === st.active);
  }
  function activeSession() {
    const c = activeOrCard(); if (!c) return null;
    const st = orChats.get(c.id); if (!st) return null;
    return st.sessions.find((s) => s.id === st.active) || null;
  }
  function saveOrHist(cardId) {
    const st = orChats.get(cardId); if (!st) return;
    lite.openrouter.histSet(cardId, { sessions: st.sessions, active: st.active });
  }
  // model cost/size formatting (pricing is USD per token → show per 1M tokens)
  function fmtCtx(n) { n = parseInt(n, 10); if (!n) return ''; return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
  function fmtPrice(p) {
    const v = parseFloat(p); if (!Number.isFinite(v)) return null;
    if (v === 0) return 'free';
    const per = v * 1e6;
    return '$' + (per >= 1 ? per.toFixed(2) : per.toPrecision(2));
  }
  function fmtUsd(v) { const n = Number(v); return '$' + (Number.isFinite(n) ? n : 0).toFixed(2); }
  function usageText(key) {
    const u = orUsageByKey.get(key);
    if (!u || u.loading) return 'баланс: загрузка…';
    if (u.error) return 'баланс: —';
    const used = fmtUsd(u.usage);
    if (u.limit == null) return `израсходовано ${used} · лимит ∞`;
    return `${used} / ${fmtUsd(u.limit)}`;
  }
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); }
  function updateUsageDom(key) {
    const esc = cssEsc(key);
    document.querySelectorAll(`.or-usage-text[data-key="${esc}"]`).forEach((s) => { s.textContent = usageText(key); });
    const loading = (orUsageByKey.get(key) || {}).loading;
    document.querySelectorAll(`.or-refresh[data-key="${esc}"]`).forEach((b) => b.classList.toggle('spinning', !!loading));
  }
  async function fetchKeyInfo(key, force) {
    const cur = orUsageByKey.get(key);
    if (!force && cur) return;            // already have data (or loading) — auto-load runs once
    if (cur && cur.loading) return;       // a request is already in flight
    orUsageByKey.set(key, { loading: true });
    updateUsageDom(key);
    let r; try { r = await lite.openrouter.keyInfo(key); } catch (e) { r = { error: String(e) }; }
    if (r && !r.error) orUsageByKey.set(key, { usage: r.usage, limit: r.limit, limit_remaining: r.limit_remaining, label: r.label });
    else orUsageByKey.set(key, { error: (r && r.error) || 'ошибка' });
    updateUsageDom(key);
  }
  // Баланс активного ключа в шапке чат-топа (#chat-usage/#chat-usage-refresh). Привязка к ключу
  // через data-key → существующий updateUsageDom обновит этот элемент по тому же селектору.
  function showUsage(key) {
    const t = $('#chat-usage'); if (t) { t.dataset.key = key; t.textContent = usageText(key); }
    const r = $('#chat-usage-refresh'); if (r) { r.dataset.key = key; r.classList.toggle('spinning', !!(orUsageByKey.get(key) || {}).loading); }
    if (!orUsageByKey.has(key)) fetchKeyInfo(key, false); // ленивая автозагрузка один раз на ключ
  }
  function modelMetaText(card) {
    const mm = card.modelMeta; if (!mm) return card.model || '';
    const parts = [card.model];
    const ctx = fmtCtx(mm.context); if (ctx) parts.push(ctx + ' ctx');
    const pin = fmtPrice(mm.pricing && mm.pricing.prompt); if (pin) parts.push('вход ' + pin + '/1M');
    const pout = fmtPrice(mm.pricing && mm.pricing.completion); if (pout) parts.push('выход ' + pout + '/1M');
    return parts.join(' · ');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // Render assistant markdown to sanitized HTML (CSP already blocks scripts; we still strip
  // dangerous tags / on*-handlers / javascript: urls as defense-in-depth).
  function mdToSafeHtml(src) {
    let html;
    try { html = marked.parse(String(src || ''), { gfm: true, breaks: true }); } catch (_) { return escapeHtml(src); }
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
    tpl.content.querySelectorAll('*').forEach((n) => {
      [...n.attributes].forEach((a) => {
        const name = a.name.toLowerCase();
        if (name.startsWith('on')) { n.removeAttribute(a.name); return; }
        if (name === 'href' || name === 'src') {
          // allowlist URL schemes: links → http(s)/mailto; img src → http(s)/data. Drop the rest.
          let proto = '';
          try { proto = new URL(a.value, location.href).protocol; } catch (_) { n.removeAttribute(a.name); return; }
          const ok = (name === 'src') ? ['http:', 'https:', 'data:'] : ['http:', 'https:', 'mailto:'];
          if (!ok.includes(proto)) n.removeAttribute(a.name);
        }
      });
    });
    return tpl.innerHTML;
  }
  function enhanceCodeBlocks(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy')) return;
      const code = pre.querySelector('code');
      if (code) { // syntax highlight (highlight.js); keep the raw text for copy below
        const raw = code.textContent;
        const langCls = (code.className.match(/language-([\w+#-]+)/) || [])[1];
        try {
          const res = (langCls && hljs.getLanguage(langCls))
            ? hljs.highlight(raw, { language: langCls, ignoreIllegals: true })
            : hljs.highlightAuto(raw);
          code.innerHTML = res.value; // hljs returns sanitized HTML (no raw user HTML survives)
        } catch (_) {}
        code.classList.add('hljs');
      }
      const btn = el('button', 'code-copy', 'Копировать');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        lite.copyText(code ? code.textContent : pre.textContent); // textContent = original code, not highlighted markup
        btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1000);
      });
      pre.appendChild(btn);
    });
  }
  function renderMsgContent(bubble, role, text) {
    bubble.classList.remove('err');
    if (role === 'assistant') { bubble.innerHTML = mdToSafeHtml(text); enhanceCodeBlocks(bubble); }
    else bubble.textContent = text || '';
  }
  // Fullscreen image viewer with a download button (for generated/markdown images).
  function openImageLightbox(src) {
    const ov = el('div', 'img-lightbox');
    const img = el('img', 'img-lb-img'); img.src = src;
    const bar = el('div', 'img-lb-bar');
    const dl = el('button', 'btn primary', 'Скачать');
    dl.addEventListener('click', (e) => { e.stopPropagation(); downloadImage(src); });
    const cl = el('button', 'btn', 'Закрыть');
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    cl.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    bar.appendChild(dl); bar.appendChild(cl);
    ov.appendChild(img); ov.appendChild(bar);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); }); // click backdrop to dismiss
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
  }
  function downloadImage(src) {
    try {
      const a = document.createElement('a');
      a.href = src;
      const ext = (src.match(/^data:image\/(\w+)/) || [])[1] || 'png';
      a.download = 'openrouter-image-' + Date.now() + '.' + ext;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (_) {}
  }

  // Вкладки внутри панели чата — по одной на каждый ключ. Клик переключает активный ключ,
  // «+» открывает модалку добавления/управления ключами (там же rename/delete). ПКМ — туда же.
  function renderChatTabs() {
    const bar = $('#chat-tabs'); if (!bar) return;
    bar.innerHTML = '';
    for (const c of orCards) {
      const tab = el('div', 'tab' + (c.id === activeCardId ? ' active' : ''));
      tab.dataset.orid = c.id;
      tab.appendChild(el('span', 'tab-name', c.name));
      tab.title = c.name + (c.model ? ' · ' + c.model : '') + '  ·  ' + maskKey(c.key);
      tab.addEventListener('click', () => openChat(c.id));
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); showOpenRouter(); });
      bar.appendChild(tab);
    }
    const add = iconBtn('tab-add', 'plus', 'Добавить ключ OpenRouter', 15);
    add.addEventListener('click', () => showOpenRouter());
    bar.appendChild(add);
  }

  // ---------------------------------------------------------------- OpenRouter chat UI
  // ================================================================ панель правого слота
  // Заглушка, когда панель открыта, но ключ не выбран (или удалён).
  function showChatPlaceholder() {
    renderChatTabs();
    $('#chat-title').textContent = 'OpenRouter';
    const log = $('#chat-log'); if (log) { log.innerHTML = ''; log.appendChild(el('div', 'chat-empty', 'Выберите ключ во вкладках сверху или добавьте новый кнопкой «+».')); }
    const b = $('#chat-model-btn'); if (b) { b.textContent = 'Выбрать модель…'; b.title = ''; }
    const u = $('#chat-usage'); if (u) { u.textContent = ''; u.removeAttribute('data-key'); }
    $('#chat-model-pop') && $('#chat-model-pop').classList.add('hidden');
    $('#chat-session-pop') && $('#chat-session-pop').classList.add('hidden');
    setChatSending(false);
  }
  // Канонический setOpen панели (по образцу git/audit): взаимоисключение + рост окна + сохранение.
  function setChatOpen(open, opts = {}) {
    if (open === chatOpen) { if (open) renderActiveCard(); return; }
    if (open) closeOtherPanels('chat');
    const delta = layout.chat + GUTTER;
    chatOpen = open;
    $('#chat-pane').classList.toggle('hidden', !open);
    $('#gutter-chat').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false на restore — сохранённая ширина уже учла панель
    saveUiState();
    if (open) renderActiveCard();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleChat() { setChatOpen(!chatOpen); }
  // Открыть чат карточки-ключа id (клик по плашке в колонке проектов): выбрать ключ + раскрыть панель.
  function openChat(id) {
    const card = orCards.find((c) => c.id === id);
    if (!card) return;
    activeCardId = id;
    if (!chatOpen) setChatOpen(true);   // setChatOpen → renderActiveCard
    else renderActiveCard();
  }
  // Отрисовать панель под текущий activeCardId (грузит историю при первом открытии ключа).
  async function renderActiveCard() {
    renderChatTabs();        // подсветка активной вкладки-ключа
    const card = activeOrCard();
    if (!card) { showChatPlaceholder(); return; }
    const id = card.id;
    const st = getOrChat(id);
    $('#chat-title').textContent = card.name;
    showUsage(card.key);     // баланс активного ключа в шапке чат-топа
    $('#chat-model-btn').textContent = card.model || 'Выбрать модель…';
    $('#chat-model-btn').title = card.model ? modelMetaText(card) : '';
    $('#chat-model-pop').classList.add('hidden');
    $('#chat-session-pop').classList.add('hidden');
    setChatSending(st.streaming);
    if (!st.loaded) { // pull history from disk on first open of this card
      let doc = null;
      try { doc = await lite.openrouter.histGet(id); } catch (_) {}
      if (Array.isArray(doc)) st.sessions = doc.length ? [{ id: newSessId(), name: 'Сессия 1', messages: doc }] : []; // legacy
      else if (doc && Array.isArray(doc.sessions)) { st.sessions = doc.sessions; st.active = doc.active; }
      // backfill per-session contextN (older data kept it per-card) so the setting binds to the session
      for (const s of st.sessions) if (s.contextN == null) s.contextN = clamp(card.contextN || 10, 1, 100);
      st.loaded = true;
    }
    if (activeCardId !== id) return; // user switched away during the async load
    ensureSession(st);
    updateSessionBtn();
    syncCtxInput();
    renderChatLog();
    setTimeout(() => { const ta = $('#chat-input'); if (ta) ta.focus(); }, 30);
  }
  function updateSessionBtn() { const s = activeSession(); const b = $('#chat-session-btn'); if (b) b.textContent = '☰ ' + (s ? s.name : 'Сессия'); }
  function renderChatLog() {
    const log = $('#chat-log');
    log.innerHTML = '';
    const sess = activeSession();
    if (!sess || !sess.messages.length) {
      log.appendChild(el('div', 'chat-empty', 'Выбери модель вверху и напиши первое сообщение.'));
      return;
    }
    for (const msg of sess.messages) appendChatMsg(msg.role, msg.content);
    scrollChat();
  }
  function appendChatMsg(role, text, streaming) {
    const log = $('#chat-log');
    const empty = log.querySelector('.chat-empty'); if (empty) empty.remove();
    const wrap = el('div', 'chat-msg ' + (role === 'user' ? 'me' : 'bot'));
    wrap.dataset.raw = text || ''; // raw source (markdown for assistant) — what the copy button yields
    // sticky header so the copy button stays in view while a long message scrolls
    const head = el('div', 'chat-msg-head');
    head.appendChild(el('span', 'msg-role', role === 'user' ? 'Вы' : 'Ассистент'));
    const copy = iconBtn('msg-copy', 'copy', 'Копировать сообщение', 15);
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      lite.copyText(wrap.dataset.raw || '');
      copy.replaceChildren(icon('check', 15)); setTimeout(() => copy.replaceChildren(icon('copy', 15)), 900);
    });
    head.appendChild(copy);
    const bubble = el('div', 'chat-bubble');
    if (streaming) bubble.textContent = text || ''; // plain while streaming; finalized to markdown on done
    else renderMsgContent(bubble, role, text);
    wrap.appendChild(head);
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    scrollChat();
    return wrap;
  }
  function scrollChat() { const log = $('#chat-log'); if (log) log.scrollTop = log.scrollHeight; }
  function setChatSending(on) {
    const btn = $('#chat-send'); if (!btn) return;
    btn.textContent = on ? '■' : '▶';
    btn.classList.toggle('sending', on);
    btn.title = on ? 'Остановить' : 'Отправить';
  }
  function onSendClick() {
    const card = activeOrCard(); if (!card) return;
    const st = orChats.get(card.id);
    if (st && st.streaming) { if (st.reqId) lite.openrouter.chatAbort(st.reqId); return; }
    sendChat();
  }
  function sendChat() {
    const card = activeOrCard(); if (!card) return;
    if (!card.model) { toast('Сначала выбери модель вверху'); return; }
    const ta = $('#chat-input');
    const text = ta.value.trim();
    if (!text) return;
    const st = getOrChat(card.id);
    if (st.streaming) return;
    const sess = ensureSession(st);
    ta.value = ''; ta.style.height = 'auto';
    sess.messages.push({ role: 'user', content: text });
    appendChatMsg('user', text);
    saveOrHist(card.id);
    const n = clamp(sess.contextN || 10, 1, 100); // context window is per-session
    const ctx = sess.messages.slice(-n).map((m) => ({ role: m.role, content: m.content }));
    const wrap = appendChatMsg('assistant', '…', true);
    const bubble = wrap.querySelector('.chat-bubble');
    const reqId = 'orq' + (++orReqSeq);
    st.streaming = true; st.reqId = reqId;
    setChatSending(true);
    let acc = '';
    let rich = false; // once an image arrives, render markdown live (don't dump the data: URL as text)
    const finish = (errMsg) => {
      pendingOr.delete(reqId);
      st.streaming = false; st.reqId = null;
      wrap.dataset.raw = acc;
      renderMsgContent(bubble, 'assistant', acc || (errMsg ? '' : '(пустой ответ)'));
      if (errMsg) { bubble.classList.add('err'); bubble.appendChild(el('div', 'chat-err', '⚠ Ошибка: ' + errMsg)); }
      if (acc) { sess.messages.push({ role: 'assistant', content: acc }); saveOrHist(card.id); }
      if (activeCardId === card.id) setChatSending(false);
      scrollChat();
    };
    pendingOr.set(reqId, {
      chunk: (d) => {
        acc += d;
        if (!rich && d.includes('![image](')) rich = true;
        if (rich) renderMsgContent(bubble, 'assistant', acc); else bubble.textContent = acc;
        scrollChat();
      },
      done: () => finish(null),
      error: (msg) => finish(msg),
    });
    lite.openrouter.chatStart({ reqId, key: card.key, model: card.model, messages: ctx });
  }
  // ---------------------------------------------------------------- chat sessions (per key)
  function toggleSessionPop() {
    const pop = $('#chat-session-pop');
    if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
    renderSessionList();
    pop.classList.remove('hidden');
  }
  function renderSessionList() {
    const pop = $('#chat-session-pop'); pop.innerHTML = '';
    const card = activeOrCard(); if (!card) return;
    const st = getOrChat(card.id);
    const add = el('div', 'sess-row sess-add');
    add.appendChild(icon('plus', 14)); add.appendChild(el('span', null, 'Новая сессия'));
    add.addEventListener('click', () => newSession(card.id));
    pop.appendChild(add);
    for (const s of st.sessions) {
      const row = el('div', 'sess-row' + (s.id === st.active ? ' on' : ''));
      row.appendChild(el('span', 'sess-name', s.name));
      const ren = iconBtn('sess-mini', 'pencil', 'Переименовать', 12);
      ren.addEventListener('click', (e) => { e.stopPropagation(); renameSession(card.id, s.id); });
      row.appendChild(ren);
      if (st.sessions.length > 1) {
        const del = iconBtn('sess-mini', 'trash', 'Удалить сессию', 12);
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(card.id, s.id); });
        row.appendChild(del);
      }
      row.addEventListener('click', () => switchSession(card.id, s.id));
      pop.appendChild(row);
    }
  }
  function newSession(cardId) {
    const st = getOrChat(cardId);
    const cur = st.sessions.find((s) => s.id === st.active); // inherit the current session's context size
    const s = blankSession('Сессия ' + (st.sessions.length + 1), cur ? cur.contextN : 10);
    st.sessions.push(s); st.active = s.id; saveOrHist(cardId);
    $('#chat-session-pop').classList.add('hidden');
    updateSessionBtn(); syncCtxInput(); renderChatLog();
    setTimeout(() => { const ta = $('#chat-input'); if (ta) ta.focus(); }, 20);
  }
  function switchSession(cardId, sid) {
    const st = getOrChat(cardId); if (!st.sessions.find((s) => s.id === sid)) return;
    st.active = sid; saveOrHist(cardId);
    $('#chat-session-pop').classList.add('hidden');
    updateSessionBtn(); syncCtxInput(); renderChatLog();
  }
  function renameSession(cardId, sid) {
    const st = getOrChat(cardId); const s = st.sessions.find((x) => x.id === sid); if (!s) return;
    showPrompt('Переименовать сессию', 'Название', s.name, (v) => {
      const t = (v || '').trim(); if (!t) return;
      s.name = t; saveOrHist(cardId); renderSessionList(); updateSessionBtn();
    });
  }
  function deleteSession(cardId, sid) {
    const st = getOrChat(cardId); if (st.sessions.length <= 1) return; // keep ≥1
    showConfirm('Удалить сессию?', 'История этой сессии будет удалена без возможности восстановления.', 'Удалить', () => {
      const wasActive = st.active === sid;
      st.sessions = st.sessions.filter((s) => s.id !== sid);
      if (wasActive) st.active = st.sessions[0].id;
      saveOrHist(cardId);
      renderSessionList(); updateSessionBtn();
      if (wasActive) renderChatLog();
    });
  }
  // Model picker dropdown — fetched once per key, filtered by the search box.
  async function toggleModelPop() {
    const pop = $('#chat-model-pop');
    if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
    const card = activeOrCard(); if (!card) return;
    pop.classList.remove('hidden');
    const search = $('#chat-model-search');
    search.value = ''; search.focus();
    const list = $('#chat-model-list');
    list.innerHTML = '<div class="chat-model-loading">Загрузка моделей…</div>';
    let models = orModelsByKey.get(card.key);
    if (!models) {
      const r = await lite.openrouter.models(card.key);
      if (r.error) { list.innerHTML = ''; list.appendChild(el('div', 'chat-model-loading', 'Ошибка: ' + r.error)); return; }
      models = r.models || []; orModelsByKey.set(card.key, models);
    }
    if (activeCardId !== card.id || pop.classList.contains('hidden')) return;
    renderModelList('');
  }
  function renderModelList(filter) {
    const card = activeOrCard(); if (!card) return;
    const list = $('#chat-model-list');
    const models = orModelsByKey.get(card.key) || [];
    const q = (filter || '').toLowerCase();
    const shown = (q ? models.filter((m) => (m.id + ' ' + m.name).toLowerCase().includes(q)) : models).slice(0, 300);
    list.innerHTML = '';
    if (!shown.length) { list.appendChild(el('div', 'chat-model-loading', 'Ничего не найдено')); return; }
    for (const m of shown) {
      const row = el('div', 'chat-model-row' + (m.id === card.model ? ' on' : ''));
      row.appendChild(el('div', 'cm-name', m.name));
      row.appendChild(el('div', 'cm-id', m.id));
      const meta = el('div', 'cm-meta');
      const ctx = fmtCtx(m.context); if (ctx) meta.appendChild(el('span', 'cm-chip', ctx + ' ctx'));
      const pin = fmtPrice(m.pricing && m.pricing.prompt); if (pin) meta.appendChild(el('span', 'cm-chip', 'вход ' + pin + '/1M'));
      const pout = fmtPrice(m.pricing && m.pricing.completion); if (pout) meta.appendChild(el('span', 'cm-chip', 'выход ' + pout + '/1M'));
      if (meta.childNodes.length) row.appendChild(meta);
      row.addEventListener('click', () => {
        card.model = m.id;
        card.modelMeta = { context: m.context, pricing: m.pricing };
        saveOrCards();
        $('#chat-model-btn').textContent = m.id;
        $('#chat-model-btn').title = modelMetaText(card);
        $('#chat-model-pop').classList.add('hidden');
        renderChatTabs(); // обновить ярлык вкладки активного ключа
      });
      list.appendChild(row);
    }
  }
  // ---------------------------------------------------------------- OpenRouter keys modal
  function deleteOrCard(id) {
    const st = orChats.get(id);
    if (st && st.streaming && st.reqId) { try { lite.openrouter.chatAbort(st.reqId); } catch (_) {} pendingOr.delete(st.reqId); }
    orCards = orCards.filter((c) => c.id !== id);
    saveOrCards();
    orChats.delete(id);
    try { lite.openrouter.histSet(id, []); } catch (_) {}
    if (activeCardId === id) { activeCardId = null; if (chatOpen) renderActiveCard(); }
    renderChatTabs();
  }
  function showOpenRouter() {
    closeMenus();
    const { m, close } = makeModal(`
      <h2><span style="color:var(--green-bright)">🔑</span> OpenRouter</h2>
      <div class="about-desc or-intro">
        Добавь свой API-ключ OpenRouter — он появится отдельной плашкой в колонке слева
        (категория «OpenRouter»). Клик по плашке открывает чат вместо терминала: вверху
        выбираешь любую модель из OpenRouter, ниже — общаешься как в обычном чате.<br><br>
        Купить ключ и следить за балансом удобно на <a href="#" id="or-site">apisell.ru</a>
        или через телеграм-бота <a href="#" id="or-bot">@openrouter_store_bot</a>.
      </div>
      <div class="or-list" id="or-list"></div>
      <div class="or-add">
        <div class="field"><label>API-ключ OpenRouter</label>
          <input type="text" id="or-key" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label>Название (как подписать плашку)</label>
          <input type="text" id="or-name" placeholder="например: Рабочий ключ" autocomplete="off" spellcheck="false"></div>
        <div class="err" id="or-err"></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="or-close">Закрыть</button>
        <button class="btn primary" id="or-add">Добавить ключ</button>
      </div>`);
    m.querySelector('#or-site').onclick = (e) => { e.preventDefault(); lite.openExternal('https://apisell.ru'); };
    m.querySelector('#or-bot').onclick = (e) => { e.preventDefault(); lite.openExternal('https://t.me/openrouter_store_bot'); };
    const listBox = m.querySelector('#or-list');
    const err = m.querySelector('#or-err');
    function renderList() {
      listBox.innerHTML = '';
      if (!orCards.length) { listBox.appendChild(el('div', 'or-empty', 'Пока нет ключей — добавь первый ниже.')); return; }
      for (const c of orCards) {
        const row = el('div', 'or-row');
        const info = el('div', 'or-row-info');
        info.appendChild(el('div', 'or-row-name', c.name));
        info.appendChild(el('div', 'or-row-key', maskKey(c.key) + (c.model ? '  ·  ' + c.model : '')));
        row.appendChild(info);
        const ren = iconBtn('icon-btn', 'pencil', 'Переименовать');
        ren.addEventListener('click', () => showPrompt('Название ключа', 'Название', c.name, (v) => {
          const t = (v || '').trim(); if (!t) return;
          c.name = t; saveOrCards(); renderList(); renderChatTabs();
          if (activeCardId === c.id) $('#chat-title').textContent = t;
        }));
        const del = iconBtn('icon-btn', 'trash', 'Удалить ключ');
        del.addEventListener('click', () => showConfirm('Удалить ключ?',
          `Плашка «${c.name}» и история её чата будут удалены без возможности восстановления.`,
          'Удалить', () => { deleteOrCard(c.id); renderList(); }));
        row.appendChild(ren); row.appendChild(del);
        listBox.appendChild(row);
      }
    }
    renderList();
    m.querySelector('#or-close').onclick = close;
    m.querySelector('#or-add').onclick = () => {
      const key = m.querySelector('#or-key').value.trim();
      const name = m.querySelector('#or-name').value.trim();
      if (!key) { err.textContent = 'Вставь API-ключ OpenRouter'; return; }
      orCards.push({ id: newOrId(), name: name || ('Ключ ' + (orCards.length + 1)), key, model: '', contextN: 10 });
      saveOrCards();
      m.querySelector('#or-key').value = ''; m.querySelector('#or-name').value = ''; err.textContent = '';
      renderList(); renderChatTabs();
    };
    setTimeout(() => m.querySelector('#or-key').focus(), 30);
  }

  // ---- глобальные подписки (вызываются ядром из init, на прежних местах) ----
  function bindStream() {
    lite.openrouter.onChunk(({ reqId, delta }) => { const h = pendingOr.get(reqId); if (h) h.chunk(delta); });
    lite.openrouter.onDone(({ reqId }) => { const h = pendingOr.get(reqId); if (h) h.done(); });
    lite.openrouter.onError(({ reqId, error }) => { const h = pendingOr.get(reqId); if (h) h.error(error); });
  }
  function bindControls() {
  $('#chat-keys').addEventListener('click', (e) => { e.stopPropagation(); showOpenRouter(); });
  $('#chat-usage-refresh').addEventListener('click', (e) => { e.stopPropagation(); const c = activeOrCard(); if (c) fetchKeyInfo(c.key, true); });
  $('#chat-send').addEventListener('click', onSendClick);
  $('#chat-model-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleModelPop(); });
  $('#chat-model-search').addEventListener('input', (e) => renderModelList(e.target.value));
  $('#chat-model-pop').addEventListener('click', (e) => e.stopPropagation());
  $('#chat-session-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleSessionPop(); });
  $('#chat-session-pop').addEventListener('click', (e) => e.stopPropagation());
  $('#chat-log').addEventListener('click', (e) => {
    const img = e.target.closest('img'); // generated/markdown image → open in a lightbox
    if (img && img.src) { e.preventDefault(); openImageLightbox(img.src); return; }
    const a = e.target.closest('a[href]'); if (!a) return; // links in messages open in the system browser
    e.preventDefault();
    // model output is untrusted — only open http(s); never file:/custom schemes via openExternal
    try { const u = new URL(a.getAttribute('href'), location.href); if (u.protocol === 'http:' || u.protocol === 'https:') lite.openExternal(u.href); } catch (_) {}
  });
  $('#chat-ctx-input').addEventListener('change', (e) => {
    const card = activeOrCard(); if (!card) return;
    const s = activeSession(); if (!s) return;
    const v = clamp(e.target.value, 1, 100); e.target.value = v; s.contextN = v; // bind to the active session
    saveOrHist(card.id);
  });
  const chatInput = $('#chat-input');
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } // Enter sends; sendChat no-ops while streaming (use ■ to stop)
  });
  chatInput.addEventListener('input', () => { // auto-grow the textarea up to a cap
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  });
  document.addEventListener('click', () => {
    for (const sel of ['#chat-model-pop', '#chat-session-pop']) { const p = $(sel); if (p && !p.classList.contains('hidden')) p.classList.add('hidden'); }
  });
  }

  return {
    isOpen: () => chatOpen,
    setOpen: setChatOpen,
    toggle: toggleChat,
    bindStream,
    bindControls,
  };
}
