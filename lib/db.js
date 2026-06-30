// Lightweight DB client backend for the «Базы данных» module.
// Pure-JS / WASM drivers — NO native build: pg (Postgres), mysql2 (MySQL/MariaDB),
// sql.js (SQLite, WASM), ssh2 (optional SSH tunnel). Secrets encrypted via safeStorage.
//
// main.js wires this up: registerDbIpc({ ipcMain, safeStorage, getConnections, setConnections, dialog }).
const net = require('net');
const fs = require('fs');

const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const initSqlJs = require('sql.js');
const { Client: SshClient } = require('ssh2');

let _safe = null, _get = null, _set = null, _dialog = null;
const conns = new Map();     // connId -> live handle { type, pg|my|sq, tunnel, config }
let SQL = null;              // sql.js module (lazy-initialised once)

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
    const ssh = new SshClient();
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
      server.listen(0, '127.0.0.1', () => { done = true; resolve({ ssh, server, port: server.address().port }); });
    });
    const cfg = { host: c.sshHost, port: +c.sshPort || 22, username: c.sshUser, readyTimeout: 15000 };
    const key = dec(c.sshKeyEnc);
    if (key) { cfg.privateKey = key; const pp = dec(c.sshPassEnc); if (pp) cfg.passphrase = pp; }
    else cfg.password = dec(c.sshPassEnc);
    try { ssh.connect(cfg); } catch (e) { fail(e); }
  });
}

function closeTunnel(t) { if (!t) return; try { t.server.close(); } catch (_) {} try { t.ssh.end(); } catch (_) {} }

// ---------------------------------------------------------------- connect
async function makeHandle(c) {
  let host = c.host || '127.0.0.1';
  let port = +c.port || DEFAULT_PORT[c.type] || 0;
  let tunnel = null;
  if (c.sshEnabled && c.type !== 'sqlite') { tunnel = await openTunnel(c, host, port); host = '127.0.0.1'; port = tunnel.port; }
  try {
    if (c.type === 'postgres') {
      const pg = new PgClient({ host, port, user: c.user || undefined, password: dec(c.passEnc) || undefined,
        database: c.database || undefined, ssl: c.ssl ? { rejectUnauthorized: !c.sslInsecure, servername: c.host || undefined } : undefined, connectionTimeoutMillis: 15000, query_timeout: 60000 });
      await pg.connect();
      if (c.readOnly) { try { await pg.query('SET default_transaction_read_only = on'); } catch (_) {} } // server-enforced
      return { type: 'postgres', pg, tunnel, config: c };
    }
    if (c.type === 'mysql') {
      const my = await mysql.createConnection({ host, port, user: c.user || undefined, password: dec(c.passEnc) || undefined,
        database: c.database || undefined, ssl: c.ssl ? { rejectUnauthorized: !c.sslInsecure } : undefined, connectTimeout: 15000, multipleStatements: true, dateStrings: true });
      if (c.readOnly) { try { await my.query('SET SESSION TRANSACTION READ ONLY'); } catch (_) {} } // best-effort (regex backs it up)
      return { type: 'mysql', my, tunnel, config: c };
    }
    if (c.type === 'sqlite') {
      if (!SQL) SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
      const file = c.file || c.database;
      const buf = fs.readFileSync(file);
      const sq = new SQL.Database(buf);
      return { type: 'sqlite', sq, file, tunnel, config: c };
    }
  } catch (e) { closeTunnel(tunnel); throw e; }
  throw new Error('Неизвестный тип БД: ' + c.type);
}

async function getHandle(id) {
  if (conns.has(id)) return conns.get(id);
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
}
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
function flushSqlite(h) { try { if (h.type === 'sqlite' && h.file) fs.writeFileSync(h.file, Buffer.from(h.sq.export())); } catch (_) {} }

// Run a list of statements atomically — powers the grid edit buffer (UPDATE/INSERT/DELETE commit).
// All-or-nothing: any failure rolls back and the original error propagates.
async function runTransaction(h, statements) {
  const list = (statements || []).filter((s) => s && String(s).trim());
  if (!list.length) return { ok: true, count: 0 };
  if (h.type === 'postgres') {
    await h.pg.query('BEGIN');
    try { for (const s of list) await h.pg.query(s); await h.pg.query('COMMIT'); }
    catch (e) { try { await h.pg.query('ROLLBACK'); } catch (_) {} throw e; }
  } else if (h.type === 'mysql') {
    await h.my.query('START TRANSACTION');
    try { for (const s of list) await h.my.query(s); await h.my.query('COMMIT'); }
    catch (e) { try { await h.my.query('ROLLBACK'); } catch (_) {} throw e; }
  } else {
    h.sq.exec('BEGIN');
    try { for (const s of list) h.sq.exec(s); h.sq.exec('COMMIT'); }
    catch (e) { try { h.sq.exec('ROLLBACK'); } catch (_) {} throw e; }
    flushSqlite(h);
  }
  return { ok: true, count: list.length };
}

