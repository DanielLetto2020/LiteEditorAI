// Тест безопасности: safeRelSegments не даёт ключу объекта увести «Скачать папку» за пределы
// выбранного каталога. Ключ в бакете — произвольная строка (в т.ч. из чужого/публичного бакета),
// поэтому '..' и сепараторы в нём — не путь, а данные.
// Запуск: node test/storage-path.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const path = require('path');
const { safeRelSegments } = require('../lib/safe-name');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
const join = (rel) => path.join('/dest', ...safeRelSegments(rel));
const inside = (rel) => { const p = join(rel); return p === '/dest' || p.startsWith('/dest' + path.sep); };

// --- Нормальные ключи не ломаются ---
assert.deepStrictEqual(safeRelSegments('a/b/c.txt'), ['a', 'b', 'c.txt']); passed++;
assert.deepStrictEqual(safeRelSegments('file.txt'), ['file.txt']); passed++;
assert.deepStrictEqual(safeRelSegments('a//b'), ['a', 'b']); passed++;           // пустые сегменты
assert.deepStrictEqual(safeRelSegments('папка/файл.md'), ['папка', 'файл.md']); passed++;
assert.deepStrictEqual(safeRelSegments('.hidden/x'), ['.hidden', 'x']); passed++; // скрытый — обычное имя
assert.deepStrictEqual(safeRelSegments('a/...b/c'), ['a', '...b', 'c']); passed++; // три точки — легальное имя

// --- Traversal обезврежен ---
assert.deepStrictEqual(safeRelSegments('../../etc/passwd'), ['etc', 'passwd']); passed++;
assert.deepStrictEqual(safeRelSegments('a/../../b'), ['a', 'b']); passed++;
assert.deepStrictEqual(safeRelSegments('./x'), ['x']); passed++;
ok(inside('../../../../home/user/.bashrc'), 'глубокий traversal остаётся внутри каталога');
ok(inside('..'), 'ключ из одного «..»');
ok(inside('../'), 'traversal с хвостовым слешем');
ok(inside('a/../../../../../../tmp/pwn'), 'traversal вперемешку с именами');

// --- Windows-специфика: обратный слеш и двоеточие внутри сегмента ---
assert.deepStrictEqual(safeRelSegments('a\\..\\..\\b'), ['a_.._.._b']); passed++;
assert.deepStrictEqual(safeRelSegments('C:/x'), ['C_', 'x']); passed++;          // диск-относительный путь
ok(!safeRelSegments('a\\b').some((s) => s.includes('\\')), 'обратных слешей в сегментах не остаётся');

// --- Вырожденные ключи не пишут в саму папку ---
assert.deepStrictEqual(safeRelSegments(''), ['object']); passed++;
assert.deepStrictEqual(safeRelSegments('///'), ['object']); passed++;
assert.deepStrictEqual(safeRelSegments('../..'), ['object']); passed++;
ok(join('') !== '/dest', 'пустой ключ не даёт путь самого каталога');

// --- NUL-байт вырезается ---
ok(!safeRelSegments('a\0b/c').some((s) => s.includes('\0')), 'NUL-байт удалён');

console.log(`✓ storage-path: ${passed} проверок пройдено`);
