// RemoteHost module backend: interactive SSH shell sessions over ssh2, with
// securely-stored connection profiles. Secrets (password / private key / passphrase)
// are encrypted via Electron safeStorage — same scheme as lib/db.js (v1: OS keyring,
// fallback b64 obfuscation when no keyring is available).
//
// A session is a live ssh2 `shell` channel streamed to the renderer as a PTY-like feed:
//   main → renderer:  rh:data { id, data }   /  rh:exit { id }
//   renderer → main:  rh:write / rh:resize / rh:close
// The renderer binds an xterm to each session id, exactly like the scratch terminal.
//
// main.js wires this: registerRemoteIpc({ ipcMain, safeStorage, send, getConnections, setConnections }).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: SshClient } = require('ssh2');

let _safe = null, _get = null, _set = null, _send = null;
const sessions = new Map(); // sessionId -> { ssh, stream, connId }

// ---------------------------------------------------------------- secrets
function enc(text) {
  if (!text) return '';
  try { if (_safe && _safe.isEncryptionAvailable()) return 'v1:' + _safe.encryptString(text).toString('base64'); } catch (_) {}
  console.warn('WARN: OS keyring (safeStorage) is unavailable. Falling back to weak base64 obfuscation for secrets!');
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
function publicConn(c) { const { passEnc, keyEnc, passphraseEnc, ...rest } = c; return { ...rest, hasPass: !!passEnc, hasKey: !!keyEnc, hasPassphrase: !!passphraseEnc }; }
function publicList() { return loadConns().map(publicConn); }

// ---------------------------------------------------------------- ssh config
// Default identity files in ~/.ssh, tried for passwordless login (like OpenSSH does).
function defaultIdentityFiles() {
  const dir = path.join(os.homedir(), '.ssh');
  const out = [];
  for (const f of ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']) {
    try { const p = path.join(dir, f); if (fs.existsSync(p)) out.push(fs.readFileSync(p)); } catch (_) {}
  }
  return out;
}
// Build an ssh2 connect config from a stored (encrypted) connection record.
function sshConfig(c) {
  const cfg = { host: c.host, port: +c.port || 22, username: c.user || undefined, readyTimeout: 20000, tryKeyboard: true };
  // keepalive — like PhpStorm's "send keepalive every N seconds" so idle connections don't drop
  if (c.keepalive) { cfg.keepaliveInterval = Math.max(2, +c.keepaliveSeconds || 30) * 1000; cfg.keepaliveCountMax = 6; }
  if (c.auth === 'agent') {
    // passwordless: use the system SSH agent + default ~/.ssh keys, exactly like `ssh user@host`
    const sock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : null);
    if (sock) cfg.agent = sock;
    const keys = defaultIdentityFiles();
    if (keys.length) cfg.privateKey = keys[0];
  } else if (c.auth === 'key') {
    // explicit key blob (kept for forward-compat; current UI exposes password / agent)
    const key = dec(c.keyEnc);
    if (key) { cfg.privateKey = key; const pp = dec(c.passphraseEnc); if (pp) cfg.passphrase = pp; }
  } else {
    cfg.password = dec(c.passEnc);
  }
  cfg.hostVerifier = (hashedKey) => {
    if (c.hostHash && c.hostHash !== hashedKey) {
      console.warn('SSH Host Key Mismatch for ' + c.host);
      return false;
    }
    c.hostHash = hashedKey; // TOFU (Trust On First Use) in memory
    return true;
  };
  return cfg;
}
// Merge typed form values over the saved record so test/connect works without re-typing secrets.
function mergedConfig(conn) {
  const saved = conn && conn.id ? (loadConns().find((x) => x.id === conn.id) || {}) : {};
  const cfg = { ...saved, ...conn };
  cfg.passEnc = conn && conn.password != null ? (conn.password ? enc(conn.password) : '') : (saved.passEnc || '');
  cfg.keyEnc = conn && conn.key != null ? (conn.key ? enc(conn.key) : '') : (saved.keyEnc || '');
  cfg.passphraseEnc = conn && conn.passphrase != null ? (conn.passphrase ? enc(conn.passphrase) : '') : (saved.passphraseEnc || '');
  return cfg;
}

