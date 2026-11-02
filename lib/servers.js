// «Серверы» — бэкенд модуля-дашборда: реестр серверов, планировщик опроса, история метрик, правила
// проблем с уведомлениями и действия из белого списка (контейнеры, systemd, журнал, du, перезагрузка).
//
// Сервер = ссылка на SSH-профиль «Удалённых хостов» (rhId): секреты и ключи хоста живут там, сюда не
// копируются. Опрос — проба lib/servers-probe.js через постоянное соединение (rhApi.execPooled): одно
// SSH-соединение на сервер, ничего не устанавливается.
//
// Частоты (окно «Серверы» открыто → быстрее; закрыто → фон, ради уведомлений):
//   fast  — pollFastSec (10 с) / фон 60 с      ctr   — 15 с на вкладке «Контейнеры», 60 с в окне, 5 мин фон
//   slow  — pollSlowSec (5 мин)                 units — 60 с на вкладке «Сервисы», иначе с каждой slow
//   pkg   — 30 мин (apt list ~0.6 с)
// Проблема (issue) = { key, sev: crit|warn|info, tpl, args, since, muted } — tpl/args переводит окно
// (шаблон — ключ словаря), уведомление ОС переводит main (i18n.t). Уведомляем о НОВЫХ crit/warn —
// ключи уже показанных проблем помнит конфиг сервера (seen), чтобы перезапуск редактора не повторял их.
'use strict';
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const probe = require('./servers-probe');
const model = require('./servers-model');
const agent = require('./servers-agent');

let D = null; // { ipcMain, rhApi, readStoreKey, writeStoreKey, broadcast, notify, log, storeDir }
let servers = [];
const rt = new Map();     // id -> runtime
const subs = new Map();   // webContents.id -> { wc, focus: { id, tab } }

const HIST_FAST_MS = 60 * 60 * 1000;      // сырые fast-замеры — час
const HIST_MIN_POINTS = 24 * 60;          // поминутные агрегаты — сутки
const PKG_EVERY = 30 * 60 * 1000;
const CERT_EVERY = 6 * 3600 * 1000;      // сроки TLS-сертификатов доменов — раз в 6 часов
const PROBE_TIMEOUT = 45000;
// юниты нужны и вне «Сервисов»: проекты показывают состояние своих юнитов
const DEF = { enabled: true, group: '', tags: [], notes: '', pollFastSec: 10, bgFastSec: 60, pollSlowSec: 300,
  thresholds: { disk: 90, inode: 90, mem: 90, load: 2 } };

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const newId = () => 'srv' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
const fmt = (tpl, args) => String(tpl).replace(/\{(\d)\}/g, (_, i) => (args && args[Number(i)] != null ? String(args[Number(i)]) : ''));

// ---------------------------------------------------------------- конфиг
function sanitize(x, prev) {
  const p = prev || {};
  const th = { ...DEF.thresholds, ...(p.thresholds || {}), ...((x && x.thresholds) || {}) };
  return {
    id: p.id || newId(),
    rhId: String((x && x.rhId) || p.rhId || ''),
    name: String((x && x.name != null ? x.name : p.name) || '').trim().slice(0, 80),
    group: String((x && x.group != null ? x.group : p.group) || '').trim().slice(0, 40),
    tags: (Array.isArray(x && x.tags) ? x.tags : (p.tags || [])).map((t) => String(t).trim()).filter(Boolean).slice(0, 12),
    notes: String((x && x.notes != null ? x.notes : p.notes) || '').slice(0, 4000),
    enabled: x && x.enabled != null ? !!x.enabled : (p.enabled != null ? p.enabled : true),
    pollFastSec: clampInt(x && x.pollFastSec != null ? x.pollFastSec : p.pollFastSec, 5, 600, DEF.pollFastSec),
    bgFastSec: clampInt(x && x.bgFastSec != null ? x.bgFastSec : p.bgFastSec, 15, 3600, DEF.bgFastSec),
    pollSlowSec: clampInt(x && x.pollSlowSec != null ? x.pollSlowSec : p.pollSlowSec, 60, 86400, DEF.pollSlowSec),
    thresholds: { disk: clampInt(th.disk, 50, 99, 90), inode: clampInt(th.inode, 50, 99, 90), mem: clampInt(th.mem, 50, 99, 90), load: Math.max(0.5, Math.min(20, Number(th.load) || 2)) },
    muted: (p.muted && typeof p.muted === 'object') ? p.muted : {},
    seen: Array.isArray(p.seen) ? p.seen : [],
    // подписи адресов («основной», «VPN») и ручные правки проектов — правятся своими IPC, не формой
    ipLabels: (p.ipLabels && typeof p.ipLabels === 'object') ? p.ipLabels : {},
    projects: (p.projects && typeof p.projects === 'object') ? p.projects : {},
    // агент: до какого момента уже дочитано (сек) и последние события с сервера
    agentSync: (p.agentSync && typeof p.agentSync === 'object') ? p.agentSync : { m: 0, e: 0 },
    agentEvents: Array.isArray(p.agentEvents) ? p.agentEvents.slice(-200) : [],
  };
}
function persist() { try { D.writeStoreKey('servers', servers); } catch (_) {} }
function load() {
  const raw = D.readStoreKey('servers');
  servers = Array.isArray(raw) ? raw.filter((x) => x && x.id).map((x) => sanitize(x, x)) : [];
}

// ---------------------------------------------------------------- runtime
function R(id) {
  let r = rt.get(id);
  if (!r) {
    r = { checking: false, state: 'unknown', error: '', fails: 0, lastOk: 0, lastTry: 0,
      tFast: 0, tSlow: 0, tCtr: 0, tUnits: 0, tPkg: 0, want: new Set(['slow', 'ctr', 'pkg', 'net', 'units']),
      engines: [], prevCpu: null, prevNet: null, prevNetAt: 0, prevCtrState: null, prevRestarts: new Map(), restartAt: new Map(),
      os: null, ips: [], live: null, disks: [], failed: [], reboot: null, pkg: null, containers: null, ctrState: null, ctrAt: 0,
      units: null, timers: null, unitsAt: 0, hist: [], minute: [], minAcc: null, issues: new Map(), counters: new Map(),
      tNet: 0, net2: null, netAt: 0, tools: null, certs: {}, tCert: 0, certBusy: false,
      agent: null, agentSynced: false, agentBusy: false };
    rt.set(id, r);
  }
  return r;
}
function windowOpen() { return subs.size > 0; }
function focusOf(id) { for (const s of subs.values()) if (s.focus && s.focus.id === id) return s.focus.tab || 'overview'; return null; }

