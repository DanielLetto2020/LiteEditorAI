// Тесты чистых хелперов снимков и статуса вынесенных терминалов (lib/projterm-state.js)
// и селективного снимка store для окна projterm (lib/store.js).
// Запуск: node test/projterm-state.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeProjTermSnapshot,
  collectLiveSessionIds,
  summarizeDetachedStatus,
} = require('../lib/projterm-state');
const { createStore } = require('../lib/store');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// 1. normalizeProjTermSnapshot: базовая нормализация и защита границ
eq(normalizeProjTermSnapshot(null, 'p1'), null, 'null-вход даёт null');
eq(normalizeProjTermSnapshot({ tabs: [] }), null, 'без projId и fallbackProjId даёт null');

const snap1 = normalizeProjTermSnapshot({
  active: 's2',
  splitPair: ['s1', 's2'],
  termSplit: 0.95,
  tabs: [
    { sid: ' s1 ', name: '   ', customName: 0, autoTitled: 1, isLazy: false, exited: false },
    { sid: 's1', name: 'duplicate', customName: true },
    { sid: '', name: 'empty' },
    { sid: 's2', name: 'Claude', customName: true, autoTitled: false, isLazy: false, exited: false },
    { sid: 's3', name: 'Lazy', customName: false, autoTitled: false, isLazy: true, exited: false },
  ],
}, 'proj-fallback');

eq(snap1, {
  projId: 'proj-fallback',
  active: 's2',
  splitPair: ['s1', 's2'],
  termSplit: 0.8,
  tabs: [
    { sid: 's1', name: 'Терминал', customName: false, autoTitled: true, isLazy: false, exited: false },
    { sid: 's2', name: 'Claude', customName: true, autoTitled: false, isLazy: false, exited: false },
    { sid: 's3', name: 'Lazy', customName: false, autoTitled: false, isLazy: true, exited: false },
  ],
}, 'нормализация обрезает пробелы, убирает дубли/пустые sid и зажимает termSplit сверху до 0.8');

// splitPair с lazy-вкладкой или одинаковыми sid сбрасывается, битый active откатывается на первую вкладку
const snap2 = normalizeProjTermSnapshot({
  projId: 'p2',
  active: 'missing-sid',
  splitPair: ['s1', 's_lazy'],
  termSplit: 0.05,
  tabs: [
    { sid: 's1', name: 'One', isLazy: false },
    { sid: 's_lazy', name: 'Two', isLazy: true },
  ],
});
eq(snap2.active, 's1', 'невалидный active падает на первую вкладку');
eq(snap2.splitPair, null, 'splitPair с lazy-вкладкой сбрасывается');
eq(snap2.termSplit, 0.2, 'termSplit зажимается снизу до 0.2');

const snap3 = normalizeProjTermSnapshot({
  projId: 'p3',
  splitPair: ['s1', 's1'],
  termSplit: 'not-a-number',
  tabs: [{ sid: 's1', name: 'Solo' }],
});
eq(snap3.splitPair, null, 'splitPair с одинаковыми sid сбрасывается');
eq(snap3.termSplit, 0.5, 'нечисловой termSplit откатывается на 0.5');

// 2. collectLiveSessionIds
eq(collectLiveSessionIds(null), [], 'null снимок даёт пустой список живых сессий');
eq(collectLiveSessionIds(snap1), ['s1', 's2'], 'collectLiveSessionIds возвращает только не-lazy вкладки');

// 3. summarizeDetachedStatus
eq(
  summarizeDetachedStatus('p1', [{ sid: 's_lazy', isLazy: true, state: 'busy' }]),
  { projId: 'p1', aggState: 'idle', waitingCount: 0, waitingSids: [], hasAgent: false, idle: false },
  'только lazy-вкладки дают aggState=idle и idle=false',
);

eq(
  summarizeDetachedStatus('p1', [
    { sid: 's1', state: 'busy', hasAgent: true, idle: false },
    { sid: 's2', state: 'waiting', hasAgent: true, idle: false },
    { sid: 's3', state: 'waiting', hasAgent: true, idle: false },
    { sid: 's4', isLazy: true, state: 'waiting', hasAgent: true },
  ]),
  {
    projId: 'p1',
    aggState: 'waiting',
    waitingCount: 2,
    waitingSids: ['s2', 's3'],
    hasAgent: true,
    idle: false,
  },
  'waiting приоритетнее busy, lazy-вкладки не попадают в waitingSids',
);

eq(
  summarizeDetachedStatus('p1', [
    { sid: 's1', state: 'busy', hasAgent: false, idle: false },
    { sid: 's2', state: 'quiet', hasAgent: false, idle: true },
  ]),
  { projId: 'p1', aggState: 'busy', waitingCount: 0, waitingSids: [], hasAgent: false, idle: false },
  'busy приоритетнее quiet',
);

eq(
  summarizeDetachedStatus('p1', [
    { sid: 's1', state: 'quiet', hasAgent: false, idle: true },
    { sid: 's2', state: 'quiet', hasAgent: false, exited: true, idle: false },
  ]),
  { projId: 'p1', aggState: 'quiet', waitingCount: 0, waitingSids: [], hasAgent: false, idle: true },
  'idle=true, когда все живые сессии idle без агента или exited',
);

// 4. Селективный снимок store для modId === 'projterm' включает promptSnippets
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-projterm-store-'));
try {
  const store = createStore({ storeDir: dir, flushDelayMs: 20 });
  store.ensureDir();
  store.writeStoreKey('promptSnippets', [{ id: 'pr1', title: 'Hello', text: 'World' }], { sync: true });
  const projTermSnap = store.loadSnapshot({ modId: 'projterm' });
  const pomoSnap = store.loadSnapshot({ modId: 'pomodoro' });
  eq(projTermSnap.promptSnippets, [{ id: 'pr1', title: 'Hello', text: 'World' }], 'окно projterm получает promptSnippets');
  ok(pomoSnap.promptSnippets === undefined, 'другие окна модулей не получают promptSnippets');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`projterm-state.test.js: OK (${passed} assertions)`);