function cleanup(id) {
  const s = sessions.get(id);
  if (s) { try { s.stream.end(); } catch (_) {} try { s.ssh.end(); } catch (_) {} sessions.delete(id); }
}

// Open an interactive SSH shell channel. Resolves once the channel is ready (or fails).
function openSession(sessionId, c, cols, rows) {
  return new Promise((resolve) => {
    const ssh = new SshClient();
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    ssh.on('error', (e) => {
      _send('rh:data', { id: sessionId, data: `\r\n\x1b[31mОшибка SSH: ${e.message || e}\x1b[0m\r\n` });
      _send('rh:exit', { id: sessionId });
      cleanup(sessionId);
      finish({ error: String(e.message || e) });
    });
    // keyboard-interactive (some servers force it even for password auth) → answer with the password
    ssh.on('keyboard-interactive', (_name, _instr, _lang, prompts, cb) => {
      const pw = dec(c.passEnc);
      cb(prompts.map(() => pw || ''));
    });
    ssh.on('ready', () => {
      ssh.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
        if (err) { _send('rh:exit', { id: sessionId }); try { ssh.end(); } catch (_) {} return finish({ error: String(err.message || err) }); }
        sessions.set(sessionId, { ssh, stream, connId: c.id });
        stream.on('data', (d) => _send('rh:data', { id: sessionId, data: d.toString('utf8') }));
        if (stream.stderr) stream.stderr.on('data', (d) => _send('rh:data', { id: sessionId, data: d.toString('utf8') }));
        stream.on('close', () => { _send('rh:exit', { id: sessionId }); cleanup(sessionId); });
        finish({ ok: true });
      });
    });
    try { ssh.connect(sshConfig(c)); } catch (e) { _send('rh:exit', { id: sessionId }); finish({ error: String(e.message || e) }); }
  });
}

// ---------------------------------------------------------------- file browser (read-only)
// Persistent browse connections per profile: SFTP over ssh2 (type ssh/sftp) or basic-ftp (type ftp).
const posix = path.posix;
const browsers = new Map(); // connId -> { type:'sftp'|'ftp', ssh?, sftp?, ftp? }
const MAX_VIEW = 2 * 1024 * 1024; // 2 МБ — порог просмотра файла

function normPath(p) { const n = posix.normalize(String(p || '/')); return n.length > 1 ? n.replace(/\/+$/, '') : n; }
function sortEntries(a) { return a.sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name) : (x.dir ? -1 : 1))); }
function decodeForView(buf) {
  if (buf.subarray(0, 8192).includes(0)) return { ok: true, binary: true, size: buf.length }; // NUL → бинарник
  return { ok: true, content: buf.toString('utf8'), size: buf.length };
}

function sftpConnect(c) {
  return new Promise((resolve, reject) => {
    const ssh = new SshClient();
    let done = false;
    const fail = (e) => { if (!done) { done = true; try { ssh.end(); } catch (_) {} reject(e); } };
    ssh.on('error', fail);
    ssh.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => { const pw = dec(c.passEnc); cb(prompts.map(() => pw || '')); });
    ssh.on('ready', () => { ssh.sftp((err, sftp) => { if (err) return fail(err); done = true; resolve({ type: 'sftp', ssh, sftp }); }); });
    try { ssh.connect(sshConfig(c)); } catch (e) { fail(e); }
  });
}
async function ftpConnect(c) {
  const { Client } = require('basic-ftp');
  const client = new Client(20000);
  // FTPS verifies the server cert by default; only skip verification if the user explicitly opts in.
  await client.access({ host: c.host, port: +c.port || 21, user: c.user || undefined, password: dec(c.passEnc) || undefined, secure: !!c.ftps, secureOptions: (c.ftps && c.ftpsInsecure) ? { rejectUnauthorized: false } : undefined });
  return { type: 'ftp', ftp: client };
}
async function getBrowser(c) {
  if (browsers.has(c.id)) return browsers.get(c.id);
  const b = (c.type === 'ftp') ? await ftpConnect(c) : await sftpConnect(c);
  browsers.set(c.id, b);
  return b;
}
function closeBrowser(id) {
  const b = browsers.get(id); if (!b) return;
  try { if (b.ssh) b.ssh.end(); } catch (_) {}
  try { if (b.ftp) b.ftp.close(); } catch (_) {}
  browsers.delete(id);
}
const sftpReaddir = (s, p) => new Promise((res, rej) => s.readdir(p, (e, l) => e ? rej(e) : res(l)));
const sftpRealpath = (s, p) => new Promise((res) => s.realpath(p, (e, abs) => res(e ? p : abs)));
const sftpStat = (s, p) => new Promise((res, rej) => s.stat(p, (e, st) => e ? rej(e) : res(st)));
const sftpReadFile = (s, p) => new Promise((res, rej) => s.readFile(p, (e, buf) => e ? rej(e) : res(buf)));

