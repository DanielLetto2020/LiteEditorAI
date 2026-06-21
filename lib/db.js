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
// Uniform result: { columns:[names], rows:[[...]], rowCount }. A result set with columns is a
// SELECT; an empty `columns` means a write/DDL (the renderer keys its display off that).
async function rawQuery(h, sql) {
  if (h.type === 'postgres') {
    const r = await h.pg.query({ text: sql, rowMode: 'array' });
    const res = Array.isArray(r) ? r[r.length - 1] : r; // simple-protocol multi-statement → last result
    return { columns: (res.fields || []).map((f) => f.name), rows: res.rows || [], rowCount: res.rowCount };
  }
  if (h.type === 'mysql') {
    let [rows, fields] = await h.my.query({ sql, rowsAsArray: true });
    // multipleStatements → mysql2 returns an array of result-sets with `fields` nested one level;
    // mirror the pg branch and report the last statement's result.
    if (Array.isArray(fields) && Array.isArray(fields[0])) { fields = fields[fields.length - 1]; rows = rows[rows.length - 1]; }
    if (Array.isArray(rows)) return { columns: (fields || []).map((f) => f.name), rows, rowCount: rows.length };
    return { columns: [], rows: [], rowCount: rows.affectedRows };
  }
  // sqlite — exec() runs all statements; a write returns no result set → report modified rows.
  const stmts = h.sq.exec(sql);
  if (!stmts.length) return { columns: [], rows: [], rowCount: h.sq.getRowsModified() };
  const last = stmts[stmts.length - 1];
  return { columns: last.columns, rows: last.values, rowCount: last.values.length };
}
// Persist sqlite to disk after a write (sql.js is in-memory).
function flushSqlite(h) { try { if (h.type === 'sqlite' && h.file) fs.writeFileSync(h.file, Buffer.from(h.sq.export())); } catch (_) {} }

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
async function tableData(h, schema, table, { limit = 200, offset = 0 } = {}) {
  const tq = qualified(h.type, schema, table);
  const lim = Math.max(1, Math.min(5000, +limit || 200));
  const off = Math.max(0, +offset || 0);
  const data = await rawQuery(h, `SELECT * FROM ${tq} LIMIT ${lim} OFFSET ${off}`);
  let total = null;
  try { const c = await rawQuery(h, `SELECT COUNT(*) FROM ${tq}`); total = Number(c.rows[0] && c.rows[0][0]); } catch (_) {}
  return { ...data, total, limit: lim, offset: off };
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
