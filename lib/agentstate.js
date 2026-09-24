// Состояние агента в терминале по его собственному отчёту — для индикатора активности.
// Используется в main.js (pty:agentState); тесты — test/agentstate.test.js.
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

module.exports = { agentState, claudePresence, configDirOf };
