// remote.js — удалённый пульт LiteEditor (ПК-сторона).
//
// Открывает ИСХОДЯЩИЙ WebSocket к релею (lite.codecopy.ru) с role=pc. Релей
// склеивает нас с Android-пультом(ами) по аккаунту (логин/пароль → токен сессии).
// Токен пользователь не вводит: входит логином/паролем в модалке «Пульт», main
// получает токен от релея и передаёт его сюда через apply().
//
// Включается, когда есть сохранённый токен И включён тумблер (enabled). Конфиг —
// из стора (ключ remote); legacy-путь через env (LITE_REMOTE=1 + LITE_RELAY_TOKEN)
// тоже работает. Файл грузится напрямую (не бандлится) — правки на след. запуске.

let WebSocket = null;
try { WebSocket = require('ws'); } catch (_) { /* ws не установлен — фича не поднимется */ }

const BUF_LIMIT = 16 * 1024; // короткий «хвост» вывода на сессию (не копим большую историю)

let logger = { log() {} };
let getSessions = () => ({ sessions: [], projects: [] });
let writeInput = () => {};
let openProject = () => {};
let onSelect = () => {};
let resizeSession = () => {};

let host = 'lite.codecopy.ru';
let token = '';
let enabled = false;

let ws = null;
let stopped = true;
let reconnectTimer = null;
let activeSid = null;
const buffers = new Map();

function wsUrl() { return `wss://${host}/ws`; }

function send(obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
}

function sendState() {
  let s = {};
  try { s = getSessions() || {}; } catch (_) {}
  send({ t: 'state', sessions: s.sessions || [], projects: s.projects || [], active: s.active || '' });
}

function connect() {
  if (!WebSocket || !enabled || !token) return;
  const url = `${wsUrl()}?token=${encodeURIComponent(token)}&role=pc`;
  try { ws = new WebSocket(url); }
  catch (e) { logger.log('error', 'remote', 'connect failed', e); scheduleReconnect(); return; }

  ws.on('open', () => { logger.log('info', 'remote', `connected to relay ${host}`); sendState(); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.t === 'peer' && m.role === 'app' && m.event === 'join') sendState();
    else if (m.t === 'hello') sendState();
    else if (m.t === 'select' && typeof m.sid === 'string') {
      activeSid = m.sid;
      const buf = buffers.get(m.sid);
      if (buf) send({ t: 'data', sid: m.sid, data: buf });
      try { onSelect(m.sid); } catch (_) {}   // пульт выбрал → переключить десктоп
    } else if (m.t === 'input' && typeof m.sid === 'string') {
      try { writeInput(m.sid, m.data || ''); } catch (_) {}
    } else if (m.t === 'open' && typeof m.projId === 'string') {
      try { openProject(m.projId); } catch (_) {}
    } else if (m.t === 'resize' && typeof m.sid === 'string') {
      try { resizeSession(m.sid, m.cols | 0, m.rows | 0); } catch (_) {}
    }
  });
  ws.on('close', () => { ws = null; scheduleReconnect(); });
  ws.on('error', (e) => { logger.log('warn', 'remote', 'ws error', e && e.message); try { ws.close(); } catch (_) {} });
}

function scheduleReconnect() {
  if (stopped || !enabled || !token) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!ws) connect(); }, 3000);
}

// --- Публичный API -----------------------------------------------------------

function init(opts = {}) {
  if (opts.logger) logger = opts.logger;
  if (opts.getSessions) getSessions = opts.getSessions;
  if (opts.writeInput) writeInput = opts.writeInput;
  if (opts.openProject) openProject = opts.openProject;
  if (opts.onSelect) onSelect = opts.onSelect;
  if (opts.resizeSession) resizeSession = opts.resizeSession;
}

// Применить конфиг (host/token/enabled). Поднимает или гасит соединение.
function apply(cfg = {}) {
  if (cfg.host !== undefined) host = cfg.host || 'lite.codecopy.ru';
  if (cfg.token !== undefined) token = cfg.token || '';
  if (cfg.enabled !== undefined) enabled = !!cfg.enabled;
  reconcile();
}

function reconcile() {
  if (enabled && token && WebSocket) {
    stopped = false;
    if (!ws) connect();
  } else {
    stop();
  }
}

function stop() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws && ws.close(); } catch (_) {}
  ws = null;
}

function status() {
  return { enabled, hasToken: !!token, host, connected: !!(ws && ws.readyState === 1) };
}

function broadcast(sid, data) {
  let buf = (buffers.get(sid) || '') + data;
  if (buf.length > BUF_LIMIT) buf = buf.slice(buf.length - BUF_LIMIT);
  buffers.set(sid, buf);
  if (sid === activeSid) send({ t: 'data', sid, data });
}

function exit(sid) { buffers.delete(sid); send({ t: 'exit', sid }); }
function notifyState() { sendState(); }

module.exports = { init, apply, stop, status, broadcast, exit, notifyState };