// ---------------------------------------------------------------- история
function histPath() { return path.join(D.storeDir, 'servers-hist.json'); }
let histDirty = false, histTimer = null;
function loadHist() {
  try {
    const j = JSON.parse(fs.readFileSync(histPath(), 'utf8'));
    const cut = Date.now() - 24 * 3600 * 1000;
    for (const [id, pts] of Object.entries(j || {})) if (Array.isArray(pts)) R(id).minute = pts.filter((p) => Array.isArray(p) && p[0] > cut).slice(-HIST_MIN_POINTS);
  } catch (_) {}
}
function flushHist() {
  if (!histDirty) return;
  histDirty = false;
  const out = {};
  for (const s of servers) { const r = rt.get(s.id); if (r && r.minute.length) out[s.id] = r.minute; }
  try { const tmp = histPath() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, histPath()); } catch (e) { D.log('warn', 'servers', 'история не записалась: ' + e.message); }
}
function markHist() { histDirty = true; if (!histTimer) { histTimer = setTimeout(() => { histTimer = null; flushHist(); }, 60000); if (histTimer.unref) histTimer.unref(); } }
// точка: [t, cpu%, mem%, load1, rx B/s, tx B/s]
function pushHist(r, pt) {
  r.hist.push(pt);
  const cut = pt[0] - HIST_FAST_MS;
  while (r.hist.length && r.hist[0][0] < cut) r.hist.shift();
  const minute = Math.floor(pt[0] / 60000) * 60000;
  if (r.minAcc && r.minAcc.t !== minute) {
    const a = r.minAcc;
    r.minute.push([a.t, +(a.cpu / a.n).toFixed(1), +(a.mem / a.n).toFixed(1), +a.load.toFixed(2), Math.round(a.rx / a.n), Math.round(a.tx / a.n)]);
    if (r.minute.length > HIST_MIN_POINTS) r.minute.splice(0, r.minute.length - HIST_MIN_POINTS);
    r.minAcc = null; markHist();
  }
  if (!r.minAcc) r.minAcc = { t: minute, n: 0, cpu: 0, mem: 0, load: 0, rx: 0, tx: 0 };
  const a = r.minAcc; a.n++; a.cpu += pt[1] || 0; a.mem += pt[2] || 0; a.load = Math.max(a.load, pt[3] || 0); a.rx += pt[4] || 0; a.tx += pt[5] || 0;
}
// искра для карточки: последний час поминутно (+ текущая неполная минута)
function sparkOf(r) {
  const cut = Date.now() - HIST_FAST_MS;
  const pts = r.minute.filter((p) => p[0] >= cut);
  if (r.minAcc && r.minAcc.n) { const a = r.minAcc; pts.push([a.t, a.cpu / a.n, a.mem / a.n, a.load, a.rx / a.n, a.tx / a.n]); }
  return pts.map((p) => [p[0], +(+p[1]).toFixed(1), +(+p[2]).toFixed(1), +(+p[3]).toFixed(2), Math.round(p[4]), Math.round(p[5])]);
}

// ---------------------------------------------------------------- применение пробы
function applyProbe(s, r, d, secs) {
  const now = Date.now();
  if (d.engines) r.engines = d.engines;
  if (d.os) r.os = d.os;
  if (d.ips) r.ips = d.ips;
  if (d.disks) r.disks = d.disks;
  if (d.failed) r.failed = d.failed;
  if (d.reboot) r.reboot = d.reboot;
  if (d.pkg) r.pkg = { ...d.pkg, at: now };
  if (d.units) { r.units = d.units; r.timers = d.timers || []; r.unitsAt = now; }
  if (d.tools) r.tools = d.tools;
  if (d.agent) r.agent = d.agent;
  if (d.net2) { r.net2 = d.net2; r.netAt = now; }
  if (d.containers) {
    for (const c of d.containers) { // рост числа рестартов — проблема на 30 мин
      const k = c.engine + ':' + c.id, prev = r.prevRestarts.get(k);
      if (prev != null && c.restarts > prev) r.restartAt.set(k, { at: now, n: c.restarts - prev, name: c.name });
      r.prevRestarts.set(k, c.restarts);
    }
    r.containers = d.containers; r.ctrAt = now;
  }
  if (d.ctrState) {
    // контейнер был running и перестал → сразу полный список (код выхода, рестарты)
    if (r.prevCtrState) {
      const was = new Map(r.prevCtrState.map((c) => [c.engine + ':' + c.id, c.state]));
      if (d.ctrState.some((c) => was.get(c.engine + ':' + c.id) === 'running' && c.state !== 'running') || d.ctrState.length !== r.prevCtrState.length) r.want.add('ctr');
    }
    r.prevCtrState = d.ctrState; r.ctrState = d.ctrState;
  }
  if (secs.includes('fast') && d.cpu && d.mem) {
    let cpuPct = null;
    if (r.prevCpu && d.cpu.total > r.prevCpu.total) cpuPct = Math.max(0, Math.min(100, 100 * (1 - (d.cpu.idle - r.prevCpu.idle) / (d.cpu.total - r.prevCpu.total))));
    r.prevCpu = d.cpu;
    let rx = null, tx = null; const ifRates = {};
    if (d.net) {
      if (r.prevNet && r.prevNetAt) {
        const dt = (now - r.prevNetAt) / 1000; rx = 0; tx = 0;
        for (const [n, v] of Object.entries(d.net)) {
          const p = r.prevNet[n]; if (!p || dt <= 0) continue;
          const drx = Math.max(0, v.rx - p.rx) / dt, dtx = Math.max(0, v.tx - p.tx) / dt;
          ifRates[n] = { rx: Math.round(drx), tx: Math.round(dtx), virt: v.virt };
          if (!v.virt) { rx += drx; tx += dtx; }
        }
      }
      r.prevNet = d.net; r.prevNetAt = now;
    }
    const memPct = d.mem.total ? 100 * d.mem.used / d.mem.total : 0;
    r.live = { at: now, uptime: d.uptime, load: d.load, cpu: cpuPct, mem: d.mem, memPct, rx: rx == null ? null : Math.round(rx), tx: tx == null ? null : Math.round(tx), ifRates };
    if (cpuPct != null) pushHist(r, [now, +cpuPct.toFixed(1), +memPct.toFixed(1), d.load ? d.load.l1 : 0, Math.round(rx || 0), Math.round(tx || 0)]);
  }
}

