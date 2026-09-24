// Lightweight DB client backend for the «Базы данных» module.
// Pure-JS / WASM drivers — NO native build: pg (Postgres), mysql2 (MySQL/MariaDB),
// sql.js (SQLite, WASM), ssh2 (optional SSH tunnel). Secrets encrypted via safeStorage.
//
// main.js wires this up: registerDbIpc({ ipcMain, safeStorage, getConnections, setConnections, dialog }).
const net = require('net');
const fs = require('fs');

// Драйверы грузятся при первом подключении, а не на старте редактора: pg + mysql2 + ssh2 — около
// 70 мс синхронной работы главного процесса до создания окна, а модулем БД пользуются не в каждом запуске.
let _pg = null, _mysql = null, _sqljs = null, _ssh2 = null;
const pgLib = () => _pg || (_pg = require('pg'));
const mysqlLib = () => _mysql || (_mysql = require('mysql2/promise'));
const sqlJsLib = () => _sqljs || (_sqljs = require('sql.js'));
const ssh2Lib = () => _ssh2 || (_ssh2 = require('ssh2'));
const { isReadOnlySql, sqlStatementCount } = require('./sqlro');

let _safe = null, _get = null, _set = null, _dialog = null;
const conns = new Map();     // connId -> live handle { type, pg|my|sq, tunnel, config }
let SQL = null;              // Promise<sql.js module> — ленивая инициализация, ровно одна на процесс

const DEFAULT_PORT = { postgres: 5432, mysql: 3306 };

// ---------------------------------------------------------------- secrets
function enc(text) {
  if (!text) return '';
  try { if (_safe && _safe.isEncryptionAvailable()) return 'v1:' + _safe.encryptString(text).toString('base64'); } catch (_) {}
  return 'b64:' + Buffer.from(String(text), 'utf8').toString('base64'); // fallback (no OS keyring): obfuscation only
}
function dec(blob) {
  if (!blob) return '';
  try {
    if (blob.startsWith('v1:')) return _safe.decryptString(Buffer.from(blob.slice(3), 'base64'));
    if (blob.startsWith('b64:')) return Buffer.from(blob.slice(4), 'base64').toString('utf8');
  } catch (_) {}
  return '';
}

// ---------------------------------------------------------------- store
function loadConns() { const a = _get(); return Array.isArray(a) ? a : []; }
function saveConns(a) { _set(a); }
// Strip secret blobs before sending to the renderer; expose only "has*" flags.
function publicConn(c) { const { passEnc, sshPassEnc, sshKeyEnc, ...rest } = c; return { ...rest, hasPass: !!passEnc, hasSshPass: !!sshPassEnc, hasSshKey: !!sshKeyEnc }; }
function publicList() { return loadConns().map(publicConn); }

// ---------------------------------------------------------------- SSH tunnel
// Open an SSH connection and a local TCP listener that forwards each socket to dbHost:dbPort
// over SSH. The driver then connects to 127.0.0.1:<localPort>.
function openTunnel(c, dbHost, dbPort) {
  return new Promise((resolve, reject) => {
    const ssh = new (ssh2Lib().Client)();
    let done = false;
    const fail = (e) => { if (!done) { done = true; try { ssh.end(); } catch (_) {} reject(e); } };
    ssh.on('error', fail);
    ssh.on('ready', () => {
      const server = net.createServer((sock) => {
        ssh.forwardOut('127.0.0.1', 0, dbHost, dbPort, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          stream.on('error', () => sock.destroy());
          sock.on('error', () => { try { stream.destroy(); } catch (_) {} });
        });
      });
      server.on('error', fail);
      ssh.on('close', () => { try { server.close(); } catch (_) {} }); // SSH died mid-session → drop the local listener
      server.listen(0, '127.0.0.1', () => { done = true; resolve({ ssh, server, port: /** @type {import('net').AddressInfo} */ (server.address()).port }); });
    });
    const cfg = { host: c.sshHost, port: +c.sshPort || 22, username: c.sshUser, readyTimeout: 15000, tryKeyboard: true };
    ssh.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => { const pw = dec(c.sshPassEnc); cb(prompts.map(() => pw || '')); });
    const key = dec(c.sshKeyEnc);
    const pw = dec(c.sshPassEnc);
    if (key) { cfg.privateKey = key; if (pw) cfg.passphrase = pw; }
    else if (pw) cfg.password = pw;
    else {
      // Секретов нет — как `ssh user@host`: системный агент + первый дефолтный ключ из ~/.ssh
      // (профили «Удалённых хостов» с auth=agent приезжают в префилл контейнеров именно такими).
      // Берём только ключ, который читается без пароля: зашифрованный (разблокирован в агенте) ssh2
      // не разбирает и бросает «Cannot parse privateKey» прямо в connect() — до агента не доходило.
      const sock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : null);
      if (sock) cfg.agent = sock;
      try {
        const dir = require('path').join(require('os').homedir(), '.ssh');
        for (const f of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
          const p = require('path').join(dir, f);
          if (!fs.existsSync(p)) continue;
          const buf = fs.readFileSync(p);
          if (ssh2Lib().utils.parseKey(buf) instanceof Error) continue;
          cfg.privateKey = buf; break;
        }
      } catch (_) {}
    }
    try { ssh.connect(cfg); } catch (e) { fail(e); }
  });
}

function closeTunnel(t) { if (!t) return; try { t.server.close(); } catch (_) {} try { t.ssh.end(); } catch (_) {} }

// ---------------------------------------------------------------- connect
// Postgres по умолчанию отдаёт даты объектами Date, bytea — Buffer, json — разобранным объектом,
// массивы — массивами. В рендерер это уезжало как есть: даты показывались в кавычках и в UTC,
// двойной клик по JSON-ячейке подставлял «[object Object]», а правка даты/массива/bytea уходила
// обратно в базу в формате, который она не принимает. Отдаём текст в формате самой СУБД (так же
// mysql2 работает с dateStrings) — его и видно, и можно вписать назад. Числа и bool — как раньше.
const PG_KEEP_PARSED = new Set([16, 20, 21, 23, 26, 700, 701, 1700]); // bool, int8, int2, int4, oid, float4, float8, numeric
const pgTypes = { getTypeParser: (oid, format) => (PG_KEEP_PARSED.has(oid) ? pgLib().types.getTypeParser(oid, format) : (v) => v) };
// MySQL: JSON — текстом (как хранится), остальное — стандартный разбор mysql2
const myTypeCast = (field, next) => (field.type === 'JSON' ? field.string('utf8') : next());

