// LiteEditor — модуль-окно «Серверы» (module.html#servers): дашборд всех серверов в одном месте.
// Мониторинг (ресурсы, история, проблемы с уведомлениями), информация (ОС, адреса, диски, обновления)
// и управление (контейнеры, сервисы systemd, журнал, du, перезагрузка) — по SSH-профилям «Удалённых
// хостов», без установки чего-либо на сервер. Терминал и файлы не дублируются: кнопки открывают
// «Удалённые хосты» на нужном профиле, полный менеджер контейнеров — окно «Контейнеры» на этом хосте.
// Бэкенд — window.lite.servers.* (lib/servers.js + проба lib/servers-probe.js).
// Изоляция: только ui.js/i18n.js и host; цвета — токены (.srv-* в styles.css).
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';
import { t } from '../i18n.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// ---------------------------------------------------------------- форматирование
function fmtBytes(n, digits) {
  if (n == null || !Number.isFinite(n)) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(digits != null ? digits : 1)) + ' ' + u[i];
}
function fmtRate(bps) { // байты/с → биты/с, как принято для каналов
  if (bps == null || !Number.isFinite(bps)) return '—';
  const b = bps * 8; const u = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с']; let i = 0, v = b;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}
function fmtPct(v) { return v == null || !Number.isFinite(v) ? '—' : (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%'; }
function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return t('{0} д {1} ч', d, h);
  if (h) return t('{0} ч {1} мин', h, m);
  return t('{0} мин', m);
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t('{0} с назад', s);
  if (s < 3600) return t('{0} мин назад', Math.floor(s / 60));
  if (s < 86400) return t('{0} ч назад', Math.floor(s / 3600));
  return t('{0} д назад', Math.floor(s / 86400));
}
function fmtTime(ts, withDate) {
  const d = new Date(ts); const p = (x) => String(x).padStart(2, '0');
  return (withDate ? p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' : '') + p(d.getHours()) + ':' + p(d.getMinutes());
}
const STATE = {
  online: ['ok', 'на связи'], unknown: ['wait', 'опрос…'], offline: ['crit', 'нет связи'], auth: ['crit', 'ошибка входа'],
  hostkey: ['crit', 'ключ хоста изменился'], disabled: ['off', 'опрос выключен'], noprofile: ['crit', 'нет SSH-профиля'],
};
const SEV = { crit: ['crit', 'критично', 'warning'], warn: ['warn', 'внимание', 'warning'], info: ['info', 'к сведению', 'info'] };
const CTR_STATE = { running: ['ok', 'работает'], exited: ['off', 'остановлен'], created: ['off', 'создан'], paused: ['warn', 'пауза'],
  restarting: ['warn', 'перезапуск'], dead: ['crit', 'мёртв'], stopping: ['warn', 'останавливается'], removing: ['warn', 'удаляется'] };
const VPN_RE = /vpn|wireguard|\bwg\b|xray|v2ray|amnezia|openvpn|outline|shadowsocks|3x-ui|marzban|hysteria/i;

function dot(kind) { return el('span', 'srv-dot srv-dot-' + kind); }
function stateChip(state) { const [k, label] = STATE[state] || STATE.unknown; const c = el('span', 'srv-state srv-state-' + k); c.append(dot(k), el('span', null, label)); return c; }
function bar(pct, warnAt, critAt) {
  const b = el('div', 'srv-bar'); const f = el('div', 'srv-bar-fill');
  const v = Math.max(0, Math.min(100, pct || 0)); f.style.width = v + '%';
  if (critAt != null && v >= critAt) f.classList.add('crit'); else if (warnAt != null && v >= warnAt) f.classList.add('warn');
  b.appendChild(f); return b;
}
function maxDisk(s) { let m = null; for (const d of s.disks || []) if (!m || (d.pct || 0) > (m.pct || 0)) m = d; return m; }
function activeIssues(s) { return (s.issues || []).filter((i) => !i.muted); }
function issueText(i) { return t(i.tpl, ...(i.args || [])); }
function hostLine(s) { return s.host ? `${s.host.user ? s.host.user + '@' : ''}${s.host.host}${s.host.port && +s.host.port !== 22 ? ':' + s.host.port : ''}` : t('профиль не найден'); }
function mainIps(s) { return (s.ips || []).filter((i) => !i.virt && i.fam === 4).map((i) => i.addr); }

// ---------------------------------------------------------------- график (SVG, наведение — линия + подсказка)
// points: [[t, ...]]; series: [{ idx, label, cls, fmt }]; opts: { h, max, min, compact, fmtT }
function lineChart(points, series, opts = {}) {
  // Подписи осей — HTML поверх (SVG растягивается по ширине, его текст исказился бы). Высота viewBox
  // равна CSS-высоте графика (.srv-chart svg), поэтому по вертикали 1 единица = 1 px.
  const axes = !opts.compact;
  const W = 600, H = opts.h || 120, padL = 0, padR = 0, padT = axes ? 8 : 3, padB = axes ? 2 : 3;
  const wrap = el('div', 'srv-chart' + (opts.compact ? ' compact' : ' axes'));
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  wrap.appendChild(svg);
  if (!points || points.length < 2) { wrap.appendChild(el('div', 'srv-chart-empty', 'данные копятся…')); return wrap; }
  const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
  let max = opts.max != null ? opts.max : 0;
  if (opts.max == null) for (const p of points) for (const s of series) max = Math.max(max, Number(p[s.idx]) || 0);
  if (!(max > 0)) max = 1;
  if (opts.max == null) max *= 1.1;
  const x = (tt) => padL + (W - padL - padR) * ((tt - t0) / Math.max(1, t1 - t0));
  const y = (v) => H - padB - (H - padT - padB) * Math.max(0, Math.min(1, (Number(v) || 0) / max));
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  if (axes) { // сетка: 0 / половина / максимум, подписи слева; время — под графиком
    for (const f of [0, 0.5, 1]) {
      const yy = y(max * f);
      svg.appendChild(mk('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: 'srv-gridline' }));
      const lab = el('span', 'srv-ylab', series[0].fmt(max * f, true)); lab.style.top = (yy - 6) + 'px'; wrap.appendChild(lab);
    }
    const xl = el('div', 'srv-xlabs');
    xl.append(el('span', null, fmtTime(t0, t1 - t0 > 20 * 3600e3)), el('span', null, fmtTime(t1, false)));
    wrap.appendChild(xl);
  }
  for (const s of series) {
    const d = points.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[s.idx]).toFixed(1)).join(' ');
    if (series.length === 1) svg.appendChild(mk('path', { d: d + ` L${x(t1).toFixed(1)} ${H - padB} L${x(t0).toFixed(1)} ${H - padB} Z`, class: 'srv-area ' + s.cls }));
    svg.appendChild(mk('path', { d, class: 'srv-line ' + s.cls, 'vector-effect': 'non-scaling-stroke' }));
  }
  if (series.length > 1 && !opts.compact) { // легенда — идентичность не только цветом
    const lg = el('div', 'srv-legend');
    for (const s of series) { const it = el('span', 'srv-legend-it'); it.append(el('span', 'srv-legend-sw ' + s.cls), el('span', null, s.label)); lg.appendChild(it); }
    wrap.appendChild(lg);
  }
  // наведение: вертикальная линия + подсказка с ближайшей точкой
  const cross = mk('line', { y1: padT, y2: H - padB, class: 'srv-cross', visibility: 'hidden' }); svg.appendChild(cross);
  const tip = el('div', 'srv-tip hidden'); wrap.appendChild(tip);
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect(); const fx = (e.clientX - r.left) / r.width * W;
    const tt = t0 + (fx - padL) / (W - padL - padR) * (t1 - t0);
    let best = points[0]; for (const p of points) if (Math.abs(p[0] - tt) < Math.abs(best[0] - tt)) best = p;
    const xx = x(best[0]); cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = '';
    tip.appendChild(el('div', 'srv-tip-t', fmtTime(best[0], t1 - t0 > 20 * 3600e3)));
    for (const s of series) { const row = el('div', 'srv-tip-row'); row.append(el('span', 'srv-legend-sw ' + s.cls), el('span', null, (series.length > 1 ? s.label + ': ' : '') + s.fmt(best[s.idx]))); tip.appendChild(row); }
    tip.classList.remove('hidden');
    const wr = wrap.getBoundingClientRect();
    const px = (r.left - wr.left) + (xx / W) * r.width; tip.style.left = Math.min(wr.width - 130, Math.max(0, px + 8)) + 'px';
  });
  svg.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); });
  return wrap;
}

