// LiteEditor — модуль «Базы данных» (Postgres/MySQL/SQLite).
// IDE-уровень: дерево объектов (колонки/типы/PK/FK), вкладки таблиц и SQL-консолей,
// типизированный грид (сортировка/ресайз/выделение/копирование/просмотр ячейки/inline-edit),
// автокомплит SQL по схеме, ER-диаграмма, конструктор запросов, сравнение схем, история.
// Изоляция по образцу textproc.js: ядро — через host; UI-хелперы — из ui.js; бэкенд — window.lite.db.*.
import { el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt } from '../ui.js';
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

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
  function dbDispose() { destroyAllEditors(); }
  function saveDbUi() { persist('dbUi', dbUi); }
  function dbCatHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }

  // ---- dialect-aware quoting (renderer side, for inline-edit & query builder)
  function qIdent(id) { return dbActiveConn && dbActiveConn.type === 'mysql' ? '`' + String(id).replace(/`/g, '``') + '`' : '"' + String(id).replace(/"/g, '""') + '"'; }
  function qual(schema, table) { if (dbActiveConn && dbActiveConn.type === 'sqlite') return qIdent(table); return (schema ? qIdent(schema) + '.' : '') + qIdent(table); }
  function lit(v) { if (v == null) return 'NULL'; if (typeof v === 'number') return String(v); if (/^-?\d+(\.\d+)?$/.test(String(v))) return String(v); return "'" + String(v).replace(/'/g, "''") + "'"; }
  const DESTRUCTIVE_RE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|replace)\b/i;
  function isDestructiveSql(s) { const t = String(s).replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''"); return DESTRUCTIVE_RE.test(t); }
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
    m.classList.add('db-modal');
    const f = m.querySelector('#dbf');
    const field = (label, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, label)); w.appendChild(node); f.appendChild(w); return node; };
    const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
    const name = field('Имя', inp(c.name, 'Моя база'));
    const typeSel = el('select'); for (const [k, v] of Object.entries(DB_TYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === c.type) o.selected = true; typeSel.appendChild(o); }
    field('Тип', typeSel);
    const cat = field('Категория', inp(c.category || 'Все', 'Все'));
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
      const o = { id: c.id, name: name.value.trim(), type: typeSel.value, category: cat.value.trim() || 'Все', readOnly: ro.checked, color: colorSel.value, isProd: prod.checked };
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
    statusDot.onclick = async () => { statusDot.className = 'db-status-dot'; statusDot.title = 'Переподключение…'; const r = await lite.db.reconnect(dbActiveId); if (r && r.ok) { toast('Переподключено'); dbSchema = null; dbColsCache = null; dbObjectsCache = null; metaCache.clear(); pingNow(); renderDbWorkspace(body); } else { statusDot.classList.add('err'); toast((r && r.error) || 'Не удалось', { kind: 'err' }); } };
    pingNow();
    const tools = el('div', 'db-side-tools');
    const tNewSql = iconBtn('drow-act', 'terminal', 'Новый SQL-запрос', 15); tNewSql.onclick = () => openSqlTab();
    const tEr = iconBtn('drow-act', 'graph', 'ER-диаграмма', 15); tEr.onclick = () => openErTab();
    const tQb = iconBtn('drow-act', 'filter', 'Конструктор запроса', 15); tQb.onclick = () => openBuilderTab();
    const tDiff = iconBtn('drow-act', 'diff', 'Сравнить схемы', 15); tDiff.onclick = () => openDiffTab();
    const tRefresh = iconBtn('drow-act', 'refresh', 'Обновить схему', 15); tRefresh.onclick = () => { dbSchema = null; dbColsCache = null; dbObjectsCache = null; metaCache.clear(); dbRelationsCache = null; renderDbWorkspace(body); };
    tools.append(tNewSql, tEr, tQb, tDiff, tRefresh);
    side.appendChild(tools);
    const search = el('input', 'db-tree-search'); search.placeholder = 'Поиск объекта…'; search.value = dbUi.treeSearch || '';
    side.appendChild(search);
    const tree = el('div', 'db-tree'); side.appendChild(tree);
    // --- gutter ---
    const gut = el('div', 'db-side-gutter');
    // --- main (tabs) ---
    const main = el('div', 'db-main');
    const tabbar = el('div', 'db-tabbar'); tabbar.id = 'db-tabbar'; main.appendChild(tabbar);
    const tabbody = el('div', 'db-tabbody'); tabbody.id = 'db-tabbody'; main.appendChild(tabbody);
    ide.append(side, gut, main);
    body.appendChild(ide);

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
    const row = el('div', 'db-tree-table clickable');
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
  function setChev(node, name) { const nc = icon(name, 11); nc.classList.add('db-tcol-chev'); node.replaceWith(nc); nc.onclick = node.onclick; return nc; }
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
  function activate(key) { activeKey = key; const body = $('#db-tabbody'); const bar = $('#db-tabbar'); if (bar) renderTabBar(bar, body); if (body) renderTabBody(body); }
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
    if (!body) return; destroyTabEditors(); body.innerHTML = '';
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
  function destroyTabEditors() { /* table/SQL tabs recreate editors on render; SQL editor lives on tab.editor */ }
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
    const refr = iconBtn('drow-act', 'refresh', 'Обновить', 14); refr.onclick = () => renderTabBody($('#db-tabbody'));
    const chart = iconBtn('drow-act', 'graph', 'График', 14); chart.onclick = () => { if (t.lastResult) openChart(t.lastResult.columns, t.lastResult.colTypes, t.lastResult.rows); };
    const exp = iconBtn('drow-act', 'download', 'Экспорт всей таблицы', 14); exp.onclick = () => exportTable(t);
    bar.append(refr, chart, exp);
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
    gridWrap.innerHTML = '<div class="git-loading">Загрузка…</div>';

    const seq = ++dbRenderSeq;
    const r = await lite.db.tableData(dbActiveId, t.schema, t.table, { limit: DB_PAGE, offset: t.page * DB_PAGE, orderBy: t.orderBy, orderDir: t.orderDir, where: t.where });
    if (seq !== dbRenderSeq) return;
    gridWrap.innerHTML = '';
    if (r.error) { gridWrap.appendChild(el('div', 'docker-err', r.error)); return; }
    t.lastResult = r;
    const meta = metaCache.get((t.schema ? t.schema + '.' : '') + t.table) || await getMeta(t.schema, t.table);
    const editable = !dbActiveConn.readOnly && !t.view && meta && !meta.error && meta.columns.some((c) => c.pk);
    const pkNames = (meta && meta.columns ? meta.columns.filter((c) => c.pk).map((c) => c.name) : []);
    const grid = makeGrid({
      columns: r.columns, colTypes: r.colTypes, rows: r.rows,
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
  }

  // ---- edit buffer: pending edits / deletes / inserts → transactional commit
  function pendingCount(t) { const b = t.buffer; if (!b) return 0; return Object.keys(b.edits).length + b.deletes.size + b.inserts.filter((o) => Object.keys(o).length).length; }
  function clearBuffer(t) { t.buffer = { edits: {}, deletes: new Set(), inserts: [] }; }
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
      const doApply = async () => { const r = await lite.db.transaction(dbActiveId, stmts); if (r && r.ok) { toast(`Применено: ${r.count}`); clearBuffer(t); renderTabBody($('#db-tabbody')); } else toast((r && r.error) || 'Ошибка применения', { kind: 'err' }); };
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
    const wrap = el('div', 'db-grid');
    const tbl = document.createElement('table');
    // header
    const thead = document.createElement('thead'); const htr = document.createElement('tr');
    const corner = document.createElement('th'); corner.className = 'db-rownum-h'; corner.textContent = '#'; htr.appendChild(corner);
    columns.forEach((c, ci) => {
      const th = document.createElement('th'); th.className = 'db-c-' + (types[ci] || 'text');
      const lab = el('span', 'db-th-label', c); th.appendChild(lab);
      if (sortState && sortState.col === c) th.appendChild(el('span', 'db-sort', sortState.dir === 'asc' ? ' ▲' : ' ▼'));
      if (onSort) { lab.style.cursor = 'pointer'; lab.onclick = () => onSort(c); }
      if (opts.onHeaderMenu) th.oncontextmenu = (e) => { e.preventDefault(); opts.onHeaderMenu(e, c, ci); };
      const grip = el('span', 'db-col-grip'); th.appendChild(grip); colGrip(grip, th);
      htr.appendChild(th);
    });
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
      const spacerTop = document.createElement('tr'); const stc = document.createElement('td'); stc.colSpan = columns.length + 1; spacerTop.appendChild(stc);
      const spacerBot = document.createElement('tr'); const sbc = document.createElement('td'); sbc.colSpan = columns.length + 1; spacerBot.appendChild(sbc);
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
      rowv.forEach((v0, ci) => {
        const edited = buffer && buffer.edits[ri] && (columns[ci] in buffer.edits[ri]);
        const v = edited ? buffer.edits[ri][columns[ci]] : v0;
        const td = document.createElement('td'); td.className = 'db-c-' + (types[ci] || 'text'); td.dataset.r = ri; td.dataset.c = ci;
        if (edited) td.classList.add('db-edited');
        if (opts.fkCols && opts.fkCols.has(columns[ci]) && v != null) td.classList.add('db-fk');
        paintCell(td, v);
        td.onmousedown = (e) => { if (e.button !== 0) return; dragging = true; sel.clear(); anchor = [ri, ci]; cur = [ri, ci]; sel.add(cellKey(ri, ci)); paintSel(); reportSel(); showCellValue(v, columns[ci]); wrap.focus({ preventScroll: true }); };
        td.onmouseenter = () => { if (dragging && anchor) { sel.clear(); const [ar, ac] = anchor; for (let r = Math.min(ar, ri); r <= Math.max(ar, ri); r++) for (let c = Math.min(ac, ci); c <= Math.max(ac, ci); c++) sel.add(cellKey(r, c)); paintSel(); reportSel(); } };
        if (editable && buffer) td.ondblclick = () => startEdit(td, ri, ci, v, false);
        if (onCellMenu) td.oncontextmenu = (e) => { e.preventDefault(); onCellMenu(e, v, columns[ci], rowv, ri); };
        tr.appendChild(td);
      });
      return tr;
    }
    function insertRow(obj, ii) {
      const tr = document.createElement('tr'); tr.classList.add('db-row-insert');
      const rn = document.createElement('td'); rn.className = 'db-rownum'; rn.textContent = '＋'; tr.appendChild(rn);
      columns.forEach((col, ci) => {
        const td = document.createElement('td'); td.className = 'db-c-' + (types[ci] || 'text');
        const has = col in obj; paintCell(td, has ? obj[col] : null); if (!has) td.classList.add('db-null');
        td.ondblclick = () => startEditInsert(td, ii, col);
        tr.appendChild(td);
      });
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
      r = Math.max(0, Math.min(rows.length - 1, r)); c = Math.max(0, Math.min(columns.length - 1, c));
      if (extend && anchor) { sel.clear(); const [ar, ac] = anchor; for (let rr = Math.min(ar, r); rr <= Math.max(ar, r); rr++) for (let cc = Math.min(ac, c); cc <= Math.max(ac, c); cc++) sel.add(cellKey(rr, cc)); }
      else { sel.clear(); anchor = [r, c]; sel.add(cellKey(r, c)); }
      cur = [r, c]; ensureVisible(r); paintSel(); reportSel(); const rv = rows[r]; if (rv) showCellValue(rv[c], columns[c]);
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
        e.preventDefault(); if (!cur) cur = [0, 0]; let [r, c] = cur;
        if (e.key === 'ArrowUp') r--; else if (e.key === 'ArrowDown') r++; else if (e.key === 'ArrowLeft') c--; else if (e.key === 'ArrowRight') c++;
        else if (e.key === 'Home') { c = 0; if (e.ctrlKey) r = 0; } else if (e.key === 'End') { c = columns.length - 1; if (e.ctrlKey) r = rows.length - 1; }
        else if (e.key === 'PageUp') r -= 20; else if (e.key === 'PageDown') r += 20;
        setCur(r, c, e.shiftKey); return;
      }
      if (e.key === 'Escape') { sel.clear(); cur = null; paintSel(); reportSel(); return; }
      if (e.key === 'Enter' && editable && buffer && cur) { e.preventDefault(); const td = tb.querySelector(`td[data-r="${cur[0]}"][data-c="${cur[1]}"]`); if (td) startEdit(td, cur[0], cur[1], rows[cur[0]][cur[1]]); }
    });
    function addInsertRow() { if (!editable || !buffer) return; buffer.inserts.push({}); tb.appendChild(insertRow(buffer.inserts[buffer.inserts.length - 1], buffer.inserts.length - 1)); onBufferChange && onBufferChange(); }
    return { element: wrap, addInsertRow, selection: () => [...sel].map((k) => k.split(':').map(Number)) };
  }
  function colGrip(grip, th) {
    grip.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = th.getBoundingClientRect().width;
      const move = (ev) => { th.style.width = th.style.minWidth = th.style.maxWidth = Math.max(40, startW + ev.clientX - startX) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    };
  }

  // cell value viewer (bottom dock of the active grid host)
  function showCellValue(v, colName) {
    let dock = $('#db-cellview');
    const body = $('#db-tabbody'); if (!body) return;
    if (!dock) { dock = el('div', 'db-cellview'); dock.id = 'db-cellview'; body.appendChild(dock); }
    dock.innerHTML = '';
    const head = el('div', 'db-cellview-head'); head.append(el('span', 'db-cellview-col', colName || ''));
    const copy = iconBtn('drow-act', 'copy', 'Копировать значение', 12); copy.onclick = () => { navigator.clipboard.writeText(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v))); toast('Скопировано'); };
    const hide = iconBtn('drow-act', 'x', 'Скрыть', 12); hide.onclick = () => dock.remove();
    head.append(copy, hide); dock.appendChild(head);
    const pre = el('pre', 'db-cellview-body');
    if (v == null) { pre.textContent = 'NULL'; pre.classList.add('db-null'); }
    else if (typeof v === 'object') pre.textContent = JSON.stringify(v, null, 2);
    else { const s = String(v); try { if (/^\s*[[{]/.test(s)) { pre.textContent = JSON.stringify(JSON.parse(s), null, 2); pre.classList.add('db-json-pretty'); } else pre.textContent = s; } catch (_) { pre.textContent = s; } }
    dock.appendChild(pre);
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
    bar.appendChild(dbExportBar(() => t.lastResult, 'query'));
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
    const { m, close } = makeModal(`<h2>Изменить структуру: ${table}</h2><div class="db-ed"></div>`); m.classList.add('db-modal');
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
    const exec = el('button', 'btn primary', 'Выполнить'); exec.onclick = () => { if (!stmts.length) return; prodGuard(stmts.join(' '), async () => { const r = await lite.db.transaction(dbActiveId, stmts); if (r && r.ok) { toast('Применено'); close(); metaCache.delete((schema ? schema + '.' : '') + table); dbSchema = null; if (dbOpen) renderDbWorkspace($('#db-body')); } else toast((r && r.error) || 'Ошибка', { kind: 'err' }); }); };
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
    const { m } = makeModal(`<h2>Профайл колонки: ${colName}</h2><div id="dbprof" class="db-prof"><div class="git-loading">Считаю…</div></div>`); m.classList.add('db-modal');
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
  function openChart(columns, colTypes, rows) {
    if (!rows || !rows.length) { toast('Нет данных для графика'); return; }
    const { m } = makeModal('<h2>График</h2><div class="db-chart-ctrls"></div><div class="db-chart-area"></div>'); m.classList.add('db-modal', 'db-chart-modal');
    const ctrls = m.querySelector('.db-chart-ctrls'); const area = m.querySelector('.db-chart-area');
    const lab = (t, node) => { const w = el('div', 'db-field'); w.append(el('label', null, t), node); return w; };
    const xSel = el('select'); columns.forEach((c, i) => xSel.appendChild(new Option(c, i)));
    const ySel = el('select'); columns.forEach((c, i) => { if (!colTypes || colTypes[i] === 'number') ySel.appendChild(new Option(c, i)); });
    if (!ySel.options.length) columns.forEach((c, i) => ySel.appendChild(new Option(c, i)));
    const tSel = el('select'); tSel.append(new Option('Столбцы', 'bar'), new Option('Линия', 'line'));
    ctrls.append(lab('Ось X', xSel), lab('Ось Y', ySel), lab('Тип', tSel));
    const draw = () => renderChartSvg(area, rows, +xSel.value, +ySel.value, tSel.value);
    [xSel, ySel, tSel].forEach((s) => s.onchange = draw);
    draw();
  }
  function renderChartSvg(area, rows, xi, yi, type) {
    area.innerHTML = '';
    const all = rows.map((r) => ({ x: r[xi], y: Number(r[yi]) })).filter((d) => !Number.isNaN(d.y));
    if (!all.length) { area.appendChild(el('div', 'docker-empty', 'Колонка Y не числовая.')); return; }
    const data = all.slice(0, 60); const truncated = all.length > 60;
    const W = 640, H = 280, padL = 52, padB = 66, padT = 12, padR = 12;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxY = Math.max(...data.map((d) => d.y), 0), minY = Math.min(...data.map((d) => d.y), 0);
    const span = maxY - minY || 1; const yOf = (v) => padT + ih - (v - minY) / span * ih;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('class', 'db-chart-svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%');
    // axes + gridlines
    for (let g = 0; g <= 4; g++) { const v = minY + span * g / 4; const y = yOf(v); const ln = document.createElementNS(ns, 'line'); ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR); ln.setAttribute('y1', y); ln.setAttribute('y2', y); ln.setAttribute('class', 'db-chart-grid'); svg.appendChild(ln); const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', padL - 6); tx.setAttribute('y', y + 3); tx.setAttribute('class', 'db-chart-ylab'); tx.textContent = trimNum(v); svg.appendChild(tx); }
    const n = data.length; const step = iw / n;
    const everyX = Math.ceil(n / 12);
    if (type === 'bar') {
      data.forEach((d, i) => { const bw = Math.max(1, step * 0.7); const x = padL + i * step + (step - bw) / 2; const y = yOf(Math.max(0, d.y)); const h = Math.abs(yOf(d.y) - yOf(0)); const rc = document.createElementNS(ns, 'rect'); rc.setAttribute('x', x); rc.setAttribute('y', y); rc.setAttribute('width', bw); rc.setAttribute('height', Math.max(1, h)); rc.setAttribute('class', 'db-chart-bar'); const ttl = document.createElementNS(ns, 'title'); ttl.textContent = `${d.x}: ${d.y}`; rc.appendChild(ttl); svg.appendChild(rc); });
    } else {
      const pts = data.map((d, i) => `${padL + i * step + step / 2},${yOf(d.y)}`).join(' ');
      const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', pts); pl.setAttribute('class', 'db-chart-line'); svg.appendChild(pl);
      data.forEach((d, i) => { const cc = document.createElementNS(ns, 'circle'); cc.setAttribute('cx', padL + i * step + step / 2); cc.setAttribute('cy', yOf(d.y)); cc.setAttribute('r', 2.5); cc.setAttribute('class', 'db-chart-dot'); const ttl = document.createElementNS(ns, 'title'); ttl.textContent = `${d.x}: ${d.y}`; cc.appendChild(ttl); svg.appendChild(cc); });
    }
    data.forEach((d, i) => { if (i % everyX) return; const tx = document.createElementNS(ns, 'text'); const cx = padL + i * step + step / 2; tx.setAttribute('x', cx); tx.setAttribute('y', H - padB + 14); tx.setAttribute('class', 'db-chart-xlab'); tx.setAttribute('transform', `rotate(40 ${cx} ${H - padB + 14})`); tx.textContent = String(d.x == null ? '∅' : d.x).slice(0, 14); svg.appendChild(tx); });
    area.appendChild(svg);
    if (truncated) area.appendChild(el('div', 'db-er-note', `показаны первые 60 из ${all.length} строк`));
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
  function dbExportBar(getResult, name) {
    const wrap = el('div', 'db-export');
    for (const fmt of ['csv', 'json', 'sql']) { const b = el('button', 'db-exp-btn', fmt.toUpperCase()); b.title = 'Экспорт ' + fmt.toUpperCase(); b.onclick = (e) => { e.stopPropagation(); dbDoExport(getResult(), name, fmt); }; wrap.appendChild(b); }
    return wrap;
  }
  async function exportTable(t) {
    toast('Выгрузка всей таблицы…');
    const r = await lite.db.fetchAll(dbActiveId, t.schema, t.table, { where: t.where, orderBy: t.orderBy, orderDir: t.orderDir });
    if (r.error) { toast(r.error, { kind: 'err' }); return; }
    showMenu(innerWidth / 2, 120, [
      { label: `CSV (${r.rows.length} строк)`, action: () => dbDoExport(r, t.table, 'csv') },
      { label: `JSON (${r.rows.length} строк)`, action: () => dbDoExport(r, t.table, 'json') },
      { label: `SQL INSERT (${r.rows.length} строк)`, action: () => dbDoExport(r, t.table, 'sql') },
    ]);
  }
  async function dbDoExport(result, name, fmt) {
    if (!result || !result.columns || !result.columns.length) { toast('Нет данных для экспорта'); return; }
    const { columns, rows } = result; let text = '';
    if (fmt === 'csv') { const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); text = [columns.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n'); }
    else if (fmt === 'json') { text = JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2); }
    else { const qv = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'"; text = rows.map((r) => `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${r.map(qv).join(', ')});`).join('\n'); }
    const r = await lite.db.saveText(`${name}.${fmt}`, text);
    if (r && r.ok) toast('Сохранено: ' + r.path, { ttl: 7000 });
    else if (r && r.error) toast(r.error, { kind: 'err' });
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

  function refresh() { dbSchema = null; dbColsCache = null; dbObjectsCache = null; metaCache.clear(); dbRelationsCache = null; if (dbOpen) renderDbPanel(); }
  document.addEventListener('keydown', (e) => { if (dbOpen && dbActiveId && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette(); } });
  return { isOpen: () => dbOpen, setOpen: setDbOpen, toggle: toggleDb, renderPanel: renderDbPanel, refresh };
}
