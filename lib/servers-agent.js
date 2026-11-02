// «Серверы», этап 6: агент на сервере — маленький POSIX sh-скрипт (+ awk), который раз в минуту пишет метрики
// и события в файлы, пока редактор закрыт. НЕ ИИ и НЕ служба с портом: ничего не слушает, связь — только SSH
// (редактор при подключении дочитывает накопленное). Живёт целиком в каталоге пользователя, root не нужен.
//
//   ~/.local/share/lite-agent/
//     agent.sh      — сам агент (VERSION ниже); `agent.sh run` — один замер, `agent.sh loop` — цикл (запасной режим)
//     agent.conf    — движки контейнеров и пороги (пишет редактор при установке/смене настроек)
//     metrics.log   — «t cpu% mem% load1 rx_Bps tx_Bps disk_max%» по строке в минуту, хранится KEEP строк (2 суток)
//     events.log    — «t sev key текст»: проблема появилась (warn/crit) / ушла (ok), контейнер упал/поднялся
//     state/        — прошлые значения для дельт CPU/сети и множества активных проблем
//     mode          — чем запускается: systemd (user timer, нужен linger) | cron | loop
//
// Запуск: systemd --user таймер (если linger включён или включается через sudo -n), иначе crontab, иначе
// фоновый цикл nohup (не переживает перезагрузку — UI предупредит).
'use strict';

const AGENT_VERSION = 1;
const DIR = '$HOME/.local/share/lite-agent';