// ---------------------------------------------------------------- проблемы
// bump=false — пересчёт вне опроса (сайты, сертификаты): счётчики «N замеров подряд» не растут
function evalIssues(s, r, bump = true) {
  const want = []; // [key, sev, tpl, args, need]
  const th = s.thresholds;
  if (r.state === 'hostkey') want.push(['conn', 'crit', 'Ключ SSH-хоста изменился — опрос остановлен, решите в «Удалённых хостах»', [], 1]);
  else if (r.state === 'auth') want.push(['conn', 'crit', 'Не удалось войти по SSH: {0}', [r.error], 1]);
  else if (r.state === 'offline') want.push(['conn', 'crit', 'Нет связи с сервером: {0}', [r.error], 2]);
  if (r.state === 'online') {
    for (const d of r.disks || []) {
      if (d.pct != null && d.pct >= th.disk) want.push(['disk:' + d.mount, d.pct >= Math.max(97, th.disk) ? 'crit' : 'warn', 'Диск {0} заполнен на {1}%', [d.mount, d.pct], 1]);
      if (d.ipct != null && d.ipct >= th.inode) want.push(['inode:' + d.mount, 'warn', 'Inodes на {0} заняты на {1}%', [d.mount, d.ipct], 1]);
    }
    const live = r.live; const nproc = (r.os && r.os.nproc) || 1;
    const need = Math.max(2, Math.ceil(60 / (windowOpen() ? s.pollFastSec : s.bgFastSec)));
    if (live && live.memPct >= th.mem) want.push(['mem', 'warn', 'Память занята на {0}%', [Math.round(live.memPct)], need]);
    if (live && live.load && live.load.l1 > nproc * th.load) want.push(['load', 'warn', 'Высокая нагрузка: load {0} при {1} ядрах', [live.load.l1.toFixed(2), nproc], need]);
    const byId = new Map((r.containers || []).map((c) => [c.id, c]));
    for (const u of r.failed || []) {
      if (u.helper) {
        // юнит проверки здоровья контейнера, которого уже нет (пересоздан compose) — мусор systemd, не проблема
        const c = byId.get(u.unit.slice(0, 12));
        if (c) want.push(['hc:' + c.name, 'info', 'Проверка здоровья контейнера {0} завершилась ошибкой', [c.name], 1]);
      } else want.push(['unit:' + (u.user ? 'user:' : '') + u.unit, 'warn', u.user ? 'Пользовательский сервис {0} упал' : 'Сервис {0} упал', [u.unit], 1]);
    }
    if (r.reboot && r.reboot.required) want.push(['reboot', 'info', 'Нужна перезагрузка (обновлено пакетов: {0})', [r.reboot.pkgs.length], 1]);
    if (r.pkg && r.pkg.security > 0) want.push(['security', 'info', 'Обновления безопасности: {0}', [r.pkg.security], 1]);
    const now = Date.now();
    for (const c of r.containers || []) {
      const nm = c.name || c.id;
      if (c.health === 'unhealthy') want.push(['ctrh:' + nm, 'warn', 'Контейнер {0} нездоров (healthcheck)', [nm], 1]);
      // остановка руками даёт 0 / 137 (SIGKILL) / 143 (SIGTERM) — это не авария
      if ((c.state === 'exited' || c.state === 'dead') && c.exitCode != null && ![0, 137, 143].includes(c.exitCode)) want.push(['ctrx:' + nm, 'warn', 'Контейнер {0} остановился с кодом {1}', [nm, c.exitCode], 1]);
      const ra = r.restartAt.get(c.engine + ':' + c.id);
      if (ra && now - ra.at < 30 * 60 * 1000) want.push(['ctrr:' + nm, 'warn', 'Контейнер {0} перезапустился (+{1})', [nm, ra.n], 1]);
    }
  }
  // сертификаты доменов: < 14 дней — внимание, < 3 дней или истёк — критично
  for (const [d, c] of Object.entries(r.certs || {})) {
    if (c.days == null) continue;
    if (c.days < 0) want.push(['cert:' + d, 'crit', 'Сертификат {0} истёк {1}', [d, fmtDate(c.validTo)], 1]);
    else if (c.days < 3) want.push(['cert:' + d, 'crit', 'Сертификат {0} истекает через {1} дн.', [d, c.days], 1]);
    else if (c.days < 14) want.push(['cert:' + d, 'warn', 'Сертификат {0} истекает через {1} дн.', [d, c.days], 1]);
  }
  // сайты из вкладки «Сайты», привязанные к серверу (уведомляет сам «Мониторинг сайтов» — здесь тихо)
  for (const t of sitesOf(s)) {
    const st = model.siteState(t);
    if (st === 'triggered') want.push(['site:' + t.id, 'crit', 'Сайт {0}: сработала проверка', [t.name || t.url], 1, true]);
    else if (st === 'error') want.push(['site:' + t.id, 'warn', 'Сайт {0}: проверка не выполнилась', [t.name || t.url], 1, true]);
  }
  // порт открыт наружу (слушает на всех адресах, фаервол пропускает) — к сведению, кроме обычных 22/80/443
  if (r.state === 'online' && r.net2) {
    const nm = model.buildNetMap(r.net2, r.containers, s.ipLabels);
    for (const x of (nm && nm.exposed) || []) {
      if ([22, 80, 443].includes(x.port) || x.fwAllowed === false || x.proto !== 'tcp') continue;
      want.push(['exposed:' + x.proto + x.port, 'info', 'Порт {0}/{1} ({2}) открыт на всех адресах', [x.port, x.proto, (x.container && x.container.name) || x.procs.join(', ') || '?'], 1, true]);
    }
  }
  const now = Date.now();
  const active = new Set();
  for (const [key, sev, tpl, args, need, quiet] of want) {
    const old = r.counters.get(key) || 0;
    const n = bump ? old + 1 : Math.max(old, need === 1 ? 1 : 0);
    r.counters.set(key, n);
    if (n < need) continue;
    active.add(key);
    const prev = r.issues.get(key);
    r.issues.set(key, { key, sev, tpl, args, since: prev ? prev.since : now, quiet: !!quiet });
  }
  if (bump) for (const k of [...r.counters.keys()]) if (!want.some((w) => w[0] === k)) r.counters.delete(k);
  const gone = [];
  for (const k of [...r.issues.keys()]) if (!active.has(k)) { gone.push(r.issues.get(k)); r.issues.delete(k); }
  // уведомления: новые crit/warn, которых не было в прошлый раз (seen переживает перезапуск)
  for (const [k, m] of Object.entries(s.muted)) if (!(m > now)) delete s.muted[k];
  const seen = new Set(s.seen);
  for (const is of r.issues.values()) {
    if (seen.has(is.key)) continue;
    if ((is.sev === 'crit' || is.sev === 'warn') && !is.quiet && !(s.muted[is.key] > now)) {
      try { D.notify(s, is.sev, is.tpl, is.args); } catch (_) {}
    }
  }
  if (gone.some((g) => g.key === 'conn') && seen.has('conn')) { try { D.notify(s, 'ok', 'Сервер снова на связи', []); } catch (_) {} }
  const nextSeen = [...r.issues.keys()].sort();
  if (nextSeen.join('\n') !== s.seen.slice().sort().join('\n')) { s.seen = nextSeen; persist(); }
}

