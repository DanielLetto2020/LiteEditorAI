// remote.js — удалённый пульт LiteEditor (ПК-сторона).
//
// Открывает ИСХОДЯЩИЙ WebSocket к релею (lite.codecopy.ru) с role=pc. Релей
// склеивает нас с Android-пультом (role=app) по общей комнате. Дальше:
//   • вывод PTY (pty:data) зеркалим пульту;
//   • ввод/промпт с пульта пишем в соответствующий PTY;
//   • отдаём пульту список вкладок-сессий (метки).
//
// Включается ТОЛЬКО при env LITE_REMOTE=1 (по умолчанию выключено → у обычных
// пользователей ничего не меняется). Файл грузится напрямую (не бандлится),
// как logger.js — правки применяются на следующем запуске.
//
// Конфиг через окружение:
//   LITE_REMOTE=1                 — включить
//   LITE_RELAY_URL=wss://lite.codecopy.ru/ws   (дефолт)
//   LITE_RELAY_TOKEN=<секрет>     — общий секрет (как в релее и в APK)
//   LITE_RELAY_ROOM=default       — код пейринга (дефолт)

let WebSocket = null;
try { WebSocket = require('ws'); } catch (_) { /* ws не установлен — фича просто не поднимется */ }

const DEFAULT_URL = 'wss://lite.codecopy.ru/ws';
const BUF_LIMIT = 64 * 1024; // сколько последнего вывода держим на сессию для реплея при выборе вкладки

let logger = { log() {} };
let getSessions = () => [];   // () => [{ sid, label }]
let writeInput = () => {};    // (sid, data) => void

let ws = null;
let stopped = true;
let reconnectTimer = null;
let activeSid = null;                 // какую сессию сейчас смотрит пульт
const buffers = new Map();            // sid -> string (хвост вывода)

function cfg() {
  return {
    enabled: process.env.LITE_REMOTE === '1',
    url: process.env.LITE_RELAY_URL || DEFAULT_URL,
    token: process.env.LITE_RELAY_TOKEN || '',
    room: process.env.LITE_RELAY_ROOM || 'default',
  };
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function sendState() {
  let sessions = [];
  try { sessions = getSessions() || []; } catch (_) {}
  send({ t: 'state', sessions });
}

function connect() {
  const c = cfg();
  if (!WebSocket || !c.enabled || !c.token) return;
  const url = `${c.url}?token=${encodeURIComponent(c.token)}&room=${encodeURIComponent(c.room)}&role=pc`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    logger.log('error', 'remote', 'connect failed', e); scheduleReconnect(); return;
  }

  ws.on('open', () => { logger.log('info', 'remote', `connected to relay room=${c.room}`); sendState(); });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.t === 'peer' && m.role === 'app' && m.event === 'join') {
      // Пульт подключился — отдать ему актуальный список вкладок.
      sendState();
    } else if (m.t === 'hello') {
      sendState();
    } else if (m.t === 'select' && typeof m.sid === 'string') {
      activeSid = m.sid;
      const buf = buffers.get(m.sid);
      if (buf) send({ t: 'data', sid: m.sid, data: buf }); // реплей последнего вывода
    } else if (m.t === 'input' && typeof m.sid === 'string') {
      try { writeInput(m.sid, m.data || ''); } catch (_) {}
    }
  });

  ws.on('close', () => { scheduleReconnect(); });
  ws.on('error', (e) => { logger.log('warn', 'remote', 'ws error', e && e.message); try { ws.close(); } catch (_) {} });
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

// --- Публичный API (зовётся из main.js) -----------------------------------

function start(opts = {}) {
  if (opts.logger) logger = opts.logger;
  if (opts.getSessions) getSessions = opts.getSessions;
  if (opts.writeInput) writeInput = opts.writeInput;
  const c = cfg();
  if (!c.enabled) return;
  if (!WebSocket) { logger.log('warn', 'remote', 'ws not installed — remote disabled'); return; }
  if (!c.token) { logger.log('warn', 'remote', 'LITE_RELAY_TOKEN empty — remote disabled'); return; }
  stopped = false;
  logger.log('info', 'remote', `starting remote pult → ${c.url} room=${c.room}`);
  connect();
}

function stop() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws && ws.close(); } catch (_) {}
  ws = null;
}

// Зовётся из onData PTY: копим хвост и (если эту сессию смотрят) шлём пульту.
function broadcast(sid, data) {
  let buf = (buffers.get(sid) || '') + data;
  if (buf.length > BUF_LIMIT) buf = buf.slice(buf.length - BUF_LIMIT);
  buffers.set(sid, buf);
  if (sid === activeSid) send({ t: 'data', sid, data });
}

function exit(sid) {
  buffers.delete(sid);
  send({ t: 'exit', sid });
}

// Вызвать, когда список вкладок мог измениться (создали/закрыли/переименовали).
function notifyState() { sendState(); }

module.exports = { start, stop, broadcast, exit, notifyState };
