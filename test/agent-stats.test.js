// Unit-тесты для lib/agent-stats.js: 30-дневная ротация, midnight split, sleep clamp, сброс дня.
'use strict';

const assert = require('assert');
const { createAgentStats, SLEEP_CLAMP_MS, dateKeyLocal } = require('../lib/agent-stats');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

check('tracks working/waiting durations, turns and clamps >120s sleep gaps', () => {
  let now = new Date(2026, 4, 10, 12, 0, 0).getTime();
  let saved = null;
  const stats = createAgentStats({ now: () => now, setData: (v) => { saved = v; } });

  stats.updateSession('s1', { status: 'busy', agentKind: 'claude', projId: 'p1' });
  now += 10000; // 10s working
  stats.updateSession('s1', { status: 'waiting', agentKind: 'claude', projId: 'p1' });
  now += 500000; // huge sleep -> clamped to 120s waiting
  stats.removeSession('s1');
  stats.flush();

  assert(saved && saved.days);
  const sum = stats.getSummary();
  assert.strictEqual(sum.today.workingMs, 10000);
  assert.strictEqual(sum.today.waitingMs, SLEEP_CLAMP_MS);
  assert.strictEqual(sum.today.turns, 1);
  assert.strictEqual(sum.today.byAgent.claude.workingMs, 10000);
  assert.strictEqual(sum.today.byProject.p1.turns, 1);
});

check('splits slices across local midnight boundary', () => {
  let now = new Date(2026, 4, 10, 23, 59, 40).getTime();
  const stats = createAgentStats({ now: () => now });
  stats.updateSession('s1', { status: 'busy', agentKind: 'codex', projId: 'p1' });
  now += 50000; // +50s -> 20s on May 10, 30s on May 11
  stats.checkpoint();

  const d1 = dateKeyLocal(new Date(2026, 4, 10, 12, 0, 0).getTime());
  const d2 = dateKeyLocal(new Date(2026, 4, 11, 12, 0, 0).getTime());
  assert.strictEqual(stats._store.days[d1].workingMs, 20000);
  assert.strictEqual(stats._store.days[d2].workingMs, 30000);
});

check('prunes days beyond 30 entries and resetToday clears current day only', () => {
  const seed = { days: {} };
  for (let i = 1; i <= 32; i++) {
    seed.days[`2026-04-${String(i).padStart(2, '0')}`] = { workingMs: 1000, waitingMs: 0, idleMs: 0, turns: 1 };
  }
  let now = new Date(2026, 4, 15, 10, 0, 0).getTime();
  const stats = createAgentStats({ now: () => now, getData: () => seed });
  stats.updateSession('s1', { status: 'busy', agentKind: 'claude', projId: 'p1' });
  now += 5000;
  stats.checkpoint();
  const sum = stats.getSummary();
  assert(sum.days.length <= 30);

  stats._store.days[sum.todayKey].workingMs = 5000;
  stats.resetToday();
  assert.strictEqual(stats.getSummary().today.workingMs, 0);
});

console.log(`agent-stats.test.js: ${passed} checks passed`);
