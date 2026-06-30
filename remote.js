// remote.js — удалённый пульт LiteEditor (ПК-сторона).
//
// Открывает ИСХОДЯЩИЙ WebSocket к релею (хост задаёт пользователь — self-hosting) с role=pc. Релей
// склеивает нас с Android-пультом(ами) по аккаунту (логин/пароль → токен сессии).
// Токен пользователь не вводит: входит логином/паролем в модалке «Пульт», main
// получает токен от релея и передаёт его сюда через apply().
//
// Включается, когда есть сохранённый токен И включён тумблер (enabled). Конфиг —
// из стора (ключ remote); legacy-путь через env (LITE_REMOTE=1 + LITE_RELAY_TOKEN)
// тоже работает. Файл грузится напрямую (не бандлится) — правки на след. запуске.

let WebSocket = null;
try { WebSocket = require('ws'); } catch (_) { /* ws не установлен — фича не поднимется */ }

// «Проекция экрана» (принцип mosh): пульту по сети идёт не ANSI-стрим, а видимый экран
// активной сессии как текст — полный кадр на select и line-диффы с debounce дальше.
// Шторм перерисовок TUI-агента схлопывается в пару маленьких кадров в секунду, а ресинк
// после обрыва мобильной сети стоит один кадр ~5КБ вместо мегабайтного снапшота.
const FRAME_MS = 200;       // минимальный интервал между кадрами (trailing debounce)

let logger = { log() {} };
let getSessions = () => ({ sessions: [], projects: [] });
let screenFrame = () => null;  // (sid, styled) → {cols,rows,lines[],cursor:[x,y],alt,styled?,curIdx?} — задаётся из main
let writeInput = () => {};
let openProject = () => {};
let onSelect = () => {};
let onClose = () => {};
let onNewFolder = () => {};
let onRestartApp = () => {};
let onHistoryGet = () => {};
let onStoreList = () => {};
let onStoreGet = () => {};
let onStoreGetZip = () => {};
let onStoreCancel = () => {};
let onTasksGet = () => {};        // (reqId, id) — пульт запросил список задач (проектный/общий)
let onTasksSet = () => {};        // (id, notes) — пульт сохранил список задач
let onNoteToTerminal = () => {};  // (projId, text) — пульт: вставить текст задачи в терминал проекта
let onPultPresence = () => {};   // (connected:boolean) — пульт подключился/отключился
let onPairRequest = () => {};    // ({device,name,pubkey,code}) — пульт просит одобрить устройство
let onPultsChanged = () => {};   // (list) — состав подключённых пультов изменился (для бейджа в UI)
let onSysInfo = () => {};        // ({device,info,loc}) — пульт прислал системную инфу/гео
let isBlocked = () => false;     // (device) → доступ устройству отключён в редакторе

let appConnected = false;        // есть ли сейчас хотя бы один пульт (role=app) на связи

// --- Подключённые пульты (по device id из peer/hello) --------------------------
const pults = new Map();         // device → {device, name, ver, since}

function pultList() { return Array.from(pults.values()); }
function kick(device) { send({ t: 'kick', device: String(device || '') }); }
function pultUpsert(device, info) {
  device = String(device || '').trim();
  if (!device) return;
  const cur = pults.get(device) || { device, name: '', ver: '', since: Date.now() };
  if (info && info.name) cur.name = String(info.name).slice(0, 80);
  if (info && info.ver) cur.ver = String(info.ver).slice(0, 24);
  pults.set(device, cur);
  // Заблокированное устройство выкидываем сразу при появлении (kick адресный — по device).
  let blocked = false;
  try { blocked = !!isBlocked(device); } catch (_) {}
  if (blocked) kick(device);
  pultsChanged();
}
function pultRemove(device) {
  if (pults.delete(String(device || '').trim())) pultsChanged();
}
function pultsChanged() {
  setPultPresence(pults.size > 0);
  try { onPultsChanged(pultList()); } catch (_) {}
}

let host = '';   // хост релея задаётся пользователем (self-hosting); пусто = не подключаемся
let token = '';
let enabled = false;

let ws = null;
let stopped = true;
let announceRestart = !!process.env.LITE_HEIR_PORT;   // запущены как наследник горячего перезапуска
let reconnectTimer = null;
let activeSid = null;