async function makeHandle(c) {
  let host = c.host || '127.0.0.1';
  let port = +c.port || DEFAULT_PORT[c.type] || 0;
  let tunnel = null;
  if (c.sshEnabled && c.type !== 'sqlite') { tunnel = await openTunnel(c, host, port); host = '127.0.0.1'; port = tunnel.port; }
  try {
    if (c.type === 'postgres') {
      const pg = new (pgLib().Client)({ host, port, user: c.user || undefined, password: dec(c.passEnc) || undefined,
        database: c.database || undefined, ssl: c.ssl ? { rejectUnauthorized: !c.sslInsecure, servername: c.host || undefined } : undefined, connectionTimeoutMillis: 15000, query_timeout: 60000, types: pgTypes });
      await pg.connect();
      if (c.readOnly) { try { await pg.query('SET default_transaction_read_only = on'); } catch (_) {} } // server-enforced
      return { type: 'postgres', pg, tunnel, config: c };
    }
    if (c.type === 'mysql') {
      const my = await mysqlLib().createConnection({ host, port, user: c.user || undefined, password: dec(c.passEnc) || undefined,
        database: c.database || undefined, ssl: c.ssl ? { rejectUnauthorized: !c.sslInsecure } : undefined, connectTimeout: 15000, multipleStatements: true, dateStrings: true, typeCast: myTypeCast });
      if (c.readOnly) { try { await my.query('SET SESSION TRANSACTION READ ONLY'); } catch (_) {} } // best-effort (regex backs it up)
      return { type: 'mysql', my, tunnel, config: c };
    }
    if (c.type === 'sqlite') {
      // Храним ОБЕЩАНИЕ инициализации, а не готовый модуль: два SQLite-подключения, открытые
      // параллельно, иначе оба видели бы SQL === null и грузили WASM дважды (лишний инстанс
      // в памяти, второй результат просто затирал первый).
      // Провал инициализации не залипает: сбрасываем, чтобы следующая попытка началась заново.
      if (!SQL) SQL = sqlJsLib()({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') }).catch((e) => { SQL = null; throw e; });
      const sqljs = await SQL;
      const file = c.file || c.database;
      const buf = fs.readFileSync(file);
      const sq = new sqljs.Database(buf);
      return { type: 'sqlite', sq, file, tunnel, config: c };
    }
  } catch (e) { closeTunnel(tunnel); throw e; }
  throw new Error('Неизвестный тип БД: ' + c.type);
}

// Открытие подключения асинхронно, поэтому в карту кладём ОБЕЩАНИЕ, а не готовый хэндл (как это
// делает пул admin-клиентов в lib/kafka.js). Иначе несколько запросов, ушедших параллельно до
// первого коннекта — а так открывается любая вкладка БД: схема, таблицы, связи, метаданные разом, —
// каждый промахивался мимо кэша и открывал СВОЁ соединение. В карте оставалось последнее, остальные
// утекали: живая сессия на сервере плюс, для профилей через SSH, туннель с занятым локальным портом,
// который уже некому закрыть. Для SQLite это было ещё и опасно: две независимые базы sql.js на один
// файл, и сброс из «забытой» мог перезаписать файл устаревшим снимком.
const pendingConns = new Map(); // id -> Promise<handle>, живёт только на время открытия
async function getHandle(id) {
  if (conns.has(id)) return conns.get(id);
  const inflight = pendingConns.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    const c = loadConns().find((x) => x.id === id);
    if (!c) throw new Error('Подключение не найдено');
    const h = await makeHandle(c);
    // A backend connection can drop async (idle timeout, server restart, network). pg/mysql2
    // clients then emit 'error'; with NO listener Node re-throws it as an uncaught exception →
    // crashes the main process. Swallow it and evict the cached handle so the next query reconnects.
    const evict = () => { if (conns.get(id) === h) { conns.delete(id); closeTunnel(h.tunnel); } };
    if (h.pg) h.pg.on('error', evict);
    if (h.my) h.my.on('error', evict);
    conns.set(id, h);
    return h;
  })();
  pendingConns.set(id, p);
  try { return await p; } finally { pendingConns.delete(id); }
}
// Одно соединение подключения делят все вкладки окна и агент AI-DB. Многошаговые операции нельзя
// перемежать чужими запросами: запрос соседней вкладки, пришедший между «BEGIN READ ONLY» агента и его
// SELECT, выполнился бы внутри read-only-транзакции, а COMMIT транзакции правок из грида закрыл бы
// транзакцию агента досрочно — и его запрос шёл бы уже без защиты СУБД (то же с SET SESSION
// max_execution_time у MySQL). Поэтому всё, что идёт в соединение, встаёт в очередь по одному.
// Скорость не теряется: pg.Client и соединение mysql2 и так выполняют запросы строго по одному.
function exclusive(h, fn) {
  const run = (h.chain || Promise.resolve()).then(() => fn(h));
  h.chain = run.catch(() => {});
  return run;
}
async function withConn(id, fn) { return exclusive(await getHandle(id), fn); }
function closeHandle(id) {
  const h = conns.get(id); if (!h) return;
  try { if (h.pg) h.pg.end(); } catch (_) {}
  try { if (h.my) h.my.end(); } catch (_) {}
  try { if (h.sq) h.sq.close(); } catch (_) {}
  closeTunnel(h.tunnel);
  conns.delete(id);
}
function closeAll() { for (const id of [...conns.keys()]) closeHandle(id); }

