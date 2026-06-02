// mobile.js — UI удалённого пульта LiteEditor (Android-WebView / браузер).
//
// ВЕСЬ обмен идёт по WebSocket (включая вход): fetch из file://-WebView виснет на
// CORS-preflight, а WS работает без CORS. Поток:
//   • есть сохранённый токен → connect(token) → сразу авторизованы (role=app).
//   • нет токена → connect('') (пред-авторизация) → отправляем {t:"login",...} →
//     ждём {t:"auth_ok",token} | {t:"auth_err",error}.
// Любая JS-ошибка шлётся на сервер ({t:"report"}) и показывается баннером — чтобы
// «чёрный экран»/«тишину» можно было диагностировать удалённо (таблица reports).
// БЕЗ xterm: на старых WebView (Chrome 79 и т.п.) xterm 5.x падает в асинхронном
// рендер-цикле. Терминал — простой <pre> с очисткой ANSI: рисует на любом WebView.

let ws = null;
let relayUrl = 'wss://lite.codecopy.ru/ws';
let token = '';
let selected = null;
let lastSessions = [];
let lastProjects = [];
let booted = false;
let reconnectTimer = null;
let authPending = null;   // {login,password} — отправить после открытия сокета
let authTimer = null;

const $ = (id) => document.getElementById(id);

// localStorage на file:// может бросать — оборачиваем (fallback в память).
const mem = {};
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return (k in mem) ? mem[k] : null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { mem[k] = v; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) { delete mem[k]; } }

// ----------------------------------------------------------- телеметрия/ошибки
let reportCount = 0;
function sendReport(kind, message, detail) {
  if (reportCount > 25) return;   // защита от флуда (повторяющиеся ошибки)
  reportCount++;
  const payload = JSON.stringify({
    t: 'report', kind: String(kind || ''), message: String(message || '').slice(0, 2000),
    detail: String(detail || '').slice(0, 8000), ua: (navigator && navigator.userAgent) || '',
    login: lsGet('lite_login') || '',
  });
  try {
    if (ws && ws.readyState === 1) { ws.send(payload); return; }
    const w = new WebSocket(relayUrl + '?role=app');     // транзиентное соединение
    w.onopen = () => { try { w.send(payload); } catch (_) {} setTimeout(() => { try { w.close(); } catch (_) {} }, 1000); };
  } catch (_) {}
}

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
window.addEventListener('error', (e) => {
  const msg = (e && e.message) || String(e);
  showFatal(msg);
  sendReport('js-error', msg, (e && e.error && e.error.stack) || ((e && e.filename) + ':' + (e && e.lineno)));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = (e && e.reason) || {};
  showFatal('promise: ' + (r.message || r));
  sendReport('promise', r.message || String(r), r.stack || '');
});

function setStatus(text, cls) { const el = $('status'); if (el) { el.textContent = text; el.className = cls || ''; } }

// ----------------------------------------------------------------- вход
function showLogin(errText) {
  $('login').style.display = 'flex';
  $('app').style.display = 'none';
  if (errText !== undefined) $('lg-err').textContent = errText || '';
}
function setAuthBusy(b) { const g = $('lg-go'); if (g) g.disabled = b; }
function authError(msg) { clearTimeout(authTimer); authTimer = null; authPending = null; setAuthBusy(false); $('lg-err').textContent = msg; }

function submitAuth() {
  const login = $('lg-login').value.trim().toLowerCase();
  const pass = $('lg-pass').value;
  $('lg-err').textContent = '';
  if (login.length < 3 || pass.length < 4) { $('lg-err').textContent = 'Логин ≥3, пароль ≥4 символа'; return; }
  setAuthBusy(true);
  authPending = { login, password: pass };
  clearTimeout(authTimer);
  authTimer = setTimeout(() => { authError('Нет связи с релеем'); sendReport('login-timeout', 'no auth reply in 12s', relayUrl); }, 12000);
  if (ws && ws.readyState === 1) flushAuth();
  else if (!ws || (ws.readyState !== 0)) connect();   // закрыт → открываем; connecting → ждём onopen
}
function flushAuth() {
  if (!authPending) return;
  send({ t: 'login', login: authPending.login, password: authPending.password });
}

function logout() {
  lsDel('lite_token'); lsDel('lite_login');
  token = '';
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  showLogin('');
  connect(); // пред-авторизованный сокет для нового входа
}

// ------------------------------------------------------------ терминал (текст)
let pre = null;

function initTerm() {
  const host = $('term');
  host.innerHTML = '';
  pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;height:100%;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#d6deeb;font:12px/1.35 monospace;padding:6px';
  host.appendChild(pre);
}
// Грубая чистка ANSI/OSC, чтобы текст был читаемым.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[[\]][0-9;?=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function writeOut(data) {
  if (!pre) return;
  pre.textContent += stripAnsi(data);
  if (pre.textContent.length > 120000) pre.textContent = pre.textContent.slice(-90000);
  pre.scrollTop = pre.scrollHeight;
}
function clearOut() { if (pre) pre.textContent = ''; }
function focusOut() {}

