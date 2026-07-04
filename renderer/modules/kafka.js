// LiteEditor — модуль «Kafka»: профили кластеров + воркспейс Обзор / Топики / Группы / Live-tail
// поверх kafkajs (бэкенд lib/kafka.js). Функционал стандартных клиентов (AKHQ/Kafka UI): топики
// с партициями/RF/ISR, создание/удаление/purge/партиции/конфиги, консюмер-группы с ЛАГОМ и
// сбросом оффсетов, просмотр сообщений (peek), публикация; свои фишки: live-tail топика в
// реальном времени (живёт в фоне у неактивных вкладок), графики скоростей и лага (копятся
// клиентом — у Kafka нет history API), спарклайны In/с у топиков и тренд лага у групп с
// тревогой «лаг растёт». Вкладки профилей, PRODUCTION-гард, приём заготовки из «Контейнеров».
// Изоляция по образцу rmq.js: ядро — через host; UI-хелперы — из ui.js; бэкенд — window.lite.kafka.*.
import { el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt } from '../ui.js';
import Chart from 'chart.js/auto';   // уже в бандле (модули БД/RabbitMQ)

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initKafka(host) {
  const { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let kfkOpen = false;
  let connsList = [], secure = true;
  let activeId = null, activeConn = null;
  let renderSeq = 0;
  let restoredOnce = false;
  // ---- вкладки профилей: несколько открытых кластеров одновременно (модель как в RabbitMQ/БД)
  let openProfs = [];
  let profListMode = false;
  const profStates = new Map();   // profileId -> снапшот воркспейса
  let kafkaUi = (STORE.kafkaUi && typeof STORE.kafkaUi === 'object') ? STORE.kafkaUi : {};
  const saveUi = () => persist('kafkaUi', kafkaUi);

  // --- workspace state (свапается вкладками)
  let section = 'topics';        // 'overview' | 'topics' | 'groups' | 'tail'
  let filterText = '';
  let sortKey = 'name', sortDir = 1;
  let cur = {};                  // последние данные секций
  let lastSig = '';
  let pollTimer = null, pollBusy = false;
  let peekT = null;              // имя топика с открытой панелью сообщений
  let dataBox = null, peekBox = null, statusEl = null;
  let showInternal = false;      // служебные топики (__consumer_offsets и т.п.)
  let ovEls = null;              // скелет обзора (карточки + Chart-инстансы)
  // Графики и спарклайны копятся КЛИЕНТОМ между поллами (у Kafka нет history API, как у
  // RMQ management): серии живут в состоянии профиля и переживают переключение вкладок.
  const freshSeries = () => ({ rate: [], lag: [] });          // [{t, produce, consume}], [{t, v}]
  let series = freshSeries();
  let sparks = new Map();        // topic  -> [rate…] (cap 12) — спарклайн In/с в строке топика
  let lagHist = new Map();       // groupId -> [lag…] (cap 12) — тренд лага в строке группы

  // --- live-tail: per-профильный объект; стрим ЖИВЁТ в фоне у неактивных вкладок
  let tailUid = 0;
  let tailEls = null;
  let tailPreset = null;         // { topic } — автозапуск из строки топика
  const freshTail = () => ({ id: null, paused: false, buf: [], count: 0, msgs: [], topic: '', filter: '', note: '' });
  let tail = freshTail();
  const tailStreams = new Map(); // streamId -> tail-объект своего профиля

  // ---------------------------------------------------------------- helpers
  const fmtN = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const fmtRate = (r) => r == null ? '—' : (r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2));
  function fmtB(n) {
    n = Number(n); if (!Number.isFinite(n) || n <= 0) return '—';
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  }
  function catHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function cssVar(name, fb) { try { const v = getComputedStyle(document.body).getPropertyValue(name).trim(); return v || fb; } catch (_) { return fb; } }
  function badge(txt, title, cls) { const b = el('span', 'rmq-badge' + (cls ? ' ' + cls : ''), txt); if (title) b.title = title; return b; }
  function guardedConfirm(title, msg, btnLabel, run) {
    const prod = activeConn && activeConn.isProd;
    showConfirm(prod ? 'PRODUCTION — ' + title : title, msg + (prod ? ' Профиль помечен как PRODUCTION!' : ''), btnLabel, run);
  }
  function setStatus(ok, err) {
    if (!statusEl) return;
    statusEl.className = 'db-status-dot ' + (ok ? 'ok' : 'err');
    statusEl.title = ok ? 'Подключено (брокер отвечает)' : ('Нет связи: ' + (err || ''));
  }

  // ---------------------------------------------------------------- open/close
  function setKafkaOpen(open, opts = {}) {
    if (open === kfkOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('kafka');
    else { stopPoll(); stopAllTails(); }
    const delta = layout.kafka + GUTTER;
    kfkOpen = open;
    $('#kafka-pane').classList.toggle('hidden', !open);
    $('#gutter-kafka').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleKafka() { setKafkaOpen(!kfkOpen); }

  // ---------------------------------------------------------------- panel router
  async function renderPanel() {
    const seq = ++renderSeq;
    const body = $('#kafka-body');
    if (!activeId || profListMode) {
      stopPoll();
      body.innerHTML = '<div class="git-loading">Загрузка профилей…</div>';
      try { const r = await lite.kafka.list(); connsList = r.connections || []; secure = r.secure !== false; }
      catch (_) { connsList = []; }
      if (seq !== renderSeq || !kfkOpen) return;
      if (!restoredOnce) { // восстановление набора вкладок прошлого запуска
        restoredOnce = true;
        const ids = (Array.isArray(kafkaUi.openTabs) ? kafkaUi.openTabs : []).filter((id) => connsList.some((c) => c.id === id));
        if (ids.length && !profListMode) {
          openProfs = ids;
          const actId = (kafkaUi.activeTab && ids.includes(kafkaUi.activeTab)) ? kafkaUi.activeTab : ids[ids.length - 1];
          const act = connsList.find((c) => c.id === actId);
          if (act) { openProfile(act); return; }
        }
      }
      body.innerHTML = '';
      renderProfStrip(body);
      const wrap = el('div', 'db-list-wrap');
      body.appendChild(wrap);
      renderProfiles(wrap);
    } else {
      body.innerHTML = '';
      renderProfStrip(body);
      const wrap = el('div', 'db-ws-wrap');
      body.appendChild(wrap);
      renderWorkspace(wrap);
    }
  }

  // ---------------------------------------------------------------- profiles list
  function renderProfiles(body) {
    body.innerHTML = '';
    const top = el('div', 'db-topbar');
    top.appendChild(el('span', 'db-topbar-title', 'Кластеры Kafka'));
    const add = iconBtn('drow-act', 'plus', 'Новый профиль', 16); add.onclick = () => connModal(null);
    top.appendChild(add);
    body.appendChild(top);
    if (!secure) body.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — пароли шифруются слабее.'));
    if (!connsList.length) { body.appendChild(el('div', 'docker-empty', 'Нет профилей. Добавь первый кнопкой ＋ или из модуля «Контейнеры» (иконка Kafka у контейнера брокера).')); return; }
    const groups = {};
    for (const c of connsList) { const g = c.category || 'Все'; (groups[g] = groups[g] || []).push(c); }
    const cats = Object.keys(groups).sort((a, b) => (a === 'Все' ? -1 : b === 'Все' ? 1 : a.localeCompare(b)));
    for (const cat of cats) body.appendChild(catBlock(cat, groups[cat]));
  }
  function catBlock(cat, list) {
    const block = el('div', 'docker-group-block');
    const head = el('div', 'docker-group-head');
    const hue = catHue(cat);
    head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
    head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
    const collapsed = !!(kafkaUi.catCollapsed && kafkaUi.catCollapsed[cat]);
    const chev = icon(collapsed ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
    head.append(chev, el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(list.length)));
    const bodyEl = el('div', 'docker-group-body');
    if (collapsed) bodyEl.style.display = 'none';
    for (const c of list) bodyEl.appendChild(connRow(c));
    head.onclick = () => {
      kafkaUi.catCollapsed = kafkaUi.catCollapsed || {}; kafkaUi.catCollapsed[cat] = !kafkaUi.catCollapsed[cat]; saveUi();
      const col = kafkaUi.catCollapsed[cat]; bodyEl.style.display = col ? 'none' : '';
      const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev'); head.replaceChild(nc, head.firstChild);
    };
    block.append(head, bodyEl);
    return block;
  }
  function connRow(c) {
    const row = el('div', 'db-conn-row clickable');
    if (c.color) { row.style.borderLeft = `3px solid ${c.color}`; row.style.paddingLeft = '6px'; }
    row.appendChild(icon('kafka', 16));
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', c.name || '(без имени)'));
    main.appendChild(el('span', 'drow-sub', `${c.brokers || '127.0.0.1:9092'}${c.saslMechanism ? ' · ' + c.saslMechanism : ''}${c.ssl ? ' · TLS' : ''}${c.isProd ? ' · PROD' : ''}`));
    row.appendChild(main);
    if (openProfs.includes(c.id)) row.appendChild(el('span', 'db-ro-badge', 'открыто'));
    const acts = el('div', 'drow-acts');
    const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13); edit.onclick = (e) => { e.stopPropagation(); connModal(c); };
    const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
    del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить профиль?', `«${c.name}» удалится из списка (сам кластер не трогается).`, 'Удалить', async () => {
      await lite.kafka.delete(c.id);
      const st = profStates.get(c.id);
      const tl = activeId === c.id ? tail : (st && st.tail);
      if (tl) stopTail(tl);
      openProfs = openProfs.filter((x) => x !== c.id); profStates.delete(c.id);
      if (activeId === c.id) { activeId = null; activeConn = null; cur = {}; tail = freshTail(); tailEls = null; }
      saveOpenSet();
      renderPanel();
    }); };
    acts.append(edit, del); row.appendChild(acts);
    row.addEventListener('click', () => openProfile(c));
    return row;
  }

  // Открыть/активировать вкладку профиля; состояние — из памяти, если уже открывали.
  function openProfile(c) {
    if (activeId === c.id && !profListMode) { renderPanel(); return; }
    if (activeId) snapshotProf();
    stopPoll();
    profListMode = false;
    if (!openProfs.includes(c.id)) openProfs.push(c.id);
    const s = profStates.get(c.id);
    activeId = c.id; activeConn = (s && s.conn) || c;
    if (s) {
      section = s.section; filterText = s.filterText; sortKey = s.sortKey; sortDir = s.sortDir;
      cur = s.cur; peekT = s.peekT; tail = s.tail; showInternal = s.showInternal;
      series = s.series || freshSeries(); sparks = s.sparks || new Map(); lagHist = s.lagHist || new Map();
    } else {
      section = 'topics'; filterText = ''; sortKey = 'name'; sortDir = 1;
      cur = {}; peekT = null; tail = freshTail(); showInternal = false;
      series = freshSeries(); sparks = new Map(); lagHist = new Map();
    }
    lastSig = ''; tailEls = null;
    saveOpenSet();
    renderPanel();
  }
  function saveOpenSet() { kafkaUi.openTabs = openProfs.slice(); kafkaUi.activeTab = activeId; saveUi(); }
  function snapshotProf() {
    if (!activeId) return;
    profStates.set(activeId, { conn: activeConn, section, filterText, sortKey, sortDir, cur, peekT, tail, showInternal, series, sparks, lagHist });
  }
  function closeProfTab(id) {
    const st = profStates.get(id);
    const tl = id === activeId ? tail : (st && st.tail);
    if (tl) stopTail(tl);
    const wasActive = id === activeId;
    openProfs = openProfs.filter((x) => x !== id);
    profStates.delete(id);
    if (wasActive) {
      stopPoll();
      activeId = null; activeConn = null; cur = {}; peekT = null; tail = freshTail(); tailEls = null;
      const nextId = openProfs[openProfs.length - 1];
      if (nextId) {
        const ns = profStates.get(nextId);
        const next = (ns && ns.conn) || connsList.find((x) => x.id === nextId);
        if (next) { saveOpenSet(); openProfile(next); return; }
      }
      profListMode = false;
    }
    saveOpenSet();
    renderPanel();
  }
  // Полоса вкладок-профилей (классы общие с БД/RMQ: db-conn-strip / db-ctab / db-conndd).
  function renderProfStrip(hostEl) {
    if (!openProfs.length) return;
    const strip = el('div', 'db-conn-strip');
    for (const id of openProfs) {
      const st = profStates.get(id);
      const c = (activeId === id ? activeConn : (st && st.conn)) || connsList.find((x) => x.id === id) || { id, name: '…' };
      const tl = activeId === id ? tail : (st && st.tail);
      const tab = el('div', 'db-ctab' + (id === activeId && !profListMode ? ' on' : ''));
      const dot = el('span', 'db-ctab-dot'); if (c.color) dot.style.background = c.color;
      tab.append(dot, el('span', 'db-ctab-name', c.name || id));
      if (tl && tl.id) { const live = el('span', 'db-ctab-live'); live.appendChild(icon('play', 10)); live.title = 'Live-tail работает в фоне'; tab.appendChild(live); }
      const x = iconBtn('db-ctab-x', 'x', 'Закрыть вкладку (её live-tail остановится)', 11);
      x.onclick = (e) => { e.stopPropagation(); closeProfTab(id); };
      tab.appendChild(x);
      tab.onclick = () => { if (id !== activeId || profListMode) openProfile(c); };
      strip.appendChild(tab);
    }
    const add = iconBtn('db-ctab-add', 'plus', 'Открыть ещё профиль…', 14);
    add.onclick = (e) => { e.stopPropagation(); profDropdown(add); };
    strip.appendChild(add);
    hostEl.appendChild(strip);
  }
  function closeProfDd() { const d = document.getElementById('kafka-conndd'); if (d) d.remove(); }
  async function profDropdown(anchor) {
    closeProfDd();
    const dd = el('div', 'db-conndd'); dd.id = 'kafka-conndd';
    dd.appendChild(el('div', 'db-conndd-load', 'Загружаю…'));
    document.body.appendChild(dd);
    const r0 = anchor.getBoundingClientRect();
    dd.style.left = Math.max(8, Math.min(r0.left, window.innerWidth - 300)) + 'px';
    dd.style.top = (r0.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', closeProfDd, { once: true }), 0);
    let list = connsList;
    try { const r = await lite.kafka.list(); list = r.connections || []; connsList = list; } catch (_) {}
    if (!document.getElementById('kafka-conndd')) return;
    dd.innerHTML = '';
    for (const c of list) {
      const row = el('div', 'db-conndd-row');
      const dot = el('span', 'db-ctab-dot'); if (c.color) dot.style.background = c.color;
      row.append(dot, el('span', 'db-conndd-name', c.name || '(без имени)'));
      row.appendChild(el('span', 'db-conndd-sub', String(c.brokers || '').split(/[\s,;]+/)[0] || ''));
      if (openProfs.includes(c.id)) row.appendChild(el('span', 'db-conndd-mark', 'открыто'));
      row.onclick = () => { closeProfDd(); openProfile(c); };
      dd.appendChild(row);
    }
    if (!list.length) dd.appendChild(el('div', 'db-conndd-load', 'Нет сохранённых профилей'));
    const nw = el('div', 'db-conndd-row db-conndd-new');
    nw.append(icon('plus', 13), el('span', 'db-conndd-name', 'Новый профиль…'));
    nw.onclick = () => { closeProfDd(); connModal(null); };
    dd.appendChild(nw);
  }

  // ---------------------------------------------------------------- profile modal
  function connModal(existing) {
    const c = existing ? { ...existing } : { category: 'Все', brokers: '127.0.0.1:9092' };
    const { m, close } = makeModal(`<h2>${c.id ? 'Изменить' : 'Новый'} профиль Kafka</h2><div id="kfkf" class="db-form"></div>`);
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#kfkf');
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
    const name = inp(c.name, 'Мой кластер');
    f.appendChild(mk('Имя', name));
    const cats = [...new Set(connsList.map((x) => (x.category || 'Все')).filter(Boolean))];
    if (!cats.includes('Все')) cats.unshift('Все');
    if (c.category && !cats.includes(c.category)) cats.push(c.category);
    const catSel = el('select'); for (const cc of cats) { const o = new Option(cc, cc); if (cc === (c.category || 'Все')) o.selected = true; catSel.appendChild(o); }
    const CAT_NEW = '__newcat__'; catSel.appendChild(new Option('➕ Новая категория…', CAT_NEW));
    const catNew = inp('', 'Название новой категории'); catNew.style.display = 'none';
    catSel.onchange = () => { const isNew = catSel.value === CAT_NEW; catNew.style.display = isNew ? '' : 'none'; if (isNew) catNew.focus(); };
    const catWrap = el('div', 'db-cat-wrap'); catWrap.append(catSel, catNew);
    f.appendChild(mk('Категория', catWrap));
    const grp = el('div', 'db-group');
    const brokersI = inp(c.brokers || '', 'host1:9092, host2:9092');
    brokersI.title = 'Bootstrap-брокеры через запятую';
    const saslSel = el('select');
    for (const [v, lbl] of [['', 'без аутентификации'], ['plain', 'SASL PLAIN'], ['scram-sha-256', 'SCRAM-SHA-256'], ['scram-sha-512', 'SCRAM-SHA-512']]) {
      const o = new Option(lbl, v); if ((c.saslMechanism || '') === v) o.selected = true; saslSel.appendChild(o);
    }
    const userI = inp(c.user || '', 'логин SASL');
    const passI = inp(c.password || '', c.id ? '(без изменений)' : 'пароль SASL', 'password');
    const syncSasl = () => { const on = !!saslSel.value; userI.disabled = passI.disabled = !on; };
    saslSel.onchange = syncSasl;
    const tls = el('input'); tls.type = 'checkbox'; tls.checked = !!c.ssl;
    const tlsLabel = el('label', 'db-check'); tlsLabel.append(tls, document.createTextNode(' TLS (SSL) до брокеров'));
    grp.append(mk('Брокеры', brokersI), mk('Аутентификация', saslSel), mk('Пользователь', userI), mk('Пароль', passI), tlsLabel);
    f.appendChild(grp);
    const colorSel = el('select');
    for (const [v, lbl] of [['', 'без цвета'], ['#e5484d', '🔴 красный (prod)'], ['#f5a623', '🟠 янтарный (stage)'], ['#30a46c', '🟢 зелёный (dev)'], ['#0091ff', '🔵 синий'], ['#8e4ec6', '🟣 фиолетовый']]) { const o = document.createElement('option'); o.value = v; o.textContent = lbl; if ((c.color || '') === v) o.selected = true; colorSel.appendChild(o); }
    f.appendChild(mk('Цвет окружения', colorSel));
    const prod = el('input'); prod.type = 'checkbox'; prod.checked = !!c.isProd;
    const prodLabel = el('label', 'db-check db-check-warn'); prodLabel.append(prod, document.createTextNode(' PRODUCTION — предупреждать перед purge/delete/reset'));
    f.appendChild(prodLabel);
    syncSasl();
    const collect = () => {
      const o = {
        id: c.id, name: name.value.trim(), category: (catSel.value === CAT_NEW ? catNew.value.trim() : catSel.value) || 'Все',
        brokers: brokersI.value.trim() || '127.0.0.1:9092', ssl: tls.checked,
        saslMechanism: saslSel.value, user: userI.value.trim(),
        color: colorSel.value, isProd: prod.checked,
      };
      if (passI.value) o.password = passI.value;
      if (c.source) o.source = c.source; // метка «создано из контейнера X» — для дедупа повторных кликов
      return o;
    };
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const test = el('button', 'btn', 'Тест');
    test.onclick = async () => {
      status.textContent = 'Проверяю…'; status.className = 'db-test-status';
      const r = await lite.kafka.test(collect());
      if (r.ok) { status.textContent = `✓ ${r.version || 'подключение успешно'}`; status.classList.add('ok'); }
      else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); }
    };
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => {
      const o = collect();
      if (!o.name) { toast('Введи имя', { kind: 'err' }); return; }
      const r = await lite.kafka.save(o);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      close(); renderPanel();
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
  }

  // ---------------------------------------------------------------- «Контейнеры» → Kafka
  async function openFromContainer(payload) {
    const p = payload && payload.prefill;
    if (!p || !p.name) return;
    restoredOnce = true;
    let list = [];
    try { const r = await lite.kafka.list(); list = r.connections || []; connsList = list; secure = r.secure !== false; } catch (_) {}
    const existing = list.find((x) => x.source && x.source === p.source);
    if (existing) { toast(`Переключаюсь на «${existing.name}»`, { ttl: 2200 }); openProfile(existing); return; }
    const toList = () => { if (activeId) { stopPoll(); snapshotProf(); } profListMode = true; renderPanel(); };
    const draft = { ...p };
    toast(`Проверяю подключение к «${draft.name}»…`, { ttl: 2500 });
    let t;
    try { t = await lite.kafka.test(draft); } catch (e) { t = { ok: false, error: String(e) }; }
    if (t && t.ok) {
      const r = await lite.kafka.save(draft);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      toast(`✓ ${t.version || 'Подключено'} — профиль создан из контейнера`);
      openProfile(r.connection);
    } else {
      toast('Автопроверка не прошла: ' + ((t && t.error) || 'нет ответа') + ' — проверь advertised.listeners/порт', { kind: 'err', ttl: 9000 });
      toList(); connModal(draft);
    }
  }

  // ---------------------------------------------------------------- workspace
  const SECTIONS = [['overview', 'Обзор'], ['topics', 'Топики'], ['groups', 'Группы'], ['tail', 'Live-tail']];
  function renderWorkspace(body) {
    stopPoll();
    body.innerHTML = '';
    const head = el('div', 'db-ws-head');
    if (activeConn.color) head.style.borderBottom = `2px solid ${activeConn.color}`;
    const back = iconBtn('drow-act', 'chevron-left', 'К списку профилей (вкладка останется открытой)', 16);
    back.onclick = () => { stopPoll(); snapshotProf(); profListMode = true; renderPanel(); };
    statusEl = el('span', 'db-status-dot'); statusEl.title = 'Проверка соединения…';
    head.append(back, statusEl, icon('kafka', 15), el('span', 'db-ws-name', activeConn.name));
    if (activeConn.isProd) head.appendChild(el('span', 'db-ro-badge', 'PROD'));
    body.appendChild(head);
    const tabsEl = el('div', 'docker-subtabs');
    for (const [k, label] of SECTIONS) {
      const t = el('button', 'docker-subtab' + (k === section ? ' on' : '')); t.dataset.k = k; t.textContent = label;
      t.onclick = () => {
        if (section === t.dataset.k) return;
        section = t.dataset.k; peekT = null; filterText = '';
        tabsEl.querySelectorAll('.docker-subtab').forEach((b) => b.classList.toggle('on', b.dataset.k === section));
        mountSection();
      };
      tabsEl.appendChild(t);
    }
    body.appendChild(tabsEl);
    const secBox = el('div', 'rmq-sec'); secBox.id = 'kafka-secbox';
    body.appendChild(secBox);
    mountSection();
  }

  // Каркас секции: тулбар строится один раз (фокус в фильтре не теряется); данные
  // перерисовываются только при изменении (сигнатура).
  function mountSection() {
    const box = document.getElementById('kafka-secbox'); if (!box) return;
    destroyOvCharts();
    box.innerHTML = ''; dataBox = null; peekBox = null; tailEls = null; lastSig = ''; // tail НЕ стопаем — живёт в фоне
    if (section === 'tail') { stopPoll(); mountTail(box); return; }
    if (section === 'topics' || section === 'groups') {
      const bar = el('div', 'rmq-toolbar');
      const filt = el('input', 'rmq-filter'); filt.type = 'search'; filt.placeholder = 'Фильтр по имени…'; filt.value = filterText;
      filt.oninput = () => { filterText = filt.value; renderData(); };
      bar.appendChild(filt);
      if (section === 'topics') {
        const intLabel = el('label', 'db-check kfk-int-check');
        const intCb = el('input'); intCb.type = 'checkbox'; intCb.checked = showInternal;
        intCb.onchange = () => { showInternal = intCb.checked; lastSig = ''; loadSection(false); };
        intLabel.append(intCb, document.createTextNode(' служебные'));
        intLabel.title = 'Показывать внутренние топики (__consumer_offsets и т.п.)';
        bar.appendChild(intLabel);
        const crt = el('button', 'btn rmq-pub-btn');
        crt.append(icon('plus', 13), document.createTextNode(' Топик'));
        crt.title = 'Создать топик';
        crt.onclick = () => createTopicModal();
        bar.appendChild(crt);
        const pub = el('button', 'btn rmq-pub-btn');
        pub.append(icon('upload', 13), document.createTextNode(' Отправить'));
        pub.onclick = () => produceModal({});
        bar.appendChild(pub);
      }
      box.appendChild(bar);
    }
    dataBox = el('div', 'rmq-data');
    dataBox.appendChild(el('div', 'git-loading', 'Загружаю…'));
    box.appendChild(dataBox);
    if (section === 'topics') { peekBox = el('div', 'rmq-peek'); peekBox.style.display = 'none'; box.appendChild(peekBox); }
    loadSection(false);
    startPoll();
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function startPoll() {
    stopPoll();
    // Kafka-операции тяжелее HTTP RMQ (оффсеты каждого топика) — поллим чуть реже.
    pollTimer = setInterval(() => { if (!document.hidden) loadSection(true); }, 4000);
  }
  async function loadSection(silent) {
    if (section === 'tail') return;
    if (!activeId || pollBusy || !dataBox) return;
    pollBusy = true;
    const id = activeId, sec = section, seq = ++renderSeq;
    let r, err = null;
    try {
      if (sec === 'overview') r = await lite.kafka.overview(id);
      else if (sec === 'topics') r = await lite.kafka.topics(id, showInternal);
      else r = await lite.kafka.groups(id);
      if (r && r.error) err = r.error;
    } catch (e) { err = String(e); }
    pollBusy = false;
    if (activeId !== id || section !== sec || !dataBox) return;
    if (err) {
      setStatus(false, err);
      if (!silent || !dataBox.querySelector('[data-k], .rmq-ov')) { destroyOvCharts(); dataBox.innerHTML = ''; dataBox.appendChild(el('div', 'docker-err', err)); lastSig = ''; }
      return;
    }
    setStatus(true);
    if (sec === 'overview') { cur.overview = r; pushOvSample(r); renderOverviewLive(); return; }
    cur[sec] = r.items || [];
    if (sec === 'topics') pushTopicSparks(cur.topics);
    if (sec === 'groups') pushLagHist(cur.groups);
    const sig = JSON.stringify(cur[sec]);
    if (sig !== lastSig || seq === renderSeq && !dataBox.childElementCount) { lastSig = sig; renderData(); }
  }

  function renderData() {
    if (!dataBox) return;
    if (section === 'overview') return renderOverviewLive();
    const scroll0 = dataBox.scrollTop;
    dataBox.innerHTML = '';
    const q = (filterText || '').toLowerCase();
    if (section === 'topics') {
      let items = (cur.topics || []).filter((x) => !q || x.name.toLowerCase().includes(q));
      items = sortItems(items);
      renderTopics(dataBox, items);
    } else {
      let items = (cur.groups || []).filter((x) => !q || x.groupId.toLowerCase().includes(q));
      items = sortItems(items);
      renderGroups(dataBox, items);
    }
    dataBox.scrollTop = scroll0;
  }
  function sortItems(items) {
    const k = sortKey, d = sortDir;
    return [...items].sort((a, b) => {
      const av = a[k], bv = b[k];
      if (typeof av === 'string' || typeof bv === 'string') return d * String(av).localeCompare(String(bv));
      return d * ((av == null ? -1 : av) - (bv == null ? -1 : bv));
    });
  }

  // ---------------------------------------------------------------- клиентские серии/спарклайны
  const SPARK_CAP = 12, SERIES_CAP = 240;
  function pushOvSample(ov) {
    const t = ov.ts || Date.now();
    series.rate.push({ t, produce: ov.produceRate, consume: ov.consumeRate });
    if (series.rate.length > SERIES_CAP) series.rate.shift();
    if (ov.totalLag != null) {
      series.lag.push({ t, v: ov.totalLag });
      if (series.lag.length > SERIES_CAP) series.lag.shift();
    }
  }
  function pushTopicSparks(items) {
    const alive = new Set();
    for (const it of items || []) {
      alive.add(it.name);
      if (it.rate == null) continue;
      const arr = sparks.get(it.name) || [];
      arr.push(it.rate);
      if (arr.length > SPARK_CAP) arr.shift();
      sparks.set(it.name, arr);
    }
    for (const k of [...sparks.keys()]) if (!alive.has(k)) sparks.delete(k);
  }
  function pushLagHist(items) {
    const alive = new Set();
    for (const it of items || []) {
      alive.add(it.groupId);
      if (it.lag == null) continue;
      const arr = lagHist.get(it.groupId) || [];
      arr.push(it.lag);
      if (arr.length > SPARK_CAP) arr.shift();
      lagHist.set(it.groupId, arr);
    }
    for (const k of [...lagHist.keys()]) if (!alive.has(k)) lagHist.delete(k);
  }
  // Инлайн-SVG спарклайн (как в RMQ): тренд кодируем цветом + стрелкой (не только цветом).
  function sparkCellFrom(vals, opts = {}) {
    const cell = el('span', 'rmq-cell rmq-spark');
    if (!vals || vals.length < 2) { cell.textContent = '—'; cell.classList.add('dim'); return cell; }
    const min = Math.min(...vals), max = Math.max(...vals);
    const W = 68, H = 16;
    const pts = vals.map((v, i) =>
      `${(i / (vals.length - 1) * W).toFixed(1)},${(H - 2 - (max === min ? (H - 4) / 2 : (v - min) / (max - min) * (H - 4))).toFixed(1)}`).join(' ');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'rmq-spark-svg');
    const pl = document.createElementNS(NS, 'polyline');
    pl.setAttribute('points', pts); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', 'currentColor'); pl.setAttribute('stroke-width', '1.5');
    svg.appendChild(pl);
    cell.appendChild(svg);
    const first = vals[0], last = vals[vals.length - 1];
    const grow = last > first * 1.1 && last - first >= (opts.minDelta != null ? opts.minDelta : 5);
    const fall = first > last * 1.1 && first - last >= (opts.minDelta != null ? opts.minDelta : 5);
    if (grow && opts.growBad) { cell.classList.add('bad'); cell.title = (opts.label || '') + ` растёт: ${fmtN(Math.round(first))} → ${fmtN(Math.round(last))}`; cell.appendChild(el('span', 'rmq-trend', '↑')); }
    else if (fall && opts.growBad) { cell.classList.add('good'); cell.title = (opts.label || '') + ` падает: ${fmtN(Math.round(first))} → ${fmtN(Math.round(last))}`; cell.appendChild(el('span', 'rmq-trend', '↓')); }
    else { cell.classList.add('dim'); cell.title = (opts.label || '') + ` ${fmtN(Math.round(min))}…${fmtN(Math.round(max))}`; }
    return cell;
  }

  // ---------------------------------------------------------------- Обзор (KPI + графики)
  function destroyOvCharts() {
    if (ovEls) { for (const ch of [ovEls.chRate, ovEls.chLag]) { try { ch && ch.destroy(); } catch (_) {} } }
    ovEls = null;
  }
  function renderOverviewLive() {
    if (!dataBox || section !== 'overview') return;
    if (!ovEls || !dataBox.contains(ovEls.root)) buildOverview(dataBox);
    updateOverview(cur.overview);
  }
  function buildOverview(box) {
    destroyOvCharts();
    box.innerHTML = '';
    const root = el('div', 'rmq-ov');
    const cards = el('div', 'rmq-cards');
    const mkCard = (title) => {
      const cEl = el('div', 'rmq-card');
      cEl.appendChild(el('div', 'rmq-card-t', title));
      const v = el('div', 'rmq-card-v', '—'); const s = el('div', 'rmq-card-s', '');
      cEl.append(v, s); cards.appendChild(cEl);
      return { v, s };
    };
    const cMsg = mkCard('Сообщений'), cIn = mkCard('Запись'), cOut = mkCard('Чтение'), cT = mkCard('Топики'), cG = mkCard('Группы');
    root.appendChild(cards);
    const chBar = el('div', 'rmq-ch-bar');
    chBar.appendChild(el('span', 'rmq-ch-title', 'Графики'));
    chBar.appendChild(el('span', 'kfk-ch-note', 'копятся, пока профиль открыт (у Kafka нет истории метрик)'));
    root.appendChild(chBar);
    const wrapRate = el('div', 'rmq-chart'); const cvRate = document.createElement('canvas'); wrapRate.appendChild(cvRate);
    const wrapLag = el('div', 'rmq-chart'); const cvLag = document.createElement('canvas'); wrapLag.appendChild(cvLag);
    root.append(el('div', 'rmq-ch-cap', 'Скорости, сообщ./с'), wrapRate, el('div', 'rmq-ch-cap', 'Суммарный лаг консюмер-групп'), wrapLag);
    root.appendChild(el('div', 'rmq-ch-cap', 'Брокеры'));
    const nodesBox = el('div', 'rmq-nodes'); root.appendChild(nodesBox);
    const meta = el('div', 'rmq-meta'); root.appendChild(meta);
    box.appendChild(root);
    const mkChart = (canvas, seriesDef) => new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: seriesDef.map((s0) => ({ label: s0.label, data: [], borderColor: s0.color, backgroundColor: s0.color, borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.25, fill: false, spanGaps: true })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: cssVar('--text-dim', '#8d949d'), boxWidth: 10, boxHeight: 10, font: { size: 10 } } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { ticks: { color: cssVar('--text-mute', '#626a73'), font: { size: 9 }, maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { color: cssVar('--border', 'rgba(128,128,128,.08)') } },
          y: { beginAtZero: true, ticks: { color: cssVar('--text-mute', '#626a73'), font: { size: 9 }, maxTicksLimit: 5 }, grid: { color: cssVar('--border', 'rgba(128,128,128,.08)') } },
        },
      },
    });
    const chRate = mkChart(cvRate, [
      { label: 'Запись', color: cssVar('--green', '#34d399') },
      { label: 'Чтение', color: cssVar('--info', '#7aa2f7') },
    ]);
    const chLag = mkChart(cvLag, [
      { label: 'Лаг', color: cssVar('--warn', '#e0af68') },
    ]);
    ovEls = { root, cMsg, cIn, cOut, cT, cG, chRate, chLag, nodesBox, meta, nodesSig: '' };
  }
  function updateOverview(ov) {
    if (!ovEls || !ov) return;
    ovEls.cMsg.v.textContent = fmtN(ov.totalMessages);
    ovEls.cMsg.s.textContent = `партиций ${fmtN(ov.partitionCount)}${ov.underReplicated ? ` · ⚠ UR ${ov.underReplicated}` : ''}`;
    ovEls.cIn.v.textContent = ov.produceRate == null ? '—' : fmtRate(ov.produceRate) + '/с';
    ovEls.cIn.s.textContent = 'входящий поток';
    ovEls.cOut.v.textContent = ov.consumeRate == null ? '—' : fmtRate(ov.consumeRate) + '/с';
    ovEls.cOut.s.textContent = ov.totalLag != null ? `лаг ${fmtN(ov.totalLag)}` : 'коммиты групп';
    ovEls.cT.v.textContent = fmtN(ov.topicCount);
    ovEls.cT.s.textContent = ov.internalCount ? `+ ${ov.internalCount} служебных` : '';
    ovEls.cG.v.textContent = fmtN(ov.groupCount);
    ovEls.cG.s.textContent = 'консюмер-группы';
    const fmtT = (t) => new Date(t).toTimeString().slice(0, 8);
    ovEls.chRate.data.labels = series.rate.map((p) => fmtT(p.t));
    ovEls.chRate.data.datasets[0].data = series.rate.map((p) => p.produce);
    ovEls.chRate.data.datasets[1].data = series.rate.map((p) => p.consume);
    ovEls.chRate.update('none');
    ovEls.chLag.data.labels = series.lag.map((p) => fmtT(p.t));
    ovEls.chLag.data.datasets[0].data = series.lag.map((p) => p.v);
    ovEls.chLag.update('none');
    const nSig = JSON.stringify(ov.brokers || []);
    if (nSig !== ovEls.nodesSig) {
      ovEls.nodesSig = nSig;
      ovEls.nodesBox.innerHTML = '';
      for (const b of (ov.brokers || [])) {
        const row = el('div', 'rmq-node');
        row.append(
          el('span', 'rmq-node-name', '#' + b.nodeId + ' · ' + b.addr),
          b.controller ? badge('controller', 'этот брокер — контроллер кластера', 'ok') : el('span', ''),
        );
        ovEls.nodesBox.appendChild(row);
      }
    }
    ovEls.meta.textContent = `Кластер ${ov.clusterId || '?'} · брокеров ${fmtN((ov.brokers || []).length)}`;
  }

  // ---------------------------------------------------------------- Топики
  const T_COLS = [
    ['name', 'Топик'], ['partitions', 'Парт.'], ['messages', 'Сообщений'], ['rate', 'In/с'],
  ];
  function renderTopics(box, items) {
    const headRow = el('div', 'rmq-row kfk-tgrid rmq-head');
    T_COLS.forEach(([k, t], idx) => {
      const hCell = el('span', 'rmq-cell rmq-sortable' + (sortKey === k ? ' on' : ''), t + (sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''));
      hCell.onclick = () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'name' ? 1 : -1; } renderData(); };
      headRow.appendChild(hCell);
      if (idx === 0) headRow.appendChild(el('span', 'rmq-cell', 'Тренд In/с'));
    });
    headRow.appendChild(el('span', 'rmq-cell', ''));
    box.appendChild(headRow);
    if (!items.length) { box.appendChild(el('div', 'docker-empty', filterText ? 'Ничего не найдено.' : 'Нет топиков. Создай первый кнопкой «＋ Топик».')); return; }
    for (const ti of items) {
      const row = el('div', 'rmq-row kfk-tgrid clickable'); row.dataset.k = ti.name;
      const nameCell = el('span', 'rmq-cell rmq-namecell');
      nameCell.append(el('span', 'rmq-qname', ti.name));
      if (ti.internal) nameCell.appendChild(badge('int', 'служебный топик'));
      nameCell.appendChild(badge('RF ' + ti.replication, 'replication factor', 'type'));
      if (ti.underReplicated) nameCell.appendChild(badge('UR ' + ti.underReplicated, 'under-replicated партиции: ISR меньше реплик', 'err'));
      row.appendChild(nameCell);
      row.appendChild(sparkCellFrom(sparks.get(ti.name), { label: 'In/с:', minDelta: 1, growBad: false }));
      row.appendChild(el('span', 'rmq-cell num dim', fmtN(ti.partitions)));
      row.appendChild(el('span', 'rmq-cell num' + (ti.messages ? '' : ' dim'), fmtN(ti.messages)));
      row.appendChild(el('span', 'rmq-cell num dim', fmtRate(ti.rate)));
      const acts = el('span', 'rmq-cell drow-acts');
      const bPeek = iconBtn('drow-act', 'eye', 'Просмотреть сообщения', 13);
      bPeek.onclick = (e) => { e.stopPropagation(); openPeek(ti); };
      const bPub = iconBtn('drow-act', 'upload', 'Отправить сообщение в топик', 13);
      bPub.onclick = (e) => { e.stopPropagation(); produceModal({ topic: ti.name }); };
      const bTail = iconBtn('drow-act', 'play', 'Live-tail — слушать поток топика', 13);
      bTail.onclick = (e) => { e.stopPropagation(); startTailFor(ti); };
      const bInfo = iconBtn('drow-act', 'settings', 'Партиции и конфиги', 13);
      bInfo.onclick = (e) => { e.stopPropagation(); topicDetailModal(ti); };
      const bPurge = iconBtn('drow-act', 'eraser', 'Очистить (удалить все сообщения)', 13);
      bPurge.onclick = (e) => {
        e.stopPropagation();
        guardedConfirm('Очистить топик?', `Все сообщения «${ti.name}» (${fmtN(ti.messages)}) будут удалены безвозвратно (DeleteRecords).`, 'Очистить', async () => {
          const rr = await lite.kafka.purgeTopic(activeId, ti.name);
          if (rr && rr.ok) { toast('Топик очищен ✓'); lastSig = ''; loadSection(true); }
          else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
        });
      };
      const bDel = iconBtn('drow-act danger', 'trash', 'Удалить топик', 13);
      bDel.onclick = (e) => {
        e.stopPropagation();
        guardedConfirm('Удалить топик?', `«${ti.name}» будет удалён вместе с сообщениями (${fmtN(ti.messages)}).`, 'Удалить', async () => {
          const rr = await lite.kafka.deleteTopic(activeId, ti.name);
          if (rr && rr.ok) { toast('Топик удалён ✓'); if (peekT === ti.name) closePeek(); lastSig = ''; loadSection(true); }
          else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
        });
      };
      acts.append(bPeek, bPub, bTail, bInfo, bPurge, bDel);
      row.appendChild(acts);
      row.addEventListener('click', () => openPeek(ti));
      box.appendChild(row);
    }
  }

  // --- создание топика
  function createTopicModal() {
    const { m, close } = makeModal('<h2>Новый топик</h2><div id="kfkct" class="db-form"></div>');
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#kfkct');
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const name = el('input'); name.type = 'text'; name.placeholder = 'my-topic';
    const parts = el('input'); parts.type = 'number'; parts.value = '3'; parts.min = '1';
    const repl = el('input'); repl.type = 'number'; repl.value = '1'; repl.min = '1';
    const ret = el('select');
    for (const [v, lbl] of [['', 'по умолчанию брокера'], ['3600000', '1 час'], ['86400000', '1 день'], ['604800000', '7 дней'], ['-1', 'бессрочно']]) ret.appendChild(new Option(lbl, v));
    const pol = el('select');
    pol.append(new Option('delete — удалять по retention', 'delete'), new Option('compact — компактировать по ключу', 'compact'));
    f.append(mk('Имя', name), mk('Партиций', parts), mk('Replication factor', repl), mk('Retention', ret), mk('Cleanup policy', pol));
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const create = el('button', 'btn primary', 'Создать');
    create.onclick = async () => {
      const topic = name.value.trim();
      if (!topic) { toast('Введи имя топика', { kind: 'err' }); return; }
      status.textContent = 'Создаю…'; status.className = 'db-test-status';
      const r = await lite.kafka.createTopic(activeId, {
        topic, partitions: +parts.value || 1, replication: +repl.value || 1,
        retentionMs: ret.value || null, cleanupPolicy: pol.value === 'delete' ? null : pol.value,
      });
      if (r && r.ok) { toast(`Топик «${topic}» создан ✓`); close(); lastSig = ''; loadSection(true); }
      else { status.textContent = '✕ ' + ((r && r.error) || 'не удалось'); status.classList.add('err'); }
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(create, cancel); f.appendChild(row); f.appendChild(status);
    setTimeout(() => name.focus(), 50);
  }

  // --- детали топика: партиции (лидер/реплики/ISR/оффсеты) + конфиги + операции
  async function topicDetailModal(ti) {
    const { m, close } = makeModal('<h2></h2><div id="kfktd" class="kfk-detail"><div class="git-loading">Загружаю…</div></div>');
    m.classList.add('db-modal', 'kfk-detail-modal');
    m.querySelector('h2').textContent = 'Топик: ' + ti.name; // имя приходит из кластера — не в HTML
    const box = m.querySelector('#kfktd');
    let r;
    try { r = await lite.kafka.topicDetail(activeId, ti.name); } catch (e) { r = { error: String(e) }; }
    if (!box.isConnected) return;
    box.innerHTML = '';
    if (r.error) { box.appendChild(el('div', 'docker-err', r.error)); return; }
    const ops = el('div', 'gm-actions');
    const addP = el('button', 'btn', '＋ Партиции');
    addP.onclick = () => {
      showPrompt('Добавить партиции', 'Новое ОБЩЕЕ число партиций (сейчас ' + (r.partitions || []).length + '; уменьшить нельзя). Распределение по ключам изменится!', String((r.partitions || []).length + 1), async (cnt) => {
        if (!cnt || !(+cnt > 0)) return;
        const rr = await lite.kafka.addPartitions(activeId, ti.name, +cnt);
        if (rr && rr.ok) { toast('Партиции добавлены ✓'); close(); lastSig = ''; loadSection(true); }
        else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
      });
    };
    const retB = el('button', 'btn', 'Retention…');
    retB.onclick = () => {
      const curRet = (r.configs || []).find((c) => c.name === 'retention.ms');
      showPrompt('Изменить retention', 'retention.ms (мс; -1 = бессрочно):', curRet ? curRet.value : '604800000', async (v) => {
        if (v == null || v === '') return;
        const rr = await lite.kafka.setTopicConfig(activeId, ti.name, 'retention.ms', v);
        if (rr && rr.ok) { toast('Retention изменён ✓'); close(); }
        else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
      });
    };
    ops.append(addP, retB);
    box.appendChild(ops);
    box.appendChild(el('div', 'rmq-ch-cap', 'Партиции'));
    const ph = el('div', 'rmq-row kfk-pgrid rmq-head');
    for (const t of ['P', 'Лидер', 'Реплики', 'ISR', 'Начало', 'Конец', 'Сообщений']) ph.appendChild(el('span', 'rmq-cell', t));
    box.appendChild(ph);
    for (const p of (r.partitions || [])) {
      const row = el('div', 'rmq-row kfk-pgrid');
      const isrBad = (p.isr || []).length < (p.replicas || []).length;
      row.append(
        el('span', 'rmq-cell num', String(p.partition)),
        el('span', 'rmq-cell num dim', String(p.leader)),
        el('span', 'rmq-cell dim', (p.replicas || []).join(',')),
        el('span', 'rmq-cell' + (isrBad ? ' warn' : ' dim'), (p.isr || []).join(',') + (isrBad ? ' ⚠' : '')),
        el('span', 'rmq-cell num dim', p.low == null ? '—' : fmtN(p.low)),
        el('span', 'rmq-cell num dim', p.high == null ? '—' : fmtN(p.high)),
        el('span', 'rmq-cell num', p.messages == null ? '—' : fmtN(p.messages)),
      );
      box.appendChild(row);
    }
    box.appendChild(el('div', 'rmq-ch-cap', 'Конфиги (не-дефолтные сверху)'));
    const cfgBox = el('div', 'kfk-cfgs');
    for (const cfg of (r.configs || [])) {
      const row = el('div', 'kfk-cfg' + (cfg.isDefault ? ' dim' : ''));
      row.append(el('span', 'kfk-cfg-n', cfg.name), el('span', 'kfk-cfg-v', cfg.value == null ? '' : String(cfg.value)));
      cfgBox.appendChild(row);
    }
    box.appendChild(cfgBox);
  }

  // --- peek-панель: просмотр сообщений топика (чтение в Kafka никого не задевает)
  function closePeek() { peekT = null; if (peekBox) { peekBox.style.display = 'none'; peekBox.innerHTML = ''; } }
  function openPeek(ti) {
    if (!peekBox) return;
    peekT = ti.name;
    peekBox.style.display = '';
    peekBox.innerHTML = '';
    const head = el('div', 'rmq-peek-head');
    head.append(icon('eye', 14), el('span', 'rmq-peek-title', `Сообщения: ${ti.name}`));
    const cnt = el('select', 'rmq-peek-cnt');
    for (const n of [10, 50, 200]) cnt.appendChild(new Option(n + ' шт', n, n === 10, n === 10));
    const fromSel = el('select', 'rmq-peek-cnt');
    fromSel.append(new Option('последние', 'end', true, true), new Option('с начала', 'begin'));
    const load = () => fetchPeek(ti, +cnt.value, fromSel.value);
    cnt.onchange = load; fromSel.onchange = load;
    const re = iconBtn('drow-act', 'refresh', 'Перечитать', 13); re.onclick = load;
    const x = iconBtn('drow-act', 'x', 'Закрыть', 13); x.onclick = closePeek;
    head.append(cnt, fromSel, re, x);
    peekBox.appendChild(head);
    peekBox.appendChild(el('div', 'rmq-peek-list'));
    load();
  }
  async function fetchPeek(ti, count, from) {
    const list = peekBox && peekBox.querySelector('.rmq-peek-list'); if (!list) return;
    list.innerHTML = ''; list.appendChild(el('div', 'git-loading', 'Читаю…'));
    let r;
    try { r = await lite.kafka.peek(activeId, ti.name, count, from); } catch (e) { r = { error: String(e) }; }
    if (!peekBox || peekT !== ti.name) return;
    list.innerHTML = '';
    if (r.error) { list.appendChild(el('div', 'docker-err', r.error)); return; }
    const items = r.items || [];
    if (!items.length) { list.appendChild(el('div', 'docker-empty', 'Топик пуст.')); return; }
    items.forEach((mMsg, i) => {
      const blk = el('div', 'rmq-msg');
      const mh = el('div', 'rmq-msg-head');
      const t = new Date(mMsg.ts);
      mh.append(
        el('span', 'rmq-msg-idx', '#' + (i + 1)),
        el('span', 'rmq-msg-route', `p${mMsg.partition} · offset ${mMsg.offset}`),
        el('span', 'rmq-msg-bytes', t.toLocaleString()),
      );
      if (mMsg.key != null) mh.appendChild(badge('key: ' + mMsg.key, 'ключ сообщения', 'type'));
      mh.appendChild(el('span', 'rmq-msg-bytes', fmtB(mMsg.size)));
      const cp = iconBtn('drow-act', 'copy', 'Скопировать payload', 12);
      cp.onclick = () => { navigator.clipboard.writeText(mMsg.value || '').then(() => toast('Скопировано')); };
      mh.appendChild(cp);
      blk.appendChild(mh);
      let text = mMsg.value || '';
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
      blk.appendChild(el('pre', 'rmq-msg-body', text || '(пустой payload)'));
      const hdrs = mMsg.headers && Object.keys(mMsg.headers).length ? mMsg.headers : null;
      if (hdrs) {
        const pl = el('div', 'rmq-msg-props');
        pl.appendChild(el('span', null, 'headers: ' + JSON.stringify(hdrs)));
        blk.appendChild(pl);
      }
      list.appendChild(blk);
    });
    list.appendChild(el('div', 'rmq-peek-note', 'Чтение в Kafka неразрушающее: сообщения остаются в топике, оффсеты групп не двигаются.'));
  }

  // ---------------------------------------------------------------- Группы
  const G_COLS = [
    ['groupId', 'Группа'], ['members', 'Участ.'], ['topics', 'Топ.'], ['lag', 'Лаг'],
  ];
  function renderGroups(box, items) {
    const headRow = el('div', 'rmq-row kfk-ggrid rmq-head');
    G_COLS.forEach(([k, t], idx) => {
      const hCell = el('span', 'rmq-cell rmq-sortable' + (sortKey === k ? ' on' : ''), t + (sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''));
      hCell.onclick = () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'groupId' ? 1 : -1; } renderData(); };
      headRow.appendChild(hCell);
      if (idx === 0) headRow.appendChild(el('span', 'rmq-cell', 'Тренд лага'));
    });
    headRow.appendChild(el('span', 'rmq-cell', ''));
    box.appendChild(headRow);
    if (!items.length) { box.appendChild(el('div', 'docker-empty', filterText ? 'Ничего не найдено.' : 'Нет консюмер-групп.')); return; }
    for (const gi of items) {
      const row = el('div', 'rmq-row kfk-ggrid clickable'); row.dataset.k = gi.groupId;
      const nameCell = el('span', 'rmq-cell rmq-namecell');
      const stCls = gi.state === 'Stable' ? 'ok' : (gi.state === 'Empty' ? '' : 'warn');
      nameCell.append(el('span', 'rmq-qname', gi.groupId));
      if (gi.state) nameCell.appendChild(badge(gi.state, 'состояние группы', stCls));
      if (gi.lag != null && gi.lag > 0 && !gi.members) nameCell.appendChild(badge('лаг без консюмеров', 'есть недочитанные сообщения, но участников нет', 'err'));
      row.appendChild(nameCell);
      row.appendChild(sparkCellFrom(lagHist.get(gi.groupId), { label: 'Лаг:', minDelta: 5, growBad: true }));
      row.appendChild(el('span', 'rmq-cell num' + (gi.members ? '' : ' dim'), fmtN(gi.members)));
      row.appendChild(el('span', 'rmq-cell num dim', fmtN(gi.topics)));
      row.appendChild(el('span', 'rmq-cell num' + (gi.lag ? ' warn' : ' dim'), gi.lag == null ? '—' : fmtN(gi.lag)));
      const acts = el('span', 'rmq-cell drow-acts');
      const bDet = iconBtn('drow-act', 'eye', 'Детали: лаг по партициям, участники, сброс оффсетов', 13);
      bDet.onclick = (e) => { e.stopPropagation(); groupDetailModal(gi); };
      const bDel = iconBtn('drow-act danger', 'trash', 'Удалить группу (только пустую)', 13);
      bDel.onclick = (e) => {
        e.stopPropagation();
        guardedConfirm('Удалить группу?', `«${gi.groupId}» будет удалена (её оффсеты пропадут). Kafka откажет, если есть активные участники.`, 'Удалить', async () => {
          const rr = await lite.kafka.deleteGroup(activeId, gi.groupId);
          if (rr && rr.ok) { toast('Группа удалена ✓'); lastSig = ''; loadSection(true); }
          else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
        });
      };
      acts.append(bDet, bDel);
      row.appendChild(acts);
      row.addEventListener('click', () => groupDetailModal(gi));
      box.appendChild(row);
    }
  }
  // Детали группы: таблица лага per-топик/партиция + участники + сброс оффсетов.
  async function groupDetailModal(gi) {
    const { m, close } = makeModal('<h2></h2><div id="kfkgd" class="kfk-detail"><div class="git-loading">Загружаю…</div></div>');
    m.classList.add('db-modal', 'kfk-detail-modal');
    m.querySelector('h2').textContent = 'Группа: ' + gi.groupId; // id приходит из кластера — не в HTML
    const box = m.querySelector('#kfkgd');
    let r;
    try { r = await lite.kafka.groupDetail(activeId, gi.groupId); } catch (e) { r = { error: String(e) }; }
    if (!box.isConnected) return;
    box.innerHTML = '';
    if (r.error) { box.appendChild(el('div', 'docker-err', r.error)); return; }
    const topics = [...new Set((r.rows || []).map((x) => x.topic))];
    const ops = el('div', 'gm-actions');
    if (topics.length) {
      const tSel = el('select');
      for (const t of topics) tSel.appendChild(new Option(t, t));
      const toStart = el('button', 'btn', '⏮ Сброс в начало');
      const toEnd = el('button', 'btn', '⏭ Сброс в конец');
      const doReset = (to) => {
        guardedConfirm('Сбросить оффсеты?',
          `Группа «${gi.groupId}», топик «${tSel.value}» → ${to === 'earliest' ? 'НАЧАЛО (перечитает всё)' : 'КОНЕЦ (пропустит недочитанное)'}. Работает только на пустой группе (без активных консюмеров).`,
          'Сбросить', async () => {
            const rr = await lite.kafka.resetOffsets(activeId, gi.groupId, tSel.value, to);
            if (rr && rr.ok) { toast('Оффсеты сброшены ✓'); close(); lastSig = ''; loadSection(true); }
            else toast((rr && rr.error) || 'Не удалось (группа активна?)', { kind: 'err', ttl: 8000 });
          });
      };
      toStart.onclick = () => doReset('earliest');
      toEnd.onclick = () => doReset('latest');
      ops.append(tSel, toStart, toEnd);
    }
    box.appendChild(ops);
    if (r.state) box.appendChild(el('div', 'rmq-meta', `Состояние: ${r.state}${r.protocol ? ' · протокол ' + r.protocol : ''}`));
    if ((r.members || []).length) {
      box.appendChild(el('div', 'rmq-ch-cap', 'Участники'));
      for (const mb of r.members) {
        const row = el('div', 'rmq-node');
        row.append(el('span', 'rmq-node-name', mb.clientId), el('span', 'rmq-node-kv', mb.host), el('span', 'rmq-node-kv', mb.assign));
        box.appendChild(row);
      }
    }
    box.appendChild(el('div', 'rmq-ch-cap', 'Лаг по партициям'));
    const ph = el('div', 'rmq-row kfk-lgrid rmq-head');
    for (const t of ['Топик', 'P', 'Committed', 'End', 'Лаг']) ph.appendChild(el('span', 'rmq-cell', t));
    box.appendChild(ph);
    if (!(r.rows || []).length) box.appendChild(el('div', 'docker-empty', 'Нет закоммиченных оффсетов.'));
    for (const p of (r.rows || [])) {
      const row = el('div', 'rmq-row kfk-lgrid');
      row.append(
        el('span', 'rmq-cell dim', p.topic),
        el('span', 'rmq-cell num dim', String(p.partition)),
        el('span', 'rmq-cell num dim', fmtN(p.committed)),
        el('span', 'rmq-cell num dim', p.end == null ? '—' : fmtN(p.end)),
        el('span', 'rmq-cell num' + (p.lag ? ' warn' : ''), p.lag == null ? '—' : fmtN(p.lag)),
      );
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- Live-tail
  // Поток топика с текущего момента (эфемерная группа с конца, без коммитов) — настоящие
  // консюмеры ничего не замечают. Пауза копит сообщения и доигрывает; фильтр — по key/value.
  function startTailFor(ti) {
    tailPreset = { topic: ti.name };
    section = 'tail';
    renderPanel();
  }
  function mountTail(box) {
    const bar = el('div', 'rmq-toolbar');
    const tSel = el('select', 'rmq-tail-ex');
    tSel.appendChild(new Option('— выбери топик —', ''));
    const filt = el('input', 'rmq-filter'); filt.type = 'text'; filt.value = tail.filter || '';
    filt.placeholder = 'фильтр: подстрока в key/value (пусто — всё)';
    filt.oninput = () => { tail.filter = filt.value; };
    const startBtn = el('button', 'btn primary rmq-tail-btn');
    const setStartBtn = () => { startBtn.innerHTML = ''; startBtn.append(icon(tail.id ? 'stop' : 'play', 13), document.createTextNode(tail.id ? ' Стоп' : ' Слушать')); };
    const pauseBtn = iconBtn('drow-act' + (tail.paused ? ' on' : ''), 'pause', 'Пауза — сообщения копятся и доиграются', 14);
    const clearBtn = iconBtn('drow-act', 'eraser', 'Очистить вывод', 14);
    const counter = el('span', 'rmq-tail-cnt', '0 сообщ.');
    bar.append(tSel, filt, startBtn, pauseBtn, clearBtn, counter);
    box.appendChild(bar);
    const note = el('div', 'rmq-tail-note', (tail.id && tail.note) ? tail.note : 'Слушаем топик с текущего момента через эфемерную группу — оффсеты настоящих консюмеров не двигаются.');
    box.appendChild(note);
    const list = el('div', 'rmq-data rmq-tail-list');
    box.appendChild(list);
    tailEls = { tSel, filt, startBtn, pauseBtn, list, counter, note, setStartBtn };
    setStartBtn(); updateTailCounter();
    if (tail.msgs.length) { for (const p of tail.msgs) appendTailRowDom(p); list.scrollTop = list.scrollHeight; }
    else list.appendChild(el('div', 'docker-empty', 'Выбери топик и нажми «Слушать». Поток сообщений появится здесь.'));
    startBtn.onclick = () => { if (tail.id) stopTail(); else startTail(); };
    pauseBtn.onclick = () => {
      tail.paused = !tail.paused;
      pauseBtn.classList.toggle('on', tail.paused);
      if (!tail.paused) { const buf = tail.buf.splice(0); for (const p of buf) { tail.msgs.push(p); if (tail.msgs.length > 500) tail.msgs.shift(); appendTailRowDom(p); } updateTailCounter(); }
      else toast('Пауза: сообщения копятся (до 1000)', { ttl: 2500 });
    };
    clearBtn.onclick = () => { list.innerHTML = ''; tail.buf = []; tail.msgs = []; tail.count = 0; updateTailCounter(); };
    // список топиков для селекта (+ восстановление выбора / автозапуск из строки топика)
    lite.kafka.topics(activeId, false).then((r) => {
      if (!tailEls || tailEls.tSel !== tSel || r.error) return;
      cur.topics = r.items || [];
      for (const ti of cur.topics) tSel.appendChild(new Option(ti.name, ti.name));
      if (tail.topic) {
        if (![...tSel.options].some((o) => o.value === tail.topic)) tSel.appendChild(new Option(tail.topic, tail.topic));
        tSel.value = tail.topic;
      }
      if (tailPreset) { tSel.value = tailPreset.topic; tailPreset = null; if (tSel.value && !tail.id) startTail(); }
    }).catch(() => {});
  }
  async function startTail() {
    if (!tailEls || tail.id) return;
    const topic = tailEls.tSel.value;
    if (!topic) { toast('Выбери топик для прослушивания', { kind: 'err' }); return; }
    const sid = 'kt' + (++tailUid) + Date.now().toString(36);
    const t = tail;
    t.id = sid; t.paused = false; t.buf = []; t.count = 0; t.msgs = [];
    t.topic = topic;
    tailStreams.set(sid, t);
    tailEls.setStartBtn(); tailEls.pauseBtn.classList.remove('on'); updateTailCounter();
    tailEls.list.innerHTML = '';
    tailEls.list.appendChild(el('div', 'docker-empty', 'Слушаю… жду сообщений.'));
    let r;
    try { r = await lite.kafka.tailStart(activeId, topic, sid); }
    catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) {
      tailStreams.delete(sid); t.id = null;
      if (t === tail && tailEls) { tailEls.setStartBtn(); tailEls.list.innerHTML = ''; tailEls.list.appendChild(el('div', 'docker-err', (r && r.error) || 'Не удалось начать прослушивание')); }
      toast((r && r.error) || 'Live-tail не запустился', { kind: 'err', ttl: 9000 });
      return;
    }
    t.note = `Слушаю «${topic}» с текущего момента · эфемерная группа, без коммитов`;
    if (t === tail && tailEls) tailEls.note.textContent = t.note;
  }
  function stopTail(t = tail) {
    if (t.id) { try { lite.kafka.tailStop(t.id); } catch (_) {} tailStreams.delete(t.id); t.id = null; }
    t.paused = false; t.buf = [];
    if (t === tail && tailEls) { tailEls.setStartBtn(); tailEls.pauseBtn.classList.remove('on'); }
  }
  function stopAllTails() { for (const t of [...tailStreams.values()]) stopTail(t); }
  function updateTailCounter() {
    if (tailEls) tailEls.counter.textContent = `${tail.count} сообщ.${tail.paused ? ` · пауза (+${tail.buf.length})` : ''}`;
  }
  function tailMatch(t, p) {
    const q = (t.filter || '').toLowerCase();
    if (!q) return true;
    return String(p.key || '').toLowerCase().includes(q) || String(p.value || '').toLowerCase().includes(q);
  }
  function handleTailMsg(t, p) {
    if (!tailMatch(t, p)) return;
    t.count++;
    if (t.paused) { t.buf.push(p); if (t.buf.length > 1000) t.buf.shift(); if (t === tail) updateTailCounter(); return; }
    t.msgs.push(p); if (t.msgs.length > 500) t.msgs.shift();
    if (t === tail && tailEls && section === 'tail') appendTailRowDom(p);
    if (t === tail) updateTailCounter();
  }
  function appendTailRowDom(p) {
    if (!tailEls) return;
    const list = tailEls.list;
    const ph = list.querySelector('.docker-empty'); if (ph) ph.remove();
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
    const row = el('div', 'rmq-msg rmq-tl');
    const head = el('div', 'rmq-msg-head');
    const t = new Date(p.ts || Date.now());
    head.append(
      el('span', 'rmq-msg-idx', t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0')),
      el('span', 'rmq-msg-route', `p${p.partition} · ${p.offset}`),
    );
    if (p.key != null) head.appendChild(badge('key: ' + p.key, 'ключ сообщения', 'type'));
    head.appendChild(el('span', 'rmq-msg-bytes', fmtB(p.size)));
    const cp = iconBtn('drow-act', 'copy', 'Скопировать payload', 12);
    cp.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(p.value || '').then(() => toast('Скопировано')); };
    head.appendChild(cp);
    row.appendChild(head);
    row.appendChild(el('div', 'rmq-tl-prev', (p.value || '').replace(/\s+/g, ' ').slice(0, 180) || '(пустой payload)'));
    let expanded = null;
    row.onclick = () => {
      if (expanded) { expanded.remove(); expanded = null; return; }
      let text = p.value || '';
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
      expanded = el('pre', 'rmq-msg-body', text);
      if (p.headers && Object.keys(p.headers).length) expanded.textContent += '\n\n— headers —\n' + JSON.stringify(p.headers, null, 2);
      row.appendChild(expanded);
    };
    list.appendChild(row);
    while (list.children.length > 500) list.removeChild(list.firstChild);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  lite.kafka.onTailData((p) => { const t = p && tailStreams.get(p.streamId); if (t) handleTailMsg(t, p); });
  lite.kafka.onTailExit((p) => {
    const t = p && tailStreams.get(p.streamId); if (!t) return;
    tailStreams.delete(p.streamId); t.id = null;
    if (t === tail && tailEls) { tailEls.setStartBtn(); tailEls.note.textContent += ' · поток закрыт брокером'; }
    toast(`Live-tail («${t.topic}»): соединение закрыто`, { kind: 'err', ttl: 6000 });
  });

  // ---------------------------------------------------------------- публикация
  // История последних отправок — per-профиль в kafkaUi.prodHist (восстанавливает все поля).
  function produceModal(pre) {
    const { m, close } = makeModal('<h2>Отправить сообщение</h2><div id="kfkp" class="db-form"></div>');
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#kfkp');
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const hist = (kafkaUi.prodHist && kafkaUi.prodHist[activeId]) || [];
    const tSel = el('select');
    for (const ti of (cur.topics || [])) tSel.appendChild(new Option(ti.name, ti.name));
    if (pre.topic) {
      if (![...tSel.options].some((o) => o.value === pre.topic)) tSel.appendChild(new Option(pre.topic, pre.topic));
      tSel.value = pre.topic;
    }
    const keyI = el('input'); keyI.type = 'text'; keyI.placeholder = '(без ключа — round-robin по партициям)';
    const partI = el('input'); partI.type = 'text'; partI.placeholder = '(авто)'; partI.title = 'Номер партиции; пусто — по ключу/round-robin';
    const payload = el('textarea', 'rmq-payload'); payload.rows = 8; payload.placeholder = '{"hello": "world"}';
    const hdrI = el('input'); hdrI.type = 'text'; hdrI.placeholder = '{"trace-id": "…"} (JSON, опционально)';
    if (hist.length) {
      const hSel = el('select');
      hSel.appendChild(new Option('История отправок…', ''));
      hist.forEach((h, i) => hSel.appendChild(new Option(`${h.topic} · ${h.key || '(без ключа)'} · ${(h.value || '').slice(0, 40)}`, String(i))));
      hSel.onchange = () => {
        const h = hist[+hSel.value]; if (!h) return;
        if (![...tSel.options].some((o) => o.value === h.topic)) tSel.appendChild(new Option(h.topic, h.topic));
        tSel.value = h.topic; keyI.value = h.key || ''; payload.value = h.value || ''; hdrI.value = h.headers || '';
      };
      f.appendChild(mk('Шаблон', hSel));
    }
    f.appendChild(mk('Топик', tSel));
    const row2 = el('div', 'db-row2');
    const cell = (label, node) => { const w = el('div', 'db-field'); w.append(el('label', null, label), node); return w; };
    row2.append(cell('Ключ', keyI), cell('Партиция', partI));
    f.appendChild(row2);
    const pw = el('div', 'db-field');
    const pl = el('label', null, 'Payload');
    const fmt = el('button', 'btn rmq-fmt-btn', '{ } формат');
    fmt.onclick = (e) => { e.preventDefault(); try { payload.value = JSON.stringify(JSON.parse(payload.value), null, 2); } catch (_) { toast('Payload — не валидный JSON', { kind: 'err' }); } };
    const plRow = el('div', 'rmq-pl-row'); plRow.append(pl, fmt);
    pw.append(plRow, payload); f.appendChild(pw);
    f.appendChild(mk('Headers', hdrI));
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const send = el('button', 'btn primary', 'Отправить');
    send.onclick = async () => {
      if (!tSel.value) { toast('Выбери топик', { kind: 'err' }); return; }
      let headers = null;
      if (hdrI.value.trim()) {
        try { headers = JSON.parse(hdrI.value); if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw 0; }
        catch (_) { toast('Headers — не валидный JSON-объект', { kind: 'err' }); return; }
      }
      status.textContent = 'Отправляю…'; status.className = 'db-test-status';
      const r = await lite.kafka.produce(activeId, {
        topic: tSel.value, key: keyI.value.trim() || null, value: payload.value,
        partition: partI.value.trim(), headers,
      });
      if (r && r.ok) {
        kafkaUi.prodHist = kafkaUi.prodHist || {};
        const arr = kafkaUi.prodHist[activeId] = kafkaUi.prodHist[activeId] || [];
        arr.unshift({ topic: tSel.value, key: keyI.value.trim(), value: payload.value, headers: hdrI.value.trim() });
        kafkaUi.prodHist[activeId] = arr.slice(0, 10);
        saveUi();
        status.textContent = `✓ Отправлено → p${r.partition}, offset ${r.offset}`; status.classList.add('ok');
        toast('Сообщение отправлено ✓'); lastSig = ''; loadSection(true);
      } else { status.textContent = '✕ ' + ((r && r.error) || 'не удалось'); status.classList.add('err'); }
    };
    const cancel = el('button', 'btn', 'Закрыть'); cancel.onclick = close;
    row.append(send, cancel); f.appendChild(row); f.appendChild(status);
    // топики могли ещё не грузиться (отправка из «Групп») — дотянем список
    if (!(cur.topics || []).length && activeId) {
      lite.kafka.topics(activeId, false).then((r) => {
        if (r && !r.error) { cur.topics = r.items || []; const v = tSel.value;
          for (const ti of cur.topics) if (![...tSel.options].some((o) => o.value === ti.name)) tSel.appendChild(new Option(ti.name, ti.name));
          if (v) tSel.value = v;
        }
      }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- refresh (кнопка шапки окна)
  function refresh() {
    if (!kfkOpen) return;
    if (activeId) {
      if (section === 'tail') { mountSection(); return; } // перемонтаж: свежий список топиков, стрим живёт
      lastSig = ''; loadSection(false);
    } else renderPanel();
  }

  return { isOpen: () => kfkOpen, setOpen: setKafkaOpen, toggle: toggleKafka, renderPanel, refresh, openFromContainer };
}
