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
const sftpWriteFile = (s, p, buf) => new Promise((res, rej) => s.writeFile(p, buf, (e) => e ? rej(e) : res()));

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
// Запись файла на хост (save-back правок из вивера): SFTP writeFile / FTP uploadFrom.
async function fsWrite(c, filePath, content) {
  const b = await getBrowser(c);
  const buf = Buffer.from(String(content == null ? '' : content), 'utf8');
  if (b.type === 'sftp') { await sftpWriteFile(b.sftp, filePath, buf); return { ok: true }; }
  const { Readable } = require('stream');
  await b.ftp.uploadFrom(Readable.from(buf), filePath);
  return { ok: true };
}

// ---------------------------------------------------------------- exec (одна команда → stdout)
// Одноразовое SSH-соединение: connect → exec → собрать вывод (кап 512 КБ) → end. Для FTP недоступно.
const EXEC_MAX = 512 * 1024;
function execCapture(c, cmd, timeoutMs, stdin) {
  if (c.type === 'ftp') return Promise.resolve({ ok: false, error: 'exec доступен только для SSH-профилей' });
  return new Promise((resolve) => {
    const ssh = new SshClient();
    let done = false, out = '', err = '';
    const fin = (r) => { if (!done) { done = true; clearTimeout(tm); try { ssh.end(); } catch (_) {} resolve(r); } };
    const tm = setTimeout(() => fin({ ok: false, error: 'таймаут выполнения команды' }), Math.max(3000, timeoutMs || 15000));
    ssh.on('error', (e) => fin({ ok: false, error: String(e.message || e) }));
    ssh.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => { const pw = dec(c.passEnc); cb(prompts.map(() => pw || '')); });
    ssh.on('ready', () => {
      ssh.exec(String(cmd || ''), (e, stream) => {
        if (e) return fin({ ok: false, error: String(e.message || e) });
        if (stdin != null) { try { stream.end(stdin); } catch (_) {} } // напр. пароль для sudo -S (записать + EOF)
        stream.on('data', (d) => { if (out.length < EXEC_MAX) out += d.toString('utf8'); });
        if (stream.stderr) stream.stderr.on('data', (d) => { if (err.length < EXEC_MAX) err += d.toString('utf8'); });
        stream.on('close', (code) => fin({ ok: true, code: code == null ? 0 : code, stdout: out, stderr: err }));
      });
    });
    try { ssh.connect(sshConfig(c)); } catch (e) { fin({ ok: false, error: String(e.message || e) }); }
  });
}

