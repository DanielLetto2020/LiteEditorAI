// Уровень строки консоли главного процесса в логе (logger.js consoleLevel):
// предупреждения Node об устаревших API — WARN, а не ERROR. Запуск: node test/logger-level.test.js
'use strict';

const assert = require('assert');
const { consoleLevel } = require('../logger.js');

let passed = 0;
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

eq(consoleLevel('error', ['(node:5268) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.']), 'warn', 'DEP0180');
eq(consoleLevel('error', ['(node:202072) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated']), 'warn', 'без кода DEP');
eq(consoleLevel('error', ['Error: boom']), 'error', 'обычная ошибка');
eq(consoleLevel('error', ['x (node:1) [DEP0001] DeprecationWarning: y']), 'error', 'не с начала строки');
eq(consoleLevel('error', [new Error('(node:1) DeprecationWarning: x')]), 'error', 'не строка');
eq(consoleLevel('error', []), 'error', 'без аргументов');
eq(consoleLevel('warn', ['(node:1) [DEP0180] DeprecationWarning: x']), 'warn', 'warn остаётся warn');
eq(consoleLevel('log', ['x']), 'info', 'log → info');
eq(consoleLevel('info', ['x']), 'info', 'info');

console.log(`✓ logger-level: ${passed} проверок пройдено`);
