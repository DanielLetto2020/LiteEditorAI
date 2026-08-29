// Тест защитного фильтра «только чтение» (lib/db.js). Он стоит на двух путях: db:query для
// соединения, помеченного readOnly, и db:queryRo для вкладки AI-DB. Ложное «да» = запрет обойдён;
// у SQLite оно ещё и теряет данные (flushSqlite вызывается по !isReadOnlySql).
// Запуск: node test/sql-readonly.test.js (чистый node, без зависимостей — как весь npm test)
const assert = require('assert');
const { isReadOnlySql, stripSqlLiterals } = require('../lib/sqlro');

let passed = 0;
const ro = (sql, want, msg) => { assert.strictEqual(isReadOnlySql(sql), want, msg + ' :: ' + sql); passed++; };

// --- Читающие запросы проходят ---
ro('SELECT 1', true, 'простейший select');
ro('SELECT * FROM t WHERE c = 1 ORDER BY c', true, 'select с условием');
ro("SELECT REPLACE(c,'a','b') FROM t", true, 'функция REPLACE — не запись');
ro('SELECT count(*) FROM "insert"', true, 'кавычки: идентификатор с ключевым словом');
ro('SELECT * FROM `update`', true, 'обратные кавычки MySQL как идентификатор');
ro("SELECT 'drop table x' AS s", true, 'ключевое слово внутри строки');
ro("SELECT 'a--b' AS s", true, 'двойной дефис внутри строки');
ro("SELECT 'a/*b' AS s", true, 'начало комментария внутри строки');
ro('SELECT 1 -- drop table t', true, 'ключевое слово в хвостовом комментарии');
ro('SELECT 1 /* delete from t */', true, 'ключевое слово в блочном комментарии');
ro("SELECT 'it''s ok' AS s", true, 'удвоенный апостроф внутри строки');
ro('WITH x AS (SELECT 1) SELECT * FROM x', true, 'CTE');
ro('EXPLAIN SELECT * FROM t', true, 'explain');

// --- Изменяющие запросы отбиваются ---
ro('DROP TABLE t', false, 'drop');
ro('INSERT INTO t VALUES (1)', false, 'insert');
ro('UPDATE t SET c = 1', false, 'update');
ro('DELETE FROM t', false, 'delete');
ro('TRUNCATE t', false, 'truncate');
ro('CREATE TABLE t (a int)', false, 'create');
ro('SELECT * INTO b FROM a', false, 'select into');

// --- Обходы, ради которых фильтр и переписан ---
ro("SELECT 'a--' AS x; DROP TABLE t;", false, 'дефисы в строке прятали DROP за ними');
ro("SELECT 'a--'; INSERT INTO t VALUES (1)", false, 'то же с INSERT (у SQLite это ещё и потеря данных)');
ro("SELECT 'a/*'; DROP TABLE t; -- '", false, 'начало блочного комментария в строке');
ro('SELECT "a--" ; DROP TABLE t;', false, 'то же через двойные кавычки');
ro('SELECT `a--` ; DROP TABLE t;', false, 'то же через обратные кавычки');
ro("SELECT 'x' /* c */; DELETE FROM t", false, 'настоящий комментарий не прячет следующий стейтмент');

// --- Незакрытые литералы и комментарии не должны «съедать» хвост в разрешающую сторону ---
ro("SELECT 'unterminated; DROP TABLE t", false, 'незакрытая строка: хвост считаем кодом');
ro("SELECT $$it's$$; DROP TABLE t;", false, 'апостроф в долларовых кавычках Postgres не прячет хвост');
ro("SELECT $$ x $$ AS s", true, 'долларовые кавычки без апострофа — обычный select');
ro('SELECT 1 /* незакрытый комментарий; DROP TABLE t', true, 'незакрытый блочный комментарий съедает хвост (как и СУБД)');

// --- Сам сканер ---
assert.strictEqual(stripSqlLiterals("SELECT 'a--b' FROM t"), "SELECT '' FROM t"); passed++;
assert.strictEqual(stripSqlLiterals('SELECT 1 -- hvost\nSELECT 2'), 'SELECT 1 \nSELECT 2'); passed++;
assert.strictEqual(stripSqlLiterals('a /* b */ c'), 'a  c'); passed++;
assert.strictEqual(stripSqlLiterals("SELECT 'it''s'"), "SELECT ''"); passed++;
assert.strictEqual(stripSqlLiterals(''), ''); passed++;

console.log(`✓ sql-readonly: ${passed} проверок пройдено`);