// --- Кадры экрана ------------------------------------------------------------
let lastFrame = null;     // последний отправленный кадр {sid,cols,rows,lines,cursor,alt}
let frameSeq = 0;         // монотонный номер кадра — пульт ловит дыры и перезапрашивает full
let frameTimer = null;
let lastFlushAt = 0;
// Пульт умеет цветные кадры (заявил styled в select). Старый APK шлёт select без
// флага → плоский текст как раньше; флип режима всегда идёт через select, а тот
// сбрасывает lastFrame → следующий кадр full, смешения форматов в диффах не бывает.
let styledOk = false;

// PTY активной сессии что-то вывел → запланировать кадр (не чаще FRAME_MS).
// Без подключённого пульта кадры не шлём (сокет ПК↔релей живёт всегда — не гоняем
// JSON в пустоту); вернувшийся пульт сам пришлёт select и получит полный кадр.
function screenTouch(sid) {
  if (!appConnected || sid !== activeSid || !ws || ws.readyState !== 1) return;
  if (frameTimer) return;
  const wait = Math.max(0, FRAME_MS - (Date.now() - lastFlushAt));
  frameTimer = setTimeout(() => { frameTimer = null; flushScreen(false); }, wait);
}

function flushScreen(forceFull) {
  lastFlushAt = Date.now();
  const sid = activeSid;
  if (!sid) return;
  let f = null;
  try { f = screenFrame(sid, styledOk); } catch (_) {}
  if (!f || !Array.isArray(f.lines)) return;
  const curIdx = (typeof f.curIdx === 'number') ? f.curIdx : -1;
  const full = forceFull || !lastFrame || lastFrame.sid !== sid
    || lastFrame.cols !== f.cols || lastFrame.rows !== f.rows;
  if (full) {
    frameSeq++;
    send({ t: 'screen', sid, seq: frameSeq, full: true, cols: f.cols, rows: f.rows, alt: !!f.alt, cursor: f.cursor, curIdx, st: f.styled ? 1 : 0, lines: f.lines });
  } else {
    const diff = [];
    for (let i = 0; i < f.lines.length; i++) {
      if (f.lines[i] !== lastFrame.lines[i]) diff.push([i, f.lines[i]]);
    }
    const cursorMoved = !lastFrame.cursor || f.cursor[0] !== lastFrame.cursor[0]
      || f.cursor[1] !== lastFrame.cursor[1] || !!f.alt !== !!lastFrame.alt
      || curIdx !== lastFrame.curIdx;
    if (!diff.length && !cursorMoved) return;   // экран не изменился — кадр не нужен
    frameSeq++;
    send({ t: 'screen', sid, seq: frameSeq, alt: !!f.alt, cursor: f.cursor, curIdx, diff });
  }
  lastFrame = { sid, cols: f.cols, rows: f.rows, lines: f.lines, cursor: f.cursor, curIdx, alt: !!f.alt };
}

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

function sendState() {
  let s = {};
  try { s = getSessions() || {}; } catch (_) {}
  send({ t: 'state', sessions: s.sessions || [], projects: s.projects || [], active: s.active || '' });
}

