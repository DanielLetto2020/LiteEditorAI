// «Серверы»: проба состояния хоста по SSH и разбор её вывода. Без установки на сервер: константный
// POSIX sh-скрипт уходит через stdin (`sh -s`) по постоянному соединению (rhApi.execPooled), на диск
// хоста ничего не пишется. Какие секции собрать — переменная LE_S («fast slow ctr units pkg»),
// какими движками контейнеров — LE_ENG (найденные прошлой медленной пробой; пусто → искать).
//
// Вывод — секции «@@имя» построчно; каждую разбирает своя чистая функция. Сломанная секция даёт
// { error } и не валит остальные: на хосте может не быть ss, systemd, apt, podman — пропускаются молча.
//
// Уровни (частоту задаёт lib/servers.js):
//   fast  — loadavg, /proc/stat, meminfo, net/dev, uptime, состояние контейнеров (имя/состояние)
//   slow  — ОС, диски (+inodes), упавшие юниты, нужна ли перезагрузка, адреса, движки контейнеров
//   ctr   — полный список контейнеров (порты, метки compose, рестарты, health) + stats
//   units — запущенные/упавшие сервисы systemd (система и пользователь)
//   pkg   — число обновлений пакетов (apt ~0.6 с — редко)
'use strict';

const ENGINES = ['docker', 'podman', 'sudodocker', 'sudopodman'];
const AGENT_STATUS = require('./servers-agent').STATUS_SH;

