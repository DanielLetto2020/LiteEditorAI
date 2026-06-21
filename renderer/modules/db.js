// LiteEditor — модуль «Базы данных» (Postgres/MySQL/SQLite) правого слота.
// Изолирован по образцу textproc.js: всё из ядра — через host, UI-хелперы — из ui.js,
// бэкенд — window.lite.db.* (драйверы в main, lib/db.js). CodeMirror-SQL импортируется здесь.
// host: { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels }
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// Right-pane lightweight DB client: connections grouped by category, schema tree, table data
// grid, SQL console (CodeMirror) and CSV/JSON/SQL export. Drivers live in main (lib/db.js).
export function initDb(host) {
  const { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let dbOpen = false;          // модуль баз данных справа открыт
  let dbConnsList = [], dbSecure = true;
  let dbActiveId = null, dbActiveConn = null, dbSchema = null;
  let dbWsTab = 'tree', dbTableSel = null, dbSqlEditor = null, dbLastResult = null, dbRenderSeq = 0;
  let dbUi = (STORE.dbUi && typeof STORE.dbUi === 'object') ? STORE.dbUi : {}; // {catCollapsed, treeOpen, lastSql}
  const DB_TYPES = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', sqlite: 'SQLite' };
  const DB_DEF_PORT = { postgres: 5432, mysql: 3306, sqlite: 0 };

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
  function dbDispose() { if (dbSqlEditor) { try { dbSqlEditor.destroy(); } catch (_) {} dbSqlEditor = null; } }
  function saveDbUi() { persist('dbUi', dbUi); }
  function dbCatHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }

  async function renderDbPanel() {
    const seq = ++dbRenderSeq;
    const body = $('#db-body');
    if (!dbActiveId) {
      body.innerHTML = '<div class="git-loading">Загрузка подключений…</div>';
      try { const r = await lite.db.list(); dbConnsList = r.connections || []; dbSecure = r.secure !== false; }
      catch (_) { dbConnsList = []; }
      if (seq !== dbRenderSeq || !dbOpen) return;
      renderDbConnections(body);
    } else {
      renderDbWorkspace(body);
    }
  }

  // ---- connections list (grouped by category, accordion + gradient, default «Все»)
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
    row.addEventListener('click', () => { dbActiveId = c.id; dbActiveConn = c; dbSchema = null; dbTableSel = null; dbWsTab = 'tree'; renderDbPanel(); });
    return row;
  }

  // ---- add/edit connection modal (host + SSH, безопасно)
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
    // host group
    const hostWrap = el('div', 'db-group');
    const host = inp(c.host || '', 'localhost'); const port = inp(c.port || DB_DEF_PORT[c.type] || '', '5432', 'number');
    const user = inp(c.user || '', 'пользователь'); const pass = inp('', existing ? '(без изменений)' : 'пароль', 'password');
    const database = inp(c.database || '', 'имя базы (опц.)');
    const ssl = el('input'); ssl.type = 'checkbox'; ssl.checked = !!c.ssl;
    const sslIns = el('input'); sslIns.type = 'checkbox'; sslIns.checked = !!c.sslInsecure;
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, lbl)); w.appendChild(node); return w; };
    const sslLabel = (() => { const w = el('label', 'db-check'); w.append(ssl, document.createTextNode(' Использовать SSL/TLS')); return w; })();
    const sslInsLabel = (() => { const w = el('label', 'db-check db-check-warn'); w.append(sslIns, document.createTextNode(' Доверять самоподписанному сертификату (небезопасно)')); return w; })();
    ssl.onchange = () => { sslInsLabel.style.display = ssl.checked ? '' : 'none'; };
    hostWrap.append(mk('Хост', host), mk('Порт', port), mk('Пользователь', user), mk('Пароль', pass), mk('База', database), sslLabel, sslInsLabel);
    f.appendChild(hostWrap);
    // sqlite group
    const sqliteWrap = el('div', 'db-group');
    const file = inp(c.file || c.database || '', '/путь/к/базе.sqlite');
    sqliteWrap.append(mk('Файл БД', file));
    f.appendChild(sqliteWrap);
    // SSH group
    const sshOn = el('input'); sshOn.type = 'checkbox'; sshOn.checked = !!c.sshEnabled;
    const sshLabel = el('label', 'db-check'); sshLabel.append(sshOn, document.createTextNode(' Подключаться через SSH-туннель'));
    f.appendChild(sshLabel);
    const sshWrap = el('div', 'db-group');
    const sshHost = inp(c.sshHost || '', 'ssh-хост'); const sshPort = inp(c.sshPort || 22, '22', 'number');
    const sshUser = inp(c.sshUser || '', 'ssh-пользователь'); const sshPass = inp('', existing ? '(без изменений)' : 'пароль/passphrase', 'password');
    sshWrap.append(mk('SSH хост', sshHost), mk('SSH порт', sshPort), mk('SSH пользователь', sshUser), mk('SSH пароль', sshPass));
    f.appendChild(sshWrap);
    // read-only
    const ro = el('input'); ro.type = 'checkbox'; ro.checked = !!c.readOnly;
    const roLabel = el('label', 'db-check'); roLabel.append(ro, document.createTextNode(' Только чтение (запрет изменяющих запросов)'));
    f.appendChild(roLabel);
    // visibility by type
    const syncType = () => {
      const t = typeSel.value;
      hostWrap.style.display = t === 'sqlite' ? 'none' : '';
      sqliteWrap.style.display = t === 'sqlite' ? '' : 'none';
      sshLabel.style.display = t === 'sqlite' ? 'none' : '';
      sshWrap.style.display = (t !== 'sqlite' && sshOn.checked) ? '' : 'none';
      sslInsLabel.style.display = (t !== 'sqlite' && ssl.checked) ? '' : 'none';
    };
    // Replace the port only when it's empty or still a known default (5432/3306) — keep custom ports.
    const DEF_PORTS = new Set(Object.values(DB_DEF_PORT).filter(Boolean));
    typeSel.onchange = () => { if (!port.value || DEF_PORTS.has(+port.value)) port.value = DB_DEF_PORT[typeSel.value] || ''; syncType(); };
    sshOn.onchange = syncType; syncType();
    // collect form → conn object (passwords only if typed)
    const collect = () => {
      const o = { id: c.id, name: name.value.trim(), type: typeSel.value, category: cat.value.trim() || 'Все', readOnly: ro.checked };
      if (typeSel.value === 'sqlite') { o.file = file.value.trim(); o.database = o.file; }
      else { o.host = host.value.trim(); o.port = +port.value || DB_DEF_PORT[typeSel.value]; o.user = user.value.trim(); o.database = database.value.trim(); o.ssl = ssl.checked; o.sslInsecure = sslIns.checked; o.sshEnabled = sshOn.checked; o.sshHost = sshHost.value.trim(); o.sshPort = +sshPort.value || 22; o.sshUser = sshUser.value.trim(); if (sshPass.value) o.sshPassword = sshPass.value; }
      if (pass.value) o.password = pass.value;
      return o;
    };
    // buttons
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const test = el('button', 'btn', 'Тест');
    test.onclick = async () => { status.textContent = 'Проверяю…'; status.className = 'db-test-status'; const r = await lite.db.test(collect()); if (r.ok) { status.textContent = '✓ ' + (r.version || 'подключение успешно'); status.classList.add('ok'); } else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); } };
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => { const o = collect(); if (!o.name) { toast('Введи имя', { kind: 'err' }); return; } const r = await lite.db.save(o); if (r && r.error) { toast(r.error, { kind: 'err' }); return; } close(); renderDbPanel(); };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
  }

  // ---- workspace (active connection): tabs «Объекты» / «SQL»
  function renderDbWorkspace(body) {
    body.innerHTML = '';
    const head = el('div', 'db-ws-head');
    const back = iconBtn('drow-act', 'chevron-left', 'К подключениям', 16);
    back.onclick = () => { dbActiveId = null; dbActiveConn = null; dbSchema = null; dbTableSel = null; dbDispose(); renderDbPanel(); };
    head.append(back, icon('database', 15), el('span', 'db-ws-name', dbActiveConn.name));
    if (dbActiveConn.readOnly) head.appendChild(el('span', 'db-ro-badge', 'только чтение'));
    body.appendChild(head);
    const tabs = el('div', 'docker-subtabs');
    for (const [k, label] of [['tree', 'Объекты'], ['sql', 'SQL']]) {
      const t = el('button', 'docker-subtab' + (dbWsTab === k ? ' on' : '')); t.textContent = label;
      t.onclick = () => { if (dbWsTab !== k) { dbWsTab = k; renderDbWorkspace(body); } };
      tabs.appendChild(t);
    }
    body.appendChild(tabs);
    const view = el('div', 'db-ws-view'); body.appendChild(view);
    if (dbWsTab === 'tree') renderDbTree(view); else renderDbSql(view);
  }

  async function renderDbTree(view) {
    dbDispose(); // no SQL editor needed on the objects tab — release the lingering CodeMirror
    if (dbTableSel) { renderDbTableView(view); return; }
    const seq = ++dbRenderSeq;
    view.innerHTML = '<div class="git-loading">Чтение схемы…</div>';
    if (!dbSchema) { const r = await lite.db.schema(dbActiveId); if (seq !== dbRenderSeq) return; if (r.error) { view.innerHTML = ''; view.appendChild(el('div', 'docker-err', r.error)); return; } dbSchema = r; }
    view.innerHTML = '';
    if (!dbSchema.schemas || !dbSchema.schemas.length) { view.appendChild(el('div', 'docker-empty', 'Нет таблиц.')); return; }
    for (const sch of dbSchema.schemas) view.appendChild(dbSchemaBlock(sch));
  }
  function dbSchemaBlock(sch) {
    const block = el('div', 'docker-sec');
    const k = dbActiveId + ':' + sch.name;
    const open = !(dbUi.treeOpen && dbUi.treeOpen[k] === false); // default open
    const head = el('button', 'docker-sec-head');
    const chev = icon(open ? 'chevron-down' : 'chevron-right', 13); chev.classList.add('dsec-chev');
    head.append(chev, icon('grid', 14), el('span', 'dsec-title', sch.name), el('span', 'dsec-count', String(sch.tables.length)));
    const list = el('div', 'docker-sec-body'); if (!open) list.style.display = 'none';
    for (const t of sch.tables) {
      const r = el('div', 'db-table-row clickable');
      r.append(icon(t.view ? 'eye' : 'box', 13), el('span', 'db-table-name', t.name));
      r.onclick = () => { dbTableSel = { schema: sch.name, table: t.name, page: 0 }; renderDbPanel(); };
      list.appendChild(r);
    }
    head.onclick = () => {
      dbUi.treeOpen = dbUi.treeOpen || {}; const cur = !(dbUi.treeOpen[k] === false); dbUi.treeOpen[k] = !cur; saveDbUi();
      list.style.display = dbUi.treeOpen[k] ? '' : 'none';
      const nc = icon(dbUi.treeOpen[k] ? 'chevron-down' : 'chevron-right', 13); nc.classList.add('dsec-chev'); head.replaceChild(nc, head.firstChild);
    };
    block.append(head, list);
    return block;
  }

  const DB_PAGE = 200;
  async function renderDbTableView(view) {
    const sel = dbTableSel;
    dbLastResult = null; // drop the previous table's data so a failed load can't be exported by mistake
    view.innerHTML = '';
    const bar = el('div', 'db-tablebar');
    const back = iconBtn('drow-act', 'chevron-left', 'К объектам', 15); back.onclick = () => { dbTableSel = null; renderDbPanel(); };
    bar.append(back, el('span', 'db-table-title', sel.table));
    bar.appendChild(dbExportBar(() => dbLastResult, sel.table));
    view.appendChild(bar);
    const grid = el('div', 'db-grid-wrap'); grid.innerHTML = '<div class="git-loading">Загрузка…</div>'; view.appendChild(grid);
    const pager = el('div', 'db-pager'); view.appendChild(pager);
    const seq = ++dbRenderSeq;
    const r = await lite.db.tableData(dbActiveId, sel.schema, sel.table, { limit: DB_PAGE, offset: sel.page * DB_PAGE });
    if (seq !== dbRenderSeq) return;
    grid.innerHTML = '';
    if (r.error) { grid.appendChild(el('div', 'docker-err', r.error)); return; }
    dbLastResult = r;
    grid.appendChild(dbGrid(r.columns, r.rows));
    const totalNum = r.total != null && !Number.isNaN(r.total) ? r.total : null;
    pager.appendChild(el('span', 'db-pageinfo', `${r.rows.length ? sel.page * DB_PAGE + 1 : 0}–${sel.page * DB_PAGE + r.rows.length} из ${totalNum != null ? totalNum : '?'}`));
    const prev = iconBtn('drow-act', 'chevron-left', 'Назад', 13); prev.disabled = sel.page <= 0; prev.onclick = () => { if (sel.page > 0) { sel.page--; renderDbPanel(); } };
    // Last page either when this page is short, or (total known) when the next offset is past the end —
    // avoids stepping onto an empty trailing page when the row count is an exact multiple of DB_PAGE.
    const next = iconBtn('drow-act', 'chevron-right', 'Вперёд', 13);
    next.disabled = r.rows.length < DB_PAGE || (totalNum != null && (sel.page + 1) * DB_PAGE >= totalNum);
    next.onclick = () => { sel.page++; renderDbPanel(); };
    pager.append(prev, next);
  }

  function dbGrid(columns, rows) {
    const wrap = el('div', 'db-grid');
    const tbl = document.createElement('table');
    const thead = document.createElement('thead'); const htr = document.createElement('tr');
    for (const c of columns) { const th = document.createElement('th'); th.textContent = c; htr.appendChild(th); }
    thead.appendChild(htr); tbl.appendChild(thead);
    const tb = document.createElement('tbody');
    for (const rowv of rows) {
      const tr = document.createElement('tr');
      for (const v of rowv) {
        const td = document.createElement('td');
        if (v === null || v === undefined) { td.textContent = 'NULL'; td.className = 'db-null'; }
        else { let s = typeof v === 'object' ? JSON.stringify(v) : String(v); if (s.length > 400) s = s.slice(0, 400) + '…'; td.textContent = s; td.title = s; }
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  // ---- SQL console (CodeMirror + run + results + export/import)
  function dbDialect() { return dbActiveConn.type === 'mysql' ? MySQL : dbActiveConn.type === 'sqlite' ? SQLite : PostgreSQL; }
  function renderDbSql(view) {
    view.innerHTML = '';
    const edWrap = el('div', 'db-sql-editor'); view.appendChild(edWrap);
    const bar = el('div', 'db-sql-bar');
    const run = el('button', 'btn primary db-run', '▶ Выполнить'); run.title = 'Ctrl+Enter'; run.onclick = dbRunSql;
    bar.appendChild(run);
    const imp = el('button', 'btn db-imp', '⬇ Импорт'); imp.title = 'Загрузить SQL-файл в редактор';
    imp.onclick = async () => { const r = await lite.db.openText(); if (r && r.ok && dbSqlEditor) dbSqlEditor.dispatch({ changes: { from: 0, to: dbSqlEditor.state.doc.length, insert: r.content } }); else if (r && r.error) toast(r.error, { kind: 'err' }); };
    bar.appendChild(imp);
    bar.appendChild(dbExportBar(() => dbLastResult, 'query'));
    view.appendChild(bar);
    const res = el('div', 'db-sql-result'); res.id = 'db-sql-result'; view.appendChild(res);
    if (dbSqlEditor) { try { dbSqlEditor.destroy(); } catch (_) {} dbSqlEditor = null; }
    const initial = (dbUi.lastSql && dbUi.lastSql[dbActiveId]) || '';
    const state = EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle), sql({ dialect: dbDialect() }), oneDark,
        keymap.of([{ key: 'Ctrl-Enter', run: () => { dbRunSql(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => { if (u.docChanged) { dbUi.lastSql = dbUi.lastSql || {}; dbUi.lastSql[dbActiveId] = u.state.doc.toString(); } }),
      ],
    });
    dbSqlEditor = new EditorView({ state, parent: edWrap });
  }
  async function dbRunSql() {
    if (!dbSqlEditor) return;
    const text = dbSqlEditor.state.doc.toString().trim();
    if (!text) return;
    saveDbUi();
    const res = $('#db-sql-result'); if (!res) return;
    res.innerHTML = '<div class="git-loading">Выполняю…</div>';
    dbLastResult = null; // a failed/aborted run must not leave the prior result exportable
    const seq = ++dbRenderSeq;
    const r = await lite.db.query(dbActiveId, text);
    if (seq !== dbRenderSeq || !document.getElementById('db-sql-result')) return;
    res.innerHTML = '';
    if (r.error) { res.appendChild(el('div', 'docker-err', r.error)); return; }
    dbLastResult = r;
    if (r.columns && r.columns.length) { res.appendChild(el('div', 'db-result-info', `${r.rows.length} строк`)); res.appendChild(dbGrid(r.columns, r.rows)); dbSchema = null; }
    else { res.appendChild(el('div', 'db-result-info', `Готово${r.rowCount != null ? ` · затронуто строк: ${r.rowCount}` : ''}`)); dbSchema = null; }
  }

  // ---- export (CSV / JSON / SQL) — three small buttons
  function dbExportBar(getResult, name) {
    const wrap = el('div', 'db-export');
    for (const fmt of ['csv', 'json', 'sql']) {
      const b = el('button', 'db-exp-btn', fmt.toUpperCase());
      b.title = 'Экспорт в ' + fmt.toUpperCase();
      b.onclick = (e) => { e.stopPropagation(); dbDoExport(getResult(), name, fmt); };
      wrap.appendChild(b);
    }
    return wrap;
  }
  async function dbDoExport(result, name, fmt) {
    if (!result || !result.columns || !result.columns.length) { toast('Нет данных для экспорта'); return; }
    const { columns, rows } = result;
    let text = '', ext = fmt;
    if (fmt === 'csv') { const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); text = [columns.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n'); }
    else if (fmt === 'json') { text = JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2); }
    else { const qv = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'"; text = rows.map((r) => `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${r.map(qv).join(', ')});`).join('\n'); }
    const r = await lite.db.saveText(`${name}.${ext}`, text);
    if (r && r.ok) toast('Сохранено: ' + r.path, { ttl: 7000 });
    else if (r && r.error) toast(r.error, { kind: 'err' });
  }

  // ⟳ в шапке панели: сбросить кэш схемы и перечитать.
  function refresh() { dbSchema = null; if (dbOpen) renderDbPanel(); }

  return { isOpen: () => dbOpen, setOpen: setDbOpen, toggle: toggleDb, renderPanel: renderDbPanel, refresh };
}
