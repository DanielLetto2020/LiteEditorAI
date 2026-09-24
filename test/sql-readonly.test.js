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

// --- Лексика конкретной СУБД: текст, который одна СУБД читает строкой, а другая — кодом ---
// dialect: тип подключения; без него запрос обязан пройти правила всех СУБД сразу.
const rod = (sql, dialect, want, msg) => { assert.strictEqual(isReadOnlySql(sql, dialect), want, msg + ' [' + (dialect || 'все') + '] :: ' + sql); passed++; };
for (const d of [undefined, 'mysql']) {
  rod("SELECT '\\''; SET SESSION TRANSACTION READ WRITE; DROP TABLE t; -- '", d, false, "MySQL: \\' — экранированная кавычка, следом конец строки");
  rod('SELECT "\\""; DROP TABLE t; -- "', d, false, 'MySQL: то же в двойных кавычках');
  rod('SELECT 1--1; DROP TABLE t;', d, false, 'MySQL: «--» без пробела — не комментарий');
  rod('SELECT 1 /*!50000 ; DROP TABLE t */', d, false, 'MySQL: /*! … */ исполняется');
  rod('SELECT 1 /*M!100100 ; DROP TABLE t */', d, false, 'MariaDB: /*M! … */ исполняется');
  rod('SELECT 1 /*!50000 SELECT 1 /* x */ ; DROP TABLE t */', d, false, 'MySQL: вложенный /* внутри исполняемого не прячет хвост');
}
for (const d of [undefined, 'postgres']) {
  rod("SELECT $$a'$$; DROP TABLE t; SELECT 'x'", d, false, 'Postgres: апостроф в $$…$$ не открывает строку');
  rod("SELECT $tag$a'$tag$; DROP TABLE t; SELECT 'x'", d, false, 'Postgres: именованные долларовые кавычки');
  rod("SELECT $тег$a'$тег$; DROP TABLE t; SELECT 'x'", d, false, 'Postgres: метка долларовых кавычек не из ASCII');
  rod("SELECT E'\\''; DROP TABLE t; -- '", d, false, "Postgres: в E'…' обратный слэш экранирует");
  rod("SELECT 'C:\\', 'x'; DROP TABLE t; SELECT 'y'", d, false, 'Postgres (standard_conforming_strings=on): слэш в конце строки — просто символ');
}
for (const d of [undefined, 'sqlite']) rod("SELECT [a'b] FROM t; DROP TABLE t; SELECT 'x'", d, false, 'SQLite: апостроф в [идентификаторе]');
for (const d of [undefined, 'postgres', 'mysql', 'sqlite']) {
  rod("SELECT * FROM t/**/INTO OUTFILE '/tmp/x'", d, false, 'комментарий разделяет слова: t/**/INTO — это INTO');
  rod('SELECT * FROM t WHERE a = 1', d, true, 'обычный select');
  rod("SELECT name FROM t WHERE name LIKE 'a\\_b' OR code ~ '^\\d+$'", d, true, 'обратные слэши в шаблонах');
}
// своя СУБД — меньше ложных отказов: то, что в ней строка/комментарий, не считается кодом
rod('SELECT $$drop table t$$ AS s', 'postgres', true, 'Postgres: ключевое слово внутри $$…$$');
rod('SELECT $$drop table t$$ AS s', undefined, false, 'без СУБД $$…$$ может быть и кодом');
rod('SELECT 1 # drop table t', 'mysql', true, 'MySQL: # — комментарий');
rod('SELECT [drop] FROM t', 'sqlite', true, 'SQLite: [drop] — идентификатор');
rod('SELECT 1 --drop table t', 'postgres', true, 'Postgres: «--» без пробела — тоже комментарий');
rod('SELECT 1 --drop table t', 'mysql', false, 'MySQL: «--drop» — код');
rod("SELECT 'it\\'s' AS s", 'mysql', true, "MySQL: \\' внутри строки");
rod('SELECT 1 /*!99999 drop */', 'postgres', true, 'Postgres: /*! — обычный комментарий');