// Выполнить скрипт под root: сперва passwordless sudo (-n), затем sudo -S с паролем SSH-профиля
// (частый кейс на VPS: sudo-пароль = SSH-пароль). script — тело для sh -c, БЕЗ одинарных кавычек внутри.
// Каждая попытка — своё SSH-соединение (execCapture), так что свежие группы/права подхватываются сразу.
async function sudoExec(c, script, timeoutMs) {
  const sh = `sh -c '${String(script).replace(/'/g, '')}'`;
  let r = await execCapture(c, `sudo -n ${sh} 2>&1`, timeoutMs);
  if (r.ok && r.code === 0) return { ok: true, out: r.stdout };
  const pw = dec(c.passEnc);
  if (pw) {
    const r2 = await execCapture(c, `sudo -S -p '' ${sh} 2>&1`, timeoutMs, pw + '\n');
    if (r2.ok && r2.code === 0) return { ok: true, out: r2.stdout, usedPassword: true };
    if (r2.ok) r = r2;
  }
  const tail = String((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-3).join(' · ');
  return { ok: false, error: tail || r.error || 'sudo не выполнился' };
}

// ---------------------------------------------------------------- сканер сервисов хоста
// Один exec: слушающие TCP-порты (ss, фолбэк netstat) + наличие docker/podman-сокетов.
// Loopback-only сервисы тоже видим — через SSH-туннель они достижимы (заход с самого хоста).
const SVC_KINDS = [
  { kind: 'postgres', ports: [5432] }, { kind: 'mysql', ports: [3306] },
  { kind: 'rabbitmq', ports: [15672] }, { kind: 'amqp', ports: [5672] },
  { kind: 'kafka', ports: [9092, 29092, 9094, 19092] },
  { kind: 'redis', ports: [6379] }, { kind: 'mongo', ports: [27017] },
  { kind: 'web', ports: [80, 443, 8080, 3000, 8000, 5173, 4200, 8081, 8888] },
];
function classifyPort(port, proc) {
  const p = String(proc || '').toLowerCase();
  if (/postgres/.test(p)) return 'postgres';
  if (/mysqld|mariadb/.test(p)) return 'mysql';
  if (/beam|rabbit/.test(p)) return port === 5672 ? 'amqp' : (port === 15672 ? 'rabbitmq' : null);
  if (/kafka|redpanda/.test(p)) return 'kafka';
  if (/redis/.test(p)) return 'redis';
  if (/mongod/.test(p)) return 'mongo';
  if (/nginx|caddy|apache|httpd|node|traefik/.test(p)) return 'web';
  for (const k of SVC_KINDS) if (k.ports.includes(port)) return k.kind;
  return null;
}
// Сокеты не только ищем (test -S), но и проверяем доступ (test -r/-w): sshd пробрасывает unix-сокет
// от имени SSH-пользователя, и «сокет есть, но прав нет» (не в группе docker / рутовый podman.sock)
// иначе выглядит как молчаливый EOF у CLI. name-denied=path — есть, но недоступен.
const SOCK_TEST = (name, p) => `test -S ${p} && { test -r ${p} && test -w ${p} && echo ${name}=${p} || echo ${name}-denied=${p}; }; `;
const USER_PODMAN = '"/run/user/$(id -u)/podman/podman.sock"';
const SCAN_CMD =
  '(ss -ltnp 2>/dev/null || ss -ltn 2>/dev/null || netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null); ' +
  'echo __SOCKS__; ' +
  SOCK_TEST('docker', '/var/run/docker.sock') +
  SOCK_TEST('podman', '/run/podman/podman.sock') +
  `test -S ${USER_PODMAN} && { test -w ${USER_PODMAN} && echo "podman=/run/user/$(id -u)/podman/podman.sock" || echo "podman-denied=/run/user/$(id -u)/podman/podman.sock"; }; ` +
  'command -v podman >/dev/null 2>&1 && echo podman-cli=yes; true';
async function scanServices(c) {
  const r = await execCapture(c, SCAN_CMD, 20000);
  if (!r.ok) return r;
  const [portsPart, socksPart] = String(r.stdout || '').split('__SOCKS__');
  const seen = new Map(); // port -> { port, addr, proc }
  for (const line of String(portsPart || '').split('\n')) {
    // ss/netstat: локальный адрес вида 0.0.0.0:5432 | [::]:80 | 127.0.0.1:6379 | :::80
    const m = line.match(/(?:^|\s)(\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]*\]|::|\*)[:.](\d{1,5})\s/);
    if (!m) continue;
    const port = parseInt(m[2], 10);
    if (!(port > 0 && port < 65536) || port === 22) continue;
    const addr = m[1].replace(/[[\]]/g, '') || '*';
    const pm = line.match(/users:\(\("([^"]+)/) || line.match(/\d+\/([\w.-]+)\s*$/);
    const proc = pm ? pm[1] : '';
    const prev = seen.get(port);
    // приоритет записи с публичным адресом (0.0.0.0/::), чтобы не потерять «доступен снаружи»
    if (!prev || (prev.addr.startsWith('127.') && !addr.startsWith('127.'))) seen.set(port, { port, addr, proc });
  }
  const services = [];
  for (const { port, addr, proc } of [...seen.values()].sort((a, b) => a.port - b.port)) {
    const kind = classifyPort(port, proc);
    services.push({ port, addr, proc: proc || '', kind, loopbackOnly: addr.startsWith('127.') || addr === '::1' });
  }
  const sockets = {}, denied = {}; // sockets — доступные; denied — есть на хосте, но у SSH-юзера нет прав
  for (const line of String(socksPart || '').split('\n')) {
    let m = line.trim().match(/^(docker|podman)=(.+)$/);
    if (m) { if (!sockets[m[1]]) sockets[m[1]] = m[2]; continue; }
    m = line.trim().match(/^(docker|podman)-denied=(.+)$/);
    if (m && !denied[m[1]]) denied[m[1]] = m[2];
  }
  // podman установлен, но API-сокета нет (socket-activated сервис спит) — UI подскажет включить
  const podmanCli = /(^|\n)\s*podman-cli=yes\s*(\n|$)/.test(String(socksPart || ''));
  return { ok: true, services, sockets, denied, podmanCli };
}