// ВНИМАНИЕ: только POSIX sh (на Ubuntu это dash). Никаких bash-измов: [[ ]], массивы, $'..', local -a.
const SCRIPT = String.raw`
export LC_ALL=C
S=" $LE_S "
has() { case "$S" in *" $1 "*) return 0;; esac; return 1; }
sec() { printf '\n@@%s\n' "$1"; }
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 10"
# зависший демон движка не должен держать всю пробу: каждый вызов — под timeout
eng() { e="$1"; shift; case "$e" in docker) $T docker "$@";; podman) $T podman "$@";; sudodocker) $T sudo -n docker "$@";; sudopodman) $T sudo -n podman "$@";; esac; }

ENGS="$LE_ENG"
if [ -z "$ENGS" ] || has slow; then
  ENGS=""
  # docker, за которым стоит podman (пакет podman-docker), — не второй движок: иначе контейнеры двоятся
  if command -v docker >/dev/null 2>&1 && ! docker --version 2>/dev/null | grep -qi podman; then
    if docker ps -q >/dev/null 2>&1; then ENGS="$ENGS docker"
    elif sudo -n docker ps -q >/dev/null 2>&1; then ENGS="$ENGS sudodocker"; fi
  fi
  if command -v podman >/dev/null 2>&1; then
    ENGS="$ENGS podman"
    if [ "$(id -u)" != 0 ] && sudo -n true >/dev/null 2>&1; then
      n=$(sudo -n podman ps -aq 2>/dev/null | wc -l); [ "$n" -gt 0 ] 2>/dev/null && ENGS="$ENGS sudopodman"
    fi
  fi
fi
sec engines; echo $ENGS
sec now; date +%s

if has fast; then
  sec uptime; cat /proc/uptime
  sec loadavg; cat /proc/loadavg
  sec cpu; grep '^cpu ' /proc/stat
  sec mem; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
  sec net; tail -n +3 /proc/net/dev
  for e in $ENGS; do
    sec "ctrstate:$e"; eng "$e" ps -a --format '{{.ID}}	{{.Names}}	{{.State}}	{{.Status}}' 2>&1
  done
fi

if has slow; then
  sec os; cat /etc/os-release 2>/dev/null; echo "KERNEL=$(uname -r)"; echo "HOSTNAME=$(hostname 2>/dev/null)"; echo "ARCH=$(uname -m)"
  echo "NPROC=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
  command -v systemd-detect-virt >/dev/null 2>&1 && echo "VIRT=$(systemd-detect-virt 2>/dev/null)"
  command -v sudo >/dev/null 2>&1 && { sudo -n true >/dev/null 2>&1 && echo "SUDO=free" || echo "SUDO=pass"; } || echo "SUDO=none"
  echo "USER=$(id -un)"
  sec df; $T df -PTk 2>/dev/null
  sec dfi; $T df -PTi 2>/dev/null
  if command -v systemctl >/dev/null 2>&1; then
    sec failed; systemctl --failed --no-legend --plain --no-pager 2>/dev/null
    sec failed_user; systemctl --user --failed --no-legend --plain --no-pager 2>/dev/null
  fi
  sec reboot; if [ -f /var/run/reboot-required ]; then echo yes; cat /var/run/reboot-required.pkgs 2>/dev/null; fi
  sec ips; ip -o addr show scope global 2>/dev/null
  # агент на сервере (этап 6): установлен ли, версия, режим запуска, последняя запись
  sec agent; ${AGENT_STATUS}
  # чем поднимать compose-проекты (этап «Проекты»)
  sec tools; command -v podman-compose docker-compose 2>/dev/null; docker compose version >/dev/null 2>&1 && echo docker-compose-plugin
fi

if has net; then
  SS="ss"; [ "$(id -u)" != 0 ] && sudo -n true >/dev/null 2>&1 && SS="sudo -n ss"   # процессы чужих сокетов видит только root
  sec addrj; ip -j addr 2>/dev/null
  sec routej; ip -j route 2>/dev/null
  sec route6j; ip -6 -j route 2>/dev/null
  sec rulej; ip -j rule 2>/dev/null
  sec listen; $SS -Hltnup 2>/dev/null || ss -Hltnu 2>/dev/null
  sec fw
  if command -v ufw >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then echo "@UFW"; sudo -n ufw status verbose 2>/dev/null; fi
  if command -v firewall-cmd >/dev/null 2>&1; then echo "@FIREWALLD"; firewall-cmd --state 2>&1; sudo -n firewall-cmd --list-all 2>/dev/null; fi
  echo "@NFT"; { sudo -n nft list tables 2>/dev/null || nft list tables 2>/dev/null; }
  sec nginx; grep -RHE '^[[:space:]]*(server_name|root|proxy_pass|listen)[[:space:]]' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -3000
  sec caddy; [ -r /etc/caddy/Caddyfile ] && head -3000 /etc/caddy/Caddyfile
fi

if has ctr; then
  for e in $ENGS; do
    case "$e" in
      *podman) sec "ctr:$e"; eng "$e" ps -a --format json 2>&1
               sec "stats:$e"; eng "$e" stats --no-stream --format json 2>/dev/null ;;
      *docker) sec "ctr:$e"; eng "$e" ps -a --no-trunc --format '{{json .}}' 2>&1
               sec "ctrinfo:$e"; ids=$(eng "$e" ps -aq 2>/dev/null); [ -n "$ids" ] && eng "$e" inspect --format '{{.Id}} {{.RestartCount}} {{.State.ExitCode}} {{.State.StartedAt}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $ids 2>/dev/null
               sec "stats:$e"; eng "$e" stats --no-stream --format '{{json .}}' 2>/dev/null ;;
    esac
  done
fi

if has units && command -v systemctl >/dev/null 2>&1; then
  sec units; systemctl list-units --type=service --no-legend --plain --no-pager 2>/dev/null
  sec units_user; systemctl --user list-units --type=service --no-legend --plain --no-pager 2>/dev/null
  sec timers; systemctl list-units --type=timer --no-legend --plain --no-pager 2>/dev/null
fi

if has pkg; then
  sec pkg
  if command -v apt >/dev/null 2>&1; then
    echo "MANAGER=apt"; apt list --upgradable 2>/dev/null | grep '/' | sed 's/^/P /'
  elif command -v dnf >/dev/null 2>&1; then
    echo "MANAGER=dnf"; dnf -q --cacheonly check-update 2>/dev/null | grep -E '^[A-Za-z0-9]' | sed 's/^/P /'
  elif command -v apk >/dev/null 2>&1; then
    echo "MANAGER=apk"; apk version -l '<' 2>/dev/null | tail -n +2 | sed 's/^/P /'
  fi
fi
sec end
`;

// Команда для execPooled: переменные — только из белого списка (секции и движки), значения без кавычек.
function command(sections, engines) {
  const secs = (sections || []).filter((s) => /^[a-z]+$/.test(s)).join(' ');
  const engs = (engines || []).filter((e) => ENGINES.includes(e)).join(' ');
  return `LE_S='${secs}' LE_ENG='${engs}' sh -s`;
}

