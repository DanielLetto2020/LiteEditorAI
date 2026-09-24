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
rod("SELECT 'a\\''; DROP TABLE t; -- '", 'postgres', false, 'Postgres со standard_conforming_strings=off: слэш экранирует и в обычной строке');
ro('SELECT 4/2; DROP TABLE t', false, 'деление — не начало комментария');
ro('SELECT 1 /* x*y / drop */', true, '«*» и «/» по отдельности комментарий не закрывают');

// --- Не пишут в таблицы, но снимают защиту или бьют по серверу ---
for (const d of [undefined, 'postgres', 'mysql', 'sqlite']) {
  // SET, переключающий режим/роль/глобальные настройки
  rod('SET default_transaction_read_only = off', d, false, 'pg: снять read-only по умолчанию');
  rod('SELECT 1; SET transaction_read_only = off', d, false, 'pg: SET вторым оператором');
  rod('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', d, false, 'pg: характеристики сессии');
  rod('SET SESSION TRANSACTION READ WRITE', d, false, 'MySQL: режим транзакций сессии');
  rod('SET @@session.transaction_read_only = 0', d, false, 'MySQL: системная переменная');
  rod('set session tx_read_only=0', d, false, 'MySQL: старое имя переменной');
  rod('SET ROLE postgres', d, false, 'смена роли');
  rod('SET SESSION AUTHORIZATION DEFAULT', d, false, 'смена пользователя');
  rod('SET GLOBAL max_connections = 1', d, false, 'MySQL: глобальная настройка');
  rod('SET @@global.read_only = 0', d, false, 'MySQL: @@global');
  rod('SET PERSIST max_connections = 1', d, false, 'MySQL: PERSIST');
  rod("SET PASSWORD = 'x'", d, false, 'MySQL: смена пароля');
  rod('(SET ROLE x)', d, false, 'скобки перед оператором');
  rod('SET search_path TO app, public; SELECT 1', d, true, 'безобидный SET');
  rod('SET NAMES utf8mb4', d, true, 'SET NAMES');
  rod('SET @x = 1', d, true, 'пользовательская переменная');
  rod('SET LOCAL statement_timeout = 1000', d, true, 'таймаут');
  // транзакция на запись
  rod('BEGIN READ WRITE; SELECT f()', d, false, 'pg: BEGIN READ WRITE');
  rod('START TRANSACTION READ WRITE', d, false, 'MySQL: START TRANSACTION READ WRITE');
  rod('START TRANSACTION; SELECT 1; COMMIT', d, true, 'обычная транзакция на чтение');
  rod('BEGIN; SELECT 1; END', d, true, 'BEGIN/END');
  // операторы по первому слову
  for (const st of ['REPLACE t VALUES (1)', 'replace t set a = 1', 'RESET ALL', 'DISCARD ALL', "PREPARE s FROM @s", 'EXECUTE s',
    "EXECUTE IMMEDIATE 'x'", 'KILL 42', 'KILL QUERY 42', 'SHUTDOWN', 'RESTART', 'FLUSH PRIVILEGES', 'PURGE BINARY LOGS BEFORE NOW()',
    "INSTALL PLUGIN x SONAME 'x.so'", 'UNINSTALL PLUGIN x', 'OPTIMIZE TABLE t', 'REPAIR TABLE t', 'ANALYZE t', 'CHECKPOINT',
    'CLUSTER t', 'REFRESH MATERIALIZED VIEW v', 'REASSIGN OWNED BY a TO b', 'IMPORT FOREIGN SCHEMA s FROM SERVER x INTO y',
    "SECURITY LABEL ON TABLE t IS 'x'", "COMMENT ON TABLE t IS 'x'", 'START REPLICA', 'STOP REPLICA', 'CHANGE MASTER TO x = 1',
    "BINLOG 'x'", "CLONE INSTANCE FROM 'u'@'h':3306", "SELECT 1; KILL 42", "SET @s = 'DROP TABLE t'; PREPARE s FROM @s; EXECUTE s"]) {
    rod(st, d, false, 'оператор ' + st.split(' ')[0]);
  }
  rod("SELECT REPLACE(a, 'x', 'y') FROM t", d, true, 'REPLACE() — функция, не оператор');
  rod('EXPLAIN ANALYZE SELECT * FROM t', d, true, 'EXPLAIN ANALYZE SELECT');
  rod('SELECT start, stop, change, comment, analyze FROM t', d, true, 'такие слова внутри оператора — просто имена');
  // функции с побочными эффектами
  for (const fn of ['SELECT pg_terminate_backend(pid) FROM pg_stat_activity', 'SELECT pg_cancel_backend(1)', 'SELECT pg_reload_conf()',
    "SELECT lo_export(1, '/tmp/x')", "SELECT dblink_exec('dbname=x', 'DROP TABLE t')", "SELECT * FROM dblink('c', 'DELETE FROM t') AS t(a int)",
    "SELECT query_to_xml('SELECT 1', true, true, '')", "SELECT set_config('default_transaction_read_only', 'off', false)",
    "SELECT setval('s', 1)", "SELECT nextval('s')", "SELECT pg_file_write('x', 'y', false)", "SELECT sys_exec('id')",
    'SELECT pg_catalog.pg_terminate_backend (1)', 'SELECT pg_terminate_backend/**/(1)',
    'SELECT "pg_terminate_backend"(1)', 'SELECT "pg_catalog"."setval"(\'s\', 1)', 'SELECT `sys_exec`(\'id\')']) {
    rod(fn, d, false, 'функция ' + fn);
  }
  rod('SELECT U&"\\0070g_terminate_backend"(1)', d, false, 'U&"…" — имя с экранами');
  rod("SELECT currval('s'), pg_backend_pid(), setval_count FROM t", d, true, 'читающие функции и похожие имена');
  rod('SELECT * FROM "setval" s', d, true, 'таблица с «опасным» именем — не вызов');
  rod("SELECT 'pg_terminate_backend(1)' AS s", d, true, 'имя функции в строке');
}

// --- Число операторов (db:queryRo — ровно один; фильтр WHERE таблицы — одно условие) ---
const { sqlStatementCount } = require('../lib/sqlro');
const cnt = (sql, dialect, want, msg) => { assert.strictEqual(sqlStatementCount(sql, dialect), want, msg + ' [' + (dialect || 'все') + '] :: ' + sql); passed++; };
cnt('SELECT 1', undefined, 1, 'один');
cnt('SELECT 1;', 'postgres', 1, 'хвостовой «;»');
cnt('SELECT 1; -- конец', 'mysql', 1, 'комментарий после «;»');
cnt("SELECT 'a;b' FROM t", undefined, 1, '«;» в строке');
cnt('SELECT 1; COMMIT; SELECT setval(1)', 'postgres', 3, 'три оператора');
cnt('SELECT $$a;b$$', 'postgres', 1, 'Postgres: «;» в $$…$$');
cnt('SELECT $$a;b$$', undefined, 2, 'без СУБД $$…$$ может быть кодом');
cnt("SELECT '\\''; COMMIT", 'mysql', 2, "MySQL: \\' не прячет второй оператор");
cnt('SELECT 1 /*!; COMMIT */', 'mysql', 2, 'MySQL: /*! … */ — код');
cnt('   ', undefined, 0, 'пусто');

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
assert.strictEqual(stripSqlLiterals('/*!1 a */ b /* c */ d', { exec: true }), '  a   b   d'); passed++;   // после */ обычный комментарий снова комментарий
assert.strictEqual(stripSqlLiterals('$$a$$ b', { dollar: true }), '$$ b'); passed++;   // долларовые кавычки в самом начале
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
