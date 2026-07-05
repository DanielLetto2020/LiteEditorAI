// LiteEditor — модуль «RabbitMQ»: обёртка над management HTTP API, удобнее стандартного UI.
// Профили серверов (категории/цвета/PRODUCTION, пароли в safeStorage) + воркспейс с разделами
// Обзор / Очереди / Exchanges / Подключения. Живой полл (перерисовка только при изменении данных —
// фокус/скролл не теряются), peek сообщений БЕЗ съедания (ack_requeue_true), публикация с историей,
// purge/delete/kill с confirm и PRODUCTION-гардом. Приём заготовки профиля из модуля «Контейнеры».
// Изоляция по образцу db.js: ядро — через host; UI-хелперы — из ui.js; бэкенд — window.lite.rmq.*.
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';
import { kpFormButtons } from '../kpicker.js';
import Chart from 'chart.js/auto';   // уже в бандле (модуль БД), auto-регистрация контроллеров

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initRmq(host) {
  const { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let rmqOpen = false;
  let connsList = [], secure = true;
  let activeId = null, activeConn = null;
  let renderSeq = 0;
  let restoredOnce = false;
  // ---- вкладки профилей: несколько открытых брокеров одновременно (модель как в «Базах данных»)
  let openProfs = [];             // порядок вкладок: [profileId]
  let profListMode = false;       // при открытых вкладках показать список профилей («домой»)
  const profStates = new Map();   // profileId -> снапшот воркспейса (секция/vhost/данные/tail)
  let rmqUi = (STORE.rmqUi && typeof STORE.rmqUi === 'object') ? STORE.rmqUi : {};
  const saveUi = () => persist('rmqUi', rmqUi);

  // --- workspace state
  let section = 'queues';        // 'overview' | 'queues' | 'exchanges' | 'connections'
  let vhost = '';                // '' = все vhost'ы
  let vhosts = [];
  let filterText = '';
  let sortKey = 'name', sortDir = 1;
  let cur = {};                  // последние данные секций (queues/exchanges/connections/overview)
  let lastSig = '';              // подпись отрисованного — полл не трогает DOM без изменений
  let pollTimer = null, pollBusy = false;
  let peekQ = null;              // имя очереди с открытой панелью сообщений
  let dataBox = null, peekBox = null, statusEl = null, vhostSel = null;
  let chartAge = 600;            // диапазон графиков обзора, сек (per-профиль, свапается вкладками)
  let ovEls = null;              // скелет обзора: карточки + Chart-инстансы (строится один раз на маунт)

  // --- live-tail: per-профильный объект (свапается вкладками); стрим ЖИВЁТ в фоне у неактивных
  // вкладок — сообщения копятся в msgs (кап 500) и доигрываются при возврате на вкладку/секцию.
  let tailUid = 0;
  let tailEls = null;            // DOM активной секции tail (null вне секции)
  let tailPreset = null;         // { exchange } — автозапуск из строки exchange
  const freshTail = () => ({ id: null, paused: false, buf: [], count: 0, msgs: [], exchange: '', pattern: '#', note: '' });
  let tail = freshTail();        // tail АКТИВНОГО профиля
  const tailStreams = new Map(); // streamId -> tail-объект своего профиля (роутинг фоновых сообщений)

  // ---------------------------------------------------------------- helpers
  const fmtN = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const fmtRate = (r) => r == null ? '—' : (r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2));
  function fmtB(n) {
    n = Number(n); if (!Number.isFinite(n) || n <= 0) return '—';
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtUp(ms) {
    const s = Math.floor(ms / 1000); if (s < 60) return s + 'с';
    const m = Math.floor(s / 60); if (m < 60) return m + 'м';
    const h = Math.floor(m / 60); if (h < 48) return h + 'ч ' + (m % 60) + 'м';
    return Math.floor(h / 24) + 'д ' + (h % 24) + 'ч';
  }
  function catHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  // токены темы для графиков (правило тем: никакого хардкода — цвета читаем из CSS-переменных)
  function cssVar(name, fb) { try { const v = getComputedStyle(document.body).getPropertyValue(name).trim(); return v || fb; } catch (_) { return fb; } }
  function badge(txt, title, cls) { const b = el('span', 'rmq-badge' + (cls ? ' ' + cls : ''), txt); if (title) b.title = title; return b; }
  // PRODUCTION-гард поверх обычного confirm для разрушающих действий
  function guardedConfirm(title, msg, btnLabel, run) {
    const prod = activeConn && activeConn.isProd;
    showConfirm(prod ? 'PRODUCTION — ' + title : title, msg + (prod ? ' Профиль помечен как PRODUCTION!' : ''), btnLabel, run);
  }
  function setStatus(ok, err) {
    if (!statusEl) return;
    statusEl.className = 'db-status-dot ' + (ok ? 'ok' : 'err');
    statusEl.title = ok ? 'Подключено (management API отвечает)' : ('Нет связи: ' + (err || ''));
  }

  // ---------------------------------------------------------------- open/close
  function setRmqOpen(open, opts = {}) {
    if (open === rmqOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('rmq');
    else { stopPoll(); stopAllTails(); }
    const delta = layout.rmq + GUTTER;
    rmqOpen = open;
    $('#rmq-pane').classList.toggle('hidden', !open);
    $('#gutter-rmq').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleRmq() { setRmqOpen(!rmqOpen); }

  // ---------------------------------------------------------------- panel router
  async function renderPanel() {
    const seq = ++renderSeq;
    const body = $('#rmq-body');
    if (!activeId || profListMode) {
      stopPoll();
      body.innerHTML = '<div class="git-loading">Загрузка профилей…</div>';
      try { const r = await lite.rmq.list(); connsList = r.connections || []; secure = r.secure !== false; }
      catch (_) { connsList = []; }
      if (seq !== renderSeq || !rmqOpen) return;
      if (!restoredOnce) { // восстановление набора вкладок прошлого запуска
        restoredOnce = true;
        const ids = (Array.isArray(rmqUi.openTabs) ? rmqUi.openTabs : []).filter((id) => connsList.some((c) => c.id === id));
        if (ids.length && !profListMode) {
          openProfs = ids;
          const actId = (rmqUi.activeTab && ids.includes(rmqUi.activeTab)) ? rmqUi.activeTab : ids[ids.length - 1];
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
    top.appendChild(el('span', 'db-topbar-title', 'Серверы RabbitMQ'));
    const add = iconBtn('drow-act', 'plus', 'Новый профиль', 16); add.onclick = () => connModal(null);
    top.appendChild(add);
    body.appendChild(top);
    if (!secure) body.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — пароли шифруются слабее.'));
    if (!connsList.length) { body.appendChild(el('div', 'docker-empty', 'Нет профилей. Добавь первый кнопкой ＋ или из модуля «Контейнеры» (иконка кролика у контейнера RabbitMQ).')); return; }
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
    const collapsed = !!(rmqUi.catCollapsed && rmqUi.catCollapsed[cat]);
    const chev = icon(collapsed ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
    head.append(chev, el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(list.length)));
    const bodyEl = el('div', 'docker-group-body');
    if (collapsed) bodyEl.style.display = 'none';
    for (const c of list) bodyEl.appendChild(connRow(c));
    head.onclick = () => {
      rmqUi.catCollapsed = rmqUi.catCollapsed || {}; rmqUi.catCollapsed[cat] = !rmqUi.catCollapsed[cat]; saveUi();
      const col = rmqUi.catCollapsed[cat]; bodyEl.style.display = col ? 'none' : '';
      const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev'); head.replaceChild(nc, head.firstChild);
    };
    block.append(head, bodyEl);
    return block;
  }
  function connRow(c) {
    const row = el('div', 'db-conn-row clickable');
    if (c.color) { row.style.borderLeft = `3px solid ${c.color}`; row.style.paddingLeft = '6px'; }
    row.appendChild(icon('rabbit', 16));
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', c.name || '(без имени)'));
    main.appendChild(el('span', 'drow-sub', `${c.host || '127.0.0.1'}:${c.port || 15672} · vhost ${c.vhost || '/'} · ${c.user || 'guest'}${c.isProd ? ' · PROD' : ''}`));
    row.appendChild(main);
    if (openProfs.includes(c.id)) row.appendChild(el('span', 'db-ro-badge', 'открыто'));
    const acts = el('div', 'drow-acts');
    const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13); edit.onclick = (e) => { e.stopPropagation(); connModal(c); };
    const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
    del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить профиль?', `«${c.name}» удалится из списка (сам сервер не трогается).`, 'Удалить', async () => {
      await lite.rmq.delete(c.id);
      const st = profStates.get(c.id);
      const tl = activeId === c.id ? tail : (st && st.tail);
      if (tl) stopTail(tl); // вкладку и её фоновый стрим тоже закрываем
      openProfs = openProfs.filter((x) => x !== c.id); profStates.delete(c.id);
      if (activeId === c.id) { activeId = null; activeConn = null; cur = {}; tail = freshTail(); tailEls = null; }
      saveOpenSet();
      renderPanel();
    }); };
    acts.append(edit, del); row.appendChild(acts);
    row.addEventListener('click', () => openProfile(c));
    return row;
  }

  // Открыть/активировать вкладку профиля. Состояние (секция/vhost/данные/tail) — из памяти,
  // если уже открывали; live-tail неактивной вкладки продолжает копить сообщения в фоне.
  function openProfile(c) {
    if (activeId === c.id && !profListMode) { renderPanel(); return; }
    if (activeId) snapshotProf();
    stopPoll();
    profListMode = false;
    if (!openProfs.includes(c.id)) openProfs.push(c.id);
    const s = profStates.get(c.id);
    activeId = c.id; activeConn = (s && s.conn) || c;
    if (s) {
      section = s.section; vhost = s.vhost; vhosts = s.vhosts; filterText = s.filterText;
      sortKey = s.sortKey; sortDir = s.sortDir; cur = s.cur; peekQ = s.peekQ; tail = s.tail; chartAge = s.chartAge || 600;
    } else {
      section = 'queues'; filterText = ''; sortKey = 'name'; sortDir = 1;
      vhost = (c.vhost && c.vhost !== '/') ? c.vhost : '';
      vhosts = []; cur = {}; peekQ = null; tail = freshTail(); chartAge = 600;
    }
    lastSig = ''; tailEls = null;
    saveOpenSet();
    renderPanel();
  }
  function saveOpenSet() { rmqUi.openTabs = openProfs.slice(); rmqUi.activeTab = activeId; saveUi(); }
  function snapshotProf() {
    if (!activeId) return;
    profStates.set(activeId, { conn: activeConn, section, vhost, vhosts, filterText, sortKey, sortDir, cur, peekQ, tail, chartAge });
  }
  function closeProfTab(id) {
    const st = profStates.get(id);
    const tl = id === activeId ? tail : (st && st.tail);
    if (tl) stopTail(tl); // фоновый стрим закрываем вместе с вкладкой
    const wasActive = id === activeId;
    openProfs = openProfs.filter((x) => x !== id);
    profStates.delete(id);
    if (wasActive) {
      stopPoll();
      activeId = null; activeConn = null; cur = {}; peekQ = null; tail = freshTail(); tailEls = null;
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
  // Полоса вкладок-профилей (классы переиспользуем из БД: db-conn-strip / db-ctab / db-conndd).
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
  function closeProfDd() { const d = document.getElementById('rmq-conndd'); if (d) d.remove(); }
  async function profDropdown(anchor) {
    closeProfDd();
    const dd = el('div', 'db-conndd'); dd.id = 'rmq-conndd';
    dd.appendChild(el('div', 'db-conndd-load', 'Загружаю…'));
    document.body.appendChild(dd);
    const r0 = anchor.getBoundingClientRect();
    dd.style.left = Math.max(8, Math.min(r0.left, window.innerWidth - 300)) + 'px';
    dd.style.top = (r0.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', closeProfDd, { once: true }), 0);
    let list = connsList;
    try { const r = await lite.rmq.list(); list = r.connections || []; connsList = list; } catch (_) {}
    if (!document.getElementById('rmq-conndd')) return; // успели закрыть, пока грузился список
    dd.innerHTML = '';
    for (const c of list) {
      const row = el('div', 'db-conndd-row');
      const dot = el('span', 'db-ctab-dot'); if (c.color) dot.style.background = c.color;
      row.append(dot, el('span', 'db-conndd-name', c.name || '(без имени)'));
      row.appendChild(el('span', 'db-conndd-sub', `${c.host || '127.0.0.1'}:${c.port || 15672}`));
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
    // existing: сохранённый профиль (есть id) ИЛИ черновик из «Контейнеров» (без id, с password/source)
    const c = existing ? { ...existing } : { category: 'Все', port: 15672, amqpPort: 5672, vhost: '/', user: 'guest' };
    const { m, close } = makeModal(`<h2>${c.id ? 'Изменить' : 'Новый'} профиль RabbitMQ</h2><div id="rmqf" class="db-form"></div>`);
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#rmqf');
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
    const name = inp(c.name, 'Мой брокер');
    f.appendChild(mk('Имя', name));
    // Категория — как в модуле БД: выбор из существующих или новая
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
    const hostI = inp(c.host || '', '127.0.0.1');
    const portI = inp(c.port || 15672, '15672', 'number');
    const userI = inp(c.user || '', 'guest');
    const passI = inp(c.password || '', c.id ? '(без изменений)' : 'guest', 'password');
    const vhostI = inp(c.vhost || '/', '/');
    const amqpI = inp(c.amqpPort || 5672, '5672', 'number');
    const tls = el('input'); tls.type = 'checkbox'; tls.checked = !!c.tls;
    const tlsLabel = el('label', 'db-check'); tlsLabel.append(tls, document.createTextNode(' Management по HTTPS (TLS)'));
    // «Сейф паролей»: заполнить/сохранить креды management-пользователя.
    const kpRow = kpFormButtons({
      user: userI, pass: passI,
      title: () => name.value.trim() || 'LiteEditor: RabbitMQ',
      url: () => (hostI.value.trim() ? hostI.value.trim() + ':' + (portI.value || '') : ''),
      notes: 'LiteEditor · модуль «RabbitMQ»',
    });
    grp.append(mk('Хост', hostI), mk('Порт management', portI), mk('Пользователь', userI), mk('Пароль', passI), kpRow,
      mk('Vhost по умолчанию', vhostI), mk('Порт AMQP (справочно)', amqpI), tlsLabel);
    f.appendChild(grp);
    const colorSel = el('select');
    for (const [v, lbl] of [['', 'без цвета'], ['#e5484d', '🔴 красный (prod)'], ['#f5a623', '🟠 янтарный (stage)'], ['#30a46c', '🟢 зелёный (dev)'], ['#0091ff', '🔵 синий'], ['#8e4ec6', '🟣 фиолетовый']]) { const o = document.createElement('option'); o.value = v; o.textContent = lbl; if ((c.color || '') === v) o.selected = true; colorSel.appendChild(o); }
    f.appendChild(mk('Цвет окружения', colorSel));
    const prod = el('input'); prod.type = 'checkbox'; prod.checked = !!c.isProd;
    const prodLabel = el('label', 'db-check db-check-warn'); prodLabel.append(prod, document.createTextNode(' PRODUCTION — предупреждать перед purge/delete/kill'));
    f.appendChild(prodLabel);
    const collect = () => {
      const o = {
        id: c.id, name: name.value.trim(), category: (catSel.value === CAT_NEW ? catNew.value.trim() : catSel.value) || 'Все',
        host: hostI.value.trim() || '127.0.0.1', port: +portI.value || 15672, user: userI.value.trim() || 'guest',
        vhost: vhostI.value.trim() || '/', amqpPort: +amqpI.value || 5672, tls: tls.checked,
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
      const r = await lite.rmq.test(collect());
      if (r.ok) { status.textContent = `✓ ${r.version || 'подключение успешно'} (${r.user || ''})`; status.classList.add('ok'); }
      else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); }
    };
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => {
      const o = collect();
      if (!o.name) { toast('Введи имя', { kind: 'err' }); return; }
      const r = await lite.rmq.save(o);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      close(); renderPanel();
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
  }

  // ---------------------------------------------------------------- «Контейнеры» → RabbitMQ
  // payload — ответ containers:inspectMq (через main). Повторный клик не плодит дубли (source).
  async function openFromContainer(payload) {
    const p = payload && payload.prefill;
    if (!p || !p.name) return;
    restoredOnce = true; // явное намерение юзера главнее авто-восстановления вкладок
    let list = [];
    try { const r = await lite.rmq.list(); list = r.connections || []; connsList = list; secure = r.secure !== false; } catch (_) {}
    const existing = list.find((x) => x.source && x.source === p.source);
    if (existing) { // повтор клика = переключение; порт мог смениться (контейнер/туннель) → тихо обновить
      if ((p.port && existing.port !== p.port) || (p.host && existing.host !== p.host)) {
        try { const u = await lite.rmq.save({ ...existing, host: p.host || existing.host, port: p.port || existing.port }); if (u && u.connection) Object.assign(existing, u.connection); } catch (_) {}
      }
      toast(`Переключаюсь на «${existing.name}»`, { ttl: 2200 }); openProfile(existing); return;
    }
    const toList = () => { if (activeId) { stopPoll(); snapshotProf(); } profListMode = true; renderPanel(); };
    const draft = { ...p };
    if (payload.passwordUnknown || draft.password == null) { // креды неизвестны (SSH-туннель) → сразу префилл-форма
      delete draft.password;
      toList(); connModal(draft);
      return;
    }
    toast(`Проверяю подключение к «${draft.name}»…`, { ttl: 2500 });
    let t;
    try { t = await lite.rmq.test(draft); } catch (e) { t = { ok: false, error: String(e) }; }
    if (t && t.ok) {
      const r = await lite.rmq.save(draft);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      toast(`✓ ${t.version || 'Подключено'} — профиль создан из контейнера`);
      openProfile(r.connection);
    } else {
      toast('Автопроверка не прошла: ' + ((t && t.error) || 'нет ответа') + ' — проверь поля', { kind: 'err', ttl: 9000 });
      toList(); connModal(draft);
    }
  }

  // ---------------------------------------------------------------- workspace
  const SECTIONS = [['overview', 'Обзор'], ['queues', 'Очереди'], ['exchanges', 'Exchanges'], ['tail', 'Live-tail'], ['connections', 'Подключения']];
  function renderWorkspace(body) {
    stopPoll();
    body.innerHTML = '';
    const head = el('div', 'db-ws-head');
    if (activeConn.color) head.style.borderBottom = `2px solid ${activeConn.color}`;
    const back = iconBtn('drow-act', 'chevron-left', 'К списку профилей (вкладка останется открытой)', 16);
    back.onclick = () => { stopPoll(); snapshotProf(); profListMode = true; renderPanel(); };
    statusEl = el('span', 'db-status-dot'); statusEl.title = 'Проверка соединения…';
    head.append(back, statusEl, icon('rabbit', 15), el('span', 'db-ws-name', activeConn.name));
    if (activeConn.isProd) head.appendChild(el('span', 'db-ro-badge', 'PROD'));
    vhostSel = el('select', 'rmq-vhost-sel');
    vhostSel.appendChild(new Option('vhost: все', ''));
    if (vhost) vhostSel.appendChild(new Option('vhost: ' + vhost, vhost, true, true));
    vhostSel.onchange = () => { vhost = vhostSel.value; peekQ = null; lastSig = ''; mountSection(); };
    head.appendChild(vhostSel);
    body.appendChild(head);
    const tabsEl = el('div', 'docker-subtabs');
    for (const [k, label] of SECTIONS) {
      const t = el('button', 'docker-subtab' + (k === section ? ' on' : '')); t.dataset.k = k; t.textContent = label;
      t.onclick = () => {
        if (section === t.dataset.k) return;
        section = t.dataset.k; peekQ = null; filterText = '';
        tabsEl.querySelectorAll('.docker-subtab').forEach((b) => b.classList.toggle('on', b.dataset.k === section));
        mountSection();
      };
      tabsEl.appendChild(t);
    }
    body.appendChild(tabsEl);
    const secBox = el('div', 'rmq-sec'); secBox.id = 'rmq-secbox';
    body.appendChild(secBox);
    loadVhosts();
    mountSection();
  }
  async function loadVhosts() {
    if (!activeId) return;
    try {
      const r = await lite.rmq.vhosts(activeId);
      if (r.error || !vhostSel) return;
      vhosts = r.vhosts || [];
      const cv = vhost;
      vhostSel.innerHTML = '';
      vhostSel.appendChild(new Option('vhost: все', ''));
      for (const v of vhosts) vhostSel.appendChild(new Option('vhost: ' + v, v, false, v === cv));
      if (cv && !vhosts.includes(cv)) vhost = '';
    } catch (_) {}
  }

  // Каркас секции: тулбар (строится один раз — фокус в фильтре не теряется) + область данных,
  // которую полл перерисовывает только при изменении данных (сигнатура).
  function mountSection() {
    const box = document.getElementById('rmq-secbox'); if (!box) return;
    destroyOvCharts(); // Chart-инстансы обзора не должны пережить перемонтаж секции
    box.innerHTML = ''; dataBox = null; peekBox = null; tailEls = null; lastSig = ''; // tail НЕ стопаем — живёт в фоне
    if (section === 'tail') { stopPoll(); mountTail(box); return; }
    if (section === 'queues' || section === 'exchanges' || section === 'connections') {
      const bar = el('div', 'rmq-toolbar');
      const filt = el('input', 'rmq-filter'); filt.type = 'search'; filt.placeholder = 'Фильтр по имени…'; filt.value = filterText;
      filt.oninput = () => { filterText = filt.value; renderData(); };
      bar.appendChild(filt);
      if (section === 'queues' || section === 'exchanges') {
        const pub = el('button', 'btn rmq-pub-btn');
        pub.append(icon('upload', 13), document.createTextNode(' Опубликовать'));
        pub.onclick = () => publishModal({});
        bar.appendChild(pub);
      }
      box.appendChild(bar);
    }
    dataBox = el('div', 'rmq-data');
    dataBox.appendChild(el('div', 'git-loading', 'Загружаю…'));
    box.appendChild(dataBox);
    if (section === 'queues') { peekBox = el('div', 'rmq-peek'); peekBox.style.display = 'none'; box.appendChild(peekBox); }
    loadSection(false);
    startPoll();
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => { if (!document.hidden) loadSection(true); }, 3000);
  }
  async function loadSection(silent) {
    if (section === 'tail') return; // live-tail не поллится — у него свой поток
    if (!activeId || pollBusy || !dataBox) return;
    pollBusy = true;
    const id = activeId, sec = section, seq = ++renderSeq;
    let r, err = null;
    try {
      if (sec === 'overview') r = await lite.rmq.overview(id, chartAge);
      else if (sec === 'queues') r = await lite.rmq.queues(id, vhost, true); // + спарклайны глубины
      else if (sec === 'exchanges') r = await lite.rmq.exchanges(id, vhost);
      else r = await lite.rmq.connections(id);
      if (r && r.error) err = r.error;
    } catch (e) { err = String(e); }
    pollBusy = false;
    if (activeId !== id || section !== sec || !dataBox) return; // контекст сменился во время запроса
    if (err) {
      setStatus(false, err);
      if (!silent || !dataBox.querySelector('[data-k], .rmq-ov')) { destroyOvCharts(); dataBox.innerHTML = ''; dataBox.appendChild(el('div', 'docker-err', err)); lastSig = ''; }
      return;
    }
    setStatus(true);
    if (sec === 'overview') { cur.overview = r; renderOverviewLive(); return; } // графики обновляются in-place, без пересборки DOM
    cur[sec] = r.items || [];
    const sig = JSON.stringify(cur[sec]);
    if (sig !== lastSig || seq === renderSeq && !dataBox.childElementCount) { lastSig = sig; renderData(); }
  }

  function renderData() {
    if (!dataBox) return;
    if (section === 'overview') return renderOverviewLive();
    const scroll0 = dataBox.scrollTop; // спарклайны меняются каждый полл → перерисовка не должна сбивать скролл
    dataBox.innerHTML = '';
    const q = (filterText || '').toLowerCase();
    if (section === 'queues') {
      let items = (cur.queues || []).filter((x) => !q || x.name.toLowerCase().includes(q));
      items = sortItems(items);
      renderQueues(dataBox, items);
    } else if (section === 'exchanges') {
      const items = (cur.exchanges || []).filter((x) => !q || (x.name || '(default)').toLowerCase().includes(q));
      renderExchanges(dataBox, items);
    } else {
      const items = (cur.connections || []).filter((x) => !q || (x.client + x.user + x.peer).toLowerCase().includes(q));
      renderConnections(dataBox, items);
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

  // ---------------------------------------------------------------- Обзор (KPI + графики)
  // Скелет строится один раз на маунт секции; полл обновляет значения и точки графиков
  // in-place (Chart.update без анимации) — DOM не пересобирается, ничего не мигает.
  function destroyOvCharts() {
    if (ovEls) { for (const ch of [ovEls.chLen, ovEls.chRate]) { try { ch && ch.destroy(); } catch (_) {} } }
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
    const cMsg = mkCard('Сообщений'), cPub = mkCard('Publish'), cDel = mkCard('Deliver'), cQ = mkCard('Очереди'), cCon = mkCard('Подключения');
    root.appendChild(cards);
    // диапазон графиков — как в стандартном UI (retention-политики: 10м/1ч/8ч/24ч)
    const chBar = el('div', 'rmq-ch-bar');
    chBar.appendChild(el('span', 'rmq-ch-title', 'Графики'));
    const rangeSel = el('select', 'rmq-peek-cnt');
    for (const [a, lbl] of [[600, '10 минут'], [3600, '1 час'], [28800, '8 часов'], [86400, '24 часа']]) rangeSel.appendChild(new Option(lbl, a, a === chartAge, a === chartAge));
    rangeSel.onchange = () => { chartAge = +rangeSel.value; loadSection(false); };
    chBar.appendChild(rangeSel);
    root.appendChild(chBar);
    const wrapLen = el('div', 'rmq-chart'); const cvLen = document.createElement('canvas'); wrapLen.appendChild(cvLen);
    const wrapRate = el('div', 'rmq-chart'); const cvRate = document.createElement('canvas'); wrapRate.appendChild(cvRate);
    root.append(el('div', 'rmq-ch-cap', 'Сообщения в очередях'), wrapLen, el('div', 'rmq-ch-cap', 'Скорости, сообщ./с'), wrapRate);
    root.appendChild(el('div', 'rmq-ch-cap', 'Ноды'));
    const nodesBox = el('div', 'rmq-nodes'); root.appendChild(nodesBox);
    const meta = el('div', 'rmq-meta'); root.appendChild(meta);
    box.appendChild(root);
    // тонкие линии, рецессивная сетка, легенда снизу, crosshair-тултип; цвета — токены темы,
    // соответствие серия→цвет фиксировано (смена диапазона серии не перекрашивает)
    const mkChart = (canvas, series) => new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: series.map((s0) => ({ label: s0.label, data: [], borderColor: s0.color, backgroundColor: s0.color, borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.25, fill: false, spanGaps: true })) },
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
    const chLen = mkChart(cvLen, [
      { label: 'Ready', color: cssVar('--info', '#7aa2f7') },
      { label: 'Unacked', color: cssVar('--warn', '#e0af68') },
    ]);
    const chRate = mkChart(cvRate, [
      { label: 'Publish', color: cssVar('--green', '#34d399') },
      { label: 'Deliver', color: cssVar('--info', '#7aa2f7') },
      { label: 'Ack', color: cssVar('--add', '#9ece6a') },
      { label: 'Redeliver', color: cssVar('--danger', '#f7768e') },
    ]);
    ovEls = { root, cMsg, cPub, cDel, cQ, cCon, rangeSel, chLen, chRate, nodesBox, meta, nodesSig: '' };
  }
  function updateOverview(ov) {
    if (!ovEls || !ov) return;
    ovEls.cMsg.v.textContent = fmtN(ov.messages); ovEls.cMsg.s.textContent = `ready ${fmtN(ov.ready)} · unacked ${fmtN(ov.unacked)}`;
    ovEls.cPub.v.textContent = fmtRate(ov.rates.publish) + '/с'; ovEls.cPub.s.textContent = 'входящий поток';
    ovEls.cDel.v.textContent = fmtRate(ov.rates.deliver) + '/с'; ovEls.cDel.s.textContent = `ack ${fmtRate(ov.rates.ack)}/с`;
    ovEls.cQ.v.textContent = fmtN(ov.totals.queues); ovEls.cQ.s.textContent = `exchanges ${fmtN(ov.totals.exchanges)}`;
    ovEls.cCon.v.textContent = fmtN(ov.totals.connections); ovEls.cCon.s.textContent = `каналы ${fmtN(ov.totals.channels)} · консюмеры ${fmtN(ov.totals.consumers)}`;
    const se = ov.series || {};
    const fmtT = (t) => { const d = new Date(t); const s = d.toTimeString(); return chartAge > 3600 ? s.slice(0, 5) : s.slice(0, 8); };
    const apply = (chart, seriesArr) => {
      const base = seriesArr.reduce((a, b) => (b.length > a.length ? b : a), []);
      chart.data.labels = base.map((p) => fmtT(p.t));
      // серии одного графика идут по одной сэмпл-сетке; rate-серии на 1 точку короче — выравниваем с конца
      seriesArr.forEach((s0, i) => { const pad = base.length - s0.length; chart.data.datasets[i].data = [...new Array(Math.max(0, pad)).fill(null), ...s0.map((p) => p.v)]; });
      chart.update('none');
    };
    const L = se.lengths || {}, R = se.rates || {};
    apply(ovEls.chLen, [L.ready || [], L.unacked || []]);
    apply(ovEls.chRate, [R.publish || [], R.deliver || [], R.ack || [], R.redeliver || []]);
    const nSig = JSON.stringify(ov.nodes || []);
    if (nSig !== ovEls.nodesSig) { // ноды меняются редко — пересобираем только по факту
      ovEls.nodesSig = nSig;
      ovEls.nodesBox.innerHTML = '';
      for (const n of (ov.nodes || [])) {
        const row = el('div', 'rmq-node' + (n.memAlarm || n.diskAlarm ? ' alarm' : ''));
        row.append(
          el('span', 'rmq-node-name', n.name),
          badge(n.running ? 'running' : 'down', '', n.running ? 'ok' : 'err'),
          el('span', 'rmq-node-kv', `память ${fmtB(n.memUsed)} / ${fmtB(n.memLimit)}${n.memAlarm ? ' ⚠ ALARM' : ''}`),
          el('span', 'rmq-node-kv', `диск свободно ${fmtB(n.diskFree)} (лимит ${fmtB(n.diskLimit)})${n.diskAlarm ? ' ⚠ ALARM' : ''}`),
          el('span', 'rmq-node-kv', `fd ${fmtN(n.fdUsed)}/${fmtN(n.fdTotal)}`),
          el('span', 'rmq-node-kv', `аптайм ${fmtUp(n.uptime)}`),
        );
        ovEls.nodesBox.appendChild(row);
      }
    }
    ovEls.meta.textContent = `RabbitMQ ${ov.version} · Erlang ${ov.erlang}${ov.cluster ? ' · ' + ov.cluster : ''}`;
  }

  // ---------------------------------------------------------------- Очереди
  const Q_COLS = [
    ['name', 'Очередь'], ['ready', 'Ready'], ['unacked', 'Unacked'], ['messages', 'Всего'],
    ['consumers', 'Конс.'], ['inRate', 'In/с'], ['outRate', 'Out/с'],
  ];
  // Спарклайн глубины очереди (12 точек за 2 мин, инлайн-SVG — дёшево для сотен строк).
  // Тревога = рост при ready>0 (красный + ↑), спад = зелёный + ↓; стрелка — вторичное
  // кодирование, чтобы смысл не держался на одном цвете.
  function sparkCell(qi) {
    const cell = el('span', 'rmq-cell rmq-spark');
    const vals = (qi.spark || []).map((p) => p.v);
    if (vals.length < 2) { cell.textContent = '—'; cell.classList.add('dim'); return cell; }
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
    const grow = last > first * 1.1 && last - first >= 5;
    const fall = first > last * 1.1 && first - last >= 5;
    if (grow && qi.ready > 0) { cell.classList.add('bad'); cell.title = `Глубина растёт: ${first} → ${last} за 2 мин`; cell.appendChild(el('span', 'rmq-trend', '↑')); }
    else if (fall) { cell.classList.add('good'); cell.title = `Глубина падает: ${first} → ${last} за 2 мин`; cell.appendChild(el('span', 'rmq-trend', '↓')); }
    else { cell.classList.add('dim'); cell.title = `Глубина за 2 мин: ${min}…${max}`; }
    return cell;
  }
  function renderQueues(box, items) {
    const headRow = el('div', 'rmq-row rmq-qgrid rmq-head');
    Q_COLS.forEach(([k, t], idx) => {
      const hCell = el('span', 'rmq-cell rmq-sortable' + (sortKey === k ? ' on' : ''), t + (sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''));
      hCell.onclick = () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'name' ? 1 : -1; } renderData(); };
      headRow.appendChild(hCell);
      if (idx === 0) headRow.appendChild(el('span', 'rmq-cell', 'Тренд')); // колонка спарклайнов (не сортируется)
    });
    headRow.appendChild(el('span', 'rmq-cell', ''));
    box.appendChild(headRow);
    if (!items.length) { box.appendChild(el('div', 'docker-empty', filterText ? 'Ничего не найдено.' : 'Нет очередей.')); return; }
    for (const qi of items) {
      const row = el('div', 'rmq-row rmq-qgrid clickable'); row.dataset.k = qi.vhost + '|' + qi.name;
      const nameCell = el('span', 'rmq-cell rmq-namecell');
      const dot = el('span', 'dstate dstate-' + (qi.state === 'running' ? 'run' : qi.state === 'idle' ? 'stop' : 'pause')); dot.title = qi.state;
      nameCell.append(dot, el('span', 'rmq-qname', qi.name));
      if (!vhost && qi.vhost !== '/') nameCell.appendChild(badge(qi.vhost, 'vhost'));
      if (qi.qtype && qi.qtype !== 'classic') nameCell.appendChild(badge(qi.qtype, 'тип очереди'));
      if (qi.durable) nameCell.appendChild(badge('D', 'durable — переживает рестарт брокера'));
      if (qi.autoDelete) nameCell.appendChild(badge('AD', 'auto-delete'));
      if (qi.exclusive) nameCell.appendChild(badge('Excl', 'exclusive'));
      if (qi.dlx) nameCell.appendChild(badge('DLX', 'dead-letter exchange: ' + qi.dlx, 'warn'));
      if (qi.ttl != null) nameCell.appendChild(badge('TTL', 'message TTL: ' + qi.ttl + ' мс'));
      if (qi.ready > 0 && !qi.consumers) nameCell.appendChild(badge('нет консюмеров', 'в очереди есть сообщения, но их никто не читает', 'err'));
      row.appendChild(nameCell);
      row.appendChild(sparkCell(qi));
      row.appendChild(el('span', 'rmq-cell num' + (qi.ready ? '' : ' dim'), fmtN(qi.ready)));
      row.appendChild(el('span', 'rmq-cell num' + (qi.unacked ? ' warn' : ' dim'), fmtN(qi.unacked)));
      row.appendChild(el('span', 'rmq-cell num' + (qi.messages ? '' : ' dim'), fmtN(qi.messages)));
      row.appendChild(el('span', 'rmq-cell num' + (qi.consumers ? '' : ' dim'), fmtN(qi.consumers)));
      row.appendChild(el('span', 'rmq-cell num dim', fmtRate(qi.inRate)));
      row.appendChild(el('span', 'rmq-cell num dim', fmtRate(qi.outRate)));
      const acts = el('span', 'rmq-cell drow-acts');
      const bPeek = iconBtn('drow-act', 'eye', 'Просмотреть сообщения (без съедания)', 13);
      bPeek.onclick = (e) => { e.stopPropagation(); openPeek(qi); };
      const bPub = iconBtn('drow-act', 'upload', 'Опубликовать в эту очередь', 13);
      bPub.onclick = (e) => { e.stopPropagation(); publishModal({ exchange: '', routingKey: qi.name, vhost: qi.vhost }); };
      const bPurge = iconBtn('drow-act', 'eraser', 'Очистить (purge)', 13);
      bPurge.onclick = (e) => {
        e.stopPropagation();
        guardedConfirm('Очистить очередь?', `Все сообщения «${qi.name}» (${fmtN(qi.messages)}) будут удалены безвозвратно.`, 'Очистить', async () => {
          const rr = await lite.rmq.purge(activeId, qi.vhost, qi.name);
          if (rr && rr.ok) { toast('Очередь очищена ✓'); lastSig = ''; loadSection(true); }
          else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
        });
      };
      const bDel = iconBtn('drow-act danger', 'trash', 'Удалить очередь', 13);
      bDel.onclick = (e) => {
        e.stopPropagation();
        guardedConfirm('Удалить очередь?', `«${qi.name}» будет удалена вместе с сообщениями (${fmtN(qi.messages)}).`, 'Удалить', async () => {
          const rr = await lite.rmq.deleteQueue(activeId, qi.vhost, qi.name);
          if (rr && rr.ok) { toast('Очередь удалена ✓'); if (peekQ === qi.name) closePeek(); lastSig = ''; loadSection(true); }
          else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
        });
      };
      acts.append(bPeek, bPub, bPurge, bDel);
      row.appendChild(acts);
      row.addEventListener('click', () => openPeek(qi));
      box.appendChild(row);
    }
  }

  // --- peek-панель: просмотр сообщений очереди без съедания (requeue)
  function closePeek() { peekQ = null; if (peekBox) { peekBox.style.display = 'none'; peekBox.innerHTML = ''; } }
  function openPeek(qi) {
    if (!peekBox) return;
    peekQ = qi.name;
    peekBox.style.display = '';
    peekBox.innerHTML = '';
    const head = el('div', 'rmq-peek-head');
    head.append(icon('eye', 14), el('span', 'rmq-peek-title', `Сообщения: ${qi.name}`));
    const cnt = el('select', 'rmq-peek-cnt');
    for (const n of [1, 10, 50]) cnt.appendChild(new Option(n + ' шт', n, n === 10, n === 10));
    const load = () => fetchPeek(qi, +cnt.value);
    cnt.onchange = load;
    const re = iconBtn('drow-act', 'refresh', 'Перечитать', 13); re.onclick = load;
    const x = iconBtn('drow-act', 'x', 'Закрыть', 13); x.onclick = closePeek;
    head.append(cnt, re, x);
    peekBox.appendChild(head);
    peekBox.appendChild(el('div', 'rmq-peek-list'));
    load();
  }
  async function fetchPeek(qi, count) {
    const list = peekBox && peekBox.querySelector('.rmq-peek-list'); if (!list) return;
    list.innerHTML = ''; list.appendChild(el('div', 'git-loading', 'Читаю…'));
    let r;
    try { r = await lite.rmq.peek(activeId, qi.vhost, qi.name, count); } catch (e) { r = { error: String(e) }; }
    if (!peekBox || peekQ !== qi.name) return;
    list.innerHTML = '';
    if (r.error) { list.appendChild(el('div', 'docker-err', r.error)); return; }
    const items = r.items || [];
    if (!items.length) { list.appendChild(el('div', 'docker-empty', 'Очередь пуста.')); return; }
    items.forEach((mMsg, i) => {
      const blk = el('div', 'rmq-msg');
      const mh = el('div', 'rmq-msg-head');
      mh.append(
        el('span', 'rmq-msg-idx', '#' + (i + 1)),
        el('span', 'rmq-msg-route', `${mMsg.exchange || '(default)'} → ${mMsg.routingKey || ''}`),
      );
      if (mMsg.redelivered) mh.appendChild(badge('redelivered', 'сообщение уже доставлялось', 'warn'));
      const ct = mMsg.properties && mMsg.properties.content_type;
      if (ct) mh.appendChild(badge(ct, 'content-type'));
      mh.appendChild(el('span', 'rmq-msg-bytes', fmtB(mMsg.bytes)));
      const cp = iconBtn('drow-act', 'copy', 'Скопировать payload', 12);
      cp.onclick = () => { navigator.clipboard.writeText(mMsg.payload || '').then(() => toast('Скопировано')); };
      mh.appendChild(cp);
      blk.appendChild(mh);
      let text = mMsg.payload || '';
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
      blk.appendChild(el('pre', 'rmq-msg-body', text));
      const props = mMsg.properties || {};
      const extra = Object.keys(props).filter((k) => k !== 'content_type' && k !== 'headers');
      const hdrs = props.headers && Object.keys(props.headers).length ? props.headers : null;
      if (extra.length || hdrs) {
        const pl = el('div', 'rmq-msg-props');
        for (const k of extra) pl.appendChild(el('span', null, `${k}: ${JSON.stringify(props[k])}`));
        if (hdrs) pl.appendChild(el('span', null, 'headers: ' + JSON.stringify(hdrs)));
        blk.appendChild(pl);
      }
      list.appendChild(blk);
    });
    list.appendChild(el('div', 'rmq-peek-note', 'Сообщения возвращены в очередь (requeue) — порядок может измениться, флаг redelivered установлен.'));
  }

  // ---------------------------------------------------------------- Exchanges
  function renderExchanges(box, items) {
    if (!items.length) { box.appendChild(el('div', 'docker-empty', filterText ? 'Ничего не найдено.' : 'Нет exchanges.')); return; }
    for (const ex of items) {
      const row = el('div', 'rmq-row rmq-exgrid'); row.dataset.k = ex.vhost + '|' + ex.name;
      const nameCell = el('span', 'rmq-cell rmq-namecell');
      nameCell.append(icon('graph', 13), el('span', 'rmq-qname', ex.name || '(default)'));
      if (!vhost && ex.vhost !== '/') nameCell.appendChild(badge(ex.vhost, 'vhost'));
      nameCell.appendChild(badge(ex.type, 'тип exchange', 'type'));
      if (ex.durable) nameCell.appendChild(badge('D', 'durable'));
      if (ex.autoDelete) nameCell.appendChild(badge('AD', 'auto-delete'));
      if (ex.internal) nameCell.appendChild(badge('int', 'internal — публиковать нельзя'));
      row.appendChild(nameCell);
      row.appendChild(el('span', 'rmq-cell num dim', 'in ' + fmtRate(ex.inRate) + '/с'));
      row.appendChild(el('span', 'rmq-cell num dim', 'out ' + fmtRate(ex.outRate) + '/с'));
      const acts = el('span', 'rmq-cell drow-acts');
      if (ex.name) { // default ('') нельзя биндить — tail только для именованных
        const bTail = iconBtn('drow-act', 'play', 'Live-tail — слушать поток этого exchange', 13);
        bTail.onclick = () => startTailFor(ex);
        acts.appendChild(bTail);
      }
      if (!ex.internal) {
        const bPub = iconBtn('drow-act', 'upload', 'Опубликовать в этот exchange', 13);
        bPub.onclick = () => publishModal({ exchange: ex.name, vhost: ex.vhost });
        acts.appendChild(bPub);
      }
      row.appendChild(acts);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- Подключения
  function renderConnections(box, items) {
    if (!items.length) { box.appendChild(el('div', 'docker-empty', 'Нет активных подключений.')); return; }
    for (const cn of items) {
      const row = el('div', 'rmq-row rmq-cngrid'); row.dataset.k = cn.name;
      const nameCell = el('span', 'rmq-cell rmq-namecell');
      const dot = el('span', 'dstate dstate-' + (cn.state === 'running' ? 'run' : 'pause')); dot.title = cn.state;
      nameCell.append(dot, el('span', 'rmq-qname', cn.client || cn.name));
      nameCell.appendChild(badge(cn.user, 'пользователь'));
      if (cn.vhost && cn.vhost !== '/') nameCell.appendChild(badge(cn.vhost, 'vhost'));
      row.appendChild(nameCell);
      row.appendChild(el('span', 'rmq-cell dim', cn.peer));
      row.appendChild(el('span', 'rmq-cell num dim', 'каналов: ' + cn.channels));
      row.appendChild(el('span', 'rmq-cell num dim', `↓${fmtRate(cn.recvRate)} ↑${fmtRate(cn.sendRate)} Б/с`));
      const acts = el('span', 'rmq-cell drow-acts');
      const kill = iconBtn('drow-act danger', 'power', 'Разорвать подключение', 13);
      kill.onclick = () => {
        guardedConfirm('Разорвать подключение?', `Клиент «${cn.client || cn.name}» (${cn.peer}, юзер ${cn.user}) будет отключён.`, 'Разорвать', async () => {
          const rr = await lite.rmq.killConnection(activeId, cn.name);
          if (rr && rr.ok) { toast('Подключение разорвано ✓'); lastSig = ''; loadSection(true); }
          else toast((rr && rr.error) || 'Не удалось', { kind: 'err' });
        });
      };
      acts.appendChild(kill);
      row.appendChild(acts);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- Live-tail
  // Прослушивание exchange через временную очередь (bind + consume в main, lib/rmq.js openTail):
  // реальные консюмеры сообщений НЕ теряют. Пауза копит сообщения в буфер и доигрывает их.
  const tailVhost = () => vhost || (activeConn && activeConn.vhost) || '/';
  // Кнопка ▶ на строке exchange: перейти в секцию Live-tail и сразу начать слушать его.
  function startTailFor(ex) {
    tailPreset = { exchange: ex.name };
    if (ex.vhost && ex.vhost !== tailVhost()) vhost = ex.vhost; // tail живёт в vhost'е exchange'а
    section = 'tail';
    renderPanel(); // перерисует воркспейс с активной секцией tail → mountTail → автозапуск
  }
  function mountTail(box) {
    const bar = el('div', 'rmq-toolbar');
    const exSel = el('select', 'rmq-tail-ex');
    exSel.appendChild(new Option('— выбери exchange —', ''));
    const pat = el('input', 'rmq-filter'); pat.type = 'text'; pat.value = tail.pattern || '#';
    pat.placeholder = 'binding key: topic → # или app.*, direct → точный ключ';
    pat.title = 'topic: # (всё) / app.*.err; fanout: игнорируется; direct: точный routing key';
    const startBtn = el('button', 'btn primary rmq-tail-btn');
    const setStartBtn = () => { startBtn.innerHTML = ''; startBtn.append(icon(tail.id ? 'stop' : 'play', 13), document.createTextNode(tail.id ? ' Стоп' : ' Слушать')); };
    const pauseBtn = iconBtn('drow-act' + (tail.paused ? ' on' : ''), 'pause', 'Пауза — сообщения копятся и доиграются', 14);
    const clearBtn = iconBtn('drow-act', 'eraser', 'Очистить вывод', 14);
    const counter = el('span', 'rmq-tail-cnt', '0 сообщ.');
    bar.append(exSel, pat, startBtn, pauseBtn, clearBtn, counter);
    box.appendChild(bar);
    const note = el('div', 'rmq-tail-note', (tail.id && tail.note) ? tail.note : `vhost: ${tailVhost()} · временная очередь биндится на exchange — реальные консюмеры ничего не теряют`);
    box.appendChild(note);
    const list = el('div', 'rmq-data rmq-tail-list');
    box.appendChild(list);
    tailEls = { exSel, pat, startBtn, pauseBtn, list, counter, note, setStartBtn };
    setStartBtn(); updateTailCounter();
    // доигрываем накопленное — стрим мог работать в фоне, пока смотрели другие секции/вкладки
    if (tail.msgs.length) { for (const p of tail.msgs) appendTailRowDom(p); list.scrollTop = list.scrollHeight; }
    else list.appendChild(el('div', 'docker-empty', 'Выбери exchange и нажми «Слушать». Поток сообщений появится здесь.'));
    const autoPattern = () => {
      const ex = (cur.exchanges || []).find((x) => x.name === exSel.value);
      pat.value = ex && ex.type === 'topic' ? '#' : '';
    };
    exSel.onchange = autoPattern;
    startBtn.onclick = () => { if (tail.id) stopTail(); else startTail(); };
    pauseBtn.onclick = () => {
      tail.paused = !tail.paused;
      pauseBtn.classList.toggle('on', tail.paused);
      if (!tail.paused) { const buf = tail.buf.splice(0); for (const p of buf) { tail.msgs.push(p); if (tail.msgs.length > 500) tail.msgs.shift(); appendTailRowDom(p); } updateTailCounter(); }
      else toast('Пауза: сообщения копятся (до 1000)', { ttl: 2500 });
    };
    clearBtn.onclick = () => { list.innerHTML = ''; tail.buf = []; tail.msgs = []; tail.count = 0; updateTailCounter(); };
    // список exchanges нужного vhost'а для селекта (+ восстановление выбора / автозапуск из строки exchange)
    lite.rmq.exchanges(activeId, tailVhost()).then((r) => {
      if (!tailEls || tailEls.exSel !== exSel || r.error) return; // секцию успели перемонтировать
      cur.exchanges = r.items || [];
      for (const ex of cur.exchanges) if (ex.name) exSel.appendChild(new Option(`${ex.name} · ${ex.type}`, ex.name));
      if (tail.exchange) {
        if (![...exSel.options].some((o) => o.value === tail.exchange)) exSel.appendChild(new Option(tail.exchange, tail.exchange));
        exSel.value = tail.exchange;
      }
      if (tailPreset) { exSel.value = tailPreset.exchange; autoPattern(); tailPreset = null; if (exSel.value && !tail.id) startTail(); }
    }).catch(() => {});
  }
  async function startTail() {
    if (!tailEls || tail.id) return;
    const exchange = tailEls.exSel.value;
    if (!exchange) { toast('Выбери exchange для прослушивания', { kind: 'err' }); return; }
    const sid = 'tl' + (++tailUid) + Date.now().toString(36);
    const t = tail; // фиксируем объект: к моменту ответа юзер мог переключить вкладку профиля
    t.id = sid; t.paused = false; t.buf = []; t.count = 0; t.msgs = [];
    t.exchange = exchange; t.pattern = tailEls.pat.value;
    tailStreams.set(sid, t);
    tailEls.setStartBtn(); tailEls.pauseBtn.classList.remove('on'); updateTailCounter();
    tailEls.list.innerHTML = '';
    tailEls.list.appendChild(el('div', 'docker-empty', 'Слушаю… жду сообщений.'));
    const vh0 = tailVhost();
    let r;
    try { r = await lite.rmq.tailStart(activeId, vh0, exchange, t.pattern, sid); }
    catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) {
      tailStreams.delete(sid); t.id = null;
      if (t === tail && tailEls) { tailEls.setStartBtn(); tailEls.list.innerHTML = ''; tailEls.list.appendChild(el('div', 'docker-err', (r && r.error) || 'Не удалось начать прослушивание')); }
      toast((r && r.error) || 'Live-tail не запустился (проверь AMQP-порт в профиле)', { kind: 'err', ttl: 9000 });
      return;
    }
    t.note = `Слушаю «${exchange}» (ключ: ${t.pattern || '—'}) · vhost ${vh0} · AMQP-порт ${(activeConn && activeConn.amqpPort) || 5672}`;
    if (t === tail && tailEls) tailEls.note.textContent = t.note;
  }
  function stopTail(t = tail) {
    if (t.id) { try { lite.rmq.tailStop(t.id); } catch (_) {} tailStreams.delete(t.id); t.id = null; }
    t.paused = false; t.buf = [];
    if (t === tail && tailEls) { tailEls.setStartBtn(); tailEls.pauseBtn.classList.remove('on'); }
  }
  function stopAllTails() { for (const t of [...tailStreams.values()]) stopTail(t); }
  function updateTailCounter() {
    if (tailEls) tailEls.counter.textContent = `${tail.count} сообщ.${tail.paused ? ` · пауза (+${tail.buf.length})` : ''}`;
  }
  // Приём кадра: t — tail-объект СВОЕГО профиля (не обязательно активного). В DOM пишем
  // только когда его вкладка активна и открыта секция tail; иначе копим в msgs.
  function handleTailMsg(t, p) {
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
      el('span', 'rmq-msg-route', p.routingKey || '(пустой ключ)'),
    );
    if (p.redelivered) head.appendChild(badge('redelivered', '', 'warn'));
    if (p.properties && p.properties.contentType) head.appendChild(badge(p.properties.contentType, 'content-type'));
    head.appendChild(el('span', 'rmq-msg-bytes', fmtB(p.size)));
    const cp = iconBtn('drow-act', 'copy', 'Скопировать payload', 12);
    cp.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(p.payload || '').then(() => toast('Скопировано')); };
    head.appendChild(cp);
    row.appendChild(head);
    row.appendChild(el('div', 'rmq-tl-prev', (p.payload || '').replace(/\s+/g, ' ').slice(0, 180) || '(пустой payload)'));
    let expanded = null;
    row.onclick = () => { // клик — развернуть/свернуть pretty-JSON
      if (expanded) { expanded.remove(); expanded = null; return; }
      let text = p.payload || '';
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
      expanded = el('pre', 'rmq-msg-body', text);
      const hdrs = p.properties && p.properties.headers;
      if (hdrs && Object.keys(hdrs).length) expanded.textContent += '\n\n— headers —\n' + JSON.stringify(hdrs, null, 2);
      row.appendChild(expanded);
    };
    list.appendChild(row);
    while (list.children.length > 500) list.removeChild(list.firstChild); // кап буфера DOM
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  // подписки на поток — один раз на весь модуль; кадры роутятся в tail-объект своего профиля
  lite.rmq.onTailData((p) => { const t = p && tailStreams.get(p.streamId); if (t) handleTailMsg(t, p); });
  lite.rmq.onTailExit((p) => {
    const t = p && tailStreams.get(p.streamId); if (!t) return;
    tailStreams.delete(p.streamId); t.id = null;
    if (t === tail && tailEls) { tailEls.setStartBtn(); tailEls.note.textContent += ' · поток закрыт сервером'; }
    toast(`Live-tail («${t.exchange}»): соединение закрыто`, { kind: 'err', ttl: 6000 });
  });

  // ---------------------------------------------------------------- публикация
  // История последних отправок — per-профиль в rmqUi.pubHist (восстанавливает все поля формы).
  function publishModal(pre) {
    const { m, close } = makeModal('<h2>Опубликовать сообщение</h2><div id="rmqp" class="db-form"></div>');
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#rmqp');
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const hist = (rmqUi.pubHist && rmqUi.pubHist[activeId]) || [];
    const exSel = el('select');
    exSel.appendChild(new Option('(default) — напрямую в очередь по routing key', ''));
    for (const ex of (cur.exchanges || [])) { if (ex.name && !ex.internal) exSel.appendChild(new Option(ex.name + '  ·  ' + ex.type, ex.name)); }
    if (pre.exchange != null) exSel.value = pre.exchange;
    if (pre.exchange && exSel.value !== pre.exchange) { exSel.appendChild(new Option(pre.exchange, pre.exchange, true, true)); }
    const rk = el('input'); rk.type = 'text'; rk.placeholder = 'routing key (для default — имя очереди)'; rk.value = pre.routingKey || '';
    const payload = el('textarea', 'rmq-payload'); payload.rows = 8; payload.placeholder = '{"hello": "world"}';
    const dmSel = el('select');
    dmSel.append(new Option('Persistent (2) — переживает рестарт', '2', true, true), new Option('Transient (1)', '1'));
    const ctI = el('input'); ctI.type = 'text'; ctI.value = 'application/json'; ctI.placeholder = 'content-type';
    if (hist.length) {
      const hSel = el('select');
      hSel.appendChild(new Option('История отправок…', ''));
      hist.forEach((h, i) => hSel.appendChild(new Option(`${h.exchange || '(default)'} → ${h.routingKey}  ·  ${(h.payload || '').slice(0, 40)}`, String(i))));
      hSel.onchange = () => {
        const h = hist[+hSel.value]; if (!h) return;
        exSel.value = h.exchange || ''; rk.value = h.routingKey || ''; payload.value = h.payload || '';
        if (h.deliveryMode) dmSel.value = String(h.deliveryMode);
        if (h.contentType) ctI.value = h.contentType;
      };
      f.appendChild(mk('Шаблон', hSel));
    }
    f.appendChild(mk('Exchange', exSel));
    f.appendChild(mk('Routing key', rk));
    const pw = el('div', 'db-field');
    const pl = el('label', null, 'Payload');
    const fmt = el('button', 'btn rmq-fmt-btn', '{ } формат');
    fmt.onclick = (e) => { e.preventDefault(); try { payload.value = JSON.stringify(JSON.parse(payload.value), null, 2); } catch (_) { toast('Payload — не валидный JSON', { kind: 'err' }); } };
    const plRow = el('div', 'rmq-pl-row'); plRow.append(pl, fmt);
    pw.append(plRow, payload); f.appendChild(pw);
    const row2 = el('div', 'db-row2');
    const cell = (label, node) => { const w = el('div', 'db-field'); w.append(el('label', null, label), node); return w; };
    row2.append(cell('Delivery mode', dmSel), cell('Content-type', ctI));
    f.appendChild(row2);
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const send = el('button', 'btn primary', 'Отправить');
    send.onclick = async () => {
      if (!rk.value.trim() && !exSel.value) { toast('Для default exchange нужен routing key (имя очереди)', { kind: 'err' }); return; }
      status.textContent = 'Отправляю…'; status.className = 'db-test-status';
      const props = { delivery_mode: +dmSel.value };
      if (ctI.value.trim()) props.content_type = ctI.value.trim();
      const vhTarget = pre.vhost || vhost || (activeConn && activeConn.vhost) || '/'; // приоритет — vhost строки, из которой открыли
      const r = await lite.rmq.publish(activeId, vhTarget, exSel.value, rk.value.trim(), payload.value, props);
      if (r && r.ok) {
        rmqUi.pubHist = rmqUi.pubHist || {};
        const arr = rmqUi.pubHist[activeId] = rmqUi.pubHist[activeId] || [];
        arr.unshift({ exchange: exSel.value, routingKey: rk.value.trim(), payload: payload.value, deliveryMode: +dmSel.value, contentType: ctI.value.trim() });
        rmqUi.pubHist[activeId] = arr.slice(0, 10);
        saveUi();
        if (r.routed) { status.textContent = '✓ Отправлено и маршрутизировано'; status.classList.add('ok'); toast('Сообщение отправлено ✓'); lastSig = ''; loadSection(true); }
        else { status.textContent = '⚠ Отправлено, но НЕ маршрутизировано (нет подходящей очереди/биндинга)'; status.classList.add('err'); }
      } else { status.textContent = '✕ ' + ((r && r.error) || 'не удалось'); status.classList.add('err'); }
    };
    const cancel = el('button', 'btn', 'Закрыть'); cancel.onclick = close;
    row.append(send, cancel); f.appendChild(row); f.appendChild(status);
    // если exchanges ещё не загружены (открыли из «Очередей» до визита в Exchanges) — дотянем список
    if (!(cur.exchanges || []).length && activeId) {
      lite.rmq.exchanges(activeId, vhost).then((r) => {
        if (r && !r.error) { cur.exchanges = r.items || []; const v = exSel.value;
          for (const ex of cur.exchanges) if (ex.name && !ex.internal && ![...exSel.options].some((o) => o.value === ex.name)) exSel.appendChild(new Option(ex.name + '  ·  ' + ex.type, ex.name));
          exSel.value = v;
        }
      }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- refresh (кнопка шапки окна)
  function refresh() {
    if (!rmqOpen) return;
    if (activeId) {
      if (section === 'tail') { loadVhosts(); mountSection(); return; } // перемонтаж: свежий список exchanges, стрим живёт
      lastSig = ''; loadVhosts(); loadSection(false);
    } else renderPanel();
  }

  return { isOpen: () => rmqOpen, setOpen: setRmqOpen, toggle: toggleRmq, renderPanel, refresh, openFromContainer };
}