// ---------------------------------------------------------------- разбор
function splitSections(out) {
  const res = {};
  let cur = null, buf = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^@@([\w:.-]+)$/.exec(line);
    if (m) { if (cur) res[cur] = buf.join('\n'); cur = m[1]; buf = []; continue; }
    if (cur) buf.push(line);
  }
  if (cur) res[cur] = buf.join('\n');
  for (const k of Object.keys(res)) res[k] = res[k].replace(/^\n+|\n+$/g, '');
  return res;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function parseLoad(t) { const p = t.trim().split(/\s+/); return { l1: num(p[0]), l5: num(p[1]), l15: num(p[2]), procs: p[3] || '' }; }
function parseUptime(t) { return num(t.trim().split(/\s+/)[0]); }
// /proc/stat: cpu user nice system idle iowait irq softirq steal → сумма и простой (idle+iowait)
function parseCpu(t) {
  const p = t.trim().split(/\s+/).slice(1).map(Number);
  if (p.length < 4 || p.some((x) => !Number.isFinite(x))) throw new Error('bad /proc/stat');
  const total = p.slice(0, 8).reduce((a, b) => a + b, 0);
  const idle = p[3] + (p[4] || 0);
  return { total, idle, iowait: p[4] || 0, steal: p[7] || 0 };
}
function parseMem(t) {
  const kv = {};
  for (const l of t.split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(l); if (m) kv[m[1]] = Number(m[2]) * 1024; }
  if (!kv.MemTotal) throw new Error('bad meminfo');
  const avail = kv.MemAvailable != null ? kv.MemAvailable : (kv.MemFree || 0) + (kv.Buffers || 0) + (kv.Cached || 0);
  const swapT = kv.SwapTotal || 0, swapU = swapT - (kv.SwapFree || 0);
  return { total: kv.MemTotal, avail, used: kv.MemTotal - avail, swapTotal: swapT, swapUsed: swapU };
}
// /proc/net/dev: iface: rx_bytes … (8 полей) tx_bytes … — виртуальные (lo, veth*, podman*, cni*, br-*) отдельно
const VIRT_IF = /^(lo|veth|podman|cni|docker|br-|virbr|vnet|tap|flannel|cali|kube|tun-|vxlan)/;
function parseNet(t) {
  const ifs = {};
  for (const l of t.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l); if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    ifs[m[1]] = { rx: f[0], tx: f[8], virt: VIRT_IF.test(m[1]) };
  }
  return ifs;
}
function parseKv(t) { const o = {}; for (const l of t.split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) o[m[1]] = m[2].replace(/^"|"$/g, ''); } return o; }
function parseOs(t) {
  const kv = parseKv(t);
  return { name: kv.PRETTY_NAME || kv.NAME || '', id: kv.ID || '', version: kv.VERSION_ID || '', kernel: kv.KERNEL || '', hostname: kv.HOSTNAME || '',
    arch: kv.ARCH || '', nproc: num(kv.NPROC) || 1, virt: kv.VIRT && kv.VIRT !== 'none' ? kv.VIRT : '', sudo: kv.SUDO || '', user: kv.USER || '' };
}
// df -PT: Filesystem Type Size Used Avail Use% Mounted — служебные ФС отбрасываем
const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|nsfs|proc|sysfs|cgroup2?|devpts|ramfs|autofs|fuse\.lxcfs|fuse\.portal|tracefs|securityfs|pstore|bpf|debugfs|mqueue|hugetlbfs|configfs|binfmt_misc)$/;
function parseDfRows(t) {
  const rows = [];
  for (const l of t.split('\n').slice(1)) {
    const p = l.trim().split(/\s+/);
    if (p.length < 7) continue;
    const mount = p.slice(6).join(' ');
    if (SKIP_FS.test(p[1]) || /^\/(snap|run|sys|proc|dev)(\/|$)/.test(mount)) continue;
    rows.push({ fs: p[0], type: p[1], size: num(p[2]), used: num(p[3]), avail: num(p[4]), pct: num(String(p[5]).replace('%', '')), mount });
  }
  return rows;
}
function parseDisks(dfT, dfiT) {
  const disks = parseDfRows(dfT || '').map((d) => ({ ...d, size: d.size * 1024, used: d.used * 1024, avail: d.avail * 1024 }));
  const ino = new Map(parseDfRows(dfiT || '').map((d) => [d.mount, d]));
  // одна ФС, смонтированная в нескольких местах (bind) — показываем первую точку
  const seen = new Set(); const out = [];
  for (const d of disks) {
    const key = d.fs + '|' + d.size;
    if (seen.has(key) && d.fs.startsWith('/')) continue; seen.add(key);
    const i = ino.get(d.mount);
    out.push({ ...d, ipct: i && i.size ? i.pct : null, inodes: i ? i.size : null });
  }
  return out;
}
// Служебные юниты podman — проверки здоровья контейнеров (<64 hex>[-<rand>].service|timer):
// их «failed» — это нездоровый контейнер, а не сломанный сервис; показываем отдельно.
const HC_UNIT = /^[0-9a-f]{64}(-[0-9a-f]+)?\.(service|timer)$/;
function parseUnits(t, user) {
  const out = [];
  for (const l of String(t || '').split('\n')) {
    const p = l.trim().replace(/^[●*]\s*/, '').split(/\s+/);
    if (p.length < 4 || !/\.\w+$/.test(p[0])) continue;
    out.push({ unit: p[0], load: p[1], active: p[2], sub: p[3], desc: p.slice(4).join(' '), user: !!user, helper: HC_UNIT.test(p[0]) });
  }
  return out;
}
function parseReboot(t) {
  const lines = String(t || '').split('\n').filter(Boolean);
  if (lines[0] !== 'yes') return { required: false, pkgs: [] };
  return { required: true, pkgs: [...new Set(lines.slice(1))] };
}
// ip -o addr show scope global: «2: eth0    inet 1.2.3.4/24 brd … scope global eth0»
function parseIps(t) {
  const out = [];
  for (const l of String(t || '').split('\n')) {
    const m = /^\d+:\s+(\S+)\s+(inet6?)\s+(\S+)/.exec(l); if (!m) continue;
    const ifc = m[1].replace(/@.*$/, '');
    out.push({ ifc, fam: m[2] === 'inet6' ? 6 : 4, addr: m[3].split('/')[0], prefix: num(m[3].split('/')[1]), virt: VIRT_IF.test(ifc) });
  }
  return out;
}
function parsePkg(t) {
  const lines = String(t || '').split('\n');
  const mm = /^MANAGER=(\w+)/.exec(lines[0] || '');
  if (!mm) return { manager: '', count: 0, security: 0, list: [] };
  const list = lines.filter((l) => l.startsWith('P ')).map((l) => l.slice(2).trim()).filter(Boolean);
  const security = list.filter((l) => /security/i.test(l)).length;
  return { manager: mm[1], count: list.length, security, list: list.slice(0, 300).map((l) => l.split(/\s+/)[0]) };
}
function parseCtrState(t, engine) {
  const out = [];
  for (const l of String(t || '').split('\n')) {
    const p = l.split('\t'); if (p.length < 3) continue;
    out.push({ engine, id: p[0].slice(0, 12), name: p[1].replace(/^\[|\]$/g, ''), state: p[2].toLowerCase(), status: p[3] || '' });
  }
  return out;
}
function healthOf(status, h) { if (h) return h; const m = /\((healthy|unhealthy|starting|health: starting)\)/.exec(status || ''); return m ? m[1].replace('health: ', '') : ''; }
function labelsOf(l) {
  if (l && typeof l === 'object') return l;
  const m = {}; for (const part of String(l || '').split(',')) { const i = part.indexOf('='); if (i > 0) m[part.slice(0, i)] = part.slice(i + 1); } return m;
}
// порты: podman — массив {host_ip,host_port,container_port,protocol,range}; docker — строка «0.0.0.0:80->80/tcp, :::80->80/tcp»
function portsOf(p) {
  const out = [];
  if (Array.isArray(p)) {
    for (const x of p) {
      const n = Math.max(1, x.range || 1);
      out.push({ hostIp: x.host_ip || '', hostPort: x.host_port || 0, port: x.container_port || 0, proto: x.protocol || 'tcp', range: n });
    }
    return out;
  }
  for (const part of String(p || '').split(/,\s*/)) {
    const m = /^(?:(\[?[\d.:a-f]*\]?):(\d+)(?:-(\d+))?->)?(\d+)(?:-\d+)?\/(\w+)$/i.exec(part.trim());
    if (!m) continue;
    const hostIp = (m[1] || '').replace(/[[\]]/g, '');
    if (hostIp === '::' && out.some((o) => o.hostPort === Number(m[2]) && o.proto === m[5])) continue; // дубль IPv6
    out.push({ hostIp: hostIp === '0.0.0.0' || hostIp === '::' ? '' : hostIp, hostPort: m[2] ? Number(m[2]) : 0, port: Number(m[4]), proto: m[5], range: m[3] ? Number(m[3]) - Number(m[2]) + 1 : 1 });
  }
  return out;
}
const C_PROJECT = 'com.docker.compose.project', C_SERVICE = 'com.docker.compose.service', C_WD = 'com.docker.compose.project.working_dir', C_FILES = 'com.docker.compose.project.config_files';
// домены из правил маршрутизации traefik: traefik.http.routers.<r>.rule = Host(`a.ru`) || Host(`b.ru`, `c.ru`)
function traefikDomains(labels) {
  const out = new Set();
  for (const [k, v] of Object.entries(labels || {})) {
    if (!/^traefik\.(http|tcp)\.routers\.[^.]+\.rule$/.test(k)) continue;
    for (const m of String(v).matchAll(/Host(?:SNI)?\(([^)]*)\)/g)) for (const d of m[1].matchAll(/[`'"]([^`'"]+)[`'"]/g)) if (/^[\w.-]+\.[a-z]{2,}$/i.test(d[1])) out.add(d[1].toLowerCase());
  }
  return [...out];
}
function composeMeta(labels) {
  return { project: labels[C_PROJECT] || '', service: labels[C_SERVICE] || '', workdir: labels[C_WD] || '',
    configFiles: String(labels[C_FILES] || '').split(',').map((x) => x.trim()).filter(Boolean), domains: traefikDomains(labels),
    traefik: String(labels['traefik.enable'] || '') === 'true' };
}
function parseCtrPodman(t, engine) {
  const s = String(t || '').trim(); if (!s) return [];
  let arr; try { arr = JSON.parse(s); } catch (_) { throw new Error(s.split('\n')[0].slice(0, 200)); }
  if (!Array.isArray(arr)) arr = arr ? [arr] : [];
  return arr.filter((c) => c && typeof c === 'object' && !c.IsInfra).map((c) => {
    const labels = labelsOf(c.Labels);
    return {
      engine, id: String(c.Id || '').slice(0, 12), name: (Array.isArray(c.Names) ? c.Names[0] : c.Names) || '', image: c.Image || '',
      state: String(c.State || '').toLowerCase(), status: c.Status || '', exitCode: num(c.ExitCode), restarts: num(c.Restarts) || 0,
      startedAt: num(c.StartedAt) ? c.StartedAt * 1000 : null, health: healthOf(c.Status),
      ports: portsOf(c.Ports), ...composeMeta(labels),
      unit: labels.PODMAN_SYSTEMD_UNIT || '', pod: c.PodName || '', networks: c.Networks || [],
    };
  });
}
function parseCtrDocker(t, infoT, engine) {
  const info = new Map();
  for (const l of String(infoT || '').split('\n')) {
    const p = l.trim().split(' '); if (p.length < 4) continue;
    info.set(p[0].slice(0, 12), { restarts: num(p[1]) || 0, exitCode: num(p[2]), startedAt: Date.parse(p[3]) || null, health: p[4] || '' });
  }
  const out = [];
  for (const l of String(t || '').split('\n')) {
    const s = l.trim(); if (!s.startsWith('{')) continue;
    let c; try { c = JSON.parse(s); } catch (_) { continue; }
    const id = String(c.ID || '').slice(0, 12); const i = info.get(id) || {};
    const labels = labelsOf(c.Labels);
    out.push({
      engine, id, name: String(c.Names || '').split(',')[0], image: c.Image || '', state: String(c.State || '').toLowerCase(), status: c.Status || '',
      exitCode: i.exitCode != null ? i.exitCode : null, restarts: i.restarts || 0, startedAt: i.startedAt || null, health: healthOf(c.Status, i.health),
      ports: portsOf(c.Ports), ...composeMeta(labels), unit: '', pod: '',
      networks: String(c.Networks || '').split(',').filter(Boolean),
    });
  }
  return out;
}
// размеры «97.76MB / 12.54GB», «1.888MB», «749.6kB», «1.2GiB» → байты
function bytesOf(s) {
  const m = /^([\d.]+)\s*([KMGTP]?i?B|B|kB)?$/i.exec(String(s || '').trim()); if (!m) return null;
  const u = (m[2] || 'B').toUpperCase().replace('IB', 'B');
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 }[u] ?? 0;
  const base = /i/i.test(m[2] || '') ? 1024 : 1000;
  return Math.round(Number(m[1]) * Math.pow(base, pow));
}
function parseStats(t) {
  const s = String(t || '').trim(); if (!s) return {};
  let arr = [];
  if (s.startsWith('[')) { try { arr = JSON.parse(s); } catch (_) { arr = []; } }
  else for (const l of s.split('\n')) { try { arr.push(JSON.parse(l)); } catch (_) {} }
  const out = {};
  for (const x of (Array.isArray(arr) ? arr : [])) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id || x.ID || x.Container || '').slice(0, 12);
    const name = x.name || x.Name || '';
    const memStr = String(x.mem_usage || x.MemUsage || '').split('/');
    const rec = { cpu: parseFloat(String(x.cpu_percent || x.CPUPerc || '').replace('%', '')) || 0, mem: bytesOf(memStr[0]), memLimit: bytesOf(memStr[1]),
      memPct: parseFloat(String(x.mem_percent || x.MemPerc || '').replace('%', '')) || 0 };
    if (id) out[id] = rec; if (name) out['name:' + name] = rec;
  }
  return out;
}

