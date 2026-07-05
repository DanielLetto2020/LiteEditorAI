// LiteEditor — модуль «Удалённые хосты» (SSH/SFTP/FTP) правого слота.
// Изолирован по образцу textproc.js: всё из ядра — через host, UI-хелперы — из ui.js,
// бэкенд — window.lite.rh.* (ssh2/basic-ftp в main, lib/remotehost.js). xterm импортируется здесь.
// host: { STORE, persist, settings, layout, GUTTER, saveUiState, refitActiveTerminal,
//         closeOtherPanels, termTheme, applyUnicode11, loadFastRenderer, copySelection }
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';
import { kpFormButtons } from '../kpicker.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// Менеджер профилей подключений + живые SSH-сессии-вкладки (ssh2 shell ↔ xterm).
// Два вида внутри панели: 'list' (список хостов) и 'session' (открытый терминал). Вкладки
// сессий живут поверх обоих видов; «+» возвращает к списку для нового подключения.
export function initRh(host) {
  const { STORE, persist, settings, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, termTheme, applyUnicode11, loadFastRenderer, copySelection } = host;

  let rhOpen = false;
  let rhConnsList = [], rhSecure = true;
  let rhView = 'list';             // 'list' (менеджер подключений) | 'session' (открытый терминал)
  const rhTerms = new Map();       // sessionId -> { term, fit, search, container, name, connId }
  let rhSessions = [];             // ordered session ids (вкладки)
  let rhActiveSession = null;
  let rhSeq = 0, rhRenderSeq = 0;
  let rhFiles = null;              // активный браузер файлов: { connId, name, type, path, entries, loading, file, error }
  let rhUi = (STORE.rhUi && typeof STORE.rhUi === 'object') ? STORE.rhUi : {}; // { catCollapsed }
  function setRhOpen(open, opts = {}) {
    if (open === rhOpen) { if (open) renderRhPanel(); return; }
    // Right slot holds one module — opening RemoteHost closes the others (chat is separate).
    if (open) closeOtherPanels('rh');
    if (!open && rhFiles) { try { lite.rh.fsClose(rhFiles.connId); } catch (_) {} rhFiles = null; if (rhView === 'files') rhView = rhSessions.length ? 'session' : 'list'; }
    const delta = layout.rh + GUTTER;
    rhOpen = open;
    $('#rh-pane').classList.toggle('hidden', !open);
    $('#gutter-rh').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
    saveUiState();
    if (open) renderRhPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function saveRhUi() { persist('rhUi', rhUi); }

  async function renderRhPanel() {
    const seq = ++rhRenderSeq;
    renderRhTabs(); // вкладки терминал-сессий видны во всех видах
    $('#rh-back').style.display = (rhView !== 'list') ? '' : 'none';
    const showSession = rhView === 'session' && rhActiveSession && rhTerms.has(rhActiveSession);
    $('#rh-conns').style.display = showSession ? 'none' : '';
    $('#rh-term').style.display = showSession ? 'block' : 'none';
    if (showSession) { $('#rh-title').textContent = rhTerms.get(rhActiveSession).name; showActiveRhSession(); return; }
    if (rhView === 'files' && rhFiles) { renderRhFiles(); return; }
    $('#rh-title').textContent = 'Удалённые хосты';
    const body = $('#rh-conns');
    body.innerHTML = '<div class="git-loading">Загрузка подключений…</div>';
    try { const r = await lite.rh.list(); rhConnsList = r.connections || []; rhSecure = r.secure !== false; }
    catch (_) { rhConnsList = []; }
    if (seq !== rhRenderSeq || !rhOpen) return;
    renderRhConnections(body);
  }
  // Вернуться к списку хостов; если был открыт браузер файлов — закрыть его соединение.
  function rhGoList() { if (rhFiles) { try { lite.rh.fsClose(rhFiles.connId); } catch (_) {} rhFiles = null; } rhView = 'list'; renderRhPanel(); }
  function renderRhConnections(body) {
    body.innerHTML = '';
    const top = el('div', 'db-topbar');
    top.appendChild(el('span', 'db-topbar-title', 'Подключения'));
    const add = iconBtn('drow-act', 'plus', 'Новое подключение', 16); add.onclick = () => rhConnModal(null);
    top.appendChild(add);
    body.appendChild(top);
    if (!rhSecure) body.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — секреты шифруются слабее (base64).'));
    if (!rhConnsList.length) { body.appendChild(el('div', 'docker-empty', 'Нет подключений. Добавь сервер по кнопке +')); return; }
    const groups = {};
    for (const c of rhConnsList) { const g = c.category || 'Все'; (groups[g] = groups[g] || []).push(c); }
    const cats = Object.keys(groups).sort((a, b) => (a === 'Все' ? -1 : b === 'Все' ? 1 : a.localeCompare(b)));
    for (const cat of cats) body.appendChild(rhCatBlock(cat, groups[cat]));
  }
  // Цвет категории по имени — копия dbCatHue из db.js (модули изолированы, общих импортов нет;
  // при выносе модуля хелпер остался приватным в db.js → ReferenceError при рендере категорий).
  function dbCatHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function rhCatBlock(cat, list) {
    const block = el('div', 'docker-group-block');
    const head = el('div', 'docker-group-head');
    const hue = dbCatHue(cat);
    head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
    head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
    const collapsed = !!(rhUi.catCollapsed && rhUi.catCollapsed[cat]);
    const chev = icon(collapsed ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
    head.append(chev, el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(list.length)));
    const bodyEl = el('div', 'docker-group-body');
    if (collapsed) bodyEl.style.display = 'none';
    for (const c of list) bodyEl.appendChild(rhConnRow(c));
    head.onclick = () => {
      rhUi.catCollapsed = rhUi.catCollapsed || {}; rhUi.catCollapsed[cat] = !rhUi.catCollapsed[cat]; saveRhUi();
      const col = rhUi.catCollapsed[cat]; bodyEl.style.display = col ? 'none' : '';
      const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev'); head.replaceChild(nc, head.firstChild);
    };
    block.append(head, bodyEl);
    return block;
  }
  function rhConnRow(c) {
    const row = el('div', 'db-conn-row clickable');
    row.appendChild(icon('globe', 16));
    const main = el('div', 'drow-main');
    const nameLine = el('div', 'rh-name-line');
    nameLine.appendChild(el('span', 'drow-name', c.name || '(без имени)'));
    if (rhSessions.some((sid) => { const r = rhTerms.get(sid); return r && r.connId === c.id; })) nameLine.appendChild(el('span', 'rh-live', 'на связи'));
    main.appendChild(nameLine);
    const proto = c.type === 'ftp' ? 'FTP' : c.type === 'sftp' ? 'SFTP' : 'SSH';
    const defPort = c.type === 'ftp' ? 21 : 22;
    const sub = `${proto} · ${c.user ? c.user + '@' : ''}${c.host || '—'}:${c.port || defPort}${c.auth && c.auth !== 'password' ? ' · без пароля' : ''}${c.keepalive && c.type !== 'ftp' ? ' · keepalive ' + (c.keepaliveSeconds || 30) + 'с' : ''}`;
    main.appendChild(el('span', 'drow-sub', sub));
    row.appendChild(main);
    const acts = el('div', 'drow-acts');
    if (c.type !== 'ftp') { // сканер сервисов и туннели — только SSH
      const svc = iconBtn('drow-act ddb', 'grid', 'Сервисы хоста — открыть БД/RabbitMQ/Kafka/контейнеры через SSH-туннель', 14);
      svc.onclick = (e) => { e.stopPropagation(); showHostServices(c); };
      acts.appendChild(svc);
    }
    const browse = iconBtn('drow-act', 'folder', 'Файлы (просмотр)', 14); browse.onclick = (e) => { e.stopPropagation(); rhOpenFiles(c); };
    const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13); edit.onclick = (e) => { e.stopPropagation(); rhConnModal(c); };
    const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
    del.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить подключение?', `«${c.name}» удалится из списка.`, 'Удалить', async () => { await lite.rh.delete(c.id); renderRhPanel(); }); };
    acts.append(browse, edit, del); row.appendChild(acts);
    // один клик: SSH → терминал, SFTP/FTP → файлы (терминала у них нет)
    row.addEventListener('click', () => { if (c.type === 'ftp' || c.type === 'sftp') rhOpenFiles(c); else rhConnect(c); });
    return row;
  }

  // ---- add/edit connection modal (SSH, безопасно: пароль/ключ/passphrase, keepalive)
  function rhConnModal(existing) {
    const c = existing ? { ...existing } : { type: 'ssh', auth: 'password', category: 'Все', port: 22, keepalive: true, keepaliveSeconds: 30 };
    const { m, close } = makeModal(`<h2>${existing ? 'Изменить' : 'Новое'} подключение</h2><div id="rhf" class="db-form"></div>`);
    m.classList.add('db-modal');
    const f = m.querySelector('#rhf');
    const field = (label, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, label)); w.appendChild(node); f.appendChild(w); return node; };
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.appendChild(el('label', null, lbl)); w.appendChild(node); return w; };
    const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };

    const name = field('Имя', inp(c.name, 'Мой сервер'));
    const cat = field('Категория', inp(c.category || 'Все', 'Все'));
    // protocol
    const typeSel = el('select');
    for (const [k, v] of [['ssh', 'SSH — терминал + файлы (SFTP)'], ['sftp', 'SFTP — только файлы'], ['ftp', 'FTP — только файлы']]) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === (c.type || 'ssh')) o.selected = true; typeSel.appendChild(o); }
    field('Протокол', typeSel);
    // host group
    const hostWrap = el('div', 'db-group');
    const host = inp(c.host || '', 'example.com или IP');
    const port = inp(c.port || 22, '22', 'number');
    const user = inp(c.user || '', 'root');
    hostWrap.append(mk('Хост', host), mk('Порт', port), mk('Пользователь', user));
    f.appendChild(hostWrap);
    // auth method (SSH/SFTP — пароль или ключ; FTP — только пароль)
    const authSel = el('select');
    for (const [k, v] of [['password', 'Пароль'], ['agent', 'Без пароля (SSH-ключ из системы)']]) { const o = document.createElement('option'); o.value = k; o.textContent = v; if (k === (c.auth || 'password')) o.selected = true; authSel.appendChild(o); }
    const authWrap = el('div', 'db-field'); authWrap.append(el('label', null, 'Аутентификация'), authSel); f.appendChild(authWrap);
    // password (режим «Пароль») + «Сейф паролей»: заполнить/сохранить креды хоста
    const passWrap = el('div', 'db-group');
    const pass = inp('', existing && c.hasPass ? '(сохранён — оставь пустым)' : 'пароль', 'password');
    const kpRow = kpFormButtons({
      user, pass,
      title: () => name.value.trim() || 'LiteEditor: удалённый хост',
      url: () => (host.value.trim() ? host.value.trim() + ':' + (port.value || '') : ''),
      notes: 'LiteEditor · модуль «Удалённые хосты»',
    });
    passWrap.append(mk('Пароль', pass), kpRow);
    f.appendChild(passWrap);
    // agent hint (режим «Без пароля») — ничего вводить не нужно
    const agentHint = el('div', 'rh-hint', 'Вход по SSH-ключу из системы (агент или ~/.ssh) — пароль и ключ вводить не нужно, как при `ssh user@host` в терминале.');
    f.appendChild(agentHint);
    // FTPS (TLS) — только для FTP
    const ftps = el('input'); ftps.type = 'checkbox'; ftps.checked = !!c.ftps;
    const ftpsLabel = el('label', 'db-check'); ftpsLabel.append(ftps, document.createTextNode(' FTPS — шифровать соединение (TLS)'));
    f.appendChild(ftpsLabel);
    const ftpsIns = el('input'); ftpsIns.type = 'checkbox'; ftpsIns.checked = !!c.ftpsInsecure;
    const ftpsInsLabel = el('label', 'db-check db-check-warn'); ftpsInsLabel.append(ftpsIns, document.createTextNode(' Доверять самоподписанному сертификату (небезопасно)'));
    f.appendChild(ftpsInsLabel);
    // keepalive (как в phpStorm: галочка + интервал) — для SSH/SFTP
    const kaOn = el('input'); kaOn.type = 'checkbox'; kaOn.checked = c.keepalive !== false;
    const kaLabel = el('label', 'db-check'); kaLabel.append(kaOn, document.createTextNode(' Держать соединение живым (keepalive)'));
    f.appendChild(kaLabel);
    const kaWrap = el('div', 'db-group');
    const kaSec = inp(c.keepaliveSeconds || 30, '30', 'number');
    kaWrap.append(mk('Слать запрос каждые, сек', kaSec));
    f.appendChild(kaWrap);

    const syncType = () => {
      const isFtp = typeSel.value === 'ftp';
      const isAgent = !isFtp && authSel.value === 'agent';
      authWrap.style.display = isFtp ? 'none' : '';      // FTP — только пароль
      passWrap.style.display = isAgent ? 'none' : '';
      agentHint.style.display = isAgent ? '' : 'none';
      ftpsLabel.style.display = isFtp ? '' : 'none';
      ftpsInsLabel.style.display = (isFtp && ftps.checked) ? '' : 'none';
      kaLabel.style.display = isFtp ? 'none' : '';        // FTP keepalive не нужен
      kaWrap.style.display = (!isFtp && kaOn.checked) ? '' : 'none';
    };
    typeSel.onchange = () => { const def = typeSel.value === 'ftp' ? 21 : 22; if (!port.value || port.value == 21 || port.value == 22) port.value = def; syncType(); };
    authSel.onchange = syncType; kaOn.onchange = syncType; ftps.onchange = syncType; syncType();

    const collect = () => {
      const isFtp = typeSel.value === 'ftp';
      const o = { id: c.id, name: name.value.trim(), category: cat.value.trim() || 'Все', type: typeSel.value, host: host.value.trim(), port: +port.value || (isFtp ? 21 : 22), user: user.value.trim(), auth: isFtp ? 'password' : authSel.value, keepalive: !isFtp && kaOn.checked, keepaliveSeconds: Math.max(2, +kaSec.value || 30) };
      if (isFtp) { o.ftps = ftps.checked; o.ftpsInsecure = ftps.checked && ftpsIns.checked; }
      if (o.auth === 'password' && pass.value) o.password = pass.value;
      return o;
    };
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const test = el('button', 'btn', 'Тест');
    test.onclick = async () => { const o = collect(); if (!o.host) { status.textContent = '✕ укажи хост'; status.className = 'db-test-status err'; return; } status.textContent = 'Проверяю…'; status.className = 'db-test-status'; const r = await lite.rh.test(o); if (r.ok) { status.textContent = '✓ подключение успешно'; status.classList.add('ok'); } else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); } };
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => { const o = collect(); if (!o.name) { toast('Введи имя', { kind: 'err' }); return; } if (!o.host) { toast('Введи хост', { kind: 'err' }); return; } const r = await lite.rh.save(o); if (r && r.error) { toast(r.error, { kind: 'err' }); return; } close(); renderRhPanel(); };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(test, save, cancel); f.appendChild(row); f.appendChild(status);
  }

  // ---- sessions (live SSH terminals as tabs)
  async function rhConnect(c) {
    const sessionId = 'rh::' + c.id + '::t' + (++rhSeq);
    const rec = createRhTerminal(sessionId, c.name || c.host, c.id);
    rhSessions.push(sessionId);
    rhActiveSession = sessionId;
    rhView = 'session';
    renderRhPanel();
    rec.term.write(`\x1b[90mПодключение к ${c.user ? c.user + '@' : ''}${c.host}:${c.port || 22}…\x1b[0m\r\n`);
    const r = await lite.rh.open(sessionId, c.id, rec.term.cols, rec.term.rows);
    if (r && r.error) rec.term.write(`\r\n\x1b[31m${r.error}\x1b[0m\r\n`);
  }
  function createRhTerminal(sessionId, name, connId) {
    const container = el('div', 'term-instance');
    $('#rh-term').appendChild(container);
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
      fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 8000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
    applyUnicode11(term);
    term.open(container);
    loadFastRenderer(term);
    fit.fit();
    term.onData((data) => lite.rh.write(sessionId, data));
    term.onResize(({ cols, rows }) => lite.rh.resize(sessionId, cols, rows));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { closeRhSession(rhActiveSession); return false; }
      if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleRhTab(e.key === 'PageDown' ? 1 : -1); return false; }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term);
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteRh(sessionId); return false; }
      return true;
    });
    const rec = { term, fit, search, container, name: name || 'SSH', connId };
    rhTerms.set(sessionId, rec);
    return rec;
  }
  async function pasteRh(sessionId) {
    const text = await lite.readClipboard();
    if (text) lite.rh.write(sessionId, text);
    const rec = rhTerms.get(sessionId); if (rec) { try { rec.term.focus(); } catch (_) {} }
  }
  function renderRhTabs() {
    const bar = $('#rh-tabs'); if (!bar) return;
    bar.style.display = rhSessions.length ? 'flex' : 'none';
    bar.innerHTML = '';
    rhSessions.forEach((sid) => {
      const rec = rhTerms.get(sid); if (!rec) return;
      const tab = el('div', 'tab' + (sid === rhActiveSession && rhView === 'session' ? ' active' : ''));
      tab.appendChild(el('span', 'rh-tab-dot'));
      tab.appendChild(el('span', 'tab-name', rec.name));
      const x = iconBtn('tab-close', 'x', 'Закрыть сессию (Ctrl+Shift+W)', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); closeRhSession(sid); });
      tab.appendChild(x);
      tab.addEventListener('click', () => switchRhTab(sid));
      bar.appendChild(tab);
    });
    const add = iconBtn('tab-add', 'plus', 'Подключиться к другому хосту', 15);
    add.addEventListener('click', () => rhGoList());
    bar.appendChild(add);
  }
  function switchRhTab(sid) { if (!rhTerms.has(sid)) return; rhActiveSession = sid; rhView = 'session'; renderRhPanel(); }
  function showActiveRhSession() {
    for (const [sid, rec] of rhTerms) rec.container.style.display = sid === rhActiveSession ? 'block' : 'none';
    refitRhSession(true);
  }
  function refitRhSession(focusIt) {
    if (!rhOpen || rhView !== 'session' || !rhActiveSession) return;
    const rec = rhTerms.get(rhActiveSession); if (!rec) return;
    requestAnimationFrame(() => { try { rec.fit.fit(); lite.rh.resize(rhActiveSession, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {} });
  }
  function cycleRhTab(dir) {
    if (rhSessions.length < 2) return;
    let i = rhSessions.indexOf(rhActiveSession) + dir;
    if (i < 0) i = rhSessions.length - 1; if (i >= rhSessions.length) i = 0;
    switchRhTab(rhSessions[i]);
  }
  function closeRhSession(sid) {
    if (!sid) return;
    lite.rh.close(sid);
    const rec = rhTerms.get(sid);
    if (rec) { try { rec.term.dispose(); } catch (_) {} rec.container.remove(); rhTerms.delete(sid); }
    const i = rhSessions.indexOf(sid); if (i >= 0) rhSessions.splice(i, 1);
    if (rhActiveSession === sid) rhActiveSession = rhSessions[Math.max(0, i - 1)] || null;
    if (!rhSessions.length || !rhActiveSession) rhView = 'list';
    renderRhPanel();
  }

  // ---- сервисы хоста: скан слушающих портов/сокетов + связки в модули через SSH-туннель
  const SVC_LABEL = {
    postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', rabbitmq: 'RabbitMQ (management)',
    amqp: 'AMQP (RabbitMQ, без management)', kafka: 'Kafka', redis: 'Redis', mongo: 'MongoDB', web: 'Веб-сервис',
  };
  // Поднять туннель до сервиса и отдать заготовку в целевой модуль (тот же маршрут, что у связки
  // «Контейнеры → модуль»: existing по source → переключение, новый → тест/форма-префилл).
  async function openSvcInModule(c, svc) {
    toast(`Поднимаю SSH-туннель до ${c.host}:${svc.port}…`, { ttl: 4000 });
    let t;
    try { t = await lite.rh.tunnelOpen(c.id, '127.0.0.1', svc.port, `${SVC_LABEL[svc.kind] || svc.kind}: ${c.name || c.host}`); }
    catch (e) { t = { ok: false, error: String(e) }; }
    if (!t || !t.ok) { toast('Туннель не поднялся: ' + ((t && t.error) || 'ошибка'), { kind: 'err', ttl: 9000 }); return; }
    const source = `rh:${c.id}:${svc.port}`;
    const name = `${c.name || c.host}: ${SVC_LABEL[svc.kind] || svc.kind}`;
    if (svc.kind === 'postgres' || svc.kind === 'mysql') {
      lite.db.openFromContainer({ ok: true, kind: svc.kind, published: true, running: true, passwordUnknown: true, prefill: {
        name, type: svc.kind, host: '127.0.0.1', port: t.port, user: '', database: '', category: 'SSH-туннели', source,
      } });
    } else if (svc.kind === 'rabbitmq') {
      lite.rmq.openFromContainer({ ok: true, kind: 'rabbitmq', published: true, running: true, passwordUnknown: true, prefill: {
        name, host: '127.0.0.1', port: t.port, amqpPort: 5672, vhost: '/', user: '', password: null, category: 'SSH-туннели', source,
      } });
    } else if (svc.kind === 'kafka') {
      toast('Kafka через туннель работает, если advertised.listeners брокера указывает на localhost', { ttl: 7000 });
      lite.kafka.openFromContainer({ ok: true, kind: 'kafka', published: true, running: true, prefill: {
        name, brokers: '127.0.0.1:' + t.port, category: 'SSH-туннели', source,
      } });
    }
  }
  async function watchSvcSite(c, svc) {
    const url = 'http://' + c.host + ':' + svc.port;
    let sites = [];
    try { const l = await lite.sitemon.list(); if (Array.isArray(l)) sites = l; } catch (_) {}
    if (sites.some((s) => s && s.url === url)) { toast(`Уже наблюдается: ${url}`, { ttl: 5000 }); lite.module.open('sitemon'); return; }
    const a = await lite.sitemon.add(`${c.name || c.host}:${svc.port}`, url);
    if (!a || !a.ok) { toast((a && a.error) || 'Не удалось добавить в мониторинг', { kind: 'err', ttl: 8000 }); return; }
    toast(`${url} — добавлен в «Мониторинг сайтов»`, { ttl: 5000 });
    lite.module.open('sitemon');
  }
  function showHostServices(c) {
    const { m, close } = makeModal('<h2></h2>');
    m.querySelector('h2').textContent = 'Сервисы: ' + (c.name || c.host || ''); // имя профиля — только textContent
    m.classList.add('rh-svc-modal');
    const sub = el('div', 'about-desc', 'Слушающие TCP-порты хоста и docker/podman-сокеты. Открытие сервиса в модуле идёт через SSH-туннель — работает и для сервисов, доступных только на localhost хоста.');
    const body = el('div', 'rh-svc-body');
    body.appendChild(el('div', 'git-loading', 'Сканирую хост…'));
    m.append(sub, body);
    lite.rh.services(c.id).then((r) => {
      if (!m.isConnected) return; // модалку успели закрыть
      body.innerHTML = '';
      if (!r || !r.ok) { body.appendChild(el('div', 'db-warn', '⚠ ' + ((r && r.error) || 'скан не удался'))); return; }
      const services = r.services || [];
      const sockets = r.sockets || {};
      if (!services.length && !Object.keys(sockets).length) { body.appendChild(el('div', 'docker-empty', 'Слушающих сервисов не найдено')); return; }
      const mkRow = (iconName, title, subText, actLabel, onAct) => {
        const row = el('div', 'rh-svc-row');
        row.append(icon(iconName, 15));
        const txt = el('div', 'rh-svc-text');
        txt.appendChild(el('span', 'rh-svc-title', title));
        if (subText) txt.appendChild(el('span', 'rh-svc-sub', subText));
        row.appendChild(txt);
        if (actLabel) {
          const b = el('button', 'btn kp-btn'); b.type = 'button'; b.textContent = actLabel;
          b.onclick = () => { close(); onAct(); };
          row.appendChild(b);
        }
        body.appendChild(row);
      };
      // сокеты контейнерных движков — открыть модуль «Контейнеры» в удалённом контексте
      for (const [engine, sock] of Object.entries(sockets)) {
        mkRow('box', engine === 'docker' ? 'Docker (сокет)' : 'Podman (сокет)', sock, 'В Контейнеры', async () => {
          toast('Переключаю «Контейнеры» на этот хост…', { ttl: 4000 });
          let rr;
          try { rr = await lite.containers.remoteSet(c.id); } catch (e) { rr = { ok: false, error: String(e) }; }
          if (!rr || !rr.ok) { toast((rr && rr.error) || 'Не удалось переключить', { kind: 'err', ttl: 9000 }); return; }
          lite.module.open('docker');
        });
      }
      const SVC_ICON = { postgres: 'database', mysql: 'database', rabbitmq: 'rabbit', amqp: 'rabbit', kafka: 'kafka', redis: 'database', mongo: 'database', web: 'globe' };
      for (const svc of services) {
        const subText = `порт ${svc.port} · ${svc.addr}${svc.loopbackOnly ? ' (только localhost хоста)' : ''}${svc.proc ? ' · ' + svc.proc : ''}`;
        if (svc.kind === 'postgres' || svc.kind === 'mysql') mkRow(SVC_ICON[svc.kind], SVC_LABEL[svc.kind], subText, 'В Базы данных', () => openSvcInModule(c, svc));
        else if (svc.kind === 'rabbitmq') mkRow('rabbit', SVC_LABEL.rabbitmq, subText, 'В RabbitMQ', () => openSvcInModule(c, svc));
        else if (svc.kind === 'kafka') mkRow('kafka', SVC_LABEL.kafka, subText, 'В Kafka', () => openSvcInModule(c, svc));
        else if (svc.kind === 'web' && !svc.loopbackOnly) mkRow('globe', SVC_LABEL.web, subText, 'Наблюдать', () => watchSvcSite(c, svc));
        else mkRow(SVC_ICON[svc.kind] || 'file', SVC_LABEL[svc.kind] || ('Порт ' + svc.port), subText, null, null);
      }
    });
  }

  // ---- file browser (read-only): SFTP (ssh/sftp) или FTP
  function rhHumanSize(n) { if (!n && n !== 0) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB'; }
  function rhJoin(base, name) {
    if (name === '..') { const b = String(base).replace(/\/+$/, ''); const i = b.lastIndexOf('/'); return i <= 0 ? '/' : b.slice(0, i); }
    return (base === '/' ? '' : String(base).replace(/\/+$/, '')) + '/' + name;
  }
  async function rhOpenFiles(c) {
    rhFiles = { connId: c.id, name: c.name || c.host, type: c.type || 'ssh', path: '~', entries: null, loading: true, file: null, error: null };
    rhView = 'files';
    renderRhPanel();
    await rhLoadDir('~');
  }
  async function rhLoadDir(p) {
    if (!rhFiles) return;
    const connId = rhFiles.connId;
    rhFiles.loading = true; rhFiles.file = null; rhFiles.error = null; renderRhFiles();
    const r = await lite.rh.fsList(connId, p);
    if (!rhFiles || rhFiles.connId !== connId || rhView !== 'files') return;
    rhFiles.loading = false;
    if (r.error) rhFiles.error = r.error;
    else { rhFiles.path = r.path; rhFiles.entries = r.entries; }
    renderRhFiles();
  }
  async function rhOpenFile(name) {
    if (!rhFiles) return;
    const connId = rhFiles.connId;
    const full = rhJoin(rhFiles.path, name);
    rhFiles.loading = true; renderRhFiles();
    const r = await lite.rh.fsRead(connId, full);
    if (!rhFiles || rhFiles.connId !== connId || rhView !== 'files') return;
    rhFiles.loading = false;
    rhFiles.file = { name, path: full, error: r.error, binary: r.binary, content: r.content, size: r.size };
    renderRhFiles();
  }
  function renderRhFiles() {
    if (!rhFiles) return;
    $('#rh-title').textContent = rhFiles.name;
    $('#rh-back').style.display = '';
    const body = $('#rh-conns');
    body.innerHTML = '';
    const bar = el('div', 'rh-fbar');
    const up = iconBtn('drow-act', 'chevron-up', 'Вверх', 14); up.onclick = () => rhLoadDir(rhJoin(rhFiles.path, '..'));
    const pathEl = el('span', 'rh-fpath', rhFiles.path || ''); pathEl.title = rhFiles.path || '';
    const refresh = iconBtn('drow-act', 'refresh', 'Обновить', 14); refresh.onclick = () => rhLoadDir(rhFiles.path);
    bar.append(up, pathEl, refresh);
    body.appendChild(bar);
    if (rhFiles.file) { renderRhFileContent(body); return; }
    if (rhFiles.loading) { body.appendChild(el('div', 'git-loading', 'Загрузка…')); return; }
    if (rhFiles.error) { body.appendChild(el('div', 'db-warn', '⚠ ' + rhFiles.error)); return; }
    const list = el('div', 'rh-flist');
    if (!rhFiles.entries || !rhFiles.entries.length) list.appendChild(el('div', 'docker-empty', 'Пусто'));
    for (const e of (rhFiles.entries || [])) {
      const r = el('div', 'rh-frow');
      r.appendChild(icon(e.dir ? 'folder' : 'file', 15));
      r.appendChild(el('span', 'rh-fname', e.name));
      if (!e.dir) {
        r.appendChild(el('span', 'rh-fsize', rhHumanSize(e.size)));
        const ed = iconBtn('drow-act rh-fedit', 'code', 'Редактировать в вивере (сохранение уйдёт на хост)', 13);
        ed.onclick = (ev) => { ev.stopPropagation(); rhEditInViewer(rhJoin(rhFiles.path, e.name)); };
        r.appendChild(ed);
      }
      r.onclick = () => e.dir ? rhLoadDir(rhJoin(rhFiles.path, e.name)) : rhOpenFile(e.name);
      list.appendChild(r);
    }
    body.appendChild(list);
  }
  // Открыть удалённый файл в вивере: main снимет tmp-копию и будет заливать каждое сохранение
  // обратно на хост (SFTP/FTP) — полноценная правка, а не только просмотр.
  async function rhEditInViewer(fullPath) {
    if (!rhFiles) return;
    toast('Открываю в вивере…', { ttl: 2500 });
    const r = await lite.rh.fsOpenInViewer(rhFiles.connId, fullPath);
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось открыть в вивере', { kind: 'err', ttl: 8000 }); return; }
    toast('Файл в вивере. Ctrl+S / автосейв заливает правки на хост', { ttl: 6000 });
  }
  function renderRhFileContent(body) {
    const f = rhFiles.file;
    const head = el('div', 'rh-fchead');
    const back = iconBtn('drow-act', 'chevron-left', 'К списку файлов', 14); back.onclick = () => { rhFiles.file = null; renderRhFiles(); };
    head.append(back, icon('file', 14), el('span', 'rh-fcname', f.name));
    if (f.size != null) head.appendChild(el('span', 'rh-fsize', rhHumanSize(f.size)));
    if (!f.error && !f.binary) {
      const ed = iconBtn('drow-act rh-fedit', 'code', 'Редактировать в вивере (сохранение уйдёт на хост)', 13);
      ed.onclick = () => rhEditInViewer(f.path);
      head.appendChild(ed);
    }
    body.appendChild(head);
    if (rhFiles.loading) { body.appendChild(el('div', 'git-loading', 'Загрузка…')); return; }
    if (f.error) { body.appendChild(el('div', 'db-warn', '⚠ ' + f.error)); return; }
    if (f.binary) { body.appendChild(el('div', 'docker-empty', 'Бинарный файл — просмотр недоступен')); return; }
    const pre = el('pre', 'rh-fview'); pre.textContent = f.content || '';
    body.appendChild(pre);
  }

  // Глобальные IPC-подписки на поток данных SSH-сессий (вызывается ядром из init, как раньше).
  function bindEvents() {
    lite.rh.onData(({ id, data }) => { const rec = rhTerms.get(id); if (rec) rec.term.write(data); });
    lite.rh.onExit(({ id }) => { const rec = rhTerms.get(id); if (rec) rec.term.write('\r\n\x1b[90m[соединение закрыто — закрой вкладку или подключись заново]\x1b[0m\r\n'); });
  }
  // Размер шрифта всем SSH-терминалам (вызывается ядром из applyFontSize).
  function applyFontSize() {
    for (const rec of rhTerms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
  }

  return { isOpen: () => rhOpen, setOpen: setRhOpen, renderPanel: renderRhPanel, goList: rhGoList, refitSession: refitRhSession, bindEvents, applyFontSize };
}