// Secondary client-side guard (the server-side read-only session is the real enforcer).
// Strip comments + string/quoted-identifier literals first so a keyword inside a value
// (e.g. SELECT 'I do this') doesn't trip it.
// NB: `replace` is intentionally absent — every destructive REPLACE already trips another token
// (`REPLACE INTO` → into, `CREATE OR REPLACE` → create), and listing it would block the read-only
// `SELECT REPLACE(col,'a','b')` string function as if it were a write.
const DESTRUCTIVE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|call|do|vacuum|reindex|attach|detach|lock|rename|into|load|handler)\b/i;
function isReadOnlySql(sql) {
  const s = String(sql).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  return !DESTRUCTIVE.test(s);
}

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
function groupSchema(rows, type) {
  const map = new Map();
  for (const [schema, table, ttype] of rows) {
    if (!map.has(schema)) map.set(schema, []);
    map.get(schema).push({ name: table, view: /view/i.test(ttype || '') });
  }
  return { schemas: [...map.entries()].map(([name, tables]) => ({ name, tables })) };
}
// Server-side ORDER BY / WHERE so sorting and filtering work on the whole table, not just the
// loaded page. `orderBy` is validated against the real column list; `where` is a raw predicate
// the user typed (already gated by readOnly on the query path) — appended verbatim after WHERE.
async function tableData(h, schema, table, { limit = 200, offset = 0, orderBy = null, orderDir = 'asc', where = '' } = {}) {
  const tq = qualified(h.type, schema, table);
  const lim = Math.max(1, Math.min(5000, +limit || 200));
  const off = Math.max(0, +offset || 0);
  let whereSql = '';
  if (where && String(where).trim()) whereSql = ' WHERE ' + String(where).trim();
  let orderSql = '';
  if (orderBy) { const dir = String(orderDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'; orderSql = ` ORDER BY ${q(h.type, orderBy)} ${dir}`; }
  const data = await rawQuery(h, `SELECT * FROM ${tq}${whereSql}${orderSql} LIMIT ${lim} OFFSET ${off}`);
  let total = null;
  try { const c = await rawQuery(h, `SELECT COUNT(*) FROM ${tq}${whereSql}`); total = Number(c.rows[0] && c.rows[0][0]); } catch (_) {}
  return { ...data, total, limit: lim, offset: off };
}

// Fetch the whole table (capped) for export — separate from the paged grid view.
async function fetchAll(h, schema, table, { where = '', orderBy = null, orderDir = 'asc', max = 100000 } = {}) {
  return tableData(h, schema, table, { limit: max, offset: 0, where, orderBy, orderDir });
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
  const fks = (await h.pg.query({
    text: `SELECT kcu.column_name, ccu.table_schema, ccu.table_name, ccu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`, values: [sch, table], rowMode: 'array' })).rows;
  const fkMap = new Map(fks.map((r) => [r[0], { schema: r[1], table: r[2], column: r[3] }]));
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
  } else ddl = buildPgDdl(h.type, sch, table, columns, pk, indexes);
  return { schema: sch, table, columns, indexes, ddl };
}

function buildPgDdl(type, schema, table, columns, pk, indexes) {
  const lines = columns.map((c) => `  ${q(type, c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ' DEFAULT ' + c.default : ''}`);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => q(type, c)).join(', ')})`);
  for (const c of columns) if (c.fk) lines.push(`  FOREIGN KEY (${q(type, c.name)}) REFERENCES ${q(type, c.fk.table)} (${q(type, c.fk.column)})`);
  let ddl = `CREATE TABLE ${q(type, schema)}.${q(type, table)} (\n${lines.join(',\n')}\n);`;
  for (const i of indexes) if (!i.primary) ddl += `\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(type, i.name)} ON ${q(type, table)} (${i.columns.map((c) => q(type, c)).join(', ')});`;
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
  try { const r = h.sq.exec(`SELECT sql FROM sqlite_master WHERE name = '${String(table).replace(/'/g, "''")}'`); ddl = r.length && r[0].values[0] ? r[0].values[0][0] : ''; } catch (_) {}
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
    const fn = (await h.pg.query({ text: `SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind = 'f' ORDER BY 1,2`, rowMode: 'array' })).rows;
    const sq = (await h.pg.query({ text: `SELECT sequence_schema, sequence_name FROM information_schema.sequences ORDER BY 1,2`, rowMode: 'array' })).rows;
    const est = (await h.pg.query({ text: `SELECT n.nspname, c.relname, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`, rowMode: 'array' })).rows;
    const rowEstimates = {}; for (const [s, t, n] of est) rowEstimates[s + '.' + t] = Number(n);
    return { functions: fn.map((r) => ({ schema: r[0], name: r[1], kind: 'function' })), sequences: sq.map((r) => ({ schema: r[0], name: r[1] })), rowEstimates };
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
    try { const [r] = await h.my.query({ sql: `SHOW CREATE ${what} ${qualified('mysql', schema, name)}`, rowsAsArray: true }); return r[0] ? (r[0][2] || '') : ''; } catch (e) { return String(e.message || e); }
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
    const r = await h.pg.query({ text: `SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_schema, ccu.table_name, ccu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog','information_schema')`, rowMode: 'array' });
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
    cfg.sshPassEnc = conn && conn.sshPassword != null ? (conn.sshPassword ? enc(conn.sshPassword) : '') : (saved.sshPassEnc || '');
    cfg.sshKeyEnc = conn && conn.sshKey != null ? (conn.sshKey ? enc(conn.sshKey) : '') : (saved.sshKeyEnc || '');
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

  ipcMain.handle('db:schema', async (_e, { id } = {}) => { try { return await listSchema(await getHandle(id)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:tableData', async (_e, { id, schema, table, ...opts } = {}) => { try { return await tableData(await getHandle(id), schema, table, opts); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:tableMeta', async (_e, { id, schema, table } = {}) => { try { return await tableMeta(await getHandle(id), schema, table); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:relations', async (_e, { id } = {}) => { try { return { relations: await relations(await getHandle(id)) }; } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:columns', async (_e, { id } = {}) => { try { return await allColumns(await getHandle(id)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:objects', async (_e, { id } = {}) => { try { return await objects(await getHandle(id)); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:objectDdl', async (_e, { id, schema, name, kind } = {}) => { try { return { ddl: await objectDdl(await getHandle(id), schema, name, kind) }; } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:objectInfo', async (_e, { id, schema, table } = {}) => { try { return await objectInfo(await getHandle(id), schema, table); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:fetchAll', async (_e, { id, schema, table, ...opts } = {}) => { try { return await fetchAll(await getHandle(id), schema, table, opts); } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('db:cancel', async (_e, { id } = {}) => { try { return await cancelQuery(id); } catch (e) { return { ok: false, error: String(e.message || e) }; } });
  ipcMain.handle('db:ping', async (_e, { id } = {}) => {
    try { const h = await getHandle(id); if (h.type === 'postgres') await h.pg.query('SELECT 1'); else if (h.type === 'mysql') await h.my.query('SELECT 1'); else h.sq.exec('SELECT 1'); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('db:reconnect', async (_e, { id } = {}) => {
    try { closeHandle(id); await getHandle(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('db:transaction', async (_e, { id, statements } = {}) => {
    try {
      const h = await getHandle(id);
      if (h.config && h.config.readOnly) return { ok: false, error: 'Подключение в режиме «только чтение».' };
      return await runTransaction(h, statements);
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // Run arbitrary SQL. readOnly connections refuse destructive statements.
  ipcMain.handle('db:query', async (_e, { id, sql } = {}) => {
    try {
      const h = await getHandle(id);
      if (h.config && h.config.readOnly && !isReadOnlySql(sql)) return { error: 'Подключение в режиме «только чтение» — изменяющие запросы запрещены.' };
      const r = await rawQuery(h, sql);
      // Persist SQLite after any modifying SQL — keyed off the statement text, because a
      // multi-statement run ending in SELECT (e.g. «INSERT …; SELECT …») returns a result set
      // yet still mutated the in-memory DB; flushSqlite() no-ops for non-sqlite handles.
      if (!isReadOnlySql(sql)) flushSqlite(h);
      return r;
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