async function fsList(c, reqPath) {
  const b = await getBrowser(c);
  if (b.type === 'sftp') {
    let p = (!reqPath || reqPath === '~') ? await sftpRealpath(b.sftp, '.') : reqPath;
    p = normPath(p);
    const list = await sftpReaddir(b.sftp, p);
    const entries = list.map((e) => ({
      name: e.filename,
      dir: (e.attrs && typeof e.attrs.isDirectory === 'function') ? e.attrs.isDirectory() : /^d/.test(e.longname || ''),
      size: (e.attrs && e.attrs.size) || 0,
    })).filter((e) => e.name !== '.' && e.name !== '..');
    return { ok: true, path: p, entries: sortEntries(entries) };
  }
  let p = (reqPath && reqPath !== '~') ? normPath(reqPath) : normPath(await b.ftp.pwd());
  const list = await b.ftp.list(p);
  const entries = list.map((e) => ({ name: e.name, dir: !!e.isDirectory, size: e.size || 0 })).filter((e) => e.name !== '.' && e.name !== '..');
  return { ok: true, path: p, entries: sortEntries(entries) };
}
async function fsRead(c, filePath) {
  const b = await getBrowser(c);
  if (b.type === 'sftp') {
    let st = null; try { st = await sftpStat(b.sftp, filePath); } catch (_) {}
    if (st && st.size > MAX_VIEW) return { error: 'Файл слишком большой для просмотра (> 2 МБ)' };
    return decodeForView(await sftpReadFile(b.sftp, filePath));
  }
  const { Writable } = require('stream');
  const chunks = []; let total = 0; let overflow = false;
  const sink = new Writable({ write(ch, _enc, cb) { total += ch.length; if (total > MAX_VIEW) { overflow = true; return cb(new Error('too big')); } chunks.push(ch); cb(); } });
  try { await b.ftp.downloadTo(sink, filePath); } catch (e) { if (overflow) return { error: 'Файл слишком большой для просмотра (> 2 МБ)' }; throw e; }
  return decodeForView(Buffer.concat(chunks));
}

