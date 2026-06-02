// mobile.js — UI удалённого пульта LiteEditor (Android-WebView / браузер).
//
// Вход по логину/паролю (аккаунт создаётся в редакторе на ПК). При входе клиент
// получает от релея токен сессии (POST /login), кладёт в localStorage и
// подключается к релею (role=app). Дальше: слева вкладки ПК, справа терминал,
// снизу — поле промпта.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

let ws = null;
let relayUrl = 'wss://lite.codecopy.ru/ws';
let httpBase = 'https://lite.codecopy.ru';
let token = '';
let selected = null;
let term = null;
let fit = null;
let reconnectTimer = null;
let lastSessions = [];
let booted = false;

const $ = (id) => document.getElementById(id);

// localStorage на file://-странице WebView может бросать SecurityError — оборачиваем
// и падаем в память (токен переживёт сессию, но не полный перезапуск приложения).
const mem = {};
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return (k in mem) ? mem[k] : null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { mem[k] = v; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) { delete mem[k]; } }

// Видимый баннер ошибок — чтобы на планшете не было «чёрного экрана» без причины.
function showFatal(msg) {
  let b = $('fatal');
  if (!b) {
    b = document.createElement('div');
    b.id = 'fatal';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#5a1620;color:#fff;'
      + 'font:12px monospace;padding:8px;white-space:pre-wrap;max-height:40%;overflow:auto';
    document.body.appendChild(b);
  }
  b.textContent = 'Ошибка: ' + msg;
}
window.addEventListener('error', (e) => showFatal((e && e.message) || String(e)));
window.addEventListener('unhandledrejection', (e) => showFatal('promise: ' + ((e && e.reason && e.reason.message) || e.reason)));

function deriveHttp(wsu) {
  return wsu.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '');
}

function setStatus(text, cls) {
  const el = $('status');
  if (el) { el.textContent = text; el.className = cls || ''; }
}

// ----------------------------------------------------------------- вход
function showLogin(errText) {
  $('login').style.display = 'flex';
  $('app').style.display = 'none';
  if (errText) $('lg-err').textContent = errText;
}

async function doLogin() {
  const login = $('lg-login').value.trim().toLowerCase();
  const pass = $('lg-pass').value;
  $('lg-err').textContent = '';
  if (login.length < 3 || pass.length < 4) { $('lg-err').textContent = 'Логин ≥3, пароль ≥4 символа'; return; }
  $('lg-go').disabled = true;
  try {
    const res = await fetch(httpBase + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password: pass }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      token = data.token;
      lsSet('lite_token', token);
      lsSet('lite_login', data.login || login);
      enterApp();
    } else {
      $('lg-err').textContent = data.detail || (res.status === 401 ? 'Неверный логин или пароль' : 'Ошибка входа');
    }
  } catch (e) {
    $('lg-err').textContent = 'Нет связи с релеем';
  } finally {
    $('lg-go').disabled = false;
  }
}

function logout() {
  lsDel('lite_token');
  lsDel('lite_login');
  token = '';
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  showLogin('');
}

// ----------------------------------------------------------------- терминал
function initTerm() {
  term = new Terminal({
    fontSize: 13, fontFamily: 'monospace', cursorBlink: true, scrollback: 5000,
    theme: { background: '#0d1117', foreground: '#d6deeb', cursor: '#7fdbca' },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  try { fit.fit(); } catch (_) {}
  window.addEventListener('resize', () => { try { fit.fit(); } catch (_) {} });
  term.onData((d) => sendInput(d));
}

function renderTabs(sessions) {
  const box = $('tabs');
  box.innerHTML = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'tab-empty';
    empty.textContent = 'Нет открытых терминалов на ПК';
    box.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const elx = document.createElement('div');
    elx.className = 'tab' + (s.sid === selected ? ' active' : '');
    elx.textContent = s.label || s.sid;
    elx.onclick = () => selectSession(s.sid);
    box.appendChild(elx);
  }
  if (!selected && sessions.length) selectSession(sessions[0].sid);
}

function selectSession(sid) {
  selected = sid;
  if (term) term.reset();
  send({ t: 'select', sid });
  renderTabs(lastSessions);
  if (term) term.focus();
}

function sendInput(data) { if (selected) send({ t: 'input', sid: selected, data }); }
function send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} } }

function connect() {
  if (!token) { showLogin(''); return; }
  const url = `${relayUrl}?token=${encodeURIComponent(token)}&role=app`;
  setStatus('Подключение…', 'wait');
  try { ws = new WebSocket(url); } catch (e) { setStatus('Ошибка WS', 'bad'); scheduleReconnect(); return; }

  ws.onopen = () => { setStatus('● На связи', 'ok'); send({ t: 'hello' }); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'state') { lastSessions = m.sessions || []; renderTabs(lastSessions); }
    else if (m.t === 'data') { if (m.sid === selected && term) term.write(m.data || ''); }
    else if (m.t === 'exit') { if (m.sid === selected && term) term.write('\r\n\x1b[90m[сессия завершена]\x1b[0m\r\n'); }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'leave') { setStatus('ПК отключился', 'wait'); }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'join') { setStatus('● На связи', 'ok'); send({ t: 'hello' }); }
  };
  ws.onclose = (ev) => {
    ws = null;
    if (ev && ev.code === 4401) { logout(); return; } // токен протух/неверен → на экран входа
    setStatus('Переподключение…', 'wait'); scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function scheduleReconnect() {
  if (!token) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!ws) connect(); }, 3000);
}

function wirePrompt() {
  const pmt = $('pmt');
  const fire = () => {
    const text = pmt.value;
    if (!text) return;
    sendInput(text + '\r');
    pmt.value = '';
    if (term) term.focus();
  };
  $('send').onclick = fire;
  pmt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); } });
}

function enterApp() {
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
  if (!term) { initTerm(); wirePrompt(); }
  const who = lsGet('lite_login') || '';
  const wEl = $('whoami'); if (wEl) wEl.textContent = who;
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  connect();
}

function start(config) {
  if (config && config.relayUrl) relayUrl = config.relayUrl;
  httpBase = deriveHttp(relayUrl);
  if (booted) return; // Android зовёт __bootLite после DOMContentLoaded — не перезапускаем
  booted = true;
  try {
    $('lg-go').onclick = doLogin;
    $('lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    const lo = $('logout'); if (lo) lo.onclick = logout;
    token = lsGet('lite_token') || '';
    if (token) enterApp(); else showLogin('');
  } catch (e) {
    showLogin('');
    showFatal('start: ' + ((e && e.message) || e));
  }
}

// Android вызывает после загрузки. Браузер — из query (?relay=...).
window.__bootLite = (config) => start(config);
document.addEventListener('DOMContentLoaded', () => {
  const q = new URLSearchParams(location.search);
  start({ relayUrl: q.get('relay') || relayUrl });
});
