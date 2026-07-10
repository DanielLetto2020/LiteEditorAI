// LiteEditor — модуль «Базы данных» (Postgres/MySQL/SQLite).
// IDE-уровень: дерево объектов (колонки/типы/PK/FK), вкладки таблиц и SQL-консолей,
// типизированный грид (сортировка/ресайз/выделение/копирование/просмотр ячейки/inline-edit),
// автокомплит SQL по схеме, ER-диаграмма, конструктор запросов, сравнение схем, история.
// Изоляция по образцу textproc.js: ядро — через host; UI-хелперы — из ui.js; бэкенд — window.lite.db.*.
import { el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt } from '../ui.js';
import { marked } from 'marked';
import Chart from 'chart.js/auto';   // static import: chart.js/auto auto-registers all controllers
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initDb(host) {
  const { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let dbOpen = false;
  let dbConnsList = [], dbSecure = true;
  let dbActiveId = null, dbActiveConn = null, dbSchema = null, dbColsCache = null, dbObjectsCache = null;
  let dbRenderSeq = 0;
  let dbUi = (STORE.dbUi && typeof STORE.dbUi === 'object') ? STORE.dbUi : {};
  const DB_TYPES = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', sqlite: 'SQLite' };
  const DB_DEF_PORT = { postgres: 5432, mysql: 3306, sqlite: 0 };
  const DB_PAGE = 200;

  // workspace state (per active connection)
  let tabs = [];            // { key, kind:'table'|'sql'|'ddl'|'er'|'diff'|'qbuilder', title, ... }
  let activeKey = null;
  const metaCache = new Map();   // "schema.table" -> meta
  let sqlSeq = 0;
  // AI-DB: outer workspace view ('desk' | 'ai') + per-connection chat state
  let wsView = 'desk';
  const aiChats = new Map();      // connId -> { messages:[], busy, reqId, agent }
  let aiSeq = 0;

  // auto-refresh timer (DataGrip-style): reloads the active TABLE tab on an interval
  let autoRefSec = (typeof dbUi.autoRefSec === 'number') ? dbUi.autoRefSec : 0;   // 0 = off/pause
  let autoRefTimer = null;
  function stopAutoRef() { if (autoRefTimer) { clearInterval(autoRefTimer); autoRefTimer = null; } }
  function startAutoRef() {
    stopAutoRef();
    if (autoRefSec > 0) autoRefTimer = setInterval(() => {
      const t = findTab(activeKey);
      if (t && t.kind === 'table' && t.mode !== 'structure' && !pendingCount(t) && !document.getElementById('db-valpanel')) { t._force = true; renderTabBody($('#db-tabbody')); }
    }, autoRefSec * 1000);
  }
  function setAutoRef(sec) { autoRefSec = sec; dbUi.autoRefSec = sec; saveDbUi(); startAutoRef(); }
  function fmtInterval(s) { return s <= 0 ? 'выкл' : s < 60 ? s + 'с' : (s % 60 ? (Math.round(s / 6) / 10) : (s / 60)) + 'мин'; }

  function setDbOpen(open, opts = {}) {
    if (open === dbOpen) { if (open) renderDbPanel(); return; }
    if (open) closeOtherPanels('db');
    else dbDispose();
    const delta = layout.db + GUTTER;
    dbOpen = open;
    $('#db-pane').classList.toggle('hidden', !open);
    $('#gutter-db').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderDbPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleDb() { setDbOpen(!dbOpen); }
  let restoredOnce = false;
  function saveSession() {
    if (!dbActiveId) return;
    const ser = tabs.filter((t) => t.kind === 'table' || t.kind === 'sql').map((t) => t.kind === 'table'
      ? { kind: 'table', schema: t.schema, table: t.table, view: t.view, title: t.title, where: t.where, orderBy: t.orderBy, orderDir: t.orderDir, mode: t.mode }
      : { kind: 'sql', title: t.title, sql: t.sql });
    dbUi.session = { connId: dbActiveId, tabs: ser, activeKey }; saveDbUi();
  }
  function restoreSession(conn) {
    dbActiveId = conn.id; dbActiveConn = conn; dbSchema = null; dbColsCache = null; dbObjectsCache = null;
    metaCache.clear(); dbRelationsCache = null; navStack = []; navPtr = -1; tabs = [];
    for (const s of (dbUi.session.tabs || [])) {
      if (s.kind === 'table') tabs.push({ key: tabKeyTable(s.schema, s.table), kind: 'table', schema: s.schema, table: s.table, view: s.view, title: s.title, page: 0, orderBy: s.orderBy || null, orderDir: s.orderDir || 'asc', where: s.where || '', mode: s.mode || 'data' });
      else tabs.push({ key: 'sql:' + (++sqlSeq), kind: 'sql', title: s.title || ('Запрос ' + sqlSeq), sql: s.sql || '' });
    }
    activeKey = (dbUi.session.activeKey && findTab(dbUi.session.activeKey)) ? dbUi.session.activeKey : (tabs[0] && tabs[0].key) || null;
    renderDbPanel();
  }
  function dbDispose() { stopAutoRef(); destroyAllEditors(); const vp = document.getElementById('db-valpanel'); if (vp) vp.remove(); for (const d of aiChats.values()) for (const s of (d.sessions || [])) { if (s._reqId) { try { lite.dbai.abort(s._reqId); } catch (_) {} s._reqId = null; s._busy = false; } } }
  function saveDbUi() { persist('dbUi', dbUi); }
  function dbCatHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }

  // ---- dialect-aware quoting (renderer side, for inline-edit & query builder)
  function qIdent(id) { return dbActiveConn && dbActiveConn.type === 'mysql' ? '`' + String(id).replace(/`/g, '``') + '`' : '"' + String(id).replace(/"/g, '""') + '"'; }
  function qual(schema, table) { if (dbActiveConn && dbActiveConn.type === 'sqlite') return qIdent(table); return (schema ? qIdent(schema) + '.' : '') + qIdent(table); }
  function lit(v) { if (v == null) return 'NULL'; if (typeof v === 'number') return String(v); if (/^-?\d+(\.\d+)?$/.test(String(v))) return String(v); return "'" + String(v).replace(/'/g, "''") + "'"; }
  // kept in sync with lib/db.js DESTRUCTIVE — covers SELECT INTO / COPY / ATTACH / CALL / … that
  // would otherwise slip past a SELECT-prefix check and write to the DB or filesystem.
  const DESTRUCTIVE_RE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|call|do|vacuum|reindex|attach|detach|lock|rename|into|load|handler|replace)\b/i;
  function isDestructiveSql(s) { const t = String(s).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""'); return DESTRUCTIVE_RE.test(t); }
  // strict read-only gate for the AI tab: not destructive AND starts with a read statement
  function isReadOnlyQuery(s) { return !isDestructiveSql(s) && /^\s*\(*\s*(select|with|explain|show|describe|desc|pragma|table|values)\b/i.test(String(s)); }
  // confirm before a writing statement on a PRODUCTION-flagged connection
  function prodGuard(sqlText, run) { if (dbActiveConn && dbActiveConn.isProd && isDestructiveSql(sqlText)) showConfirm('PRODUCTION', `Подключение «${dbActiveConn.name}» помечено как PRODUCTION. Выполнить изменяющий запрос?`, 'Выполнить', run); else run(); }

  // ============================================================ panel router
  async function renderDbPanel() {
    const seq = ++dbRenderSeq;
    const body = $('#db-body');
    if (!dbActiveId) {
      body.innerHTML = '<div class="git-loading">Загрузка подключений…</div>';
      try { const r = await lite.db.list(); dbConnsList = r.connections || []; dbSecure = r.secure !== false; }
      catch (_) { dbConnsList = []; }
      if (seq !== dbRenderSeq || !dbOpen) return;
      if (!restoredOnce && dbUi.session && dbUi.session.connId) { restoredOnce = true; const conn = dbConnsList.find((c) => c.id === dbUi.session.connId); if (conn) { restoreSession(conn); return; } }
      renderDbConnections(body);
    } else {
      renderDbWorkspace(body);
    }
  }

  // ============================================================ connections list
  function renderDbConnections(body) {
    body.innerHTML = '';
    const top = el('div', 'db-topbar');
    top.appendChild(el('span', 'db-topbar-title', 'Подключения'));
    const add = iconBtn('drow-act', 'plus', 'Новое подключение', 16); add.onclick = () => dbConnModal(null);
    top.appendChild(add);
    body.appendChild(top);
    if (!dbSecure) body.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — пароли шифруются слабее.'));
    if (!dbConnsList.length) { body.appendChild(el('div', 'docker-empty', 'Нет подключений. Добавь первое кнопкой ＋.')); return; }
    const groups = {};
    for (const c of dbConnsList) { const g = c.category || 'Все'; (groups[g] = groups[g] || []).push(c); }
    const cats = Object.keys(groups).sort((a, b) => (a === 'Все' ? -1 : b === 'Все' ? 1 : a.localeCompare(b)));
    for (const cat of cats) body.appendChild(dbCatBlock(cat, groups[cat]));
  }
  function dbCatBlock(cat, list) {
    const block = el('div', 'docker-group-block');
    const head = el('div', 'docker-group-head');
    const hue = dbCatHue(cat);
    head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
    head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
    const collapsed = !!(dbUi.catCollapsed && dbUi.catCollapsed[cat]);
    const chev = icon(collapsed ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
    head.append(chev, el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(list.length)));
    const bodyEl = el('div', 'docker-group-body');
    if (collapsed) bodyEl.style.display = 'none';
    for (const c of list) bodyEl.appendChild(dbConnRow(c));
    head.onclick = () => {
      dbUi.catCollapsed = dbUi.catCollapsed || {}; dbUi.catCollapsed[cat] = !dbUi.catCollapsed[cat]; saveDbUi();
      const col = dbUi.catCollapsed[cat]; bodyEl.style.display = col ? 'none' : '';
      const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev'); head.replaceChild(nc, head.firstChild);
    };
    block.append(head, bodyEl);
    return block;
  }
  function dbConnRow(c) {
    const row = el('div', 'db-conn-row clickable');
    if (c.color) { row.style.borderLeft = `3px solid ${c.color}`; row.style.paddingLeft = '6px'; }
    row.appendChild(icon('database', 16));
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', c.name || '(без имени)'));
    const sub = c.type === 'sqlite' ? (c.file || c.database || 'файл не задан')
      : `${DB_TYPES[c.type] || c.type} · ${c.host || 'localhost'}:${c.port || DB_DEF_PORT[c.type] || ''}${c.sshEnabled ? ' · SSH' : ''}${c.readOnly ? ' · RO' : ''}`;
    main.appendChild(el('span', 'drow-sub', sub));
    row.appendChild(main);
    const acts = el('div', 'drow-acts');
    const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13); edit.onclick = (e) => { e.stopPropagation(); dbConnModal(c); };
    const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
    del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить подключение?', `«${c.name}» удалится из списка (сама БД не трогается).`, 'Удалить', async () => { await lite.db.delete(c.id); renderDbPanel(); }); };
    acts.append(edit, del); row.appendChild(acts);
    row.addEventListener('click', () => openConnection(c));
    return row;
  }

  function openConnection(c) {
    dbActiveId = c.id; dbActiveConn = c; dbSchema = null; dbColsCache = null; dbObjectsCache = null;
    tabs = []; activeKey = null; metaCache.clear(); dbRelationsCache = null; navStack = []; navPtr = -1;
    renderDbPanel();
  }

  // ============================================================ connection modal (host + SSH)
  function dbConnModal(existing) {
    const c = existing ? { ...existing } : { type: 'postgres', category: 'Все', port: 5432 };
    const { m, close } = makeModal(`<h2>${existing ? 'Изменить' : 'Новое'} подключение</h2><div id="dbf" class="db-form"></div>`);
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#dbf');
    const field = (label, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, label)); w.appendChild(node); f.appendChild(w); return node; };
    const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
    const name = field('Имя', inp(c.name, 'Моя база'));
    const typeSel = el('select'); for (const [k, v] of Object.entries(DB_TYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === c.type) o.selected = true; typeSel.appendChild(o); }
    // Категория — выбор из существующих или создание новой
    const cats = [...new Set(dbConnsList.map((x) => (x.category || 'Все')).filter(Boolean))];
    if (!cats.includes('Все')) cats.unshift('Все');
    if (c.category && !cats.includes(c.category)) cats.push(c.category);
    const catSel = el('select'); for (const cc of cats) { const o = new Option(cc, cc); if (cc === (c.category || 'Все')) o.selected = true; catSel.appendChild(o); }
    const CAT_NEW = '__newcat__'; catSel.appendChild(new Option('➕ Новая категория…', CAT_NEW));
    const catNew = inp('', 'Название новой категории'); catNew.style.display = 'none';
    catSel.onchange = () => { const isNew = catSel.value === CAT_NEW; catNew.style.display = isNew ? '' : 'none'; if (isNew) catNew.focus(); };
    const catWrap = el('div', 'db-cat-wrap'); catWrap.append(catSel, catNew);
    const getCategory = () => (catSel.value === CAT_NEW ? catNew.value.trim() : catSel.value) || 'Все';
    // Тип + Категория одним рядом (2 колонки)
    const row2 = el('div', 'db-row2');
    const cell = (label, node) => { const w = el('div', 'db-field'); w.append(el('label', null, label), node); return w; };
    row2.append(cell('Тип', typeSel), cell('Категория', catWrap));
    f.appendChild(row2);
    const hostWrap = el('div', 'db-group');
    const host2 = inp(c.host || '', 'localhost'); const port = inp(c.port || DB_DEF_PORT[c.type] || '', '5432', 'number');
    const user = inp(c.user || '', 'пользователь'); const pass = inp('', existing ? '(без изменений)' : 'пароль', 'password');
    const database = inp(c.database || '', 'имя базы (опц.)');
    const ssl = el('input'); ssl.type = 'checkbox'; ssl.checked = !!c.ssl;
    const sslIns = el('input'); sslIns.type = 'checkbox'; sslIns.checked = !!c.sslInsecure;
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, lbl)); w.appendChild(node); return w; };
    const sslLabel = (() => { const w = el('label', 'db-check'); w.append(ssl, document.createTextNode(' Использовать SSL/TLS')); return w; })();
    const sslInsLabel = (() => { const w = el('label', 'db-check db-check-warn'); w.append(sslIns, document.createTextNode(' Доверять самоподписанному сертификату (небезопасно)')); return w; })();
    ssl.onchange = () => { sslInsLabel.style.display = ssl.checked ? '' : 'none'; };
    hostWrap.append(mk('Хост', host2), mk('Порт', port), mk('Пользователь', user), mk('Пароль', pass), mk('База', database), sslLabel, sslInsLabel);
    f.appendChild(hostWrap);
    const sqliteWrap = el('div', 'db-group');
    const file = inp(c.file || c.database || '', '/путь/к/базе.sqlite');
    sqliteWrap.append(mk('Файл БД', file));
    f.appendChild(sqliteWrap);
    const sshOn = el('input'); sshOn.type = 'checkbox'; sshOn.checked = !!c.sshEnabled;
    const sshLabel = el('label', 'db-check'); sshLabel.append(sshOn, document.createTextNode(' Подключаться через SSH-туннель'));
    f.appendChild(sshLabel);
    const sshWrap = el('div', 'db-group');
    const sshHost = inp(c.sshHost || '', 'ssh-хост'); const sshPort = inp(c.sshPort || 22, '22', 'number');
    const sshUser = inp(c.sshUser || '', 'ssh-пользователь'); const sshPass = inp('', existing ? '(без изменений)' : 'пароль/passphrase', 'password');
    sshWrap.append(mk('SSH хост', sshHost), mk('SSH порт', sshPort), mk('SSH пользователь', sshUser), mk('SSH пароль', sshPass));
    f.appendChild(sshWrap);
    const ro = el('input'); ro.type = 'checkbox'; ro.checked = !!c.readOnly;
    const roLabel = el('label', 'db-check'); roLabel.append(ro, document.createTextNode(' Только чтение (запрет изменяющих запросов)'));
    f.appendChild(roLabel);
    // environment colour + production flag
    const colorSel = el('select');
    for (const [v, lbl] of [['', 'без цвета'], ['#e5484d', '🔴 красный (prod)'], ['#f5a623', '🟠 янтарный (stage)'], ['#30a46c', '🟢 зелёный (dev)'], ['#0091ff', '🔵 синий'], ['#8e4ec6', '🟣 фиолетовый']]) { const o = document.createElement('option'); o.value = v; o.textContent = lbl; if ((c.color || '') === v) o.selected = true; colorSel.appendChild(o); }
    field('Цвет окружения', colorSel);
    const prod = el('input'); prod.type = 'checkbox'; prod.checked = !!c.isProd;
    const prodLabel = el('label', 'db-check db-check-warn'); prodLabel.append(prod, document.createTextNode(' PRODUCTION — предупреждать перед изменяющими запросами'));
    f.appendChild(prodLabel);
    const syncType = () => {
      const t = typeSel.value;
      hostWrap.style.display = t === 'sqlite' ? 'none' : '';
      sqliteWrap.style.display = t === 'sqlite' ? '' : 'none';
      sshLabel.style.display = t === 'sqlite' ? 'none' : '';
      sshWrap.style.display = (t !== 'sqlite' && sshOn.checked) ? '' : 'none';
      sslInsLabel.style.display = (t !== 'sqlite' && ssl.checked) ? '' : 'none';
    };
    const DEF_PORTS = new Set(Object.values(DB_DEF_PORT).filter(Boolean));
    typeSel.onchange = () => { if (!port.value || DEF_PORTS.has(+port.value)) port.value = DB_DEF_PORT[typeSel.value] || ''; syncType(); };
    sshOn.onchange = syncType; syncType();
    const collect = () => {
      const o = { id: c.id, name: name.value.trim(), type: typeSel.value, category: getCategory(), readOnly: ro.checked, color: colorSel.value, isProd: prod.checked };
      if (typeSel.value === 'sqlite') { o.file = file.value.trim(); o.database = o.file; }
      else { o.host = host2.value.trim(); o.port = +port.value || DB_DEF_PORT[typeSel.value]; o.user = user.value.trim(); o.database = database.value.trim(); o.ssl = ssl.checked; o.sslInsecure = sslIns.checked; o.sshEnabled = sshOn.checked; o.sshHost = sshHost.value.trim(); o.sshPort = +sshPort.value || 22; o.sshUser = sshUser.value.trim(); if (sshPass.value) o.sshPassword = sshPass.value; }
      if (pass.value) o.password = pass.value;
      return o;
    };
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const test = el('button', 'btn', 'Тест');
    test.onclick = async () => { status.textContent = 'Проверяю…'; status.className = 'db-test-status'; const r = await lite.db.test(collect()); if (r.ok) { status.textContent = '✓ ' + (r.version || 'подключение успешно'); status.classList.add('ok'); } else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); } };
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => { const o = collect(); if (!o.name) { toast('Введи имя', { kind: 'err' }); return; } const r = await lite.db.save(o); if (r && r.error) { toast(r.error, { kind: 'err' }); return; } close(); renderDbPanel(); };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
  }

  // ============================================================ workspace (IDE layout)
  async function renderDbWorkspace(body) {
    body.innerHTML = '';
    const ide = el('div', 'db-ide');
    // --- sidebar ---
    const side = el('div', 'db-side'); side.style.flexBasis = (dbUi.sideW || 240) + 'px';
    const head = el('div', 'db-ws-head');
    if (dbActiveConn.color) head.style.borderBottom = `2px solid ${dbActiveConn.color}`;
    const back = iconBtn('drow-act', 'chevron-left', 'К подключениям', 16);
    back.onclick = () => { dbActiveId = null; dbActiveConn = null; dbSchema = null; tabs = []; activeKey = null; dbDispose(); renderDbPanel(); };
    const statusDot = el('span', 'db-status-dot'); statusDot.title = 'Проверка соединения…';
    head.append(back, statusDot, icon('database', 15), el('span', 'db-ws-name', dbActiveConn.name));
    if (dbActiveConn.readOnly) head.appendChild(el('span', 'db-ro-badge', 'RO'));
    if (dbActiveConn.isProd) head.appendChild(el('span', 'db-prod-badge', 'PROD'));
    side.appendChild(head);
    const pingNow = () => { statusDot.className = 'db-status-dot'; lite.db.ping(dbActiveId).then((r) => { if (r && r.ok) { statusDot.classList.add('ok'); statusDot.title = 'Соединение активно'; } else { statusDot.classList.add('err'); statusDot.title = 'Нет соединения: ' + ((r && r.error) || '') + ' — клик для переподключения'; } }); };
    statusDot.onclick = async () => { statusDot.className = 'db-status-dot'; statusDot.title = 'Переподключение…'; const r = await lite.db.reconnect(dbActiveId); if (r && r.ok) { toast('Переподключено'); dbSchema = null; dbColsCache = null; dbObjectsCache = null; metaCache.clear(); invalidateTableCaches(); pingNow(); renderDbWorkspace(body); } else { statusDot.classList.add('err'); toast((r && r.error) || 'Не удалось', { kind: 'err' }); } };
    pingNow();
    const tools = el('div', 'db-side-tools');
    const tNewSql = iconBtn('drow-act', 'terminal', 'Новый SQL-запрос', 15); tNewSql.onclick = () => openSqlTab();
    const tEr = iconBtn('drow-act', 'graph', 'ER-диаграмма', 15); tEr.onclick = () => openErTab();
    const tQb = iconBtn('drow-act', 'filter', 'Конструктор запроса', 15); tQb.onclick = () => openBuilderTab();
    const tDiff = iconBtn('drow-act', 'diff', 'Сравнить схемы', 15); tDiff.onclick = () => openDiffTab();
    const tRefresh = iconBtn('drow-act', 'refresh', 'Обновить схему (дерево объектов)', 15); tRefresh.onclick = () => { dbSchema = null; dbColsCache = null; dbObjectsCache = null; metaCache.clear(); dbRelationsCache = null; invalidateTableCaches(); renderDbWorkspace(body); };
    tools.append(tNewSql, tEr, tQb, tDiff, tRefresh);
    side.appendChild(tools);
    const search = el('input', 'db-tree-search'); search.placeholder = 'Поиск объекта…'; search.value = dbUi.treeSearch || '';
    side.appendChild(search);
    const tree = el('div', 'db-tree'); side.appendChild(tree);
    // --- gutter ---
    const gut = el('div', 'db-side-gutter');
    // --- main: outer-level tabs (Рабочий стол / AI-DB), shared tree on the left ---
    const main = el('div', 'db-main');
    const wsTabs = el('div', 'db-ws-tabs');
    const deskBtn = el('button', 'db-ws-tab'); deskBtn.append(icon('columns', 14), el('span', null, 'Рабочий стол'));
    const aiBtn = el('button', 'db-ws-tab'); aiBtn.append(icon('sparkles', 14), el('span', null, 'AI-DB'));
    wsTabs.append(deskBtn, aiBtn); main.appendChild(wsTabs);
    const deskWrap = el('div', 'db-ws-view');
    const tabbar = el('div', 'db-tabbar'); tabbar.id = 'db-tabbar'; deskWrap.appendChild(tabbar);
    const tabbody = el('div', 'db-tabbody'); tabbody.id = 'db-tabbody'; deskWrap.appendChild(tabbody);
    const aiWrap = el('div', 'db-ws-view db-ai-view hidden'); aiWrap.id = 'db-ai-view';
    main.append(deskWrap, aiWrap);
    ide.append(side, gut, main);
    body.appendChild(ide);

    const setWsView = (v) => {
      wsView = v;
      deskBtn.classList.toggle('on', v === 'desk'); aiBtn.classList.toggle('on', v === 'ai');
      deskWrap.classList.toggle('hidden', v !== 'desk'); aiWrap.classList.toggle('hidden', v !== 'ai');
      if (v === 'ai') { stopAutoRef(); renderAiChat(aiWrap); } else startAutoRef();
    };
    deskBtn.onclick = () => setWsView('desk'); aiBtn.onclick = () => setWsView('ai');
    setWsViewFn = setWsView;

    sidebarGutter(gut, side);
    search.oninput = () => { dbUi.treeSearch = search.value; renderTree(tree, search.value.trim().toLowerCase()); };

    const seq = ++dbRenderSeq;
    if (!dbSchema) {
      tree.innerHTML = '<div class="git-loading">Чтение схемы…</div>';
      const r = await lite.db.schema(dbActiveId);
      if (seq !== dbRenderSeq) return;
      if (r.error) { tree.innerHTML = ''; tree.appendChild(el('div', 'docker-err', r.error)); return; }
      dbSchema = r;
      lite.db.columns(dbActiveId).then((cr) => { if (cr && !cr.error) { dbColsCache = cr.columns || {}; refreshOpenSqlSchemas(); } });
      lite.db.objects(dbActiveId).then((o) => { if (o && !o.error) { dbObjectsCache = o; const tr = $('#db-tree-root') || tree; renderTree(tr, (dbUi.treeSearch || '').trim().toLowerCase()); } });
    }
    tree.id = 'db-tree-root';
    renderTree(tree, (search.value || '').trim().toLowerCase());
    renderTabBar(tabbar, tabbody);
    renderTabBody(tabbody);
    startAutoRef();
    setWsView(wsView || 'desk');
  }

  function sidebarGutter(gut, side) {
    gut.onmousedown = (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = side.getBoundingClientRect().width;
      const move = (ev) => { const w = Math.max(160, Math.min(520, startW + ev.clientX - startX)); side.style.flexBasis = w + 'px'; dbUi.sideW = w; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); saveDbUi(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    };
  }

  // ---- tree (schema → folders → tables → columns)
  function renderTree(tree, filter) {
    tree.innerHTML = '';
    if (!dbSchema || !dbSchema.schemas || !dbSchema.schemas.length) { tree.appendChild(el('div', 'docker-empty', 'Нет таблиц.')); return; }
    for (const sch of dbSchema.schemas) {
      const tables = sch.tables.filter((t) => !t.view);
      const views = sch.tables.filter((t) => t.view);
      const matchT = (arr) => filter ? arr.filter((t) => t.name.toLowerCase().includes(filter)) : arr;
      const ft = matchT(tables), fv = matchT(views);
      if (filter && !ft.length && !fv.length) continue;
      tree.appendChild(schemaBlock(sch, ft, fv, !!filter));
    }
    highlightTreeActive();
  }
  function schemaBlock(sch, tables, views, forceOpen) {
    const block = el('div', 'db-tree-sch');
    const k = dbActiveId + ':' + sch.name;
    const open = forceOpen || !(dbUi.treeOpen && dbUi.treeOpen[k] === false);
    const head = el('button', 'db-tree-schhead');
    const chev = icon(open ? 'chevron-down' : 'chevron-right', 12); chev.classList.add('dsec-chev');
    head.append(chev, icon('layers', 13), el('span', 'dsec-title', sch.name), el('span', 'dsec-count', String(tables.length + views.length)));
    const list = el('div', 'db-tree-schbody'); if (!open) list.style.display = 'none';
    if (tables.length) list.appendChild(folder('Таблицы', 'box', sch, tables));
    if (views.length) list.appendChild(folder('Представления', 'eye', sch, views));
    if (dbObjectsCache) {
      const fns = (dbObjectsCache.functions || []).filter((o) => o.schema === sch.name);
      const seqs = (dbObjectsCache.sequences || []).filter((o) => o.schema === sch.name);
      if (fns.length) list.appendChild(objectFolder('Функции', 'braces', sch, fns.map((o) => ({ name: o.name, kind: o.kind }))));
      if (seqs.length) list.appendChild(objectFolder('Секвенции', 'flag', sch, seqs.map((o) => ({ name: o.name, kind: 'sequence' }))));
    }
    head.onclick = () => {
      dbUi.treeOpen = dbUi.treeOpen || {}; const cur = !(dbUi.treeOpen[k] === false); dbUi.treeOpen[k] = !cur; saveDbUi();
      list.style.display = dbUi.treeOpen[k] ? '' : 'none';
      const nc = icon(dbUi.treeOpen[k] ? 'chevron-down' : 'chevron-right', 12); nc.classList.add('dsec-chev'); head.replaceChild(nc, head.firstChild);
    };
    block.append(head, list);
    return block;
  }
  function folder(label, ic, sch, items) {
    const wrap = el('div', 'db-tree-folder');
    const head = el('button', 'db-tree-folderhead');
    let open = true;
    const chev = icon('chevron-down', 11); chev.classList.add('dsec-chev');
    head.append(chev, icon(ic, 12), el('span', 'db-folder-name', label), el('span', 'dsec-count', String(items.length)));
    const list = el('div', 'db-tree-folderbody');
    for (const t of items) list.appendChild(tableNode(sch, t, ic));
    head.onclick = () => { open = !open; list.style.display = open ? '' : 'none'; const nc = icon(open ? 'chevron-down' : 'chevron-right', 11); nc.classList.add('dsec-chev'); head.replaceChild(nc, head.firstChild); };
    wrap.append(head, list);
    return wrap;
  }
  function tableNode(sch, t, ic) {
    const node = el('div', 'db-tree-tablewrap');
    const row = el('div', 'db-tree-table clickable'); row.dataset.tkey = (sch.name || '') + '.' + t.name;
    const exp = icon('chevron-right', 11); exp.classList.add('db-tcol-chev');
    const colsBox = el('div', 'db-tree-cols'); colsBox.style.display = 'none';
    let loaded = false;
    const toggleCols = async (e) => {
      e.stopPropagation();
      const showing = colsBox.style.display !== 'none';
      colsBox.style.display = showing ? 'none' : '';
      exp.classList.toggle('open', !showing);
      if (!showing && !loaded) { loaded = true; colsBox.innerHTML = '<div class="db-tcol-load">…</div>'; const meta = await getMeta(sch.name, t.name); colsBox.innerHTML = ''; if (meta.error) { colsBox.appendChild(el('div', 'docker-err', meta.error)); return; } for (const c of meta.columns) colsBox.appendChild(colRow(c)); }
    };
    exp.onclick = toggleCols;
    row.append(exp, icon(t.view ? 'eye' : ic, 12), el('span', 'db-table-name', t.name));
    if (!t.view && dbObjectsCache && dbObjectsCache.rowEstimates) { const est = dbObjectsCache.rowEstimates[(sch.name ? sch.name + '.' : '') + t.name]; if (est != null && est >= 0) row.appendChild(el('span', 'db-tree-est', humanCount(est))); }
    row.onclick = () => openTableTab(sch.name, t.name, !!t.view);
    row.oncontextmenu = (e) => { e.preventDefault(); tableMenu(e, sch.name, t.name); };
    node.append(row, colsBox);
    return node;
  }
  function objectFolder(label, ic, sch, items) {
    const wrap = el('div', 'db-tree-folder');
    const head = el('button', 'db-tree-folderhead'); let open = false;
    const chev = icon('chevron-right', 11); chev.classList.add('dsec-chev');
    head.append(chev, icon(ic, 12), el('span', 'db-folder-name', label), el('span', 'dsec-count', String(items.length)));
    const list = el('div', 'db-tree-folderbody'); list.style.display = 'none';
    for (const o of items) { const r = el('div', 'db-tree-table clickable'); r.append(icon(ic, 12), el('span', 'db-table-name', o.name)); r.onclick = () => openDdlTab(sch.name, o.name, o.kind); list.appendChild(r); }
    head.onclick = () => { open = !open; list.style.display = open ? '' : 'none'; const nc = icon(open ? 'chevron-down' : 'chevron-right', 11); nc.classList.add('dsec-chev'); head.replaceChild(nc, head.firstChild); };
    wrap.append(head, list);
    return wrap;
  }
  function humanCount(n) { if (n < 1000) return String(n); if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k'; return (n / 1e6).toFixed(1) + 'M'; }
  function humanBytes(n) { if (n == null) return '—'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; }
  function colRow(c) {
    const r = el('div', 'db-tree-col');
    const badge = c.pk ? '🔑' : c.fk ? '↗' : '';
    if (badge) r.appendChild(el('span', 'db-col-badge', badge));
    else r.appendChild(el('span', 'db-col-badge dim', c.nullable ? '' : '•'));
    r.appendChild(el('span', 'db-col-name', c.name));
    r.appendChild(el('span', 'db-col-type', c.type));
    if (c.fk) r.title = `FK → ${c.fk.table}.${c.fk.column}`;
    return r;
  }

  async function getMeta(schema, table) {
    const key = (schema ? schema + '.' : '') + table;
    if (metaCache.has(key)) return metaCache.get(key);
    const m = await lite.db.tableMeta(dbActiveId, schema, table);
    if (!m.error) metaCache.set(key, m);
    return m;
  }

  // ============================================================ tabs
  function tabKeyTable(schema, table) { return 'tbl:' + (schema || '') + '.' + table; }
  function findTab(key) { return tabs.find((t) => t.key === key); }
  function activate(key) { if (wsView === 'ai' && setWsViewFn) setWsViewFn('desk'); activeKey = key; const body = $('#db-tabbody'); const bar = $('#db-tabbar'); if (bar) renderTabBar(bar, body); if (body) renderTabBody(body); highlightTreeActive(); }
  // mark the tree row matching the active table tab (visual aid)
  function highlightTreeActive() {
    const tree = $('#db-tree-root'); if (!tree) return;
    const t = findTab(activeKey);
    const key = (t && t.kind === 'table') ? (t.schema || '') + '.' + t.table : null;
    tree.querySelectorAll('.db-tree-table.active').forEach((r) => r.classList.remove('active'));
    if (key) { const row = tree.querySelector(`.db-tree-table[data-tkey="${(window.CSS && CSS.escape) ? CSS.escape(key) : key}"]`); if (row) row.classList.add('active'); }
  }
  function closeTab(key) {
    const i = tabs.findIndex((t) => t.key === key); if (i < 0) return;
    if (tabs[i].editor) { try { tabs[i].editor.destroy(); } catch (_) {} }
    tabs.splice(i, 1);
    if (activeKey === key) activeKey = tabs.length ? tabs[Math.max(0, i - 1)].key : null;
    const body = $('#db-tabbody'); renderTabBar($('#db-tabbar'), body); renderTabBody(body);
  }
  function openTableTab(schema, table, view) {
    const key = tabKeyTable(schema, table);
    if (!findTab(key)) tabs.push({ key, kind: 'table', schema, table, view, title: table, page: 0, orderBy: null, orderDir: 'asc', where: '', mode: 'data' });
    recordNav(key); activate(key);
  }
  // open a table filtered by a predicate (used by FK navigation)
  function openTableFiltered(schema, table, whereSql) {
    const key = tabKeyTable(schema, table);
    let t = findTab(key);
    if (!t) { t = { key, kind: 'table', schema, table, view: false, title: table, page: 0, orderBy: null, orderDir: 'asc', where: whereSql, mode: 'data' }; tabs.push(t); }
    else { t.where = whereSql; t.page = 0; if (pendingCount(t)) clearBuffer(t); }
    recordNav(key); activate(key);
  }
  // browser-like back/forward across table navigations
  let navStack = [], navPtr = -1, navLock = false;
  function recordNav(key) { if (navLock) return; navStack = navStack.slice(0, navPtr + 1); if (navStack[navPtr] !== key) { navStack.push(key); navPtr = navStack.length - 1; } }
  function navGo(delta) { const p = navPtr + delta; if (p < 0 || p >= navStack.length) return; navPtr = p; navLock = true; if (findTab(navStack[p])) activate(navStack[p]); navLock = false; }
  let dbRelationsCache = null;
  async function getRelations() { if (!dbRelationsCache) { const r = await lite.db.relations(dbActiveId); dbRelationsCache = (r && r.relations) || []; } return dbRelationsCache; }
  function openSqlTab(initialSql) {
    const key = 'sql:' + (++sqlSeq); tabs.push({ key, kind: 'sql', title: 'Запрос ' + sqlSeq, sql: initialSql || '' }); activate(key);
  }
  function openErTab() { const key = 'er'; if (!findTab(key)) tabs.push({ key, kind: 'er', title: 'ER-диаграмма' }); activate(key); }
  function openBuilderTab() { const key = 'qb:' + (++sqlSeq); tabs.push({ key, kind: 'qbuilder', title: 'Конструктор' }); activate(key); }
  function openDiffTab() { const key = 'diff'; if (!findTab(key)) tabs.push({ key, kind: 'diff', title: 'Сравнение' }); activate(key); }
  function openDdlTab(schema, table, objKind) { const key = 'ddl:' + (objKind || '') + ':' + (schema || '') + '.' + table; if (!findTab(key)) tabs.push({ key, kind: 'ddl', schema, table, objKind, title: 'DDL: ' + table }); activate(key); }

  function renderTabBar(bar, body) {
    if (!bar) return; bar.innerHTML = '';
    if (!tabs.length) { bar.appendChild(el('span', 'db-tab-empty', 'Откройте таблицу в дереве или создайте SQL-запрос')); return; }
    for (const t of tabs) {
      const tab = el('div', 'db-tab' + (t.key === activeKey ? ' on' : ''));
      const kindIc = t.kind === 'sql' ? 'terminal' : t.kind === 'er' ? 'graph' : t.kind === 'diff' ? 'diff' : t.kind === 'qbuilder' ? 'filter' : t.kind === 'ddl' ? 'file' : (t.view ? 'eye' : 'box');
      tab.append(icon(kindIc, 12), el('span', 'db-tab-title', t.title));
      const x = iconBtn('db-tab-x', 'x', 'Закрыть', 11); x.onclick = (e) => { e.stopPropagation(); closeTab(t.key); };
      tab.appendChild(x);
      tab.onclick = () => { if (t.key !== activeKey) activate(t.key); };
      bar.appendChild(tab);
    }
  }
  function renderTabBody(body) {
    if (!body) return; body.innerHTML = '';
    saveSession();
    const t = findTab(activeKey);
    if (!t) { body.appendChild(el('div', 'db-tab-empty-body', 'Нет открытых вкладок')); return; }
    if (t.kind === 'table') renderTableTab(body, t);
    else if (t.kind === 'sql') renderSqlTab(body, t);
    else if (t.kind === 'ddl') renderDdlTab(body, t);
    else if (t.kind === 'er') renderErTab(body, t);
    else if (t.kind === 'qbuilder') renderBuilderTab(body, t);
    else if (t.kind === 'diff') renderDiffTab(body, t);
  }
  function destroyAllEditors() { for (const t of tabs) if (t.editor) { try { t.editor.destroy(); } catch (_) {} t.editor = null; } }
  function refreshOpenSqlSchemas() { /* schema arrives async; re-render active SQL tab to enable autocomplete */ const t = findTab(activeKey); if (t && t.kind === 'sql') renderTabBody($('#db-tabbody')); }

  // ============================================================ TABLE tab (data / structure / ddl)
  async function renderTableTab(body, t) {
    const bar = el('div', 'db-tablebar');
    const modes = el('div', 'db-modes');
    for (const [k, lbl] of [['data', 'Данные'], ['structure', 'Структура']]) {
      const b = el('button', 'db-mode' + (t.mode === k ? ' on' : '')); b.textContent = lbl; b.onclick = () => { if (t.mode !== k) { t.mode = k; renderTabBody($('#db-tabbody')); } }; modes.appendChild(b);
    }
    const ddlBtn = el('button', 'db-mode'); ddlBtn.textContent = 'DDL'; ddlBtn.onclick = () => openDdlTab(t.schema, t.table); modes.appendChild(ddlBtn);
    const nav = el('div', 'db-nav');
    const navB = iconBtn('drow-act', 'chevron-left', 'Назад (история переходов)', 14); navB.disabled = navPtr <= 0; navB.onclick = () => navGo(-1);
    const navF = iconBtn('drow-act', 'chevron-right', 'Вперёд', 14); navF.disabled = navPtr >= navStack.length - 1; navF.onclick = () => navGo(1);
    nav.append(navB, navF); bar.appendChild(nav);
    bar.appendChild(modes);
    bar.appendChild(el('span', 'db-table-title', t.table));
    if (t.mode !== 'structure') {
      const colsBtn = iconBtn('drow-act', 'columns', 'Столбцы (скрыть/показать, порядок)', 14); colsBtn.onclick = (e) => openColumnsMenu(e, t);
      const chart = iconBtn('drow-act', 'graph', 'График', 14); chart.onclick = () => { if (t.lastResult) openChart(t.lastResult.columns, t.lastResult.colTypes, t.lastResult.rows); };
      const exp = iconBtn('drow-act', 'download', 'Экспорт / копирование таблицы', 14); exp.onclick = () => exportTable(t);
      bar.append(colsBtn, chart, exp, autoRefWidget(t));   // single (merged) refresh control lives here
    } else {
      const chart = iconBtn('drow-act', 'graph', 'График', 14); chart.onclick = () => { if (t.lastResult) openChart(t.lastResult.columns, t.lastResult.colTypes, t.lastResult.rows); };
      bar.append(chart);
    }
    body.appendChild(bar);

    if (t.mode === 'structure') { renderStructure(body, t); return; }

    t.buffer = t.buffer || { edits: {}, deletes: new Set(), inserts: [] };
    // any pending change blocks a reload that would silently drop it
    const guard = (fn) => { if (pendingCount(t)) { showConfirm('Отменить правки?', `Несохранённых изменений: ${pendingCount(t)}. Перезагрузка их сбросит.`, 'Отменить правки', () => { clearBuffer(t); fn(); }); } else fn(); };

    // filter bar
    const fbar = el('div', 'db-filterbar');
    fbar.appendChild(el('span', 'db-filter-label', 'WHERE'));
    const fin = el('input', 'db-filter-input'); fin.placeholder = 'например: amount > 5 AND staff_id = 1'; fin.value = t.where || '';
    const applyF = () => guard(() => { t.where = fin.value.trim(); t.page = 0; renderTabBody($('#db-tabbody')); });
    fin.onkeydown = (e) => { if (e.key === 'Enter') applyF(); };
    const fapply = el('button', 'btn db-filter-go', 'Применить'); fapply.onclick = applyF;
    const fclear = iconBtn('drow-act', 'x', 'Сбросить фильтр', 13); fclear.onclick = () => guard(() => { fin.value = ''; t.where = ''; t.page = 0; renderTabBody($('#db-tabbody')); });
    fbar.append(fin, fapply, fclear);
    body.appendChild(fbar);

    const changesHost = el('div', 'db-changes-host'); body.appendChild(changesHost);
    const gridWrap = el('div', 'db-grid-host'); body.appendChild(gridWrap);
    const pager = el('div', 'db-pager'); body.appendChild(pager);

    // local cache: a plain tab switch reuses t.lastResult; a genuine param change (page/sort/filter),
    // the Обновить button, or the auto-refresh timer set t._force to re-query the backend.
    const dataKey = JSON.stringify({ p: t.page, ob: t.orderBy, od: t.orderDir, w: t.where || '' });
    const useCache = !t._force && t.lastResult && !t.lastResult.error && t._dataKey === dataKey;
    let r;
    if (useCache) { r = t.lastResult; }
    else {
      gridWrap.innerHTML = '<div class="git-loading">Загрузка…</div>';
      const seq = ++dbRenderSeq;
      r = await lite.db.tableData(dbActiveId, t.schema, t.table, { limit: DB_PAGE, offset: t.page * DB_PAGE, orderBy: t.orderBy, orderDir: t.orderDir, where: t.where });
      if (seq !== dbRenderSeq) return;
      gridWrap.innerHTML = '';
      if (r.error) { gridWrap.appendChild(el('div', 'docker-err', r.error)); return; }
      t.lastResult = r; t._dataKey = dataKey;
    }
    t._force = false;
    gridWrap.innerHTML = '';
    const meta = metaCache.get((t.schema ? t.schema + '.' : '') + t.table) || await getMeta(t.schema, t.table);
    const editable = !dbActiveConn.readOnly && !t.view && meta && !meta.error && meta.columns.some((c) => c.pk);
    const pkNames = (meta && meta.columns ? meta.columns.filter((c) => c.pk).map((c) => c.name) : []);
    // column order / visibility / widths persisted per tab by NAME → resolve to indices for the grid
    const colMap = colStateForGrid(t, r.columns);
    const grid = makeGrid({
      columns: r.columns, colTypes: r.colTypes, rows: r.rows,
      colOrder: colMap.order, hiddenCols: colMap.hidden, colWidths: colMap.widths,
      onColWidth: (ci, px) => { t.colW = t.colW || {}; if (px == null) delete t.colW[r.columns[ci]]; else t.colW[r.columns[ci]] = px; },
      sortState: t.orderBy ? { col: t.orderBy, dir: t.orderDir } : null,
      onSort: (col) => guard(() => { if (t.orderBy === col) t.orderDir = t.orderDir === 'asc' ? 'desc' : 'asc'; else { t.orderBy = col; t.orderDir = 'asc'; } t.page = 0; renderTabBody($('#db-tabbody')); }),
      meta, editable, buffer: editable ? t.buffer : null, pkNames,
      fkCols: new Set((meta && meta.columns ? meta.columns.filter((c) => c.fk).map((c) => c.name) : [])),
      onBufferChange: () => renderChangesBar(t, meta, changesHost),
      onSelStats: (st) => { selFoot.textContent = fmtStats(st); selFoot.classList.toggle('on', !!st); },
      onHeaderMenu: (ev, colName) => headerMenu(ev, colName, t, meta),
      onCellMenu: (e, val, colName, rowValues, ri) => cellMenu(e, val, colName, rowValues, t, r.columns, ri, meta),
    });
    gridWrap.appendChild(grid.element);
    const selFoot = el('div', 'db-selfoot'); body.appendChild(selFoot);
    if (editable) { const addb = iconBtn('drow-act', 'plus', 'Добавить строку', 14); addb.onclick = () => grid.addInsertRow(); bar.append(addb); }
    renderChangesBar(t, meta, changesHost);

    const totalNum = r.total != null && !Number.isNaN(r.total) ? r.total : null;
    pager.appendChild(el('span', 'db-pageinfo', `${r.rows.length ? t.page * DB_PAGE + 1 : 0}–${t.page * DB_PAGE + r.rows.length} из ${totalNum != null ? totalNum : '?'}`));
    const prev = iconBtn('drow-act', 'chevron-left', 'Назад', 13); prev.disabled = t.page <= 0; prev.onclick = () => guard(() => { if (t.page > 0) { t.page--; renderTabBody($('#db-tabbody')); } });
    const next = iconBtn('drow-act', 'chevron-right', 'Вперёд', 13);
    next.disabled = r.rows.length < DB_PAGE || (totalNum != null && (t.page + 1) * DB_PAGE >= totalNum);
    next.onclick = () => guard(() => { t.page++; renderTabBody($('#db-tabbody')); });
    pager.append(prev, next);
    if (t.where) pager.appendChild(el('span', 'db-pager-note', 'фильтр активен'));
    const hiddenN = t.hidden ? t.hidden.size : 0;
    if (hiddenN) pager.appendChild(el('span', 'db-pager-note2', `скрыто колонок: ${hiddenN}`));
  }

  // ---- merged refresh + auto-refresh interval control (DataGrip-style)
  function autoRefWidget(t) {
    const wrap = el('div', 'db-autoref');
    const refr = iconBtn('drow-act', 'refresh', 'Обновить данные', 14); refr.onclick = () => { t._force = true; renderTabBody($('#db-tabbody')); };
    const intBtn = el('button', 'db-autoref-int' + (autoRefSec > 0 ? ' on' : ''));
    intBtn.append(icon(autoRefSec > 0 ? 'clock' : 'clock', 12), el('span', null, autoRefSec > 0 ? fmtInterval(autoRefSec) : 'авто'));
    intBtn.title = 'Автообновление таблицы';
    const PRESETS = [5, 10, 30, 60, 300];
    const pick = (s) => { setAutoRef(s); renderTabBody($('#db-tabbody')); };
    intBtn.onclick = (e) => {
      e.stopPropagation();
      const items = [
        { label: (autoRefSec <= 0 ? '✓ ' : '') + 'Пауза / выкл', action: () => pick(0) },
        { sep: true },
        ...PRESETS.map((s) => ({ label: (autoRefSec === s ? '✓ ' : '') + fmtInterval(s), action: () => pick(s) })),
        { sep: true },
        { label: 'Свой интервал…', action: () => showPrompt('Автообновление', 'Интервал в секундах:', String(autoRefSec || 15), (val) => { const s = Math.max(1, Math.round(+val || 0)); if (s) pick(s); }) },
      ];
      showMenu(e.clientX, e.clientY, items);
    };
    wrap.append(refr, intBtn);
    return wrap;
  }

  // ---- per-tab column order / visibility / widths (stored by name) → grid indices
  function colStateForGrid(t, columns) {
    const idx = new Map(columns.map((c, i) => [c, i]));
    let order = (t.colOrder && t.colOrder.length ? t.colOrder.filter((n) => idx.has(n)).map((n) => idx.get(n)) : columns.map((_, i) => i));
    for (let i = 0; i < columns.length; i++) if (!order.includes(i)) order.push(i);
    const hidden = new Set([...(t.hidden || [])].map((n) => idx.get(n)).filter((i) => i != null));
    const widths = {}; if (t.colW) for (const [n, px] of Object.entries(t.colW)) if (idx.has(n)) widths[idx.get(n)] = px;
    return { order, hidden, widths };
  }
  function openColumnsMenu(e, t) {
    const cols = (t.lastResult && t.lastResult.columns) || [];
    if (!cols.length) { toast('Нет данных'); return; }
    t.hidden = t.hidden instanceof Set ? t.hidden : new Set(t.hidden || []);
    t.colOrder = (t.colOrder && t.colOrder.length ? t.colOrder.filter((n) => cols.includes(n)) : cols.slice());
    for (const c of cols) if (!t.colOrder.includes(c)) t.colOrder.push(c);
    const { m, close } = makeModal('<h2>Столбцы</h2>'); m.classList.add('db-modal');
    const hint = el('div', 'db-cols-hint', 'Галочка — показать колонку. Стрелками или перетаскиванием меняйте порядок.');
    m.appendChild(hint);
    const list = el('div', 'db-cols-list');
    const rebuild = () => {
      list.innerHTML = '';
      t.colOrder.forEach((name, pos) => {
        const row = el('div', 'db-cols-row'); row.draggable = true; row.dataset.pos = pos;
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = !t.hidden.has(name);
        cb.onchange = () => { if (cb.checked) t.hidden.delete(name); else t.hidden.add(name); };
        const up = iconBtn('drow-act', 'chevron-up', 'Выше', 12); up.disabled = pos === 0; up.onclick = () => { if (pos > 0) { const a = t.colOrder; [a[pos - 1], a[pos]] = [a[pos], a[pos - 1]]; rebuild(); } };
        const down = iconBtn('drow-act', 'chevron-down', 'Ниже', 12); down.disabled = pos === t.colOrder.length - 1; down.onclick = () => { const a = t.colOrder; if (pos < a.length - 1) { [a[pos + 1], a[pos]] = [a[pos], a[pos + 1]]; rebuild(); } };
        row.append(cb, el('span', 'db-cols-name', name), up, down);
        row.ondragstart = (ev) => { ev.dataTransfer.setData('text/plain', String(pos)); row.classList.add('drag'); };
        row.ondragend = () => row.classList.remove('drag');
        row.ondragover = (ev) => { ev.preventDefault(); row.classList.add('over'); };
        row.ondragleave = () => row.classList.remove('over');
        row.ondrop = (ev) => { ev.preventDefault(); row.classList.remove('over'); const from = +ev.dataTransfer.getData('text/plain'); const to = pos; if (from !== to) { const a = t.colOrder; const [it] = a.splice(from, 1); a.splice(to, 0, it); rebuild(); } };
        list.appendChild(row);
      });
    };
    rebuild();
    m.appendChild(list);
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '12px';
    const showAll = el('button', 'btn', 'Показать все'); showAll.onclick = () => { t.hidden.clear(); rebuild(); };
    const reset = el('button', 'btn', 'Сбросить порядок'); reset.onclick = () => { t.colOrder = cols.slice(); rebuild(); };
    const apply = el('button', 'btn primary', 'Применить'); apply.onclick = () => { close(); renderTabBody($('#db-tabbody')); };
    acts.append(showAll, reset, apply); m.appendChild(acts);
  }

  // ---- edit buffer: pending edits / deletes / inserts → transactional commit
  function pendingCount(t) { const b = t.buffer; if (!b) return 0; return Object.keys(b.edits).length + b.deletes.size + b.inserts.filter((o) => Object.keys(o).length).length; }
  function clearBuffer(t) { t.buffer = { edits: {}, deletes: new Set(), inserts: [] }; }
  // force every open table tab to re-query on its next render (after a commit / schema refresh)
  function invalidateTableCaches() { for (const t of tabs) if (t.kind === 'table') t._force = true; }
  function pkWhere(meta, rowValues, columns) {
    const pk = meta.columns.filter((c) => c.pk);
    return pk.map((c) => `${qIdent(c.name)} = ${lit(rowValues[columns.indexOf(c.name)])}`).join(' AND ');
  }
  function buildChangeStatements(t, meta) {
    const cols = t.lastResult.columns; const rows = t.lastResult.rows; const b = t.buffer; const out = [];
    for (const ri of Object.keys(b.edits)) {
      if (b.deletes.has(+ri)) continue; // deleted wins
      const set = Object.entries(b.edits[ri]).map(([col, val]) => `${qIdent(col)} = ${lit(val)}`).join(', ');
      if (set) out.push(`UPDATE ${qual(t.schema, t.table)} SET ${set} WHERE ${pkWhere(meta, rows[ri], cols)};`);
    }
    for (const ri of b.deletes) out.push(`DELETE FROM ${qual(t.schema, t.table)} WHERE ${pkWhere(meta, rows[ri], cols)};`);
    for (const obj of b.inserts) { const keys = Object.keys(obj); if (!keys.length) continue; out.push(`INSERT INTO ${qual(t.schema, t.table)} (${keys.map(qIdent).join(', ')}) VALUES (${keys.map((k) => lit(obj[k])).join(', ')});`); }
    return out;
  }
  function renderChangesBar(t, meta, hostEl) {
    hostEl.innerHTML = ''; const n = pendingCount(t); if (!n) return;
    const bar = el('div', 'db-changes');
    bar.appendChild(el('span', 'db-changes-info', `Изменений: ${n}`));
    const prev = el('button', 'btn', 'Просмотр SQL'); prev.onclick = () => { const sql = buildChangeStatements(t, meta).join('\n'); const { m } = makeModal(`<h2>Изменения (SQL)</h2><pre class="db-ddl-pre" style="max-height:60vh">${sql.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`); m.classList.add('db-modal'); };
    const apply = el('button', 'btn primary', 'Применить'); apply.onclick = () => {
      const stmts = buildChangeStatements(t, meta); if (!stmts.length) return;
      const doApply = async () => { const r = await lite.db.transaction(dbActiveId, stmts); if (r && r.ok) { toast(`Применено: ${r.count}`); clearBuffer(t); t._force = true; renderTabBody($('#db-tabbody')); } else toast((r && r.error) || 'Ошибка применения', { kind: 'err' }); };
      prodGuard(stmts.join(' '), doApply);
    };
    const roll = el('button', 'btn', 'Откатить'); roll.onclick = () => { clearBuffer(t); renderTabBody($('#db-tabbody')); };
    bar.append(prev, apply, roll); hostEl.appendChild(bar);
  }

  async function renderStructure(body, t) {
    const host2 = el('div', 'db-struct'); body.appendChild(host2);
    host2.innerHTML = '<div class="git-loading">Чтение структуры…</div>';
    const meta = await getMeta(t.schema, t.table);
    host2.innerHTML = '';
    if (meta.error) { host2.appendChild(el('div', 'docker-err', meta.error)); return; }
    if (!t.view && !dbActiveConn.readOnly) { const edBar = el('div', 'db-ddl-bar'); const edBtn = el('button', 'btn', 'Изменить структуру…'); edBtn.onclick = () => tableEditor(t.schema, t.table); edBar.appendChild(edBtn); host2.appendChild(edBar); }
    if (!t.view) lite.db.objectInfo(dbActiveId, t.schema, t.table).then((inf) => { if (inf && !inf.error) { const line = el('div', 'db-struct-info'); const rows = inf.rows != null && inf.rows >= 0 ? humanCount(inf.rows) : '≈?'; line.textContent = `Размер: ${humanBytes(inf.size)}  ·  строк (оценка): ${rows}`; host2.insertBefore(line, host2.firstChild); } });
    const tbl = document.createElement('table'); tbl.className = 'db-struct-table';
    tbl.innerHTML = '<thead><tr><th>#</th><th>Колонка</th><th>Тип</th><th>NULL</th><th>Ключ</th><th>По умолчанию</th></tr></thead>';
    const tb = document.createElement('tbody');
    meta.columns.forEach((c, i) => {
      const tr = document.createElement('tr');
      const key = c.pk ? 'PK' : c.fk ? `FK → ${c.fk.table}.${c.fk.column}` : '';
      for (const v of [String(i + 1), c.name, c.type, c.nullable ? 'YES' : 'NOT NULL', key, c.default || '']) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); host2.appendChild(tbl);
    if (meta.indexes && meta.indexes.length) {
      host2.appendChild(el('h4', 'db-struct-h', 'Индексы'));
      const it = document.createElement('table'); it.className = 'db-struct-table';
      it.innerHTML = '<thead><tr><th>Имя</th><th>Уникальный</th><th>Колонки</th></tr></thead>';
      const itb = document.createElement('tbody');
      for (const ix of meta.indexes) { const tr = document.createElement('tr'); for (const v of [ix.name, ix.unique ? 'да' : '', ix.columns.join(', ')]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } itb.appendChild(tr); }
      it.appendChild(itb); host2.appendChild(it);
    }
  }

  async function renderDdlTab(body, t) {
    const wrap = el('div', 'db-ddl'); body.appendChild(wrap); wrap.innerHTML = '<div class="git-loading">…</div>';
    let ddl, err;
    if (t.objKind === 'function' || t.objKind === 'procedure' || t.objKind === 'sequence') { const r = await lite.db.objectDdl(dbActiveId, t.schema, t.table, t.objKind); if (r.error) err = r.error; else ddl = r.ddl; }
    else { const meta = await getMeta(t.schema, t.table); if (meta.error) err = meta.error; else ddl = meta.ddl; }
    wrap.innerHTML = '';
    if (err) { wrap.appendChild(el('div', 'docker-err', err)); return; }
    const bar = el('div', 'db-ddl-bar');
    const copy = el('button', 'btn', 'Копировать'); copy.onclick = () => { navigator.clipboard.writeText(ddl || ''); toast('DDL скопирован'); };
    bar.appendChild(copy); wrap.appendChild(bar);
    const pre = el('pre', 'db-ddl-pre'); pre.textContent = ddl || '(DDL недоступен)'; wrap.appendChild(pre);
  }

  // ============================================================ GRID (typed, sortable, resizable, selectable)
  function fmtVal(v) { if (v === null || v === undefined) return null; if (typeof v === 'object') return JSON.stringify(v); return String(v); }
  function paintCell(td, v) { const s = fmtVal(v); if (s === null) { td.textContent = 'NULL'; td.classList.add('db-null'); } else { td.classList.remove('db-null'); let disp = s; if (disp.length > 300) disp = disp.slice(0, 300) + '…'; td.textContent = disp; } }
  const trimNum = (n) => Number.isInteger(n) ? String(n) : (Math.abs(n) >= 1000 ? n.toFixed(2) : n.toPrecision(6).replace(/\.?0+$/, ''));
  function fmtStats(stat) { if (!stat) return ''; let s = `выбрано ячеек: ${stat.count}`; if (stat.num) s += `  ·  сумма ${trimNum(stat.sum)}  ·  сред. ${trimNum(stat.avg)}  ·  мин ${trimNum(stat.min)}  ·  макс ${trimNum(stat.max)}  ·  чисел ${stat.num}`; return s; }
  function makeGrid(opts) {
    const { columns, colTypes, rows, sortState, onSort, editable, onCellMenu, buffer, onBufferChange } = opts;
    const types = colTypes || columns.map(() => 'text');
    // column order/visibility/widths (original indices) — see renderTableTab for name↔index mapping
    const hidden = opts.hiddenCols instanceof Set ? opts.hiddenCols : new Set();
    let order = (opts.colOrder && opts.colOrder.length ? opts.colOrder.slice() : columns.map((_, i) => i)).filter((i) => i >= 0 && i < columns.length);
    for (let i = 0; i < columns.length; i++) if (!order.includes(i)) order.push(i);
    const widths = opts.colWidths || {};
    const vis = order.filter((i) => !hidden.has(i));   // visible original indices, in display order
    const wrap = el('div', 'db-grid');
    const tbl = document.createElement('table');
    // apply a column width across header + all its body cells (px=null clears it).
    // also mutate the local `widths` map so virtualized rows created later inherit it.
    const applyW = (ci, px) => {
      if (px == null) delete widths[ci]; else widths[ci] = px;
      wrap.querySelectorAll(`[data-c="${ci}"]`).forEach((cell) => { cell.style.width = cell.style.minWidth = cell.style.maxWidth = px == null ? '' : px + 'px'; });
    };
    // header
    const thead = document.createElement('thead'); const htr = document.createElement('tr');
    const corner = document.createElement('th'); corner.className = 'db-rownum-h'; corner.textContent = '#'; htr.appendChild(corner);
    for (const ci of vis) {
      const c = columns[ci];
      const th = document.createElement('th'); th.className = 'db-c-' + (types[ci] || 'text'); th.dataset.c = ci;
      const lab = el('span', 'db-th-label', c); th.appendChild(lab);
      if (sortState && sortState.col === c) th.appendChild(el('span', 'db-sort', sortState.dir === 'asc' ? ' ▲' : ' ▼'));
      if (onSort) { lab.style.cursor = 'pointer'; lab.onclick = () => onSort(c); }
      if (opts.onHeaderMenu) th.oncontextmenu = (e) => { e.preventDefault(); opts.onHeaderMenu(e, c, ci); };
      if (widths[ci]) { th.style.width = th.style.minWidth = th.style.maxWidth = widths[ci] + 'px'; }
      const grip = el('span', 'db-col-grip'); th.appendChild(grip); colGrip(grip, th, ci, applyW, opts.onColWidth);
      htr.appendChild(th);
    }
    thead.appendChild(htr); tbl.appendChild(thead);
    // body
    const tb = document.createElement('tbody');
    const sel = new Set(); let anchor = null, dragging = false, cur = null;
    const cellKey = (r, c) => r + ':' + c;
    function reportSel() {
      if (!opts.onSelStats) return;
      if (!sel.size) { opts.onSelStats(null); return; }
      let count = 0; const nums = [];
      for (const k of sel) { const [r, c] = k.split(':').map(Number); const v = rows[r] && rows[r][c]; count++; if (v != null) { const isNum = types[c] === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)); if (isNum) { const n = Number(v); if (!Number.isNaN(n)) nums.push(n); } } }
      const stat = { count }; if (nums.length) { const sum = nums.reduce((a, b) => a + b, 0); stat.num = nums.length; stat.sum = sum; stat.avg = sum / nums.length; stat.min = Math.min(...nums); stat.max = Math.max(...nums); }
      opts.onSelStats(stat);
    }
    const VIRT = !editable && rows.length > 800;
    if (VIRT) {
      wrap.classList.add('db-grid-virtual');
      const ROWH = 23, OVER = 12;
      const spacerTop = document.createElement('tr'); const stc = document.createElement('td'); stc.colSpan = vis.length + 1; spacerTop.appendChild(stc);
      const spacerBot = document.createElement('tr'); const sbc = document.createElement('td'); sbc.colSpan = vis.length + 1; spacerBot.appendChild(sbc);
      let lo = -1, hi = -1;
      const renderWindow = () => {
        const vh = wrap.clientHeight || Math.round(innerHeight * 0.6);
        const start = Math.max(0, Math.floor(wrap.scrollTop / ROWH) - OVER);
        const end = Math.min(rows.length, Math.ceil((wrap.scrollTop + vh) / ROWH) + OVER);
        if (start === lo && end === hi) return; lo = start; hi = end;
        tb.innerHTML = '';
        stc.style.height = (start * ROWH) + 'px'; tb.appendChild(spacerTop);
        for (let i = start; i < end; i++) tb.appendChild(dataRow(rows[i], i));
        sbc.style.height = Math.max(0, (rows.length - end) * ROWH) + 'px'; tb.appendChild(spacerBot);
        paintSel();
      };
      tbl.appendChild(tb); wrap.appendChild(tbl);
      wrap.addEventListener('scroll', () => requestAnimationFrame(renderWindow));
      setTimeout(renderWindow, 0); renderWindow();
    } else {
      rows.forEach((rowv, ri) => tb.appendChild(dataRow(rowv, ri)));
      if (editable && buffer) buffer.inserts.forEach((obj, ii) => tb.appendChild(insertRow(obj, ii)));
      tbl.appendChild(tb); wrap.appendChild(tbl);
    }
    document.addEventListener('mouseup', () => { dragging = false; });

    function dataRow(rowv, ri) {
      const tr = document.createElement('tr'); tr.dataset.ri = ri;
      if (buffer && buffer.deletes.has(ri)) tr.classList.add('db-row-del');
      const rn = document.createElement('td'); rn.className = 'db-rownum'; rn.textContent = String(ri + 1); tr.appendChild(rn);
      if (editable && buffer) rn.oncontextmenu = (e) => { e.preventDefault(); rowMenu(e, ri, tr); };
      for (const ci of vis) {
        const v0 = rowv[ci];
        const edited = buffer && buffer.edits[ri] && (columns[ci] in buffer.edits[ri]);
        const v = edited ? buffer.edits[ri][columns[ci]] : v0;
        const td = document.createElement('td'); td.className = 'db-c-' + (types[ci] || 'text'); td.dataset.r = ri; td.dataset.c = ci;
        if (edited) td.classList.add('db-edited');
        if (opts.fkCols && opts.fkCols.has(columns[ci]) && v != null) td.classList.add('db-fk');
        if (widths[ci]) { td.style.width = td.style.minWidth = td.style.maxWidth = widths[ci] + 'px'; }
        paintCell(td, v);
        td.onmousedown = (e) => { if (e.button !== 0) return; dragging = true; sel.clear(); anchor = [ri, ci]; cur = [ri, ci]; sel.add(cellKey(ri, ci)); paintSel(); reportSel(); if (document.getElementById('db-valpanel')) showCellValue(v, columns[ci]); wrap.focus({ preventScroll: true }); };
        td.onmouseenter = () => { if (dragging && anchor) { sel.clear(); const [ar, ac] = anchor; for (let r = Math.min(ar, ri); r <= Math.max(ar, ri); r++) for (let c = Math.min(ac, ci); c <= Math.max(ac, ci); c++) sel.add(cellKey(r, c)); paintSel(); reportSel(); } };
        if (editable && buffer) td.ondblclick = () => startEdit(td, ri, ci, v, false);
        if (onCellMenu) td.oncontextmenu = (e) => { e.preventDefault(); onCellMenu(e, v, columns[ci], rowv, ri); };
        tr.appendChild(td);
      }
      return tr;
    }
    function insertRow(obj, ii) {
      const tr = document.createElement('tr'); tr.classList.add('db-row-insert');
      const rn = document.createElement('td'); rn.className = 'db-rownum'; rn.textContent = '＋'; tr.appendChild(rn);
      for (const ci of vis) {
        const col = columns[ci];
        const td = document.createElement('td'); td.className = 'db-c-' + (types[ci] || 'text'); td.dataset.c = ci;
        const has = col in obj; paintCell(td, has ? obj[col] : null); if (!has) td.classList.add('db-null');
        if (widths[ci]) { td.style.width = td.style.minWidth = td.style.maxWidth = widths[ci] + 'px'; }
        td.ondblclick = () => startEditInsert(td, ii, col);
        tr.appendChild(td);
      }
      return tr;
    }
    function startEdit(td, ri, ci, v) {
      const inp = el('input', 'db-cell-edit'); inp.value = v == null ? '' : String(v);
      td.textContent = ''; td.appendChild(inp); inp.focus(); inp.select();
      const fin = (commit) => {
        if (commit) { const nv = inp.value === '' ? null : inp.value; buffer.edits[ri] = buffer.edits[ri] || {}; buffer.edits[ri][columns[ci]] = nv; td.classList.add('db-edited'); paintCell(td, nv); onBufferChange && onBufferChange(); }
        else paintCell(td, v);
      };
      inp.onblur = () => fin(true);
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } else if (e.key === 'Escape') { inp.onblur = null; fin(false); } };
    }
    function startEditInsert(td, ii, col) {
      const cur = col in buffer.inserts[ii] ? buffer.inserts[ii][col] : '';
      const inp = el('input', 'db-cell-edit'); inp.value = cur == null ? '' : String(cur);
      td.textContent = ''; td.appendChild(inp); inp.focus(); inp.select();
      const fin = (commit) => {
        if (commit) { const nv = inp.value === '' ? null : inp.value; buffer.inserts[ii][col] = nv; td.classList.remove('db-null'); paintCell(td, nv); onBufferChange && onBufferChange(); }
        else { const has = col in buffer.inserts[ii]; paintCell(td, has ? buffer.inserts[ii][col] : null); if (!has) td.classList.add('db-null'); }
      };
      inp.onblur = () => fin(true);
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } else if (e.key === 'Escape') { inp.onblur = null; fin(false); } };
    }
    function rowMenu(e, ri, tr) {
      const del = buffer.deletes.has(ri);
      showMenu(e.clientX, e.clientY, [{ label: del ? 'Отменить удаление' : 'Удалить строку', danger: !del, action: () => { if (del) buffer.deletes.delete(ri); else buffer.deletes.add(ri); tr.classList.toggle('db-row-del', !del); onBufferChange && onBufferChange(); } }]);
    }
    function paintSel() { tb.querySelectorAll('td.sel').forEach((x) => x.classList.remove('sel')); for (const k of sel) { const [r, c] = k.split(':'); const td = tb.querySelector(`td[data-r="${r}"][data-c="${c}"]`); if (td) td.classList.add('sel'); } }
    wrap.tabIndex = 0;
    function ensureVisible(r) { const td = tb.querySelector(`td[data-r="${r}"]`); if (td) td.scrollIntoView({ block: 'nearest' }); else wrap.scrollTop = Math.max(0, r * 23 - wrap.clientHeight / 2); }
    function setCur(r, c, extend) {
      r = Math.max(0, Math.min(rows.length - 1, r));
      if (!vis.includes(c)) c = vis.length ? vis[0] : 0;
      if (extend && anchor) { sel.clear(); const [ar, ac] = anchor; for (let rr = Math.min(ar, r); rr <= Math.max(ar, r); rr++) for (let cc = Math.min(ac, c); cc <= Math.max(ac, c); cc++) sel.add(cellKey(rr, cc)); }
      else { sel.clear(); anchor = [r, c]; sel.add(cellKey(r, c)); }
      cur = [r, c]; ensureVisible(r); paintSel(); reportSel();
      if (document.getElementById('db-valpanel')) { const rv = rows[r]; if (rv) showCellValue(rv[c], columns[c]); }
    }
    wrap.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel.size) {
        e.preventDefault();
        const cells = [...sel].map((k) => k.split(':').map(Number));
        const rs = [...new Set(cells.map((x) => x[0]))].sort((a, b) => a - b);
        const cs = [...new Set(cells.map((x) => x[1]))].sort((a, b) => a - b);
        const tsv = rs.map((r) => cs.map((c) => { const v = rows[r][c]; return v == null ? '' : fmtVal(v); }).join('\t')).join('\n');
        navigator.clipboard.writeText(tsv); toast(`Скопировано ячеек: ${sel.size}`); return;
      }
      const NAV = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
      if (NAV.includes(e.key)) {
        e.preventDefault(); if (!cur) cur = [0, vis[0] || 0]; let [r, c] = cur;
        let vp = Math.max(0, vis.indexOf(c));   // position within visible order
        if (e.key === 'ArrowUp') r--; else if (e.key === 'ArrowDown') r++;
        else if (e.key === 'ArrowLeft') c = vis[Math.max(0, vp - 1)]; else if (e.key === 'ArrowRight') c = vis[Math.min(vis.length - 1, vp + 1)];
        else if (e.key === 'Home') { c = vis[0]; if (e.ctrlKey) r = 0; } else if (e.key === 'End') { c = vis[vis.length - 1]; if (e.ctrlKey) r = rows.length - 1; }
        else if (e.key === 'PageUp') r -= 20; else if (e.key === 'PageDown') r += 20;
        setCur(r, c, e.shiftKey); return;
      }
      if (e.key === 'Escape') { sel.clear(); cur = null; paintSel(); reportSel(); return; }
      if (e.key === 'Enter' && editable && buffer && cur) { e.preventDefault(); const td = tb.querySelector(`td[data-r="${cur[0]}"][data-c="${cur[1]}"]`); if (td) startEdit(td, cur[0], cur[1], rows[cur[0]][cur[1]]); }
    });
    function addInsertRow() { if (!editable || !buffer) return; buffer.inserts.push({}); tb.appendChild(insertRow(buffer.inserts[buffer.inserts.length - 1], buffer.inserts.length - 1)); onBufferChange && onBufferChange(); }
    return { element: wrap, addInsertRow, selection: () => [...sel].map((k) => k.split(':').map(Number)) };
  }
  function colGrip(grip, th, ci, applyW, onColWidth) {
    grip.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = th.getBoundingClientRect().width;
      let last = startW;
      const move = (ev) => { last = Math.max(40, startW + ev.clientX - startX); applyW(ci, last); };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('db-col-resizing'); if (onColWidth) onColWidth(ci, Math.round(last)); };
      document.body.classList.add('db-col-resizing');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    };
    // double-click the grip → auto-fit (clear fixed width for this column)
    grip.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); applyW(ci, null); if (onColWidth) onColWidth(ci, null); };
  }

  // cell value viewer — right slide-in panel with JSON auto-detect, syntax highlight, fold/unfold
  function detectValue(v) {
    if (v == null) return { kind: 'null' };
    if (typeof v === 'object') return { kind: 'json', data: v };
    const s = String(v);
    if (typeof v === 'boolean') return { kind: 'bool', text: s };
    if (typeof v === 'number') return { kind: 'number', text: s };
    if (/^\s*[[{]/.test(s)) { try { return { kind: 'json', data: JSON.parse(s) }; } catch (_) {} }
    if (/^\s*<[a-zA-Z?!]/.test(s) && /<\/[a-zA-Z]|\/>/.test(s)) return { kind: 'xml', text: s };
    if (/^-?\d+(\.\d+)?$/.test(s.trim())) return { kind: 'number', text: s.trim() };
    return { kind: 'text', text: s };
  }
  // ---- JSON viewer model: a v-tree carrying persistent collapsed state per node
  function jvBuild(val) {
    if (Array.isArray(val)) return { kind: 'arr', collapsed: false, entries: val.map((v, i) => [i, jvBuild(v)]) };
    if (val && typeof val === 'object') return { kind: 'obj', collapsed: false, entries: Object.entries(val).map(([k, v]) => [k, jvBuild(v)]) };
    return { kind: 'prim', value: val };
  }
  function jvSetDeep(node, val) { if (node.kind === 'prim') return; node.collapsed = val; for (const [, c] of node.entries) jvSetDeep(c, val); }
  function jvValSpan(val) {
    if (val === null) return { cls: 'jv-null', text: 'null' };
    const t = typeof val;
    if (t === 'number') return { cls: 'jv-num', text: String(val) };
    if (t === 'boolean') return { cls: 'jv-bool', text: String(val) };
    return { cls: 'jv-str', text: JSON.stringify(val) };
  }
  // flatten v-tree → ordered line descriptors honouring each node's collapsed flag
  function jvFlatten(node, key, depth, isLast, out) {
    const comma = isLast ? '' : ',';
    const keyParts = key != null ? [{ cls: 'jv-key', text: JSON.stringify(key) }, { cls: 'jv-colon', text: ': ' }] : [];
    if (node.kind === 'prim') { out.push({ depth, foldable: false, parts: [...keyParts, jvValSpan(node.value), comma && { cls: 'jv-punc', text: comma }].filter(Boolean) }); return; }
    const isArr = node.kind === 'arr'; const open = isArr ? '[' : '{', close = isArr ? ']' : '}'; const n = node.entries.length;
    if (n === 0) { out.push({ depth, foldable: false, parts: [...keyParts, { cls: 'jv-brace', text: open + close }, comma && { cls: 'jv-punc', text: comma }].filter(Boolean) }); return; }
    if (node.collapsed) { out.push({ depth, foldable: true, collapsed: true, node, parts: [...keyParts, { cls: 'jv-brace', text: open }, { cls: 'jv-ell', text: ' … ' }, { cls: 'jv-brace', text: close }, comma && { cls: 'jv-punc', text: comma }, { cls: 'jv-count', text: ` ${n}` }].filter(Boolean) }); return; }
    out.push({ depth, foldable: true, collapsed: false, node, parts: [...keyParts, { cls: 'jv-brace', text: open }] });
    node.entries.forEach(([k, c], i) => jvFlatten(c, isArr ? null : k, depth + 1, i === n - 1, out));
    out.push({ depth, foldable: false, parts: [{ cls: 'jv-brace', text: close }, comma && { cls: 'jv-punc', text: comma }].filter(Boolean) });
  }
  function jvMetrics(data) {
    const compact = JSON.stringify(data) || '';
    let objects = 0, arrays = 0, totalKeys = 0, values = 0, maxDepth = 0;
    (function walk(v, d) { if (d > maxDepth) maxDepth = d; if (Array.isArray(v)) { arrays++; v.forEach((x) => walk(x, d + 1)); } else if (v && typeof v === 'object') { objects++; const ks = Object.keys(v); totalKeys += ks.length; ks.forEach((k) => walk(v[k], d + 1)); } else values++; })(data, 1);
    const topLevel = Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 0);
    const bytes = new TextEncoder().encode(compact).length;
    return { chars: compact.length, bytes, topLevel, maxDepth, totalKeys, objects, arrays, values, rootType: Array.isArray(data) ? 'массив' : 'объект' };
  }
  function jvFmtBytes(n) { if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ'; return (n / 1048576).toFixed(2) + ' МБ'; }
  // render the v-tree into a body element (gutter line-numbers + fold arrows, hover highlight)
  function jvRender(body, root) {
    const all = []; jvFlatten(root, null, 0, true, all);
    body.innerHTML = '';
    const CAP = 4000;   // guard against a huge jsonb cell freezing the UI with тысячи DOM-строк
    const lines = all.length > CAP ? all.slice(0, CAP) : all;
    lines.forEach((ln, i) => {
      const row = el('div', 'jv-line' + (ln.foldable ? ' foldable' : ''));
      const gut = el('div', 'jv-gutter');
      gut.appendChild(el('span', 'jv-ln', String(i + 1)));
      const fold = el('span', 'jv-fold');
      if (ln.foldable) { const ch = icon(ln.collapsed ? 'chevron-right' : 'chevron-down', 11); ch.classList.add('jv-chev'); fold.appendChild(ch); }
      gut.appendChild(fold);
      const content = el('div', 'jv-content'); content.style.paddingLeft = (ln.depth * 16 + 4) + 'px';
      for (const p of ln.parts) content.appendChild(el('span', p.cls, p.text));
      row.append(gut, content);
      if (ln.foldable) row.onclick = () => { if (ln.node.collapsed) ln.node.collapsed = false; else jvSetDeep(ln.node, true); jvRender(body, root); };
      body.appendChild(row);
    });
    if (all.length > CAP) body.appendChild(el('div', 'jv-cap', `… показано ${CAP} из ${all.length} строк — сверните узлы или копируйте JSON целиком`));
  }
  function showCellValue(v, colName) {
    let panel = document.getElementById('db-valpanel');
    const fresh = !panel;
    if (fresh) { panel = el('div', 'db-valpanel'); panel.id = 'db-valpanel'; document.body.appendChild(panel); }
    panel.innerHTML = '';
    const det = detectValue(v);
    const head = el('div', 'db-valpanel-head');
    head.append(el('span', 'db-valpanel-col', colName || 'значение'));
    head.appendChild(el('span', 'db-valpanel-badge', { 'null': 'NULL', json: 'JSON', xml: 'XML', number: 'число', bool: 'bool', text: 'текст' }[det.kind] || 'текст'));
    head.appendChild((() => { const s = el('span'); s.style.flex = '1'; return s; })());
    const body = el('div', 'db-valpanel-body');
    const info = el('div', 'db-valpanel-info');
    if (det.kind === 'json' && det.data && typeof det.data === 'object') {
      const root = jvBuild(det.data);
      const foldAll = iconBtn('drow-act', 'fold', 'Свернуть всё', 13); foldAll.onclick = () => { jvSetDeep(root, true); jvRender(body, root); };
      const unfoldAll = iconBtn('drow-act', 'unfold', 'Развернуть всё', 13); unfoldAll.onclick = () => { jvSetDeep(root, false); jvRender(body, root); };
      const firstLvl = iconBtn('drow-act', 'list-ordered', 'Развернуть первый уровень', 13); firstLvl.onclick = () => { jvSetDeep(root, true); root.collapsed = false; jvRender(body, root); };
      const copyJson = iconBtn('drow-act', 'braces', 'Копировать весь JSON', 13); copyJson.onclick = () => { navigator.clipboard.writeText(JSON.stringify(det.data, null, 2)); toast('JSON скопирован'); };
      const infoBtn = iconBtn('drow-act', 'info', 'Информация о JSON', 13);
      const applyInfo = () => { const on = !!dbUi.jsonInfo; info.classList.toggle('on', on); infoBtn.classList.toggle('on', on); };
      infoBtn.onclick = () => { dbUi.jsonInfo = !dbUi.jsonInfo; saveDbUi(); applyInfo(); };
      head.append(foldAll, unfoldAll, firstLvl, copyJson, infoBtn);
      // info bar content
      const m = jvMetrics(det.data);
      const chip = (k, val) => { const c = el('span', 'jv-chip'); c.append(el('span', 'jv-chip-k', k), el('span', 'jv-chip-v', String(val))); return c; };
      info.append(
        chip('тип', m.rootType), chip('верхний уровень', m.topLevel), chip('всего ключей', m.totalKeys),
        chip('глубина', m.maxDepth), chip('объектов', m.objects), chip('массивов', m.arrays),
        chip('значений', m.values), chip('символов', m.chars), chip('объём', jvFmtBytes(m.bytes)),
      );
      body.classList.add('jv');
      panel.append(head, info, body);
      applyInfo();
      jvRender(body, root);
    } else {
      const copy = iconBtn('drow-act', 'copy', 'Копировать значение', 13);
      copy.onclick = () => { navigator.clipboard.writeText(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v))); toast('Скопировано'); };
      head.append(copy);
      if (det.kind === 'null') { const p = el('pre', 'db-valpanel-pre db-null'); p.textContent = 'NULL'; body.appendChild(p); }
      else { const p = el('pre', 'db-valpanel-pre'); p.textContent = det.text; if (det.kind === 'number') p.classList.add('jv-num'); body.appendChild(p); }
      panel.append(head, body);
    }
    const close = iconBtn('drow-act', 'x', 'Закрыть', 13); close.onclick = () => { panel.classList.remove('on'); setTimeout(() => panel.remove(), 180); };
    head.append(close);
    if (fresh) requestAnimationFrame(() => panel.classList.add('on')); else panel.classList.add('on');
  }

  // ============================================================ SQL tab
  function dbDialect() { return dbActiveConn.type === 'mysql' ? MySQL : dbActiveConn.type === 'sqlite' ? SQLite : PostgreSQL; }
  function buildSchemaObj() {
    const out = {}; if (!dbColsCache) return out;
    for (const [k, cols] of Object.entries(dbColsCache)) { out[k] = cols; const bare = k.includes('.') ? k.split('.').slice(-1)[0] : k; if (!out[bare]) out[bare] = cols; }
    return out;
  }
  function renderSqlTab(body, t) {
    const edWrap = el('div', 'db-sql-editor'); body.appendChild(edWrap);
    const bar = el('div', 'db-sql-bar');
    const run = el('button', 'btn primary db-run', '▶ Выполнить'); run.title = 'Ctrl+Enter (выделение/запрос под курсором)'; run.onclick = () => runSql(t);
    const fmt = el('button', 'btn', 'Формат'); fmt.title = 'Форматировать SQL'; fmt.onclick = () => { if (t.editor) { const out = formatSql(t.editor.state.doc.toString()); t.editor.dispatch({ changes: { from: 0, to: t.editor.state.doc.length, insert: out } }); } };
    const explain = el('button', 'btn', 'EXPLAIN'); explain.onclick = () => explainQuery(t);
    const save = el('button', 'btn', '★ Сохранить'); save.title = 'Сохранить запрос под именем'; save.onclick = () => saveNamedQuery(t);
    const hist = el('button', 'btn', 'История'); hist.onclick = (e) => historyMenu(e, t);
    const imp = el('button', 'btn', '⬇ Импорт'); imp.title = 'Загрузить SQL-файл'; imp.onclick = async () => { const r = await lite.db.openText(); if (r && r.ok && t.editor) t.editor.dispatch({ changes: { from: 0, to: t.editor.state.doc.length, insert: r.content } }); else if (r && r.error) toast(r.error, { kind: 'err' }); };
    const cancel = el('button', 'btn db-cancel', '■ Отмена'); cancel.style.display = 'none'; cancel.onclick = () => lite.db.cancel(dbActiveId);
    bar.append(run, fmt, explain, save, hist, imp, cancel);
    const expBtn = el('button', 'btn db-exp-open', 'Экспорт…'); expBtn.title = 'Экспорт / копирование результата'; expBtn.style.marginLeft = 'auto';
    expBtn.onclick = () => { if (t.lastResult && t.lastResult.columns) openExportModal(t.lastResult, 'query'); else toast('Нет результата'); };
    bar.appendChild(expBtn);
    body.appendChild(bar);
    const res = el('div', 'db-sql-result'); body.appendChild(res); t.resultEl = res; t.cancelBtn = cancel;

    if (t.editor) { try { t.editor.destroy(); } catch (_) {} }
    const schemaObj = buildSchemaObj();
    const state = EditorState.create({
      doc: t.sql || '',
      extensions: [
        lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(),
        autocompletion(), syntaxHighlighting(defaultHighlightStyle),
        sql({ dialect: dbDialect(), schema: schemaObj }), oneDark,
        keymap.of([
          { key: 'Ctrl-Enter', run: () => { runSql(t); return true; } },
          { key: 'Mod-Enter', run: () => { runSql(t); return true; } },
          { key: 'Tab', run: acceptCompletion }, indentWithTab, ...completionKeymap, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => { if (u.docChanged) t.sql = u.state.doc.toString(); }),
      ],
    });
    t.editor = new EditorView({ state, parent: edWrap });
    if (t.lastResult) showSqlResult(t, t.lastResult);
  }
  function currentSqlText(t) {
    const ed = t.editor; if (!ed) return '';
    const sel = ed.state.selection.main;
    if (!sel.empty) return ed.state.sliceDoc(sel.from, sel.to).trim();
    // statement under cursor: split whole doc by ';' and find the segment containing the cursor
    const doc = ed.state.doc.toString(); const pos = sel.head;
    let start = doc.lastIndexOf(';', pos - 1) + 1; let end = doc.indexOf(';', pos); if (end < 0) end = doc.length;
    const stmt = doc.slice(start, end).trim();
    return stmt || doc.trim();
  }
  async function runSql(t, explain) {
    if (!t.editor) return;
    let text = currentSqlText(t); if (!text) return;
    if (explain) text = 'EXPLAIN ' + text.replace(/;\s*$/, '');
    runWithParams(text, (finalText) => {
      if (dbActiveConn && dbActiveConn.isProd && isDestructiveSql(finalText)) { prodGuard(finalText, () => execSql(t, finalText)); return; }
      execSql(t, finalText);
    });
  }
  // substitute :name parameters via a prompt before running (skips ::casts and array-slices follow no \w)
  function runWithParams(text, cont) {
    const names = [...new Set([...text.matchAll(/(?<!:):([A-Za-z_]\w*)/g)].map((m) => m[1]))];
    if (!names.length) { cont(text); return; }
    const { m, close } = makeModal('<h2>Параметры запроса</h2><div class="db-form" id="dbparams"></div>'); m.classList.add('db-modal');
    const host = m.querySelector('#dbparams'); const ins = {};
    for (const n of names) { const w = el('div', 'db-field'); w.append(el('label', null, ':' + n)); const i = el('input'); ins[n] = i; w.append(i); host.appendChild(w); }
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '10px';
    const ok = el('button', 'btn primary', 'Выполнить'); ok.onclick = () => { let out = text; for (const n of names) out = out.replace(new RegExp('(?<!:):' + n + '\\b', 'g'), lit(ins[n].value === '' ? null : ins[n].value)); close(); cont(out); };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close; acts.append(ok, cancel); host.appendChild(acts);
    setTimeout(() => ins[names[0]].focus(), 30);
  }
  async function execSql(t, text) {
    pushHistory(text);
    const res = t.resultEl; if (!res) return;
    res.innerHTML = '<div class="git-loading">Выполняю…</div>';
    t.lastResult = null;
    if (t.cancelBtn && dbActiveConn.type !== 'sqlite') t.cancelBtn.style.display = '';
    const seq = ++sqlSeq; t._seq = seq; const t0 = performance.now();
    const r = await lite.db.query(dbActiveId, text);
    if (t._seq !== seq) return;
    if (t.cancelBtn) t.cancelBtn.style.display = 'none';
    const ms = Math.round(performance.now() - t0);
    res.innerHTML = '';
    if (r.error) { res.appendChild(el('div', 'docker-err', r.error)); return; }
    r._ms = ms; t.lastResult = r; showSqlResult(t, r);
    // a DDL/DML run may have changed the schema → drop caches
    dbSchema = null; metaCache.clear(); dbRelationsCache = null;
  }
  // ---- graphical EXPLAIN
  async function explainQuery(t) {
    if (!t.editor) return; let text = currentSqlText(t); if (!text) return; text = text.replace(/;\s*$/, '');
    const res = t.resultEl; if (!res) return; res.innerHTML = '<div class="git-loading">EXPLAIN…</div>';
    t.lastResult = null; const type = dbActiveConn.type;
    const q = type === 'postgres' ? `EXPLAIN (FORMAT JSON) ${text}` : type === 'mysql' ? `EXPLAIN FORMAT=JSON ${text}` : `EXPLAIN QUERY PLAN ${text}`;
    const r = await lite.db.query(dbActiveId, q);
    res.innerHTML = '';
    if (r.error) { res.appendChild(el('div', 'docker-err', r.error)); return; }
    res.appendChild(el('div', 'db-result-info', 'План выполнения'));
    const host = el('div', 'db-plan'); res.appendChild(host);
    try {
      if (type === 'postgres') renderPgPlan(host, r);
      else if (type === 'mysql') renderJsonPlan(host, r);
      else renderSqlitePlan(host, r);
    } catch (e) { host.appendChild(el('div', 'docker-err', 'Не удалось разобрать план: ' + (e.message || e))); const pre = el('pre', 'db-ddl-pre'); pre.textContent = JSON.stringify(r.rows, null, 2); host.appendChild(pre); }
  }
  function renderPgPlan(host, r) {
    let plan = r.rows[0][0]; if (typeof plan === 'string') plan = JSON.parse(plan);
    const root = plan[0].Plan; const maxCost = root['Total Cost'] || 1;
    const node = (n) => {
      const div = el('div', 'db-plan-node');
      const head = el('div', 'db-plan-head');
      const share = (n['Total Cost'] || 0) / maxCost;
      if (share > 0.5) head.classList.add('hot');
      head.append(el('span', 'db-plan-type', n['Node Type'] + (n['Relation Name'] ? ' · ' + n['Relation Name'] : '') + (n['Index Name'] ? ' (' + n['Index Name'] + ')' : '')));
      const bits = [`cost ${n['Total Cost']}`, `rows ${n['Plan Rows']}`]; if (n['Actual Total Time'] != null) bits.push(`${n['Actual Total Time']} мс`); if (n['Filter']) bits.push('filter');
      head.append(el('span', 'db-plan-cost', bits.join(' · ')));
      div.appendChild(head);
      if (n['Node Type'] === 'Seq Scan' && (n['Plan Rows'] || 0) > 1000) div.appendChild(el('div', 'db-plan-hint', '⚠ Seq Scan по большой таблице — возможно, поможет индекс' + (n['Filter'] ? ' на колонке из ' + n['Filter'] : '')));
      if (n.Plans) { const kids = el('div', 'db-plan-kids'); n.Plans.forEach((k) => kids.appendChild(node(k))); div.appendChild(kids); }
      return div;
    };
    host.appendChild(node(root));
  }
  function renderJsonPlan(host, r) {
    let plan = r.rows[0][0]; if (typeof plan === 'string') plan = JSON.parse(plan);
    const pre = el('pre', 'db-ddl-pre'); pre.textContent = JSON.stringify(plan, null, 2); host.appendChild(pre);
  }
  function renderSqlitePlan(host, r) {
    // rows: id, parent, notused, detail → indent by parent chain
    const byId = new Map(); r.rows.forEach((row) => byId.set(row[0], { id: row[0], parent: row[1], detail: row[3], kids: [] }));
    const roots = []; for (const n of byId.values()) { const p = byId.get(n.parent); if (p) p.kids.push(n); else roots.push(n); }
    const node = (n) => { const div = el('div', 'db-plan-node'); div.appendChild(el('div', 'db-plan-head', n.detail)); if (n.kids.length) { const k = el('div', 'db-plan-kids'); n.kids.forEach((c) => k.appendChild(node(c))); div.appendChild(k); } return div; };
    roots.forEach((n) => host.appendChild(node(n)));
  }
  function showSqlResult(t, r) {
    const res = t.resultEl; if (!res) return; res.innerHTML = '';
    if (r.columns && r.columns.length) {
      const info = el('div', 'db-result-info'); info.append(el('span', null, `${r.rows.length} строк${r._ms != null ? ` · ${r._ms} мс` : ''}`));
      const chartBtn = el('button', 'db-exp-btn', '📊 График'); chartBtn.onclick = () => openChart(r.columns, r.colTypes, r.rows); info.appendChild(chartBtn);
      res.appendChild(info);
      let sortState = null; const rows = r.rows.slice();
      const selFoot = el('div', 'db-selfoot');
      const rerender = () => { res.querySelector('.db-grid')?.remove(); const g = makeGrid({ columns: r.columns, colTypes: r.colTypes, rows, sortState, onSelStats: (st) => { selFoot.textContent = fmtStats(st); selFoot.classList.toggle('on', !!st); }, onSort: (col) => { const ci = r.columns.indexOf(col); if (sortState && sortState.col === col) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc'; else sortState = { col, dir: 'asc' }; rows.sort((a, b) => { const x = a[ci], y = b[ci]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * (sortState.dir === 'asc' ? 1 : -1); }); rerender(); }, onCellMenu: (e, val, colName) => cellMenu(e, val, colName, null, null, r.columns, null, null, r) }); res.insertBefore(g.element, selFoot); };
      res.appendChild(selFoot); rerender();
    } else {
      res.appendChild(el('div', 'db-result-info', `Готово${r.rowCount != null ? ` · затронуто строк: ${r.rowCount}` : ''}${r._ms != null ? ` · ${r._ms} мс` : ''}`));
    }
  }

  // ---- query history + named saved queries (persisted in dbUi)
  function pushHistory(sql) { dbUi.history = dbUi.history || []; if (dbUi.history[0] === sql) return; dbUi.history.unshift(sql); if (dbUi.history.length > 50) dbUi.history.length = 50; saveDbUi(); }
  function loadInto(t, s) { if (t.editor) t.editor.dispatch({ changes: { from: 0, to: t.editor.state.doc.length, insert: s } }); }
  function saveNamedQuery(t) {
    const sql = (t.editor && t.editor.state.doc.toString().trim()) || ''; if (!sql) { toast('Пустой запрос'); return; }
    showPrompt('Сохранить запрос', 'Имя запроса', '', (name) => {
      dbUi.saved = dbUi.saved || []; const i = dbUi.saved.findIndex((x) => x.name === name);
      if (i >= 0) dbUi.saved[i].sql = sql; else dbUi.saved.unshift({ name, sql }); saveDbUi(); toast('Сохранено: ' + name);
    });
  }
  const SNIPPETS = [
    ['Список таблиц', "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','mysql','performance_schema','sys') ORDER BY 1,2;"],
    ['Размеры таблиц (Postgres)', 'SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;'],
    ['Активные запросы (Postgres)', "SELECT pid, state, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;"],
    ['Шаблон с параметром', 'SELECT * FROM /*таблица*/ WHERE id = :id;'],
  ];
  function historyMenu(e, t) {
    const items = [];
    const saved = dbUi.saved || [];
    if (saved.length) { for (const s of saved) items.push({ label: '★ ' + s.name, action: () => loadInto(t, s.sql) }); items.push({ sep: true }); }
    for (const [name, sql] of SNIPPETS) items.push({ label: '◇ ' + name, action: () => loadInto(t, sql) });
    items.push({ sep: true });
    for (const s of (dbUi.history || []).slice(0, 15)) items.push({ label: s.replace(/\s+/g, ' ').slice(0, 70), action: () => loadInto(t, s) });
    showMenu(e.clientX, e.clientY, items);
  }
  // ---- object palette (Ctrl+P): fuzzy jump to table/column
  function openPalette() {
    if (!dbActiveId || !dbSchema) return;
    const items = [];
    for (const sch of dbSchema.schemas) for (const tb of sch.tables) items.push({ label: (sch.name ? sch.name + '.' : '') + tb.name, schema: sch.name, table: tb.name, view: tb.view });
    if (dbColsCache) for (const [k, cols] of Object.entries(dbColsCache)) { const dot = k.indexOf('.'); const schema = dot >= 0 ? k.slice(0, dot) : null; const table = dot >= 0 ? k.slice(dot + 1) : k; for (const col of cols) items.push({ label: k + '.' + col, schema, table, col }); }
    const { m, close } = makeModal('<h2>Переход к объекту</h2><input id="dbpal" class="db-tree-search" placeholder="таблица или колонка…"><div id="dbpallist" class="db-pal-list"></div>'); m.classList.add('db-modal');
    const inp = m.querySelector('#dbpal'); inp.style.width = '100%'; const list = m.querySelector('#dbpallist');
    let active = 0, filtered = [];
    const pick = (it) => { close(); openTableTab(it.schema, it.table, !!it.view); };
    const paint = () => { [...list.children].forEach((c, i) => c.classList.toggle('on', i === active)); list.children[active] && list.children[active].scrollIntoView({ block: 'nearest' }); };
    const render = () => { const q = inp.value.trim().toLowerCase(); filtered = (q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items).slice(0, 300); active = 0; list.innerHTML = ''; filtered.forEach((it, i) => { const r = el('div', 'db-pal-item' + (i === 0 ? ' on' : '')); r.textContent = it.label; r.onclick = () => pick(it); list.appendChild(r); }); };
    inp.oninput = render;
    inp.onkeydown = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); paint(); } else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); } else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) pick(filtered[active]); } };
    render(); setTimeout(() => inp.focus(), 30);
  }

  // ============================================================ context menus
  function showMenu(x, y, items) {
    document.querySelector('.db-ctxmenu')?.remove();
    const menu = el('div', 'db-ctxmenu'); menu.style.left = x + 'px'; menu.style.top = y + 'px';
    for (const it of items) { if (it.sep) { menu.appendChild(el('div', 'db-ctx-sep')); continue; } const mi = el('div', 'db-ctx-item' + (it.danger ? ' danger' : '')); mi.textContent = it.label; mi.onclick = () => { menu.remove(); it.action(); }; menu.appendChild(mi); }
    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    const r = menu.getBoundingClientRect(); if (r.right > innerWidth) menu.style.left = (innerWidth - r.width - 6) + 'px'; if (r.bottom > innerHeight) menu.style.top = (innerHeight - r.height - 6) + 'px';
  }
  function tableMenu(e, schema, table) {
    const qn = qual(schema, table);
    showMenu(e.clientX, e.clientY, [
      { label: 'Открыть данные', action: () => openTableTab(schema, table, false) },
      { label: 'SELECT 100 строк', action: () => autorun(`SELECT * FROM ${qn} LIMIT 100;`) },
      { label: 'COUNT(*)', action: () => autorun(`SELECT COUNT(*) FROM ${qn};`) },
      { label: 'Структура', action: () => { openTableTab(schema, table, false); const t = findTab(tabKeyTable(schema, table)); if (t) { t.mode = 'structure'; renderTabBody($('#db-tabbody')); } } },
      { label: 'DDL', action: () => openDdlTab(schema, table) },
      { label: 'Изменить структуру…', action: () => tableEditor(schema, table) },
      { sep: true },
      { label: 'Копировать имя', action: () => { navigator.clipboard.writeText(table); toast('Скопировано'); } },
      { label: 'INSERT-шаблон', action: () => insertTemplate(schema, table) },
      { sep: true },
      { label: 'DROP TABLE…', danger: true, action: () => showConfirm('Удалить таблицу?', `${qn} будет удалена безвозвратно.`, 'DROP', () => autorun(`DROP TABLE ${qn};`)) },
    ]);
  }
  function cellMenu(e, val, colName, rowValues, t, columns, ri, meta, resultObj) {
    const items = [
      { label: 'Копировать значение', action: () => { navigator.clipboard.writeText(val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val))); toast('Скопировано'); } },
      { label: 'Показать значение', action: () => showCellValue(val, colName) },
      { label: 'Копировать имя колонки', action: () => { navigator.clipboard.writeText(colName); toast('Скопировано'); } },
    ];
    if (t && columns) {
      items.push({ sep: true });
      items.push({ label: `Фильтр: ${colName} = …`, action: () => { t.where = `${qIdent(colName)} = ${lit(val)}`; t.page = 0; renderTabBody($('#db-tabbody')); } });
      const col = meta && meta.columns && meta.columns.find((c) => c.name === colName);
      if (col && col.fk && val != null) {
        items.push({ label: `→ Перейти: ${col.fk.table}.${col.fk.column}`, action: () => openTableFiltered(col.fk.schema || t.schema, col.fk.table, `${qIdent(col.fk.column)} = ${lit(val)}`) });
      }
      if (col && val != null) {
        items.push({ label: 'Показать ссылающиеся →', action: async () => { await showUsages(t, colName, val); } });
      }
    }
    const res = resultObj || (t && t.lastResult);
    if (res && res.columns && res.rows) {
      const ci = res.columns.indexOf(colName); const name = (t && t.table) || 'query';
      items.push({ sep: true });
      if (ci >= 0) items.push({ label: `Копировать колонку как IN (…)`, action: () => copyInList(colName, ci, res.rows) });
      items.push({ label: 'Копировать как Markdown', action: () => copyResultAs('markdown', res.columns, res.rows) });
      items.push({ label: 'Копировать как CSV', action: () => copyResultAs('csv', res.columns, res.rows) });
      items.push({ label: 'Копировать как JSON', action: () => copyResultAs('json', res.columns, res.rows) });
      items.push({ label: 'Копировать как INSERT', action: () => copyResultAs('insert', res.columns, res.rows, name) });
    }
    showMenu(e.clientX, e.clientY, items);
  }
  // ---- visual table editor (generates ALTER, runs in a transaction)
  async function tableEditor(schema, table) {
    const meta = await getMeta(schema, table); if (meta.error) { toast(meta.error, { kind: 'err' }); return; }
    const tq = qual(schema, table); const stmts = [];
    const { m, close } = makeModal(`<h2>Изменить структуру: ${esc(table)}</h2><div class="db-ed"></div>`); m.classList.add('db-modal');
    const host = m.querySelector('.db-ed');
    const inp = (ph) => { const i = el('input'); i.placeholder = ph; return i; };
    const out = el('pre', 'db-ddl-pre'); const refresh = () => { out.textContent = stmts.join('\n') || '— нет изменений —'; };
    // add column
    const acName = inp('имя'); const acType = inp('тип (varchar(50), int, …)'); const acNull = el('input'); acNull.type = 'checkbox'; acNull.checked = true; const acDef = inp('DEFAULT (опц.)');
    const addColBtn = el('button', 'btn', '+ колонку'); addColBtn.onclick = () => { if (!acName.value.trim() || !acType.value.trim()) { toast('Имя и тип'); return; } stmts.push(`ALTER TABLE ${tq} ADD COLUMN ${qIdent(acName.value.trim())} ${acType.value.trim()}${acNull.checked ? '' : ' NOT NULL'}${acDef.value.trim() ? ' DEFAULT ' + acDef.value.trim() : ''};`); refresh(); };
    const acRow = el('div', 'db-ed-row'); acRow.append(acName, acType, labelChk('NULL', acNull), acDef, addColBtn);
    host.append(el('div', 'db-ed-h', 'Добавить колонку'), acRow);
    // drop column
    const dcSel = el('select'); for (const c of meta.columns) dcSel.appendChild(new Option(c.name, c.name));
    const dropColBtn = el('button', 'btn', '− колонку'); dropColBtn.onclick = () => { stmts.push(`ALTER TABLE ${tq} DROP COLUMN ${qIdent(dcSel.value)};`); refresh(); };
    const dcRow = el('div', 'db-ed-row'); dcRow.append(dcSel, dropColBtn);
    host.append(el('div', 'db-ed-h', 'Удалить колонку'), dcRow);
    // add index
    const ixName = inp('имя индекса'); const ixCols = inp('колонки через запятую'); const ixUniq = el('input'); ixUniq.type = 'checkbox';
    const addIxBtn = el('button', 'btn', '+ индекс'); addIxBtn.onclick = () => { if (!ixName.value.trim() || !ixCols.value.trim()) { toast('Имя и колонки'); return; } const cols = ixCols.value.split(',').map((s) => qIdent(s.trim())).join(', '); stmts.push(`CREATE ${ixUniq.checked ? 'UNIQUE ' : ''}INDEX ${qIdent(ixName.value.trim())} ON ${tq} (${cols});`); refresh(); };
    const ixRow = el('div', 'db-ed-row'); ixRow.append(ixName, ixCols, labelChk('UNIQUE', ixUniq), addIxBtn);
    host.append(el('div', 'db-ed-h', 'Добавить индекс'), ixRow);
    // output + actions
    host.append(el('div', 'db-ed-h', 'SQL'), out); refresh();
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '10px';
    const undo = el('button', 'btn', 'Убрать последнее'); undo.onclick = () => { stmts.pop(); refresh(); };
    const exec = el('button', 'btn primary', 'Выполнить'); exec.onclick = () => { if (!stmts.length) return; prodGuard(stmts.join(' '), async () => { const r = await lite.db.transaction(dbActiveId, stmts); if (r && r.ok) { toast('Применено'); close(); metaCache.delete((schema ? schema + '.' : '') + table); dbSchema = null; invalidateTableCaches(); if (dbOpen) renderDbWorkspace($('#db-body')); } else toast((r && r.error) || 'Ошибка', { kind: 'err' }); }); };
    acts.append(undo, exec); host.appendChild(acts);
  }
  function labelChk(text, node) { const w = el('label', 'db-check'); w.append(node, document.createTextNode(' ' + text)); return w; }
  function headerMenu(e, colName, t, meta) {
    showMenu(e.clientX, e.clientY, [
      { label: 'Сортировать ↑', action: () => { t.orderBy = colName; t.orderDir = 'asc'; t.page = 0; renderTabBody($('#db-tabbody')); } },
      { label: 'Сортировать ↓', action: () => { t.orderBy = colName; t.orderDir = 'desc'; t.page = 0; renderTabBody($('#db-tabbody')); } },
      { sep: true },
      { label: 'Профайлинг колонки', action: () => profileColumn(t, colName, meta) },
      { label: 'Копировать имя колонки', action: () => { navigator.clipboard.writeText(colName); toast('Скопировано'); } },
    ]);
  }
  async function profileColumn(t, colName, meta) {
    const col = meta && meta.columns && meta.columns.find((c) => c.name === colName);
    const numeric = col && /\b(int|integer|numeric|real|double|decimal|float|money|serial|bigint|smallint)\b/i.test(col.type || '');
    const c = qIdent(colName); const tbl = qual(t.schema, t.table); const wh = t.where ? ` WHERE ${t.where}` : '';
    const { m } = makeModal(`<h2>Профайл колонки: ${esc(colName)}</h2><div id="dbprof" class="db-prof"><div class="git-loading">Считаю…</div></div>`); m.classList.add('db-modal');
    const host = m.querySelector('#dbprof');
    const agg = await lite.db.query(dbActiveId, `SELECT COUNT(*) AS total, COUNT(${c}) AS nonnull, COUNT(DISTINCT ${c}) AS distinctc, MIN(${c}) AS mn, MAX(${c}) AS mx${numeric ? `, AVG(${c}) AS avgv` : ''} FROM ${tbl}${wh}`);
    if (agg.error) { host.innerHTML = ''; host.appendChild(el('div', 'docker-err', agg.error)); return; }
    const [total, nonnull, distinctc, mn, mx, avgv] = agg.rows[0].map((x) => x);
    const tot = Number(total) || 0; const nullc = tot - (Number(nonnull) || 0);
    host.innerHTML = '';
    const stats = [
      ['Всего строк', tot], ['Заполнено', nonnull], ['NULL', `${nullc} (${tot ? (nullc / tot * 100).toFixed(1) : 0}%)`],
      ['Уникальных', distinctc], ['Минимум', mn], ['Максимум', mx],
    ];
    if (numeric) stats.push(['Среднее', avgv != null ? Number(avgv).toFixed(3) : '—']);
    const grid = el('div', 'db-prof-stats');
    for (const [k, v] of stats) { const cell = el('div', 'db-prof-stat'); cell.append(el('span', 'db-prof-k', k), el('span', 'db-prof-v', v == null ? 'NULL' : String(v))); grid.appendChild(cell); }
    host.appendChild(grid);
    host.appendChild(el('h4', 'db-struct-h', 'Топ значений'));
    const topHost = el('div', 'db-prof-top'); topHost.innerHTML = '<div class="git-loading">…</div>'; host.appendChild(topHost);
    const top = await lite.db.query(dbActiveId, `SELECT ${c} AS v, COUNT(*) AS n FROM ${tbl}${wh} GROUP BY ${c} ORDER BY n DESC LIMIT 10`);
    topHost.innerHTML = '';
    if (top.error) { topHost.appendChild(el('div', 'docker-err', top.error)); return; }
    const maxN = Math.max(1, ...top.rows.map((r) => Number(r[1]) || 0));
    for (const [v, n] of top.rows) {
      const row = el('div', 'db-prof-bar-row');
      row.append(el('span', 'db-prof-bar-label', v == null ? 'NULL' : String(v)));
      const track = el('div', 'db-prof-bar-track'); const fill = el('div', 'db-prof-bar-fill'); fill.style.width = (Number(n) / maxN * 100) + '%'; track.appendChild(fill);
      row.append(track, el('span', 'db-prof-bar-n', String(n)));
      topHost.appendChild(row);
    }
  }
  // ---- mini charts (SVG, no deps)
  // ── charts (Chart.js, statically imported): many types + PNG export ──
  const _ChartLib = Chart;
  async function loadChartLib() { return _ChartLib; }
  const CHART_TYPES = [
    { id: 'bar', label: 'Столбцы' }, { id: 'line', label: 'Линия' }, { id: 'area', label: 'Область' },
    { id: 'horizontalBar', label: 'Гориз. столбцы' }, { id: 'pie', label: 'Круговая' }, { id: 'doughnut', label: 'Кольцо' },
    { id: 'radar', label: 'Радар' }, { id: 'scatter', label: 'Точечная' },
  ];
  const CHART_ALIAS = { column: 'bar', columns: 'bar', donut: 'doughnut', hbar: 'horizontalBar', horizontal: 'horizontalBar', 'horizontal-bar': 'horizontalBar', point: 'scatter', dot: 'scatter' };
  function normChartType(t) { t = String(t || 'bar').toLowerCase(); if (CHART_ALIAS[t]) t = CHART_ALIAS[t]; return CHART_TYPES.some((x) => x.id === t) ? t : 'bar'; }
  const CHART_PALETTE = ['#6cb6ff', '#7ee787', '#f0883e', '#b794f6', '#ff7b72', '#39c5cf', '#e3b341', '#db61a2', '#a5d6ff', '#56d364'];
  function cssVar(name, fb) { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (_) { return fb; } }
  function buildChartConfig(type, columns, rows, spec) {
    type = normChartType(type);
    const xi = columns.indexOf(spec.x);
    const ys = (spec.y || []).map((c) => ({ name: c, i: columns.indexOf(c) })).filter((o) => o.i >= 0);
    const data = rows.slice(0, 100);
    const text = cssVar('--text', '#e6edf3'), grid = cssVar('--border', '#30363d');
    const num = (v) => { const n = Number(v); return Number.isNaN(n) ? null : n; };
    const labels = data.map((r) => r[xi] == null ? '∅' : String(r[xi]));
    const common = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: text } }, title: spec.title ? { display: true, text: spec.title, color: text } : { display: false } } };
    if (type === 'pie' || type === 'doughnut') { const yi = ys.length ? ys[0].i : -1; return { type, data: { labels, datasets: [{ data: data.map((r) => num(r[yi])), backgroundColor: labels.map((_, k) => CHART_PALETTE[k % CHART_PALETTE.length]) }] }, options: common }; }
    if (type === 'radar') { const datasets = ys.map((o, k) => ({ label: o.name, data: data.map((r) => num(r[o.i])), borderColor: CHART_PALETTE[k % CHART_PALETTE.length], backgroundColor: CHART_PALETTE[k % CHART_PALETTE.length] + '55' })); return { type: 'radar', data: { labels, datasets }, options: { ...common, scales: { r: { angleLines: { color: grid }, grid: { color: grid }, pointLabels: { color: text }, ticks: { color: text, backdropColor: 'transparent' } } } } }; }
    if (type === 'scatter') { const yi = ys.length ? ys[0].i : -1; return { type: 'scatter', data: { datasets: [{ label: (ys[0] && ys[0].name) || 'y', data: data.map((r) => ({ x: num(r[xi]), y: num(r[yi]) })).filter((p) => p.x != null && p.y != null), backgroundColor: CHART_PALETTE[0] }] }, options: { ...common, scales: { x: { ticks: { color: text }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid } } } } }; }
    const cfgType = type === 'area' ? 'line' : (type === 'horizontalBar' ? 'bar' : type);
    const fill = type === 'area'; const indexAxis = type === 'horizontalBar' ? 'y' : 'x';
    const datasets = ys.map((o, k) => ({ label: o.name, data: data.map((r) => num(r[o.i])), borderColor: CHART_PALETTE[k % CHART_PALETTE.length], backgroundColor: cfgType === 'line' ? CHART_PALETTE[k % CHART_PALETTE.length] + '33' : CHART_PALETTE[k % CHART_PALETTE.length], fill, tension: 0.25, pointRadius: 2, borderWidth: 2 }));
    return { type: cfgType, data: { labels, datasets }, options: { ...common, indexAxis, scales: { x: { ticks: { color: text, maxRotation: 55, autoSkip: true }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid } } } } };
  }
  async function renderChartCanvas(container, type, columns, rows, spec, opts = {}) {
    container.innerHTML = '';
    const Chart = await loadChartLib();
    if (!Chart) { container.appendChild(el('div', 'docker-err', 'Библиотека графиков не загрузилась')); return null; }
    const wrap = el('div', 'db-chart-canvaswrap'); const canvas = document.createElement('canvas'); wrap.appendChild(canvas); container.appendChild(wrap);
    let instance = null;
    try { instance = new Chart(canvas, buildChartConfig(type, columns, rows, spec)); }
    catch (e) { container.innerHTML = ''; container.appendChild(el('div', 'docker-err', 'Не построить график: ' + (e.message || e))); return null; }
    if (opts.download) { const dl = iconBtn('db-chart-dl', 'download', 'Скачать PNG', 14); dl.onclick = () => downloadCanvas(canvas, (spec.title || 'chart')); wrap.appendChild(dl); }
    if (rows.length > 100) container.appendChild(el('div', 'db-er-note', `показаны первые 100 из ${rows.length} строк`));
    return { instance, canvas };
  }
  function downloadCanvas(canvas, name) { try { const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = (name || 'chart').replace(/[^\w.-]+/g, '_') + '.png'; a.click(); } catch (_) { toast('Не удалось сохранить картинку', { kind: 'err' }); } }
  // destroy Chart.js instances under a root before it's torn down (avoids leaking instances)
  function destroyChartsIn(root) { if (!_ChartLib || !root) return; root.querySelectorAll('canvas').forEach((cv) => { const c = _ChartLib.getChart && _ChartLib.getChart(cv); if (c) { try { c.destroy(); } catch (_) {} } }); }
  function openChart(columns, colTypes, rows) {
    if (!rows || !rows.length) { toast('Нет данных для графика'); return; }
    const { m } = makeModal('<h2>График</h2>', () => { if (cur && cur.instance) { try { cur.instance.destroy(); } catch (_) {} } }); m.classList.add('db-modal', 'db-chart-modal');
    const ctrls = el('div', 'db-chart-ctrls'); m.appendChild(ctrls);
    const area = el('div', 'db-chart-area'); m.appendChild(area);
    const lab = (t, node) => { const w = el('div', 'db-field'); w.append(el('label', null, t), node); return w; };
    const tSel = el('select'); CHART_TYPES.forEach((t) => tSel.appendChild(new Option(t.label, t.id)));
    const xSel = el('select'); columns.forEach((c) => xSel.appendChild(new Option(c, c)));
    const ySel = el('select'); columns.forEach((c, i) => { if (!colTypes || colTypes[i] === 'number') ySel.appendChild(new Option(c, c)); }); if (!ySel.options.length) columns.forEach((c) => ySel.appendChild(new Option(c, c)));
    const dl = el('button', 'btn', 'Скачать PNG');
    ctrls.append(lab('Тип', tSel), lab('Ось X', xSel), lab('Ось Y', ySel), dl);
    let cur = null;
    const draw = async () => { if (cur && cur.instance) { try { cur.instance.destroy(); } catch (_) {} } cur = await renderChartCanvas(area, tSel.value, columns, rows, { x: xSel.value, y: [ySel.value], title: '' }); };
    [tSel, xSel, ySel].forEach((s) => s.onchange = draw);
    dl.onclick = () => { if (cur && cur.canvas) downloadCanvas(cur.canvas, 'chart'); };
    draw();
  }
  function copyInList(colName, ci, rows) {
    const vals = [...new Set(rows.map((r) => r[ci]).filter((v) => v != null))];
    navigator.clipboard.writeText(`${qIdent(colName)} IN (${vals.map(lit).join(', ')})`); toast(`Скопировано значений: ${vals.length}`);
  }
  function copyResultAs(fmt, columns, rows, name) {
    let text = '';
    if (fmt === 'markdown') { text = '| ' + columns.join(' | ') + ' |\n| ' + columns.map(() => '---').join(' | ') + ' |\n' + rows.map((r) => '| ' + r.map((v) => v == null ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |').join('\n'); }
    else if (fmt === 'csv') { const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); text = [columns.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n'); }
    else if (fmt === 'json') { text = JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2); }
    else { text = rows.map((r) => `INSERT INTO ${name || 'tbl'} (${columns.join(', ')}) VALUES (${r.map(lit).join(', ')});`).join('\n'); }
    navigator.clipboard.writeText(text); toast(`Скопировано строк: ${rows.length}`);
  }
  // reverse-FK: tables whose foreign key points at t.table.colName → open filtered by the value
  async function showUsages(t, colName, val) {
    const rels = await getRelations();
    const refs = rels.filter((r) => r.toTable === t.table && (r.toSchema || t.schema) === t.schema && r.toColumn === colName);
    if (!refs.length) { toast('Нет таблиц, ссылающихся на ' + t.table + '.' + colName); return; }
    if (refs.length === 1) { const r = refs[0]; openTableFiltered(r.fromSchema || t.schema, r.fromTable, `${qIdent(r.fromColumn)} = ${lit(val)}`); return; }
    const items = refs.map((r) => ({ label: `${r.fromTable}.${r.fromColumn}`, action: () => openTableFiltered(r.fromSchema || t.schema, r.fromTable, `${qIdent(r.fromColumn)} = ${lit(val)}`) }));
    const x = (innerWidth / 2) | 0, y = 120; showMenu(x, y, items);
  }
  function autorun(sqlText) { openSqlTab(sqlText); const t = tabs[tabs.length - 1]; setTimeout(() => runSql(t), 60); }
  async function insertTemplate(schema, table) {
    const meta = await getMeta(schema, table); if (meta.error) { toast(meta.error, { kind: 'err' }); return; }
    const cols = meta.columns.filter((c) => !c.autoinc);
    const sqlText = `INSERT INTO ${qual(schema, table)} (${cols.map((c) => qIdent(c.name)).join(', ')})\nVALUES (${cols.map((c) => c.nullable ? 'NULL' : `''`).join(', ')});`;
    openSqlTab(sqlText);
  }

  // ============================================================ export (full table / current result)
  // DataGrip-style: many formats, custom dropdown, remembered destination dir, copy-to-clipboard.
  const EXPORT_FORMATS = [
    { id: 'csv', ext: 'csv', label: 'CSV', desc: 'значения через запятую' },
    { id: 'tsv', ext: 'tsv', label: 'TSV', desc: 'значения через табуляцию' },
    { id: 'json', ext: 'json', label: 'JSON', desc: 'массив объектов' },
    { id: 'jsonl', ext: 'jsonl', label: 'JSON Lines', desc: 'по объекту на строку (NDJSON)' },
    { id: 'sql', ext: 'sql', label: 'SQL INSERT', desc: 'операторы INSERT' },
    { id: 'markdown', ext: 'md', label: 'Markdown', desc: 'таблица Markdown' },
    { id: 'html', ext: 'html', label: 'HTML', desc: '<table> для вставки' },
    { id: 'xml', ext: 'xml', label: 'XML', desc: '<rows><row>…' },
  ];
  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function formatResult(fmt, columns, rows, name) {
    const sqlV = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
    const cell = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (fmt === 'csv') { const esc = (v) => v == null ? '' : /[",\n]/.test(cell(v)) ? '"' + cell(v).replace(/"/g, '""') + '"' : cell(v); return [columns.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n'); }
    if (fmt === 'tsv') { const esc = (v) => cell(v).replace(/[\t\n\r]/g, ' '); return [columns.join('\t'), ...rows.map((r) => r.map(esc).join('\t'))].join('\n'); }
    if (fmt === 'json') return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
    if (fmt === 'jsonl') return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, r[i]])))).join('\n');
    if (fmt === 'sql') return rows.map((r) => `INSERT INTO ${name || 'tbl'} (${columns.map(qIdent).join(', ')}) VALUES (${r.map(sqlV).join(', ')});`).join('\n');
    if (fmt === 'markdown') return '| ' + columns.join(' | ') + ' |\n| ' + columns.map(() => '---').join(' | ') + ' |\n' + rows.map((r) => '| ' + r.map((v) => cell(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |').join('\n');
    if (fmt === 'html') return `<table>\n  <thead><tr>${columns.map((c) => `<th>${xmlEsc(c)}</th>`).join('')}</tr></thead>\n  <tbody>\n${rows.map((r) => '    <tr>' + r.map((v) => `<td>${xmlEsc(cell(v))}</td>`).join('') + '</tr>').join('\n')}\n  </tbody>\n</table>`;
    if (fmt === 'xml') return `<rows>\n${rows.map((r) => '  <row>' + columns.map((c, i) => `<${c}>${xmlEsc(cell(r[i]))}</${c}>`).join('') + '</row>').join('\n')}\n</rows>`;
    return '';
  }
  // lightweight custom dropdown (styled) — value/label/desc; calls onChange(id)
  function customSelect(options, value, onChange) {
    const wrap = el('div', 'db-csel'); let cur = value;
    const btn = el('button', 'db-csel-btn');
    const lab = el('span', 'db-csel-lab'); const car = icon('chevron-down', 13); car.classList.add('db-csel-car');
    btn.append(lab, car);
    const menu = el('div', 'db-csel-menu hidden');
    const paint = () => { const o = options.find((x) => x.id === cur) || options[0]; lab.textContent = o.label; };
    const closeMenu = () => { menu.classList.add('hidden'); document.removeEventListener('mousedown', onDoc); };
    const onDoc = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const hid = menu.classList.contains('hidden'); if (hid) { menu.classList.remove('hidden'); document.addEventListener('mousedown', onDoc); } else closeMenu(); };
    for (const o of options) {
      const it = el('div', 'db-csel-item' + (o.id === cur ? ' on' : ''));
      it.append(el('span', 'db-csel-item-lab', o.label)); if (o.desc) it.append(el('span', 'db-csel-item-desc', o.desc));
      it.onclick = () => { cur = o.id; paint(); menu.querySelectorAll('.db-csel-item.on').forEach((x) => x.classList.remove('on')); it.classList.add('on'); closeMenu(); onChange && onChange(o.id); };
      menu.appendChild(it);
    }
    paint(); wrap.append(btn, menu);
    return { element: wrap, get: () => cur };
  }
  async function exportTable(t) {
    toast('Выгрузка всей таблицы…');
    const r = await lite.db.fetchAll(dbActiveId, t.schema, t.table, { where: t.where, orderBy: t.orderBy, orderDir: t.orderDir });
    if (r.error) { toast(r.error, { kind: 'err' }); return; }
    openExportModal(r, t.table);
  }
  function openExportModal(result, name) {
    if (!result || !result.columns || !result.columns.length) { toast('Нет данных для экспорта'); return; }
    const { columns, rows } = result;
    const { m, close } = makeModal('<h2>Экспорт данных</h2>'); m.classList.add('db-modal', 'db-export-modal');
    m.appendChild(el('div', 'db-exp-sub', `${name || 'результат'} · строк: ${rows.length} · колонок: ${columns.length}`));
    let fmtId = dbUi.exportFmt && EXPORT_FORMATS.some((f) => f.id === dbUi.exportFmt) ? dbUi.exportFmt : 'csv';
    const fRow = el('div', 'db-exp-field'); fRow.append(el('label', null, 'Формат'));
    const sel = customSelect(EXPORT_FORMATS, fmtId, (id) => { fmtId = id; dbUi.exportFmt = id; saveDbUi(); refreshPreview(); });
    fRow.appendChild(sel.element); m.appendChild(fRow);
    const pRow = el('div', 'db-exp-field'); pRow.append(el('label', null, 'Папка сохранения'));
    const pathIn = el('input', 'db-exp-path'); pathIn.placeholder = 'по умолчанию — последняя'; pathIn.value = dbUi.exportDir || '';
    const browse = iconBtn('drow-act', 'folder', 'Выбрать папку', 14); browse.onclick = async () => { const d = await lite.db.chooseDir(); if (d && d.ok) { pathIn.value = d.path; dbUi.exportDir = d.path; saveDbUi(); } };
    const pWrap = el('div', 'db-exp-pathwrap'); pWrap.append(pathIn, browse); pRow.appendChild(pWrap); m.appendChild(pRow);
    const prev = el('pre', 'db-exp-preview');
    const refreshPreview = () => { const txt = formatResult(fmtId, columns, rows.slice(0, 30), name); prev.textContent = txt.length > 4000 ? txt.slice(0, 4000) + '\n…' : txt; };
    refreshPreview();
    m.appendChild(el('div', 'db-exp-prevhint', 'Предпросмотр (первые 30 строк)')); m.appendChild(prev);
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '12px';
    const copy = el('button', 'btn', 'Копировать в буфер'); copy.onclick = () => { const text = formatResult(fmtId, columns, rows, name); navigator.clipboard.writeText(text); toast(`Скопировано строк: ${rows.length}`); };
    const saveBtn = el('button', 'btn primary', 'Сохранить в файл…'); saveBtn.onclick = async () => {
      const fmt = EXPORT_FORMATS.find((f) => f.id === fmtId); const text = formatResult(fmtId, columns, rows, name);
      const dir = (pathIn.value || dbUi.exportDir || '').trim();
      const fname = `${name || 'export'}.${fmt.ext}`;
      const defPath = dir ? dir.replace(/[/\\]+$/, '') + '/' + fname : fname;
      const r = await lite.db.saveText(defPath, text);
      if (r && r.ok) { toast('Сохранено: ' + r.path, { ttl: 7000 }); const d = r.path.replace(/[/\\][^/\\]*$/, ''); if (d) { dbUi.exportDir = d; saveDbUi(); } close(); }
      else if (r && r.error) toast(r.error, { kind: 'err' });
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    acts.append(copy, saveBtn, cancel); m.appendChild(acts);
  }

  // ============================================================ SQL formatter (lightweight, no deps)
  function formatSql(s) {
    const kw = ['select', 'from', 'where', 'and', 'or', 'order by', 'group by', 'having', 'limit', 'offset', 'left join', 'right join', 'inner join', 'join', 'on', 'insert into', 'values', 'update', 'set', 'delete from', 'union all', 'union'];
    let out = s.replace(/\s+/g, ' ').trim();
    const breakBefore = ['from', 'where', 'order by', 'group by', 'having', 'limit', 'offset', 'left join', 'right join', 'inner join', 'join', 'union all', 'union', 'set', 'values'];
    for (const k of breakBefore) out = out.replace(new RegExp('\\s+' + k.replace(/ /g, '\\s+') + '\\b', 'gi'), '\n' + k.toUpperCase());
    out = out.replace(/\s+(and|or)\b/gi, '\n  $1');
    out = out.replace(/\bselect\b/gi, 'SELECT');
    return out;
  }

  // ============================================================ ER diagram (SVG, draggable)
  async function renderErTab(body, t) {
    const host2 = el('div', 'db-er'); body.appendChild(host2); host2.innerHTML = '<div class="git-loading">Чтение связей…</div>';
    const rel = await lite.db.relations(dbActiveId);
    host2.innerHTML = '';
    if (rel.error) { host2.appendChild(el('div', 'docker-err', rel.error)); return; }
    const relations = rel.relations || [];
    // collect tables (from schema) and their columns from cache
    const tableSet = new Set();
    for (const sch of (dbSchema?.schemas || [])) for (const tb of sch.tables) if (!tb.view) tableSet.add((sch.name ? sch.name + '.' : '') + tb.name);
    for (const r of relations) { tableSet.add((r.fromSchema ? r.fromSchema + '.' : '') + r.fromTable); tableSet.add((r.toSchema ? r.toSchema + '.' : '') + r.toTable); }
    const names = [...tableSet];
    if (!names.length) { host2.appendChild(el('div', 'docker-empty', 'Нет таблиц для диаграммы.')); return; }
    // grid layout
    const cols = Math.ceil(Math.sqrt(names.length)); const BW = 150, BH = 26, GX = 210, GY = 120;
    const pos = new Map();
    names.forEach((n, i) => pos.set(n, { x: 30 + (i % cols) * GX, y: 30 + Math.floor(i / cols) * GY }));
    const W = 60 + cols * GX, H = 80 + Math.ceil(names.length / cols) * GY;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('class', 'db-er-svg'); svg.setAttribute('width', W); svg.setAttribute('height', H);
    const linesG = document.createElementNS(svgNS, 'g'); svg.appendChild(linesG);
    const boxesG = document.createElementNS(svgNS, 'g'); svg.appendChild(boxesG);
    const fullKey = (s, tb) => (s ? s + '.' : '') + tb;
    function drawLines() {
      linesG.innerHTML = '';
      for (const r of relations) {
        const a = pos.get(fullKey(r.fromSchema, r.fromTable)), b = pos.get(fullKey(r.toSchema, r.toTable)); if (!a || !b) continue;
        const x1 = a.x + BW / 2, y1 = a.y + BH / 2, x2 = b.x + BW / 2, y2 = b.y + BH / 2;
        const path = document.createElementNS(svgNS, 'path');
        const mx = (x1 + x2) / 2;
        path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
        path.setAttribute('class', 'db-er-line'); linesG.appendChild(path);
      }
    }
    function drawBoxes() {
      boxesG.innerHTML = '';
      for (const n of names) {
        const p = pos.get(n);
        const g = document.createElementNS(svgNS, 'g'); g.setAttribute('transform', `translate(${p.x},${p.y})`); g.setAttribute('class', 'db-er-box');
        const rect = document.createElementNS(svgNS, 'rect'); rect.setAttribute('width', BW); rect.setAttribute('height', BH); rect.setAttribute('rx', 6); g.appendChild(rect);
        const txt = document.createElementNS(svgNS, 'text'); txt.setAttribute('x', 8); txt.setAttribute('y', 17); txt.textContent = n.includes('.') ? n.split('.').slice(-1)[0] : n; g.appendChild(txt);
        g.onmousedown = (e) => {
          e.preventDefault(); const sx = e.clientX, sy = e.clientY, ox = p.x, oy = p.y;
          const mv = (ev) => { p.x = ox + (ev.clientX - sx); p.y = oy + (ev.clientY - sy); g.setAttribute('transform', `translate(${p.x},${p.y})`); drawLines(); };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        };
        g.ondblclick = () => { const nm = n.includes('.') ? n.split('.').slice(-1)[0] : n; const sc = n.includes('.') ? n.split('.')[0] : null; openTableTab(sc, nm, false); };
        boxesG.appendChild(g);
      }
    }
    drawLines(); drawBoxes();
    const note = el('div', 'db-er-note', `${names.length} таблиц · ${relations.length} связей · тяните блоки, двойной клик — открыть`);
    host2.append(note, svg);
  }

  // ============================================================ query builder (visual)
  async function renderBuilderTab(body, t) {
    const host2 = el('div', 'db-qb'); body.appendChild(host2);
    host2.appendChild(el('div', 'db-qb-title', 'Конструктор запроса'));
    const tableSel = el('select', 'db-qb-sel');
    const all = [];
    for (const sch of (dbSchema?.schemas || [])) for (const tb of sch.tables) all.push({ schema: sch.name, table: tb.name });
    tableSel.appendChild(new Option('— выберите таблицу —', ''));
    for (const a of all) { const o = new Option((a.schema ? a.schema + '.' : '') + a.table, JSON.stringify(a)); tableSel.appendChild(o); }
    host2.append(labelWrap('Таблица', tableSel));
    const colsBox = el('div', 'db-qb-cols');
    const whereIn = el('input', 'db-qb-where'); whereIn.placeholder = 'условие WHERE (опц.)';
    const orderIn = el('input', 'db-qb-order'); orderIn.placeholder = 'ORDER BY (опц.)';
    const limitIn = el('input', 'db-qb-limit'); limitIn.type = 'number'; limitIn.value = '100'; limitIn.placeholder = 'LIMIT';
    const out = el('pre', 'db-qb-out');
    const build = () => {
      const sel = tableSel.value ? JSON.parse(tableSel.value) : null; if (!sel) { out.textContent = ''; return; }
      const checked = [...colsBox.querySelectorAll('input:checked')].map((x) => qIdent(x.value));
      const colList = checked.length ? checked.join(', ') : '*';
      let s = `SELECT ${colList}\nFROM ${qual(sel.schema, sel.table)}`;
      if (whereIn.value.trim()) s += `\nWHERE ${whereIn.value.trim()}`;
      if (orderIn.value.trim()) s += `\nORDER BY ${orderIn.value.trim()}`;
      if (limitIn.value.trim()) s += `\nLIMIT ${+limitIn.value || 100}`;
      out.textContent = s + ';';
    };
    tableSel.onchange = async () => {
      colsBox.innerHTML = ''; const sel = tableSel.value ? JSON.parse(tableSel.value) : null; if (!sel) { build(); return; }
      const meta = await getMeta(sel.schema, sel.table); if (meta.error) { build(); return; }
      for (const c of meta.columns) { const lab = el('label', 'db-qb-collabel'); const cb = el('input'); cb.type = 'checkbox'; cb.value = c.name; cb.onchange = build; lab.append(cb, document.createTextNode(' ' + c.name)); colsBox.appendChild(lab); }
      build();
    };
    [whereIn, orderIn, limitIn].forEach((x) => x.oninput = build);
    host2.append(el('div', 'db-qb-collabel-h', 'Колонки'), colsBox, labelWrap('WHERE', whereIn), labelWrap('ORDER BY', orderIn), labelWrap('LIMIT', limitIn));
    const actions = el('div', 'gm-actions');
    const openBtn = el('button', 'btn primary', 'Открыть в SQL-консоли'); openBtn.onclick = () => { if (out.textContent) openSqlTab(out.textContent); };
    const runBtn = el('button', 'btn', 'Выполнить'); runBtn.onclick = () => { if (out.textContent) autorun(out.textContent); };
    actions.append(openBtn, runBtn); host2.append(el('div', 'db-qb-out-h', 'SQL'), out, actions);
  }
  function labelWrap(label, node) { const w = el('div', 'db-field'); w.appendChild(el('label', null, label)); w.appendChild(node); return w; }

  // ============================================================ schema diff (two connections)
  async function renderDiffTab(body, t) {
    const host2 = el('div', 'db-diff'); body.appendChild(host2);
    host2.appendChild(el('div', 'db-qb-title', 'Сравнение схем'));
    const sel = el('select', 'db-qb-sel'); sel.appendChild(new Option('— другое подключение —', ''));
    try { const list = (await lite.db.list()).connections || []; for (const c of list) if (c.id !== dbActiveId) sel.appendChild(new Option(c.name, c.id)); } catch (_) {}
    host2.append(labelWrap('Сравнить с', sel));
    const go = el('button', 'btn primary', 'Сравнить'); host2.appendChild(go);
    const result = el('div', 'db-diff-result'); host2.appendChild(result);
    go.onclick = async () => {
      if (!sel.value) { toast('Выберите подключение'); return; }
      result.innerHTML = '<div class="git-loading">Сравниваю схемы…</div>';
      const [a, b] = await Promise.all([lite.db.columns(dbActiveId), lite.db.columns(sel.value)]);
      if (a.error || b.error) { result.innerHTML = ''; result.appendChild(el('div', 'docker-err', a.error || b.error)); return; }
      result.innerHTML = '';
      const A = a.columns || {}, B = b.columns || {};
      const allTables = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
      const diffList = [];
      for (const name of allTables) {
        const ca = A[name], cb = B[name];
        if (!cb) diffList.push({ name, status: 'только здесь' });
        else if (!ca) diffList.push({ name, status: 'только там' });
        else { const sa = new Set(ca), sb = new Set(cb); const onlyA = ca.filter((x) => !sb.has(x)), onlyB = cb.filter((x) => !sa.has(x)); if (onlyA.length || onlyB.length) diffList.push({ name, status: 'различаются', onlyA, onlyB }); }
      }
      if (!diffList.length) { result.appendChild(el('div', 'docker-empty', 'Схемы идентичны по таблицам и колонкам.')); return; }
      const tbl = document.createElement('table'); tbl.className = 'db-struct-table';
      tbl.innerHTML = '<thead><tr><th>Таблица</th><th>Статус</th><th>Различия колонок</th></tr></thead>';
      const tb = document.createElement('tbody');
      for (const d of diffList) { const detail = d.status === 'различаются' ? [d.onlyA.length ? '−тут: ' + d.onlyA.join(', ') : '', d.onlyB.length ? '+там: ' + d.onlyB.join(', ') : ''].filter(Boolean).join('; ') : ''; const tr = document.createElement('tr'); for (const v of [d.name, d.status, detail]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } tb.appendChild(tr); }
      tbl.appendChild(tb);
      const info = el('div', 'db-result-info'); info.append(el('span', null, `Расхождений: ${diffList.length}`));
      const migBtn = el('button', 'db-exp-btn', 'Сгенерировать миграцию →'); migBtn.title = 'ALTER/CREATE, приводящие текущую БД к выбранной'; migBtn.onclick = async () => { migBtn.textContent = 'Генерирую…'; const sqlText = await genMigration(diffList, sel.value); migBtn.textContent = 'Сгенерировать миграцию →'; openSqlTab('-- Миграция: текущая → ' + (sel.options[sel.selectedIndex].text) + '\n-- Просмотрите перед выполнением (DROP закомментированы)\n\n' + sqlText); };
      info.appendChild(migBtn);
      result.appendChild(info); result.appendChild(tbl);
    };
  }
  async function genMigration(diffs, targetId) {
    const out = [];
    for (const d of diffs) {
      const dot = d.name.indexOf('.'); const schema = dot >= 0 ? d.name.slice(0, dot) : null; const table = dot >= 0 ? d.name.slice(dot + 1) : d.name;
      if (d.status === 'только там') { const m = await lite.db.tableMeta(targetId, schema, table); out.push(m.error ? `-- не удалось получить DDL для ${d.name}: ${m.error}` : m.ddl); }
      else if (d.status === 'только здесь') { out.push(`-- DROP TABLE ${qual(schema, table)};  -- есть только в текущей БД`); }
      else {
        if (d.onlyB && d.onlyB.length) { const m = await lite.db.tableMeta(targetId, schema, table); const types = {}; if (!m.error) for (const c of m.columns) types[c.name] = c; for (const col of d.onlyB) { const c = types[col]; out.push(`ALTER TABLE ${qual(schema, table)} ADD COLUMN ${qIdent(col)} ${c ? c.type : 'text'}${c && !c.nullable ? ' NOT NULL' : ''};`); } }
        if (d.onlyA && d.onlyA.length) for (const col of d.onlyA) out.push(`-- ALTER TABLE ${qual(schema, table)} DROP COLUMN ${qIdent(col)};  -- есть только в текущей БД`);
      }
    }
    return out.join('\n');
  }

  // ============================================================ AI-DB (read-only chat with the database)
  let setWsViewFn = null;   // set by renderDbWorkspace so cards can switch back to «Рабочий стол»
  // per-connection chat: multiple named sessions (create / switch / delete) + persistence in dbUi.
  // session = { id, title, ts, messages[], _busy, _reqId, _streamEl }  (underscore = runtime-only)
  function aiData() {
    let d = aiChats.get(dbActiveId);
    if (!d) {
      const saved = (dbUi.aiSessions && dbUi.aiSessions[dbActiveId]) || null;
      const sessions = (saved && saved.length) ? saved.map((s) => ({ id: s.id, title: s.title, ts: s.ts, pinned: !!s.pinned, messages: s.messages || [] })) : [{ id: 's' + (++aiSeq), title: 'Новый чат', ts: Date.now(), pinned: false, messages: [] }];
      let activeId = (dbUi.aiActive && dbUi.aiActive[dbActiveId]) || sessions[0].id;
      if (!sessions.some((s) => s.id === activeId)) activeId = sessions[0].id;
      d = { sessions, activeId, agent: (dbUi.aiAgent || 'claude') };
      aiChats.set(dbActiveId, d);
    }
    return d;
  }
  function aiSession() { const d = aiData(); let s = d.sessions.find((x) => x.id === d.activeId); if (!s) { s = d.sessions[0]; d.activeId = s.id; } return s; }
  function serializeAiMsg(m) {
    if (m.role === 'result') return { role: 'result', sql: m.sql, chart: m.chart || null, columns: m.columns || null, colTypes: m.colTypes || null, rows: m.rows ? m.rows.slice(0, 200) : null, rowsTrunc: !!(m.rows && m.rows.length > 200), error: m.error || null, summary: m.summary || '' };
    return { role: m.role, text: m.text || '' };
  }
  function aiPersist() {
    const d = aiChats.get(dbActiveId); if (!d) return;
    dbUi.aiSessions = dbUi.aiSessions || {}; dbUi.aiActive = dbUi.aiActive || {};
    dbUi.aiSessions[dbActiveId] = d.sessions.map((s) => ({ id: s.id, title: s.title, ts: s.ts, pinned: !!s.pinned, messages: (s.messages || []).map(serializeAiMsg) }));
    dbUi.aiActive[dbActiveId] = d.activeId; saveDbUi();
  }
  function aiSessTitle(s) { if (s.title && s.title !== 'Новый чат') return s.title; const u = (s.messages || []).find((m) => m.role === 'user'); return (u && u.text) ? u.text.slice(0, 40) : 'Новый чат'; }
  function aiNewSession(host) { const d = aiData(); const s = { id: 's' + (++aiSeq), title: 'Новый чат', ts: Date.now(), messages: [] }; d.sessions.unshift(s); d.activeId = s.id; aiPersist(); renderAiChat(host); }
  function aiSwitchSession(host, id) { const d = aiData(); const cur = aiSession(); if (cur._reqId) { try { lite.dbai.abort(cur._reqId); } catch (_) {} cur._busy = false; cur._reqId = null; } d.activeId = id; aiPersist(); renderAiChat(host); }
  function aiDeleteSession(host, id) {
    const d = aiData(); const i = d.sessions.findIndex((x) => x.id === id); if (i < 0) return;
    const s = d.sessions[i]; if (s._reqId) { try { lite.dbai.abort(s._reqId); } catch (_) {} }
    d.sessions.splice(i, 1);
    if (!d.sessions.length) d.sessions.push({ id: 's' + (++aiSeq), title: 'Новый чат', ts: Date.now(), messages: [] });
    if (d.activeId === id) d.activeId = d.sessions[Math.max(0, i - 1)].id;
    aiPersist(); renderAiChat(host);
  }
  function aiTyping() { const w = el('div', 'db-ai-typing'); w.append(el('span', 'db-ai-dot'), el('span', 'db-ai-dot'), el('span', 'db-ai-dot')); return w; }
  const AI_SUGGEST = ['Какие таблицы есть в базе и сколько в них строк?', 'Покажи поля таблицы …', 'Сделай срез: топ-10 по …', 'Сколько записей за последний месяц?'];

  // compact schema doc for the agent: per-table columns (+ types/PK/FK where known), row estimates
  function buildAiSchemaDoc() {
    const dialect = dbActiveConn ? dbActiveConn.type : 'postgres';
    const lines = [`СУБД/диалект: ${DB_TYPES[dialect] || dialect}`];
    const rels = dbRelationsCache || [];
    const fkBy = new Map();
    for (const r of rels) { const k = (r.fromSchema ? r.fromSchema + '.' : '') + r.fromTable + '.' + r.fromColumn; fkBy.set(k, `${r.toTable}.${r.toColumn}`); }
    const est = (dbObjectsCache && dbObjectsCache.rowEstimates) || {};
    const cols = dbColsCache || {};
    const keys = Object.keys(cols).sort();
    if (!keys.length) return lines.join('\n') + '\n(схема ещё читается)';
    for (const key of keys) {
      const meta = metaCache.get(key); const rc = est[key];
      lines.push(`\n## ${key}${rc != null && rc >= 0 ? ` (~${humanCount(rc)} строк)` : ''}`);
      if (meta && meta.columns) { for (const c of meta.columns) lines.push(`- ${c.name} ${c.type || ''}${c.pk ? ' PK' : ''}${c.fk ? ` FK→${c.fk.table}.${c.fk.column}` : ''}${c.nullable === false ? ' NOT NULL' : ''}`.trim()); }
      else { for (const cn of cols[key]) { const fk = fkBy.get(key + '.' + cn); lines.push(`- ${cn}${fk ? ` FK→${fk}` : ''}`); } }
    }
    let doc = lines.join('\n');
    if (doc.length > 16000) doc = doc.slice(0, 16000) + '\n… (схема обрезана — спрашивайте конкретные таблицы)';
    return doc;
  }
  function buildAiPrompt(st) {
    const dialect = dbActiveConn ? (DB_TYPES[dbActiveConn.type] || dbActiveConn.type) : 'SQL';
    const sys = [
      'Ты — ассистент-аналитик базы данных, работающий СТРОГО НА ЧТЕНИЕ.',
      'Тебе дана структура всех таблиц. Помогай пользователю получать данные и понятные отчёты.',
      'ЖЁСТКИЕ ПРАВИЛА:',
      '1) НИКОГДА не предлагай изменяющие запросы (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/MERGE). Только SELECT / WITH / EXPLAIN.',
      `2) Диалект — ${dialect}: используй его синтаксис и правильное экранирование идентификаторов.`,
      '3) Если для ответа нужен запрос — выведи РОВНО ОДИН SQL в блоке ```sql … ```. Запрос будет показан пользователю и выполнен ТОЛЬКО после подтверждения. НЕ выдумывай результаты заранее, дождись данных.',
      '4) Ставь разумный LIMIT (напр. 200), если строк может быть много (кроме агрегатов COUNT/SUM/AVG/GROUP BY).',
      '5) ГРАФИКИ. Когда нужен график — добавь спецификацию в исполняемом блоке ```chart с JSON:',
      '   ```chart',
      '   {"type":"bar","x":"<колонка_меток>","y":["<числовая_колонка>"],"title":"<заголовок>"}',
      '   ```',
      '   Типы: bar, line, area, horizontalBar, pie, doughnut, radar, scatter. y — массив из 1+ ЧИСЛОВЫХ колонок (несколько = серии; для pie/doughnut/scatter берётся первая). Имена x/y — как столбцы в SELECT. Приложение само нарисует КАРТИНКУ (Chart.js, есть «Скачать PNG») по данным последнего выполненного запроса. Блок ```chart можно дать в том же сообщении с ```sql, ИЛИ отдельным сообщением уже ПОСЛЕ того, как увидишь результат. НЕ описывай график словами и не рисуй ASCII — только блок ```chart. (Альтернатива одной строкой: @chart bar x=col y=col1,col2.)',
      '6) ВЫБОР ФОРМАТА. Если пользователь НЕ указал формат, но ответ хорошо смотрелся бы графиком/таблицей — спроси формат через @ask с вариантами: «Текстом», «Таблицей» (если уместно), «Графиком». После выбора выдай нужное (для графика — SELECT + @chart). Если формат очевиден (короткий факт → текст; набор строк → таблица) — не спрашивай, выдай сразу.',
      '7) Если вопрос чисто справочный (например «какие поля у таблицы»), отвечай ТЕКСТОМ по схеме без запроса.',
      '8) После выполнения запроса тебе вернут результат (колонки + строки). Тогда дай краткий понятный вывод/отчёт на русском (markdown: заголовки, списки, выделения). Не дублируй всю таблицу — она уже показана пользователю.',
      '9) Если тебе не хватает данных или вопрос неоднозначен — НЕ ГАДАЙ. Задай уточняющий вопрос пользователю строго в формате (каждая директива с новой строки):',
      '@ask <твой короткий вопрос>     — если нужно выбрать ОДИН вариант;',
      '@askmulti <твой вопрос>         — если можно выбрать НЕСКОЛЬКО вариантов;',
      'затем перечисли варианты, каждый с новой строки:',
      '@opt <вариант 1>',
      '@opt <вариант 2>',
      'Каждый @opt — короткий вариант (1–6 слов). Приложение само добавит поле «Свой ответ» и кнопку «Отправить» — их указывать не нужно. Используй этот механизм всегда, когда требуется уточнение.',
      '',
      '=== СТРУКТУРА БД ===',
      buildAiSchemaDoc(),
    ].join('\n');
    const convo = st.messages.map((m) => {
      if (m.role === 'assistant' && m.streaming) return '';   // skip the in-flight placeholder
      if (m.role === 'user') return `\n[ПОЛЬЗОВАТЕЛЬ]:\n${m.text}`;
      if (m.role === 'assistant') return `\n[ТЫ]:\n${m.text}`;
      if (m.role === 'result') return `\n[РЕЗУЛЬТАТ ВЫПОЛНЕНИЯ ЗАПРОСА]:\n${m.summary}`;
      return '';
    }).join('\n');
    return sys + '\n\n=== ДИАЛОГ ===' + convo + '\n\n[ТЫ]:';
  }
  function aiResultSummary(sql, r) {
    if (!r || r.error) return `Ошибка выполнения: ${(r && r.error) || 'неизвестно'}\nSQL: ${sql}`;
    const cols = r.columns || [], rows = r.rows || [];
    let s = `Запрос вернул строк: ${rows.length}. Колонки: ${cols.join(', ')}.`;
    if (rows.length) {
      const sample = rows.slice(0, 30).map((row) => cols.map((_, i) => { const v = fmtVal(row[i]); return v == null ? 'NULL' : v; }).join(' | ')).join('\n');
      s += `\nДанные (до 30 строк):\n${cols.join(' | ')}\n${sample}`;
      if (rows.length > 30) s += `\n… ещё ${rows.length - 30} строк`;
    }
    return s.slice(0, 8000);
  }
  // best-effort resolution of a chart spec against actual result columns (never silently drop)
  function resolveChartSpec(columns, colTypes, spec) {
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const find = (name) => {
      if (name == null) return null;
      let i = columns.indexOf(name); if (i >= 0) return columns[i];
      const lc = String(name).toLowerCase(); i = columns.findIndex((c) => c.toLowerCase() === lc); if (i >= 0) return columns[i];
      const n = norm(name); i = columns.findIndex((c) => norm(c) === n); return i >= 0 ? columns[i] : null;
    };
    const numericCols = columns.filter((c, i) => colTypes ? colTypes[i] === 'number' : true);
    let x = find(spec.x) || columns[0];
    let ys = (Array.isArray(spec.y) ? spec.y : [spec.y]).map(find).filter(Boolean);
    if (!ys.length) { ys = numericCols.filter((c) => c !== x).slice(0, 1); if (!ys.length) ys = [columns.find((c) => c !== x) || columns[0]]; }
    return { type: normChartType(spec.type), x, y: ys, title: spec.title || '' };
  }
  // parse assistant text → [{type:'md',text} | {type:'sql',sql,chart} | {type:'chart',chart} | {type:'ask',ask}]
  function parseAssistant(text) {
    text = String(text || '');
    let chart = null;
    // preferred: an executable ```chart JSON block ; fallback: a one-line @chart directive
    const fence = text.match(/```chart\s*([\s\S]*?)```/i);
    if (fence) { try { const j = JSON.parse(fence[1].trim()); chart = { type: j.type, x: j.x, y: Array.isArray(j.y) ? j.y : [j.y].filter((v) => v != null), title: j.title || '' }; } catch (_) {} text = text.replace(fence[0], ''); }
    if (!chart) { const cm = text.match(/@chart\s+(\w[\w-]*)\s+x=(\S+)\s+y=(\S+)(?:\s+title=([^\n]+))?/i); if (cm) { chart = { type: cm[1], x: cm[2], y: cm[3].split(',').map((s) => s.trim()).filter(Boolean), title: (cm[4] || '').trim() }; text = text.replace(cm[0], ''); } }
    // clarification directive: @ask (single) / @askmulti (multiple) + @opt lines
    let ask = null;
    const askM = text.match(/^[ \t>*-]*@(askmulti|ask)[:\s]+(.+)$/im);
    if (askM) {
      const opts = []; const re = /^[ \t>*-]*@opt[:\s]+(.+)$/gim; let mm;
      while ((mm = re.exec(text))) opts.push(mm[1].trim());
      ask = { question: askM[2].trim(), options: opts, multi: askM[1].toLowerCase() === 'askmulti' };
      text = text.replace(/^[ \t>*-]*@(?:askmulti|ask)[:\s]+.*$/im, '').replace(/^[ \t>*-]*@opt[:\s]+.*$/gim, '');
    }
    const parts = []; const re = /```sql\s*([\s\S]*?)```/gi; let last = 0, m, attached = false;
    while ((m = re.exec(text))) { if (m.index > last) parts.push({ type: 'md', text: text.slice(last, m.index) }); parts.push({ type: 'sql', sql: m[1].trim(), chart: attached ? null : chart }); attached = true; last = re.lastIndex; }
    if (last < text.length) parts.push({ type: 'md', text: text.slice(last) });
    if (ask) parts.push({ type: 'ask', ask });
    if (chart && !attached) parts.push({ type: 'chart', chart });   // standalone → render from last result
    return parts;
  }
  // render agent markdown to sanitized HTML (defense-in-depth: CSP blocks scripts, we still
  // strip dangerous tags / on*-handlers / non-allowlisted URL schemes — same pattern as openrouter.js)
  function mdInto(node, src) {
    let html;
    try { html = marked.parse(String(src || ''), { gfm: true, breaks: true }); } catch (_) { node.textContent = src || ''; return; }
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
    tpl.content.querySelectorAll('*').forEach((n) => {
      [...n.attributes].forEach((a) => {
        const name = a.name.toLowerCase();
        if (name.startsWith('on')) { n.removeAttribute(a.name); return; }
        if (name === 'href' || name === 'src') {
          let proto = ''; try { proto = new URL(a.value, location.href).protocol; } catch (_) { n.removeAttribute(a.name); return; }
          const ok = (name === 'src') ? ['http:', 'https:', 'data:'] : ['http:', 'https:', 'mailto:'];
          if (!ok.includes(proto)) n.removeAttribute(a.name);
        }
      });
    });
    node.innerHTML = tpl.innerHTML;
  }

  // ── AI providers (global, shared by all DBs): CLI (claude/codex) + OpenAI-compatible APIs
  //    (OpenRouter / Ollama / LM Studio). Config persists under STORE.dbaiProviders.
  function aiProviders() {
    const p = (STORE.dbaiProviders && typeof STORE.dbaiProviders === 'object') ? STORE.dbaiProviders : {};
    return {
      openrouter: { key: (p.openrouter && p.openrouter.key) || '', models: (p.openrouter && p.openrouter.models) || [] },
      ollama: { baseUrl: (p.ollama && p.ollama.baseUrl) || 'http://localhost:11434', models: (p.ollama && p.ollama.models) || [] },
      lmstudio: { baseUrl: (p.lmstudio && p.lmstudio.baseUrl) || 'http://localhost:1234', models: (p.lmstudio && p.lmstudio.models) || [] },
    };
  }
  function saveProviders(cfg) { persist('dbaiProviders', cfg); }
  function parseAgentId(id) { const i = String(id).indexOf('::'); return i < 0 ? { kind: id, model: null } : { kind: id.slice(0, i), model: id.slice(i + 2) }; }
  function providerEndpoint(kind) {
    const c = aiProviders();
    if (kind === 'or') return { base: 'https://openrouter.ai/api/v1', key: c.openrouter.key };
    if (kind === 'ollama') return { base: c.ollama.baseUrl.replace(/\/+$/, '') + '/v1', key: '' };
    if (kind === 'lmstudio') return { base: c.lmstudio.baseUrl.replace(/\/+$/, '') + '/v1', key: '' };
    return null;
  }
  const aiEnabled = (list, id) => list.some((x) => x.id === id);
  function aiToggleModel(list, m, on) { const i = list.findIndex((x) => x.id === m.id); if (on) { if (i < 0) list.push({ id: m.id, name: m.name || m.id }); } else if (i >= 0) list.splice(i, 1); }
  function aiModelRow(m, list, cfg, extra) {
    const row = el('div', 'db-prov-mrow');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = aiEnabled(list, m.id); cb.onchange = () => { aiToggleModel(list, m, cb.checked); saveProviders(cfg); };
    const lab = el('label', 'db-prov-mcheck'); lab.appendChild(cb);
    const info = el('div', 'db-prov-minfo'); info.appendChild(el('div', 'db-prov-mname', m.name || m.id));
    if (extra) info.appendChild(el('div', 'db-prov-mmeta', extra)); else info.appendChild(el('div', 'db-prov-mmeta', m.id));
    row.append(lab, info); return row;
  }
  function aiOrPanel(cfg) {
    const wrap = el('div', 'db-prov-panel');
    const keyRow = el('div', 'db-prov-field'); keyRow.appendChild(el('label', null, 'API-ключ OpenRouter'));
    const keyIn = el('input', 'db-prov-input'); keyIn.type = 'password'; keyIn.placeholder = 'sk-or-…'; keyIn.value = cfg.openrouter.key || '';
    keyIn.onchange = () => { cfg.openrouter.key = keyIn.value.trim(); saveProviders(cfg); };
    keyRow.appendChild(keyIn); wrap.appendChild(keyRow);
    const bar = el('div', 'db-prov-bar'); const load = el('button', 'btn', 'Загрузить модели'); const search = el('input', 'db-prov-search'); search.placeholder = 'Фильтр моделей…'; const status = el('span', 'db-prov-status'); bar.append(load, search, status); wrap.appendChild(bar);
    const list = el('div', 'db-prov-list'); wrap.appendChild(list);
    let all = cfg.openrouter.models.slice();
    const draw = () => { const q = search.value.trim().toLowerCase(); list.innerHTML = ''; const shown = (q ? all.filter((m) => (m.id + ' ' + (m.name || '')).toLowerCase().includes(q)) : all).slice(0, 400); if (!shown.length) { list.appendChild(el('div', 'db-prov-empty', 'Нажмите «Загрузить модели»')); return; } for (const m of shown) { const meta = []; if (m.context) meta.push(Math.round(m.context / 1000) + 'k ctx'); if (m.pricing && m.pricing.prompt) meta.push('$' + (+m.pricing.prompt * 1e6).toFixed(2) + '/M in'); if (m.pricing && m.pricing.completion) meta.push('$' + (+m.pricing.completion * 1e6).toFixed(2) + '/M out'); list.appendChild(aiModelRow(m, cfg.openrouter.models, cfg, meta.join(' · '))); } };
    search.oninput = draw;
    load.onclick = async () => { const key = keyIn.value.trim(); if (!key) { status.textContent = 'нужен ключ'; return; } status.textContent = 'загрузка…'; const r = await lite.openrouter.models(key); if (r && r.models) { all = r.models; status.textContent = all.length + ' моделей'; draw(); } else { status.textContent = (r && r.error) || 'ошибка'; } };
    draw(); return wrap;
  }
  function aiLocalPanel(kind, cfg) {
    const def = cfg[kind]; const fallback = kind === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234';
    const wrap = el('div', 'db-prov-panel');
    wrap.appendChild(el('div', 'db-prov-hint', kind === 'ollama' ? 'Запустите Ollama (команда «ollama serve»), модели ставятся через «ollama pull <модель>». Адрес по умолчанию — http://localhost:11434.' : 'В LM Studio откройте вкладку Developer и нажмите «Start Server». Адрес по умолчанию — http://localhost:1234.'));
    const urlRow = el('div', 'db-prov-field'); urlRow.appendChild(el('label', null, 'Адрес сервера'));
    const urlIn = el('input', 'db-prov-input'); urlIn.placeholder = fallback; urlIn.value = def.baseUrl || fallback; urlIn.onchange = () => { def.baseUrl = urlIn.value.trim() || fallback; saveProviders(cfg); };
    urlRow.appendChild(urlIn); wrap.appendChild(urlRow);
    const bar = el('div', 'db-prov-bar'); const load = el('button', 'btn', 'Проверить и загрузить'); const status = el('span', 'db-prov-status'); bar.append(load, status); wrap.appendChild(bar);
    const list = el('div', 'db-prov-list'); wrap.appendChild(list);
    const draw = (models) => { list.innerHTML = ''; if (!models.length) { list.appendChild(el('div', 'db-prov-empty', 'Моделей не найдено — загрузите/установите модель на сервере')); return; } for (const m of models) list.appendChild(aiModelRow(m, def.models, cfg)); };
    load.onclick = async () => { const base = (urlIn.value.trim() || fallback).replace(/\/+$/, '') + '/v1'; status.textContent = 'проверка…'; const r = await lite.dbai.apiModels({ baseUrl: base }); if (r && r.models) { status.className = 'db-prov-status ok'; status.textContent = '✓ ' + r.models.length + ' моделей'; draw(r.models); } else { status.className = 'db-prov-status err'; status.textContent = (r && r.error) || 'нет связи'; draw(def.models); } };
    draw(def.models); return wrap;
  }
  function openProvidersModal(host) {
    const cfg = aiProviders();
    const { m, close } = makeModal('<h2>Модели и провайдеры</h2>'); m.classList.add('db-modal', 'db-prov-modal');
    m.appendChild(el('div', 'db-prov-sub', 'Глобальные настройки — общие для всех баз. Отмеченные модели появятся в выпадашке выбора агента (OpenRouter с префиксом «OR»).'));
    const tabsEl = el('div', 'db-prov-tabs'); const bodyEl = el('div', 'db-prov-bodywrap');
    const panels = { openrouter: () => aiOrPanel(cfg), ollama: () => aiLocalPanel('ollama', cfg), lmstudio: () => aiLocalPanel('lmstudio', cfg) };
    let active = 'openrouter';
    const paint = () => { bodyEl.innerHTML = ''; bodyEl.appendChild(panels[active]()); [...tabsEl.children].forEach((b) => b.classList.toggle('on', b.dataset.k === active)); };
    for (const [k, lbl] of [['openrouter', 'OpenRouter'], ['ollama', 'Ollama'], ['lmstudio', 'LM Studio']]) { const b = el('button', 'db-prov-tab', lbl); b.dataset.k = k; b.onclick = () => { active = k; paint(); }; tabsEl.appendChild(b); }
    m.append(tabsEl, bodyEl);
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '12px'; const done = el('button', 'btn primary', 'Готово'); done.onclick = () => { close(); renderAiChat(host); }; acts.appendChild(done); m.appendChild(acts);
    paint();
  }
  const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  function aiDayKey(ts) { const dt = new Date(ts || 0); return dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate(); }
  function aiDateLabel(ts) { const dt = new Date(ts || 0); return `${dt.getDate()} ${RU_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`; }
  function aiSessionRow(s, d, host) {
    const row = el('div', 'db-ai-sess' + (s.id === d.activeId ? ' on' : ''));
    if (s.pinned) row.appendChild(icon('pin', 12));
    row.appendChild(el('div', 'db-ai-sess-t', aiSessTitle(s)));
    const acts = el('div', 'db-ai-sess-acts');
    const pin = iconBtn('db-ai-sess-act' + (s.pinned ? ' on' : ''), 'pin', s.pinned ? 'Открепить' : 'Закрепить', 13); pin.onclick = (e) => { e.stopPropagation(); s.pinned = !s.pinned; aiPersist(); renderAiChat(host); };
    const del = iconBtn('db-ai-sess-act danger', 'trash', 'Удалить сессию', 13); del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить сессию?', `Сессия «${aiSessTitle(s)}» будет удалена безвозвратно.`, 'Удалить', () => aiDeleteSession(host, s.id)); };
    acts.append(pin, del); row.appendChild(acts);
    row.onclick = () => { if (s.id !== d.activeId) aiSwitchSession(host, s.id); };
    return row;
  }
  function renderSessionList(list, d, host) {
    list.innerHTML = '';
    const pinned = d.sessions.filter((s) => s.pinned).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const others = d.sessions.filter((s) => !s.pinned).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (pinned.length) { list.appendChild(el('div', 'db-ai-sess-group', 'Закреплённые')); for (const s of pinned) list.appendChild(aiSessionRow(s, d, host)); }
    let lastKey = null;
    for (const s of others) { const k = aiDayKey(s.ts); if (k !== lastKey) { list.appendChild(el('div', 'db-ai-sess-group', aiDateLabel(s.ts))); lastKey = k; } list.appendChild(aiSessionRow(s, d, host)); }
  }
  function renderAiChat(host) {
    const d = aiData(); const st = aiSession(); st._streamEl = null;
    destroyChartsIn(host);
    host.innerHTML = '';
    // ── left: sessions column (collapsible, state remembered) ──
    const collapsed = !!dbUi.aiSessCollapsed;
    const toggleSess = () => { dbUi.aiSessCollapsed = !dbUi.aiSessCollapsed; saveDbUi(); renderAiChat(host); };
    const col = el('div', 'db-ai-sessions-col' + (collapsed ? ' collapsed' : ''));
    if (collapsed) {
      const exp = iconBtn('drow-act', 'chevron-right', 'Развернуть панель сессий', 16); exp.onclick = toggleSess;
      const nb = iconBtn('drow-act', 'plus', 'Новая сессия', 16); nb.onclick = () => aiNewSession(host);
      col.append(exp, nb);
    } else {
      const colHead = el('div', 'db-ai-sessions-head');
      const collapseBtn = iconBtn('drow-act', 'chevron-left', 'Свернуть панель', 15); collapseBtn.onclick = toggleSess;
      colHead.append(collapseBtn, el('span', 'db-ai-sessions-title', 'Сессии'));
      const newBtn = el('button', 'db-ai-sessnew'); newBtn.append(icon('plus', 13), el('span', null, 'Новый')); newBtn.title = 'Новая сессия'; newBtn.onclick = () => aiNewSession(host);
      colHead.appendChild(newBtn); col.appendChild(colHead);
      const slist = el('div', 'db-ai-sessions-list'); renderSessionList(slist, d, host); col.appendChild(slist);
    }
    // ── right: chat column ──
    const chat = el('div', 'db-ai-chat-col');
    const head = el('div', 'db-ai-head');
    head.append(icon('sparkles', 15), el('span', 'db-ai-title', 'Чат с базой'), el('span', 'db-ro-badge', 'read-only'));
    const sp = el('span'); sp.style.flex = '1'; head.appendChild(sp);
    const agentSel = el('select', 'db-ai-agent'); agentSel.title = 'Агент / модель';
    const addOpt = (val, label, parent) => { const o = document.createElement('option'); o.value = val; o.textContent = label; if (val === d.agent) o.selected = true; (parent || agentSel).appendChild(o); };
    addOpt('claude', 'Claude'); addOpt('codex', 'Codex');
    const pc = aiProviders();
    const grp = (label, models, prefix, kind) => { if (!models.length) return; const g = document.createElement('optgroup'); g.label = label; for (const mm of models) addOpt(kind + '::' + mm.id, prefix + ' ' + (mm.name || mm.id), g); agentSel.appendChild(g); };
    grp('OpenRouter', pc.openrouter.models, 'OR', 'or');
    grp('Ollama', pc.ollama.models, 'Ollama', 'ollama');
    grp('LM Studio', pc.lmstudio.models, 'LMStudio', 'lmstudio');
    const og = document.createElement('optgroup'); og.label = '—'; addOpt('__settings__', '⚙ Настроить модели…', og); agentSel.appendChild(og);
    agentSel.onchange = () => { if (agentSel.value === '__settings__') { agentSel.value = d.agent; openProvidersModal(host); return; } d.agent = agentSel.value; dbUi.aiAgent = agentSel.value; saveDbUi(); };
    head.append(agentSel);
    const log = el('div', 'db-ai-log');
    if (!st.messages.length) {
      const w = el('div', 'db-ai-welcome');
      w.append(el('div', 'db-ai-welcome-h', 'Спросите базу на обычном языке'), el('div', 'db-ai-welcome-s', 'Агент знает структуру всех таблиц, сам сформирует SELECT, покажет его и выполнит после вашего подтверждения. Только чтение — ничего не меняется.'));
      const chips = el('div', 'db-ai-chips');
      for (const s of AI_SUGGEST) { const c = el('button', 'db-ai-chip', s); c.onclick = () => { ta.value = s; ta.focus(); }; chips.appendChild(c); }
      w.appendChild(chips); log.appendChild(w);
    }
    for (const msg of st.messages) log.appendChild(renderAiMsg(msg, host));
    const inputBar = el('div', 'db-ai-inputbar');
    const ta = el('textarea', 'db-ai-input'); ta.placeholder = 'Спросите о данных… (Enter — отправить, Shift+Enter — перенос)'; ta.rows = 2; ta.disabled = !!st._busy;
    const send = el('button', 'btn primary db-ai-send'); send.textContent = st._busy ? 'Стоп' : 'Спросить';
    send.onclick = () => { if (st._busy) { lite.dbai.abort(st._reqId); return; } const v = ta.value.trim(); if (v) { ta.value = ''; aiSend(host, v); } };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.onclick(); } };
    inputBar.append(ta, send);
    chat.append(head, log, inputBar);
    host.append(col, chat);
    log.scrollTop = log.scrollHeight;
  }
  // small "copy whole message" button (raw text) shown top-right of a bubble
  function aiCopyBtn(text, title) { const b = iconBtn('db-ai-copy', 'copy', title || 'Копировать', 13); b.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(text || ''); toast('Скопировано'); }; return b; }
  function renderAiMsg(msg, host) {
    const st = aiSession();
    if (msg.role === 'user') { const w = el('div', 'db-ai-msg user'); const bub = el('div', 'db-ai-bubble'); bub.appendChild(el('div', 'db-ai-text', msg.text)); bub.appendChild(aiCopyBtn(msg.text, 'Копировать сообщение')); w.appendChild(bub); return w; }
    if (msg.role === 'result') return aiResultCard(msg, host);
    const w = el('div', 'db-ai-msg asst'); const bub = el('div', 'db-ai-bubble md');
    if (msg.streaming) { if (msg.text) bub.textContent = msg.text; else bub.appendChild(aiTyping()); st._streamEl = bub; }
    else {
      const parts = parseAssistant(msg.text || '');
      if (!parts.length) bub.textContent = '(пусто)';
      for (const p of parts) {
        if (p.type === 'md') { if (p.text.trim()) { const seg = el('div', 'db-ai-md'); mdInto(seg, p.text); bub.appendChild(seg); } }
        else if (p.type === 'ask') bub.appendChild(aiAskCard(host, p.ask));
        else if (p.type === 'chart') bub.appendChild(aiStandaloneChart(host, p.chart));
        else bub.appendChild(aiSqlCard(host, p.sql, p.chart));
      }
      if ((msg.text || '').trim()) bub.appendChild(aiCopyBtn(msg.text, 'Копировать ответ ИИ'));
    }
    w.appendChild(bub); return w;
  }
  // clarification card — Claude-terminal style: vertical option plaques (custom radio/checkbox),
  // a free-text «свой ответ» field, and a «Отправить» button. Single- or multi-select.
  function aiAskCard(host, ask) {
    const card = el('div', 'db-ai-askcard');
    const bar = el('div', 'db-ai-sqlbar'); bar.append(icon('sparkles', 13), el('span', 'db-ai-sqllabel', 'Нужно уточнение' + (ask.multi ? ' · можно выбрать несколько' : '')));
    card.appendChild(bar);
    if (ask.question) card.appendChild(el('div', 'db-ai-askq', ask.question));
    const opts = el('div', 'db-ai-askopts');
    const sel = new Set();
    const askName = 'dbaiask-' + (++aiSeq);   // unique radio group per card
    const send = el('button', 'btn primary db-ai-asksendbtn', 'Отправить');
    const refresh = () => { send.disabled = !(sel.size || customTa.value.trim()); };
    (ask.options || []).forEach((o) => {
      const row = el('label', 'db-ai-optrow');
      const inp = el('input', 'db-ai-optinput'); inp.type = ask.multi ? 'checkbox' : 'radio'; inp.name = askName;
      const box = el('span', 'db-ai-optbox' + (ask.multi ? '' : ' radio'));
      inp.onchange = () => { if (ask.multi) { inp.checked ? sel.add(o) : sel.delete(o); } else { sel.clear(); if (inp.checked) sel.add(o); } refresh(); };
      row.append(inp, box, el('span', 'db-ai-optlabel', o));
      opts.appendChild(row);
    });
    card.appendChild(opts);
    const customWrap = el('div', 'db-ai-customrow');
    const customTa = el('textarea', 'db-ai-custominput'); customTa.placeholder = 'Свой ответ…'; customTa.rows = 1;
    customTa.oninput = () => { customTa.style.height = 'auto'; customTa.style.height = Math.min(140, customTa.scrollHeight) + 'px'; refresh(); };
    customWrap.appendChild(customTa); card.appendChild(customWrap);
    const submit = () => { const parts = [...sel]; const c = customTa.value.trim(); if (c) parts.push(c); if (!parts.length) return; aiSend(host, parts.join(', ')); };
    customTa.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } };
    send.onclick = submit;
    const sendRow = el('div', 'db-ai-asksend'); sendRow.appendChild(send); card.appendChild(sendRow);
    refresh();
    return card;
  }
  // a chart the agent attached without (or after) the SQL → draw it from the latest result in the session
  function aiStandaloneChart(host, chart) {
    const st = aiSession();
    let data = null;
    for (let i = st.messages.length - 1; i >= 0; i--) { const m = st.messages[i]; if (m.role === 'result' && m.columns && m.rows && m.rows.length) { data = m; break; } }
    const wrap = el('div', 'db-ai-chart');
    if (!data) { wrap.appendChild(el('div', 'db-ai-warn', 'Нет данных для графика — сначала выполните запрос.')); return wrap; }
    const spec = resolveChartSpec(data.columns, data.colTypes, chart);
    renderChartCanvas(wrap, spec.type, data.columns, data.rows, spec, { download: true });
    return wrap;
  }
  function aiSqlCard(host, sql, chart) {
    const card = el('div', 'db-ai-sqlcard');
    const ro = isReadOnlyQuery(sql);
    const bar = el('div', 'db-ai-sqlbar'); bar.append(icon('terminal', 13), el('span', 'db-ai-sqllabel', ro ? 'Предложенный запрос (чтение)' : 'Запрос отклонён: не только чтение'));
    const pre = el('pre', 'db-ai-sql'); pre.textContent = sql;
    const acts = el('div', 'db-ai-sqlacts');
    const run = el('button', 'btn primary', 'Выполнить'); run.disabled = !ro; run.onclick = () => aiExecute(host, sql, chart);
    const edit = el('button', 'btn', 'Изменить'); edit.onclick = () => showPrompt('Правка запроса', 'SQL (только чтение):', sql, (v) => { if (v && v.trim()) aiExecute(host, v.trim(), chart); });
    const copy = iconBtn('drow-act', 'copy', 'Копировать', 13); copy.onclick = () => { navigator.clipboard.writeText(sql); toast('Скопировано'); };
    const toCon = iconBtn('drow-act', 'arrow-right', 'Открыть в SQL-консоли', 13); toCon.onclick = () => { openSqlTab(sql); if (setWsViewFn) setWsViewFn('desk'); };
    acts.append(run, edit, copy, toCon);
    card.append(bar, pre, acts);
    if (!ro) card.appendChild(el('div', 'db-ai-warn', 'Этот инструмент выполняет только читающие запросы.'));
    return card;
  }
  async function aiExecute(host, sql, chart) {
    if (!isReadOnlyQuery(sql)) { toast('Разрешены только читающие запросы (SELECT/WITH/EXPLAIN)', { kind: 'err' }); return; }
    const st = aiSession();
    const resMsg = { role: 'result', sql, chart, pending: true }; st.messages.push(resMsg); renderAiChat(host);
    const r = await lite.db.query(dbActiveId, sql);
    resMsg.pending = false;
    if (r && r.error) resMsg.error = r.error; else if (r) { resMsg.columns = r.columns; resMsg.colTypes = r.colTypes; resMsg.rows = r.rows; }
    resMsg.summary = aiResultSummary(sql, r || {});
    aiPersist(); renderAiChat(host);
    aiRun(host);   // feed the result back so the agent writes a conclusion / next step
  }
  function aiResultCard(msg, host) {
    const card = el('div', 'db-ai-resultcard');
    const bar = el('div', 'db-ai-resultbar');
    bar.append(icon('database', 13), el('span', 'db-ai-resultlabel', msg.pending ? 'Выполняется…' : (msg.error ? 'Ошибка' : `Результат · строк: ${(msg.rows || []).length}`)));
    const sp = el('span'); sp.style.flex = '1'; bar.appendChild(sp);
    if (!msg.pending && !msg.error && msg.columns) {
      const exp = iconBtn('drow-act', 'download', 'Экспорт / копирование', 13); exp.onclick = () => openExportModal({ columns: msg.columns, rows: msg.rows }, 'ai_query'); bar.appendChild(exp);
      if (msg.rows && msg.rows.length) { const chartBtn = iconBtn('drow-act', 'graph', 'График', 13); chartBtn.onclick = () => openChart(msg.columns, msg.colTypes, msg.rows); bar.appendChild(chartBtn); }
    }
    card.appendChild(bar);
    const sqlDet = el('details', 'db-ai-resultsql'); sqlDet.append(el('summary', null, 'SQL'), (() => { const p = el('pre', 'db-ai-sql'); p.textContent = msg.sql; return p; })()); card.appendChild(sqlDet);
    if (msg.pending) { card.appendChild(el('div', 'git-loading', 'Запрос выполняется…')); return card; }
    if (msg.error) { card.appendChild(el('div', 'docker-err', msg.error)); return card; }
    if (!msg.columns) { card.appendChild(el('div', 'db-ai-warn', 'Результат не сохранён — выполните запрос снова.')); return card; }
    if (msg.rowsTrunc) card.appendChild(el('div', 'db-ai-warn', 'Показаны первые 200 строк (полный результат не сохраняется).'));
    // chart (if the agent attached one) + collapsed table below — best-effort, never silently dropped
    let drewChart = false;
    if (msg.chart && msg.columns && msg.rows && msg.rows.length) {
      const spec = resolveChartSpec(msg.columns, msg.colTypes, msg.chart);
      const area = el('div', 'db-ai-chart'); card.appendChild(area); renderChartCanvas(area, spec.type, msg.columns, msg.rows, spec, { download: true }); drewChart = true;
    }
    const gridWrap = el('div', 'db-ai-grid'); card.appendChild(gridWrap);
    const grid = makeGrid({ columns: msg.columns, colTypes: msg.colTypes, rows: msg.rows, onCellMenu: (e, val, colName) => cellMenu(e, val, colName, null, null, msg.columns, null, null, { columns: msg.columns, rows: msg.rows }) });
    gridWrap.appendChild(grid.element);
    if (drewChart) gridWrap.classList.add('collapsed');
    return card;
  }
  function aiSend(host, text) { const st = aiSession(); if (!st.messages.some((m) => m.role === 'user')) st.title = text.slice(0, 40); st.ts = Date.now(); st.messages.push({ role: 'user', text }); aiPersist(); renderAiChat(host); aiRun(host); }
  async function aiRun(host) {
    const data = aiData(); const st = aiSession(); if (st._busy) return; st._busy = true;
    if (!dbColsCache) { const cr = await lite.db.columns(dbActiveId); if (cr && !cr.error) dbColsCache = cr.columns || {}; }
    if (!dbRelationsCache) { try { await getRelations(); } catch (_) {} }
    const asst = { role: 'assistant', text: '', streaming: true }; st.messages.push(asst);
    renderAiChat(host);
    const reqId = 'dbai-' + (++aiSeq) + '-' + dbActiveId; st._reqId = reqId;
    let offData, offDone, offErr;
    const cleanup = () => { offData && offData(); offDone && offDone(); offErr && offErr(); st._busy = false; st._reqId = null; };
    offData = lite.dbai.onData((d) => { if (d.reqId !== reqId) return; asst.text += d.chunk || ''; if (st._streamEl) { st._streamEl.textContent = asst.text; const log = host.querySelector('.db-ai-log'); if (log) log.scrollTop = log.scrollHeight; } });
    offDone = lite.dbai.onDone((d) => { if (d.reqId !== reqId) return; asst.streaming = false; cleanup(); aiPersist(); renderAiChat(host); });
    offErr = lite.dbai.onError((d) => { if (d.reqId !== reqId) return; asst.streaming = false; if (!asst.text) asst.text = '⚠️ ' + (d.error || 'ошибка агента'); cleanup(); aiPersist(); renderAiChat(host); toast(d.error || 'Ошибка агента', { kind: 'err' }); });
    const prompt = buildAiPrompt(st);
    const ag = parseAgentId(data.agent);
    if (ag.kind === 'claude' || ag.kind === 'codex') { lite.dbai.run(reqId, ag.kind, prompt); return; }
    // API providers (OpenRouter / Ollama / LM Studio)
    const ep = providerEndpoint(ag.kind);
    if (!ep || !ag.model) { offErr({ reqId, error: 'Провайдер не настроен. Откройте «⚙ Настроить модели…».' }); return; }
    if (ag.kind === 'or' && !ep.key) { offErr({ reqId, error: 'Не задан API-ключ OpenRouter (⚙ Настроить модели…).' }); return; }
    lite.dbai.apiRun(reqId, { baseUrl: ep.base, key: ep.key, model: ag.model, prompt });
  }

  function refresh() { dbSchema = null; dbColsCache = null; dbObjectsCache = null; metaCache.clear(); dbRelationsCache = null; invalidateTableCaches(); if (dbOpen) renderDbPanel(); }
  document.addEventListener('keydown', (e) => { if (dbOpen && dbActiveId && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette(); } });
  return { isOpen: () => dbOpen, setOpen: setDbOpen, toggle: toggleDb, renderPanel: renderDbPanel, refresh };
}