// ---------------------------------------------------------------- IPC
function registerRemoteIpc({ ipcMain, safeStorage, send, getConnections, setConnections, onSessionOpen }) {
  _safe = safeStorage; _send = send; _get = getConnections; _set = setConnections;
  const _onOpen = typeof onSessionOpen === 'function' ? onSessionOpen : () => {};

  ipcMain.handle('rh:list', () => ({ connections: publicList(), secure: !!(safeStorage && safeStorage.isEncryptionAvailable()) }));

  // Save (create/update). Plain secrets come in only when changed; absent → keep existing blob.
  ipcMain.handle('rh:save', (_e, { conn } = {}) => {
    if (!conn) return { error: 'нет данных подключения' };
    const list = loadConns();
    const idx = conn.id ? list.findIndex((x) => x.id === conn.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...conn };
    delete rec.hasPass; delete rec.hasKey; delete rec.hasPassphrase;
    if (conn.password != null) rec.passEnc = conn.password ? enc(conn.password) : '';
    if (conn.key != null) rec.keyEnc = conn.key ? enc(conn.key) : '';
    if (conn.passphrase != null) rec.passphraseEnc = conn.passphrase ? enc(conn.passphrase) : '';
    delete rec.password; delete rec.key; delete rec.passphrase;
    if (!rec.id) rec.id = 'rh' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveConns(list);
    return { ok: true, id: rec.id, connection: publicConn(rec) };
  });

  ipcMain.handle('rh:delete', (_e, { id } = {}) => { saveConns(loadConns().filter((x) => x.id !== id)); return { ok: true }; });

  // Test connection — connect, then immediately drop. SSH/SFTP via ssh2, FTP via basic-ftp.
  ipcMain.handle('rh:test', async (_e, { conn } = {}) => {
    const cfg = mergedConfig(conn);
    if (cfg.type === 'ftp') {
      let b = null;
      try { b = await ftpConnect(cfg); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e.message || e) }; }
      finally { try { if (b && b.ftp) b.ftp.close(); } catch (_) {} }
    }
    return await new Promise((resolve) => {
      const ssh = new SshClient();
      let done = false;
      const fin = (r) => { if (!done) { done = true; try { ssh.end(); } catch (_) {} resolve(r); } };
      ssh.on('error', (e) => fin({ ok: false, error: String(e.message || e) }));
      ssh.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => { const pw = dec(cfg.passEnc); cb(prompts.map(() => pw || '')); });
      ssh.on('ready', () => fin({ ok: true }));
      try { ssh.connect(sshConfig(cfg)); } catch (e) { fin({ ok: false, error: String(e.message || e) }); }
    });
  });

  // Open an interactive SSH session (shell). The renderer binds an xterm to rh:data/rh:exit.
  ipcMain.handle('rh:open', async (e, { sessionId, id, cols, rows } = {}) => {
    if (sessionId) { try { _onOpen(sessionId, e.sender); } catch (_) {} } // запомнить окно-владельца сессии (маршрутизация rh:data/rh:exit)
    const c = loadConns().find((x) => x.id === id);
    if (!c) return { error: 'Подключение не найдено' };
    if (sessions.has(sessionId)) return { ok: true, existed: true };
    return await openSession(sessionId, c, cols, rows);
  });
  // File browser (read-only): list a directory / read a file for viewing.
  ipcMain.handle('rh:fsList', async (_e, { id, path: p } = {}) => {
    const c = loadConns().find((x) => x.id === id); if (!c) return { error: 'Подключение не найдено' };
    try { return await fsList(c, p); } catch (e) { closeBrowser(id); return { error: String(e.message || e) }; } // drop stale conn → reconnect next time
  });
  ipcMain.handle('rh:fsRead', async (_e, { id, path: p } = {}) => {
    const c = loadConns().find((x) => x.id === id); if (!c) return { error: 'Подключение не найдено' };
    try { return await fsRead(c, p); } catch (e) { return { error: String(e.message || e) }; }
  });
  ipcMain.on('rh:fsClose', (_e, { id } = {}) => closeBrowser(id));

  ipcMain.on('rh:write', (_e, { sessionId, data } = {}) => { const s = sessions.get(sessionId); if (s) { try { s.stream.write(data); } catch (_) {} } });
  ipcMain.on('rh:resize', (_e, { sessionId, cols, rows } = {}) => { const s = sessions.get(sessionId); if (s && cols > 0 && rows > 0) { try { s.stream.setWindow(rows, cols, 0, 0); } catch (_) {} } });
  ipcMain.on('rh:close', (_e, { sessionId } = {}) => cleanup(sessionId));

  function closeAll() { for (const id of [...sessions.keys()]) cleanup(id); for (const id of [...browsers.keys()]) closeBrowser(id); }
  return { closeAll };
}

module.exports = { registerRemoteIpc };
