// Защита главного окна от случайного закрытия при живых агентах и процессах в PTY.
// Чистая логика группировки активных сессий вынесена отдельно от Electron для модульных тестов.

const EXT_TERM_PREFIX = '__extterm__::';
const SCRATCH_PREFIX = '__scratch__::';

/**
 * Определяет, занята ли PTY-сессия по ответу procService.agents() ({ fg, agent, idle }).
 * Голый шелл на приглашении без дочерних процессов (idle === true && !agent) закрывается молча.
 * @param {{ fg?: string | null, agent?: string | null, idle?: boolean } | null | undefined} info
 * @returns {{ kind: 'agent' | 'fg' | 'bg', label: string } | null}
 */
function classifyBusySession(info) {
  if (!info || typeof info !== 'object') return null;
  if (info.agent) return { kind: 'agent', label: String(info.agent) };
  if (info.idle === true) return null;
  if (info.fg === 'running' || info.fg === 'waiting') return { kind: 'fg', label: 'команда' };
  if (info.idle === false) return { kind: 'bg', label: 'фоновый процесс' };
  return null;
}

/**
 * Понятное имя группы (проекта или служебного терминала) по id сессии.
 * @param {string} sid
 * @param {Map<string, string>} projectNamesById
 * @param {(s: string, ...args: any[]) => string} [t]
 * @returns {{ key: string, title: string }}
 */
function resolveSessionGroup(sid, projectNamesById, t = (s) => s) {
  const raw = String(sid || '');
  if (raw.startsWith(SCRATCH_PREFIX)) {
    return { key: '__scratch__', title: t('Система · ~') };
  }
  if (raw.startsWith(EXT_TERM_PREFIX)) {
    return { key: '__extterm__', title: t('Мои модули') };
  }
  const projId = raw.split('::')[0] || raw;
  const name = projectNamesById.get(projId) || projId;
  return { key: projId, title: name };
}

/**
 * Собирает сводку занятых PTY-сессий по проектам для диалога подтверждения выхода.
 * @param {{
 *   agentsMap: Record<string, { fg?: string | null, agent?: string | null, idle?: boolean }>,
 *   projects?: Array<{ id?: string, name?: string }>,
 *   t?: (s: string, ...args: any[]) => string,
 * }} opts
 * @returns {{
 *   busyCount: number,
 *   agentCount: number,
 *   groups: Array<{ key: string, title: string, summary: string, count: number }>,
 *   detailLines: string[],
 * }}
 */
function summarizeBusyPtys(opts) {
  const agentsMap = (opts && opts.agentsMap) || {};
  const t = (opts && opts.t) || ((s) => s);
  const projectNames = new Map();
  for (const p of (opts && Array.isArray(opts.projects) ? opts.projects : [])) {
    if (p && p.id) projectNames.set(String(p.id), String(p.name || p.id));
  }

  /** @type {Map<string, { key: string, title: string, counts: Map<string, number>, total: number }>} */
  const byGroup = new Map();
  let busyCount = 0;
  let agentCount = 0;

  for (const [sid, info] of Object.entries(agentsMap)) {
    const cls = classifyBusySession(info);
    if (!cls) continue;
    busyCount++;
    if (cls.kind === 'agent') agentCount++;
    const grp = resolveSessionGroup(sid, projectNames, t);
    let bucket = byGroup.get(grp.key);
    if (!bucket) {
      bucket = { key: grp.key, title: grp.title, counts: new Map(), total: 0 };
      byGroup.set(grp.key, bucket);
    }
    const label = cls.kind === 'fg'
      ? t('выполняется команда')
      : (cls.kind === 'bg' ? t('фоновый процесс') : cls.label);
    bucket.counts.set(label, (bucket.counts.get(label) || 0) + 1);
    bucket.total++;
  }

  const groups = [];
  const detailLines = [];
  for (const b of byGroup.values()) {
    const parts = [];
    for (const [label, n] of b.counts.entries()) {
      parts.push(n > 1 ? `${label} ×${n}` : label);
    }
    const summary = parts.join(', ');
    groups.push({ key: b.key, title: b.title, summary, count: b.total });
    detailLines.push(`• ${b.title} — ${summary}`);
  }

  return { busyCount, agentCount, groups, detailLines };
}

module.exports = {
  classifyBusySession,
  resolveSessionGroup,
  summarizeBusyPtys,
};