// ---------------------------------------------------------------- сеть (уровень net)
function jsonOr(t, d) { const x = String(t || '').trim(); if (!x) return d; try { return JSON.parse(x); } catch (_) { return d; } }
function parseAddrJ(t) {
  return (jsonOr(t, []) || []).filter((i) => i && i.ifname).map((i) => ({
    name: i.ifname, state: String(i.operstate || '').toLowerCase(), mac: i.address || '', virt: VIRT_IF.test(i.ifname),
    addrs: (i.addr_info || []).map((a) => ({ addr: a.local, fam: a.family === 'inet6' ? 6 : 4, prefix: a.prefixlen, scope: a.scope || '' })).filter((a) => a.addr),
  }));
}
function parseRoutes(t, fam) {
  return (jsonOr(t, []) || []).filter((r) => r && typeof r === 'object').map((r) => ({ fam, dst: r.dst || '', via: r.gateway || '', dev: r.dev || '', src: r.prefsrc || '', metric: r.metric != null ? r.metric : null, proto: r.protocol || '', table: r.table || '' }));
}
function parseRules(t) {
  return (jsonOr(t, []) || []).filter((r) => r && typeof r === 'object').map((r) => {
    const parts = [];
    if (r.src) parts.push('from ' + r.src + (r.srclen != null ? '/' + r.srclen : ''));
    if (r.dst) parts.push('to ' + r.dst + (r.dstlen != null ? '/' + r.dstlen : ''));
    if (r.iif) parts.push('iif ' + r.iif); if (r.oif) parts.push('oif ' + r.oif);
    if (r.fwmark) parts.push('fwmark ' + r.fwmark);
    parts.push('lookup ' + (r.table || '?'));
    return { priority: r.priority, text: parts.join(' '), table: r.table || '', custom: !['local', 'main', 'default'].includes(String(r.table)) || !!(r.fwmark || r.iif || r.oif || (r.src && r.src !== 'all')) };
  });
}
// ss -Hltnup: «tcp LISTEN 0 4096 127.0.0.1:8090 0.0.0.0:* users:(("rootlessport",pid=1,fd=11))»
function splitHostPort(a) {
  const m = /^(.*):(\d+|\*)$/.exec(String(a || '')); if (!m) return null;
  let host = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (host === '*' || host === '0.0.0.0' || host === '::') host = '';
  return { ip: host, port: m[2] === '*' ? 0 : Number(m[2]) };
}
function parseListen(t) {
  const out = []; const seen = new Set();
  for (const l of String(t || '').split('\n')) {
    const p = l.trim().split(/\s+/); if (p.length < 5) continue;
    const proto = p[0]; if (proto !== 'tcp' && proto !== 'udp') continue;
    const hp = splitHostPort(p[4]); if (!hp || !hp.port) continue;
    const procs = [...new Set([...l.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => m[1]))];
    // слирп rootless podman держит пачку служебных UDP-портов (DNS внутри сети контейнеров) — шум
    if (proto === 'udp' && procs.length === 1 && procs[0] === 'slirp4netns') continue;
    const key = proto + '|' + hp.ip + '|' + hp.port; if (seen.has(key)) continue; seen.add(key);
    const v6 = /^\[|^\*:|::/.test(p[4]) && !/^\[?::ffff/.test(p[4]);
    out.push({ proto, ip: hp.ip, port: hp.port, procs, v6: p[4].startsWith('[') || p[4].startsWith('*:'), loopback: /^(127\.|::1$)/.test(hp.ip) });
  }
  // одинаковые слушатели на 0.0.0.0 и [::] — одной строкой «все адреса»
  return out.filter((x, i, a) => !(x.ip === '' && a.findIndex((y) => y.proto === x.proto && y.ip === '' && y.port === x.port) !== i));
}
function parseFw(t) {
  const txt = String(t || '');
  const res = { kind: '', active: null, rules: [], text: '', nftTables: [] };
  const ufw = /@UFW\n([\s\S]*?)(?=\n@[A-Z]+\n|$)/.exec(txt);
  if (ufw) {
    res.kind = 'ufw'; res.text = ufw[1].trim();
    res.active = /Status:\s*active/i.test(ufw[1]);
    for (const l of ufw[1].split('\n')) { const m = /^(\S.*?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)( IN| OUT)?\s{2,}(.+)$/.exec(l.trim()); if (m) res.rules.push({ to: m[1], action: m[2] + (m[3] || ''), from: m[4].trim() }); }
  }
  const fwd = /@FIREWALLD\n([\s\S]*?)(?=\n@[A-Z]+\n|$)/.exec(txt);
  if (fwd && !res.kind) { res.kind = 'firewalld'; res.active = /^running/m.test(fwd[1]); res.text = fwd[1].trim(); }
  const nft = /@NFT\n([\s\S]*)$/.exec(txt);
  if (nft) res.nftTables = nft[1].split('\n').map((x) => x.trim()).filter((x) => x.startsWith('table ')).map((x) => x.slice(6));
  if (!res.kind && res.nftTables.length) { res.kind = 'nft'; res.active = true; }
  return res;
}
// nginx: «/etc/nginx/sites-enabled/a.conf:    server_name a.ru www.a.ru;» — по файлам
function parseNginx(t) {
  const files = new Map();
  for (const l of String(t || '').split('\n')) {
    const m = /^([^:]+):\s*(server_name|root|proxy_pass|listen)\s+([^;#]+)/.exec(l); if (!m) continue;
    const f = files.get(m[1]) || { file: m[1], domains: [], roots: [], proxies: [], listens: [] }; files.set(m[1], f);
    const v = m[3].trim();
    if (m[2] === 'server_name') for (const d of v.split(/\s+/)) { if (/^[\w*.-]+\.[a-z]{2,}$/i.test(d) && !f.domains.includes(d.toLowerCase())) f.domains.push(d.toLowerCase()); }
    else if (m[2] === 'root') f.roots.push(v); else if (m[2] === 'proxy_pass') f.proxies.push(v); else f.listens.push(v);
  }
  return [...files.values()].filter((f) => f.domains.length);
}
// Caddyfile: блоки верхнего уровня «a.ru, www.a.ru {» + reverse_proxy / root внутри
function parseCaddy(t) {
  const out = []; let depth = 0, cur = null;
  for (const raw of String(t || '').split('\n')) {
    const l = raw.replace(/#.*$/, '').trim(); if (!l) continue;
    if (depth === 0 && l.endsWith('{') && !l.startsWith('(') && l !== '{') {
      const hosts = l.slice(0, -1).split(/[\s,]+/).map((h) => h.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase()).filter((h) => /^[\w*.-]+\.[a-z]{2,}$/.test(h));
      cur = hosts.length ? { file: '/etc/caddy/Caddyfile', domains: hosts, roots: [], proxies: [] } : null;
      if (cur) out.push(cur);
    } else if (depth === 1 && cur) {
      let m = /^reverse_proxy\s+(?:\S+\s+)?([^\s{]+)/.exec(l); if (m) cur.proxies.push(m[1]);
      m = /^root\s+(?:\*\s+)?(\S+)/.exec(l); if (m) cur.roots.push(m[1]);
    }
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (depth <= 0) { depth = 0; cur = null; }
  }
  return out;
}
function parseTools(t) {
  const x = String(t || '');
  return { podmanCompose: /podman-compose/.test(x), dockerCompose: /\/docker-compose(\n|$)/.test(x), composePlugin: /docker-compose-plugin/.test(x) };
}

// Полный разбор вывода пробы → { engines, now, <секция>: значение | { error } }
function parse(out) {
  const raw = splitSections(out);
  const res = { engines: [], errors: {} };
  const safe = (key, fn) => { try { return fn(); } catch (e) { res.errors[key] = String((e && e.message) || e); return undefined; } };
  res.engines = (raw.engines || '').split(/\s+/).filter((e) => ENGINES.includes(e));
  res.now = num(raw.now);
  res.complete = 'end' in raw;
  if ('uptime' in raw) res.uptime = safe('uptime', () => parseUptime(raw.uptime));
  if ('loadavg' in raw) res.load = safe('loadavg', () => parseLoad(raw.loadavg));
  if ('cpu' in raw) res.cpu = safe('cpu', () => parseCpu(raw.cpu));
  if ('mem' in raw) res.mem = safe('mem', () => parseMem(raw.mem));
  if ('net' in raw) res.net = safe('net', () => parseNet(raw.net));
  if ('os' in raw) res.os = safe('os', () => parseOs(raw.os));
  if ('df' in raw) res.disks = safe('df', () => parseDisks(raw.df, raw.dfi));
  if ('failed' in raw) res.failed = safe('failed', () => [...parseUnits(raw.failed, false), ...parseUnits(raw.failed_user, true)]);
  if ('reboot' in raw) res.reboot = safe('reboot', () => parseReboot(raw.reboot));
  if ('ips' in raw) res.ips = safe('ips', () => parseIps(raw.ips));
  if ('units' in raw) res.units = safe('units', () => [...parseUnits(raw.units, false), ...parseUnits(raw.units_user, true)]);
  if ('timers' in raw) res.timers = safe('timers', () => parseUnits(raw.timers, false));
  if ('pkg' in raw) res.pkg = safe('pkg', () => parsePkg(raw.pkg));
  if ('tools' in raw) res.tools = safe('tools', () => parseTools(raw.tools));
  if ('agent' in raw) res.agent = safe('agent', () => require('./servers-agent').parseStatus(raw.agent));
  if ('addrj' in raw) {
    res.net2 = {
      ifaces: safe('addrj', () => parseAddrJ(raw.addrj)) || [],
      routes: [...(safe('routej', () => parseRoutes(raw.routej, 4)) || []), ...(safe('route6j', () => parseRoutes(raw.route6j, 6)) || [])],
      rules: safe('rulej', () => parseRules(raw.rulej)) || [],
      listen: safe('listen', () => parseListen(raw.listen)) || [],
      fw: safe('fw', () => parseFw(raw.fw)) || null,
      proxies: [...(safe('nginx', () => parseNginx(raw.nginx)) || []).map((x) => ({ ...x, kind: 'nginx' })), ...(safe('caddy', () => parseCaddy(raw.caddy)) || []).map((x) => ({ ...x, kind: 'caddy' }))],
    };
  }
  const states = [], ctrs = []; let hasCtr = false, hasState = false;
  for (const e of res.engines) {
    if (('ctrstate:' + e) in raw) { hasState = true; const v = safe('ctrstate:' + e, () => parseCtrState(raw['ctrstate:' + e], e)); if (v) states.push(...v); }
    if (('ctr:' + e) in raw) {
      hasCtr = true;
      const list = safe('ctr:' + e, () => (e.endsWith('podman') ? parseCtrPodman(raw['ctr:' + e], e) : parseCtrDocker(raw['ctr:' + e], raw['ctrinfo:' + e], e)));
      const st = safe('stats:' + e, () => parseStats(raw['stats:' + e])) || {};
      if (list) for (const c of list) { const s = st[c.id] || st['name:' + c.name]; ctrs.push(s ? { ...c, ...s } : c); }
    }
  }
  if (hasState) res.ctrState = states;
  if (hasCtr) res.containers = ctrs;
  return res;
}

module.exports = { SCRIPT, ENGINES, command, parse, splitSections, portsOf, bytesOf, parseUnits, HC_UNIT, traefikDomains, parseListen, parseFw, parseNginx, parseCaddy, parseRules };
