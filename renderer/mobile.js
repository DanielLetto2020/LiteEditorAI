// mobile.js — UI удалённого пульта LiteEditor (Android-WebView / браузер).
//
// ВЕСЬ обмен идёт по WebSocket (включая вход): fetch из file://-WebView виснет на
// CORS-preflight, а WS работает без CORS. Поток:
//   • есть сохранённый токен → connect(token) → сразу авторизованы (role=app).
//   • нет токена → connect('') (пред-авторизация) → отправляем {t:"login",...} →
//     ждём {t:"auth_ok",token} | {t:"auth_err",error}.
// Любая JS-ошибка шлётся на сервер ({t:"report"}) и показывается баннером — чтобы
// «чёрный экран»/«тишину» можно было диагностировать удалённо (таблица reports).
// Терминал — xterm 4.x (поддерживает старые WebView, в т.ч. Chrome 79; xterm 5.x
// там крашится). Если и он не заведётся — текстовый фолбэк.
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

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

// ----------------------------------------------------------- логи/телеметрия
const logBuf = [];
function pushLog(msg) {
  let t = ''; try { t = new Date().toLocaleTimeString(); } catch (_) {}
  logBuf.push('[' + t + '] ' + msg);
  if (logBuf.length > 400) logBuf.shift();
}

let reportCount = 0;
function sendReport(kind, message, detail) {
  pushLog('report:' + kind + ' ' + (message || ''));
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

function setStatus(text, cls) { pushLog('status: ' + text); const el = $('status'); if (el) { el.textContent = text; el.className = cls || ''; } }

// --- Меню в шапке: оверлей + экраны «Аккаунт» и «Логи» ---
function showOverlay(title, bodyEl) {
  let ov = $('overlay');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:14px';
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
    document.body.appendChild(ov);
  }
  ov.innerHTML = '';
  const card = document.createElement('div');
  card.style.cssText = 'background:#11161d;border:1px solid #2a323d;border-radius:10px;width:440px;max-width:92vw;max-height:82vh;overflow:auto;padding:14px';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px';
  const tt = document.createElement('b'); tt.textContent = title; tt.style.color = '#7fdbca';
  const x = document.createElement('button'); x.textContent = '✕';
  x.style.cssText = 'background:none;border:0;color:#9fb0c0;font-size:18px';
  x.onclick = () => { ov.style.display = 'none'; };
  head.appendChild(tt); head.appendChild(x);
  card.appendChild(head); card.appendChild(bodyEl);
  ov.appendChild(card); ov.style.display = 'flex';
}
function showAccount() {
  const b = document.createElement('div');
  const who = document.createElement('div');
  who.style.cssText = 'color:#d6deeb;margin-bottom:12px';
  who.textContent = 'Вы вошли как: ' + (lsGet('lite_login') || '—');
  const ver = document.createElement('div');
  ver.style.cssText = 'color:#5a6675;font-size:12px;margin-bottom:14px';
  ver.textContent = 'Версия пульта: ' + (window.PULT_VER || '');
  const out = document.createElement('button');
  out.textContent = 'Выйти / сменить аккаунт';
  out.style.cssText = 'background:#5a1620;color:#fff;border:0;border-radius:6px;padding:10px 14px;font-size:14px';
  out.onclick = () => { const ov = $('overlay'); if (ov) ov.style.display = 'none'; logout(); };
  b.appendChild(who); b.appendChild(ver); b.appendChild(out);
  showOverlay('Аккаунт', b);
}
function showLogs() {
  const b = document.createElement('div');
  const lp = document.createElement('pre');
  lp.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:#b7c2d0;font:11px/1.4 monospace;max-height:62vh;overflow:auto';
  lp.textContent = logBuf.slice().reverse().join('\n') || 'пусто';
  const row = document.createElement('div'); row.style.cssText = 'margin-top:10px;display:flex;gap:8px';
  const cp = document.createElement('button'); cp.textContent = 'Копировать';
  cp.style.cssText = 'background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:8px 12px';
  cp.onclick = () => { try { navigator.clipboard.writeText(logBuf.join('\n')); } catch (_) {} };
  row.appendChild(cp); b.appendChild(lp); b.appendChild(row);
  showOverlay('Логи пульта', b);
}
// ☰ → оверлей-меню с кнопками (надёжнее дропдауна на тач-экране).
function openMenu() {
  const b = document.createElement('div');
  const mk = (label, fn) => {
    const x = document.createElement('button');
    x.textContent = label;
    x.style.cssText = 'display:block;width:100%;text-align:left;background:#161c24;color:#d6deeb;border:1px solid #2a323d;border-radius:8px;padding:13px 14px;font-size:15px;margin-bottom:8px';
    x.onclick = () => { const ov = $('overlay'); if (ov) ov.style.display = 'none'; fn(); };
    return x;
  };
  b.appendChild(mk('Аккаунт', showAccount));
  b.appendChild(mk('Логи', showLogs));
  showOverlay('Меню', b);
}

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

// ------------------------------------------------------------ терминал
// Основной рендерер — xterm 4.x (DOM-рендерер; работает на старых WebView, в т.ч.
// Chrome 79) — рисует TUI Claude Code корректно (курсор, спиннеры). Если упадёт —
// текстовый фолбэк. Ширина подстраивается под планшет: fit + ресайз PTY на ПК.
let term = null;
let fit = null;
let termOk = false;
let termInited = false;

