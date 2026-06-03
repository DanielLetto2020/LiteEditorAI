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
const SNAP_CHUNK = 32 * 1024; // большие snapshot'ы режем, чтобы не давить релей/WebView одним JSON

let logger = { log() {} };
let getSessions = () => ({ sessions: [], projects: [] });
let snapshot = () => '';   // чистый снапшот сессии (serialize теневого xterm) — задаётся из main
let writeInput = () => {};
let openProject = () => {};
let onSelect = () => {};
let onClose = () => {};
let onNewFolder = () => {};
let onRestartApp = () => {};
let onResize = () => {};
let onHistoryGet = () => {};
let onStoreList = () => {};
let onStoreGet = () => {};
let onStoreGetZip = () => {};
let onStoreCancel = () => {};
let onPultPresence = () => {};   // (connected:boolean) — пульт подключился/отключился (для уступки размера PTY)
let onPairRequest = () => {};    // ({device,name,pubkey,code}) — пульт просит одобрить устройство

let appConnected = false;        // есть ли сейчас хотя бы один пульт (role=app) на связи

let host = 'lite.codecopy.ru';
let token = '';
let enabled = false;

let ws = null;
let stopped = true;
let announceRestart = !!process.env.LITE_HEIR_PORT;   // запущены как наследник горячего перезапуска
let reconnectTimer = null;
let activeSid = null;
const buffers = new Map();

// --- Heartbeat (детект «half-open» соединения) -------------------------------
// Релей/NAT/прокси может молча отбросить соединение (особенно при автозапуске на
// boot, когда сеть ещё перестраивается): TCP-сокет на нашей стороне не получает
// FIN/RST, ws.readyState остаётся OPEN, событие 'close' не приходит → reconnect
// никогда не срабатывает. Редактор «думает», что на связи, а релей нас уже забыл —
// подключившийся пульт не с кем спарить и висит пустым. Лечим WS-ping'ом: шлём ping
// каждые PING_MS; если до следующего тика не пришёл pong — соединение мёртвое,
// terminate() форсит 'close' → scheduleReconnect поднимает свежее соединение.
const PING_MS = 25000;
let pingTimer = null;
let isAlive = false;

function startHeartbeat() {
  stopHeartbeat();
  isAlive = true;
  pingTimer = setInterval(() => {
    if (!ws) { stopHeartbeat(); return; }
    if (!isAlive) {
      logger.log('warn', 'remote', 'no pong from relay — terminating stale ws (half-open)');
      try { ws.terminate(); } catch (_) {}   // → 'close' → scheduleReconnect
      return;
    }
    isAlive = false;
    try { ws.ping(); } catch (_) {}
  }, PING_MS);
}
function stopHeartbeat() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

function wsUrl() { return `wss://${host}/ws`; }

