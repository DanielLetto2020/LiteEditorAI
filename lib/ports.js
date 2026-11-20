// Какие TCP-порты слушают процессы терминала (Linux, /proc). Нужно для чипов «localhost:5173»
// в нижней панели: агент или команда подняли dev-сервер — открыть его одним кликом, не выискивая
// порт в выводе. Используется в main.js (IPC pty:ports), тесты — test/ports.test.js.
//
// Как: сокеты процесса — ссылки «socket:[inode]» в /proc/<pid>/fd; слушающие сокеты —
// строки /proc/<pid>/net/tcp{,6} в состоянии 0A (LISTEN). Пересекаем по inode. net/tcp берём
// из /proc/<pid>/net, а не /proc/net: так видно сетевое пространство имён самого процесса.

'use strict';

const fs = require('fs');
const { descendants } = require('./proctree');

const TCP_LISTEN = '0A';

/**
 * Слушающие сокеты из текста /proc/net/tcp или tcp6.
 * @param {string} text
 * @returns {Array<{ port: number, inode: string, addr: string }>}
 */
function parseProcNetTcp(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== TCP_LISTEN) continue;
    const local = cols[1];
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const port = parseInt(local.slice(colon + 1), 16);
    const inode = cols[9];
    if (!Number.isFinite(port) || port <= 0 || !inode || inode === '0') continue;
    out.push({ port, inode, addr: local.slice(0, colon) });
  }
  return out;
}

/**
 * Адрес слушающего сокета — только на loopback (127.0.0.0/8, ::1)? Такой порт с другой машины не
 * открыть, но для чипа это неважно; поле пригодится для подсказки.
 * @param {string} hexAddr адрес из /proc/net/tcp (8 hex — IPv4 little-endian, 32 hex — IPv6)
 */
function isLoopbackHex(hexAddr) {
  const a = String(hexAddr || '').toUpperCase();
  if (a.length === 8) return a.endsWith('7F');                  // 0100007F → 127.0.0.1
  if (a.length === 32) {
    if (a === '00000000000000000000000001000000') return true;   // ::1
    return a.startsWith('0000000000000000FFFF0000') && a.endsWith('7F'); // ::ffff:127.x.x.x
  }
  return false;
}

/** inode сокетов из списка ссылок /proc/<pid>/fd. @param {string[]} links */
function socketInodes(links) {
  const out = new Set();
  for (const l of links || []) {
    const m = /^socket:\[(\d+)\]$/.exec(String(l));
    if (m) out.add(m[1]);
  }
  return out;
}

function readFdLinks(pid) {
  let fds;
  try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { return []; }
  const out = [];
  for (const fd of fds) {
    try { out.push(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch (_) { /* fd закрылся */ }
  }
  return out;
}

function readComm(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch (_) { return ''; }
}

/**
 * Порты, которые слушают shellPid и все его потомки.
 * excludePids — процессы, чьи сокеты не считаются «портами терминала»: шелл получает от родителя
 * (главного процесса редактора) унаследованные дескрипторы, и без исключения в чипах всплывал,
 * например, отладочный порт самого Electron.
 * @param {number} shellPid
 * @param {{ excludePids?: number[], platform?: string }} [opts]
 * @returns {Array<{ port: number, comm: string, pid: number, loopback: boolean }>} по возрастанию порта
 */
function listeningPorts(shellPid, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'linux' || !shellPid) return [];
  const kids = descendants(shellPid) || [];
  const pids = [+shellPid, ...kids].slice(0, 400);
  const foreign = new Set();
  for (const pid of opts.excludePids || []) for (const ino of socketInodes(readFdLinks(pid))) foreign.add(ino);
  const owner = new Map();   // inode → pid
  for (const pid of pids) {
    for (const ino of socketInodes(readFdLinks(pid))) if (!owner.has(ino) && !foreign.has(ino)) owner.set(ino, pid);
  }
  if (!owner.size) return [];
  const byPort = new Map();
  for (const file of ['tcp', 'tcp6']) {
    let text;
    try { text = fs.readFileSync(`/proc/${shellPid}/net/${file}`, 'utf8'); } catch (_) { continue; }
    for (const s of parseProcNetTcp(text)) {
      const pid = owner.get(s.inode);
      if (pid == null) continue;
      const prev = byPort.get(s.port);
      const loopback = isLoopbackHex(s.addr);
      if (prev) { prev.loopback = prev.loopback && loopback; continue; }
      byPort.set(s.port, { port: s.port, pid, comm: readComm(pid), loopback });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

module.exports = { parseProcNetTcp, isLoopbackHex, socketInodes, listeningPorts };