// ---------------------------------------------------------------- query helpers
// Map a driver-reported physical type to a coarse UI category so the grid can align/colour
// cells (numbers right, booleans badged, dates/json highlighted) without per-cell guessing.
// pg: dataTypeID (OID); mysql2: field.type (protocol code).
function pgCategory(oid) {
  if ([21, 23, 20, 700, 701, 1700, 26].includes(oid)) return 'number';
  if (oid === 16) return 'bool';
  if ([1082, 1114, 1184, 1083, 1266].includes(oid)) return 'date';
  if ([114, 3802].includes(oid)) return 'json';
  if (oid === 17) return 'bytes';
  return 'text';
}
function myCategory(code) {
  if ([0, 1, 2, 3, 4, 5, 8, 9, 13, 246].includes(code)) return 'number';
  if ([10, 12, 7, 11, 14].includes(code)) return 'date';
  if (code === 245) return 'json';
  if ([249, 250, 251, 252].includes(code)) return 'bytes';
  return 'text';
}
function sqliteCategories(values) {
  // sql.js returns native JS values; sniff the first non-null per column.
  if (!values.length) return null;
  const n = values[0].length; const cats = new Array(n).fill('text');
  for (let i = 0; i < n; i++) {
    for (const row of values) { const v = row[i]; if (v == null) continue; cats[i] = typeof v === 'number' ? 'number' : v instanceof Uint8Array ? 'bytes' : 'text'; break; }
  }
  return cats;
}

// Uniform result: { columns:[names], colTypes:[category], rows:[[...]], rowCount }. A result set
// with columns is a SELECT; an empty `columns` means a write/DDL (the renderer keys display off that).
async function rawQuery(h, sql) {
  if (h.type === 'postgres') {
    const r = await h.pg.query({ text: sql, rowMode: 'array' });
    const res = Array.isArray(r) ? r[r.length - 1] : r; // simple-protocol multi-statement → last result
    const fields = res.fields || [];
    return { columns: fields.map((f) => f.name), colTypes: fields.map((f) => pgCategory(f.dataTypeID)), rows: res.rows || [], rowCount: res.rowCount };
  }
  if (h.type === 'mysql') {
    let [rows, fields] = await h.my.query({ sql, rowsAsArray: true });
    // multipleStatements → mysql2 returns an array of result-sets with `fields` nested one level;
    // mirror the pg branch and report the last statement's result.
    if (Array.isArray(fields) && Array.isArray(fields[0])) { fields = fields[fields.length - 1]; rows = rows[rows.length - 1]; }
    if (Array.isArray(rows)) return { columns: (fields || []).map((f) => f.name), colTypes: (fields || []).map((f) => myCategory(f.type)), rows, rowCount: rows.length };
    return { columns: [], rows: [], rowCount: rows.affectedRows };
  }
  // sqlite — exec() runs all statements; a write returns no result set → report modified rows.
  const stmts = h.sq.exec(sql);
  if (!stmts.length) return { columns: [], rows: [], rowCount: h.sq.getRowsModified() };
  const last = stmts[stmts.length - 1];
  return { columns: last.columns, colTypes: sqliteCategories(last.values), rows: last.values, rowCount: last.values.length };
}
// Persist sqlite to disk after a write (sql.js is in-memory).
// Сброс базы SQLite на диск. Две вещи, которых тут раньше не было.
//   • Атомарность: sql.js отдаёт ВЕСЬ файл целиком, и обычный writeFileSync сперва обнуляет
//     базу — обрыв посреди записи (краш, ENOSPC, выключение) оставлял бы обрезанный .sqlite,
//     то есть уничтожал бы данные, а не только последнюю правку. Пишем соседа и rename(2),
//     права цели переносим.
//   • Честность: провал записи молча глотался, и человек получал «Применено» на изменение,
//     которого на диске нет — оно жило только в памяти до конца процесса. Теперь возвращаем
//     текст ошибки, а вызывающие его показывают.
// Возвращает null при успехе (и для не-sqlite соединений), иначе строку с ошибкой.
function flushSqlite(h) {
  if (h.type !== 'sqlite' || !h.file) return null;
  let target = h.file;
  try { if (fs.lstatSync(target).isSymbolicLink()) target = fs.realpathSync(target); } catch (_) {}
  let mode; try { mode = fs.statSync(target).mode & 0o777; } catch (_) {}
  const tmp = target + '.' + Math.random().toString(36).slice(2, 8) + '.lite-tmp';
  try {
    fs.writeFileSync(tmp, Buffer.from(h.sq.export()), mode == null ? undefined : { mode });
    if (mode != null) { try { fs.chmodSync(tmp, mode); } catch (_) {} }
    fs.renameSync(tmp, target);
    return null;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return 'Изменения применены в памяти, но НЕ записаны в файл базы: ' + String((e && e.message) || e);
  }
}

// Run a list of statements atomically — powers the grid edit buffer (UPDATE/INSERT/DELETE commit).
// All-or-nothing: any failure rolls back and the original error propagates.
// Элемент списка — строка SQL ЛИБО { sql, params:[…] }. Параметризованная форма обязательна там,
// где в оператор попадают ЗНАЧЕНИЯ ячеек: склейка строкой ломалась на обратном слэше в MySQL
// (backslash-escapes рвут литерал) и на строковых ключах вида "0123", которые эвристика «похоже
// на число» отправляла в SQL без кавычек — WHERE попадал не в ту строку.
async function runTransaction(h, statements) {
  const list = (statements || [])
    .map((s) => (typeof s === 'string'
      ? { sql: s, params: [] }
      : { sql: String((s && s.sql) || ''), params: Array.isArray(s && s.params) ? s.params : [] }))
    .filter((s) => s.sql.trim());
  if (!list.length) return { ok: true, count: 0 };
  if (h.type === 'postgres') {
    await h.pg.query('BEGIN');
    try { for (const s of list) await h.pg.query(s.params.length ? { text: s.sql, values: s.params } : s.sql); await h.pg.query('COMMIT'); }
    catch (e) { try { await h.pg.query('ROLLBACK'); } catch (_) {} throw e; }
  } else if (h.type === 'mysql') {
    await h.my.query('START TRANSACTION');
    try { for (const s of list) await (s.params.length ? h.my.query(s.sql, s.params) : h.my.query(s.sql)); await h.my.query('COMMIT'); }
    catch (e) { try { await h.my.query('ROLLBACK'); } catch (_) {} throw e; }
  } else {
    h.sq.exec('BEGIN');
    try {
      // sql.js: exec() не умеет bind — параметризованный оператор гоним через prepare/run
      for (const s of list) {
        if (!s.params.length) { h.sq.exec(s.sql); continue; }
        const st = h.sq.prepare(s.sql);
        try { st.run(s.params); } finally { try { st.free(); } catch (_) {} }
      }
      h.sq.exec('COMMIT');
    } catch (e) { try { h.sq.exec('ROLLBACK'); } catch (_) {} throw e; }
    const fe = flushSqlite(h);
    if (fe) return { ok: false, error: fe, count: list.length };   // «применено» без файла на диске — не успех
  }
  return { ok: true, count: list.length };
}