function initTerm() {
  try {
    term = new Terminal({
      fontSize: 13, fontFamily: 'monospace', cursorBlink: true, scrollback: 800,
      rendererType: 'dom',
      theme: { background: '#0d1117', foreground: '#d6deeb', cursor: '#7fdbca' },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open($('term'));
    fitTerm();
    window.addEventListener('resize', fitTerm);
    term.onData((d) => sendInput(d));
    termOk = true;
  } catch (e) {
    termOk = false;
    sendReport('xterm4-init', (e && e.message) || String(e), (e && e.stack) || '');
    initPre();
  }
}
// Подгоняем размер под планшет и сообщаем ПК новый размер PTY (адаптация ширины).
function fitTerm() {
  if (!termOk || !fit) return;
  try {
    fit.fit();
    if (selected && term.cols > 0) send({ t: 'resize', sid: selected, cols: term.cols, rows: term.rows });
  } catch (_) {}
}
function writeOut(data) {
  if (termOk) {
    try { term.write(data); return; }
    catch (e) { sendReport('xterm4-write', (e && e.message) || '', (e && e.stack) || ''); termOk = false; initPre(); }
  }
  appendPre(data);
}
function clearOut() {
  if (termOk) { try { term.reset(); } catch (_) {} return; }
  lineBuf = ['']; curRow = 0; curCol = 0; if (pre) pre.textContent = '';
}
function focusOut() { if (termOk) { try { term.focus(); } catch (_) {} } }

// --- текстовый фолбэк (если xterm не завёлся) ---
let pre = null;
let lineBuf = [''];
let curRow = 0;
let curCol = 0;
function initPre() {
  const host = $('term'); host.innerHTML = '';
  pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;height:100%;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#d6deeb;font:12px/1.4 monospace;padding:6px';
  host.appendChild(pre);
  lineBuf = ['']; curRow = 0; curCol = 0;
}
function renderPre() {
  if (lineBuf.length > 500) { const drop = lineBuf.length - 400; lineBuf = lineBuf.slice(drop); curRow = Math.max(0, curRow - drop); }
  pre.textContent = lineBuf.join('\n');
  pre.scrollTop = pre.scrollHeight;
}
function putChar(ch) {
  let line = lineBuf[curRow] || '';
  if (curCol > line.length) line = line + ' '.repeat(curCol - line.length);
  lineBuf[curRow] = line.slice(0, curCol) + ch + line.slice(curCol + 1);
  curCol++;
}
function appendPre(data) {
  if (!pre) return;
  data = String(data);
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      if (data[i + 1] === '[') {
        let j = i + 2;
        while (j < data.length && !/[@-~]/.test(data[j])) j++;
        const fin = data[j], params = data.slice(i + 2, j);
        if (fin === 'K') {
          const line = lineBuf[curRow] || '';
          if (params === '2') lineBuf[curRow] = '';
          else if (params !== '1') lineBuf[curRow] = line.slice(0, curCol);
        } else if (fin === 'J' && (params === '2' || params === '3')) { lineBuf = ['']; curRow = 0; curCol = 0; }
        i = j; continue;
      } else if (data[i + 1] === ']') {
        let j = i + 2;
        while (j < data.length && data[j] !== '\x07' && data[j] !== '\x1b') j++;
        if (data[j] === '\x1b') j++;
        i = j; continue;
      } else { i++; continue; }
    }
    if (ch === '\r') { curCol = 0; continue; }
    if (ch === '\n') { curRow++; curCol = 0; if (lineBuf[curRow] === undefined) lineBuf[curRow] = ''; continue; }
    if (ch === '\b') { if (curCol > 0) curCol--; continue; }
    if (ch === '\t') { putChar(' '); while (curCol % 4 !== 0) putChar(' '); continue; }
    if (ch < ' ') continue;
    putChar(ch);
  }
  renderPre();
}

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
}
function selectSession(sid) {
  selected = sid;
  clearOut();
  send({ t: 'select', sid });
  fitTerm();           // подстроить PTY на ПК под ширину планшета для этой сессии
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
    } else if (m.t === 'state') {
      lastSessions = m.sessions || []; lastProjects = m.projects || []; renderTree();
      // Синхронизация активной вкладки: следуем за активной на ПК.
      if (m.active && m.active !== selected) selectSession(m.active);
      else if (!selected && lastSessions.length) selectSession(lastSessions[0].sid);
    }
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
  if (!termInited) { termInited = true; initTerm(); wirePrompt(); }
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
    // Шапка: версия справа + меню (Аккаунт, Логи).
    const ver = $('top-ver'); if (ver) ver.textContent = window.PULT_VER || '';
    const mb = $('menu-btn'); if (mb) mb.onclick = openMenu;
    token = lsGet('lite_token') || '';
    if (token) enterApp(); else showLogin('');
    connect();           // с токеном → авторизуемся; без → пред-авторизованный сокет для входа
    sendReport('boot', 'app started v0.9.0', (token ? 'has-token' : 'no-token'));
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
