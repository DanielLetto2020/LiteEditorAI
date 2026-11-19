// Тесты разбора и маппинга OSC 7501 (lib/osc7501.js).
// Запуск: node test/osc7501.test.js
'use strict';

const assert = require('assert');
const {
  OSC7501_QUERY_REPLY,
  decodeBase64Utf8,
  parseOsc7501,
  mapOsc7501ToIndicator,
} = require('../lib/osc7501');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

/** @param {string} raw */
function parseStatus(raw) {
  const p = parseOsc7501(raw);
  assert.ok(p && p.type === 'status', `ожидался статус для: ${raw}`);
  return p;
}

// 1. Запрос поддержки и константа ответа
ok(OSC7501_QUERY_REPLY.startsWith('\x1b]7501;?:') && OSC7501_QUERY_REPLY.endsWith('\x1b\\'), 'формат ответа на ?');
eq(parseOsc7501('?'), { type: 'query' }, 'точный запрос поддержки');
eq(parseOsc7501('  ?  '), { type: 'query' }, 'запрос поддержки с пробелами');

// 2. Реальные пакеты agy (включая base64 с padding ==)
const authParsed = parseStatus('state=blocked:kind=auth:app=antigravity:msg=U2lnbiBpbiByZXF1aXJlZA==');
eq(authParsed, {
  type: 'status',
  state: 'blocked',
  kind: 'auth',
  app: 'antigravity',
  id: '',
  msg: 'Sign in required',
  title: '',
  progress: null,
}, 'пакет agy blocked/auth с padding ==');
eq(mapOsc7501ToIndicator(authParsed), {
  action: 'set',
  indicator: 'waiting',
  reason: 'auth needed',
}, 'маппинг blocked/auth');

const setupParsed = parseStatus('state=blocked:kind=question:app=antigravity:msg=RmluaXNoIHNldHVw');
eq(setupParsed.msg, 'Finish setup', 'пакет agy blocked/question');
eq(mapOsc7501ToIndicator(setupParsed), {
  action: 'set',
  indicator: 'waiting',
  reason: 'input needed',
}, 'маппинг blocked/question');

// 3. Кириллица UTF-8 в msg/title и base64url без padding
const b64Msg = Buffer.from('Нужно разрешение\x07\n', 'utf8').toString('base64');
const b64UrlTitle = Buffer.from('Сборка проекта', 'utf8').toString('base64url');
const permParsed = parseStatus(`state=blocked:kind=permission:app=agy:msg=${b64Msg}:title=${b64UrlTitle}`);
eq(permParsed.msg, 'Нужно разрешение', 'UTF-8 msg декодируется и чистится от управляющих символов');
eq(permParsed.title, 'Сборка проекта', 'UTF-8 title в base64url декодируется');
eq(mapOsc7501ToIndicator(permParsed), {
  action: 'set',
  indicator: 'waiting',
  reason: 'permission prompt',
}, 'маппинг blocked/permission');

// 4. Все остальные состояния и progress
const workingParsed = parseStatus('state=working:progress=42:app=agy');
eq(workingParsed.progress, 42, 'валидный progress');
eq(mapOsc7501ToIndicator(workingParsed), { action: 'set', indicator: 'busy', reason: '' }, 'working → busy');

eq(mapOsc7501ToIndicator(parseOsc7501('state=blocked')), {
  action: 'set',
  indicator: 'waiting',
  reason: '',
}, 'blocked без kind');

eq(mapOsc7501ToIndicator(parseOsc7501('state=idle')), { action: 'set', indicator: 'quiet', reason: '' }, 'idle → quiet');
eq(mapOsc7501ToIndicator(parseOsc7501('state=done')), { action: 'set', indicator: 'quiet', reason: '' }, 'done → quiet');
eq(mapOsc7501ToIndicator(parseOsc7501('state=error')), { action: 'set', indicator: 'waiting', reason: 'error' }, 'error → waiting(error)');
eq(mapOsc7501ToIndicator(parseOsc7501('state=clear')), { action: 'clear' }, 'clear → clear');

// 5. Границы progress, невалидные состояния и decodeBase64Utf8
eq(parseStatus('state=working:progress=0').progress, 0, 'progress=0');
eq(parseStatus('state=working:progress=100').progress, 100, 'progress=100');
eq(parseStatus('state=working:progress=101').progress, null, 'progress=101 → null');
eq(parseStatus('state=working:progress=-5').progress, null, 'progress=-5 → null');
eq(parseStatus('state=working:progress=abc').progress, null, 'progress=abc → null');

eq(parseOsc7501(''), null, 'пустая строка → null');
eq(parseOsc7501(/** @type {any} */ (null)), null, 'null → null');
eq(parseOsc7501('kind=auth:app=agy'), null, 'без state → null');
eq(parseOsc7501('state=unknown'), null, 'неизвестный state → null');

eq(decodeBase64Utf8('not!base64'), '', 'битый base64 → пусто');
eq(decodeBase64Utf8('a'), '', 'некорректная длина base64 (mod 4 === 1) → пусто');

// 6. Пакеты подзадач с id не перетирают корневой статус сессии
const subClear = parseStatus('state=clear:id=sub1');
eq(subClear.id, 'sub1', 'id подзадачи сохранён');
eq(mapOsc7501ToIndicator(subClear), null, 'state=clear:id=sub1 игнорируется');
eq(mapOsc7501ToIndicator(parseOsc7501('state=working:id=sub1')), null, 'state=working:id=sub1 игнорируется');
eq(mapOsc7501ToIndicator(null), null, 'map(null) → null');

console.log(`osc7501.test.js: OK (${passed} assertions)`);