// Читающий запрос под защитой САМОЙ СУБД: транзакция READ ONLY (Postgres/MySQL) либо PRAGMA
// query_only (SQLite). Нужна там, где SQL сочинил не человек, а агент (вкладка AI-DB): регэксп —
// чёрный список и ловит опечатки, а транзакция ловит всё, включая write-CTE и функции с побочными
// эффектами. timeoutMs ограничивает время выполнения (тяжёлое чтение на бою — тоже инцидент).
async function readOnlyQuery(h, sql, opts = {}) {
  const timeoutMs = Math.max(0, Math.round(Number(opts.timeoutMs) || 0));
  if (h.type === 'postgres') {
    await h.pg.query('BEGIN READ ONLY');
    try {
      if (timeoutMs) await h.pg.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const r = await rawQuery(h, sql);
      await h.pg.query('COMMIT');
      return r;
    } catch (e) { try { await h.pg.query('ROLLBACK'); } catch (_) {} throw e; }
  }
  if (h.type === 'mysql') {
    // max_execution_time есть в MySQL 5.7.8+, у MariaDB переменная называется иначе — поэтому
    // таймаут ставим best-effort: не поддержали его, зато READ ONLY отработает в любом случае.
    if (timeoutMs) { try { await h.my.query(`SET SESSION max_execution_time = ${timeoutMs}`); } catch (_) {} }
    await h.my.query('START TRANSACTION READ ONLY');
    try { const r = await rawQuery(h, sql); await h.my.query('COMMIT'); return r; }
    catch (e) { try { await h.my.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { if (timeoutMs) { try { await h.my.query('SET SESSION max_execution_time = 0'); } catch (_) {} } }
  }
  h.sq.exec('PRAGMA query_only = 1');
  try { return await rawQuery(h, sql); }
  finally { try { h.sq.exec('PRAGMA query_only = 0'); } catch (_) {} }
}

// Secondary client-side guard (the server-side read-only session is the real enforcer).
// Strip comments + string/quoted-identifier literals first so a keyword inside a value
// (e.g. SELECT 'I do this') doesn't trip it.

// identifier quoting per dialect
function q(type, id) {
  if (type === 'mysql') return '`' + String(id).replace(/`/g, '``') + '`';
  return '"' + String(id).replace(/"/g, '""') + '"';
}
function qualified(type, schema, table) {
  if (type === 'sqlite') return q(type, table);
  return (schema ? q(type, schema) + '.' : '') + q(type, table);
}

// ---------------------------------------------------------------- schema / data
async function listSchema(h) {
  if (h.type === 'postgres') {
    const r = await h.pg.query({ text: `SELECT table_schema, table_name, table_type FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`, rowMode: 'array' });
    return groupSchema(r.rows, 'postgres');
  }
  if (h.type === 'mysql') {
    const [rows] = await h.my.query({ sql: `SELECT table_schema, table_name, table_type FROM information_schema.tables
      WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1,2`, rowsAsArray: true });
    return groupSchema(rows, 'mysql');
  }
  const res = h.sq.exec(`SELECT 'main' AS s, name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  return groupSchema(res.length ? res[0].values : [], 'sqlite');
}
function groupSchema(rows, _type) {
  const map = new Map();
  for (const [schema, table, ttype] of rows) {
    if (!map.has(schema)) map.set(schema, []);
    map.get(schema).push({ name: table, view: /view/i.test(ttype || '') });
  }
  return { schemas: [...map.entries()].map(([name, tables]) => ({ name, tables })) };
}
// Server-side ORDER BY / WHERE so sorting and filtering work on the whole table, not just the
// loaded page. `orderBy` is quoted as an identifier; `where` is a raw predicate the user typed —
// appended verbatim after WHERE once it is checked to be a single statement (and read-only on readOnly).
async function tableData(h, schema, table, { limit = 200, offset = 0, orderBy = null, orderDir = 'asc', where = '' } = {}, cap = 5000) {
  const tq = qualified(h.type, schema, table);
  const lim = Math.max(1, Math.min(cap, +limit || 200));
  const off = Math.max(0, +offset || 0);
  let whereSql = '';
  if (where && String(where).trim()) {
    const w = String(where).trim();
    // Фильтр — одно условие. «1=1; DELETE FROM t» уходило в драйвер вторым оператором (MySQL и SQLite
    // выполняют их по очереди), а на подключении «только чтение» этот путь вообще не проверялся.
    if (sqlStatementCount(w, h.type) > 1) throw new Error('Фильтр WHERE — одно условие, без «;».');
    if (h.config && h.config.readOnly && !isReadOnlySql(w, h.type)) throw new Error('Подключение в режиме «только чтение» — изменяющие запросы запрещены.');
    whereSql = ' WHERE ' + w;
  }
  let orderSql = '';
  if (orderBy) { const dir = String(orderDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'; orderSql = ` ORDER BY ${q(h.type, orderBy)} ${dir}`; }
  const data = await rawQuery(h, `SELECT * FROM ${tq}${whereSql}${orderSql} LIMIT ${lim} OFFSET ${off}`);
  let total = null;
  try { const c = await rawQuery(h, `SELECT COUNT(*) FROM ${tq}${whereSql}`); total = Number(c.rows[0] && c.rows[0][0]); } catch (_) {}
  return { ...data, total, limit: lim, offset: off };
}

// Fetch the whole table (capped) for export — separate from the paged grid view.
// Предел страницы грида (5000) сюда не относится: раньше выгрузка «всей таблицы» молча обрезалась
// до 5000 строк. Потолок выгрузки — EXPORT_MAX; total в ответе даёт интерфейсу сказать, если обрезано.
const EXPORT_MAX = 100000;
async function fetchAll(h, schema, table, { where = '', orderBy = null, orderDir = 'asc' } = {}) {
  return tableData(h, schema, table, { limit: EXPORT_MAX, offset: 0, where, orderBy, orderDir }, EXPORT_MAX);
}

// ---------------------------------------------------------------- table metadata (columns/PK/FK/indexes/DDL)
async function tableMeta(h, schema, table) {
  if (h.type === 'postgres') return pgTableMeta(h, schema, table);
  if (h.type === 'mysql') return myTableMeta(h, schema, table);
  return sqliteTableMeta(h, table);
}

async function pgTableMeta(h, schema, table) {
  const sch = schema || 'public';
  const cols = (await h.pg.query({
    text: `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
             pg_get_expr(ad.adbin, ad.adrelid) AS dflt, a.attnum,
             COALESCE(a.attidentity <> '' OR pg_get_expr(ad.adbin, ad.adrelid) LIKE 'nextval%', false) AS autoinc
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
           WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY a.attnum`, values: [sch, table], rowMode: 'array' })).rows;
  const pk = (await h.pg.query({
    text: `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2`, values: [sch, table], rowMode: 'array' })).rows.map((r) => r[0]);
  // Внешние ключи — из pg_constraint: conkey/confkey идут парами по порядку. information_schema
  // соединял колонки только по имени ограничения — у составного FK получалось декартово произведение
  // (обе колонки «ссылались» на одну), а одноимённые ограничения из разных схем склеивались.
  const fks = (await h.pg.query({
    text: `SELECT a.attname, fn.nspname, ft.relname, fa.attname, c.conname, k.n
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_class ft ON ft.oid = c.confrelid JOIN pg_namespace fn ON fn.oid = ft.relnamespace
           CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(att, fatt, n)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
           JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
           WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2
           ORDER BY c.conname, k.n`, values: [sch, table], rowMode: 'array' })).rows;
  const fkMap = new Map(fks.map((r) => [r[0], { schema: r[1], table: r[2], column: r[3] }]));
  const fkGroups = new Map();   // conname → { cols, refSchema, refTable, refCols } — для DDL составного FK
  for (const r of fks) {
    const g = fkGroups.get(r[4]) || { cols: [], refSchema: r[1], refTable: r[2], refCols: [] };
    g.cols.push(r[0]); g.refCols.push(r[3]); fkGroups.set(r[4], g);
  }
  const pkSet = new Set(pk);
  const columns = cols.map((r) => ({ name: r[0], type: r[1], nullable: !r[2], default: r[3], pk: pkSet.has(r[0]), fk: fkMap.get(r[0]) || null, autoinc: !!r[5] }));
  const idx = (await h.pg.query({
    text: `SELECT i.relname, ix.indisunique, ix.indisprimary, array_to_string(array_agg(a.attname ORDER BY x.n), ',')
           FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON true
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
           WHERE n.nspname = $1 AND t.relname = $2 GROUP BY i.relname, ix.indisunique, ix.indisprimary`, values: [sch, table], rowMode: 'array' })).rows;
  const indexes = idx.map((r) => ({ name: r[0], unique: r[1], primary: r[2], columns: String(r[3]).split(',') }));
  // a view/matview gets its real definition rather than a synthetic CREATE TABLE
  const rk = (await h.pg.query({ text: `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, values: [sch, table], rowMode: 'array' })).rows[0];
  let ddl;
  if (rk && (rk[0] === 'v' || rk[0] === 'm')) {
    const def = (await h.pg.query({ text: `SELECT pg_get_viewdef($1::regclass, true)`, values: [`${q('postgres', sch)}.${q('postgres', table)}`], rowMode: 'array' })).rows[0];
    ddl = `CREATE ${rk[0] === 'm' ? 'MATERIALIZED ' : ''}VIEW ${q('postgres', sch)}.${q('postgres', table)} AS\n${def ? def[0] : ''}`;
  } else ddl = buildPgDdl(h.type, sch, table, columns, pk, indexes, fkGroups);
  return { schema: sch, table, columns, indexes, ddl };
}

function buildPgDdl(type, schema, table, columns, pk, indexes, fkGroups) {
  const lines = columns.map((c) => `  ${q(type, c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ' DEFAULT ' + c.default : ''}`);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => q(type, c)).join(', ')})`);
  // одно ограничение — одна строка, даже если колонок несколько; ссылка — со схемой
  for (const [name, g] of fkGroups || []) lines.push(`  CONSTRAINT ${q(type, name)} FOREIGN KEY (${g.cols.map((c) => q(type, c)).join(', ')}) REFERENCES ${q(type, g.refSchema)}.${q(type, g.refTable)} (${g.refCols.map((c) => q(type, c)).join(', ')})`);
  let ddl = `CREATE TABLE ${q(type, schema)}.${q(type, table)} (\n${lines.join(',\n')}\n);`;
  for (const i of indexes) if (!i.primary) ddl += `\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(type, i.name)} ON ${q(type, schema)}.${q(type, table)} (${i.columns.map((c) => q(type, c)).join(', ')});`;
  return ddl;
}

async function myTableMeta(h, schema, table) {
  const sch = schema || (h.config && h.config.database);
  const [cols] = await h.my.query({ sql: `SELECT column_name, column_type, is_nullable, column_default, column_key, extra
    FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, values: [sch, table], rowsAsArray: true });
  const [fks] = await h.my.query({ sql: `SELECT column_name, referenced_table_schema, referenced_table_name, referenced_column_name
    FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`, values: [sch, table], rowsAsArray: true });
  const fkMap = new Map(fks.map((r) => [r[0], { schema: r[1], table: r[2], column: r[3] }]));
  const columns = cols.map((r) => ({ name: r[0], type: r[1], nullable: r[2] === 'YES', default: r[3], pk: r[4] === 'PRI', fk: fkMap.get(r[0]) || null, autoinc: /auto_increment/i.test(r[5] || '') }));
  const [idx] = await h.my.query({ sql: `SELECT index_name, NOT non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index)
    FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name, non_unique`, values: [sch, table], rowsAsArray: true });
  const indexes = idx.map((r) => ({ name: r[0], unique: !!r[1], primary: r[0] === 'PRIMARY', columns: String(r[2]).split(',') }));
  let ddl = '';
  try { const [cr] = await h.my.query({ sql: `SHOW CREATE TABLE ${qualified('mysql', sch, table)}`, rowsAsArray: true }); ddl = cr[0] && (cr[0][1] || cr[0][0]); } catch (_) {}
  return { schema: sch, table, columns, indexes, ddl };
}