// ---------------------------------------------------------------- опрос
function classify(err) {
  const e = String(err || '');
  if (/Ключ SSH-хоста|Host denied/i.test(e)) return 'hostkey';
  if (/All configured authentication methods failed|Permission denied \(publickey|Authentication failure/i.test(e)) return 'auth';
  return 'offline';
}
async function runProbe(s, secs) {
  const r = R(s.id);
  if (r.checking) return;
  r.checking = true; r.lastTry = Date.now();
  const t = Date.now();
  if (secs.includes('fast')) r.tFast = t;
  if (secs.includes('slow')) { r.tSlow = t; r.want.delete('slow'); }
  if (secs.includes('ctr')) { r.tCtr = t; r.want.delete('ctr'); }
  if (secs.includes('units')) { r.tUnits = t; r.want.delete('units'); }
  if (secs.includes('pkg')) { r.tPkg = t; r.want.delete('pkg'); }
  if (secs.includes('net')) { r.tNet = t; r.want.delete('net'); }
  try {
    const res = await D.rhApi.execPooled(s.rhId, probe.command(secs, r.engines), PROBE_TIMEOUT, probe.SCRIPT);
    if (!res.ok) {
      r.fails++; r.state = classify(res.error); r.error = res.error || 'ошибка';
      // не дошли до хоста — то, что собирались собрать, соберём при первом успехе
      for (const x of secs) if (x !== 'fast') r.want.add(x);
    } else {
      const d = probe.parse(res.stdout);
      if (!d.complete && !d.now) throw new Error(((res.stderr || '').trim().split('\n').pop()) || 'проба не выполнилась');
      if (Object.keys(d.errors).length) D.log('warn', 'servers', `${s.name}: секции с ошибкой — ${JSON.stringify(d.errors).slice(0, 400)}`);
      applyProbe(s, r, d, secs);
      r.fails = 0; r.state = 'online'; r.error = ''; r.lastOk = Date.now();
    }
  } catch (e) {
    r.fails++; r.state = 'offline'; r.error = String((e && e.message) || e);
  } finally {
    r.checking = false;
  }
  evalIssues(s, r);
  D.broadcast('servers:update', { server: pub(s) });
  if (r.state === 'online' && r.containers && Date.now() - r.tCert >= CERT_EVERY) checkCerts(s, false);
  if (r.state === 'online' && secs.includes('slow') && r.agent && r.agent.installed) agentSync(s);
}

// ---------------------------------------------------------------- агент: дочитать накопленное
// Метрики — в поминутную историю (заполняют дыры, пока редактор был закрыт), события — в ленту сервера.
// Уведомление одно и только при первом дочитывании после запуска редактора: дальше проблемы видит сам опрос.
async function agentSync(s) {
  const r = R(s.id);
  if (r.agentBusy) return;
  r.agentBusy = true;
  try {
    const since = s.agentSync.m || Math.floor((Date.now() - 24 * 3600e3) / 1000);
    const res = await D.rhApi.execPooled(s.rhId, 'sh -s', 60000, agent.syncScript(since, s.agentSync.e || 0));
    if (!res.ok) return;
    const d = agent.parseSync(res.stdout);
    if (!d.installed) return;
    // метрики → минуты, которых в истории нет
    const have = new Set(r.minute.map((p) => Math.floor(p[0] / 60000)));
    let added = 0;
    for (const m of d.metrics) {
      if (m.cpu == null) continue;
      const k = Math.floor(m.t / 60000);
      if (have.has(k)) continue;
      have.add(k); added++;
      r.minute.push([k * 60000, m.cpu, m.mem || 0, m.load || 0, m.rx || 0, m.tx || 0]);
    }
    if (added) {
      const cut = Date.now() - 24 * 3600e3;
      r.minute = r.minute.filter((p) => p[0] >= cut).sort((a, b) => a[0] - b[0]).slice(-HIST_MIN_POINTS);
      markHist();
    }
    if (d.metrics.length) s.agentSync.m = Math.floor(d.metrics[d.metrics.length - 1].t / 1000);
    if (d.events.length) {
      s.agentSync.e = Math.floor(d.events[d.events.length - 1].t / 1000);
      s.agentEvents = s.agentEvents.concat(d.events).slice(-200);
      const bad = d.events.filter((e) => e.sev === 'warn' || e.sev === 'crit');
      if (!r.agentSynced && bad.length) {
        try { D.notify(s, 'warn', 'Пока редактор был закрыт: событий {0}, последнее — {1}', [bad.length, bad[bad.length - 1].text]); } catch (_) {}
      }
    }
    r.agentSynced = true;
    persist();
    D.broadcast('servers:update', { server: pub(s) });
  } finally { r.agentBusy = false; }
}
function agentConf(s) { const r = R(s.id); return { engines: r.engines, disk: s.thresholds.disk, mem: s.thresholds.mem, load: s.thresholds.load }; }
async function agentInstall(s) {
  const r = R(s.id);
  if (!r.os) throw new Error('Сервер ещё не опрошен — подождите первый полный опрос');
  const res = await D.rhApi.execPooled(s.rhId, 'sh -s', 120000, agent.installScript(agentConf(s)));
  if (!res.ok) throw new Error(res.error || 'установка не выполнилась');
  const out = (res.stdout || '') + (res.stderr || '');
  const m = /MODE=(\w+)/.exec(out);
  if (!m) throw new Error((/ERR=(.*)/.exec(out) || [])[1] || out.trim().split('\n').slice(-2).join(' · ') || 'код ' + res.code);
  D.log('info', 'servers', `${s.name}: агент установлен (${m[1]})`);
  r.want.add('slow'); setTimeout(() => runProbe(s, ['fast', 'slow']), 300);
  return { ok: true, mode: m[1] };
}
async function agentUninstall(s) {
  const res = await D.rhApi.execPooled(s.rhId, 'sh -s', 60000, agent.UNINSTALL);
  if (!res.ok) throw new Error(res.error || 'удаление не выполнилось');
  if (!/^OK/m.test(res.stdout || '')) throw new Error(((/ERR=(.*)/.exec(res.stdout || '') || [])[1]) || 'удаление не подтвердилось');
  const r = R(s.id); r.agent = { installed: false };
  s.agentSync = { m: 0, e: 0 }; persist();
  D.log('info', 'servers', `${s.name}: агент удалён`);
  D.broadcast('servers:update', { server: pub(s) });
  return { ok: true };
}
function dueSections(s, r, now) {
  const open = windowOpen();
  const focus = focusOf(s.id);
  const secs = [];
  if (now - r.tFast >= (open ? s.pollFastSec : s.bgFastSec) * 1000) secs.push('fast');
  if (r.want.has('slow') || now - r.tSlow >= s.pollSlowSec * 1000) secs.push('slow');
  const ctrEvery = focus === 'containers' ? 15000 : (open ? 60000 : s.pollSlowSec * 1000);
  if (r.engines.length || r.want.has('ctr') || !r.tCtr) { if (r.want.has('ctr') || now - r.tCtr >= ctrEvery) secs.push('ctr'); }
  const unitsEvery = focus === 'services' ? 60000 : s.pollSlowSec * 1000;
  if (r.want.has('units') || now - r.tUnits >= unitsEvery) secs.push('units');
  if (r.want.has('pkg') || now - r.tPkg >= PKG_EVERY) secs.push('pkg');
  if (r.want.has('net') || now - r.tNet >= (focus === 'network' ? 60000 : s.pollSlowSec * 1000)) secs.push('net');
  // хост лежит: не собираем тяжёлое впустую — только fast (пул сам держит паузу между попытками)
  if (r.state !== 'online' && r.state !== 'unknown') return secs.includes('fast') ? ['fast'] : [];
  // любая проба несёт и fast: счётчики «N замеров подряд» в правилах считаются по пробам
  if (secs.length && !secs.includes('fast')) secs.unshift('fast');
  return secs;
}
function tick() {
  const now = Date.now();
  for (const s of servers) {
    if (!s.enabled) continue;
    const r = R(s.id);
    if (r.checking) continue;
    const secs = dueSections(s, r, now);
    if (secs.length) runProbe(s, secs);
  }
}

// ---------------------------------------------------------------- публичное представление
function pub(s) {
  const r = R(s.id);
  const pool = D.rhApi.poolState(s.rhId);
  const conn = D.rhApi.findConn(s.rhId);
  const now = Date.now();
  const ctr = r.containers || null;
  return {
    ...s, seen: undefined,
    host: conn ? { host: conn.host, port: conn.port || 22, user: conn.user || '', name: conn.name || '', type: conn.type || 'ssh' } : null,
    state: s.enabled ? (conn ? r.state : 'noprofile') : 'disabled', error: r.error, lastOk: r.lastOk, lastTry: r.lastTry, checking: r.checking,
    pool: pool ? pool.state : 'idle', retryAt: pool && pool.retryAt ? pool.retryAt : 0,
    os: r.os, ips: r.ips, live: r.live, disks: r.disks, failed: r.failed, reboot: r.reboot, pkg: r.pkg, engines: r.engines,
    containers: ctr, ctrAt: r.ctrAt, ctrState: r.ctrState,
    unitsAt: r.unitsAt,
    issues: [...r.issues.values()].map((i) => ({ ...i, muted: s.muted[i.key] > now ? s.muted[i.key] : 0 })),
    spark: sparkOf(r),
    tools: r.tools, netAt: r.netAt,
    net: r.net2 ? model.buildNetMap(r.net2, r.containers, s.ipLabels) : null,
    projects: projectsOf(s, r),
    sites: sitesOf(s).map((t) => ({ id: t.id, name: t.name, url: t.url, state: model.siteState(t), checks: (t.checks || []).length })),
    certs: r.certs, certAt: r.tCert,
    agent: r.agent ? { ...r.agent, stale: !!(r.agent.installed && r.agent.last && Date.now() - r.agent.last > 5 * 60 * 1000) } : null,
    agentVersion: agent.AGENT_VERSION,
    agentEvents: s.agentEvents.slice(-60),
    agentSync: undefined,
  };
}
function sitesOf(s) { try { return (D.getSites ? D.getSites() : []).filter((t) => t.serverId === s.id); } catch (_) { return []; } }
function allSites() { try { return D.getSites ? D.getSites() : []; } catch (_) { return []; } }
function projectsOf(s, r) {
  if (!r.containers && !r.net2 && !Object.keys(s.projects || {}).length) return null;
  return model.buildProjects({ containers: r.containers || [], net: r.net2, sites: allSites(), certs: r.certs, overrides: s.projects, units: r.units });
}
function fmtDate(ts) { try { return new Date(ts).toISOString().slice(0, 10); } catch (_) { return '?'; } }

// ---------------------------------------------------------------- TLS-сертификаты доменов
// Проверяем С ЭТОЙ машины (как браузер посетителя): tls.connect с SNI, срок из сертификата. Ошибка
// подключения — не проблема сервера (домен мог уйти на другой хост), просто показывается в проекте.
function certOf(domain) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(v); } };
    const sock = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = sock.getPeerCertificate();
      if (!c || !c.valid_to) return fin({ error: 'нет сертификата', at: Date.now() });
      const validTo = Date.parse(c.valid_to);
      fin({ validTo, days: Math.floor((validTo - Date.now()) / 86400000), issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '', trusted: !!sock.authorized, trustError: sock.authorized ? '' : String(sock.authorizationError || ''), at: Date.now() });
    });
    sock.on('timeout', () => fin({ error: 'таймаут', at: Date.now() }));
    sock.on('error', (e) => fin({ error: String((e && e.code) || (e && e.message) || e), at: Date.now() }));
  });
}
async function checkCerts(s, force) {
  const r = R(s.id);
  if (r.certBusy) return;
  r.certBusy = true; r.tCert = Date.now();
  try {
    const ps = projectsOf(s, r) || [];
    const doms = [...new Set(ps.flatMap((p) => p.domains))].filter((d) => !d.startsWith('*.')).slice(0, 150);
    const next = {};
    let i = 0;
    const worker = async () => { while (i < doms.length) { const d = doms[i++]; next[d] = await certOf(d); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    r.certs = next;
  } finally { r.certBusy = false; }
  evalIssues(s, r, false);
  D.broadcast('servers:update', { server: pub(s) });
}

// ---------------------------------------------------------------- действия (белый список)
const ENG_CMD = { docker: 'docker', podman: 'podman', sudodocker: 'sudo -n docker', sudopodman: 'sudo -n podman' };
const BAD_ID = (id) => typeof id !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/.test(id);
const BAD_UNIT = (u) => typeof u !== 'string' || !/^[A-Za-z0-9][\w@.:\\-]{0,200}\.(service|timer|socket|mount|target|path)$/.test(u);
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function srv(id) { const s = servers.find((x) => x.id === id); if (!s) throw new Error('Сервер не найден'); return s; }
async function exec(s, cmd, timeout) {
  const r = await D.rhApi.execPooled(s.rhId, cmd, timeout || 30000);
  if (!r.ok) throw new Error(r.error || 'команда не выполнилась');
  return r;
}
function engOf(s, engine) {
  const r = R(s.id);
  if (!ENG_CMD[engine] || !r.engines.includes(engine)) throw new Error('Неизвестный движок контейнеров');
  return ENG_CMD[engine];
}
async function ctrAction(s, { engine, ctrId, action }) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Неизвестное действие');
  if (BAD_ID(ctrId)) throw new Error('Некорректный id контейнера');
  const r = await exec(s, `${engOf(s, engine)} ${action} ${ctrId} 2>&1`, 90000);
  if (r.code !== 0) throw new Error((r.stdout || r.stderr || '').trim().split('\n').pop() || 'код ' + r.code);
  R(s.id).want.add('ctr'); setTimeout(() => runProbe(s, ['fast', 'ctr']), 300);
  return { ok: true };
}
async function ctrLogs(s, { engine, ctrId, tail }) {
  if (BAD_ID(ctrId)) throw new Error('Некорректный id контейнера');
  const n = clampInt(tail, 10, 5000, 300);
  const r = await exec(s, `${engOf(s, engine)} logs --tail ${n} --timestamps ${ctrId} 2>&1`, 30000);
  return { ok: true, text: r.stdout, truncated: r.stdout.length >= 512 * 1024 - 16 };
}
function sudoFree(s) { const r = R(s.id); return !!(r.os && r.os.sudo === 'free'); }
async function unitAction(s, { unit, user, action }) {
  if (!['start', 'stop', 'restart', 'reload'].includes(action)) throw new Error('Неизвестное действие');
  if (BAD_UNIT(unit)) throw new Error('Некорректное имя юнита');
  if (user) {
    const r = await exec(s, `systemctl --user ${action} ${unit} 2>&1`, 90000);
    if (r.code !== 0) throw new Error(r.stdout.trim() || 'код ' + r.code);
  } else {
    const r = await D.rhApi.sudoPooled(s.rhId, `systemctl ${action} ${unit}`, 90000);
    if (!r.ok) throw new Error(r.error || 'sudo не выполнился');
  }
  const rr = R(s.id); rr.want.add('units'); rr.want.add('slow'); setTimeout(() => runProbe(s, ['fast', 'slow', 'units']), 300);
  return { ok: true };
}
async function unitStatus(s, { unit, user }) {
  if (BAD_UNIT(unit)) throw new Error('Некорректное имя юнита');
  const r = await exec(s, `systemctl ${user ? '--user ' : ''}status --no-pager --full -n 20 ${unit} 2>&1`, 20000);
  return { ok: true, text: r.stdout };
}
async function journal(s, { unit, user, lines, priority, since }) {
  const n = clampInt(lines, 20, 5000, 300);
  const parts = ['journalctl', '--no-pager', '-o short-iso', '-n ' + n];
  if (user) parts.splice(1, 0, '--user');
  if (unit) { if (BAD_UNIT(unit)) throw new Error('Некорректное имя юнита'); parts.push('-u ' + unit); }
  if (priority) { if (!/^(emerg|alert|crit|err|warning|notice|info|debug)$/.test(priority)) throw new Error('Некорректный приоритет'); parts.push('-p ' + priority); }
  if (since) { if (!/^[\w :.-]{1,40}$/.test(since)) throw new Error('Некорректное «с какого времени»'); parts.push('--since ' + sq(since)); }
  const cmd = parts.join(' ');
  // системный журнал целиком видит только root/adm: при свободном sudo читаем через него
  const full = !user && sudoFree(s) ? `sudo -n ${cmd} 2>&1 || ${cmd} 2>&1` : `${cmd} 2>&1`;
  const r = await exec(s, full, 30000);
  return { ok: true, text: r.stdout };
}
async function du(s, { dir, sudo }) {
  const p = String(dir || '/');
  if (!p.startsWith('/') || /[\0\n\r]/.test(p) || p.length > 1024) throw new Error('Нужен абсолютный путь');
  if (sudo && !sudoFree(s)) throw new Error('sudo без пароля на сервере недоступен');
  const cmd = `${sudo ? 'sudo -n ' : ''}timeout 120 du -xk --max-depth=1 -- ${sq(p)} 2>/dev/null | sort -rn | head -80`;
  const r = await exec(s, cmd, 130000);
  const rows = [];
  for (const l of r.stdout.split('\n')) { const m = /^(\d+)\s+(.+)$/.exec(l.trim()); if (m) rows.push({ size: Number(m[1]) * 1024, path: m[2] }); }
  if (!rows.length) throw new Error('Каталог не прочитан (нет прав или не существует)');
  return { ok: true, dir: p, rows };
}
async function engineDf(s, { engine }) {
  const r = await exec(s, `${engOf(s, engine)} system df 2>&1`, 60000);
  return { ok: true, text: r.stdout };
}
async function reboot(s) {
  const r = await D.rhApi.sudoPooled(s.rhId, 'systemctl reboot', 30000);
  // соединение рвётся вместе с перезагрузкой — «обрыв» тут и есть успех
  if (!r.ok && !/закрыто|ECONNRESET|closed|EOF/i.test(r.error || '')) throw new Error(r.error || 'sudo не выполнился');
  R(s.id).want.add('slow');
  return { ok: true };
}

// ---------------------------------------------------------------- сеть: исходящий адрес, подписи адресов
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;
async function egress(s, { ip }) {
  if (ip && !IP_RE.test(String(ip))) throw new Error('Некорректный адрес');
  const via = ip ? `--interface ${ip} ` : '';
  // внешний адрес, с которым сервер ходит наружу (с этого адреса/интерфейса); ipify — без ключей и логина
  const cmd = `curl -s --max-time 8 ${via}https://api64.ipify.org 2>&1 || wget -qO- --timeout=8 ${ip ? '--bind-address=' + ip + ' ' : ''}https://api64.ipify.org 2>&1`;
  const r = await exec(s, cmd, 20000);
  const out = (r.stdout || '').trim().split('\n').pop();
  if (!IP_RE.test(out)) throw new Error(out || 'нет ответа (нет curl/wget или нет выхода в интернет)');
  return { ok: true, ip: out };
}
function setIpLabel(s, { ip, label }) {
  if (!IP_RE.test(String(ip || ''))) throw new Error('Некорректный адрес');
  const l = String(label || '').trim().slice(0, 40);
  if (l) s.ipLabels[ip] = l; else delete s.ipLabels[ip];
  persist(); D.broadcast('servers:update', { server: pub(s) });
  return { ok: true };
}

// ---------------------------------------------------------------- проекты
const DOMAIN_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
// Ручные правки проекта: имя, заметки, скрыть, дополнительные домены/каталоги/юниты; manual:true + new — новый ручной
function projectSave(s, { key, patch, remove }) {
  let k = String(key || '');
  if (!k && patch && patch.manual) k = 'm:' + Date.now().toString(36);
  if (!/^[a-z]:[\w:@./-]{1,300}$/.test(k)) throw new Error('Некорректный ключ проекта');
  if (remove) { delete s.projects[k]; persist(); D.broadcast('servers:update', { server: pub(s) }); return { ok: true }; }
  const prev = s.projects[k] || {};
  const x = patch || {};
  const list = (v, re) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((y) => String(y).trim()).filter((y) => y && re.test(y)).slice(0, 60);
  const rec = { ...prev };
  if (x.title != null) rec.title = String(x.title).trim().slice(0, 80);
  if (x.notes != null) rec.notes = String(x.notes).slice(0, 4000);
  if (x.hidden != null) rec.hidden = !!x.hidden;
  if (x.domains != null) rec.domains = list(x.domains, DOMAIN_RE).map((d) => d.toLowerCase());
  if (x.dirs != null) rec.dirs = list(x.dirs, /^\/[^\0\n]{0,500}$/);
  if (x.units != null) rec.units = list(x.units, /^[A-Za-z0-9][\w@.:-]{0,200}$/);
  s.projects[k] = rec;
  persist(); D.broadcast('servers:update', { server: pub(s) });
  if (rec.domains && rec.domains.length) setTimeout(() => checkCerts(s, true), 200);
  return { ok: true, key: k };
}
const SAFE_NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;
const SAFE_FILE = /^(?!-)(?!.*\.\.)[\w./@+-]{1,255}$/;
function findProject(s, key) {
  const p = (projectsOf(s, R(s.id)) || []).find((x) => x.key === key);
  if (!p) throw new Error('Проект не найден — обновите данные сервера');
  return p;
}
// compose проекта: тем же инструментом, что создал контейнеры, из его каталога, с его файлами
function composeBase(s, p) {
  if (p.kind !== 'compose') throw new Error('Действие доступно только для compose-проектов');
  const t = R(s.id).tools || {};
  const sudo = p.engine.startsWith('sudo') ? 'sudo -n ' : '';
  let bin = null;
  if (p.engine.endsWith('podman')) bin = t.podmanCompose ? 'podman-compose' : null;
  else bin = t.composePlugin ? 'docker compose' : t.dockerCompose ? 'docker-compose' : null;
  if (!bin) throw new Error(p.engine.endsWith('podman') ? 'На сервере нет podman-compose' : 'На сервере нет docker compose');
  if (!p.workdir || !p.workdir.startsWith('/') || /[\0\n\r]/.test(p.workdir)) throw new Error('Неизвестен каталог проекта (метка compose working_dir)');
  if (!SAFE_NAME.test(p.project)) throw new Error('Некорректное имя проекта');
  const files = p.files.filter((f) => SAFE_FILE.test(f));
  return { base: `cd ${sq(p.workdir)} && ${sudo}${bin} -p ${sq(p.project)}${files.map((f) => ' -f ' + sq(f)).join('')}`, podman: bin === 'podman-compose' };
}
function projectCommand(s, { key, action }) {
  const p = findProject(s, key);
  const { base, podman } = composeBase(s, p);
  // обновление: podman-compose без --force-recreate не пересоздаёт контейнеры — новые образы не подхватятся
  const cmds = { restart: `${base} restart`, stop: `${base} stop`, start: `${base} start`,
    update: `${base} pull && ${base} up -d${podman ? ' --force-recreate' : ''}` };
  if (!cmds[action]) throw new Error('Неизвестное действие');
  return { ok: true, cmd: cmds[action], project: p.title || p.name, workdir: p.workdir };
}
async function projectAction(s, { key, action }) {
  const { cmd } = projectCommand(s, { key, action });
  D.log('info', 'servers', `${s.name}: проект ${key} → ${action}`);
  const r = await exec(s, `${cmd} 2>&1`, action === 'update' ? 20 * 60 * 1000 : 5 * 60 * 1000);
  const rr = R(s.id); rr.want.add('ctr'); rr.want.add('net'); setTimeout(() => runProbe(s, ['fast', 'ctr', 'net']), 500);
  return { ok: r.code === 0, code: r.code, text: r.stdout, error: r.code === 0 ? '' : ((r.stdout || '').trim().split('\n').slice(-3).join(' · ') || 'код ' + r.code) };
}
async function projectLogs(s, { key, tail }) {
  const p = findProject(s, key);
  if (!p.containers.length) throw new Error('У проекта нет контейнеров');
  const n = clampInt(tail, 10, 2000, 200);
  const parts = [];
  for (const c of p.containers) {
    if (BAD_ID(c.id) || !SAFE_NAME.test(c.service || c.name)) continue;
    parts.push(`${ENG_CMD[c.engine]} logs --tail ${n} --timestamps ${c.id} 2>&1 | sed 's/^/[${c.service || c.name}] /'`);
  }
  const r = await exec(s, parts.join('; '), 60000);
  // склеить по времени: «[svc] 2026-11-02T12:00:00.123Z текст»
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => { const m = /^\[[^\]]+\] (\d{4}-\d\d-\d\dT[\d:.]+)/.exec(l); return [m ? m[1] : '', l]; });
  lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { ok: true, text: lines.map((x) => x[1]).join('\n') };
}