function send(obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
}
function sendData(sid, data) {
  data = String(data || '');
  if (!data) return;
  for (let i = 0; i < data.length; i += SNAP_CHUNK) {
    send({ t: 'data', sid, data: data.slice(i, i + SNAP_CHUNK) });
  }
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

  ws.on('open', () => {
    logger.log('info', 'remote', `connected to relay ${host}`);
    startHeartbeat();
    sendState();
    // Если мы — «наследник» горячего перезапуска, сообщаем пульту, что редактор поднялся
    // (пульт↔релей не рвётся при рестарте, поэтому без явного сигнала пульт не узнает об успехе).
    if (announceRestart) { announceRestart = false; send({ t: 'restarted' }); }
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.t === 'peer' && m.role === 'app' && m.event === 'join') { setPultPresence(true); sendState(); }
    else if (m.t === 'peer' && m.role === 'app' && m.event === 'leave') { setPultPresence(false); }
    else if (m.t === 'hello') { setPultPresence(true); sendState(); }
    else if (m.t === 'select' && typeof m.sid === 'string') {
      activeSid = m.sid;
      if (m.snapshot !== false) {
        // Чистый снапшот теневого терминала (scrollback + alt-screen + modes) — валидное
        // состояние, которое пульт восстанавливает записью в свежий xterm. Фолбэк — сырой
        // хвост (если теневого терминала нет, напр. legacy-сессия). Снапшот синхронен с
        // потоком broadcast: все байты уже записаны в теневой xterm в proc.onData до сюда.
        let snap = '';
        try { snap = snapshot(m.sid) || ''; } catch (_) {}
        if (!snap) snap = buffers.get(m.sid) || '';
        if (snap) sendData(m.sid, snap);
      }
      try { onSelect(m.sid); } catch (_) {}   // пульт выбрал → переключить десктоп
    } else if (m.t === 'input' && typeof m.sid === 'string') {
      try { writeInput(m.sid, m.data || ''); } catch (_) {}
    } else if (m.t === 'resize' && typeof m.sid === 'string') {
      try { onResize(m.sid, m.cols, m.rows); } catch (_) {}
    } else if (m.t === 'history:get' && typeof m.sid === 'string') {
      try { onHistoryGet(m.reqId, m.sid); } catch (_) {}
    } else if (m.t === 'open' && typeof m.projId === 'string') {
      try { openProject(m.projId); } catch (_) {}
    } else if (m.t === 'close' && typeof m.sid === 'string') {
      try { onClose(m.sid); } catch (_) {}
    } else if (m.t === 'newFolder' && typeof m.name === 'string') {
      try { onNewFolder(m.name); } catch (_) {}
    } else if (m.t === 'restartApp') {
      try { onRestartApp(); } catch (_) {}
    } else if (m.t === 'store:list') {
      try { onStoreList(m.reqId, m.path || ''); } catch (_) {}
    } else if (m.t === 'store:get' && typeof m.path === 'string') {
      try { onStoreGet(m.reqId, m.path); } catch (_) {}
    } else if (m.t === 'store:getZip' && typeof m.path === 'string') {
      try { onStoreGetZip(m.reqId, m.path); } catch (_) {}
    } else if (m.t === 'store:cancel') {
      try { onStoreCancel(m.reqId); } catch (_) {}
    } else if (m.t === 'pair:request') {
      // Пульт (через релей) запрашивает одобрение устройства → показать модалку в редакторе.
      try { onPairRequest({ device: m.device || '', name: m.name || '', pubkey: m.pubkey || '', code: m.code || '' }); } catch (_) {}
    }
  });
  ws.on('pong', () => { isAlive = true; });
  ws.on('close', () => { stopHeartbeat(); ws = null; setPultPresence(false); scheduleReconnect(); });
  ws.on('error', (e) => { logger.log('warn', 'remote', 'ws error', e && e.message); try { ws.close(); } catch (_) {} });
}

// Пульт появился/пропал. Дребезг join/leave одного и того же события не дёргает main лишний раз.
function setPultPresence(connected) {
  connected = !!connected;
  if (connected === appConnected) return;
  appConnected = connected;
  try { onPultPresence(connected); } catch (_) {}
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
  if (opts.snapshot) snapshot = opts.snapshot;
  if (opts.writeInput) writeInput = opts.writeInput;
  if (opts.openProject) openProject = opts.openProject;
  if (opts.onSelect) onSelect = opts.onSelect;
  if (opts.onClose) onClose = opts.onClose;
  if (opts.onNewFolder) onNewFolder = opts.onNewFolder;
  if (opts.onRestartApp) onRestartApp = opts.onRestartApp;
  if (opts.onResize) onResize = opts.onResize;
  if (opts.onHistoryGet) onHistoryGet = opts.onHistoryGet;
  if (opts.onStoreList) onStoreList = opts.onStoreList;
  if (opts.onStoreGet) onStoreGet = opts.onStoreGet;
  if (opts.onStoreGetZip) onStoreGetZip = opts.onStoreGetZip;
  if (opts.onStoreCancel) onStoreCancel = opts.onStoreCancel;
  if (opts.onPultPresence) onPultPresence = opts.onPultPresence;
  if (opts.onPairRequest) onPairRequest = opts.onPairRequest;
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
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  setPultPresence(false);
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
// Для стора: прямая отправка пульту + объём неотправленного (бэкпрешер при стриме файлов).
function bufferedAmount() { return (ws && typeof ws.bufferedAmount === 'number') ? ws.bufferedAmount : 0; }

module.exports = { init, apply, stop, status, broadcast, exit, notifyState, send, bufferedAmount };
