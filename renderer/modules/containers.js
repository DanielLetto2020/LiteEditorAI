// LiteEditor — модуль «Контейнеры» (Docker/Podman) правого слота.
// Изолирован по образцу textproc.js: всё из ядра — через host, UI-хелперы — из ui.js,
// бэкенд — window.lite.containers.*. xterm для exec-терминала импортируется здесь же.
// host: { STORE, persist, settings, layout, GUTTER, saveUiState, refitActiveTerminal,
//         closeOtherPanels, termTheme, applyUnicode11, loadFastRenderer }
import { el, icon, iconBtn, toast, showConfirm } from '../ui.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// System-wide (not per-project) right-pane manager: tabs Docker|Podman, accordion sections for
// containers (grouped by compose project), pods (podman), images, volumes, with lifecycle actions.
export function initContainers(host) {
  const { STORE, persist, settings, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, termTheme, applyUnicode11, loadFastRenderer } = host;

  let dockerOpen = false;      // модуль контейнеров (docker/podman) справа открыт
  let dockerEngine = 'docker';   // active tab
  let dockerDetect = null;        // cached {docker:{cli,compose,composePlugin}, podman:{...}}
  let dockerRenderSeq = 0;        // stale-render guard
  const dockerAcc = { containers: true, pods: true, images: false, volumes: false }; // accordion open state
  // Persisted per-engine group order + collapse: { order:{engine:[names]}, collapsed:{'engine:name':bool} }
  let dockerUi = (STORE.dockerUi && typeof STORE.dockerUi === 'object') ? STORE.dockerUi : {};
  let dockerView = 'list';        // 'list' | 'detail'
  let dockerDetail = null;        // { id, name, engine, state } when viewing one container
  let dockerDetailTab = 'logs';   // 'logs' | 'term'
  let dockerLogId = null, dockerExecId = null, dockerExecTerm = null, dockerExecFit = null;
  const dockerDetailUnsub = [];   // IPC listener cleanups for the open detail view

  function dockerGroupOrder(engine, names) { // saved order first, new groups appended (alpha)
    const saved = (dockerUi.order && dockerUi.order[engine]) || [];
    const head = saved.filter((n) => names.includes(n));
    const tail = names.filter((n) => !head.includes(n)).sort((a, b) => a.localeCompare(b));
    return [...head, ...tail];
  }
  function moveDockerGroup(engine, name, dir, allNames) {
    const order = dockerGroupOrder(engine, allNames);
    const i = order.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    dockerUi.order = dockerUi.order || {}; dockerUi.order[engine] = order; persist('dockerUi', dockerUi);
    renderDockerPanel();
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
    if (!open) { closeDockerDetail(); dockerView = 'list'; } // tear down logs/exec on close
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

  function renderDockerTabs() {
    const t = $('#docker-tabs'); t.innerHTML = '';
    for (const e of ['docker', 'podman']) {
      const installed = dockerDetect ? !!(dockerDetect[e] && dockerDetect[e].cli) : true;
      const tab = el('button', 'docker-tab' + (e === dockerEngine ? ' on' : '') + (installed ? '' : ' off'));
      tab.appendChild(icon('box', 15));
      tab.appendChild(el('span', null, e === 'docker' ? 'Docker' : 'Podman'));
      tab.onclick = () => { if (e !== dockerEngine) { dockerEngine = e; renderDockerPanel(); } };
      t.appendChild(tab);
    }
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
  // Collapsible section with a count badge; `fill(inner)` populates the body.
  function dockerAccordion(key, iconName, title, count, fill) {
    const sec = el('div', 'docker-sec');
    const head = el('button', 'docker-sec-head');
    const chev = icon(dockerAcc[key] ? 'chevron-down' : 'chevron-right', 14); chev.classList.add('dsec-chev');
    head.appendChild(chev);
    head.appendChild(icon(iconName, 15));
    head.appendChild(el('span', 'dsec-title', title));
    head.appendChild(el('span', 'dsec-count', String(count)));
    const inner = el('div', 'docker-sec-body');
    if (!dockerAcc[key]) inner.style.display = 'none';
    fill(inner);
    head.onclick = () => {
      dockerAcc[key] = !dockerAcc[key];
      inner.style.display = dockerAcc[key] ? '' : 'none';
      const nc = icon(dockerAcc[key] ? 'chevron-down' : 'chevron-right', 14); nc.classList.add('dsec-chev');
      head.replaceChild(nc, head.firstChild);
    };
    sec.append(head, inner);
    return sec;
  }
  async function dockerDo(kind, action, id, label) {
    let r;
    try { r = await lite.containers.action(dockerEngine, kind, action, id); } catch (e) { r = { ok: false, error: String(e) }; }
    if (r && r.ok) { toast((label || 'Готово') + ' ✓'); renderDockerPanel(); }
    else toast((r && r.error) || 'Команда не выполнена', { kind: 'err', ttl: 8000 });
  }
  function dActBtn(kind, action, iconName, title, id, size) {
    const b = iconBtn('drow-act', iconName, title, size || 14);
    b.onclick = (e) => { e.stopPropagation(); dockerDo(kind, action, id, title); };
    return b;
  }
  function dRemoveBtn(kind, id, label, force, extra) {
    const b = iconBtn('drow-act danger', 'trash', 'Удалить', 14);
    b.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить?', `«${label}» будет удалён${force ? ' (принудительно — объект запущен)' : ''}.${extra || ''}`, 'Удалить', () => dockerDo(kind, 'remove', id, 'Удаление')); };
    return b;
  }
  function dockerContainerRow(c) {
    const row = el('div', 'docker-row');
    const dot = el('span', 'dstate dstate-' + dStateClass(c.state)); dot.title = c.status || c.state || '';
    row.appendChild(dot);
    const main = el('div', 'drow-main');
    main.appendChild(el('span', 'drow-name', c.service || c.name || String(c.id).slice(0, 12)));
    main.appendChild(el('span', 'drow-sub', [c.image, c.ports].filter(Boolean).join('   ·   ')));
    row.appendChild(main);
    const acts = el('div', 'drow-acts');
    const running = c.state === 'running', paused = c.state === 'paused';
    if (running) {
      acts.appendChild(dActBtn('container', 'pause', 'pause', 'Пауза', c.id));
      acts.appendChild(dActBtn('container', 'restart', 'refresh', 'Перезапуск', c.id));
      acts.appendChild(dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
    } else if (paused) {
      acts.appendChild(dActBtn('container', 'unpause', 'play', 'Возобновить', c.id));
      acts.appendChild(dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
    } else {
      acts.appendChild(dActBtn('container', 'start', 'play', 'Старт', c.id));
    }
    acts.appendChild(dRemoveBtn('container', c.id, c.service || c.name || c.id, running));
    row.appendChild(acts);
    row.classList.add('clickable'); row.title = 'Открыть: логи и терминал';
    row.addEventListener('click', () => openDockerDetail(c));
    return row;
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
  function dockerSectionList(box, payload, iconName, title, key, rowFn, emptyText) {
    const items = (payload && payload.items) || [];
    box.appendChild(dockerAccordion(key, iconName, title, items.length, (inner) => {
      if (payload && payload.error) { inner.appendChild(el('div', 'docker-err', payload.error)); return; }
      if (!items.length) { inner.appendChild(el('div', 'docker-empty', emptyText)); return; }
      for (const it of items) inner.appendChild(rowFn(it));
    }));
  }
  async function dockerBulk(engine, action, ids, label) {
    if (!ids.length) return;
    let r; try { r = await lite.containers.bulk(engine, action, ids); } catch (e) { r = { ok: false, error: String(e) }; }
    if (r && r.ok) { toast((label || 'Готово') + ' ✓'); renderDockerPanel(); }
    else toast((r && r.error) || 'Не выполнено', { kind: 'err', ttl: 9000 });
  }
  function dGroupAct(action, iconName, title, engine, ids) {
    const b = iconBtn('drow-act', iconName, title, 13);
    b.onclick = (e) => { e.stopPropagation(); dockerBulk(engine, action, ids, title); };
    return b;
  }
  // One compose group: gradient header (collapsible) + bulk actions + sort arrows + container rows.
  function dockerGroupBlock(engine, name, list, allNames) {
    const block = el('div', 'docker-group-block');
    const head = el('div', 'docker-group-head');
    const hue = dockerGroupHue(name || 'misc');
    head.style.background = `linear-gradient(90deg, hsla(${hue},55%,50%,.22), hsla(${hue},55%,50%,.05) 55%, transparent)`;
    head.style.borderLeft = `3px solid hsl(${hue},60%,55%)`;
    const chev = icon(dockerGroupCollapsed(engine, name) ? 'chevron-right' : 'chevron-down', 13); chev.classList.add('dgrp-chev');
    head.appendChild(chev);
    head.appendChild(el('span', 'dgrp-name', name || 'Без группы'));
    head.appendChild(el('span', 'dgrp-count', String(list.length)));
    const acts = el('div', 'dgrp-acts');
    const ids = list.map((c) => c.id);
    acts.appendChild(dGroupAct('start', 'play', 'Старт всех', engine, ids));
    acts.appendChild(dGroupAct('pause', 'pause', 'Пауза всех', engine, ids));
    acts.appendChild(dGroupAct('stop', 'stop', 'Стоп всех', engine, ids));
    const rm = iconBtn('drow-act danger', 'trash', 'Удалить всю группу', 13);
    rm.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить группу?', `Все контейнеры группы «${name || 'без группы'}» (${list.length} шт.) будут удалены принудительно.`, 'Удалить', () => dockerBulk(engine, 'remove', ids, 'Удаление группы')); };
    acts.appendChild(rm);
    if (name) { // sort arrows only for real compose groups (ungrouped stays last)
      const up = iconBtn('drow-act', 'chevron-up', 'Поднять группу', 13); up.onclick = (e) => { e.stopPropagation(); moveDockerGroup(engine, name, -1, allNames); };
      const dn = iconBtn('drow-act', 'chevron-down', 'Опустить группу', 13); dn.onclick = (e) => { e.stopPropagation(); moveDockerGroup(engine, name, 1, allNames); };
      acts.append(up, dn);
    }
    head.appendChild(acts);
    const body = el('div', 'docker-group-body');
    if (dockerGroupCollapsed(engine, name)) body.style.display = 'none';
    for (const c of list) body.appendChild(dockerContainerRow(c));
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
  function renderDockerDisk(df) {
    const box = el('div', 'docker-disk');
    box.appendChild(icon('database', 13));
    const parts = [['Образы', df.images], ['Контейнеры', df.containers], ['Тома', df.volumes], ['Кэш', df.cache]].filter((p) => p[1]);
    if (!parts.length) { box.appendChild(el('span', 'ddisk-k', 'диск: н/д')); return box; }
    for (const [k, v] of parts) { const seg = el('span', 'ddisk-seg'); seg.appendChild(el('span', 'ddisk-k', k)); seg.appendChild(el('span', 'ddisk-v', v)); box.appendChild(seg); }
    return box;
  }
  function renderDockerSections(box, data) {
    if (data.df && !data.df.error) box.appendChild(renderDockerDisk(data.df));
    const cont = (data.containers && data.containers.items) || [];
    box.appendChild(dockerAccordion('containers', 'box', 'Контейнеры', cont.length, (inner) => {
      if (data.containers && data.containers.error) { inner.appendChild(el('div', 'docker-err', data.containers.error)); return; }
      if (!cont.length) { inner.appendChild(el('div', 'docker-empty', 'Нет контейнеров.')); return; }
      const groups = {};
      for (const c of cont) { const g = c.project || ''; (groups[g] = groups[g] || []).push(c); }
      const named = Object.keys(groups).filter((g) => g);
      const order = dockerGroupOrder(dockerEngine, named);
      for (const g of order) inner.appendChild(dockerGroupBlock(dockerEngine, g, groups[g], order));
      if (groups['']) inner.appendChild(dockerGroupBlock(dockerEngine, '', groups[''], order)); // ungrouped last
    }));
    if (dockerEngine === 'podman') dockerSectionList(box, data.pods, 'grid', 'Поды', 'pods', dockerPodRow, 'Нет подов.');
    dockerSectionList(box, data.images, 'layers', 'Образы', 'images', dockerImageRow, 'Нет образов.');
    dockerSectionList(box, data.volumes, 'database', 'Тома', 'volumes', dockerVolumeRow, 'Нет томов.');
  }
  // --- container detail view (live logs + interactive exec terminal), inside the module pane
  function openDockerDetail(c) {
    closeDockerDetail();
    dockerDetail = { id: c.id, name: c.service || c.name || String(c.id).slice(0, 12), engine: dockerEngine, state: c.state };
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
    const sid = 'log' + (++dockerRenderSeq) + Date.now().toString(36); dockerLogId = sid;
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
    const xid = 'cx' + (++dockerRenderSeq) + Date.now().toString(36); dockerExecId = xid;
    const unData = lite.containers.onExecData((p) => { if (p.execId === xid) term.write(p.data); });
    const unExit = lite.containers.onExecExit((p) => { if (p.execId === xid) term.write('\r\n\x1b[33m— сеанс завершён —\x1b[0m\r\n'); });
    dockerDetailUnsub.push(unData, unExit);
    term.onData((data) => lite.containers.execWrite(xid, data));
    term.onResize(({ cols, rows }) => lite.containers.execResize(xid, cols, rows));
    lite.containers.execStart(d.engine, d.id, xid, term.cols, term.rows).then((r) => { if (r && r.error) term.write('\r\n\x1b[31m' + r.error + '\x1b[0m\r\n'); });
    setTimeout(() => { try { fit.fit(); term.focus(); } catch (_) {} }, 40);
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
    body.appendChild(head);
    const tabsEl = el('div', 'docker-subtabs');
    const logsView = el('div', 'docker-detail-view');
    const termView = el('div', 'docker-detail-view');
    let logsStarted = false, execStarted = false;
    const show = (k) => {
      dockerDetailTab = k;
      tabsEl.querySelectorAll('.docker-subtab').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      logsView.style.display = k === 'logs' ? '' : 'none';
      termView.style.display = k === 'term' ? '' : 'none';
      if (k === 'logs' && !logsStarted) { logsStarted = true; startDockerLogs(logsView); }
      else if (k === 'term' && !execStarted) { execStarted = true; startDockerExec(termView); }
      else if (k === 'term' && dockerExecFit) setTimeout(() => { try { dockerExecFit.fit(); dockerExecTerm && dockerExecTerm.focus(); } catch (_) {} }, 30);
    };
    for (const [k, label] of [['logs', 'Логи'], ['term', 'Терминал']]) {
      const t = el('button', 'docker-subtab'); t.dataset.k = k; t.textContent = label; t.onclick = () => show(k); tabsEl.appendChild(t);
    }
    body.append(tabsEl, logsView, termView);
    show(dockerDetailTab || 'logs');
  }
  async function renderDockerPanel() {
    if (dockerView === 'detail') { closeDockerDetail(); dockerView = 'list'; }
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
    try { data = await lite.containers.list(dockerEngine); } catch (e) { data = { containers: { error: String(e) } }; }
    if (seq !== dockerRenderSeq || !dockerOpen) return;
    listBox.innerHTML = '';
    if (data.error) { listBox.appendChild(el('div', 'docker-err', data.error)); return; }
    renderDockerSections(listBox, data);
  }

  // Рефит exec-терминала контейнера при ресайзе (вызывается ядром из refitActiveTerminal).
  function refitExec() { if (dockerExecFit && dockerView === 'detail' && dockerDetailTab === 'term') { try { dockerExecFit.fit(); } catch (_) {} } }
  // ⟳ в шапке панели: сбросить кэш детекта и перечитать.
  function refresh() { dockerDetect = null; if (dockerOpen) renderDockerPanel(); }

  // Смена темы редактора: перекрасить живой exec-терминал (вызывается ядром из applyTheme).
  function applyTermTheme() { if (dockerExecTerm) { try { dockerExecTerm.options.theme = termTheme(); } catch (_) {} } }

  return { isOpen: () => dockerOpen, setOpen: setDockerOpen, toggle: toggleDocker, renderPanel: renderDockerPanel, refitExec, refresh, applyTermTheme };
}