// ---------------------------------------------------------------- IPC
function register(deps) {
  D = deps;
  load(); loadHist();
  const { ipcMain } = D;
  const wrap = (fn) => async (_e, a = {}) => { try { return await fn(srv(a.id), a); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } };

  ipcMain.handle('servers:list', () => ({ ok: true, servers: servers.map(pub) }));
  ipcMain.handle('servers:save', (_e, { server } = {}) => {
    if (!server || typeof server !== 'object') return { ok: false, error: 'нет данных сервера' };
    const conn = D.rhApi.findConn(server.rhId);
    if (!conn) return { ok: false, error: 'SSH-профиль не найден' };
    if (conn.type === 'ftp') return { ok: false, error: 'Нужен SSH-профиль: по FTP сервер не опросить' };
    const idx = server.id ? servers.findIndex((x) => x.id === server.id) : -1;
    const rec = sanitize(server, idx >= 0 ? servers[idx] : null);
    if (!rec.name) rec.name = conn.name || conn.host;
    if (idx >= 0) {
      const rhChanged = servers[idx].rhId !== rec.rhId;
      servers[idx] = rec;
      if (rhChanged) rt.delete(rec.id); // другой хост — прежние замеры и проблемы не про него
    } else servers.push(rec);
    persist();
    D.broadcast('servers:list', { servers: servers.map(pub) });
    if (rec.enabled) { const r = R(rec.id); r.want.add('slow'); r.want.add('ctr'); setTimeout(() => runProbe(rec, ['fast', 'slow', 'ctr']), 50); }
    // пороги поменялись — агенту тоже (без переустановки)
    { const r = rt.get(rec.id); if (r && r.agent && r.agent.installed) D.rhApi.execPooled(rec.rhId, 'sh -s', 30000, agent.confScript(agentConf(rec))).catch(() => {}); }
    return { ok: true, id: rec.id };
  });
  ipcMain.handle('servers:remove', (_e, { id } = {}) => {
    servers = servers.filter((x) => x.id !== id); rt.delete(id); persist(); histDirty = true; flushHist();
    D.broadcast('servers:list', { servers: servers.map(pub) });
    return { ok: true };
  });
  ipcMain.handle('servers:reorder', (_e, { ids } = {}) => {
    if (!Array.isArray(ids)) return { ok: false, error: 'нет порядка' };
    const pos = new Map(ids.map((x, i) => [x, i]));
    servers.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
    persist(); return { ok: true };
  });
  // Обновить: level — 'all' (всё сразу) или конкретная секция
  ipcMain.handle('servers:refresh', (_e, { id, level } = {}) => {
    const list = id ? servers.filter((x) => x.id === id) : servers.filter((x) => x.enabled);
    const secs = level === 'units' ? ['fast', 'units'] : level === 'ctr' ? ['fast', 'ctr'] : level === 'pkg' ? ['fast', 'pkg'] : ['fast', 'slow', 'ctr', 'units', 'pkg'];
    for (const s of list) { const r = R(s.id); for (const x of secs) if (x !== 'fast') r.want.add(x); if (!r.checking) runProbe(s, secs); }
    return { ok: true };
  });
  ipcMain.handle('servers:history', (_e, { id } = {}) => { const r = rt.get(id); return { ok: true, fast: r ? r.hist : [], minute: r ? r.minute : [] }; });
  ipcMain.handle('servers:units', (_e, { id } = {}) => { const r = rt.get(id); return { ok: true, units: r ? r.units : null, timers: r ? r.timers : null, at: r ? r.unitsAt : 0 }; });
  ipcMain.handle('servers:mute', (_e, { id, key, hours } = {}) => {
    const s = servers.find((x) => x.id === id); if (!s) return { ok: false, error: 'Сервер не найден' };
    const h = Number(hours);
    if (h > 0) s.muted[String(key)] = Date.now() + Math.min(h, 24 * 365) * 3600 * 1000; else delete s.muted[String(key)];
    persist(); D.broadcast('servers:update', { server: pub(s) });
    return { ok: true };
  });
  // Окно открыто/закрыто и что в нём в фокусе (сервер + вкладка) — частота опроса
  ipcMain.handle('servers:subscribe', (e, { focus } = {}) => {
    const wc = e.sender; const had = subs.has(wc.id);
    subs.set(wc.id, { wc, focus: focus || null });
    if (!had) { try { wc.once('destroyed', () => subs.delete(wc.id)); } catch (_) {} }
    if (focus && focus.id) {
      const s = servers.find((x) => x.id === focus.id);
      if (s && s.enabled) {
        const r = R(s.id);
        if (focus.tab === 'services' && !r.units) r.want.add('units');
        if (focus.tab === 'containers' && Date.now() - r.tCtr > 15000) r.want.add('ctr');
      }
    }
    tick();
    return { ok: true };
  });
  ipcMain.handle('servers:unsubscribe', (e) => { subs.delete(e.sender.id); return { ok: true }; });
  ipcMain.handle('servers:ctrAction', wrap(ctrAction));
  ipcMain.handle('servers:ctrLogs', wrap(ctrLogs));
  ipcMain.handle('servers:unitAction', wrap(unitAction));
  ipcMain.handle('servers:unitStatus', wrap(unitStatus));
  ipcMain.handle('servers:journal', wrap(journal));
  ipcMain.handle('servers:du', wrap(du));
  ipcMain.handle('servers:engineDf', wrap(engineDf));
  ipcMain.handle('servers:reboot', wrap(reboot));
  ipcMain.handle('servers:egress', wrap(egress));
  ipcMain.handle('servers:ipLabel', wrap(setIpLabel));
  ipcMain.handle('servers:projectSave', wrap(projectSave));
  ipcMain.handle('servers:projectCommand', wrap(projectCommand));
  ipcMain.handle('servers:projectAction', wrap(projectAction));
  ipcMain.handle('servers:projectLogs', wrap(projectLogs));
  ipcMain.handle('servers:agentInstall', wrap(agentInstall));
  ipcMain.handle('servers:agentUninstall', wrap(agentUninstall));
  ipcMain.handle('servers:agentSync', wrap(async (s) => { await agentSync(s); return { ok: true }; }));
  ipcMain.handle('servers:certCheck', wrap(async (s) => { await checkCerts(s, true); return { ok: true }; }));

  const timer = setInterval(tick, 5000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 3000); // первый опрос — когда редактор уже поднялся
  // «Мониторинг сайтов» что-то перепроверил — пересчитать проблемы серверов с привязанными сайтами
  let sitesT = null;
  const sitesChanged = () => {
    clearTimeout(sitesT);
    sitesT = setTimeout(() => {
      for (const s of servers) { const r = rt.get(s.id); if (!r) continue; evalIssues(s, r, false); D.broadcast('servers:update', { server: pub(s) }); }
    }, 500);
  };
  return { flush: flushHist, fmt, sitesChanged, list: () => servers.map((s) => ({ id: s.id, name: s.name })) };
}

module.exports = { register, _internals: { sanitize, evalIssues, applyProbe, dueSections, R, pub, BAD_ID, BAD_UNIT, sq, classify } };
