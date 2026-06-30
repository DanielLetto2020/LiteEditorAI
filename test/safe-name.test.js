// Тест безопасности: safeChildName блокирует path traversal в именах файлов/папок.
// Запуск: node test/safe-name.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const { safeChildName } = require('../lib/safe-name');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// --- Допустимые имена проходят как есть ---
ok(safeChildName('project') === 'project', 'обычное имя');
ok(safeChildName('my-folder_2') === 'my-folder_2', 'дефисы/подчёркивания');
ok(safeChildName('  spaced  ') === 'spaced', 'тримминг пробелов');
ok(safeChildName('файл') === 'файл', 'unicode');
ok(safeChildName('.hidden') === '.hidden', 'скрытый файл (точка-префикс) разрешён');

// --- Traversal и сепараторы блокируются (возвращают null) ---
ok(safeChildName('../etc') === null, 'родительский traversal');
ok(safeChildName('../../home/user/.ssh') === null, 'глубокий traversal');
ok(safeChildName('a/b') === null, 'POSIX-сепаратор');
ok(safeChildName('a\\b') === null, 'Windows-сепаратор');
ok(safeChildName('/etc/passwd') === null, 'абсолютный POSIX-путь');
ok(safeChildName('..') === null, 'просто ..');
ok(safeChildName('.') === null, 'просто .');
ok(safeChildName('C:\\Windows') === null, 'Windows-диск');
ok(safeChildName('file:stream') === null, 'NTFS alternate data stream');
ok(safeChildName('evil\0.txt') === null, 'null-байт');

// --- Мусорный ввод ---
ok(safeChildName('') === null, 'пустая строка');
ok(safeChildName('   ') === null, 'только пробелы');
ok(safeChildName(null) === null, 'null');
ok(safeChildName(undefined) === null, 'undefined');
ok(safeChildName(42) === null, 'не строка');

console.log(`✓ safe-name: ${passed} проверок пройдено`);
