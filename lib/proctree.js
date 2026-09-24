// Чтение дерева процессов из /proc (Linux) для индикатора активности терминала.
// Используется в main.js (pty:foregroundState, monitor:sample) и lib/agentstate.js; тесты — test/proctree.test.js.
//
// Индикатор спрашивает «что делает группа переднего плана терминала»: голый шелл, программа
// считает или программа спит и ждёт ввода. Раньше для этого читался /proc/*/stat ВСЕХ процессов
// системы — на машине с 1 606 процессами это 15 мс синхронной блокировки главного процесса на
// каждый опрос, а пока агент думает молча, опрос повторяется каждые 1,2 с на каждую вкладку.
// Группа переднего плана — это потомки шелла, поэтому обходим только их через
// /proc/<pid>/task/<tid>/children (0,06 мс). Нет этого файла (ядро без CONFIG_PROC_CHILDREN) —
// прежний полный обход.

const fs = require('fs');

// Разбор /proc/<pid>/stat. comm может содержать пробелы и скобки — режем по последней ')'.
function readProcStat(pid) {
  try {
    const data = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const r = data.lastIndexOf(')');
    const comm = data.slice(data.indexOf('(') + 1, r);
    const rest = data.slice(r + 2).split(' '); // state ppid pgrp session tty_nr tpgid ... [19]=starttime
    return { comm, state: rest[0], ppid: +rest[1], pgrp: +rest[2], tpgid: +rest[5], start: rest[19] };
  } catch (_) { return null; }
}

// Прямые дети процесса (по всем его потокам). null — файл children недоступен в этом ядре.
function childrenOf(pid) {
  let tids;
  try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (_) { return []; } // процесс уже вышел
  const out = [];
  let supported = false;
  for (const tid of tids) {
    let raw;
    try { raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8'); supported = true; } catch (_) { continue; }
    for (const p of raw.split(' ')) if (p) out.push(+p);
  }
  return supported || !tids.length ? out : null;
}

// Все потомки процесса (без него самого). null — обход через children невозможен.
function descendants(pid) {
  const first = childrenOf(pid);
  if (first === null) return null;
  const out = [];
  const seen = new Set([+pid]);
  const stack = first.slice();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    const kids = childrenOf(p);
    if (kids) for (const k of kids) stack.push(k);
  }
  return out;
}

// Все числовые pid системы — запасной путь.
function allPids() {
  const out = [];
  try {
    for (const ent of fs.readdirSync('/proc')) {
      const c = ent.charCodeAt(0);
      if (c >= 48 && c <= 57) out.push(+ent); // '0'..'9'
    }
  } catch (_) { return null; }
  return out;
}

// Живые процессы группы pgid (лидер первым) и считает ли кто-то из них (R — работает, D — ждёт диска).
function groupState(pgid, pids) {
  const members = [];
  let running = false;
  for (const p of pids) {
    const st = readProcStat(p);
    if (!st || st.pgrp !== pgid) continue;
    if (p === pgid) members.unshift(p); else members.push(p);
    if (st.state === 'R' || st.state === 'D') running = true;
  }
  return { alive: members.length > 0, running, pids: members };
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ash', 'tcsh', 'csh', 'ksh', '-bash', '-zsh', '-sh']);

// Группа переднего плана терминала: { kind: 'shell' | 'running' | 'waiting', pids } или null
// (не Linux / шелла нет). pids — живые процессы группы, лидер первым; у 'shell' список пуст.
function foregroundGroup(shellPid, platform = process.platform) {
  if (platform !== 'linux' || !shellPid) return null;
  const sh = readProcStat(shellPid);
  if (!sh || !(sh.tpgid > 0)) return null;
  const bare = { kind: 'shell', pids: [] };
  if (sh.tpgid === sh.pgrp) return bare;                 // shell's own group is foreground
  const leader = readProcStat(sh.tpgid);
  if (leader && SHELLS.has(leader.comm)) return bare;    // a nested shell sitting at its prompt
  let pids = descendants(shellPid);
  if (pids === null) pids = allPids();                   // ядро без children — полный обход, как раньше
  if (pids === null) return null;
  // Лидер группы проверяем и отдельно: его могли переподвесить к init (тогда он не потомок шелла).
  if (leader && !pids.includes(sh.tpgid)) pids.push(sh.tpgid);
  const g = groupState(sh.tpgid, pids);
  if (!g.alive) return bare;
  return { kind: g.running ? 'running' : 'waiting', pids: g.pids };
}

// 'shell' | 'running' | 'waiting' | null — см. комментарий в main.js у pty:foregroundState.
function foregroundKind(shellPid, platform = process.platform) {
  const g = foregroundGroup(shellPid, platform);
  return g ? g.kind : null;
}

module.exports = { readProcStat, childrenOf, descendants, allPids, groupState, foregroundGroup, foregroundKind, SHELLS };