// ВНИМАНИЕ: только POSIX sh (dash) и POSIX awk (mawk на Ubuntu): без gawk-расширений.
const AGENT = String.raw`#!/bin/sh
# LiteEditor server agent — VERSION=${AGENT_VERSION}. Метрики и события раз в минуту; без сети и портов.
# Удаление: кнопка «Удалить агента» в окне «Серверы».
export LC_ALL=C
D="$(cd "$(dirname "$0")" && pwd)"
[ -n "$XDG_RUNTIME_DIR" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"   # podman rootless из cron без сессии
ENGS=""; DISK=90; MEM=90; LOAD=2; KEEP=2880
[ -f "$D/agent.conf" ] && . "$D/agent.conf"
mkdir -p "$D/state"
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 20"
eng() { e="$1"; shift; case "$e" in docker) $T docker "$@";; podman) $T podman "$@";; sudodocker) $T sudo -n docker "$@";; sudopodman) $T sudo -n podman "$@";; esac; }

sample() {
  now=$(date +%s)
  # CPU: дельта /proc/stat к прошлому замеру
  cpu=$(awk -v f="$D/state/cpu" 'BEGIN{pt=0;pi=0; if((getline l < f)>0){split(l,a," ");pt=a[1];pi=a[2]}; close(f)}
    /^cpu /{t=0; for(i=2;i<=9&&i<=NF;i++)t+=$i; id=$5+$6; print t, id > f; if(pt>0&&t>pt) printf "%.1f", 100*(1-(id-pi)/(t-pt)); else printf "-"; exit}' /proc/stat)
  mem=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(t>0)printf "%.1f",100*(t-a)/t; else printf "-"}' /proc/meminfo)
  load=$(cut -d' ' -f1 /proc/loadavg)
  # сеть: сумма невиртуальных интерфейсов, байт/с к прошлому замеру
  net=$(awk -v f="$D/state/net" -v now="$now" 'BEGIN{pt=0;pr=0;px=0; if((getline l < f)>0){split(l,a," ");pt=a[1];pr=a[2];px=a[3]}; close(f)}
    NR>2{n=$1; sub(/:.*/,"",n); gsub(/^ +/,"",n); if(n ~ /^(lo|veth|podman|cni|docker|br-|virbr|vnet|tap|flannel|cali|kube|tun-|vxlan)/) next;
      s=$0; sub(/^[^:]*:/,"",s); split(s,v," "); rx+=v[1]; tx+=v[9]}
    END{print now, rx, tx > f; dt=now-pt; if(pt>0&&dt>0&&rx>=pr&&tx>=px) printf "%d %d", (rx-pr)/dt, (tx-px)/dt; else printf "- -"}' /proc/net/dev)
  disk=$(df -P 2>/dev/null | awk 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|udev|none|shm)$/ && $6 !~ /^\/(snap|run|sys|proc|dev)(\/|$)/ {p=$5; sub(/%/,"",p); if(p+0>m)m=p+0} END{printf "%d", m}')
  echo "$now $cpu $mem $load $net $disk" >> "$D/metrics.log"
  n=$(wc -l < "$D/metrics.log"); if [ "$n" -gt $((KEEP + 120)) ]; then tail -n "$KEEP" "$D/metrics.log" > "$D/metrics.tmp" && mv "$D/metrics.tmp" "$D/metrics.log"; fi

  # проблемы: множество активных ключей; новые → событие, ушедшие → «снова в норме».
  # FILENAME, а не NR==FNR: при ПУСТОМ первом файле NR==FNR истинно и для второго — всё ушло бы в «старые»
  : > "$D/state/now.keys"
  df -P 2>/dev/null | awk -v th="$DISK" 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|udev|none|shm)$/ && $6 !~ /^\/(snap|run|sys|proc|dev)(\/|$)/ {p=$5; sub(/%/,"",p); if(p+0>=th) print "disk:" $6 "\twarn\tДиск " $6 " заполнен на " p "%"}' >> "$D/state/now.keys"
  case "$mem" in -) ;; *) awk -v m="$mem" -v th="$MEM" 'BEGIN{if(m+0>=th) printf "mem\twarn\tПамять занята на %d%%\n", m}' >> "$D/state/now.keys";; esac
  np=$(nproc 2>/dev/null || echo 1)
  awk -v l="$load" -v n="$np" -v k="$LOAD" 'BEGIN{if(l+0>n*k) printf "load\twarn\tВысокая нагрузка: load %s при %d ядрах\n", l, n}' >> "$D/state/now.keys"
  if command -v systemctl >/dev/null 2>&1; then
    { systemctl --failed --no-legend --plain --no-pager 2>/dev/null; systemctl --user --failed --no-legend --plain --no-pager 2>/dev/null; } \
      | awk '{u=$1; if(u=="●"||u=="*")u=$2; if(u ~ /^[0-9a-f]{64}/ || u !~ /\./) next; print "unit:" u "\twarn\tСервис " u " упал"}' >> "$D/state/now.keys"
  fi
  # контейнеры: был running — перестал (и наоборот)
  : > "$D/state/ctr.now"
  for e in $ENGS; do eng "$e" ps -a --format '{{.Names}} {{.State}}' 2>/dev/null | awk -v e="$e" '{print e ":" $1, $2}' >> "$D/state/ctr.now"; done
  if [ -f "$D/state/ctr.prev" ] && [ -s "$D/state/ctr.now" ]; then
    awk -v now="$now" 'FILENAME==ARGV[1]{p[$1]=$2; next} {c[$1]=$2}
      END{for(k in p){n=k; sub(/^[^:]*:/,"",n); if(p[k]=="running" && c[k]!="running") print now, "warn", "ctr:" n, "Контейнер " n " остановился (" ((k in c) ? c[k] : "удалён") ")";
                       }
          for(k in c){n=k; sub(/^[^:]*:/,"",n); if(c[k]=="running" && (k in p) && p[k]!="running") print now, "ok", "ctr:" n, "Контейнер " n " снова работает"}}' \
      "$D/state/ctr.prev" "$D/state/ctr.now" >> "$D/events.log"
  fi
  [ -s "$D/state/ctr.now" ] || [ -z "$ENGS" ] && mv "$D/state/ctr.now" "$D/state/ctr.prev"
  touch "$D/state/active.keys"
  awk -F'\t' -v now="$now" 'FILENAME==ARGV[1]{old[$1]=$3; next} {cur[$1]=1; if(!($1 in old)) print now, $2, $1, $3}
    END{for(k in old) if(!(k in cur)) print now, "ok", k, old[k] " — снова в норме"}' "$D/state/active.keys" "$D/state/now.keys" >> "$D/events.log"
  mv "$D/state/now.keys" "$D/state/active.keys"
  n=$(wc -l < "$D/events.log" 2>/dev/null || echo 0); if [ "$n" -gt 2000 ]; then tail -n 1500 "$D/events.log" > "$D/events.tmp" && mv "$D/events.tmp" "$D/events.log"; fi
}

case "$1" in
  ""|run) sample ;;
  loop) echo $$ > "$D/loop.pid"; while :; do sample; sleep 60; done ;;
  *) echo "usage: agent.sh run|loop" >&2; exit 2 ;;
esac
`;