async function sqliteTableMeta(h, table) {
  const info = h.sq.exec(`PRAGMA table_info(${q('sqlite', table)})`);
  const fkl = h.sq.exec(`PRAGMA foreign_key_list(${q('sqlite', table)})`);
  const idxl = h.sq.exec(`PRAGMA index_list(${q('sqlite', table)})`);
  const fkMap = new Map();
  if (fkl.length) for (const r of fkl[0].values) fkMap.set(r[3], { schema: null, table: r[2], column: r[4] }); // from→table.to
  const columns = info.length ? info[0].values.map((r) => ({ name: r[1], type: r[2] || '', nullable: !r[3], default: r[4], pk: !!r[5], fk: fkMap.get(r[1]) || null, autoinc: false })) : [];
  const indexes = [];
  if (idxl.length) for (const r of idxl[0].values) {
    const ic = h.sq.exec(`PRAGMA index_info(${q('sqlite', r[1])})`);
    indexes.push({ name: r[1], unique: !!r[2], primary: r[3] === 'pk', columns: ic.length ? ic[0].values.map((x) => x[2]) : [] });
  }
  let ddl = '';
  // имя — параметром, а не вклейкой в текст (вклейка с регуляркой внутри ${} ещё и сбивала экстрактор переводов:
  // он читал всё до конца файла как одну строку, и ошибки модуля оставались без перевода)
  try { const r = h.sq.exec('SELECT sql FROM sqlite_master WHERE name = ?', [String(table)]); ddl = r.length && r[0].values[0] ? r[0].values[0][0] : ''; } catch (_) {}
  return { schema: null, table, columns, indexes, ddl };
}