// Дерево вкладок: проекты по категориям (как сайдбар редактора), под каждым —
// открытые терминалы; «＋» рядом с проектом — открыть терминал удалённо.
function renderTree() {
  const box = $('tabs');
  box.innerHTML = '';
  const projects = lastProjects || [];
  const sessions = lastSessions || [];
  const byProj = {};
  for (const s of sessions) { const k = s.projId || '__none__'; (byProj[k] = byProj[k] || []).push(s); }

  const fav = projects.filter((p) => p.favorite);
  const cats = {};
  for (const p of projects) { if (p.favorite) continue; const c = p.category || 'Все'; (cats[c] = cats[c] || []).push(p); }
  const groups = [];
  if (fav.length) groups.push(['★ Избранное', fav]);
  Object.keys(cats).sort((a, b) => (a === 'Все') - (b === 'Все') || a.localeCompare(b)).forEach((c) => groups.push([c, cats[c]]));

  const addCat = (name) => { const h = document.createElement('div'); h.className = 'cat'; h.textContent = name; box.appendChild(h); };
  const addSession = (s) => {
    const t = document.createElement('div');
    t.className = 'tab' + (s.sid === selected ? ' active' : '');
    t.textContent = s.tab || s.label || s.sid;
    t.onclick = () => selectSession(s.sid);
    box.appendChild(t);
  };

  for (const g of groups) {
    addCat(g[0]);
    for (const p of g[1]) {
      const pr = document.createElement('div');
      pr.className = 'proj';
      const nm = document.createElement('span'); nm.className = 'proj-name'; nm.textContent = p.name;
      const plus = document.createElement('button'); plus.className = 'open'; plus.textContent = '＋';
      plus.onclick = (e) => { e.stopPropagation(); send({ t: 'open', projId: p.id }); };
      pr.appendChild(nm); pr.appendChild(plus);
      box.appendChild(pr);
      for (const s of (byProj[p.id] || [])) addSession(s);
    }
  }
  const known = {}; projects.forEach((p) => { known[p.id] = 1; });
  const orphans = sessions.filter((s) => !s.projId || !known[s.projId]);
  if (orphans.length) { addCat('Прочее'); orphans.forEach(addSession); }

  if (!selected && sessions.length) selectSession(sessions[0].sid);
}
function selectSession(sid) {
  selected = sid;
  clearOut();
  send({ t: 'select', sid });
  renderTree();
  focusOut();
}
function sendInput(data) { if (selected) send({ t: 'input', sid: selected, data }); }
function send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} } }

// ----------------------------------------------------------------- соединение
function connect() {
  const url = `${relayUrl}?token=${encodeURIComponent(token)}&role=app`;
  if (token) setStatus('Подключение…', 'wait');
  try { ws = new WebSocket(url); } catch (e) { sendReport('ws-fail', String(e), url); scheduleReconnect(); return; }

  ws.onopen = () => {
    if (token) { setStatus('● На связи', 'ok'); send({ t: 'hello' }); }
    else if (authPending) { flushAuth(); }
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'auth_ok') {
      clearTimeout(authTimer); authTimer = null; authPending = null;
      token = m.token; lsSet('lite_token', token); lsSet('lite_login', m.login || '');
      setAuthBusy(false);
      enterApp();
      setStatus('● На связи', 'ok');
      send({ t: 'hello' });
    } else if (m.t === 'auth_err') {
      authError(m.error || 'Ошибка входа');
    } else if (m.t === 'state') { lastSessions = m.sessions || []; lastProjects = m.projects || []; renderTree(); }
    else if (m.t === 'data') { if (m.sid === selected) writeOut(m.data || ''); }
    else if (m.t === 'exit') { if (m.sid === selected) writeOut('\r\n[сессия завершена]\r\n'); }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'leave') { setStatus('ПК отключился', 'wait'); }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'join') { setStatus('● На связи', 'ok'); send({ t: 'hello' }); }
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!ws) connect(); }, 3000);
}

function wirePrompt() {
  const pmt = $('pmt');
  const fire = () => { const t = pmt.value; if (!t) return; sendInput(t + '\r'); pmt.value = ''; focusOut(); };
  $('send').onclick = fire;
  pmt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); } });
}

function enterApp() {
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
  if (!pre) { initTerm(); wirePrompt(); }
  const w = $('whoami'); if (w) w.textContent = lsGet('lite_login') || '';
}

function start(config) {
  if (config && config.relayUrl) relayUrl = config.relayUrl;
  if (booted) return;  // Android зовёт __bootLite после DOMContentLoaded — не дублируем
  booted = true;
  try {
    $('lg-go').onclick = submitAuth;
    $('lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    const lo = $('logout'); if (lo) lo.onclick = logout;
    token = lsGet('lite_token') || '';
    if (token) enterApp(); else showLogin('');
    connect();           // с токеном → авторизуемся; без → пред-авторизованный сокет для входа
    sendReport('boot', 'app started v0.7.0', (token ? 'has-token' : 'no-token'));
  } catch (e) {
    showLogin('');
    showFatal('start: ' + ((e && e.message) || e));
    sendReport('start-error', (e && e.message) || String(e), (e && e.stack) || '');
  }
}

window.__bootLite = (config) => start(config);
document.addEventListener('DOMContentLoaded', () => {
  const q = new URLSearchParams(location.search);
  start({ relayUrl: q.get('relay') || relayUrl });
});