const SERVICE = `[Unit]
Description=LiteEditor server agent (metrics while the editor is closed)

[Service]
Type=oneshot
ExecStart=%h/.local/share/lite-agent/agent.sh run
Nice=10
`;
const TIMER = `[Unit]
Description=LiteEditor server agent — every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
`;

const sqs = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function confText(cfg) {
  const engs = (cfg.engines || []).filter((e) => /^(docker|podman|sudodocker|sudopodman)$/.test(e)).join(' ');
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  return `ENGS="${engs}"\nDISK=${Math.round(n(cfg.disk, 50, 99, 90))}\nMEM=${Math.round(n(cfg.mem, 50, 99, 90))}\nLOAD=${n(cfg.load, 0.5, 20, 2)}\nKEEP=2880\n`;
}

// Установка: файлы через stdin-скрипт (heredoc внутри), затем выбор планировщика. Выводит MODE=… для UI.
function installScript(cfg) {
  const eof = (tag, body) => `cat > ${tag.file} <<'LITE_AGENT_EOF_${tag.id}'\n${body}LITE_AGENT_EOF_${tag.id}\n`;
  return `set -e
D="${DIR}"
mkdir -p "$D/state"
# перед обновлением — погасить запасной цикл прошлой установки
[ -f "$D/loop.pid" ] && kill "$(cat "$D/loop.pid")" 2>/dev/null || true
rm -f "$D/loop.pid"
${eof({ file: '"$D/agent.sh"', id: 'A' }, AGENT)}chmod 700 "$D/agent.sh"
${eof({ file: '"$D/agent.conf"', id: 'C' }, confText(cfg))}set +e
"$D/agent.sh" run || { echo "ERR=пробный запуск агента не прошёл"; exit 3; }
MODE=""
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  L=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null | cut -d= -f2)
  if [ "$L" != "yes" ] && sudo -n true >/dev/null 2>&1; then sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1 && L=yes; fi
  if [ "$L" = "yes" ]; then
    U="$HOME/.config/systemd/user"; mkdir -p "$U"
${eof({ file: '"$U/lite-agent.service"', id: 'S' }, SERVICE)}${eof({ file: '"$U/lite-agent.timer"', id: 'T' }, TIMER)}    systemctl --user daemon-reload && systemctl --user enable --now lite-agent.timer >/dev/null 2>&1 && MODE=systemd
  fi
fi
if [ -z "$MODE" ] && command -v crontab >/dev/null 2>&1; then
  { crontab -l 2>/dev/null | grep -v 'lite-agent/agent.sh'; echo "* * * * * $D/agent.sh run >/dev/null 2>&1"; } | crontab - && MODE=cron
fi
if [ -z "$MODE" ]; then
  nohup "$D/agent.sh" loop >/dev/null 2>&1 &
  MODE=loop
fi
echo "$MODE" > "$D/mode"
echo "MODE=$MODE"
`;
}
// Обновить только пороги/движки (настройки сервера сменились) — без переустановки
function confScript(cfg) {
  return `D="${DIR}"; [ -d "$D" ] || exit 0\ncat > "$D/agent.conf" <<'LITE_AGENT_EOF_C'\n${confText(cfg)}LITE_AGENT_EOF_C\necho OK\n`;
}
const UNINSTALL = `D="${DIR}"
systemctl --user disable --now lite-agent.timer >/dev/null 2>&1
rm -f "$HOME/.config/systemd/user/lite-agent.service" "$HOME/.config/systemd/user/lite-agent.timer"
systemctl --user daemon-reload >/dev/null 2>&1
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'lite-agent/agent.sh'; then crontab -l 2>/dev/null | grep -v 'lite-agent/agent.sh' | crontab -; fi
[ -f "$D/loop.pid" ] && kill "$(cat "$D/loop.pid")" 2>/dev/null
rm -rf "$D"
[ -e "$D" ] && echo "ERR=каталог не удалился" || echo OK
`;
// Статус (секция медленной пробы — см. servers-probe.js) и выборка накопленного с момента since
function syncScript(sinceMetrics, sinceEvents) {
  const a = Math.max(0, Math.floor(Number(sinceMetrics) || 0)), b = Math.max(0, Math.floor(Number(sinceEvents) || 0));
  return `D="${DIR}"; [ -f "$D/agent.sh" ] || { echo NOAGENT; exit 0; }
echo @@M; awk -v s=${a} '$1>s' "$D/metrics.log" 2>/dev/null | tail -n 3000
echo @@E; awk -v s=${b} '$1>s' "$D/events.log" 2>/dev/null | tail -n 500
`;
}
function parseStatus(t) {
  const x = String(t || '');
  if (!/INSTALLED/.test(x)) return { installed: false };
  const ver = /VERSION=(\d+)/.exec(x), mode = /^MODE=(\w+)/m.exec(x), last = /^LAST=(\d+)/m.exec(x), first = /^FIRST=(\d+)/m.exec(x);
  const timer = /^TIMER=(\w+)/m.exec(x), loop = /^LOOP=(\w+)/m.exec(x);
  return { installed: true, version: ver ? Number(ver[1]) : 0, mode: mode ? mode[1] : '', last: last ? Number(last[1]) * 1000 : 0, first: first ? Number(first[1]) * 1000 : 0,
    timer: timer ? timer[1] : '', loop: loop ? loop[1] === 'yes' : null, current: ver ? Number(ver[1]) === AGENT_VERSION : false };
}
// Статус для пробы: есть ли агент, версия, режим, последняя запись, жив ли таймер/цикл
const STATUS_SH = `D="${DIR}"; if [ -f "$D/agent.sh" ]; then echo INSTALLED; grep -m1 -o 'VERSION=[0-9]*' "$D/agent.sh"; echo "MODE=$(cat "$D/mode" 2>/dev/null)"
  echo "LAST=$(tail -n 1 "$D/metrics.log" 2>/dev/null | cut -d' ' -f1)"; echo "FIRST=$(head -n 1 "$D/metrics.log" 2>/dev/null | cut -d' ' -f1)"
  command -v systemctl >/dev/null 2>&1 && echo "TIMER=$(systemctl --user is-active lite-agent.timer 2>/dev/null)"
  [ -f "$D/loop.pid" ] && { kill -0 "$(cat "$D/loop.pid")" 2>/dev/null && echo LOOP=yes || echo LOOP=no; }; fi`;