// --- Сам сканер ---
assert.strictEqual(stripSqlLiterals("SELECT 'a--b' FROM t"), "SELECT '' FROM t"); passed++;
assert.strictEqual(stripSqlLiterals('SELECT 1 -- hvost\nSELECT 2'), 'SELECT 1 \nSELECT 2'); passed++;
assert.strictEqual(stripSqlLiterals('a /* b */ c'), 'a   c'); passed++;   // комментарий → пробел-разделитель
assert.strictEqual(stripSqlLiterals("SELECT 'it''s'"), "SELECT ''"); passed++;
assert.strictEqual(stripSqlLiterals(''), ''); passed++;
assert.strictEqual(stripSqlLiterals("a '\\'' b", { bs: 'all' }), "a '' b"); passed++;
assert.strictEqual(stripSqlLiterals("a '\\'' b"), "a '\\'' b"); passed++;   // «без слэша»: '' — удвоение, строка не закрыта → хвост как код
assert.strictEqual(stripSqlLiterals("E'\\'' x", { bs: 'E' }), "E'' x"); passed++;
assert.strictEqual(stripSqlLiterals("xE'\\'' x", { bs: 'E' }), "xE'\\'' x"); passed++;   // xE — идентификатор, слэш не экранирует
assert.strictEqual(stripSqlLiterals('a $q$ b $q$ c', { dollar: true }), 'a $$ c'); passed++;
assert.strictEqual(stripSqlLiterals('a$q$ b', { dollar: true }), 'a$q$ b'); passed++;   // $ после буквы — часть имени
assert.strictEqual(stripSqlLiterals('$1 $$x', { dollar: true }), '$1 $$x'); passed++;   // незакрытая — хвост как код
assert.strictEqual(stripSqlLiterals('a [b c] d', { brackets: true }), 'a [] d'); passed++;
assert.strictEqual(stripSqlLiterals('a [b c] d'), 'a [b c] d'); passed++;
assert.strictEqual(stripSqlLiterals('a --b\nc', { myDash: true }), 'a --b\nc'); passed++;
assert.strictEqual(stripSqlLiterals('a -- b\nc', { myDash: true }), 'a \nc'); passed++;
assert.strictEqual(stripSqlLiterals('a --', { myDash: true }), 'a '); passed++;
assert.strictEqual(stripSqlLiterals('a # b\nc', { hash: true }), 'a \nc'); passed++;
assert.strictEqual(stripSqlLiterals('a # b'), 'a # b'); passed++;
assert.strictEqual(stripSqlLiterals('a /*!123 b */ c', { exec: true }), 'a   b   c'); passed++;
assert.strictEqual(stripSqlLiterals('a /*!123 b */ c'), 'a   c'); passed++;
assert.strictEqual(stripSqlLiterals('a "b\\" c" d', { bsDq: true }), 'a "" d'); passed++;
assert.strictEqual(stripSqlLiterals('a "b\\" c" d'), 'a "" c" d'); passed++;

// --- Разметка для SQL-консоли: «запрос под курсором» и :параметры (renderer/modules/db.js) ---
const { splitSqlStatements, findSqlParams, substituteSqlParams } = require('../lib/sqlro');
const stmts = (sql) => splitSqlStatements(sql).map((r) => sql.slice(r.from, r.to).trim()).filter(Boolean);
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };
eq(stmts('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2'], 'два оператора');
eq(stmts("SELECT 'a;b' FROM t; SELECT 2"), ["SELECT 'a;b' FROM t", 'SELECT 2'], '«;» внутри строки не режет запрос');
eq(stmts('SELECT "x;y" FROM t'), ['SELECT "x;y" FROM t'], '«;» в идентификаторе');
eq(stmts('SELECT 1 -- a;b\n; SELECT 2'), ['SELECT 1 -- a;b', 'SELECT 2'], '«;» в строчном комментарии');
eq(stmts('SELECT 1 /* ; */; SELECT 2'), ['SELECT 1 /* ; */', 'SELECT 2'], '«;» в блочном комментарии');
eq(stmts('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; SELECT 2; $$ LANGUAGE sql; SELECT f()'),
  ['CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; SELECT 2; $$ LANGUAGE sql', 'SELECT f()'], 'тело функции в $$…$$ — один оператор');
eq(stmts('DO $body$ BEGIN PERFORM 1; END $body$; SELECT 2'), ['DO $body$ BEGIN PERFORM 1; END $body$', 'SELECT 2'], 'именованные долларовые кавычки');
eq(stmts('SELECT $1; SELECT 2'), ['SELECT $1', 'SELECT 2'], '$1 — не долларовая кавычка');
eq(stmts("SELECT 'it''s; ok'"), ["SELECT 'it''s; ok'"], 'удвоенный апостроф');
eq(findSqlParams('SELECT * FROM t WHERE id = :id AND name = :name OR id = :id'), ['id', 'name'], 'параметры без повторов');
eq(findSqlParams("SELECT 'a:b', '10:30', x::text, @v := 1, arr[1:n] FROM t WHERE c = :c"), ['c'], 'в строках, приведениях, := и срезах параметров нет');
eq(findSqlParams('SELECT 1 -- :nope\n/* :nope2 */'), [], 'в комментариях параметров нет');
eq(substituteSqlParams("SELECT ':id' AS s, :id AS v", () => '42'), "SELECT ':id' AS s, 42 AS v", 'подставляется только в коде');

console.log(`✓ sql-readonly: ${passed} проверок пройдено`);
