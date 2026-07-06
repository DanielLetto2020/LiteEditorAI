// LiteEditor — модуль «Контейнеры» (Docker/Podman) правого слота.
// Изолирован по образцу textproc.js: всё из ядра — через host, UI-хелперы — из ui.js,
// бэкенд — window.lite.containers.*. xterm для exec-терминала импортируется здесь же.
// host: { STORE, persist, settings, layout, GUTTER, saveUiState, refitActiveTerminal,
//         closeOtherPanels, termTheme, applyUnicode11, loadFastRenderer }
import { el, icon, iconBtn, toast, showConfirm, makeModal } from '../ui.js';
import { parsePublishedPorts, portUrl, portLabel } from '../../lib/portparse.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// System-wide (not per-project) right-pane manager: tabs Docker|Podman, accordion sections for
// containers (grouped by compose project), pods (podman), images, volumes, with lifecycle actions.
export function initContainers(host) {
  const { STORE, persist, settings, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, termTheme, applyUnicode11, loadFastRenderer } = host;

  let dockerOpen = false;      // модуль контейнеров (docker/podman) справа открыт
  // Persisted per-engine group order + collapse + default tab: { order:{engine:[names]}, collapsed:{'engine:name':bool}, defEngine }
  let dockerUi = (STORE.dockerUi && typeof STORE.dockerUi === 'object') ? STORE.dockerUi : {};
  const defEngine = () => (dockerUi.defEngine === 'docker' ? 'docker' : 'podman'); // дефолтная вкладка; из коробки — podman
  let dockerEngine = defEngine();   // active tab
  let dockerDetect = null;        // cached {docker:{cli,compose,composePlugin}, podman:{...}}
  let dockerRenderSeq = 0;        // stale-render guard (async render vs tab/refresh switches)
  let dockerUid = 0;              // unique-id counter for log/exec streams (decoupled from the render guard)
  const dockerAcc = { containers: true, pods: true, images: false, volumes: false }; // accordion open state
  let dockerView = 'list';        // 'list' | 'detail'
  let dockerDetail = null;        // { id, name, engine, state } when viewing one container
  let dockerDetailTab = 'logs';   // 'logs' | 'term'
  let dockerLogId = null, dockerExecId = null, dockerExecTerm = null, dockerExecFit = null;
  const dockerDetailUnsub = [];   // IPC listener cleanups for the open detail view
  let dockerPoll = null;          // setInterval handle: live in-place list refresh while panel open in list view
  let dockerListBox = null;       // the .docker-list element reconciled in place by polls (no full re-render)
  let dockerListBusy = false;     // guard: skip a poll tick while a list fetch is still in flight
  let dockerPollTick = 0;         // poll counter — most ticks are light (containers/pods); every 10th is full

  function dockerGroupOrder(engine, names) { // saved order first, new groups appended (alpha)
    const saved = (dockerUi.order && dockerUi.order[engine]) || [];
    const head = saved.filter((n) => names.includes(n));
    const tail = names.filter((n) => !head.includes(n)).sort((a, b) => a.localeCompare(b));
    return [...head, ...tail];
  }
  function currentGroupNames() { // named compose groups currently rendered, in display order (read live from the DOM)
    if (!dockerListBox) return [];
    return [...dockerListBox.querySelectorAll('.docker-group-block')].map((b) => b.dataset.group).filter((n) => n && n !== D_UNGROUPED);
  }
  function moveDockerGroup(engine, name, dir) {
    const order = currentGroupNames(); // live order, not a stale closure — survives groups appearing/disappearing
    const i = order.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    dockerUi.order = dockerUi.order || {}; dockerUi.order[engine] = order; persist('dockerUi', dockerUi);
    fetchAndReconcile(true); // smooth in-place reorder (light fetch), no full re-render flash
  }
  function dockerGroupCollapsed(engine, name) { return !!(dockerUi.collapsed && dockerUi.collapsed[engine + ':' + name]); }
  function toggleDockerGroup(engine, name) {
    dockerUi.collapsed = dockerUi.collapsed || {}; const k = engine + ':' + name;
    dockerUi.collapsed[k] = !dockerUi.collapsed[k]; persist('dockerUi', dockerUi);
  }
  function dockerGroupHue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  // Strip ANSI/OSC so container logs render cleanly in a <pre>.
  function stripAnsiSeq(s) { return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); }

  function setDockerOpen(open, opts = {}) {
    if (open === dockerOpen) { if (open) renderDockerPanel(); return; }
    if (!open) { stopDockerPoll(); dockerListBox = null; closeDockerDetail(); dockerView = 'list'; } // tear down logs/exec + live poll on close
    // Right slot holds one module — opening Docker closes the others (chat is separate).
    if (open) closeOtherPanels('docker');
    const delta = layout.docker + GUTTER;
    dockerOpen = open;
    $('#docker-pane').classList.toggle('hidden', !open);
    $('#gutter-docker').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
    saveUiState();
    if (open) renderDockerPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleDocker() { setDockerOpen(!dockerOpen); }

  // --- удалённый контекст: контейнеры хоста из «Удалённых хостов» (SSH-туннель до сокета в main)
  let dockerRemote; // undefined = статус не спрошен; null = локально; { rhId, name, engine }
  let dockerTunnels = []; // TCP-туннели текущего rh-хоста (rh:tunnelList) — для «открыть в браузере» и значков-цепочек
  async function ensureRemoteStatus() {
    if (dockerRemote !== undefined) return;
    try { const st = await lite.containers.remoteStatus(); dockerRemote = (st && st.rhId) ? st : null; } catch (_) { dockerRemote = null; }
  }
  async function applyContainersHost(rhId, label, engine) {
    const saved = rhId ? (dockerUi.engineByHost || {})[rhId] : undefined; // запомненный выбор движка для хоста
    const eng = engine || saved;
    toast(rhId ? `Подключаюсь к «${label}» (туннель до сокета)…` : 'Возвращаюсь к локальным контейнерам…', { ttl: 4000 });
    let r;
    try { r = await lite.containers.remoteSet(rhId, eng); } catch (e) { r = { ok: false, error: String(e) }; }
    if (r && r.ok && r.needChoice) { pickEngineModal(rhId, label); return; } // оба сокета — пусть выберет пользователь
    if (!r || !r.ok) {
      if (r && r.hint === 'podman-socket') { offerEnablePodman(rhId, label, r.error); return; }
      if (saved && !engine) { // запомненный движок протух (сокета больше нет) — сброс и авторетрай с автовыбором
        delete dockerUi.engineByHost[rhId]; persist('dockerUi', dockerUi);
        return applyContainersHost(rhId, label);
      }
      toast((r && r.error) || 'Не удалось переключить хост', { kind: 'err', ttl: 9000 }); return;
    }
    dockerRemote = r.rhId ? { rhId: r.rhId, name: r.name, engine: r.engine } : null;
    if (dockerRemote) dockerEngine = dockerRemote.engine; // CLI выбирает main по типу удалённого сокета
    else dockerTunnels = []; // вернулись к локальным — значки туннелей неуместны
    dockerDetect = null; // пересобрать окружение под новый контекст
    renderDockerPanel();
  }
  // На хосте оба сокета (docker и podman) — двухплиточный выбор, запоминается per-host.
  function pickEngineModal(rhId, label) {
    const { m, close } = makeModal('<h2>Какой движок?</h2>');
    m.appendChild(el('div', 'about-desc', `На «${label}» найдены оба сокета — Docker и Podman. Выбор запомнится для этого хоста.`));
    const list = el('div', 'runsql-list');
    for (const eng of ['docker', 'podman']) {
      const b = el('button', 'runsql-row'); b.type = 'button';
      b.append(icon('box', 13), el('span', 'runsql-name', eng === 'docker' ? 'Docker' : 'Podman'));
      b.onclick = () => {
        close();
        dockerUi.engineByHost = dockerUi.engineByHost || {}; dockerUi.engineByHost[rhId] = eng; persist('dockerUi', dockerUi);
        applyContainersHost(rhId, label, eng);
      };
      list.appendChild(b);
    }
    m.appendChild(list);
  }
  // Podman установлен, но его API-сокет (socket-activated) спит — предложить включить прямо по SSH.
  function offerEnablePodman(rhId, label, msg) {
    showConfirm('Podman-сокет спит', (msg || '') + ' Включить на хосте?', 'Включить', async () => {
      let x;
      try { x = await lite.rh.exec(rhId, 'systemctl --user enable --now podman.socket'); } catch (e) { x = { ok: false, error: String(e) }; }
      if (!x || !x.ok || x.code !== 0) { toast((x && (x.error || (x.stderr || '').trim())) || 'Не удалось включить сокет', { kind: 'err', ttl: 9000 }); return; }
      applyContainersHost(rhId, label, 'podman');
    });
  }
  async function pickContainersHost() {
    let profiles = [];
    try { const r = await lite.rh.list(); profiles = ((r && r.connections) || []).filter((c) => c.type !== 'ftp'); } catch (_) {}
    const { m, close } = makeModal('<h2>Контейнеры какого хоста?</h2>');
    m.appendChild(el('div', 'about-desc', 'Удалённые — через SSH-туннель до docker/podman-сокета хоста (профили модуля «Удалённые хосты»).'));
    const list = el('div', 'runsql-list');
    const row = (label, sub, onClick, on) => {
      const b = el('button', 'runsql-row' + (on ? ' on' : '')); b.type = 'button';
      b.append(icon(on ? 'check' : 'globe', 13), el('span', 'runsql-name', label));
      if (sub) b.appendChild(el('span', 'runsql-sub', sub));
      b.onclick = () => { close(); onClick(); };
      list.appendChild(b);
    };
    row('Локальная машина', 'docker / podman этой машины', () => { if (dockerRemote) applyContainersHost(null); }, !dockerRemote);
    for (const c of profiles)
      row(c.name || c.host, `${c.user || ''}@${c.host || ''}`, () => applyContainersHost(c.id, c.name || c.host), !!(dockerRemote && dockerRemote.rhId === c.id));
    if (!profiles.length) list.appendChild(el('div', 'kpick-empty', 'SSH-профилей нет — создайте в модуле «Удалённые хосты»'));
    m.appendChild(list);
  }
  function renderDockerTabs() {
    const t = $('#docker-tabs'); t.innerHTML = '';
    if (dockerRemote) { // удалённый контекст: движок диктует сокет хоста — вкладки не нужны
      const badge = el('span', 'docker-remote-badge');
      badge.append(icon('globe', 14), el('span', null, dockerRemote.name));
      badge.title = 'Контейнеры удалённого хоста (SSH-туннель). Клик — активные туннели портов. Вернуться к локальным — кнопка хоста.';
      badge.onclick = (e) => { e.stopPropagation(); hostTunnelsDropdown(badge); };
      t.appendChild(badge);
    } else {
      const def = defEngine(); // дефолтная вкладка всегда первая
      for (const e of (def === 'docker' ? ['docker', 'podman'] : ['podman', 'docker'])) {
        const installed = dockerDetect ? !!(dockerDetect[e] && dockerDetect[e].cli) : true;
        const tab = el('button', 'docker-tab' + (e === dockerEngine ? ' on' : '') + (installed ? '' : ' off'));
        tab.appendChild(icon('box', 15));
        tab.appendChild(el('span', null, e === 'docker' ? 'Docker' : 'Podman'));
        tab.onclick = () => { if (e !== dockerEngine) { dockerEngine = e; renderDockerPanel(); } };
        t.appendChild(tab);
      }
      if (dockerEngine !== def) { // активна не-дефолтная — серая ссылка «закрепить как дефолт»
        const mk = el('button', 'docker-def-link', 'сделать вкладкой по умолчанию');
        mk.type = 'button';
        mk.title = 'Запомнить: эта вкладка станет первой и будет открываться по умолчанию';
        mk.onclick = () => { dockerUi.defEngine = dockerEngine; persist('dockerUi', dockerUi); renderDockerTabs(); };
        t.appendChild(mk);
      }
    }
    const hostBtn = el('button', 'docker-host-btn' + (dockerRemote ? ' remote' : ''));
    hostBtn.append(icon('globe', 13), el('span', null, dockerRemote ? dockerRemote.name : 'Локально'));
    hostBtn.title = 'Хост контейнеров: локальная машина или сервер по SSH';
    hostBtn.onclick = pickContainersHost;
    t.appendChild(hostBtn);
  }
  // Versions strip for the active engine: cli + compose plugin (no dash) + legacy compose (dash).
  function renderDockerEnv(eng) {
    const box = el('div', 'docker-env');
    const rows = dockerEngine === 'docker'
      ? [['docker', eng.cli], ['docker compose', eng.composePlugin], ['docker-compose', eng.compose]]
      : [['podman', eng.cli], ['podman compose', eng.composePlugin], ['podman-compose', eng.compose]];
    for (const [label, ver] of rows) {
      const r = el('div', 'docker-env-row');
      r.appendChild(el('span', 'denv-k', label));
      r.appendChild(el('span', 'denv-v' + (ver ? '' : ' missing'), ver || 'не установлено'));
      box.appendChild(r);
    }
    return box;
  }
  function dStateClass(s) {
    s = String(s || '').toLowerCase();
    if (s.includes('run')) return 'run';
    if (s.includes('paus')) return 'pause';
    if (s.includes('dead')) return 'dead';
    return 'stop';
  }
  async function dockerDo(kind, action, id, label) {
    let r;
    try { r = await lite.containers.action(dockerEngine, kind, action, id); } catch (e) { r = { ok: false, error: String(e) }; }
    if (r && r.ok) { toast((label || 'Готово') + ' ✓'); fetchAndReconcile(kind === 'container' || kind === 'pod'); } // light for lifecycle, full for image/volume removal
    else toast((r && r.error) || 'Команда не выполнена', { kind: 'err', ttl: 8000 });
  }
  function dActBtn(kind, action, iconName, title, id) {
    const b = iconBtn('drow-act', iconName, title, 14);
    b.onclick = (e) => { e.stopPropagation(); dockerDo(kind, action, id, title); };
    return b;
  }
  function dRemoveBtn(kind, id, label, force, extra) {
    const b = iconBtn('drow-act danger', 'trash', 'Удалить', 14);
    b.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить?', `«${label}» будет удалён${force ? ' (принудительно — объект запущен)' : ''}.${extra || ''}`, 'Удалить', () => dockerDo(kind, 'remove', id, 'Удаление')); };
    return b;
  }
  function fillContainerActs(acts, c) { // action buttons depend on state; rebuilt only when state flips
    const running = c.state === 'running', paused = c.state === 'paused';
    if (c.dbKind) { // задетектили СУБД (по образу/портам, main аннотирует) → «открыть в модуле БД»
      const b = iconBtn('drow-act ddb', 'database', 'Открыть в модуле «Базы данных»', 14);
      b.onclick = (e) => { e.stopPropagation(); openContainerDb(c); };
      acts.appendChild(b);
    }
    if (c.mqKind === 'rabbitmq') { // задетектили RabbitMQ → «открыть в модуле RabbitMQ»
      const b = iconBtn('drow-act dmq', 'rabbit', 'Открыть в модуле «RabbitMQ»', 14);
      b.onclick = (e) => { e.stopPropagation(); openContainerMq(c); };
      acts.appendChild(b);
    }
    if (c.mqKind === 'kafka') { // задетектили Kafka → «открыть в модуле Kafka»
      const b = iconBtn('drow-act dmq', 'kafka', 'Открыть в модуле «Kafka»', 14);
      b.onclick = (e) => { e.stopPropagation(); openContainerKafka(c); };
      acts.appendChild(b);
    }
    if (c.webKind && !c.dbKind && !c.mqKind) { // задетектили веб-сервис → «наблюдать в Мониторинге сайтов»
      const b = iconBtn('drow-act dweb', 'globe', 'Наблюдать в «Мониторинге сайтов»', 14);
      b.onclick = (e) => { e.stopPropagation(); watchContainerSite(c); };
      acts.appendChild(b);
    }
    appendOpenBtn(acts, c); // published-порты → «открыть в браузере» (в т.ч. management-панели БД/брокеров)
    if (running) acts.append(dActBtn('container', 'pause', 'pause', 'Пауза', c.id), dActBtn('container', 'restart', 'refresh', 'Перезапуск', c.id), dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
    else if (paused) acts.append(dActBtn('container', 'unpause', 'play', 'Возобновить', c.id), dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
    else acts.appendChild(dActBtn('container', 'start', 'play', 'Старт', c.id));
    acts.appendChild(dRemoveBtn('container', c.id, c.service || c.name || c.id, running));
  }
  // Клик по иконке БД: inspect → заготовка подключения → окно модуля «Базы данных» (маршрут через main).
  // Модуль БД сам решит: открыть существующее подключение / молча создать / показать префилл-форму.
  async function openContainerDb(c) {
    let r;
    try { r = await lite.containers.inspectDb(dockerEngine, c.id); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось прочитать параметры контейнера', { kind: 'err', ttl: 8000 }); return; }
    if (!r.published) { toast('Порт БД не проброшен на хост (нет -p) — с хоста не подключиться', { kind: 'err', ttl: 9000 }); return; }
    if (!r.running) toast('Контейнер остановлен — подключение создастся, но оживёт после старта', { ttl: 6000 });
    lite.db.openFromContainer(r);
  }
  // Клик по иконке кролика: inspect → заготовка профиля → окно модуля «RabbitMQ» (маршрут через main).
  async function openContainerMq(c) {
    let r;
    try { r = await lite.containers.inspectMq(dockerEngine, c.id); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось прочитать параметры контейнера', { kind: 'err', ttl: 8000 }); return; }
    if (!r.published) { toast('Порт management (15672) не проброшен на хост — включи management-плагин / добавь -p', { kind: 'err', ttl: 9000 }); return; }
    if (!r.running) toast('Контейнер остановлен — профиль создастся, но оживёт после старта', { ttl: 6000 });
    lite.rmq.openFromContainer(r);
  }
  // Клик по глобусу: inspect → URL по published веб-порту → запись в «Мониторинг сайтов» (дедуп по URL).
  async function watchContainerSite(c) {
    let r;
    try { r = await lite.containers.inspectWeb(dockerEngine, c.id); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось прочитать параметры контейнера', { kind: 'err', ttl: 8000 }); return; }
    if (!r.published || !r.prefill.url) { toast('Веб-порт не проброшен на хост (нет -p) — мониторить нечего', { kind: 'err', ttl: 9000 }); return; }
    if (!r.running) toast('Контейнер остановлен — сайт будет числиться недоступным до старта', { ttl: 6000 });
    const url = r.prefill.url;
    let sites = [];
    try { const l = await lite.sitemon.list(); if (Array.isArray(l)) sites = l; } catch (_) {}
    const exists = sites.find((s) => s && s.url === url);
    if (exists) { toast(`Уже наблюдается: ${url}`, { ttl: 5000 }); lite.module.open('sitemon'); return; }
    const a = await lite.sitemon.add(r.prefill.name, url);
    if (!a || !a.ok) { toast((a && a.error) || 'Не удалось добавить в мониторинг', { kind: 'err', ttl: 8000 }); return; }
    toast(`${url} — добавлен в «Мониторинг сайтов»`, { ttl: 5000 });
    lite.module.open('sitemon');
  }
  // Клик по иконке Kafka: inspect → заготовка профиля → окно модуля «Kafka» (маршрут через main).
  async function openContainerKafka(c) {
    let r;
    try { r = await lite.containers.inspectKafka(dockerEngine, c.id); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось прочитать параметры контейнера', { kind: 'err', ttl: 8000 }); return; }
    if (!r.published) { toast('Клиентский порт Kafka (9092) не проброшен на хост — добавь -p', { kind: 'err', ttl: 9000 }); return; }
    if (!r.running) toast('Контейнер остановлен — профиль создастся, но оживёт после старта', { ttl: 6000 });
    lite.kafka.openFromContainer(r);
  }
  // --- «Открыть в браузере»: published-порты контейнера → системный браузер; для удалённого хоста —
  // через SSH-туннель (rh:tunnelOpen, дедуп в main). Порты парсятся из строки c.ports — без inspect.
  function cname(c) { return c.service || c.name || String(c.id || '').slice(0, 12); }
  function tunnelsFor(ports) { // активные TCP-туннели хоста к портам контейнера (у сокет-туннеля rport=null — мимо)
    if (!dockerRemote || !dockerTunnels.length) return [];
    const hp = new Set(ports.map((p) => p.hostPort));
    return dockerTunnels.filter((t) => t.rport && hp.has(t.rport));
  }
  async function refreshTunnels() { // не кидает: transient-ошибка списка не должна ронять полл
    if (!dockerRemote) { dockerTunnels = []; return; }
    try {
      const r = await lite.rh.tunnelList();
      dockerTunnels = ((r && r.tunnels) || []).filter((t) => t.connId === dockerRemote.rhId && t.rport);
    } catch (_) {}
  }
  // Туннель к порту удалённого хоста; локальный порт стабилен между перезапусками (карта dockerUi.tunPorts:
  // предпочитаемый порт передаётся в rh:tunnelOpen, занят → main выдаст случайный и карта перезапишется).
  async function ensurePortTunnel(p, name) {
    const key = dockerRemote.rhId + ':' + p.hostPort;
    const prefer = (dockerUi.tunPorts || {})[key];
    let t;
    try { t = await lite.rh.tunnelOpen(dockerRemote.rhId, p.hostIp || '127.0.0.1', p.hostPort, `web: ${name} :${p.hostPort}`, prefer); }
    catch (e) { t = { ok: false, error: String(e) }; }
    if (!t || !t.ok) { toast((t && t.error) || 'Туннель не поднялся', { kind: 'err', ttl: 8000 }); return null; }
    dockerUi.tunPorts = dockerUi.tunPorts || {};
    if (dockerUi.tunPorts[key] !== t.port) { dockerUi.tunPorts[key] = t.port; persist('dockerUi', dockerUi); }
    refreshTunnels().then(() => { if (dockerView === 'list') fetchAndReconcile(true); }); // цепочка на строке сразу, не ждём тика
    return t;
  }
  async function openPortInBrowser(p, name) {
    if (!dockerRemote) { lite.openExternal(portUrl(p)); return; }
    const t = await ensurePortTunnel(p, name);
    if (t) lite.openExternal(portUrl(p, '127.0.0.1', t.port));
  }
  async function copyPortUrl(p, name) {
    let url = portUrl(p);
    if (dockerRemote) { const t = await ensurePortTunnel(p, name); if (!t) return; url = portUrl(p, '127.0.0.1', t.port); }
    lite.copyText(url); toast('URL скопирован: ' + url, { ttl: 4000 });
  }
  function closePortDd() { const d = document.getElementById('docker-portdd'); if (d) d.remove(); }
  function portDd(anchor, maxW) { // общий каркас выпадашки (паттерн db-conndd из kafka.js)
    closePortDd();
    const dd = el('div', 'db-conndd'); dd.id = 'docker-portdd';
    dd.addEventListener('click', (e) => e.stopPropagation()); // клик внутри не закрывает (document-once остаётся вооружён)
    document.body.appendChild(dd);
    const r0 = anchor.getBoundingClientRect();
    dd.style.left = Math.max(8, Math.min(r0.left, window.innerWidth - maxW)) + 'px';
    dd.style.top = (r0.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', closePortDd, { once: true }), 0);
    return dd;
  }
  function portsDropdown(anchor, ports, c) { // выбор порта у мультипортового контейнера
    const dd = portDd(anchor, 300);
    for (const p of ports) { // отсортированы парсером: веб-порты первыми
      const row = el('div', 'db-conndd-row');
      row.append(icon('external-link', 13), el('span', 'db-conndd-name', portLabel(p)));
      const t = tunnelsFor([p])[0];
      if (t) { const mk = el('span', 'db-conndd-mark', ':' + t.port); mk.title = 'Туннель уже открыт — локальный порт'; row.appendChild(mk); }
      const cp = iconBtn('drow-act dportdd-copy', 'copy', 'Копировать URL', 12);
      cp.onclick = (e) => { e.stopPropagation(); closePortDd(); copyPortUrl(p, cname(c)); };
      row.appendChild(cp);
      row.onclick = () => { closePortDd(); openPortInBrowser(p, cname(c)); };
      dd.appendChild(row);
    }
  }
  function hostTunnelsDropdown(anchor) { // клик по бейджу хоста — все активные туннели портов этого хоста
    const dd = portDd(anchor, 340);
    const paint = () => {
      dd.innerHTML = '';
      if (!dockerTunnels.length) { dd.appendChild(el('div', 'db-conndd-row', 'Активных туннелей нет')); return; }
      for (const t of dockerTunnels) {
        const row = el('div', 'db-conndd-row');
        row.append(icon('link', 13), el('span', 'db-conndd-name', `${t.rhost}:${t.rport} → 127.0.0.1:${t.port}`));
        if (t.label) row.appendChild(el('span', 'db-conndd-sub', t.label));
        const x = iconBtn('drow-act dportdd-copy', 'x', 'Закрыть туннель', 12);
        x.onclick = async (e) => {
          e.stopPropagation();
          try { await lite.rh.tunnelClose(t.tunId); } catch (_) {}
          await refreshTunnels(); paint();
          if (dockerView === 'list') fetchAndReconcile(true); // убрать значок-цепочку со строки
        };
        row.appendChild(x);
        dd.appendChild(row);
      }
    };
    paint();
  }
  // Кнопка «Открыть в браузере» (+ значок активного туннеля) — общая для строки списка и шапки detail-вида.
  function appendOpenBtn(parent, c) {
    const pub = parsePublishedPorts(c.ports);
    if (c.state === 'running' && pub.length) {
      const single = pub.length === 1;
      const b = iconBtn('drow-act dopen', 'external-link',
        single ? `Открыть в браузере: ${portUrl(pub[0])}${dockerRemote ? ' (через SSH-туннель)' : ''} · ПКМ — копировать URL` : 'Открыть в браузере — выбрать порт…', 14);
      b.onclick = (e) => { e.stopPropagation(); if (single) openPortInBrowser(pub[0], cname(c)); else portsDropdown(b, pub, c); };
      b.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); if (single) copyPortUrl(pub[0], cname(c)); else portsDropdown(b, pub, c); };
      parent.appendChild(b);
    }
    const tuns = tunnelsFor(pub); // и у остановленного контейнера: туннель должен быть виден и закрываем
    if (tuns.length) {
      const tb = iconBtn('drow-act dtun', 'link', tuns.map((t) => `туннель 127.0.0.1:${t.port} → ${t.rport}`).join('\n') + '\nКлик — закрыть', 14);
      tb.onclick = async (e) => {
        e.stopPropagation();
        for (const t of tuns) { try { await lite.rh.tunnelClose(t.tunId); } catch (_) {} }
        toast('Туннель закрыт'); await refreshTunnels();
        if (dockerView === 'list') fetchAndReconcile(true);
      };
      parent.appendChild(tb);
    }
  }
  function actsSig(c) { // набор кнопок строки зависит не только от state: порты и туннели тоже его меняют
    return c.state + '|' + (c.ports || '') + '|' + tunnelsFor(parsePublishedPorts(c.ports)).map((t) => t.tunId + ':' + t.port).sort().join(',');
  }
  function dockerContainerRow(c) {
    const row = el('div', 'docker-row clickable'); row.dataset.sig = actsSig(c); row._c = c; row.title = 'Открыть: логи и терминал';
    const dot = el('span', 'dstate dstate-' + dStateClass(c.state)); dot.title = c.status || c.state || '';
    row.appendChild(dot);
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', c.service || c.name || String(c.id).slice(0, 12)));
    main.appendChild(el('span', 'drow-sub', [c.image, c.ports].filter(Boolean).join('   ·   ')));
    row.appendChild(main);
    const acts = el('div', 'drow-acts'); fillContainerActs(acts, c); row.appendChild(acts);
    row.addEventListener('click', () => openDockerDetail(row._c)); // row._c kept fresh by updateContainerRow
    return row;
  }
  function updateContainerRow(row, c) { // in-place: dot/name/sub always; action buttons only when their signature changes
    row._c = c;
    const dot = row.querySelector('.dstate'); dot.className = 'dstate dstate-' + dStateClass(c.state); dot.title = c.status || c.state || '';
    row.querySelector('.drow-name').textContent = c.service || c.name || String(c.id).slice(0, 12);
    row.querySelector('.drow-sub').textContent = [c.image, c.ports].filter(Boolean).join('   ·   ');
    const sig = actsSig(c);
    if (row.dataset.sig !== sig) { row.dataset.sig = sig; const acts = row.querySelector('.drow-acts'); acts.innerHTML = ''; fillContainerActs(acts, c); }
  }
  function dockerPodRow(p) {
    const row = el('div', 'docker-row');
    const dot = el('span', 'dstate dstate-' + dStateClass(p.status)); dot.title = p.status || '';
    row.appendChild(dot);
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', p.name || String(p.id).slice(0, 12)));
    main.appendChild(el('span', 'drow-sub', `${p.containers} контейнер(ов)   ·   ${p.status || ''}`));
    row.appendChild(main);
    const acts = el('div', 'drow-acts');
    const running = p.status === 'running' || p.status === 'degraded';
    if (running) acts.appendChild(dActBtn('pod', 'stop', 'stop', 'Стоп пода', p.id));
    else acts.appendChild(dActBtn('pod', 'start', 'play', 'Старт пода', p.id));
    acts.appendChild(dRemoveBtn('pod', p.id, p.name || p.id, running));
    row.appendChild(acts);
    return row;
  }
  function dockerImageRow(im) {
    const row = el('div', 'docker-row');
    row.appendChild(icon('layers', 15));
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', (im.repo || '<none>') + (im.tag ? ':' + im.tag : '')));
    main.appendChild(el('span', 'drow-sub', [im.size, im.created].filter(Boolean).join('   ·   ')));
    row.appendChild(main);
    const acts = el('div', 'drow-acts');
    acts.appendChild(dRemoveBtn('image', im.id, (im.repo || '<none>') + (im.tag ? ':' + im.tag : ''), false));
    row.appendChild(acts);
    return row;
  }
  function dockerVolumeRow(vo) {
    const row = el('div', 'docker-row');
    row.appendChild(icon('database', 15));
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', vo.name));
    main.appendChild(el('span', 'drow-sub', vo.driver || ''));
    row.appendChild(main);
    const acts = el('div', 'drow-acts');
    acts.appendChild(dRemoveBtn('volume', vo.name, vo.name, false, ' Данные тома будут потеряны.'));
    row.appendChild(acts);
    return row;
  }
  async function dockerBulk(engine, action, ids, label) {
    if (!ids.length) return;
    let r; try { r = await lite.containers.bulk(engine, action, ids); } catch (e) { r = { ok: false, error: String(e) }; }
    if (r && r.ok) { toast((label || 'Готово') + ' ✓'); fetchAndReconcile(true); } // bulk acts on a container group → light refresh
    else toast((r && r.error) || 'Не выполнено', { kind: 'err', ttl: 9000 });
  }
  function dGroupTargets(action, list) { // group bulk (only start/pause/stop reach here): target just the applicable containers
    const isRun = (c) => c.state === 'running', isPause = (c) => c.state === 'paused';
    if (action === 'pause') return list.filter(isRun).map((c) => c.id);                        // pause → running
    if (action === 'stop') return list.filter((c) => isRun(c) || isPause(c)).map((c) => c.id); // stop → running/paused
    return list.filter((c) => !isRun(c) && !isPause(c)).map((c) => c.id);                      // start → stopped
  }
  function dGroupAct(action, iconName, title, engine, block) { // reads block._containers live (kept fresh by polls)
    const b = iconBtn('drow-act', iconName, title, 13);
    b.onclick = (e) => {
      e.stopPropagation();
      const ids = dGroupTargets(action, block._containers || []);
      if (!ids.length) { toast('Нечего: ' + title.toLowerCase(), { ttl: 2200 }); return; } // no error toast — informative no-op
      dockerBulk(engine, action, ids, title);
    };
    return b;
  }
  const D_UNGROUPED = '(ungrouped)'; // data-group sentinel for the «без группы» block
  // One compose group: gradient header (collapsible) + bulk actions + sort arrows + container rows.
  function dockerGroupBlock(engine, name, list) {
    const block = el('div', 'docker-group-block'); block.dataset.group = name || D_UNGROUPED; block._containers = list;
    const head = el('div', 'docker-group-head');
    const hue = dockerGroupHue(name || 'misc');
    head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
    head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
    const chev = icon(dockerGroupCollapsed(engine, name) ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
    head.appendChild(chev);
    head.appendChild(el('span', 'dgrp-name', name || 'Без группы'));
    head.appendChild(el('span', 'dgrp-count', String(list.length)));
    const acts = el('div', 'dgrp-acts');
    acts.append(dGroupAct('start', 'play', 'Старт всех', engine, block), dGroupAct('pause', 'pause', 'Пауза всех', engine, block), dGroupAct('stop', 'stop', 'Стоп всех', engine, block));
    const rm = iconBtn('drow-act danger', 'trash', 'Удалить всю группу', 13);
    rm.onclick = (e) => { e.stopPropagation(); const cs = block._containers || []; showConfirm('Удалить группу?', `Все контейнеры группы «${name || 'без группы'}» (${cs.length} шт.) будут удалены принудительно.`, 'Удалить', () => dockerBulk(engine, 'remove', cs.map((c) => c.id), 'Удаление группы')); };
    acts.appendChild(rm);
    if (name) { // sort arrows only for real compose groups (ungrouped stays last)
      const up = iconBtn('drow-act', 'chevron-up', 'Поднять группу', 13); up.onclick = (e) => { e.stopPropagation(); moveDockerGroup(engine, name, -1); };
      const dn = iconBtn('drow-act', 'chevron-down', 'Опустить группу', 13); dn.onclick = (e) => { e.stopPropagation(); moveDockerGroup(engine, name, 1); };
      acts.append(up, dn);
    }
    head.appendChild(acts);
    const body = el('div', 'docker-group-body');
    if (dockerGroupCollapsed(engine, name)) body.style.display = 'none';
    for (const c of list) { const row = dockerContainerRow(c); row.dataset.k = c.id; body.appendChild(row); }
    head.onclick = () => {
      toggleDockerGroup(engine, name);
      const col = dockerGroupCollapsed(engine, name);
      body.style.display = col ? 'none' : '';
      const nc = icon(col ? 'chevron-right' : 'chevron-down', 13); nc.classList.add('dgrp-chev');
      head.replaceChild(nc, head.firstChild);
    };
    block.append(head, body);
    return block;
  }
  // Live refresh of an existing group block: count + rows in place (head/bulk read block._containers).
  function updateGroupBlock(block, list) {
    block._containers = list;
    block.querySelector('.dgrp-count').textContent = String(list.length);
    reconcileRows(block.querySelector('.docker-group-body'), list, dockerContainerRow, updateContainerRow, (c) => c.id);
  }
  function renderDockerDisk(df) {
    const box = el('div', 'docker-disk');
    box.appendChild(icon('database', 13));
    const parts = [['Образы', df.images], ['Контейнеры', df.containers], ['Тома', df.volumes], ['Кэш', df.cache]].filter((p) => p[1]);
    if (!parts.length) { box.appendChild(el('span', 'ddisk-k', 'диск: н/д')); return box; }
    for (const [k, v] of parts) { const seg = el('span', 'ddisk-seg'); seg.appendChild(el('span', 'ddisk-k', k)); seg.appendChild(el('span', 'ddisk-v', v)); box.appendChild(seg); }
    return box;
  }
  // Get-or-create a collapsible accordion section (created once, then reused/updated by polls).
  function getOrCreateDSection(box, key, iconName, title) {
    let sec = box.querySelector(`.docker-sec[data-sec="${key}"]`);
    if (sec) return sec;
    sec = el('div', 'docker-sec'); sec.dataset.sec = key;
    const head = el('button', 'docker-sec-head');
    const chev = icon(dockerAcc[key] ? 'chevron-down' : 'chevron-right', 14); chev.classList.add('dsec-chev');
    head.append(chev, icon(iconName, 15), el('span', 'dsec-title', title), el('span', 'dsec-count', '0'));
    const inner = el('div', 'docker-sec-body');
    if (!dockerAcc[key]) inner.style.display = 'none';
    head.onclick = () => {
      dockerAcc[key] = !dockerAcc[key];
      inner.style.display = dockerAcc[key] ? '' : 'none';
      const nc = icon(dockerAcc[key] ? 'chevron-down' : 'chevron-right', 14); nc.classList.add('dsec-chev');
      head.replaceChild(nc, head.firstChild);
    };
    sec.append(head, inner);
    box.appendChild(sec);
    return sec;
  }
  function removeDSection(box, key) { const s = box.querySelector(`.docker-sec[data-sec="${key}"]`); if (s) s.remove(); }
  // Keyed list reconcile: update kept rows, add new, remove gone — preserves DOM identity & scroll (no flicker).
  // Rows are matched by `data-k`; createFn builds a node, updateFn (optional) mutates a kept node in place.
  function reconcileRows(parent, items, createFn, updateFn, keyFn) {
    const existing = new Map();
    for (const ch of [...parent.children]) if (ch.dataset && ch.dataset.k != null) existing.set(ch.dataset.k, ch);
    let prev = null;
    for (const it of items) {
      const k = String(keyFn(it));
      let row = existing.get(k);
      if (row) { existing.delete(k); if (updateFn) updateFn(row, it); }
      else { row = createFn(it); row.dataset.k = k; }
      const ref = prev ? prev.nextSibling : parent.firstChild;
      if (ref !== row) parent.insertBefore(row, ref);
      prev = row;
    }
    for (const row of existing.values()) row.remove();
  }
  function setSectionPlaceholder(body, cls, text) { body.innerHTML = ''; body.appendChild(el('div', cls, text)); }
  function clearSectionPlaceholder(body) { const ph = body.querySelector('.docker-empty, .docker-err'); if (ph) ph.remove(); }
  function reconcileDiskStrip(box, df) {
    const has = df && !df.error;
    const strip = box.querySelector('.docker-disk');
    if (!has) { if (strip) strip.remove(); return; }
    const parts = [['Образы', df.images], ['Контейнеры', df.containers], ['Тома', df.volumes], ['Кэш', df.cache]].filter((p) => p[1]);
    const sig = parts.map((p) => p[0] + '=' + p[1]).join(',');
    if (strip && strip.dataset.sig === sig) return;             // unchanged → no repaint
    const fresh = renderDockerDisk(df); fresh.dataset.sig = sig;
    if (strip) box.replaceChild(fresh, strip); else box.insertBefore(fresh, box.firstChild); // disk strip stays first
  }
  function reconcileContainers(box, payload) {
    const sec = getOrCreateDSection(box, 'containers', 'box', 'Контейнеры');
    const body = sec.querySelector('.docker-sec-body');
    if (payload && payload.error) { // transient read error: keep last good rows if present, else surface it (first load)
      if (!body.querySelector('.docker-group-block')) setSectionPlaceholder(body, 'docker-err', payload.error);
      return;
    }
    const items = (payload && payload.items) || [];
    sec.querySelector('.dsec-count').textContent = String(items.length);
    if (!items.length) return setSectionPlaceholder(body, 'docker-empty', 'Нет контейнеров.');
    clearSectionPlaceholder(body);
    const groups = {};
    for (const c of items) { const g = c.project || ''; (groups[g] = groups[g] || []).push(c); }
    const byName = (a, b) => (a.service || a.name || a.id).localeCompare(b.service || b.name || b.id);
    for (const g of Object.keys(groups)) groups[g].sort(byName); // stable row order across polls
    const named = Object.keys(groups).filter((g) => g);
    const order = dockerGroupOrder(dockerEngine, named);
    const desired = groups[''] ? [...order, ''] : [...order]; // ungrouped last
    const want = new Set(desired.map((g) => g || D_UNGROUPED));
    const present = new Map();
    for (const blk of [...body.querySelectorAll('.docker-group-block')]) {
      if (want.has(blk.dataset.group)) present.set(blk.dataset.group, blk); else blk.remove();
    }
    let prev = null;
    for (const g of desired) {
      const gkey = g || D_UNGROUPED;
      let blk = present.get(gkey);
      if (blk) updateGroupBlock(blk, groups[g]); else blk = dockerGroupBlock(dockerEngine, g, groups[g]);
      const ref = prev ? prev.nextSibling : body.firstChild;
      if (ref !== blk) body.insertBefore(blk, ref);
      prev = blk;
    }
  }
  function reconcileFlatSection(box, key, iconName, title, payload, rowFn, keyFn, emptyText) {
    const sec = getOrCreateDSection(box, key, iconName, title);
    const body = sec.querySelector('.docker-sec-body');
    if (payload && payload.error) { // transient read error: keep last good rows if present, else surface it (first load)
      if (!body.querySelector('[data-k]')) setSectionPlaceholder(body, 'docker-err', payload.error);
      return;
    }
    const items = (payload && payload.items) || [];
    sec.querySelector('.dsec-count').textContent = String(items.length);
    if (!items.length) return setSectionPlaceholder(body, 'docker-empty', emptyText);
    clearSectionPlaceholder(body);
    reconcileRows(body, items, rowFn, null, keyFn); // key embeds mutable fields → change swaps the row
  }
  // Update the list area in place from a snapshot — the heart of live refresh. Only the sections present in
  // `data` are touched, so a light poll ({containers[,pods]}) leaves the heavy images/volumes/disk strip as-is.
  function reconcileDockerList(data) {
    const box = dockerListBox; if (!box) return;
    if ('df' in data) reconcileDiskStrip(box, data.df);
    if ('containers' in data) reconcileContainers(box, data.containers);
    if (dockerEngine !== 'podman') removeDSection(box, 'pods');
    else if ('pods' in data) reconcileFlatSection(box, 'pods', 'grid', 'Поды', data.pods, dockerPodRow, (p) => 'pod:' + p.id + ':' + p.status + ':' + p.containers, 'Нет подов.');
    if ('images' in data) reconcileFlatSection(box, 'images', 'layers', 'Образы', data.images, dockerImageRow, (im) => 'img:' + im.id + ':' + im.repo + ':' + im.tag, 'Нет образов.');
    if ('volumes' in data) reconcileFlatSection(box, 'volumes', 'database', 'Тома', data.volumes, dockerVolumeRow, (vo) => 'vol:' + vo.name, 'Нет томов.');
  }
  // --- container detail view (live logs + interactive exec terminal), inside the module pane
  function openDockerDetail(c) {
    closeDockerDetail();
    stopDockerPoll(); dockerListBox = null; // leaving the list — pause live refresh
    dockerDetail = { id: c.id, name: c.service || c.name || String(c.id).slice(0, 12), engine: dockerEngine, state: c.state, ports: c.ports };
    dockerView = 'detail';
    dockerDetailTab = 'logs';
    renderDockerDetail();
  }
  function closeDockerDetail() { // stop streams, kill exec PTY, dispose xterm, drop listeners
    for (const u of dockerDetailUnsub.splice(0)) { try { u(); } catch (_) {} }
    if (dockerLogId) { try { lite.containers.logsStop(dockerLogId); } catch (_) {} dockerLogId = null; }
    if (dockerExecId) { try { lite.containers.execKill(dockerExecId); } catch (_) {} dockerExecId = null; }
    if (dockerExecTerm) { try { dockerExecTerm.dispose(); } catch (_) {} dockerExecTerm = null; dockerExecFit = null; }
    dockerDetail = null;
  }
  function backToDockerList() { closeDockerDetail(); dockerView = 'list'; renderDockerPanel(); }
  function startDockerLogs(view) {
    view.innerHTML = '';
    const pre = el('pre', 'docker-logs'); view.appendChild(pre);
    const d = dockerDetail; if (!d) return;
    const sid = 'log' + (++dockerUid) + Date.now().toString(36); dockerLogId = sid;
    const unData = lite.containers.onLogsData((p) => {
      if (p.streamId !== sid) return;
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.appendChild(document.createTextNode(stripAnsiSeq(p.data)));
      while (pre.childNodes.length > 3000) pre.removeChild(pre.firstChild);
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    });
    const unExit = lite.containers.onLogsExit((p) => { if (p.streamId === sid) pre.appendChild(document.createTextNode('\n— поток логов завершён —\n')); });
    dockerDetailUnsub.push(unData, unExit);
    lite.containers.logsStart(d.engine, d.id, sid, 800).then((r) => { if (r && r.error) pre.appendChild(document.createTextNode('[ошибка: ' + r.error + ']')); });
  }
  function startDockerExec(view) {
    view.innerHTML = '';
    const wrap = el('div', 'docker-term'); view.appendChild(wrap);
    const d = dockerDetail; if (!d) return;
    const term = new Terminal({ fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace', fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 3000 });
    const fit = new FitAddon(); term.loadAddon(fit);
    applyUnicode11(term);
    term.open(wrap);
    loadFastRenderer(term);
    try { fit.fit(); } catch (_) {}
    dockerExecTerm = term; dockerExecFit = fit;
    const xid = 'cx' + (++dockerUid) + Date.now().toString(36); dockerExecId = xid;
    const unData = lite.containers.onExecData((p) => { if (p.execId === xid) term.write(p.data); });
    const unExit = lite.containers.onExecExit((p) => { if (p.execId === xid) term.write('\r\n\x1b[33m— сеанс завершён —\x1b[0m\r\n'); });
    dockerDetailUnsub.push(unData, unExit);
    term.onData((data) => lite.containers.execWrite(xid, data));
    term.onResize(({ cols, rows }) => lite.containers.execResize(xid, cols, rows));
    lite.containers.execStart(d.engine, d.id, xid, term.cols, term.rows).then((r) => { if (r && r.error) term.write('\r\n\x1b[31m' + r.error + '\x1b[0m\r\n'); });
    setTimeout(() => { try { fit.fit(); term.focus(); } catch (_) {} }, 40);
  }
  // Вкладка «Файлы» detail-вида: браузер ФС контейнера (exec ls), клик по файлу → tmp-копия в вивер.
  // Классы rh-f* — общий стиль файл-браузера «Удалённых хостов» (styles.css), не дублируем.
  function startDockerFiles(view) {
    view.innerHTML = '';
    const d = dockerDetail; if (!d) return;
    let cur = '/';
    const bar = el('div', 'rh-fbar');
    const pathEl = el('span', 'rh-fpath');
    const list = el('div', 'rh-flist');
    const join = (base, name) => {
      if (name === '..') { const b = String(base).replace(/\/+$/, ''); const i = b.lastIndexOf('/'); return i <= 0 ? '/' : b.slice(0, i); }
      return (base === '/' ? '' : String(base).replace(/\/+$/, '')) + '/' + name;
    };
    async function load(p) {
      list.innerHTML = ''; list.appendChild(el('div', 'git-loading', 'Загрузка…'));
      let r;
      try { r = await lite.containers.fsList(d.engine, d.id, p); } catch (e) { r = { ok: false, error: String(e) }; }
      if (!dockerDetail || dockerDetail.id !== d.id) return;
      list.innerHTML = '';
      if (!r || !r.ok) { list.appendChild(el('div', 'db-warn', '⚠ ' + ((r && r.error) || 'не удалось прочитать каталог'))); return; }
      cur = r.path; pathEl.textContent = cur; pathEl.title = cur;
      if (!r.entries.length) list.appendChild(el('div', 'docker-empty', 'Пусто'));
      for (const e of r.entries) {
        const row = el('div', 'rh-frow');
        row.appendChild(icon(e.dir ? 'folder' : 'file', 15));
        row.appendChild(el('span', 'rh-fname', e.name));
        row.onclick = async () => {
          if (e.dir) { load(join(cur, e.name)); return; }
          toast('Открываю в вивере…', { ttl: 2500 });
          let o;
          try { o = await lite.containers.fsOpenInViewer(d.engine, d.id, join(cur, e.name)); } catch (err) { o = { ok: false, error: String(err) }; }
          if (!o || !o.ok) toast((o && o.error) || 'Не удалось открыть файл', { kind: 'err', ttl: 8000 });
          else toast('Файл из контейнера в вивере (копия — правки в контейнер не вернутся)', { ttl: 6000 });
        };
        list.appendChild(row);
      }
    }
    const up = iconBtn('drow-act', 'chevron-up', 'Вверх', 14); up.onclick = () => load(join(cur, '..'));
    const refresh = iconBtn('drow-act', 'refresh', 'Обновить', 14); refresh.onclick = () => load(cur);
    bar.append(up, pathEl, refresh);
    view.append(bar, list);
    load(cur);
  }
  function renderDockerDetail() {
    const d = dockerDetail; if (!d) { dockerView = 'list'; renderDockerPanel(); return; }
    $('#docker-tabs').style.display = 'none';
    const body = $('#docker-body'); body.innerHTML = '';
    const head = el('div', 'docker-detail-head');
    const back = iconBtn('drow-act', 'chevron-left', 'Назад к списку', 16);
    back.onclick = backToDockerList;
    head.appendChild(back);
    head.appendChild(el('span', 'dstate dstate-' + dStateClass(d.state)));
    head.appendChild(el('span', 'docker-detail-name', d.name));
    appendOpenBtn(head, { state: d.state, ports: d.ports, name: d.name, id: d.id }); // «открыть в браузере» и из деталей
    body.appendChild(head);
    const tabsEl = el('div', 'docker-subtabs');
    const logsView = el('div', 'docker-detail-view');
    const termView = el('div', 'docker-detail-view');
    const filesView = el('div', 'docker-detail-view docker-files');
    let logsStarted = false, execStarted = false, filesStarted = false;
    const show = (k) => {
      dockerDetailTab = k;
      tabsEl.querySelectorAll('.docker-subtab').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      logsView.style.display = k === 'logs' ? '' : 'none';
      termView.style.display = k === 'term' ? '' : 'none';
      filesView.style.display = k === 'files' ? '' : 'none';
      if (k === 'logs' && !logsStarted) { logsStarted = true; startDockerLogs(logsView); }
      else if (k === 'term' && !execStarted) { execStarted = true; startDockerExec(termView); }
      else if (k === 'files' && !filesStarted) { filesStarted = true; startDockerFiles(filesView); }
      else if (k === 'term' && dockerExecFit) setTimeout(() => { try { dockerExecFit.fit(); dockerExecTerm && dockerExecTerm.focus(); } catch (_) {} }, 30);
    };
    for (const [k, label] of [['logs', 'Логи'], ['term', 'Терминал'], ['files', 'Файлы']]) {
      const t = el('button', 'docker-subtab'); t.dataset.k = k; t.textContent = label; t.onclick = () => show(k); tabsEl.appendChild(t);
    }
    body.append(tabsEl, logsView, termView, filesView);
    show(dockerDetailTab || 'logs');
  }
  async function renderDockerPanel() {
    if (dockerView === 'detail') { closeDockerDetail(); dockerView = 'list'; }
    stopDockerPoll(); dockerListBox = null; // full rebuild — drop the old in-place target & poll
    await ensureRemoteStatus(); // удалённый контекст мог остаться с прошлого открытия окна
    if (dockerRemote) dockerEngine = dockerRemote.engine;
    $('#docker-tabs').style.display = '';
    const seq = ++dockerRenderSeq;
    const body = $('#docker-body');
    if (!dockerDetect) { // probe both engines once (cached; ⟳ resets it)
      body.innerHTML = '<div class="git-loading">Поиск Docker / Podman…</div>';
      try { dockerDetect = await lite.containers.detect(); } catch (_) { dockerDetect = { docker: {}, podman: {} }; }
      if (seq !== dockerRenderSeq || !dockerOpen) return;
    }
    renderDockerTabs();
    const eng = dockerDetect[dockerEngine] || {};
    body.innerHTML = '';
    body.appendChild(renderDockerEnv(eng));
    if (!eng.cli) { // engine CLI not found
      const notice = el('div', 'docker-notice');
      notice.appendChild(icon('warning', 26));
      notice.appendChild(el('div', 'docker-notice-t', (dockerEngine === 'docker' ? 'Docker' : 'Podman') + ' не установлен'));
      notice.appendChild(el('div', 'docker-notice-s', 'CLI не найден в системе. Установи и нажми ⟳ для повторной проверки.'));
      body.appendChild(notice);
      return;
    }
    const listBox = el('div', 'docker-list');
    listBox.appendChild(el('div', 'git-loading', 'Считываю объекты…'));
    body.appendChild(listBox);
    let data;
    try { const [d] = await Promise.all([lite.containers.list(dockerEngine), refreshTunnels()]); data = d; }
    catch (e) { data = { containers: { error: String(e) } }; }
    if (seq !== dockerRenderSeq || !dockerOpen) return;
    listBox.innerHTML = '';
    if (data.error) { listBox.appendChild(el('div', 'docker-err', data.error)); return; }
    dockerListBox = listBox;
    reconcileDockerList(data); // first paint goes through the same in-place engine the polls use
    startDockerPoll();         // begin live updates (statuses change / new appear / gone disappear, no ⟳ needed)
  }

  // --- live list refresh: poll the engine while the list is visible and reconcile in place (no ⟳ needed)
  function stopDockerPoll() { if (dockerPoll) { clearInterval(dockerPoll); dockerPoll = null; } }
  // Fetch a snapshot + in-place reconcile. light=true asks the backend for only the fast, frequently-changing
  // data (containers/pods), skipping the heavy `system df`/images/volumes — that's the per-tick poll path.
  async function fetchAndReconcile(light) {
    if (dockerListBusy || !dockerOpen || dockerView !== 'list' || !dockerListBox) return; // in flight, or not on the list
    const eng = dockerEngine;
    dockerListBusy = true;
    let data;
    try { const [d] = await Promise.all([lite.containers.list(eng, light ? { light: true } : undefined), refreshTunnels()]); data = d; }
    catch (_) { data = null; } finally { dockerListBusy = false; }
    if (!data || data.error) return;                                                       // transient error: keep last view
    if (!dockerOpen || dockerView !== 'list' || dockerEngine !== eng || !dockerListBox) return; // context changed mid-fetch
    reconcileDockerList(data);
  }
  function startDockerPoll() {
    stopDockerPoll(); dockerPollTick = 0;
    dockerPoll = setInterval(() => {
      if (document.hidden) return;                    // pause when window/tab is hidden
      dockerPollTick += 1;
      fetchAndReconcile(dockerPollTick % 10 !== 0);   // light every tick; full every 10th (~30s) to catch image/volume/df drift
    }, 3000);
  }

  // Рефит exec-терминала контейнера при ресайзе (вызывается ядром из refitActiveTerminal).
  function refitExec() { if (dockerExecFit && dockerView === 'detail' && dockerDetailTab === 'term') { try { dockerExecFit.fit(); } catch (_) {} } }
  // ⟳ в шапке панели: сбросить кэш детекта и перечитать.
  function refresh() { dockerDetect = null; if (dockerOpen) renderDockerPanel(); }

  // Смена темы редактора: перекрасить живой exec-терминал (вызывается ядром из applyTheme).
  function applyTermTheme() { if (dockerExecTerm) { try { dockerExecTerm.options.theme = termTheme(); } catch (_) {} } }

  return { isOpen: () => dockerOpen, setOpen: setDockerOpen, toggle: toggleDocker, refitExec, refresh, applyTermTheme };
}