function parseSync(t) {
  const x = String(t || '');
  if (/^NOAGENT/m.test(x)) return { installed: false, metrics: [], events: [] };
  const mi = x.indexOf('@@M'), ei = x.indexOf('@@E');
  const mt = mi >= 0 ? x.slice(mi + 3, ei >= 0 ? ei : undefined) : '', et = ei >= 0 ? x.slice(ei + 3) : '';
  const num = (v) => (v === '-' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const metrics = [];
  for (const l of mt.split('\n')) {
    const p = l.trim().split(/\s+/); if (p.length < 6 || !/^\d+$/.test(p[0])) continue;
    metrics.push({ t: Number(p[0]) * 1000, cpu: num(p[1]), mem: num(p[2]), load: num(p[3]), rx: num(p[4]), tx: num(p[5]), disk: num(p[6]) });
  }
  const events = [];
  for (const l of et.split('\n')) {
    const m = /^(\d+) (warn|crit|ok|info) (\S+) (.*)$/.exec(l.trim()); if (!m) continue;
    events.push({ t: Number(m[1]) * 1000, sev: m[2], key: m[3], text: m[4] });
  }
  return { installed: true, metrics, events };
}

module.exports = { AGENT_VERSION, AGENT, installScript, confScript, UNINSTALL, syncScript, parseSync, parseStatus, STATUS_SH, confText, sqs };
