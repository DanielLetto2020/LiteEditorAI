// Локальная 30-дневная дневная телеметрия по времени работы/ожидания агентов.
'use strict';

const MAX_DAYS = 30;
const SLEEP_CLAMP_MS = 120 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKeyLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nextMidnightTs(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

function normalizeStatus(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'busy' || s === 'working') return 'working';
  if (s === 'waiting') return 'waiting';
  return 'idle';
}

function emptyDay() {
  return { workingMs: 0, waitingMs: 0, idleMs: 0, turns: 0, byAgent: {}, byProject: {} };
}

/**
 * Создать трекер статистики с кэшированием и 30-дневной ротацией.
 * @param {object} [opts]
 * @param {() => any} [opts.getData]
 * @param {(v: any) => void} [opts.setData]
 * @param {() => number} [opts.now]
 */
function createAgentStats(opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const getData = typeof opts.getData === 'function' ? opts.getData : () => null;
  const setData = typeof opts.setData === 'function' ? opts.setData : () => {};

  const raw = getData();
  /** @type {{ days: Record<string, any> }} */
  const store = (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object')
    ? { days: { ...raw.days } }
    : { days: {} };

  /** @type {Map<string, { status: string, agent: string, projId: string, lastTs: number }>} */
  const active = new Map();
  let dirty = false;
  let flushTimer = null;

  function pruneOldDays(todayKey) {
    const keys = Object.keys(store.days).sort();
    if (keys.length <= MAX_DAYS) return;
    const dropCount = keys.length - MAX_DAYS;
    for (let i = 0; i < dropCount; i++) {
      if (keys[i] !== todayKey) delete store.days[keys[i]];
    }
  }

  function ensureDay(dk) {
    if (!store.days[dk] || typeof store.days[dk] !== 'object') {
      store.days[dk] = emptyDay();
      pruneOldDays(dk);
    }
    const d = store.days[dk];
    d.byAgent = d.byAgent && typeof d.byAgent === 'object' ? d.byAgent : {};
    d.byProject = d.byProject && typeof d.byProject === 'object' ? d.byProject : {};
    return d;
  }

  pruneOldDays(dateKeyLocal(nowFn()));

  function addSlice(startTs, endTs, status, agent, projId) {
    if (endTs <= startTs) return;
    // Защита от сна ОС: один непрерывный отрезок не длиннее 120с без событий
    const cappedEnd = Math.min(endTs, startTs + SLEEP_CLAMP_MS);
    let cursor = startTs;
    const field = status === 'working' ? 'workingMs' : status === 'waiting' ? 'waitingMs' : 'idleMs';

    while (cursor < cappedEnd) {
      const dk = dateKeyLocal(cursor);
      const mid = nextMidnightTs(cursor);
      const segEnd = Math.min(cappedEnd, mid);
      const delta = segEnd - cursor;
      const day = ensureDay(dk);
      day[field] = (day[field] || 0) + delta;

      if (status !== 'idle' && agent) {
        const a = day.byAgent[agent] || (day.byAgent[agent] = { workingMs: 0, waitingMs: 0, turns: 0 });
        a[field] = (a[field] || 0) + delta;
      }
      if (status !== 'idle' && projId) {
        const p = day.byProject[projId] || (day.byProject[projId] = { workingMs: 0, waitingMs: 0, turns: 0 });
        p[field] = (p[field] || 0) + delta;
      }
      cursor = segEnd;
    }
    dirty = true;
  }

  function scheduleFlush() {
    if (!dirty || flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 5000);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty) return;
    dirty = false;
    setData({ days: store.days });
  }

  function updateSession(sid, meta) {
    if (!sid) return;
    const ts = nowFn();
    const nextStatus = normalizeStatus(meta && meta.status);
    const nextAgent = String((meta && meta.agentKind) || '');
    const nextProj = String((meta && meta.projId) || '__global__');

    const prev = active.get(sid);
    if (prev) {
      addSlice(prev.lastTs, ts, prev.status, prev.agent, prev.projId);
      if (prev.status === 'working' && nextStatus !== 'working') {
        const dk = dateKeyLocal(ts);
        const day = ensureDay(dk);
        day.turns = (day.turns || 0) + 1;
        const aKey = prev.agent || nextAgent;
        if (aKey) {
          const a = day.byAgent[aKey] || (day.byAgent[aKey] = { workingMs: 0, waitingMs: 0, turns: 0 });
          a.turns = (a.turns || 0) + 1;
        }
        const pKey = prev.projId || nextProj;
        if (pKey) {
          const p = day.byProject[pKey] || (day.byProject[pKey] = { workingMs: 0, waitingMs: 0, turns: 0 });
          p.turns = (p.turns || 0) + 1;
        }
        dirty = true;
      }
    }
    active.set(sid, { status: nextStatus, agent: nextAgent, projId: nextProj, lastTs: ts });
    scheduleFlush();
  }

  function removeSession(sid) {
    const prev = active.get(sid);
    if (!prev) return;
    const ts = nowFn();
    addSlice(prev.lastTs, ts, prev.status, prev.agent, prev.projId);
    active.delete(sid);
    scheduleFlush();
  }

  function checkpoint() {
    const ts = nowFn();
    for (const prev of active.values()) {
      addSlice(prev.lastTs, ts, prev.status, prev.agent, prev.projId);
      prev.lastTs = ts;
    }
    scheduleFlush();
  }

  function getSummary() {
    checkpoint();
    const todayKey = dateKeyLocal(nowFn());
    const today = store.days[todayKey] || emptyDay();
    const daysSorted = Object.keys(store.days).sort().slice(-MAX_DAYS).map((date) => ({
      date,
      workingMs: store.days[date].workingMs || 0,
      waitingMs: store.days[date].waitingMs || 0,
      idleMs: store.days[date].idleMs || 0,
      turns: store.days[date].turns || 0,
    }));
    return {
      todayKey,
      today: {
        workingMs: today.workingMs || 0,
        waitingMs: today.waitingMs || 0,
        idleMs: today.idleMs || 0,
        turns: today.turns || 0,
        byAgent: today.byAgent || {},
        byProject: today.byProject || {},
      },
      days: daysSorted,
    };
  }

  function resetToday() {
    const todayKey = dateKeyLocal(nowFn());
    store.days[todayKey] = emptyDay();
    const ts = nowFn();
    for (const prev of active.values()) prev.lastTs = ts;
    dirty = true;
    flush();
  }

  return {
    updateSession,
    removeSession,
    checkpoint,
    getSummary,
    resetToday,
    flush,
    _store: store,
  };
}

module.exports = { createAgentStats, dateKeyLocal, normalizeStatus, MAX_DAYS, SLEEP_CLAMP_MS };