// ---------------------------------------------------------------- SSH-туннели
// Локальный TCP-порт → (SSH) → удалённый host:port ИЛИ удалённый unix-сокет (docker/podman).
// Один ssh2-клиент на туннель, принудительный keepalive — idle-туннель не должен отваливаться.
const tunnels = new Map(); // tunId -> { ssh, server, port, connId, label, rhost, rport, sockPath }
function publicTunnel(t, id) { return { tunId: id, port: t.port, connId: t.connId, connName: t.connName, label: t.label, rhost: t.rhost || null, rport: t.rport || null, sockPath: t.sockPath || null }; }
function openTunnelGeneric(c, label, connectStream, lport) { // lport — предпочитаемый локальный порт (занят → случайный)
  return new Promise((resolve) => {
    const ssh = new SshClient();
    let done = false;
    const fin = (r) => { if (!done) { done = true; if (!r.ok) { try { ssh.end(); } catch (_) {} } resolve(r); } };
    const cfg = sshConfig(c);
    if (!cfg.keepaliveInterval) { cfg.keepaliveInterval = 15000; cfg.keepaliveCountMax = 6; }
    ssh.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => { const pw = dec(c.passEnc); cb(prompts.map(() => pw || '')); });
    ssh.on('ready', () => {
      const net = require('net');
      // t создаётся до server: обработчику коннектов нужно куда-то записать lastErr —
      // sshd рвёт канал к недоступному сокету/порту молча, клиент видит лишь EOF,
      // а настоящая причина (permission denied / administratively prohibited) остаётся тут.
      const t = { ssh, connId: c.id, connName: c.name || c.host, label };
      const server = net.createServer((sock) => {
        connectStream(ssh, (err, stream) => {
          if (err) { t.lastErr = String(err.message || err); try { sock.destroy(); } catch (_) {} return; }
          sock.pipe(stream).pipe(sock);
          const drop = () => { try { sock.destroy(); } catch (_) {} try { stream.close ? stream.close() : stream.end(); } catch (_) {} };
          sock.on('error', drop); stream.on('error', drop);
        });
      });
      const onListen = () => {
        const tunId = 'tun' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
        t.server = server; t.port = server.address().port;
        tunnels.set(tunId, t);
        // SSH умер (сеть/сервер) → прибрать туннель, чтобы не висел мёртвый локальный порт
        ssh.on('error', () => closeTunnel(tunId));
        ssh.on('close', () => closeTunnel(tunId));
        fin({ ok: true, tunId, t });
      };
      let retried = false;
      server.on('error', (e) => {
        // предпочитаемый порт занят — штатно, откатываемся на случайный (карта портов в UI перезапишется)
        if (lport && !retried && !done && e && e.code === 'EADDRINUSE') { retried = true; server.listen(0, '127.0.0.1', onListen); return; }
        fin({ ok: false, error: String(e.message || e) });
      });
      server.listen(lport || 0, '127.0.0.1', onListen);
    });
    ssh.on('error', (e) => fin({ ok: false, error: String(e.message || e) }));
    try { ssh.connect(cfg); } catch (e) { fin({ ok: false, error: String(e.message || e) }); }
  });
}
async function openTunnel(c, rhost, rport, label, lport) {
  const r = await openTunnelGeneric(c, label || `${rhost}:${rport}`, (ssh, cb) => ssh.forwardOut('127.0.0.1', 0, rhost, rport, cb), lport);
  if (r.ok) { r.t.rhost = rhost; r.t.rport = rport; }
  return r.ok ? { ok: true, tunId: r.tunId, port: r.t.port } : r;
}
async function openSockTunnel(c, sockPath, label) {
  const r = await openTunnelGeneric(c, label || sockPath, (ssh, cb) => ssh.openssh_forwardOutStreamLocal(sockPath, cb));
  if (r.ok) { r.t.sockPath = sockPath; }
  return r.ok ? { ok: true, tunId: r.tunId, port: r.t.port } : r;
}
function closeTunnel(tunId) {
  const t = tunnels.get(tunId); if (!t) return;
  tunnels.delete(tunId);
  try { t.server.close(); } catch (_) {}
  try { t.ssh.end(); } catch (_) {}
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
  ipcMain.handle('rh:fsWrite', async (_e, { id, path: p, content } = {}) => {
    const c = loadConns().find((x) => x.id === id); if (!c) return { ok: false, error: 'Подключение не найдено' };
    try { return await fsWrite(c, p, content); } catch (e) { closeBrowser(id); return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.on('rh:fsClose', (_e, { id } = {}) => closeBrowser(id));

  // Выполнить команду на хосте (одноразовый exec) + сканер сервисов (порты/сокеты).
  ipcMain.handle('rh:exec', async (_e, { id, cmd } = {}) => {
    const c = loadConns().find((x) => x.id === id); if (!c) return { ok: false, error: 'Подключение не найдено' };
    return await execCapture(c, cmd);
  });
  ipcMain.handle('rh:services', async (_e, { id } = {}) => {
    const c = loadConns().find((x) => x.id === id); if (!c) return { ok: false, error: 'Подключение не найдено' };
    try { return await scanServices(c); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // SSH-туннели: локальный порт → удалённый сервис. Живут, пока их не закрыли (или не упал SSH).
  ipcMain.handle('rh:tunnelOpen', async (_e, { id, rhost, rport, label, lport } = {}) => {
    const c = loadConns().find((x) => x.id === id); if (!c) return { ok: false, error: 'Подключение не найдено' };
    if (c.type === 'ftp') return { ok: false, error: 'туннели доступны только для SSH-профилей' };
    const port = parseInt(rport, 10);
    if (!(port > 0 && port < 65536)) return { ok: false, error: 'некорректный удалённый порт' };
    // переиспользуем живой туннель на тот же профиль+назначение — не плодим соединения
    // (живой может висеть на другом локальном порту, чем предпочитаемый lport, — вызывающий обновит свою карту)
    for (const [tid, t] of tunnels) if (t.connId === id && t.rhost === (rhost || '127.0.0.1') && t.rport === port) return { ok: true, tunId: tid, port: t.port, existed: true };
    const lp = parseInt(lport, 10);
    return await openTunnel(c, rhost || '127.0.0.1', port, label, (lp > 0 && lp < 65536) ? lp : undefined);
  });
  ipcMain.handle('rh:tunnelList', () => ({ ok: true, tunnels: [...tunnels.entries()].map(([tid, t]) => publicTunnel(t, tid)) }));
  ipcMain.handle('rh:tunnelClose', (_e, { tunId } = {}) => { closeTunnel(tunId); return { ok: true }; });

  ipcMain.on('rh:write', (_e, { sessionId, data } = {}) => { const s = sessions.get(sessionId); if (s) { try { s.stream.write(data); } catch (_) {} } });
  ipcMain.on('rh:resize', (_e, { sessionId, cols, rows } = {}) => { const s = sessions.get(sessionId); if (s && cols > 0 && rows > 0) { try { s.stream.setWindow(rows, cols, 0, 0); } catch (_) {} } });
  ipcMain.on('rh:close', (_e, { sessionId } = {}) => cleanup(sessionId));

  function closeAll() {
    for (const id of [...sessions.keys()]) cleanup(id);
    for (const id of [...browsers.keys()]) closeBrowser(id);
    for (const id of [...tunnels.keys()]) closeTunnel(id);
  }
  const findConn = (id) => loadConns().find((x) => x.id === id) || null;
  return {
    closeAll,
    findConn,
    // для main.js: «открыть удалённый файл в вивере» (tmp-копия + save-back) и docker-сокет контейнеров
    readFile: async (id, p) => { const c = findConn(id); if (!c) return { error: 'Подключение не найдено' }; try { return await fsRead(c, p); } catch (e) { return { error: String(e.message || e) }; } },
    writeFile: async (id, p, content) => { const c = findConn(id); if (!c) return { ok: false, error: 'Подключение не найдено' }; try { return await fsWrite(c, p, content); } catch (e) { closeBrowser(id); return { ok: false, error: String(e.message || e) }; } },
    scan: async (id) => { const c = findConn(id); if (!c) return { ok: false, error: 'Подключение не найдено' }; try { return await scanServices(c); } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    sockTunnel: async (id, sockPath, label) => { const c = findConn(id); if (!c) return { ok: false, error: 'Подключение не найдено' }; return await openSockTunnel(c, sockPath, label); },
    closeTunnel,
    exec: async (id, cmd, timeoutMs) => { const c = findConn(id); if (!c) return { ok: false, error: 'Подключение не найдено' }; return await execCapture(c, cmd, timeoutMs); },
    // root-операции «починки» (доступ к docker/podman-сокету): белый список скриптов держит main.js
    sudoExec: async (id, script, timeoutMs) => { const c = findConn(id); if (!c) return { ok: false, error: 'Подключение не найдено' }; return await sudoExec(c, script, timeoutMs); },
    tunnelAlive: (tunId) => tunnels.has(tunId),
    // последняя ошибка открытия канала внутри туннеля (например, sshd не пустил к unix-сокету) —
    // снаружи это выглядит как EOF у клиента, а причина лежит здесь
    tunnelError: (tunId) => { const t = tunnels.get(tunId); return (t && t.lastErr) || null; },
  };
}

module.exports = { registerRemoteIpc };
