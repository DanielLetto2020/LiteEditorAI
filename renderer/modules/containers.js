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
  let dockerRenderSeq = 0;        // stale-render guard (async render vs tab/refresh switches)
  let dockerUid = 0;              // unique-id counter for log/exec streams (decoupled from the render guard)
  const dockerAcc = { containers: true, pods: true, images: false, volumes: false }; // accordion open state
  // Persisted per-engine group order + collapse: { order:{engine:[names]}, collapsed:{'engine:name':bool} }
  let dockerUi = (STORE.dockerUi && typeof STORE.dockerUi === 'object') ? STORE.dockerUi : {};
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
    if (running) acts.append(dActBtn('container', 'pause', 'pause', 'Пауза', c.id), dActBtn('container', 'restart', 'refresh', 'Перезапуск', c.id), dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
    else if (paused) acts.append(dActBtn('container', 'unpause', 'play', 'Возобновить', c.id), dActBtn('container', 'stop', 'stop', 'Стоп', c.id));
    else acts.appendChild(dActBtn('container', 'start', 'play', 'Старт', c.id));
    acts.appendChild(dRemoveBtn('container', c.id, c.service || c.name || c.id, running));
  }
  function dockerContainerRow(c) {
    const row = el('div', 'docker-row clickable'); row.dataset.st = c.state; row._c = c; row.title = 'Открыть: логи и терминал';
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
  function updateContainerRow(row, c) { // in-place: dot/name/sub always; action buttons only when state changes
    row._c = c;
    const dot = row.querySelector('.dstate'); dot.className = 'dstate dstate-' + dStateClass(c.state); dot.title = c.status || c.state || '';
    row.querySelector('.drow-name').textContent = c.service || c.name || String(c.id).slice(0, 12);
    row.querySelector('.drow-sub').textContent = [c.image, c.ports].filter(Boolean).join('   ·   ');
    if (row.dataset.st !== c.state) { row.dataset.st = c.state; const acts = row.querySelector('.drow-acts'); acts.innerHTML = ''; fillContainerActs(acts, c); }
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
    stopDockerPoll(); dockerListBox = null; // full rebuild — drop the old in-place target & poll
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
    try { data = await lite.containers.list(eng, light ? { light: true } : undefined); }
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