// Every column in the database in one round-trip → powers SQL autocomplete (table → [columns]).
async function allColumns(h) {
  const map = {}; // "schema.table" -> [colName]
  const push = (schema, table, col) => { const k = (schema ? schema + '.' : '') + table; (map[k] = map[k] || []).push(col); };
  if (h.type === 'postgres') {
    const r = await h.pg.query({ text: `SELECT table_schema, table_name, column_name FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position`, rowMode: 'array' });
    for (const [s, t, c] of r.rows) push(s, t, c);
  } else if (h.type === 'mysql') {
    const [rows] = await h.my.query({ sql: `SELECT table_schema, table_name, column_name FROM information_schema.columns
      WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY table_schema, table_name, ordinal_position`, rowsAsArray: true });
    for (const [s, t, c] of rows) push(s, t, c);
  } else {
    const tabs = h.sq.exec(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`);
    if (tabs.length) for (const [name] of tabs[0].values) { const info = h.sq.exec(`PRAGMA table_info(${q('sqlite', name)})`); if (info.length) for (const row of info[0].values) push(null, name, row[1]); }
  }
  return { columns: map };
}

// Functions, sequences and per-table row estimates — feeds extra tree folders + row badges.
async function objects(h) {
  if (h.type === 'postgres') {
    const fn = (await h.pg.query({ text: `SELECT n.nspname, p.proname, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f', 'p') ORDER BY 1,2`, rowMode: 'array' })).rows;
    const sq = (await h.pg.query({ text: `SELECT sequence_schema, sequence_name FROM information_schema.sequences ORDER BY 1,2`, rowMode: 'array' })).rows;
    const est = (await h.pg.query({ text: `SELECT n.nspname, c.relname, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`, rowMode: 'array' })).rows;
    const rowEstimates = {}; for (const [s, t, n] of est) rowEstimates[s + '.' + t] = Number(n);
    return { functions: fn.map((r) => ({ schema: r[0], name: r[1], kind: r[2] === 'p' ? 'procedure' : 'function' })), sequences: sq.map((r) => ({ schema: r[0], name: r[1] })), rowEstimates };
  }
  if (h.type === 'mysql') {
    const db = h.config && h.config.database;
    const [fn] = await h.my.query({ sql: `SELECT routine_schema, routine_name, routine_type FROM information_schema.routines
      WHERE routine_schema NOT IN ('mysql','information_schema','performance_schema','sys')${db ? ' AND routine_schema = ?' : ''} ORDER BY 1,2`, values: db ? [db] : [], rowsAsArray: true });
    const [est] = await h.my.query({ sql: `SELECT table_schema, table_name, table_rows FROM information_schema.tables WHERE table_type='BASE TABLE'
      AND table_schema NOT IN ('mysql','information_schema','performance_schema','sys')`, rowsAsArray: true });
    const rowEstimates = {}; for (const [s, t, n] of est) rowEstimates[s + '.' + t] = Number(n);
    return { functions: fn.map((r) => ({ schema: r[0], name: r[1], kind: (r[2] || '').toLowerCase() === 'procedure' ? 'procedure' : 'function' })), sequences: [], rowEstimates };
  }
  return { functions: [], sequences: [], rowEstimates: {} };
}

// DDL for a non-table object (view handled by tableMeta; here: function/procedure/sequence).
async function objectDdl(h, schema, name, kind) {
  if (h.type === 'postgres') {
    if (kind === 'sequence') {
      const r = await h.pg.query({ text: `SELECT 'CREATE SEQUENCE ' || quote_ident($1) || '.' || quote_ident($2) ||
        ' INCREMENT ' || increment_by || ' MINVALUE ' || min_value || ' MAXVALUE ' || max_value || ' START ' || start_value
        FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, values: [schema, name], rowMode: 'array' });
      return r.rows[0] ? r.rows[0][0] : '';
    }
    const r = await h.pg.query({ text: `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`, values: [schema, name], rowMode: 'array' });
    return r.rows[0] ? r.rows[0][0] : '';
  }
  if (h.type === 'mysql') {
    const what = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    const [r] = await h.my.query({ sql: `SHOW CREATE ${what} ${qualified('mysql', schema, name)}`, rowsAsArray: true });
    if (!r[0]) return '';
    // текст подпрограммы MySQL показывает только владельцу или с привилегией SHOW_ROUTINE — иначе NULL
    if (r[0][2]) return r[0][2];
    return kind === 'procedure'
      ? '-- Текст процедуры недоступен: MySQL показывает его только владельцу (DEFINER) или пользователю с привилегией SHOW_ROUTINE.'
      : '-- Текст функции недоступен: MySQL показывает его только владельцу (DEFINER) или пользователю с привилегией SHOW_ROUTINE.';
  }
  return '';
}

// On-disk size + estimated row count for a table.
async function objectInfo(h, schema, table) {
  if (h.type === 'postgres') {
    const r = await h.pg.query({ text: `SELECT pg_total_relation_size($1::regclass), (SELECT reltuples::bigint FROM pg_class WHERE oid = $1::regclass)`,
      values: [`${q('postgres', schema || 'public')}.${q('postgres', table)}`], rowMode: 'array' });
    return { size: Number(r.rows[0][0]), rows: Number(r.rows[0][1]) };
  }
  if (h.type === 'mysql') {
    const [r] = await h.my.query({ sql: `SELECT data_length + index_length, table_rows FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, values: [schema || (h.config && h.config.database), table], rowsAsArray: true });
    return r[0] ? { size: Number(r[0][0]), rows: Number(r[0][1]) } : { size: null, rows: null };
  }
  return { size: null, rows: null };
}

// All foreign-key relations in the database — feeds the ER diagram.
async function relations(h) {
  if (h.type === 'postgres') {
    // pg_constraint, а не information_schema — см. pgTableMeta: пары колонок составного FK и схема
    const r = await h.pg.query({ text: `SELECT n.nspname, t.relname, a.attname, fn.nspname, ft.relname, fa.attname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid JOIN pg_namespace fn ON fn.oid = ft.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(att, fatt)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
      JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
      WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog','information_schema')`, rowMode: 'array' });
    return r.rows.map((x) => ({ fromSchema: x[0], fromTable: x[1], fromColumn: x[2], toSchema: x[3], toTable: x[4], toColumn: x[5] }));
  }
  if (h.type === 'mysql') {
    const [rows] = await h.my.query({ sql: `SELECT table_schema, table_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name
      FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL AND table_schema NOT IN ('mysql','information_schema','performance_schema','sys')`, rowsAsArray: true });
    return rows.map((x) => ({ fromSchema: x[0], fromTable: x[1], fromColumn: x[2], toSchema: x[3], toTable: x[4], toColumn: x[5] }));
  }
  // sqlite — walk each table's foreign_key_list
  const out = [];
  const tabs = h.sq.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
  if (tabs.length) for (const [name] of tabs[0].values) {
    const fkl = h.sq.exec(`PRAGMA foreign_key_list(${q('sqlite', name)})`);
    if (fkl.length) for (const r of fkl[0].values) out.push({ fromSchema: null, fromTable: name, fromColumn: r[3], toSchema: null, toTable: r[2], toColumn: r[4] });
  }
  return out;
}

// Cancel the in-flight query on a connection: open a throwaway control connection and ask the
// server to cancel/kill the backend running our session. SQLite is synchronous → nothing to cancel.
async function cancelQuery(id) {
  const h = conns.get(id);
  if (!h) return { ok: false, error: 'нет активного подключения' };
  const c = loadConns().find((x) => x.id === id);
  if (!c) return { ok: false, error: 'подключение не найдено' };
  try {
    if (h.type === 'postgres' && h.pg.processID) {
      const ctl = await makeHandle(c);
      try { await ctl.pg.query('SELECT pg_cancel_backend($1)', [h.pg.processID]); }
      finally { try { ctl.pg.end(); } catch (_) {} closeTunnel(ctl.tunnel); }
      return { ok: true };
    }
    if (h.type === 'mysql' && h.my.threadId) {
      const ctl = await makeHandle(c);
      try { await ctl.my.query('KILL QUERY ' + (+h.my.threadId)); }
      finally { try { ctl.my.end(); } catch (_) {} closeTunnel(ctl.tunnel); }
      return { ok: true };
    }
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: false, error: 'отмена не поддерживается для этого типа' };
}

// ---------------------------------------------------------------- IPC
/** @param {{ ipcMain: import('electron').IpcMain, safeStorage?: any, getConnections?: any, setConnections?: any, dialog?: any }} deps */
function registerDbIpc({ ipcMain, safeStorage, getConnections, setConnections, dialog }) {
  _safe = safeStorage; _get = getConnections; _set = setConnections; _dialog = dialog;

  ipcMain.handle('db:list', () => ({ connections: publicList(), secure: !!(safeStorage && safeStorage.isEncryptionAvailable()) }));

  // Save (create/update). Plain passwords come in only when changed; absent → keep existing blob.
  ipcMain.handle('db:save', (_e, { conn } = {}) => {
    if (!conn || !conn.type) return { error: 'нет данных подключения' };
    const list = loadConns();
    const idx = conn.id ? list.findIndex((x) => x.id === conn.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...conn };
    delete rec.hasPass; delete rec.hasSshPass; delete rec.hasSshKey;
    if (conn.password != null) rec.passEnc = conn.password ? enc(conn.password) : '';
    if (conn.sshPassword != null) rec.sshPassEnc = conn.sshPassword ? enc(conn.sshPassword) : '';
    if (conn.sshKey != null) rec.sshKeyEnc = conn.sshKey ? enc(conn.sshKey) : '';
    delete rec.password; delete rec.sshPassword; delete rec.sshKey;
    if (!rec.id) rec.id = 'db' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveConns(list);
    closeHandle(rec.id); // params may have changed → drop cached connection
    return { ok: true, id: rec.id, connection: publicConn(rec) };
  });
  ipcMain.handle('db:delete', (_e, { id } = {}) => { closeHandle(id); saveConns(loadConns().filter((x) => x.id !== id)); return { ok: true }; });

  // Test connection. Typed form fields override saved ones; secrets use the typed value if
  // provided, else fall back to the saved encrypted blob (so you can test without re-typing).
  ipcMain.handle('db:test', async (_e, { conn } = {}) => {
    const saved = conn && conn.id ? (loadConns().find((x) => x.id === conn.id) || {}) : {};
    const cfg = { ...saved, ...conn };
    cfg.passEnc = conn && conn.password != null ? (conn.password ? enc(conn.password) : '') : (saved.passEnc || '');
    // фолбэк «cfg.*» (а не только saved): черновик из «Контейнеров» может нести уже-шифрованные блобы
    // sshPassEnc/sshKeyEnc rh-профиля — их нельзя затирать пустотой
    cfg.sshPassEnc = conn && conn.sshPassword != null ? (conn.sshPassword ? enc(conn.sshPassword) : '') : (cfg.sshPassEnc || '');
    cfg.sshKeyEnc = conn && conn.sshKey != null ? (conn.sshKey ? enc(conn.sshKey) : '') : (cfg.sshKeyEnc || '');
    let h;
    try {
      h = await makeHandle(cfg);
      let version = '';
      try {
        if (h.type === 'postgres') { const r = await h.pg.query('SELECT version()'); version = String(r.rows[0].version).split(',')[0]; }
        else if (h.type === 'mysql') { const [r] = await h.my.query('SELECT version() v'); version = 'MySQL ' + r[0].v; }
        else { const r = h.sq.exec('SELECT sqlite_version()'); version = 'SQLite ' + (r[0] && r[0].values[0][0]); }
      } catch (_) {}
      return { ok: true, version };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
    finally { if (h) { try { if (h.pg) h.pg.end(); if (h.my) h.my.end(); if (h.sq) h.sq.close(); } catch (_) {} closeTunnel(h.tunnel); } }
  });

  ipcMain.handle('db:schema', async (_e, { id } = {}) => { try { return await withConn(id, listSchema); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:tableData', async (_e, { id, schema, table, ...opts } = {}) => { try { return await withConn(id, (h) => tableData(h, schema, table, opts)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:tableMeta', async (_e, { id, schema, table } = {}) => { try { return await withConn(id, (h) => tableMeta(h, schema, table)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:relations', async (_e, { id } = {}) => { try { return { relations: await withConn(id, relations) }; } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:columns', async (_e, { id } = {}) => { try { return await withConn(id, allColumns); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:objects', async (_e, { id } = {}) => { try { return await withConn(id, objects); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:objectDdl', async (_e, { id, schema, name, kind } = {}) => { try { return { ddl: await withConn(id, (h) => objectDdl(h, schema, name, kind)) }; } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:objectInfo', async (_e, { id, schema, table } = {}) => { try { return await withConn(id, (h) => objectInfo(h, schema, table)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:fetchAll', async (_e, { id, schema, table, ...opts } = {}) => { try { return await withConn(id, (h) => fetchAll(h, schema, table, opts)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:cancel', async (_e, { id } = {}) => { try { return await cancelQuery(id); } catch (e) { return { ok: false, error: String(e.message || e) }; } });
  ipcMain.handle('db:ping', async (_e, { id } = {}) => {
    try { await withConn(id, async (h) => { if (h.type === 'postgres') await h.pg.query('SELECT 1'); else if (h.type === 'mysql') await h.my.query('SELECT 1'); else h.sq.exec('SELECT 1'); }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('db:reconnect', async (_e, { id } = {}) => {
    try { closeHandle(id); await getHandle(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('db:transaction', async (_e, { id, statements } = {}) => {
    try {
      const h = await getHandle(id);
      if (h.config && h.config.readOnly) return { ok: false, error: 'Подключение в режиме «только чтение».' };
      return await exclusive(h, () => runTransaction(h, statements));
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // Run arbitrary SQL. readOnly connections refuse destructive statements.
  ipcMain.handle('db:query', async (_e, { id, sql } = {}) => {
    try {
      const h = await getHandle(id);
      if (h.config && h.config.readOnly && !isReadOnlySql(sql, h.type)) return { error: 'Подключение в режиме «только чтение» — изменяющие запросы запрещены.' };
      return await exclusive(h, async () => {
        const r = await rawQuery(h, sql);
        // Persist SQLite after any modifying SQL — keyed off the statement text, because a
        // multi-statement run ending in SELECT (e.g. «INSERT …; SELECT …») returns a result set
        // yet still mutated the in-memory DB; flushSqlite() no-ops for non-sqlite handles.
        const fe = isReadOnlySql(sql, h.type) ? null : flushSqlite(h);
        return fe ? { ...r, error: fe } : r;
      });
    } catch (e) { return { error: String(e.message || e) }; }
  });

  // Читающий запрос для вкладки AI-DB: гарантия read-only даёт сама СУБД (см. readOnlyQuery),
  // регэксп-фильтр стоит перед ней вторым эшелоном.
  ipcMain.handle('db:queryRo', async (_e, { id, sql, timeoutMs } = {}) => {
    try {
      return await withConn(id, (h) => {
        if (!isReadOnlySql(sql, h.type)) return { error: 'Разрешены только читающие запросы.' };
        // Ровно один оператор: «SELECT …; COMMIT; …» закрывал READ ONLY-транзакцию посередине, и хвост
        // выполнялся уже без защиты СУБД. Агенту и так велено давать один запрос.
        if (sqlStatementCount(sql, h.type) > 1) return { error: 'Разрешён один запрос за раз — без «;» между операторами.' };
        return readOnlyQuery(h, sql, { timeoutMs });
      });
    } catch (e) { return { error: String(e.message || e) }; }
  });

  // Save text (CSV/JSON/SQL export) to a user-chosen file.
  ipcMain.handle('db:saveText', async (_e, { defaultName, text } = {}) => {
    const r = await _dialog.showSaveDialog({ defaultPath: defaultName || 'export.csv' });
    if (r.canceled || !r.filePath) return { canceled: true };
    try { fs.writeFileSync(r.filePath, text != null ? String(text) : ''); return { ok: true, path: r.filePath }; }
    catch (e) { return { error: String(e.message || e) }; }
  });

  // Pick a destination directory (export modal remembers it on the renderer side).
  ipcMain.handle('db:chooseDir', async () => {
    const r = await _dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  // Open a SQL/text file → returns its content (the renderer loads it into the SQL editor).
  ipcMain.handle('db:openText', async () => {
    const r = await _dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }, { name: 'Все файлы', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
    try { return { ok: true, path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') }; }
    catch (e) { return { error: String(e.message || e) }; }
  });

  return { closeAll };
}

module.exports = { registerDbIpc };