function connect() {
  if (!WebSocket || !enabled || !token || !host) return;
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
    if (m.t === 'peer' && m.role === 'app' && m.event === 'join') { pultUpsert(m.device); sendState(); }
    else if (m.t === 'peer' && m.role === 'app' && m.event === 'leave') { pultRemove(m.device); }
    else if (m.t === 'hello') { pultUpsert(m.device, { name: m.name, ver: m.ver }); sendState(); }
    else if (m.t === 'sysinfo') {
      try { onSysInfo({ device: m.device || '', what: m.what || '', info: m.info || '', loc: m.loc || null }); } catch (_) {}
    }
    else if (m.t === 'select' && typeof m.sid === 'string') {
      activeSid = m.sid;
      styledOk = !!m.styled;     // новый APK просит цветные кадры; старый — плоские
      lastFrame = null;          // новый зритель/сессия → следующий кадр полный
      flushScreen(true);         // немедленный full-кадр (~5КБ) — пульт рисует мгновенно
      try { onSelect(m.sid); } catch (_) {}   // пульт выбрал → переключить десктоп
    } else if (m.t === 'input' && typeof m.sid === 'string') {
      try { writeInput(m.sid, m.data || ''); } catch (_) {}
    } else if (m.t === 'history:get' && typeof m.sid === 'string') {
      try { onHistoryGet(m.reqId, m.sid, m.before, m.size); } catch (_) {}
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
    } else if (m.t === 'tasks:get') {
      try { onTasksGet(m.reqId, String(m.id || '')); } catch (_) {}
    } else if (m.t === 'tasks:set' && typeof m.id === 'string' && Array.isArray(m.notes)) {
      try { onTasksSet(m.id, m.notes); } catch (_) {}
    } else if (m.t === 'tasks:toTerminal' && typeof m.text === 'string') {
      try { onNoteToTerminal(String(m.projId || ''), m.text); } catch (_) {}
    } else if (m.t === 'pair:request') {
      // Пульт (через релей) запрашивает одобрение устройства → показать модалку в редакторе.
      try { onPairRequest({ device: m.device || '', name: m.name || '', pubkey: m.pubkey || '', code: m.code || '' }); } catch (_) {}
    }
  });
  ws.on('pong', () => { isAlive = true; });
  ws.on('close', () => { stopHeartbeat(); ws = null; pults.clear(); pultsChanged(); scheduleReconnect(); });
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
  if (opts.screenFrame) screenFrame = opts.screenFrame;
  if (opts.writeInput) writeInput = opts.writeInput;
  if (opts.openProject) openProject = opts.openProject;
  if (opts.onSelect) onSelect = opts.onSelect;
  if (opts.onClose) onClose = opts.onClose;
  if (opts.onNewFolder) onNewFolder = opts.onNewFolder;
  if (opts.onRestartApp) onRestartApp = opts.onRestartApp;
  if (opts.onHistoryGet) onHistoryGet = opts.onHistoryGet;
  if (opts.onStoreList) onStoreList = opts.onStoreList;
  if (opts.onStoreGet) onStoreGet = opts.onStoreGet;
  if (opts.onStoreGetZip) onStoreGetZip = opts.onStoreGetZip;
  if (opts.onStoreCancel) onStoreCancel = opts.onStoreCancel;
  if (opts.onTasksGet) onTasksGet = opts.onTasksGet;
  if (opts.onTasksSet) onTasksSet = opts.onTasksSet;
  if (opts.onNoteToTerminal) onNoteToTerminal = opts.onNoteToTerminal;
  if (opts.onPultPresence) onPultPresence = opts.onPultPresence;
  if (opts.onPairRequest) onPairRequest = opts.onPairRequest;
  if (opts.onPultsChanged) onPultsChanged = opts.onPultsChanged;
  if (opts.onSysInfo) onSysInfo = opts.onSysInfo;
  if (opts.isBlocked) isBlocked = opts.isBlocked;
}

// Применить конфиг (host/token/enabled). Поднимает или гасит соединение.
function apply(cfg = {}) {
  const prevHost = host, prevToken = token;
  if (cfg.host !== undefined) host = cfg.host || '';
  if (cfg.token !== undefined) token = cfg.token || '';
  if (cfg.enabled !== undefined) enabled = !!cfg.enabled;
  // Сменили хост/токен на ЖИВОМ сокете → рвём его, иначе reconcile (if !ws → connect) не
  // переподключится и редактор остался бы на старом релее/сессии до следующего разрыва (B-remote).
  if (ws && (host !== prevHost || token !== prevToken)) { try { ws.close(); } catch (_) {} ws = null; }
  reconcile();
}

function reconcile() {
  if (enabled && token && host && WebSocket) {
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
  if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
  lastFrame = null;
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  pults.clear();
  pultsChanged();
}

function status() {
  return { enabled, hasToken: !!token, host, connected: !!(ws && ws.readyState === 1) };
}

function exit(sid) {
  if (sid === activeSid && lastFrame) lastFrame = null;
  send({ t: 'exit', sid });
}
function notifyState() { sendState(); }
// Для стора: прямая отправка пульту + объём неотправленного (бэкпрешер при стриме файлов).
function bufferedAmount() { return (ws && typeof ws.bufferedAmount === 'number') ? ws.bufferedAmount : 0; }

module.exports = { init, apply, stop, status, screenTouch, exit, notifyState, send, bufferedAmount, pultList, kick };
