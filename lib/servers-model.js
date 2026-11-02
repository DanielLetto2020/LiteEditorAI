// «Серверы»: чистые построители поверх снимка пробы — карта сети (этап «Сеть») и проекты на сервере
// (этап «Проекты»). Без ввода-вывода: вход — данные lib/servers-probe.js и конфиг сервера, выход —
// то, что рисует окно. Поэтому всё здесь проверяется на сохранённых выводах пробы.
'use strict';

const PROXY_PROC = /^(traefik|nginx|caddy|haproxy|envoy|apache2|httpd)$/;
const FWD_PROC = /^(rootlessport|docker-proxy|conmon|slirp4netns|pasta|containerd|dockerd|podman)$/;
const PROXY_IMG = /traefik|nginx|caddy|haproxy|envoy/i;

// ---------------------------------------------------------------- сеть
// Кто стоит за слушающим портом: процесс; для форвардеров движка (rootlessport/docker-proxy) — контейнер с
// опубликованным портом; для входного прокси (80/443) — все домены, которые он раздаёт.
function buildNetMap(net, containers, ipLabels) {
  if (!net) return null;
  const ctrs = containers || [];
  const byPort = new Map();
  for (const c of ctrs) for (const p of c.ports || []) {
    for (let i = 0; i < Math.max(1, p.range || 1); i++) {
      const k = (p.proto || 'tcp') + '|' + (p.hostPort + i);
      if (!byPort.has(k)) byPort.set(k, []);
      byPort.get(k).push({ c, hostIp: p.hostIp || '' });
    }
  }
  const proxyDomains = domainsTable(net, ctrs);
  const proxyCtrDomains = (c) => (c && PROXY_IMG.test(c.image) ? proxyDomains.map((d) => d.domain) : []);
  const rows = (net.listen || []).map((l) => {
    const cand = byPort.get(l.proto + '|' + l.port) || [];
    const hit = cand.find((x) => x.hostIp === l.ip) || cand.find((x) => !x.hostIp) || cand[0] || null;
    const c = hit && (l.procs.some((p) => FWD_PROC.test(p)) || !l.procs.length) ? hit.c : null;
    const isProxy = l.procs.some((p) => PROXY_PROC.test(p)) || (c && PROXY_IMG.test(c.image));
    const domains = isProxy && (l.port === 80 || l.port === 443 || l.port === 8443) ? (c ? proxyCtrDomains(c) : proxyDomains.map((d) => d.domain)) : (c ? c.domains || [] : []);
    return {
      proto: l.proto, ip: l.ip, port: l.port, procs: l.procs, loopback: l.loopback,
      scope: l.ip === '' ? 'all' : l.loopback ? 'loopback' : 'addr',
      container: c ? { name: c.name, project: c.project, service: c.service, engine: c.engine, id: c.id } : null,
      domains: [...new Set(domains)], proxy: !!isProxy,
    };
  }).sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  // группировка по адресу: «все адреса» первыми, затем внешние, затем loopback
  const groups = new Map();
  for (const r of rows) { const k = r.ip || '*'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const order = [...groups.keys()].sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : 0) || (/^(127\.|::1)/.test(a) ? 1 : 0) - (/^(127\.|::1)/.test(b) ? 1 : 0) || a.localeCompare(b));
  const fwOpen = firewallOpenPorts(net.fw);
  const exposed = rows.filter((r) => r.scope === 'all' && !r.loopback).map((r) => ({ ...r, fwAllowed: fwOpen ? fwOpen.has(r.proto + '/' + r.port) || fwOpen.has('*') : null }));
  return {
    groups: order.map((k) => ({ ip: k === '*' ? '' : k, label: k !== '*' && ipLabels ? ipLabels[k] || '' : '', rows: groups.get(k) })),
    exposed, domains: proxyDomains,
    ifaces: net.ifaces || [], routes: net.routes || [], rules: net.rules || [], fw: net.fw || null,
    policyRouting: (net.rules || []).some((r) => r.custom) || (net.routes || []).some((r) => r.table && !['main', 'local', 'default'].includes(String(r.table))),
  };
}
// порты, открытые фаерволом наружу (ufw): '*' — политика по умолчанию allow; null — неизвестно
function firewallOpenPorts(fw) {
  if (!fw || fw.kind !== 'ufw') return null;
  if (fw.active === false) return new Set(['*']);
  if (/Default:\s*allow \(incoming\)/i.test(fw.text || '')) return new Set(['*']);
  const set = new Set();
  for (const r of fw.rules || []) {
    if (!/^ALLOW/.test(r.action)) continue;
    const m = /^(\d+)(?::(\d+))?(?:\/(tcp|udp))?/.exec(r.to); if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let p = a; p <= b && p - a < 2000; p++) { if (!m[3] || m[3] === 'tcp') set.add('tcp/' + p); if (!m[3] || m[3] === 'udp') set.add('udp/' + p); }
  }
  return set;
}
// Домен → куда ведёт: метки traefik у контейнеров, server_name nginx, сайты Caddy
function domainsTable(net, containers) {
  const out = [];
  for (const c of containers || []) for (const d of c.domains || []) out.push({ domain: d, via: 'traefik', target: c.service || c.name, project: c.project || '', container: c.name });
  for (const p of (net && net.proxies) || []) for (const d of p.domains) {
    out.push({ domain: d, via: p.kind, target: p.proxies[0] || p.roots[0] || '', project: '', file: p.file, root: p.roots[0] || '' });
  }
  const seen = new Set();
  return out.filter((x) => { const k = x.domain + '|' + x.via + '|' + x.target; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

// ---------------------------------------------------------------- проекты
// Проект = compose-проект (метка com.docker.compose.project), отдельный контейнер или сайт прокси (nginx/Caddy:
// статика или проксирование на процесс без контейнера), плюс ручные. Ручные правки (имя, заметки, скрыть,
// дополнительные домены/каталоги/юниты) — по ключу в конфиге сервера (projects[key]).
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; } }
function buildProjects({ containers, net, sites, certs, overrides, units }) {
  const ov = overrides || {};
  const map = new Map();
  const add = (key, base) => { if (!map.has(key)) map.set(key, { key, ...base, containers: [], domains: [], dirs: [], units: [], ports: [], files: [] }); return map.get(key); };
  for (const c of containers || []) {
    let p;
    if (c.project) p = add('c:' + c.engine + ':' + c.project, { kind: 'compose', name: c.project, engine: c.engine, project: c.project });
    else if (c.pod) p = add('p:' + c.engine + ':' + c.pod, { kind: 'pod', name: c.pod, engine: c.engine });
    else p = add('s:' + c.engine + ':' + c.name, { kind: 'container', name: c.name, engine: c.engine });
    p.containers.push(c);
    for (const d of c.domains || []) if (!p.domains.includes(d)) p.domains.push(d);
    if (c.workdir && !p.dirs.includes(c.workdir)) p.dirs.push(c.workdir);
    if (c.workdir && !p.workdir) p.workdir = c.workdir;
    for (const f of c.configFiles || []) if (!p.files.includes(f)) p.files.push(f);
    if (c.unit && !p.labelUnits) p.labelUnits = [];
    if (c.unit && !p.labelUnits.includes(c.unit)) p.labelUnits.push(c.unit);
    for (const pp of c.ports || []) p.ports.push({ ...pp, container: c.service || c.name });
  }
  // сайты прокси (nginx/Caddy), не ведущие в известный контейнер: статика или процесс на хосте
  const known = new Set([...map.values()].flatMap((p) => p.domains));
  for (const px of (net && net.proxies) || []) {
    const doms = px.domains.filter((d) => !known.has(d));
    if (!doms.length) continue;
    const p = add('x:' + px.kind + ':' + px.file + ':' + doms[0], { kind: px.root || px.roots.length ? 'static' : 'proxy', name: doms[0], via: px.kind, file: px.file });
    p.domains.push(...doms); p.dirs.push(...px.roots); p.target = px.proxies[0] || '';
  }
  // ручные проекты
  for (const [key, o] of Object.entries(ov)) if (key.startsWith('m:') && o && !map.has(key)) add(key, { kind: 'manual', name: o.title || 'Проект' });
  const unitState = new Map((units || []).map((u) => [(u.user ? 'u:' : 's:') + u.unit, u]));
  // юнит из метки PODMAN_SYSTEMD_UNIT показываем, только если он правда есть: podman-compose пишет метку,
  // даже когда юнит не создан, и контейнеры поднимает podman-restart — иначе в проекте висел бы несуществующий юнит
  for (const p of map.values()) {
    for (const u of p.labelUnits || []) if ((unitState.has('u:' + u) || unitState.has('s:' + u)) && !p.units.includes(u)) p.units.push(u);
    delete p.labelUnits;
  }
  const out = [];
  for (const p of map.values()) {
    const o = ov[p.key] || {};
    if (o.title) p.title = o.title;
    p.notes = o.notes || '';
    p.hidden = !!o.hidden;
    for (const d of o.domains || []) if (!p.domains.includes(d)) p.domains.push(d);
    for (const d of o.dirs || []) if (!p.dirs.includes(d)) p.dirs.push(d);
    for (const u of o.units || []) if (!p.units.includes(u)) p.units.push(u);
    p.unitInfo = p.units.map((u) => ({ unit: u, state: (unitState.get('u:' + u) || unitState.get('s:' + u) || null) })).map((x) => ({ unit: x.unit, active: x.state ? x.state.active : null, sub: x.state ? x.state.sub : null, user: x.state ? x.state.user : null }));
    const run = p.containers.filter((c) => c.state === 'running').length;
    const bad = p.containers.filter((c) => c.health === 'unhealthy' || ((c.state === 'exited' || c.state === 'dead') && c.exitCode != null && ![0, 137, 143].includes(c.exitCode))).length;
    p.counts = { total: p.containers.length, running: run, bad };
    p.cpu = p.containers.reduce((a, c) => a + (c.cpu || 0), 0);
    p.mem = p.containers.reduce((a, c) => a + (c.mem || 0), 0);
    p.sites = (sites || []).filter((t) => p.domains.includes(hostOf(t.url))).map((t) => ({ id: t.id, name: t.name, url: t.url, state: siteState(t) }));
    p.certs = p.domains.map((d) => (certs && certs[d] ? { domain: d, ...certs[d] } : { domain: d })).filter(Boolean);
    p.status = statusOf(p);
    p.containers = p.containers.map((c) => ({ id: c.id, name: c.name, service: c.service, state: c.state, health: c.health, engine: c.engine, image: c.image }));
    out.push(p);
  }
  const rank = { bad: 0, warn: 1, partial: 2, ok: 3, stopped: 4, static: 5 };
  return out.sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0) || (rank[a.status] - rank[b.status]) || (a.title || a.name).localeCompare(b.title || b.name));
}
function siteState(t) {
  const st = (t.checks || []).map((c) => c.state);
  return st.includes('triggered') ? 'triggered' : st.includes('warn') ? 'warn' : st.includes('error') ? 'error' : st.includes('ok') ? 'ok' : 'unknown';
}
function statusOf(p) {
  if (p.counts.bad || p.sites.some((s) => s.state === 'triggered') || p.certs.some((c) => c.days != null && c.days < 3)) return 'bad';
  if (p.certs.some((c) => c.days != null && c.days < 14) || p.sites.some((s) => s.state === 'warn' || s.state === 'error')) return 'warn';
  if (!p.counts.total) return p.kind === 'manual' ? 'ok' : 'static';
  if (p.counts.running === p.counts.total) return 'ok';
  if (p.counts.running === 0) return 'stopped';
  return 'partial';
}

module.exports = { buildNetMap, buildProjects, domainsTable, firewallOpenPorts, siteState };
