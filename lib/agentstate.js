// Состояние агента в терминале по его собственному отчёту — для индикатора активности.
// Используется в main.js (pty:agentState, pty:agents); тесты — test/agentstate.test.js.
//
// По выводу терминала нельзя понять, работает ли Claude Code: строка статуса с refreshInterval
// перерисовывается и в простое (55–75 байт раз в 1–2 с), каждая буква в поле ввода — ~50 байт
// перерисовки. /proc тоже не помогает: Claude спит и пока ждёт ответа модели, и пока ждёт человека.
// Зато Claude сам ведёт файл присутствия сессии <каталог конфигурации>/sessions/<pid>.json
// (замер 24.09.2026, v2.1.281): status busy | idle | waiting, при waiting — waitingFor
// ('permission prompt', 'input needed', 'dialog open' …). Файл обновляется в пределах ~50 мс
// после перерисовки экрана и удаляется при выходе. Каталог — CLAUDE_CONFIG_DIR процесса или ~/.claude.
// Только Linux: pid Claude ищем в группе переднего плана терминала через /proc.

const fs = require('fs');
const os = require('os');
const path = require('path');
const pt = require('./proctree');

const STATUSES = new Set(['busy', 'idle', 'waiting']);

// CLAUDE_CONFIG_DIR из окружения процесса (/proc/<pid>/environ, записи через \0); '' — не задан.
function configDirOf(pid) {
  let env;
  try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch (_) { return ''; }
  const key = 'CLAUDE_CONFIG_DIR=';
  for (const kv of env.split('\0')) if (kv.startsWith(key)) return kv.slice(key.length);
  return '';
}

// Отчёт Claude о сессии процесса pid: { status, waitingFor } или null (не Claude, старая версия
// без статуса, файл от прежнего процесса с тем же pid).
function claudePresence(pid, home = os.homedir()) {
  const dir = configDirOf(pid) || path.join(home, '.claude');
  let o;
  try { o = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', pid + '.json'), 'utf8')); } catch (_) { return null; }
  if (!o || +o.pid !== +pid || !STATUSES.has(o.status)) return null;
  if (o.procStart != null) {   // pid переиспользован: файл пережил упавший Claude, а под этим pid уже другой процесс
    const st = pt.readProcStat(pid);
    if (!st || String(o.procStart) !== st.start) return null;
  }
  return { status: o.status, waitingFor: o.status === 'waiting' ? String(o.waitingFor || '') : '' };
}

// { fg: 'shell' | 'running' | 'waiting', claude: { status, waitingFor } | null } или null (не Linux).
function agentState(shellPid, platform = process.platform) {
  const g = pt.foregroundGroup(shellPid, platform);
  if (!g) return null;
  let claude = null;
  for (const p of g.pids) { claude = claudePresence(p); if (claude) break; }   // лидер группы первым
  return { fg: g.kind, claude };
}

// ── Какой агент в терминале ──────────────────────────────────────────────────
// Для фильтра «только проекты с агентом» в «Избранном»: зелёный индикатор горит и у терминала,
// открытого случайным кликом, а нужен ответ «работает ли тут агент». Узнаём по имени процесса
// в группе переднего плана: нативные сборки (claude, codex) видны по comm, запущенные
// интерпретатором (`node …/bin/gemini`, `node …/codex.js`, `python -m aider`) — по имени скрипта.
// Остановленный по Ctrl+Z агент на переднем плане не стоит — агентом не считается.
const AGENTS = new Set(['claude', 'codex', 'gemini', 'qwen', 'aider', 'opencode', 'crush', 'goose', 'amp',
  'cursor-agent', 'copilot', 'droid', 'kimi', 'auggie']);
const INTERPRETER_RE = /^(?:node|nodejs|bun|deno|python[\d.]*|pypy[\d.]*|ruby)$/;
const GROUP_SCAN_MAX = 32;   // агент — лидер группы или рядом с ним; сборку на сотни процессов не обходим

// Имя агента по командной строке: сам бинарник (`…/bin/claude`) или скрипт интерпретатора —
// первый аргумент после флагов, без каталога и расширения. Интерпретатор узнаём по argv[0], а не
// по comm: Node 24 называет главный поток «MainThread», и comm у `node …/gemini` — не «node».
function agentFromCmdline(pid) {
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) { return null; }
  const argv = raw.split('\0');
  const exe = path.basename(argv[0] || '');
  if (AGENTS.has(exe)) return exe;
  if (!INTERPRETER_RE.test(exe)) return null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;   // флаги интерпретатора; у `python -m aider` дальше идёт имя модуля
    const name = path.basename(a).replace(/\.(?:[cm]?js|py)$/, '');
    return AGENTS.has(name) ? name : null;
  }
  return null;
}
function agentName(pid) {
  const st = pt.readProcStat(pid);
  if (!st) return null;
  return AGENTS.has(st.comm) ? st.comm : agentFromCmdline(pid);
}

// { fg: 'shell' | 'running' | 'waiting', agent: 'claude' | 'codex' | … | null, idle } или null (не Linux).
// idle — терминал можно закрыть без потерь: шелл на своём приглашении и у него нет ни одного
// потомка (фоновой задачи, остановленного Ctrl+Z агента, сервера через `&`).
function agentOf(shellPid, platform = process.platform) {
  const g = pt.foregroundGroup(shellPid, platform);
  if (!g) return null;
  let agent = null;
  for (const p of g.pids.slice(0, GROUP_SCAN_MAX)) { agent = agentName(p); if (agent) break; }   // лидер группы первым
  let idle = false;
  if (g.kind === 'shell') { const kids = pt.descendants(shellPid); idle = Array.isArray(kids) && kids.length === 0; }
  return { fg: g.kind, agent, idle };
}

module.exports = { agentState, agentOf, agentName, claudePresence, configDirOf, AGENTS };