export function initServers(host) {
  const { STORE, persist } = host;
  let open = false;
  let list = [];                  // публичные записи серверов (lib/servers.js pub)
  let loaded = false;
  let ui = (STORE.serversUi && typeof STORE.serversUi === 'object') ? { ...STORE.serversUi } : {};
  ui.view = ui.view || 'all';     // 'all' | 'issues' | 'server'
  ui.tab = ui.tab || 'overview';
  ui.collapsed = ui.collapsed || {};
  const saveUi = () => { try { persist('serversUi', ui); } catch (_) {} };
  const tabState = { range: '1h', hist: null, histFor: null, histAt: 0, ctrQ: '', svcQ: '', svcScope: 'all', svcHelpers: false,
    du: null, duPath: '/', duSudo: false, duBusy: false, engDf: null, logs: { src: 'journal', unit: '', ctr: '', lines: 300, prio: '', filter: '', text: '', busy: false, at: 0 } };
  let unsubs = [];

  const sel = () => list.find((s) => s.id === ui.selId) || null;
  const body = () => $('#servers-body');

  // ---------------------------------------------------------------- жизненный цикл
  function setOpen(o) {
    if (o === open) return;
    open = o;
    $('#servers-pane').classList.toggle('hidden', !o);
    if (o) {
      unsubs.push(lite.servers.onUpdate(({ server }) => onServer(server)));
      unsubs.push(lite.servers.onList(({ servers }) => { list = servers || []; render(); }));
      subscribe();
      reload();
      clock = setInterval(() => { if (open && !document.hidden) renderSide(); }, 15000);
    } else {
      for (const u of unsubs) { try { u(); } catch (_) {} } unsubs = [];
      clearInterval(clock);
      lite.servers.unsubscribe().catch(() => {});
    }
  }
  let clock = null;
  function subscribe() {
    const focus = ui.view === 'server' && ui.selId ? { id: ui.selId, tab: ui.tab } : null;
    lite.servers.subscribe(focus).catch(() => {});
  }
  async function reload() {
    let r; try { r = await lite.servers.list(); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось загрузить серверы', { kind: 'err' }); return; }
    list = r.servers || []; loaded = true;
    if (ui.view === 'server' && !sel()) ui.view = 'all';
    render();
  }
  function onServer(s) {
    if (!s) return;
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = s; else list.push(s);
    renderSide();
    if (ui.view === 'all') renderAll(true);
    else if (ui.view === 'issues') renderIssues(true);
    else if (ui.view === 'sites') { /* «Мониторинг сайтов» обновляется своим каналом */ }
    else if (ui.view === 'server' && ui.selId === s.id) renderServer(true);
  }

  // ---------------------------------------------------------------- каркас
  function render() {
    const b = body(); if (!b) return;
    if (!b.querySelector('.srv-layout')) {
      b.innerHTML = '';
      const lay = el('div', 'srv-layout');
      lay.append(el('div', 'srv-side'), el('div', 'srv-main'));
      b.appendChild(lay);
    }
    renderSide();
    if (!loaded) { main().innerHTML = '<div class="srv-empty">' + t('Загрузка…') + '</div>'; return; }
    if (!list.length && ui.view !== 'sites') { renderWelcome(); return; }
    if (ui.view === 'issues') renderIssues(); else if (ui.view === 'sites') renderSites(); else if (ui.view === 'server' && sel()) renderServer(); else { ui.view = 'all'; renderAll(); }
  }
  const main = () => body().querySelector('.srv-main');
  // перерисовать содержимое, сохранив прокрутку (обновления приходят каждые 10 с)
  function fill(node, build) {
    const st = node.scrollTop; node.innerHTML = ''; build(node); node.scrollTop = st;
  }
  function go(view, id, tab) {
    ui.view = view; if (id) ui.selId = id; if (tab) ui.tab = tab;
    saveUi(); subscribe(); render();
    const m = main(); if (m) m.scrollTop = 0;
  }

  function renderSide() {
    const side = body() && body().querySelector('.srv-side'); if (!side) return;
    side.innerHTML = '';
    const nav = (key, ic, label, badge, onClick, active) => {
      const r = el('div', 'srv-nav' + (active ? ' active' : ''));
      r.append(icon(ic, 15), el('span', 'srv-nav-l', label));
      if (badge) r.appendChild(el('span', 'srv-badge ' + badge[1], String(badge[0])));
      r.onclick = onClick; side.appendChild(r);
    };
    const all = list.flatMap(activeIssues);
    const crit = all.filter((i) => i.sev === 'crit').length, warn = all.filter((i) => i.sev === 'warn').length;
    nav('all', 'grid', 'Все серверы', list.length ? [list.length, 'n'] : null, () => go('all'), ui.view === 'all');
    nav('issues', 'warning', 'Проблемы', crit + warn ? [crit + warn, crit ? 'crit' : 'warn'] : null, () => go('issues'), ui.view === 'issues');
    const siteBad = list.flatMap((x) => x.sites || []).filter((t) => t.state === 'triggered' || t.state === 'error').length;
    nav('sites', 'globe', 'Сайты', siteBad ? [siteBad, 'crit'] : null, () => go('sites'), ui.view === 'sites');
    const groups = new Map();
    for (const s of list) { const g = s.group || t('Без группы'); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
    for (const [g, arr] of groups) {
      const head = el('div', 'srv-group');
      const coll = !!ui.collapsed[g];
      head.append(icon(coll ? 'chevron-right' : 'chevron-down', 13), el('span', null, g), el('span', 'srv-group-n', String(arr.length)));
      head.onclick = () => { ui.collapsed[g] = !coll; saveUi(); renderSide(); };
      side.appendChild(head);
      if (coll) continue;
      for (const s of arr) {
        const row = el('div', 'srv-srow' + (ui.view === 'server' && ui.selId === s.id ? ' active' : ''));
        const [k] = STATE[s.state] || STATE.unknown;
        const top = el('div', 'srv-srow-top'); top.append(dot(k), el('span', 'srv-srow-name', s.name));
        const iss = activeIssues(s).filter((i) => i.sev !== 'info');
        if (iss.length) top.appendChild(el('span', 'srv-badge ' + (iss.some((i) => i.sev === 'crit') ? 'crit' : 'warn'), String(iss.length)));
        row.appendChild(top);
        const L = s.live; const dk = maxDisk(s);
        const sub = s.state === 'online' && L
          ? `CPU ${fmtPct(L.cpu)} · RAM ${fmtPct(L.memPct)}${dk ? ' · ' + t('диск') + ' ' + dk.pct + '%' : ''}`
          : t((STATE[s.state] || STATE.unknown)[1]);
        row.appendChild(el('div', 'srv-srow-sub', sub));
        row.onclick = () => go('server', s.id);
        side.appendChild(row);
      }
    }
    const add = el('div', 'srv-nav srv-nav-add'); add.append(icon('plus', 15), el('span', 'srv-nav-l', 'Добавить сервер')); add.onclick = () => addServer();
    side.appendChild(add);
  }

  function renderWelcome() {
    fill(main(), (m) => {
      const w = el('div', 'srv-welcome');
      w.append(icon('server', 36), el('h3', null, 'Серверы — все в одном месте'),
        el('p', null, 'Ресурсы, проблемы, контейнеры, сервисы и журнал ваших серверов. Подключение — по SSH-профилю из «Удалённых хостов»; на сервер ничего не устанавливается.'));
      const b = el('button', 'btn primary', 'Добавить сервер'); b.onclick = () => addServer();
      w.appendChild(b); m.appendChild(w);
    });
  }

  // ---------------------------------------------------------------- «Все серверы»
  function renderAll() {
    fill(main(), (m) => {
      const head = el('div', 'srv-head'); head.append(el('h2', null, 'Все серверы'));
      const sum = el('span', 'srv-head-sub');
      const on = list.filter((s) => s.state === 'online').length;
      sum.textContent = t('на связи {0} из {1}', on, list.length); head.appendChild(sum);
      m.appendChild(head);
      const grid = el('div', 'srv-grid');
      for (const s of list) grid.appendChild(card(s));
      m.appendChild(grid);
    });
  }
  function metricRow(label, valueText, pct, warnAt, critAt) {
    const r = el('div', 'srv-mrow');
    r.append(el('span', 'srv-mrow-l', label), bar(pct, warnAt, critAt), el('span', 'srv-mrow-v', valueText));
    return r;
  }
  function card(s) {
    const c = el('div', 'srv-card');
    const top = el('div', 'srv-card-top');
    top.append(el('span', 'srv-card-name', s.name), stateChip(s.state));
    c.appendChild(top);
    const sub = el('div', 'srv-card-sub');
    sub.textContent = [s.group, hostLine(s), s.os && s.os.name].filter(Boolean).join(' · ');
    c.appendChild(sub);
    if (s.state !== 'online' || !s.live) {
      c.appendChild(el('div', 'srv-card-err', s.error ? s.error : t((STATE[s.state] || STATE.unknown)[1])));
    } else {
      const L = s.live, th = s.thresholds || {}; const dk = maxDisk(s); const nproc = (s.os && s.os.nproc) || 1;
      c.appendChild(metricRow('CPU', fmtPct(L.cpu), L.cpu, 80, 95));
      c.appendChild(metricRow('RAM', `${fmtBytes(L.mem.used)} / ${fmtBytes(L.mem.total)}`, L.memPct, th.mem, 97));
      if (dk) c.appendChild(metricRow(t('Диск'), `${dk.pct}% · ${dk.mount}`, dk.pct, th.disk, 97));
      c.appendChild(metricRow('Load', `${L.load ? L.load.l1.toFixed(2) : '—'} / ${nproc}`, L.load ? 100 * L.load.l1 / (nproc * (th.load || 2)) : 0, 80, 100));
      if (s.spark && s.spark.length > 1) c.appendChild(lineChart(s.spark, [{ idx: 1, label: 'CPU', cls: 's1', fmt: fmtPct }], { h: 34, max: 100, compact: true }));
    }
    const chips = el('div', 'srv-chips');
    const cs = ctrCounts(s);
    if (cs.total) chips.appendChild(chip('box', t('контейнеры {0}/{1}', cs.running, cs.total), cs.bad ? 'warn' : ''));
    const iss = activeIssues(s).filter((i) => i.sev !== 'info');
    if (iss.length) chips.appendChild(chip('warning', t('проблем: {0}', iss.length), iss.some((i) => i.sev === 'crit') ? 'crit' : 'warn'));
    if (s.pkg && s.pkg.count) chips.appendChild(chip('download', t('обновлений: {0}', s.pkg.count), s.pkg.security ? 'warn' : ''));
    if (s.reboot && s.reboot.required) chips.appendChild(chip('power', 'нужна перезагрузка', 'warn'));
    if (s.sites && s.sites.length) { const bad = s.sites.filter((x) => x.state === 'triggered' || x.state === 'error').length; chips.appendChild(chip('globe', t('сайты {0}/{1}', s.sites.length - bad, s.sites.length), bad ? 'crit' : '')); }
    if (s.live && s.live.uptime) chips.appendChild(chip('clock', fmtDur(s.live.uptime), ''));
    c.appendChild(chips);
    c.onclick = () => go('server', s.id);
    return c;
  }
  function chip(ic, text, kind) { const c = el('span', 'srv-chip' + (kind ? ' ' + kind : '')); c.append(icon(ic, 12), el('span', null, text)); return c; }
  function ctrCounts(s) {
    const arr = s.containers || s.ctrState || [];
    return { total: arr.length, running: arr.filter((c) => c.state === 'running').length, bad: arr.filter((c) => c.health === 'unhealthy' || ((c.state === 'exited' || c.state === 'dead') && c.exitCode != null && ![0, 137, 143].includes(c.exitCode))).length };
  }

  // ---------------------------------------------------------------- «Проблемы»
  function renderIssues() {
    fill(main(), (m) => {
      const head = el('div', 'srv-head'); head.append(el('h2', null, 'Проблемы')); m.appendChild(head);
      const rows = [];
      for (const s of list) for (const i of s.issues || []) rows.push([s, i]);
      const rank = { crit: 0, warn: 1, info: 2 };
      rows.sort((a, b) => (a[1].muted ? 1 : 0) - (b[1].muted ? 1 : 0) || rank[a[1].sev] - rank[b[1].sev] || a[1].since - b[1].since);
      if (!rows.length) { m.appendChild(el('div', 'srv-empty', 'Проблем нет — все серверы в порядке.')); return; }
      const box = el('div', 'srv-issues');
      for (const [s, i] of rows) box.appendChild(issueRow(s, i, true));
      m.appendChild(box);
    });
  }
  function issueRow(s, i, withServer) {
    const [k, label, ic] = SEV[i.sev] || SEV.info;
    const r = el('div', 'srv-issue srv-sev-' + k + (i.muted ? ' muted' : ''));
    const badge = el('span', 'srv-sev'); badge.append(icon(ic, 13), el('span', null, label));
    r.appendChild(badge);
    const txt = el('div', 'srv-issue-main');
    txt.appendChild(el('div', 'srv-issue-t', issueText(i)));
    const meta = [withServer ? s.name : null, t('с {0}', fmtTime(i.since, Date.now() - i.since > 20 * 3600e3)), i.muted ? t('заглушено до {0}', fmtTime(i.muted, true)) : null].filter(Boolean).join(' · ');
    txt.appendChild(el('div', 'srv-issue-m', meta));
    r.appendChild(txt);
    const acts = el('div', 'srv-issue-acts');
    if (withServer) { const g = el('button', 'btn srv-btn-sm', 'Открыть'); g.onclick = () => go('server', s.id, tabForIssue(i)); acts.appendChild(g); }
    const mute = el('button', 'btn srv-btn-sm', i.muted ? 'Включить' : 'Заглушить');
    mute.onclick = (e) => { e.stopPropagation(); if (i.muted) doMute(s, i, 0); else muteMenu(mute, s, i); };
    acts.appendChild(mute);
    r.appendChild(acts);
    return r;
  }
  function tabForIssue(i) {
    if (/^(cert|site):/.test(i.key)) return 'projects';
    if (/^exposed:/.test(i.key)) return 'network';
    if (/^(ctr|hc:)/.test(i.key)) return 'containers';
    if (/^unit:/.test(i.key)) return 'services';
    if (/^(disk|inode):/.test(i.key)) return 'disks';
    return 'overview';
  }
  function muteMenu(anchor, s, i) {
    const old = document.querySelector('.srv-pop'); if (old) old.remove();
    const pop = el('div', 'srv-pop');
    for (const [h, l] of [[1, 'на 1 час'], [24, 'на сутки'], [24 * 7, 'на неделю'], [24 * 365, 'насовсем']]) {
      const it = el('div', 'srv-pop-it', l); it.onclick = () => { pop.remove(); doMute(s, i, h); }; pop.appendChild(it);
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 4) + 'px'; pop.style.left = Math.max(8, r.right - 160) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function h(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', h); } }), 0);
  }
  async function doMute(s, i, hours) {
    const r = await lite.servers.mute(s.id, i.key, hours).catch((e) => ({ ok: false, error: String(e) }));
    if (!r || !r.ok) toast((r && r.error) || 'Не удалось', { kind: 'err' });
  }

  // ---------------------------------------------------------------- страница сервера
  const TABS = [['overview', 'Обзор'], ['projects', 'Проекты'], ['containers', 'Контейнеры'], ['network', 'Сеть'], ['services', 'Сервисы'], ['disks', 'Диски'], ['logs', 'Логи']];
  function renderServer(fromUpdate) {
    const s = sel(); if (!s) { go('all'); return; }
    const m = main();
    let headBox = m.querySelector('.srv-shead'), tabsBox = m.querySelector('.srv-tabs'), content = m.querySelector('.srv-content');
    if (!fromUpdate || !headBox || m.dataset.sid !== s.id) {
      m.innerHTML = ''; m.dataset.sid = s.id;
      headBox = el('div', 'srv-shead'); tabsBox = el('div', 'srv-tabs'); content = el('div', 'srv-content');
      m.append(headBox, tabsBox, content);
      fromUpdate = false;
    }
    headBox.innerHTML = ''; headBox.appendChild(serverHead(s));
    tabsBox.innerHTML = '';
    for (const [id, label] of TABS) {
      const b = el('button', 'srv-tab' + (ui.tab === id ? ' active' : ''), label);
      let n = null;
      if (id === 'containers') { const c = ctrCounts(s); if (c.total) n = c.bad ? [c.bad, 'warn'] : [c.total, 'n']; }
      if (id === 'services') { const f = (s.failed || []).filter((u) => !u.helper).length; if (f) n = [f, 'warn']; }
      if (id === 'disks') { const d = maxDisk(s); if (d && d.pct >= ((s.thresholds || {}).disk || 90)) n = [d.pct + '%', 'warn']; }
      if (id === 'projects' && s.projects) { const bad = s.projects.filter((p) => !p.hidden && (p.status === 'bad' || p.status === 'warn')).length; n = bad ? [bad, 'warn'] : [s.projects.filter((p) => !p.hidden).length, 'n']; }
      if (n) b.appendChild(el('span', 'srv-badge ' + n[1], String(n[0])));
      b.onclick = () => { if (ui.tab === id) return; ui.tab = id; saveUi(); subscribe(); renderServer(); content.scrollTop = 0; };
      tabsBox.appendChild(b);
    }
    // вкладки с вводом (логи, du, поиск) не перерисовываем целиком на каждом обновлении
    if (fromUpdate && ui.tab === 'logs') return;
    if (ui.tab === 'projects') { tabProjects(content, s, fromUpdate); return; }
    if (ui.tab === 'network') { tabNetwork(content, s, fromUpdate); return; }
    if (ui.tab === 'overview') fill(content, (c) => tabOverview(c, s));
    else if (ui.tab === 'containers') tabContainers(content, s, fromUpdate);
    else if (ui.tab === 'services') tabServices(content, s, fromUpdate);
    else if (ui.tab === 'disks') tabDisks(content, s, fromUpdate);
    else if (ui.tab === 'logs') tabLogs(content, s);
  }
  function serverHead(s) {
    const h = el('div', 'srv-shead-in');
    const left = el('div', 'srv-shead-l');
    const title = el('div', 'srv-shead-t'); title.append(el('span', 'srv-shead-name', s.name), stateChip(s.state));
    left.appendChild(title);
    const meta = [hostLine(s), s.os && s.os.name, s.os && s.os.hostname, s.lastOk ? t('обновлено {0}', fmtAgo(s.lastOk)) : null].filter(Boolean).join(' · ');
    left.appendChild(el('div', 'srv-shead-m', meta));
    if (s.state !== 'online' && s.error) left.appendChild(el('div', 'srv-shead-err', s.error));
    h.appendChild(left);
    const acts = el('div', 'srv-shead-acts');
    const btn = (ic, label, fn, title) => { const b = el('button', 'btn srv-act'); b.append(icon(ic, 14), el('span', null, label)); if (title) b.title = title; b.onclick = fn; acts.appendChild(b); return b; };
    btn('terminal', 'Терминал', () => lite.module.open('rh', { connId: s.rhId, view: 'session' }), 'SSH-терминал в «Удалённых хостах»');
    btn('folder', 'Файлы', () => lite.module.open('rh', { connId: s.rhId, view: 'files' }), 'Файлы сервера в «Удалённых хостах»');
    btn('box', 'Контейнеры', () => lite.module.open('docker', { rhId: s.rhId }), 'Полный менеджер контейнеров этого сервера');
    const rb = btn('refresh', 'Обновить', async () => { rb.disabled = true; await lite.servers.refresh(s.id).catch(() => {}); setTimeout(() => { rb.disabled = false; }, 1500); }, 'Опросить сервер полностью сейчас');
    const st = iconBtn('icon-btn srv-act-ic', 'gear', 'Настройки сервера', 15); st.onclick = () => serverModal(s); acts.appendChild(st);
    h.appendChild(acts);
    return h;
  }

  // ---------------------------------------------------------------- вкладка «Обзор»
  function tile(label, value, sub, spark) {
    const t1 = el('div', 'srv-tile');
    t1.append(el('div', 'srv-tile-l', label), el('div', 'srv-tile-v', value));
    if (sub) t1.appendChild(el('div', 'srv-tile-s', sub));
    if (spark) t1.appendChild(spark);
    return t1;
  }
  function section(c, title, extra) {
    const h = el('div', 'srv-sec'); h.appendChild(el('span', 'srv-sec-t', title));
    if (extra) h.appendChild(extra);
    c.appendChild(h);
    const box = el('div', 'srv-sec-box'); c.appendChild(box); return box;
  }
  function tabOverview(c, s) {
    const iss = s.issues || [];
    if (iss.length) {
      const box = section(c, 'Проблемы');
      const rank = { crit: 0, warn: 1, info: 2 };
      for (const i of iss.slice().sort((a, b) => (a.muted ? 1 : 0) - (b.muted ? 1 : 0) || rank[a.sev] - rank[b.sev])) box.appendChild(issueRow(s, i, false));
    }
    const L = s.live;
    if (s.state === 'online' && L) {
      const nproc = (s.os && s.os.nproc) || 1;
      const tiles = el('div', 'srv-tiles');
      const sp = (idx, fmt, max) => (s.spark && s.spark.length > 1 ? lineChart(s.spark, [{ idx, label: '', cls: 's1', fmt }], { h: 30, max, compact: true }) : null);
      tiles.append(
        tile('CPU', fmtPct(L.cpu), t('ядер: {0}', nproc), sp(1, fmtPct, 100)),
        tile('Память', fmtPct(L.memPct), `${fmtBytes(L.mem.used)} / ${fmtBytes(L.mem.total)}${L.mem.swapTotal ? ' · swap ' + fmtBytes(L.mem.swapUsed) : ''}`, sp(2, fmtPct, 100)),
        tile('Load', L.load ? L.load.l1.toFixed(2) : '—', L.load ? `${L.load.l5.toFixed(2)} · ${L.load.l15.toFixed(2)}` : '', sp(3, (v) => (+v).toFixed(2))),
        tile('Сеть', `↓ ${fmtRate(L.rx)}`, `↑ ${fmtRate(L.tx)}`, sp(4, fmtRate)),
        tile('Аптайм', fmtDur(L.uptime), s.os ? s.os.kernel : ''),
      );
      c.appendChild(tiles);
      // история: 1 ч сырыми замерами / 24 ч поминутно
      const rng = el('div', 'srv-seg');
      for (const [k, l] of [['1h', '1 ч'], ['24h', '24 ч']]) {
        const b = el('button', 'srv-seg-b' + (tabState.range === k ? ' active' : ''), l);
        b.onclick = () => { tabState.range = k; tabState.hist = null; renderServer(); };
        rng.appendChild(b);
      }
      const hbox = section(c, 'История', rng);
      histInto(hbox, s);
    }
    if (s.sites && s.sites.length) {
      const sb = section(c, 'Сайты');
      for (const t1 of s.sites) sb.appendChild(siteRow(t1));
    }
    // информация
    const info = section(c, 'Сервер');
    const kv = el('div', 'srv-kv');
    const add = (k, v) => { if (v == null || v === '') return; kv.append(el('div', 'srv-kv-k', k), el('div', 'srv-kv-v', String(v))); };
    const o = s.os || {};
    add('ОС', o.name); add('Ядро', o.kernel); add('Имя хоста', o.hostname); add('Архитектура', o.arch);
    add('Виртуализация', o.virt || null); add('Ядер CPU', o.nproc);
    add('Пользователь', o.user ? `${o.user}${o.sudo === 'free' ? ' · ' + t('sudo без пароля') : o.sudo === 'pass' ? ' · ' + t('sudo с паролем') : ''}` : null);
    const ips = (s.ips || []).filter((i) => !i.virt);
    if (ips.length) add('Адреса', ips.map((i) => `${i.addr} (${i.ifc})`).join(', '));
    add('Контейнеры', s.engines && s.engines.length ? s.engines.map((e) => e.replace('sudo', 'sudo ')).join(', ') : t('не найдены'));
    add('SSH', hostLine(s));
    if (s.notes) add('Заметки', s.notes);
    info.appendChild(kv);
    // состояние системы
    const sys = section(c, 'Система');
    const lines = el('div', 'srv-status');
    const st = (kind, ic, text, btn) => { const r = el('div', 'srv-status-row ' + kind); r.append(icon(ic, 14), el('span', null, text)); if (btn) r.appendChild(btn); lines.appendChild(r); };
    if (s.reboot) st(s.reboot.required ? 'warn' : 'ok', s.reboot.required ? 'power' : 'check', s.reboot.required ? t('Нужна перезагрузка — обновлены: {0}', s.reboot.pkgs.slice(0, 6).join(', ') || '—') : t('Перезагрузка не требуется'));
    if (s.pkg) {
      if (s.pkg.count) {
        const b = el('button', 'btn srv-btn-sm', 'Обновить в терминале');
        b.title = t('Откроет SSH-терминал; команду обновления запустите сами');
        b.onclick = () => { lite.module.open('rh', { connId: s.rhId, view: 'session' }); copyCmd(s.pkg.manager === 'dnf' ? 'sudo dnf upgrade' : s.pkg.manager === 'apk' ? 'sudo apk upgrade' : 'sudo apt update && sudo apt upgrade'); };
        st(s.pkg.security ? 'warn' : 'info', 'download', s.pkg.security ? t('Доступно обновлений: {0}, из них безопасности: {1}', s.pkg.count, s.pkg.security) : t('Доступно обновлений: {0}', s.pkg.count), b);
      } else st('ok', 'check', t('Пакеты обновлены ({0})', s.pkg.manager || '—'));
    }
    const failed = (s.failed || []).filter((u) => !u.helper);
    if (failed.length) { const b = el('button', 'btn srv-btn-sm', 'К сервисам'); b.onclick = () => go('server', s.id, 'services'); st('warn', 'warning', t('Упавшие сервисы: {0}', failed.map((u) => u.unit).join(', ')), b); }
    else if (s.failed) st('ok', 'check', t('Упавших сервисов нет'));
    sys.appendChild(lines);
    agentSection(c, s);
    // диски кратко
    if (s.disks && s.disks.length) {
      const dbox = section(c, 'Диски');
      for (const d of s.disks) dbox.appendChild(metricRow(d.mount, `${fmtBytes(d.used)} / ${fmtBytes(d.size)} · ${d.pct}%`, d.pct, (s.thresholds || {}).disk || 90, 97));
    }
  }
  async function histInto(box, s) {
    const key = s.id + tabState.range;
    const draw = () => {
      if (!box.isConnected) return;
      box.innerHTML = '';
      const pts = tabState.hist || [];
      const g = el('div', 'srv-charts');
      const ch = (title, series, opts) => { const w = el('div', 'srv-chart-card'); w.appendChild(el('div', 'srv-chart-title', title)); w.appendChild(lineChart(pts, series, opts)); g.appendChild(w); };
      ch('CPU', [{ idx: 1, label: 'CPU', cls: 's1', fmt: fmtPct }], { max: 100 });
      ch('Память', [{ idx: 2, label: 'RAM', cls: 's1', fmt: fmtPct }], { max: 100 });
      ch('Load', [{ idx: 3, label: 'load1', cls: 's1', fmt: (v) => (+v || 0).toFixed(2) }], {});
      ch('Сеть', [{ idx: 4, label: t('входящий'), cls: 's1', fmt: fmtRate }, { idx: 5, label: t('исходящий'), cls: 's2', fmt: fmtRate }], {});
      box.appendChild(g);
    };
    const have = tabState.hist && tabState.histFor === key;
    if (have) draw(); else box.appendChild(el('div', 'srv-empty', 'Загрузка…'));
    if (have && Date.now() - tabState.histAt < 15000) return;   // свежее — не дёргаем main
    let r; try { r = await lite.servers.history(s.id); } catch (_) { r = null; }
    if (!r || !r.ok) { if (!have && box.isConnected) { box.innerHTML = ''; box.appendChild(el('div', 'srv-empty', 'История недоступна')); } return; }
    if (tabState.range + s.id !== key.slice(s.id.length) + s.id) return; // переключили диапазон, пока грузили
    tabState.hist = tabState.range === '1h' ? r.fast : r.minute.concat(r.fast.length ? [r.fast[r.fast.length - 1]] : []);
    tabState.histFor = key; tabState.histAt = Date.now();
    draw();
  }
  // ---- агент на сервере (не ИИ): скрипт-сборщик, копит метрики и события, пока редактор закрыт
  const AG_MODE = { systemd: 'таймер systemd (переживает перезагрузку)', cron: 'cron (переживает перезагрузку)', loop: 'фоновый цикл — не переживёт перезагрузку сервера' };
  function agentSection(c, s) {
    if (!s.agent) return;
    const a = s.agent;
    const box = section(c, 'Агент на сервере');
    const st = el('div', 'srv-status');
    const row = (kind, ic, text, ...btns) => { const r = el('div', 'srv-status-row ' + kind); r.append(icon(ic, 14), el('span', null, text)); for (const b of btns) if (b) r.appendChild(b); st.appendChild(r); };
    const btn = (label, fn, cls) => { const b = el('button', 'btn srv-btn-sm' + (cls ? ' ' + cls : ''), label); b.onclick = () => fn(b); return b; };
    const install = (b) => {
      cmdConfirm(t('Установить агента на «{0}»?', s.name),
        t('Маленький скрипт (sh + awk) раз в минуту записывает метрики и события в ~/.local/share/lite-agent, пока редактор закрыт. Портов не открывает, root не нужен, ничего не отправляет наружу — редактор сам дочитывает накопленное по SSH. Запуск: таймер systemd пользователя, если нет — cron, если нет — фоновый цикл.'),
        '~/.local/share/lite-agent/agent.sh  +  ~/.config/systemd/user/lite-agent.timer', null, t('Установить'), async () => {
          b.disabled = true;
          const r = await lite.servers.agentInstall(s.id).catch((e) => ({ ok: false, error: String(e) }));
          b.disabled = false;
          if (!r || !r.ok) toast(t('Агент: {0}', (r && r.error) || 'ошибка'), { kind: 'err', ttl: 9000 });
          else toast(t('Агент установлен: {0}', t(AG_MODE[r.mode] || r.mode)), { ttl: 6000 });
        });
    };
    const remove = () => showConfirm(t('Удалить агента с «{0}»?', s.name), t('Таймер/cron остановится, каталог ~/.local/share/lite-agent удалится вместе с накопленной историей. История, уже перенесённая в редактор, останется.'), t('Удалить'), async () => {
      const r = await lite.servers.agentUninstall(s.id).catch((e) => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) toast(t('Агент: {0}', (r && r.error) || 'ошибка'), { kind: 'err', ttl: 9000 }); else toast('Агент удалён', { ttl: 3000 });
    });
    if (!a.installed) {
      row('info', 'info', t('Не установлен — пока редактор закрыт, история и события не копятся.'), btn('Установить', install, 'primary'));
    } else {
      const fresh = a.last ? t('последняя запись {0}', fmtAgo(a.last)) : t('записей пока нет');
      row(a.stale ? 'warn' : 'ok', a.stale ? 'warning' : 'check', t('Работает: {0} · {1}', t(AG_MODE[a.mode] || a.mode || '?'), fresh) + (a.first ? ' · ' + t('история с {0}', new Date(a.first).toLocaleString()) : ''),
        !a.current ? btn('Обновить агента', install) : null, btn('Удалить', remove, 'danger'));
      if (a.stale) row('warn', 'warning', a.mode === 'loop' ? t('Запись остановилась — фоновый цикл, скорее всего, не пережил перезагрузку. Переустановите агента.') : t('Запись остановилась больше 5 минут назад — проверьте таймер: systemctl --user status lite-agent.timer'));
      if (a.mode === 'loop' && !a.stale) row('warn', 'warning', t('Ни systemd пользователя (linger), ни cron не нашлись — агент работает фоновым циклом и после перезагрузки сервера не запустится сам.'));
    }
    box.appendChild(st);
    const ev = (s.agentEvents || []).slice().reverse();
    if (ev.length) {
      const eb = section(c, 'События с сервера');
      for (const e of ev.slice(0, 15)) {
        const k = e.sev === 'ok' ? 'ok' : e.sev === 'crit' ? 'crit' : e.sev === 'info' ? 'info' : 'warn';
        const r = el('div', 'srv-ev');
        r.append(dot(k), el('span', 'srv-ev-t', fmtTime(e.t, true)), el('span', 'srv-ev-x', e.text));
        eb.appendChild(r);
      }
    }
  }
  function copyCmd(cmd) { try { lite.copyText(cmd); toast(t('Команда скопирована: {0}', cmd), { ttl: 6000 }); } catch (_) {} }

  // ---------------------------------------------------------------- вкладка «Контейнеры»
  function tabContainers(c, s, fromUpdate) {
    let tools = c.querySelector('.srv-tools'), listBox = c.querySelector('.srv-ctr-list');
    if (!fromUpdate || !tools || !listBox) {
      c.innerHTML = '';
      tools = el('div', 'srv-tools');
      const q = el('input', 'srv-search'); q.placeholder = t('Поиск: имя, образ, проект, порт…'); q.value = tabState.ctrQ;
      q.oninput = () => { tabState.ctrQ = q.value; ctrList(listBox, sel()); };
      const win = el('button', 'btn srv-btn-sm'); win.append(icon('box', 13), el('span', null, 'Открыть в окне «Контейнеры»'));
      win.onclick = () => lite.module.open('docker', { rhId: s.rhId });
      const rf = iconBtn('icon-btn', 'refresh', 'Обновить список', 14); rf.onclick = () => lite.servers.refresh(s.id, 'ctr');
      const dfb = el('button', 'btn srv-btn-sm', 'Место движка'); dfb.title = t('podman/docker system df'); dfb.onclick = () => showEngineDf(sel());
      tools.append(q, el('span', 'srv-grow'), dfb, win, rf);
      listBox = el('div', 'srv-ctr-list');
      c.append(tools, listBox);
    }
    const st = c.scrollTop; ctrList(listBox, s); c.scrollTop = st;
  }
  function ctrList(box, s) {
    box.innerHTML = '';
    if (!s.engines || !s.engines.length) { box.appendChild(el('div', 'srv-empty', s.state === 'online' ? 'На сервере не найден docker или podman.' : 'Нет данных — сервер не на связи.')); return; }
    if (!s.containers) { box.appendChild(el('div', 'srv-empty', 'Список контейнеров загружается…')); return; }
    const q = tabState.ctrQ.trim().toLowerCase();
    const arr = s.containers.filter((c) => !q || [c.name, c.image, c.project, c.service, c.status, ...(c.ports || []).map((p) => String(p.hostPort))].join(' ').toLowerCase().includes(q));
    const cs = ctrCounts(s);
    box.appendChild(el('div', 'srv-ctr-sum', t('работают {0} из {1}', cs.running, cs.total) + (s.ctrAt ? ' · ' + t('обновлено {0}', fmtAgo(s.ctrAt)) : '')));
    const groups = new Map();
    for (const c of arr) { const g = c.project || c.pod || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const names = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const g of names) {
      const items = groups.get(g);
      const head = el('div', 'srv-cgroup');
      const run = items.filter((c) => c.state === 'running').length;
      head.append(icon('layers', 13), el('span', 'srv-cgroup-n', g || t('Без проекта')), el('span', 'srv-cgroup-c', `${run}/${items.length}`));
      if (items[0].workdir) head.appendChild(el('span', 'srv-cgroup-p', items[0].workdir));
      box.appendChild(head);
      for (const c of items.sort((a, b) => (a.service || a.name).localeCompare(b.service || b.name))) box.appendChild(ctrRow(s, c));
    }
    if (!arr.length) box.appendChild(el('div', 'srv-empty', 'Ничего не найдено'));
  }
  function ctrRow(s, c) {
    const r = el('div', 'srv-crow');
    const [k, label] = CTR_STATE[c.state] || ['off', c.state || '?'];
    const kind = c.health === 'unhealthy' ? 'crit' : (c.state === 'exited' && c.exitCode != null && ![0, 137, 143].includes(c.exitCode) ? 'crit' : k);
    const st = el('span', 'srv-cstate srv-state-' + kind); st.append(dot(kind), el('span', null, c.health === 'unhealthy' ? t('нездоров') : label));
    const nm = el('div', 'srv-crow-main');
    const top = el('div', 'srv-crow-top'); top.append(el('span', 'srv-crow-name', c.service || c.name));
    if (c.service && c.name !== c.service) top.appendChild(el('span', 'srv-crow-sub', c.name));
    if (VPN_RE.test(c.name + ' ' + c.image)) top.appendChild(el('span', 'srv-chip warn', 'VPN'));
    nm.appendChild(top);
    const meta = [c.image.replace(/^docker\.io\/(library\/)?/, ''), c.status, c.restarts ? t('рестартов: {0}', c.restarts) : null].filter(Boolean).join(' · ');
    nm.appendChild(el('div', 'srv-crow-meta', meta));
    if (c.ports && c.ports.length) {
      const pr = el('div', 'srv-ports');
      for (const p of c.ports) {
        const pub = !p.hostIp || p.hostIp === '0.0.0.0' || p.hostIp === '::';
        const txt = `${p.hostIp ? p.hostIp + ':' : ''}${p.hostPort}${p.range > 1 ? '-' + (p.hostPort + p.range - 1) : ''}→${p.port}/${p.proto}`;
        const ch = el('span', 'srv-port' + (pub ? ' pub' : ''), txt);
        ch.title = pub ? t('Открыт на всех адресах сервера') : t('Только на адресе {0}', p.hostIp);
        pr.appendChild(ch);
      }
      nm.appendChild(pr);
    }
    const res = el('div', 'srv-crow-res');
    if (c.state === 'running' && c.cpu != null) { res.append(el('span', null, fmtPct(c.cpu)), el('span', null, fmtBytes(c.mem))); }
    const acts = el('div', 'srv-crow-acts');
    const a = (ic, title, fn, cls) => { const b = iconBtn('icon-btn' + (cls ? ' ' + cls : ''), ic, title, 14); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
    a('list', 'Логи', () => showCtrLogs(s, c));
    if (c.state === 'running') { a('refresh', 'Перезапустить', () => ctrDo(s, c, 'restart')); a('stop', 'Остановить', () => ctrDo(s, c, 'stop'), 'danger'); }
    else a('play', 'Запустить', () => ctrDo(s, c, 'start'));
    r.append(st, nm, res, acts);
    return r;
  }
  function ctrDo(s, c, action) {
    const nm = c.service || c.name;
    const verb = { start: 'Запустить', stop: 'Остановить', restart: 'Перезапустить' }[action];
    const run = async () => {
      toast(t('{0}: {1}…', t(verb), nm), { ttl: 3000 });
      const r = await lite.servers.ctrAction(s.id, c.engine, c.id, action).catch((e) => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) toast(t('Контейнер {0}: {1}', nm, (r && r.error) || 'ошибка'), { kind: 'err', ttl: 9000 });
      else toast(t('Готово: {0}', nm), { ttl: 3000 });
    };
    if (action === 'start') { run(); return; }
    if (VPN_RE.test(c.name + ' ' + c.image) || c.name === 'traefik' || /proxy|nginx|caddy|traefik|haproxy/i.test(c.image)) {
      typedConfirm(t('{0} «{1}» на «{2}»?', t(verb), nm, s.name),
        t('Контейнер похож на VPN или входной прокси: связь с сервисами (а для VPN — и с самим сервером через туннель) может пропасть. Чтобы подтвердить, введите имя сервера.'),
        s.name, t(verb), run);
      return;
    }
    showConfirm(t('{0} «{1}»?', t(verb), nm), t('Сервер «{0}». Сервис будет недоступен, пока контейнер не поднимется.', s.name), t(verb), run);
  }
  function typedConfirm(title, text, expect, okLabel, onOk) {
    const { m, close } = makeModal('<h2></h2><div class="about-desc"></div><input class="srv-typed" type="text" autocomplete="off" spellcheck="false"><div class="modal-actions"><button class="btn" data-x>Отмена</button><button class="btn danger" data-ok disabled></button></div>');
    m.querySelector('h2').textContent = title;
    m.querySelector('.about-desc').textContent = text;
    const inp = m.querySelector('.srv-typed'); inp.placeholder = expect;
    const ok = m.querySelector('[data-ok]'); ok.textContent = okLabel;
    inp.oninput = () => { ok.disabled = inp.value.trim() !== expect; };
    m.querySelector('[data-x]').onclick = close;
    ok.onclick = () => { if (inp.value.trim() !== expect) return; close(); onOk(); };
    setTimeout(() => inp.focus(), 30);
  }
  // Подтверждение с точной командой, которая уйдёт на сервер; expect — ввести имя сервера (опасные действия)
  function cmdConfirm(title, text, cmd, expect, okLabel, onOk) {
    const { m, close } = makeModal('<h2></h2><div class="about-desc"></div><pre class="srv-pre srv-pre-sm srv-cmd"></pre><div class="srv-typed-wrap"></div><div class="modal-actions"><button class="btn" data-x>Отмена</button><button class="btn" data-ok></button></div>');
    m.classList.add('srv-modal-wide');
    m.querySelector('h2').textContent = title;
    m.querySelector('.about-desc').textContent = text;
    m.querySelector('.srv-cmd').textContent = cmd;
    const ok = m.querySelector('[data-ok]'); ok.textContent = okLabel; ok.classList.add(expect ? 'danger' : 'primary');
    let inp = null;
    if (expect) {
      const w = m.querySelector('.srv-typed-wrap');
      w.appendChild(el('div', 'rh-hint', t('Чтобы подтвердить, введите имя сервера: {0}', expect)));
      inp = el('input', 'srv-typed'); inp.placeholder = expect; w.appendChild(inp);
      ok.disabled = true; inp.oninput = () => { ok.disabled = inp.value.trim() !== expect; };
    }
    m.querySelector('[data-x]').onclick = close;
    ok.onclick = () => { if (inp && inp.value.trim() !== expect) return; close(); onOk(); };
    setTimeout(() => (inp || m.querySelector('[data-x]')).focus(), 30);
  }
  function textModal(title, loader, opts = {}) {
    const { m, close } = makeModal('<h2></h2><div class="srv-mtools"></div><pre class="srv-pre"></pre>');
    m.classList.add('srv-modal-wide');
    m.querySelector('h2').textContent = title;
    const pre = m.querySelector('.srv-pre'), tools = m.querySelector('.srv-mtools');
    let text = '';
    const filter = el('input', 'srv-search'); filter.placeholder = t('Фильтр строк…');
    const paint = () => { const f = filter.value.trim().toLowerCase(); pre.textContent = f ? text.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n') : text; };
    filter.oninput = paint;
    const load = async (arg) => {
      pre.textContent = t('Загрузка…');
      let r; try { r = await loader(arg); } catch (e) { r = { ok: false, error: String(e) }; }
      if (!r || !r.ok) { pre.textContent = ''; toast((r && r.error) || 'Ошибка', { kind: 'err' }); return; }
      text = r.text || ''; paint(); pre.scrollTop = pre.scrollHeight;
    };
    tools.appendChild(filter);
    if (opts.tails) {
      const seg = el('select', 'srv-select');
      for (const n of opts.tails) { const o = document.createElement('option'); o.value = n; o.textContent = t('{0} строк', n); seg.appendChild(o); }
      seg.value = String(opts.tails[1] || opts.tails[0]);
      seg.onchange = () => load(+seg.value);
      tools.appendChild(seg);
      load(+seg.value);
    } else load();
    const cp = iconBtn('icon-btn', 'copy', 'Скопировать', 14); cp.onclick = () => { try { lite.copyText(pre.textContent); toast('Скопировано', { ttl: 1500 }); } catch (_) {} };
    const rf = iconBtn('icon-btn', 'refresh', 'Обновить', 14); rf.onclick = () => { const sl = tools.querySelector('select'); load(sl ? +sl.value : undefined); };
    const x = iconBtn('icon-btn', 'x', 'Закрыть', 15); x.onclick = close;
    tools.append(cp, rf, x);
  }
  function showCtrLogs(s, c) { textModal(t('Логи: {0}', c.name), (n) => lite.servers.ctrLogs(s.id, c.engine, c.id, n), { tails: [100, 300, 1000, 3000] }); }
  function showEngineDf(s) {
    const engs = (s && s.engines) || [];
    if (!engs.length) { toast('Движок контейнеров не найден', { kind: 'err' }); return; }
    textModal(t('Место движка: {0}', engs.join(', ')), async () => {
      const outs = [];
      for (const e of engs) { const r = await lite.servers.engineDf(s.id, e); if (!r.ok) return r; outs.push((engs.length > 1 ? '# ' + e + '\n' : '') + r.text); }
      return { ok: true, text: outs.join('\n\n') };
    });
  }

  // ---------------------------------------------------------------- вкладка «Сервисы»
  async function tabServices(c, s, fromUpdate) {
    let tools = c.querySelector('.srv-tools'), listBox = c.querySelector('.srv-svc-list');
    if (!fromUpdate || !tools || !listBox) {
      c.innerHTML = '';
      tools = el('div', 'srv-tools');
      const q = el('input', 'srv-search'); q.placeholder = t('Поиск сервиса…'); q.value = tabState.svcQ;
      q.oninput = () => { tabState.svcQ = q.value; svcList(listBox, sel()); };
      const scope = el('select', 'srv-select');
      for (const [v, l] of [['all', 'Все'], ['system', 'Системные'], ['user', 'Пользовательские']]) { const o = document.createElement('option'); o.value = v; o.textContent = t(l); scope.appendChild(o); }
      scope.value = tabState.svcScope; scope.onchange = () => { tabState.svcScope = scope.value; svcList(listBox, sel()); };
      const helpers = el('label', 'srv-check'); const hc = el('input'); hc.type = 'checkbox'; hc.checked = tabState.svcHelpers;
      hc.onchange = () => { tabState.svcHelpers = hc.checked; svcList(listBox, sel()); };
      helpers.append(hc, el('span', null, 'служебные podman'));
      const rf = iconBtn('icon-btn', 'refresh', 'Обновить', 14); rf.onclick = () => lite.servers.refresh(s.id, 'units');
      tools.append(q, scope, helpers, el('span', 'srv-grow'), rf);
      listBox = el('div', 'srv-svc-list');
      c.append(tools, listBox);
    }
    await loadUnits(s);
    const st = c.scrollTop; svcList(listBox, sel() || s); c.scrollTop = st;
  }
  let unitsCache = { id: null, at: 0, units: null, timers: null };
  async function loadUnits(s) {
    if (unitsCache.id === s.id && unitsCache.at && unitsCache.at >= (s.unitsAt || 0)) return;
    let r; try { r = await lite.servers.units(s.id); } catch (_) { r = null; }
    if (r && r.ok) unitsCache = { id: s.id, at: r.at, units: r.units, timers: r.timers };
  }
  function svcList(box, s) {
    box.innerHTML = '';
    if (unitsCache.id !== s.id || !unitsCache.units) { box.appendChild(el('div', 'srv-empty', s.state === 'online' ? 'Список сервисов загружается…' : 'Нет данных — сервер не на связи.')); return; }
    const q = tabState.svcQ.trim().toLowerCase();
    const pass = (u) => (tabState.svcHelpers || !u.helper) && (tabState.svcScope === 'all' || (tabState.svcScope === 'user') === u.user) && (!q || (u.unit + ' ' + u.desc).toLowerCase().includes(q));
    const failedMap = new Map();
    for (const u of [...(s.failed || []), ...unitsCache.units.filter((x) => x.active === 'failed')]) failedMap.set((u.user ? 'u:' : 's:') + u.unit, u);
    const failed = [...failedMap.values()].filter(pass);
    const running = unitsCache.units.filter((u) => u.active !== 'failed' && pass(u));
    const block = (title, arr, empty) => {
      const h = el('div', 'srv-cgroup'); h.append(el('span', 'srv-cgroup-n', title), el('span', 'srv-cgroup-c', String(arr.length))); box.appendChild(h);
      if (!arr.length) { box.appendChild(el('div', 'srv-empty sm', empty)); return; }
      for (const u of arr) box.appendChild(unitRow(s, u));
    };
    block(t('Упавшие'), failed, t('Упавших нет'));
    block(t('Загруженные'), running.sort((a, b) => (a.sub === 'running' ? 0 : 1) - (b.sub === 'running' ? 0 : 1) || a.unit.localeCompare(b.unit)), t('Ничего не найдено'));
    if (unitsCache.timers && unitsCache.timers.length && !q) {
      const h = el('div', 'srv-cgroup'); h.append(el('span', 'srv-cgroup-n', t('Таймеры')), el('span', 'srv-cgroup-c', String(unitsCache.timers.length))); box.appendChild(h);
      for (const u of unitsCache.timers) box.appendChild(unitRow(s, u, true));
    }
  }
  function unitRow(s, u, timer) {
    const r = el('div', 'srv-urow');
    const kind = u.active === 'failed' ? 'crit' : u.sub === 'running' || u.sub === 'waiting' ? 'ok' : u.active === 'activating' ? 'warn' : 'off';
    const st = el('span', 'srv-cstate srv-state-' + kind); st.append(dot(kind), el('span', null, u.sub || u.active));
    const main1 = el('div', 'srv-crow-main');
    const top = el('div', 'srv-crow-top'); top.append(el('span', 'srv-crow-name', u.unit));
    if (u.user) top.appendChild(el('span', 'srv-chip', 'польз.'));
    if (u.helper) top.appendChild(el('span', 'srv-chip', 'healthcheck'));
    main1.append(top, el('div', 'srv-crow-meta', u.desc || ''));
    const acts = el('div', 'srv-crow-acts');
    const a = (ic, title, fn, cls) => { const b = iconBtn('icon-btn' + (cls ? ' ' + cls : ''), ic, title, 14); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
    a('info', 'Статус', () => textModal(t('Статус: {0}', u.unit), () => lite.servers.unitStatus(s.id, u.unit, u.user)));
    a('list', 'Журнал', () => { Object.assign(tabState.logs, { src: 'unit', unit: (u.user ? 'user:' : '') + u.unit, text: '' }); ui.tab = 'logs'; saveUi(); subscribe(); renderServer(); loadLogs(sel()); });
    if (!timer) a('refresh', 'Перезапустить', () => unitDo(s, u, 'restart'));
    if (!timer && u.active === 'failed') a('play', 'Запустить', () => unitDo(s, u, 'start'));
    r.append(st, main1, acts);
    return r;
  }
  function unitDo(s, u, action) {
    const verb = action === 'restart' ? 'Перезапустить' : 'Запустить';
    const run = async () => {
      const r = await lite.servers.unitAction(s.id, u.unit, u.user, action).catch((e) => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) toast(t('{0}: {1}', u.unit, (r && r.error) || 'ошибка'), { kind: 'err', ttl: 9000 });
      else toast(t('Готово: {0}', u.unit), { ttl: 3000 });
    };
    if (/^(ssh|sshd|networking|systemd-networkd|NetworkManager|wg-quick@.*|openvpn.*|nftables|ufw|firewalld|docker|podman)\.service$/.test(u.unit)) {
      typedConfirm(t('{0} {1} на «{2}»?', t(verb), u.unit, s.name), t('Это сервис, от которого зависит доступ к серверу или сети. Если он не поднимется, вы можете потерять SSH. Чтобы подтвердить, введите имя сервера.'), s.name, t(verb), run);
      return;
    }
    showConfirm(t('{0} {1}?', t(verb), u.unit), t('Сервер «{0}»{1}', s.name, u.user ? '' : ' · ' + t('через sudo')), t(verb), run);
  }

  // ---------------------------------------------------------------- вкладка «Диски»
  function tabDisks(c, s, fromUpdate) {
    let parts = c.querySelector('.srv-disk-parts'), duBox = c.querySelector('.srv-du');
    if (!fromUpdate || !parts || !duBox) {
      c.innerHTML = '';
      parts = el('div', 'srv-disk-parts');
      c.appendChild(parts);
      const h = el('div', 'srv-sec'); h.appendChild(el('span', 'srv-sec-t', 'Что занимает место'));
      c.appendChild(h);
      duBox = el('div', 'srv-du');
      c.appendChild(duBox);
      renderDu(duBox, s);
    }
    parts.innerHTML = '';
    if (!s.disks || !s.disks.length) { parts.appendChild(el('div', 'srv-empty', s.state === 'online' ? 'Разделы загружаются…' : 'Нет данных — сервер не на связи.')); return; }
    const tbl = el('div', 'srv-dtable');
    for (const d of s.disks) {
      const r = el('div', 'srv-drow');
      const nm = el('div', 'srv-drow-n'); nm.append(el('span', 'srv-crow-name', d.mount), el('span', 'srv-crow-meta', `${d.fs} · ${d.type}`));
      const use = el('div', 'srv-drow-u'); use.append(bar(d.pct, (s.thresholds || {}).disk || 90, 97), el('span', 'srv-crow-meta', `${fmtBytes(d.used)} / ${fmtBytes(d.size)} · ${t('свободно {0}', fmtBytes(d.avail))}`));
      const ino = el('div', 'srv-drow-i', d.ipct != null ? t('inodes {0}%', d.ipct) : '');
      const pct = el('div', 'srv-drow-p', d.pct + '%');
      const scan = iconBtn('icon-btn', 'search', 'Что занимает место', 14); scan.onclick = () => { tabState.duPath = d.mount; duScan(duBox, sel()); };
      r.append(nm, use, ino, pct, scan); tbl.appendChild(r);
    }
    parts.appendChild(tbl);
  }
  function renderDu(box, s) {
    box.innerHTML = '';
    const bar1 = el('div', 'srv-tools');
    const p = el('input', 'srv-search'); p.value = tabState.duPath; p.placeholder = '/';
    p.onkeydown = (e) => { if (e.key === 'Enter') { tabState.duPath = p.value.trim() || '/'; duScan(box, sel()); } };
    const sudoL = el('label', 'srv-check'); const sc = el('input'); sc.type = 'checkbox'; sc.checked = tabState.duSudo;
    sc.disabled = !(s.os && s.os.sudo === 'free');
    sc.onchange = () => { tabState.duSudo = sc.checked; };
    sudoL.title = t('Читать каталоги от root (нужен sudo без пароля)');
    sudoL.append(sc, el('span', null, 'от root'));
    const go1 = el('button', 'btn srv-btn-sm', 'Посчитать'); go1.onclick = () => { tabState.duPath = p.value.trim() || '/'; duScan(box, sel()); };
    bar1.append(p, sudoL, go1);
    box.appendChild(bar1);
    const res = el('div', 'srv-du-res');
    box.appendChild(res);
    if (tabState.duBusy) res.appendChild(el('div', 'srv-empty', t('Считаю размер {0}… (на больших каталогах — до пары минут)', tabState.duPath)));
    else if (tabState.du && tabState.du.sid === s.id) duRows(res, box, s);
    else res.appendChild(el('div', 'srv-empty sm', 'Выберите раздел выше или введите путь — покажу, какие каталоги внутри больше всего.'));
  }
  async function duScan(box, s) {
    if (tabState.duBusy) return;
    tabState.duBusy = true; renderDu(box, s);
    const r = await lite.servers.du(s.id, tabState.duPath, tabState.duSudo).catch((e) => ({ ok: false, error: String(e) }));
    tabState.duBusy = false;
    if (!r || !r.ok) { toast((r && r.error) || 'Ошибка', { kind: 'err' }); renderDu(box, s); return; }
    tabState.du = { sid: s.id, dir: r.dir, rows: r.rows };
    if (box.isConnected) renderDu(box, sel() || s);
  }
  function duRows(res, box, s) {
    const { dir, rows } = tabState.du;
    const self = rows.find((x) => x.path === dir) || rows[0];
    const head = el('div', 'srv-du-head');
    head.appendChild(el('span', 'srv-crow-name', t('{0} — всего {1}', dir, fmtBytes(self.size))));
    if (dir !== '/') {
      const up = el('button', 'btn srv-btn-sm', 'Выше');
      up.onclick = () => { tabState.duPath = dir.replace(/\/[^/]+\/?$/, '') || '/'; duScan(box, s); };
      head.appendChild(up);
    }
    res.appendChild(head);
    const kids = rows.filter((x) => x.path !== dir);
    const top = kids.length ? kids[0].size : 1;
    for (const k of kids) {
      const r = el('div', 'srv-du-row');
      r.append(el('span', 'srv-du-n', k.path.slice(dir === '/' ? 1 : dir.length + 1) || k.path), bar(100 * k.size / top), el('span', 'srv-du-s', fmtBytes(k.size)));
      r.onclick = () => { tabState.duPath = k.path; duScan(box, s); };
      res.appendChild(r);
    }
    if (!kids.length) res.appendChild(el('div', 'srv-empty sm', 'Подкаталогов нет'));
  }

  // ---------------------------------------------------------------- вкладка «Логи»
  function tabLogs(c, s) {
    c.innerHTML = '';
    const L = tabState.logs;
    const tools = el('div', 'srv-tools srv-tools-wrap');
    const src = el('select', 'srv-select');
    for (const [v, l] of [['journal', 'Системный журнал'], ['unit', 'Сервис'], ['ctr', 'Контейнер']]) { const o = document.createElement('option'); o.value = v; o.textContent = t(l); src.appendChild(o); }
    src.value = L.src;
    const target = el('select', 'srv-select srv-select-wide');
    const fillTarget = () => {
      target.innerHTML = '';
      if (L.src === 'unit') {
        const units = (unitsCache.id === s.id && unitsCache.units) ? unitsCache.units.filter((u) => !u.helper) : [];
        const all = [...new Map([...(s.failed || []).filter((u) => !u.helper), ...units].map((u) => [(u.user ? 'user:' : '') + u.unit, u])).values()];
        if (L.unit && !all.some((u) => (u.user ? 'user:' : '') + u.unit === L.unit)) all.unshift({ unit: L.unit.replace(/^user:/, ''), user: L.unit.startsWith('user:') });
        for (const u of all) { const o = document.createElement('option'); o.value = (u.user ? 'user:' : '') + u.unit; o.textContent = u.unit + (u.user ? ' (' + t('польз.') + ')' : ''); target.appendChild(o); }
        if (L.unit) target.value = L.unit; L.unit = target.value;
        if (!all.length) loadUnits(s).then(() => { if (unitsCache.units && L.src === 'unit') fillTarget(); });
      } else if (L.src === 'ctr') {
        for (const cc of s.containers || []) { const o = document.createElement('option'); o.value = cc.engine + '|' + cc.id; o.textContent = cc.name; target.appendChild(o); }
        if (L.ctr) target.value = L.ctr; L.ctr = target.value;
      }
      target.style.display = L.src === 'journal' ? 'none' : '';
      prio.style.display = L.src === 'ctr' ? 'none' : '';
    };
    const lines = el('select', 'srv-select');
    for (const n of [100, 300, 1000, 3000]) { const o = document.createElement('option'); o.value = n; o.textContent = t('{0} строк', n); lines.appendChild(o); }
    lines.value = String(L.lines);
    const prio = el('select', 'srv-select');
    for (const [v, l] of [['', 'все уровни'], ['err', 'ошибки'], ['warning', 'предупреждения+']]) { const o = document.createElement('option'); o.value = v; o.textContent = t(l); prio.appendChild(o); }
    prio.value = L.prio;
    const filter = el('input', 'srv-search'); filter.placeholder = t('Фильтр строк…'); filter.value = L.filter;
    const loadB = el('button', 'btn primary srv-btn-sm', 'Показать');
    src.onchange = () => { L.src = src.value; fillTarget(); };
    target.onchange = () => { if (L.src === 'unit') L.unit = target.value; else L.ctr = target.value; };
    lines.onchange = () => { L.lines = +lines.value; };
    prio.onchange = () => { L.prio = prio.value; };
    filter.oninput = () => { L.filter = filter.value; paint(); };
    loadB.onclick = () => loadLogs(sel() || s);
    const cp = iconBtn('icon-btn', 'copy', 'Скопировать', 14); cp.onclick = () => { try { lite.copyText(out.textContent); toast('Скопировано', { ttl: 1500 }); } catch (_) {} };
    tools.append(src, target, prio, lines, filter, loadB, cp);
    const out = el('pre', 'srv-pre srv-logs');
    const paint = () => {
      if (L.busy) { out.textContent = t('Загрузка…'); return; }
      if (!L.text) { out.textContent = t('Выберите источник и нажмите «Показать».'); return; }
      const f = L.filter.trim().toLowerCase();
      out.textContent = f ? L.text.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n') : L.text;
    };
    c.append(tools, out);
    fillTarget(); paint();
    tabState.logs.paint = () => { paint(); out.scrollTop = out.scrollHeight; };
  }
  async function loadLogs(s) {
    const L = tabState.logs;
    if (!s || L.busy) return;
    L.busy = true; if (L.paint) L.paint();
    let r;
    try {
      if (L.src === 'ctr') { const [eng, id] = String(L.ctr || '').split('|'); r = id ? await lite.servers.ctrLogs(s.id, eng, id, L.lines) : { ok: false, error: t('Выберите контейнер') }; }
      else {
        const user = L.src === 'unit' && L.unit.startsWith('user:');
        const unit = L.src === 'unit' ? L.unit.replace(/^user:/, '') : '';
        r = (L.src === 'unit' && !unit) ? { ok: false, error: t('Выберите сервис') } : await lite.servers.journal(s.id, { unit, user, lines: L.lines, priority: L.prio });
      }
    } catch (e) { r = { ok: false, error: String(e) }; }
    L.busy = false;
    if (!r || !r.ok) { toast((r && r.error) || 'Ошибка', { kind: 'err' }); L.text = ''; }
    else L.text = r.text || t('(пусто)');
    if (L.paint) L.paint();
  }

  // ---------------------------------------------------------------- «Сайты» (встроенный «Мониторинг сайтов»)
  let sitesNode = null, sitesMod = null;
  async function renderSites() {
    const m = main(); m.innerHTML = ''; m.dataset.sid = '';
    if (!sitesNode) sitesNode = el('div', 'sitemon-body srv-sites');
    m.appendChild(sitesNode);
    await ensureSites();
  }
  async function ensureSites() {
    if (sitesMod) return sitesMod;
    try {
      const mod = await import('./sitemon.js');
      if (!sitesNode) sitesNode = el('div', 'sitemon-body srv-sites');
      sitesMod = mod.initSitemon({ STORE, persist, body: sitesNode, embedded: true });
      sitesMod.setOpen(true);
    } catch (e) { toast(t('Не удалось загрузить «Сайты»: {0}', (e && e.message) || e), { kind: 'err' }); }
    return sitesMod;
  }
  const SITE_ST = { ok: ['ok', 'в норме'], triggered: ['crit', 'тревога'], warn: ['warn', 'внимание'], error: ['crit', 'ошибка проверки'], unknown: ['wait', 'проверяется…'], info: ['info', 'инфо'] };
  function siteRow(x) {
    const r = el('div', 'srv-status-row');
    const [k, l] = SITE_ST[x.state] || SITE_ST.unknown;
    const st = el('span', 'srv-cstate srv-state-' + k); st.append(dot(k), el('span', null, l));
    const a = el('a', 'srv-link', x.name || x.url); a.href = '#'; a.title = x.url; a.onclick = (e) => { e.preventDefault(); lite.openExternal(x.url); };
    r.append(st, a);
    const go1 = el('button', 'btn srv-btn-sm', 'К сайтам'); go1.onclick = () => go('sites'); r.appendChild(go1);
    return r;
  }

  // ---------------------------------------------------------------- вкладка «Проекты»
  const PST = { ok: ['ok', 'работает'], partial: ['warn', 'частично'], stopped: ['off', 'остановлен'], bad: ['crit', 'проблема'], warn: ['warn', 'внимание'], static: ['info', 'без контейнеров'] };
  const PKIND = { compose: 'compose', pod: 'pod', container: 'контейнер', static: 'статика', proxy: 'прокси', manual: 'вручную' };
  function tabProjects(c, s, fromUpdate) {
    let tools = c.querySelector('.srv-tools'), box = c.querySelector('.srv-proj-list');
    if (!fromUpdate || !tools || !box) {
      c.innerHTML = '';
      tools = el('div', 'srv-tools');
      const q = el('input', 'srv-search'); q.placeholder = t('Поиск: проект, домен, сервис…'); q.value = tabState.projQ || '';
      q.oninput = () => { tabState.projQ = q.value; projList(box, sel()); };
      const hid = el('label', 'srv-check'); const hc = el('input'); hc.type = 'checkbox'; hc.checked = !!tabState.projHidden;
      hc.onchange = () => { tabState.projHidden = hc.checked; projList(box, sel()); };
      hid.append(hc, el('span', null, 'скрытые'));
      const cert = el('button', 'btn srv-btn-sm', 'Проверить сертификаты');
      cert.onclick = async () => { cert.disabled = true; await lite.servers.certCheck(s.id).catch(() => {}); cert.disabled = false; };
      const add = el('button', 'btn srv-btn-sm'); add.append(icon('plus', 13), el('span', null, 'Проект вручную'));
      add.onclick = () => projectModal(sel(), null);
      tools.append(q, hid, el('span', 'srv-grow'), cert, add);
      box = el('div', 'srv-proj-list');
      c.append(tools, box);
    }
    const st = c.scrollTop; projList(box, s); c.scrollTop = st;
  }
  function projList(box, s) {
    box.innerHTML = '';
    if (!s.projects) { box.appendChild(el('div', 'srv-empty', s.state === 'online' ? 'Проекты собираются…' : 'Нет данных — сервер не на связи.')); return; }
    const q = (tabState.projQ || '').trim().toLowerCase();
    const arr = s.projects.filter((p) => (tabState.projHidden || !p.hidden) && (!q || [p.title, p.name, p.workdir, ...p.domains, ...p.containers.map((x) => x.service || x.name)].join(' ').toLowerCase().includes(q)));
    const hidden = s.projects.filter((p) => p.hidden).length;
    box.appendChild(el('div', 'srv-ctr-sum', t('проектов: {0}', s.projects.length - hidden) + (hidden ? ' · ' + t('скрыто: {0}', hidden) : '') + (s.certAt ? ' · ' + t('сертификаты проверены {0}', fmtAgo(s.certAt)) : '')));
    if (!arr.length) { box.appendChild(el('div', 'srv-empty', 'Ничего не найдено')); return; }
    for (const p of arr) box.appendChild(projCard(s, p));
  }
  function certChip(cert) {
    if (!cert || (cert.days == null && !cert.error)) return null;
    if (cert.error) { const c1 = el('span', 'srv-chip', t('TLS: {0}', cert.error)); c1.title = t('Сертификат не получен с этой машины'); return c1; }
    const kind = cert.days < 3 ? 'crit' : cert.days < 14 ? 'warn' : '';
    const c1 = el('span', 'srv-chip' + (kind ? ' ' + kind : ''), cert.days < 0 ? t('TLS истёк') : t('TLS {0} дн.', cert.days));
    c1.title = t('Издатель: {0} · до {1}{2}', cert.issuer || '?', new Date(cert.validTo).toLocaleDateString(), cert.trusted ? '' : ' · ' + t('не доверенный: {0}', cert.trustError));
    if (!cert.trusted && !kind) c1.classList.add('warn');
    return c1;
  }
  function projCard(s, p) {
    const card1 = el('div', 'srv-proj' + (p.hidden ? ' hidden-p' : ''));
    const head = el('div', 'srv-proj-head');
    const [k, l] = PST[p.status] || PST.ok;
    const st = el('span', 'srv-cstate srv-state-' + k); st.append(dot(k), el('span', null, l));
    head.append(st, el('span', 'srv-proj-name', p.title || p.name));
    if (p.title && p.title !== p.name) head.appendChild(el('span', 'srv-crow-sub', p.name));
    head.appendChild(el('span', 'srv-chip', PKIND[p.kind] || p.kind));
    if (p.counts.total) head.appendChild(el('span', 'srv-proj-cnt', t('{0}/{1} контейнеров', p.counts.running, p.counts.total)));
    if (p.counts.running) head.appendChild(el('span', 'srv-proj-cnt', `${fmtPct(p.cpu)} · ${fmtBytes(p.mem)}`));
    card1.appendChild(head);
    const meta = [p.workdir || (p.dirs[0] || ''), p.files.length ? p.files.join(', ') : '', p.via ? p.via + (p.file ? ': ' + p.file : '') : '', p.target ? '→ ' + p.target : ''].filter(Boolean).join(' · ');
    if (meta) card1.appendChild(el('div', 'srv-crow-meta', meta));
    if (p.notes) card1.appendChild(el('div', 'srv-proj-notes', p.notes));
    // домены: ссылка, сертификат, сайт из «Сайтов»
    if (p.domains.length) {
      const dl = el('div', 'srv-proj-doms');
      const certs = new Map(p.certs.map((x) => [x.domain, x]));
      const sites = new Map(p.sites.map((x) => [(() => { try { return new URL(x.url).hostname; } catch (_) { return ''; } })(), x]));
      const show = tabState.projOpen && tabState.projOpen[p.key] ? p.domains : p.domains.slice(0, 6);
      for (const d of show) {
        const row = el('div', 'srv-dom');
        const a = el('a', 'srv-link', d); a.href = '#'; a.onclick = (e) => { e.preventDefault(); lite.openExternal('https://' + d.replace(/^\*\./, '')); };
        row.appendChild(a);
        const cc = certChip(certs.get(d)); if (cc) row.appendChild(cc);
        const site = sites.get(d);
        if (site) { const [sk, sl] = SITE_ST[site.state] || SITE_ST.unknown; const sc = el('span', 'srv-chip' + (sk === 'crit' ? ' crit' : sk === 'warn' ? ' warn' : ''), t('сайт: {0}', t(sl))); row.appendChild(sc); }
        else if (!d.startsWith('*.')) {
          const w = el('button', 'srv-mini', 'наблюдать'); w.title = t('Добавить в «Сайты» с привязкой к этому серверу');
          w.onclick = async () => { const m1 = await ensureSites(); if (m1) m1.addSiteFor('https://' + d + '/', s.id); };
          row.appendChild(w);
        }
        dl.appendChild(row);
      }
      if (p.domains.length > show.length) {
        const more = el('button', 'srv-mini', t('ещё {0}', p.domains.length - show.length));
        more.onclick = () => { tabState.projOpen = { ...(tabState.projOpen || {}), [p.key]: true }; projList(card1.parentNode, sel()); };
        dl.appendChild(more);
      }
      card1.appendChild(dl);
    }
    if (p.containers.length) {
      const cl = el('div', 'srv-proj-ctrs');
      for (const x of p.containers) {
        const kk = x.health === 'unhealthy' ? 'crit' : (CTR_STATE[x.state] || ['off'])[0];
        const ch = el('span', 'srv-proj-ctr'); ch.append(dot(kk), el('span', null, x.service || x.name)); ch.title = `${x.name} · ${x.image} · ${t((CTR_STATE[x.state] || ['', x.state])[1])}`;
        cl.appendChild(ch);
      }
      card1.appendChild(cl);
    }
    const pubPorts = p.ports.filter((x) => x.hostPort);
    if (pubPorts.length) card1.appendChild(el('div', 'srv-crow-meta', t('порты: {0}', pubPorts.map((x) => `${x.hostIp ? x.hostIp + ':' : ''}${x.hostPort}→${x.container}`).join(', '))));
    if (p.unitInfo.length) card1.appendChild(el('div', 'srv-crow-meta', t('юниты: {0}', p.unitInfo.map((u) => u.unit + (u.active ? ' (' + u.active + ')' : '')).join(', '))));
    const acts = el('div', 'srv-proj-acts');
    const b = (ic, label, fn, cls) => { const x = el('button', 'btn srv-btn-sm' + (cls ? ' ' + cls : '')); x.append(icon(ic, 13), el('span', null, label)); x.onclick = fn; acts.appendChild(x); return x; };
    if (p.containers.length) b('list', 'Логи', () => textModal(t('Логи проекта: {0}', p.title || p.name), (n) => lite.servers.projectLogs(s.id, p.key, n), { tails: [50, 200, 1000] }));
    if (p.kind === 'compose') {
      b('refresh', 'Перезапустить', () => projDo(s, p, 'restart'));
      b('download', 'Обновить', () => projDo(s, p, 'update'));
      if (p.counts.running) b('stop', 'Остановить', () => projDo(s, p, 'stop'), 'danger');
      else b('play', 'Запустить', () => projDo(s, p, 'start'));
    }
    const dir = p.workdir || p.dirs[0];
    if (dir) b('folder', 'Файлы', () => lite.module.open('rh', { connId: s.rhId, view: 'files', path: dir }));
    b('pencil', 'Изменить', () => projectModal(s, p));
    b(p.hidden ? 'eye' : 'eye-off', p.hidden ? 'Показать' : 'Скрыть', () => lite.servers.projectSave(s.id, p.key, { hidden: !p.hidden }));
    card1.appendChild(acts);
    return card1;
  }
  async function projDo(s, p, action) {
    let pc; try { pc = await lite.servers.projectCommand(s.id, p.key, action); } catch (e) { pc = { ok: false, error: String(e) }; }
    if (!pc || !pc.ok) { toast((pc && pc.error) || 'Ошибка', { kind: 'err', ttl: 9000 }); return; }
    const verb = { restart: 'Перезапустить', update: 'Обновить', stop: 'Остановить', start: 'Запустить' }[action];
    const title = t('{0} проект «{1}» на «{2}»?', t(verb), pc.project, s.name);
    const what = action === 'update'
      ? t('Скачает свежие образы и пересоздаст контейнеры проекта — сервисы перезапустятся. Если проект поднимали с особыми флагами (профили, env-файлы), сверьте команду. Будет выполнено на сервере:')
      : action === 'stop' ? t('Все сервисы проекта станут недоступны. Будет выполнено на сервере:') : t('Будет выполнено на сервере:');
    const run = () => runProject(s, p, action, pc);
    const typed = action === 'update' || action === 'stop' || VPN_RE.test(p.name + ' ' + p.containers.map((x) => x.image).join(' '));
    cmdConfirm(title, what, pc.cmd, typed ? s.name : null, t(verb), run);
  }
  async function runProject(s, p, action, pc) {
    const { m, close } = makeModal('<h2></h2><div class="srv-mtools"></div><pre class="srv-pre"></pre>');
    m.classList.add('srv-modal-wide');
    m.querySelector('h2').textContent = t('{0}: {1}', pc.project, t({ restart: 'перезапуск', update: 'обновление', stop: 'остановка', start: 'запуск' }[action]));
    const pre = m.querySelector('.srv-pre'); pre.textContent = '$ ' + pc.cmd + '\n\n' + t('Выполняется… (обновление образов может занять несколько минут)');
    const x = iconBtn('icon-btn', 'x', 'Закрыть', 15); x.onclick = close; m.querySelector('.srv-mtools').append(el('span', 'srv-grow'), x);
    let r; try { r = await lite.servers.projectAction(s.id, p.key, action); } catch (e) { r = { ok: false, error: String(e) }; }
    pre.textContent = '$ ' + pc.cmd + '\n\n' + ((r && r.text) || '') + '\n' + (r && r.ok ? t('✓ Готово') : t('✗ Ошибка: {0}', (r && r.error) || '?'));
    pre.scrollTop = pre.scrollHeight;
    if (!r || !r.ok) toast(t('Проект {0}: {1}', pc.project, (r && r.error) || 'ошибка'), { kind: 'err', ttl: 9000 }); else toast(t('Готово: {0}', pc.project), { ttl: 3000 });
  }
  function projectModal(s, p) {
    const manualNew = !p;
    const { m, close } = makeModal(`<h2>${manualNew ? t('Новый проект') : t('Проект: {0}', p.title || p.name)}</h2><div class="db-form srv-form"></div>`);
    m.classList.add('db-modal');
    const f = m.querySelector('.srv-form');
    const field = (label, node, hint) => { const w = el('div', 'db-field'); w.append(el('label', null, label), node); if (hint) w.appendChild(el('div', 'rh-hint', hint)); f.appendChild(w); return node; };
    const inp = (v, ph) => { const i = el('input'); i.type = 'text'; if (v != null) i.value = v; if (ph) i.placeholder = ph; return i; };
    const title = field('Название', inp(p ? (p.title || '') : '', p ? p.name : 'например: лендинг'));
    const domains = field('Дополнительные домены', inp('', 'a.ru, b.ru'), p && p.domains.length ? t('Найдены сами: {0}', p.domains.join(', ')) : 'Через запятую — для них проверяются сертификаты');
    const dirs = field('Каталоги', inp(manualNew ? '' : '', '/var/www/site'), 'Абсолютные пути через запятую — откроются в «Файлах»');
    const units = field('Сервисы systemd', inp('', 'my-app.service'), 'Через запятую — их состояние видно в проекте');
    const notes = el('textarea'); notes.rows = 3; notes.value = (p && p.notes) || ''; field('Заметки', notes);
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const save = el('button', 'btn primary', manualNew ? 'Добавить' : 'Сохранить');
    save.onclick = async () => {
      const patch = { title: title.value, notes: notes.value };
      if (domains.value.trim() || manualNew) patch.domains = domains.value;
      if (dirs.value.trim() || manualNew) patch.dirs = dirs.value;
      if (units.value.trim() || manualNew) patch.units = units.value;
      if (manualNew) patch.manual = true;
      const r = await lite.servers.projectSave(s.id, p ? p.key : '', patch).catch((e) => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) { toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' }); return; }
      close();
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(save, cancel);
    if (p) {
      const reset = el('button', 'btn danger', p.kind === 'manual' ? 'Удалить проект' : 'Сбросить правки');
      reset.onclick = () => showConfirm(p.kind === 'manual' ? t('Удалить проект «{0}»?', p.title || p.name) : t('Сбросить ручные правки «{0}»?', p.title || p.name),
        t('На сервере ничего не изменится — только описание проекта в редакторе.'), t('Да'), async () => { close(); await lite.servers.projectSave(s.id, p.key, null, true); });
      row.append(el('span', 'srv-grow'), reset);
    }
    f.appendChild(row);
    setTimeout(() => title.focus(), 30);
  }

  // ---------------------------------------------------------------- вкладка «Сеть»
  function tabNetwork(c, s, fromUpdate) {
    const st = c.scrollTop;
    c.innerHTML = '';
    const nm = s.net;
    if (!nm) { c.appendChild(el('div', 'srv-empty', s.state === 'online' ? 'Сеть опрашивается…' : 'Нет данных — сервер не на связи.')); return; }
    const head = el('div', 'srv-tools');
    head.appendChild(el('span', 'srv-ctr-sum', s.netAt ? t('обновлено {0}', fmtAgo(s.netAt)) : ''));
    head.appendChild(el('span', 'srv-grow'));
    const eg = el('button', 'btn srv-btn-sm', 'Исходящий адрес'); eg.title = t('С какого внешнего адреса сервер ходит в интернет по умолчанию');
    eg.onclick = () => egressCheck(s, '', eg);
    const rf = iconBtn('icon-btn', 'refresh', 'Обновить', 14); rf.onclick = () => lite.servers.refresh(s.id, 'net');
    head.append(eg, rf);
    c.appendChild(head);
    if (nm.policyRouting) c.appendChild(el('div', 'srv-note', 'На сервере есть свои правила маршрутизации (policy routing) — трафик с разных адресов может уходить разными путями. Проверьте «Исходящий адрес» у каждого адреса.'));
    // адреса
    const ab = section(c, 'Адреса');
    const rates = (s.live && s.live.ifRates) || {};
    for (const i of nm.ifaces.filter((x) => !x.virt)) {
      const r1 = el('div', 'srv-if');
      const top = el('div', 'srv-if-top');
      const k = i.state === 'up' ? 'ok' : i.state === 'unknown' ? 'info' : 'off';
      top.append(dot(k), el('span', 'srv-crow-name', i.name), el('span', 'srv-crow-meta', [i.state, i.mac].filter(Boolean).join(' · ')));
      const rt1 = rates[i.name]; if (rt1) top.appendChild(el('span', 'srv-if-rate', `↓ ${fmtRate(rt1.rx)} · ↑ ${fmtRate(rt1.tx)}`));
      r1.appendChild(top);
      for (const a of i.addrs.filter((x) => x.scope !== 'link')) {
        const ar = el('div', 'srv-if-addr');
        ar.appendChild(el('code', null, `${a.addr}/${a.prefix}`));
        const lab = (s.ipLabels || {})[a.addr];
        const lb = el('button', 'srv-mini' + (lab ? ' on' : ''), lab || t('подпись'));
        lb.title = t('Подпись адреса: «основной», «VPN», «почта»…');
        lb.onclick = () => labelPrompt(s, a.addr, lab);
        ar.appendChild(lb);
        const out = el('span', 'srv-crow-meta');
        const e1 = el('button', 'srv-mini', 'исходящий'); e1.title = t('Каким адресом сервер выходит в интернет с этого адреса'); e1.onclick = () => egressCheck(s, a.addr, e1, out);
        ar.append(e1, out);
        r1.appendChild(ar);
      }
      ab.appendChild(r1);
    }
    // слушающие порты
    const lb = section(c, 'Кто слушает');
    const fwKind = nm.fw && nm.fw.kind;
    for (const g of nm.groups) {
      const gh = el('div', 'srv-cgroup');
      const gname = g.ip ? g.ip : t('Все адреса (0.0.0.0 / ::)');
      gh.append(el('span', 'srv-cgroup-n', gname));
      if (g.label) gh.appendChild(el('span', 'srv-chip', g.label));
      if (/^(127\.|::1)/.test(g.ip)) gh.appendChild(el('span', 'srv-chip', 'только локально'));
      gh.appendChild(el('span', 'srv-cgroup-c', String(g.rows.length)));
      lb.appendChild(gh);
      for (const r2 of g.rows) {
        const row = el('div', 'srv-lrow');
        row.appendChild(el('span', 'srv-lport', `${r2.port}/${r2.proto}`));
        const who = el('div', 'srv-crow-main');
        const top = el('div', 'srv-crow-top');
        if (r2.container) { top.append(icon('box', 12), el('span', 'srv-crow-name', r2.container.service || r2.container.name)); if (r2.container.project) top.appendChild(el('span', 'srv-crow-sub', r2.container.project)); }
        else top.appendChild(el('span', 'srv-crow-name', r2.procs.join(', ') || t('процесс скрыт (нужен sudo)')));
        who.appendChild(top);
        if (r2.domains.length) {
          const dl = el('div', 'srv-crow-meta');
          dl.textContent = r2.domains.length > 4 ? t('{0} и ещё {1}', r2.domains.slice(0, 4).join(', '), r2.domains.length - 4) : r2.domains.join(', ');
          dl.title = r2.domains.join('\n');
          who.appendChild(dl);
        }
        row.appendChild(who);
        const marks = el('div', 'srv-lmarks');
        if (r2.scope === 'all') {
          const ex = nm.exposed.find((x) => x.port === r2.port && x.proto === r2.proto);
          if (ex && ex.fwAllowed === false) marks.appendChild(el('span', 'srv-chip', t('закрыт фаерволом')));
          else marks.appendChild(el('span', 'srv-chip warn', ex && ex.fwAllowed ? t('открыт наружу') : t('на всех адресах')));
        }
        row.appendChild(marks);
        lb.appendChild(row);
      }
    }
    if (fwKind !== 'ufw') lb.appendChild(el('div', 'srv-note', 'Фаервол не ufw (или нет sudo) — открыт ли порт снаружи, не проверить; «на всех адресах» значит, что сервис принимает подключения с любого адреса сервера.'));
    // домены
    if (nm.domains.length) {
      const db = section(c, 'Домены');
      const certs = s.certs || {};
      for (const d of nm.domains) {
        const row = el('div', 'srv-lrow');
        const a = el('a', 'srv-link', d.domain); a.href = '#'; a.onclick = (e) => { e.preventDefault(); lite.openExternal('https://' + d.domain.replace(/^\*\./, '')); };
        const who = el('div', 'srv-crow-main');
        who.append(a, el('div', 'srv-crow-meta', `${d.via} → ${d.target || '?'}${d.project ? ' · ' + d.project : ''}${d.file ? ' · ' + d.file : ''}`));
        row.append(icon('globe', 13), who);
        const marks = el('div', 'srv-lmarks'); const cc = certChip(certs[d.domain]); if (cc) marks.appendChild(cc);
        row.appendChild(marks);
        db.appendChild(row);
      }
    }
    // маршрутизация
    const rb = section(c, 'Маршрутизация');
    if (nm.rules.length) {
      const rl = el('div', 'srv-pre srv-pre-sm');
      rl.textContent = nm.rules.map((x) => `${String(x.priority).padStart(5)}: ${x.text}${x.custom ? '   ← ' + t('своё правило') : ''}`).join('\n');
      rb.appendChild(rl);
    }
    const rt2 = el('div', 'srv-pre srv-pre-sm');
    rt2.textContent = nm.routes.map((x) => `${x.fam === 6 ? 'v6 ' : ''}${x.dst || 'default'}${x.via ? ' via ' + x.via : ''}${x.dev ? ' dev ' + x.dev : ''}${x.src ? ' src ' + x.src : ''}${x.metric != null ? ' metric ' + x.metric : ''}${x.table ? ' table ' + x.table : ''}${x.proto ? ' (' + x.proto + ')' : ''}`).join('\n');
    rb.appendChild(rt2);
    // фаервол
    const fb = section(c, 'Фаервол');
    const fw = nm.fw;
    if (!fw || !fw.kind) fb.appendChild(el('div', 'srv-empty sm', 'Фаервол не найден или нужен sudo, чтобы его прочитать.'));
    else {
      const st1 = el('div', 'srv-status-row ' + (fw.active ? 'ok' : 'warn'));
      st1.append(icon(fw.active ? 'check' : 'warning', 14), el('span', null, t('{0}: {1}', fw.kind, fw.active ? t('включён') : t('выключен'))));
      fb.appendChild(st1);
      if (fw.text) { const pre = el('div', 'srv-pre srv-pre-sm'); pre.textContent = fw.text; fb.appendChild(pre); }
      if (fw.nftTables && fw.nftTables.length) fb.appendChild(el('div', 'srv-crow-meta', t('таблицы nftables: {0}', fw.nftTables.join(', '))));
    }
    c.scrollTop = st;
  }
  async function egressCheck(s, ip, btn, out) {
    btn.disabled = true;
    const r = await lite.servers.egress(s.id, ip || undefined).catch((e) => ({ ok: false, error: String(e) }));
    btn.disabled = false;
    if (!r || !r.ok) { toast(t('Исходящий адрес: {0}', (r && r.error) || 'ошибка'), { kind: 'err' }); return; }
    if (out) out.textContent = '→ ' + r.ip; else toast(t('Сервер выходит в интернет с адреса {0}', r.ip), { ttl: 8000 });
  }
  function labelPrompt(s, ip, cur) {
    const { m, close } = makeModal('<h2></h2><input class="srv-typed" type="text" maxlength="40"><div class="modal-actions"><button class="btn" data-x>Отмена</button><button class="btn primary" data-ok>Сохранить</button></div>');
    m.querySelector('h2').textContent = t('Подпись адреса {0}', ip);
    const inp = m.querySelector('.srv-typed'); inp.value = cur || ''; inp.placeholder = t('например: основной, VPN');
    const save = async () => { const r = await lite.servers.ipLabel(s.id, ip, inp.value).catch((e) => ({ ok: false, error: String(e) })); if (!r || !r.ok) toast((r && r.error) || 'Ошибка', { kind: 'err' }); close(); };
    m.querySelector('[data-x]').onclick = close; m.querySelector('[data-ok]').onclick = save;
    inp.onkeydown = (e) => { if (e.key === 'Enter') save(); };
    setTimeout(() => inp.focus(), 30);
  }

  // ---------------------------------------------------------------- добавление / настройки сервера
  async function addServer() { serverModal(null); }
  async function serverModal(existing) {
    let prof; try { prof = await lite.rh.list(); } catch (_) { prof = null; }
    const conns = ((prof && prof.connections) || []).filter((c) => c.type !== 'ftp');
    const s = existing ? { ...existing } : { enabled: true, group: '', tags: [], pollFastSec: 10, pollSlowSec: 300, thresholds: { disk: 90, inode: 90, mem: 90, load: 2 } };
    const { m, close } = makeModal(`<h2>${existing ? t('Настройки сервера') : t('Добавить сервер')}</h2><div class="db-form srv-form"></div>`);
    m.classList.add('db-modal');
    const f = m.querySelector('.srv-form');
    const field = (label, node, hint) => { const w = el('div', 'db-field'); w.append(el('label', null, label), node); if (hint) w.appendChild(el('div', 'rh-hint', hint)); f.appendChild(w); return node; };
    const inp = (v, ph, type) => { const i = el('input'); i.type = type || 'text'; if (v != null) i.value = v; if (ph) i.placeholder = ph; return i; };
    if (!conns.length) {
      f.appendChild(el('div', 'rh-hint', 'Сначала создайте SSH-профиль в «Удалённых хостах» — сервер подключается через него (пароль или ключ хранятся там).'));
      const b = el('button', 'btn primary', 'Открыть «Удалённые хосты»'); b.onclick = () => { close(); lite.module.open('rh'); };
      f.appendChild(b); return;
    }
    const used = new Set(list.filter((x) => !existing || x.id !== existing.id).map((x) => x.rhId));
    const pSel = el('select');
    for (const c of conns) { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.name || c.host} — ${c.user ? c.user + '@' : ''}${c.host}${used.has(c.id) ? ' · ' + t('уже добавлен') : ''}`; pSel.appendChild(o); }
    pSel.value = s.rhId || (conns.find((c) => !used.has(c.id)) || conns[0]).id;
    field('SSH-профиль', pSel, 'Профиль из «Удалённых хостов». Новый — создайте там.');
    const name = field('Имя', inp(s.name || '', 'по имени профиля'));
    const groups = [...new Set(list.map((x) => x.group).filter(Boolean))];
    const dl = el('datalist'); dl.id = 'srv-groups'; for (const g of groups) { const o = document.createElement('option'); o.value = g; dl.appendChild(o); }
    f.appendChild(dl);
    const group = field('Группа', inp(s.group || '', 'например: РФ, Зарубеж')); group.setAttribute('list', 'srv-groups');
    const tags = field('Теги', inp((s.tags || []).join(', '), 'через запятую'));
    const g1 = el('div', 'db-group');
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const pf = inp(s.pollFastSec || 10, '10', 'number'), ps = inp(s.pollSlowSec || 300, '300', 'number');
    g1.append(mk('Опрос ресурсов, с', pf), mk('Полный опрос, с', ps)); f.appendChild(g1);
    f.appendChild(el('div', 'rh-hint', 'Когда окно «Серверы» закрыто, ресурсы опрашиваются раз в минуту — ради уведомлений о проблемах.'));
    const th = s.thresholds || {};
    const g2 = el('div', 'db-group');
    const td = inp(th.disk || 90, '90', 'number'), tm = inp(th.mem || 90, '90', 'number'), tl = inp(th.load || 2, '2', 'number'); tl.step = '0.5';
    g2.append(mk('Диск, % ≥', td), mk('Память, % ≥', tm), mk('Load на ядро ≥', tl)); f.appendChild(g2);
    const notes = el('textarea'); notes.rows = 3; notes.value = s.notes || ''; field('Заметки', notes);
    const en = el('input'); en.type = 'checkbox'; en.checked = s.enabled !== false;
    const enL = el('label', 'db-check'); enL.append(en, document.createTextNode(' ' + t('Опрашивать сервер'))); f.appendChild(enL);
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const save = el('button', 'btn primary', existing ? 'Сохранить' : 'Добавить');
    save.onclick = async () => {
      const rec = { id: s.id, rhId: pSel.value, name: name.value.trim(), group: group.value.trim(), tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean),
        pollFastSec: +pf.value, pollSlowSec: +ps.value, thresholds: { disk: +td.value, inode: th.inode || 90, mem: +tm.value, load: +tl.value }, notes: notes.value, enabled: en.checked };
      const r = await lite.servers.save(rec).catch((e) => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) { toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' }); return; }
      close();
      if (!existing) { ui.view = 'server'; ui.selId = r.id; ui.tab = 'overview'; saveUi(); subscribe(); }
      reload();
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(save, cancel);
    if (existing) {
      const del = el('button', 'btn danger', 'Убрать из списка');
      del.title = t('Сервер пропадёт из дашборда; SSH-профиль в «Удалённых хостах» останется');
      del.onclick = () => showConfirm(t('Убрать «{0}» из «Серверов»?', s.name), t('История метрик удалится. SSH-профиль в «Удалённых хостах» не тронется.'), t('Убрать'), async () => {
        close(); const r = await lite.servers.remove(s.id); if (r && r.ok) { ui.view = 'all'; saveUi(); reload(); } else toast((r && r.error) || 'Ошибка', { kind: 'err' });
      });
      row.appendChild(el('span', 'srv-grow'));
      row.appendChild(del);
    }
    f.appendChild(row);
    if (existing) {
      const danger = el('div', 'srv-danger');
      danger.appendChild(el('div', 'srv-sec-t', 'Опасная зона'));
      const rb = el('button', 'btn danger', 'Перезагрузить сервер');
      rb.onclick = () => { close(); typedConfirm(t('Перезагрузить «{0}»?', s.name), t('Все сервисы и контейнеры сервера будут недоступны, пока он не поднимется (обычно 1–3 минуты). Контейнеры без политики автозапуска не поднимутся сами. Чтобы подтвердить, введите имя сервера.'), s.name, t('Перезагрузить'), async () => {
        const r = await lite.servers.reboot(s.id).catch((e) => ({ ok: false, error: String(e) }));
        if (!r || !r.ok) toast((r && r.error) || 'Ошибка', { kind: 'err', ttl: 9000 }); else toast(t('Сервер «{0}» перезагружается', s.name), { ttl: 6000 });
      }); };
      danger.appendChild(rb);
      f.appendChild(danger);
    }
  }

  // ---------------------------------------------------------------- параметр открытия окна
  // { serverId, tab? } — открыть сервер (из уведомления, из других модулей)
  function handleArg(arg) {
    if (!arg || typeof arg !== 'object') return;
    if (arg.serverId) { ui.selId = String(arg.serverId); ui.view = 'server'; if (arg.tab && TABS.some((x) => x[0] === arg.tab)) ui.tab = arg.tab; }
    else if (arg.view === 'issues') ui.view = 'issues';
    else if (arg.view === 'sites') ui.view = 'sites';
    saveUi(); subscribe(); render();
  }
  function refreshAll() { lite.servers.refresh(null).catch(() => {}); toast('Опрашиваю все серверы…', { ttl: 2500 }); }

  return { isOpen: () => open, setOpen, addServer, refreshAll, handleArg };
}
