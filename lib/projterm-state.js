// Чистые хелперы снимков вкладок и агрегации статуса вынесенных терминалов проекта.
// Используется в main.js для валидации/передачи сессий между окнами и покрывается тестами Node.

'use strict';

/**
 * @typedef {{ sid: string, name: string, customName: boolean, autoTitled: boolean, isLazy: boolean, exited: boolean }} ProjTermTabSnap
 * @typedef {{ projId: string, active: string | null, splitPair: [string, string] | null, termSplit: number, tabs: ProjTermTabSnap[] }} ProjTermSnapshot
 */

/**
 * Нормализует снимок вкладок проекта для безопасной передачи между главным и вынесенным окном.
 * @param {any} raw
 * @param {string} [fallbackProjId]
 * @returns {ProjTermSnapshot | null}
 */
function normalizeProjTermSnapshot(raw, fallbackProjId) {
  if (!raw || typeof raw !== 'object') return null;
  const projId = typeof raw.projId === 'string' && raw.projId ? raw.projId : (typeof fallbackProjId === 'string' ? fallbackProjId : '');
  if (!projId) return null;

  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
  /** @type {ProjTermTabSnap[]} */
  const tabs = [];
  const seen = new Set();
  for (const item of rawTabs) {
    if (!item || typeof item !== 'object') continue;
    const sid = typeof item.sid === 'string' ? item.sid.trim() : '';
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    tabs.push({
      sid,
      name: rawName || 'Терминал',
      customName: !!item.customName,
      autoTitled: !!item.autoTitled,
      isLazy: !!item.isLazy,
      exited: !!item.exited,
    });
  }

  const liveSet = new Set(tabs.filter((t) => !t.isLazy).map((t) => t.sid));
  let active = typeof raw.active === 'string' && seen.has(raw.active) ? raw.active : null;
  if (!active && tabs.length) active = tabs[0].sid;

  /** @type {[string, string] | null} */
  let splitPair = null;
  if (Array.isArray(raw.splitPair) && raw.splitPair.length === 2) {
    const s0 = raw.splitPair[0];
    const s1 = raw.splitPair[1];
    if (typeof s0 === 'string' && typeof s1 === 'string' && s0 !== s1 && liveSet.has(s0) && liveSet.has(s1)) {
      splitPair = [s0, s1];
    }
  }

  const numSplit = Number(raw.termSplit);
  const termSplit = Number.isFinite(numSplit) ? Math.max(0.2, Math.min(0.8, numSplit)) : 0.5;

  return { projId, active, splitPair, termSplit, tabs };
}

/**
 * Возвращает список sid живых (не lazy) вкладок из снимка.
 * @param {ProjTermSnapshot | null | undefined} snap
 * @returns {string[]}
 */
function collectLiveSessionIds(snap) {
  if (!snap || !Array.isArray(snap.tabs)) return [];
  return snap.tabs.filter((t) => t && !t.isLazy && typeof t.sid === 'string' && t.sid).map((t) => t.sid);
}

/**
 * Агрегирует статус вынесенного окна терминалов для списка проектов, трея и бейджа внимания.
 * @param {string} projId
 * @param {Array<{ sid: string, isLazy?: boolean, exited?: boolean, hasAgent?: boolean, state?: string, idle?: boolean }>} sessions
 */
function summarizeDetachedStatus(projId, sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const live = list.filter((s) => s && !s.isLazy);
  if (!live.length) {
    return { projId, aggState: 'idle', waitingCount: 0, waitingSids: [], hasAgent: false, idle: false };
  }
  const waitingSids = live.filter((s) => s.state === 'waiting').map((s) => s.sid);
  const hasBusy = live.some((s) => s.state === 'busy');
  const aggState = waitingSids.length ? 'waiting' : hasBusy ? 'busy' : 'quiet';
  const hasAgent = live.some((s) => !!s.hasAgent);
  const idle = live.every((s) => !!s.exited || (!!s.idle && !s.hasAgent));
  return {
    projId,
    aggState,
    waitingCount: waitingSids.length,
    waitingSids,
    hasAgent,
    idle,
  };
}

module.exports = {
  normalizeProjTermSnapshot,
  collectLiveSessionIds,
  summarizeDetachedStatus,
};
