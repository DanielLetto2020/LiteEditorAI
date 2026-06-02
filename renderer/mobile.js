// mobile.js — UI удалённого пульта LiteEditor (внутри Android-WebView / в браузере).
//
// Слева — список вкладок-сессий с ПК, справа — терминал (xterm) с живым выводом,
// снизу — поле промпта. Канал — WebSocket к релею (lite.codecopy.ru, role=app);
// релей склеивает нас с ПК-редактором (role=pc) по общей комнате.
//
// Конфиг приходит двумя путями:
//   • Android: MainActivity зовёт window.__bootLite({relayUrl, room, token}).
//   • Браузер (тест): из query — ?relay=wss://...&token=...&room=default.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

let ws = null;
let cfg = null;
let selected = null;
let term = null;
let fit = null;
let reconnectTimer = null;
let manualClose = false;

const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const el = $('status');
  if (el) { el.textContent = text; el.className = cls || ''; }
}

function initTerm() {
  term = new Terminal({
    fontSize: 13,
    fontFamily: 'monospace',
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    theme: { background: '#0d1117', foreground: '#d6deeb', cursor: '#7fdbca' },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  try { fit.fit(); } catch (_) {}
  window.addEventListener('resize', () => { try { fit.fit(); } catch (_) {} });
  // Прямой набор в терминал тоже шлём как ввод (по желанию).
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
    const el = document.createElement('div');
    el.className = 'tab' + (s.sid === selected ? ' active' : '');
    el.textContent = s.label || s.sid;
    el.onclick = () => selectSession(s.sid);
    box.appendChild(el);
  }
  // Если ничего не выбрано — выбрать первую автоматически.
  if (!selected && sessions.length) selectSession(sessions[0].sid);
}

function selectSession(sid) {
  selected = sid;
  if (term) term.reset();
  // подсветить активную вкладку
  for (const el of document.querySelectorAll('#tabs .tab')) {
    el.classList.toggle('active', el.textContent && false); // перерисуем через renderTabs ниже
  }
  send({ t: 'select', sid });
  // обновим подсветку
  for (const el of document.querySelectorAll('#tabs .tab')) el.classList.remove('active');
  // (renderTabs всё равно перерисует при следующем state)
  if (term) term.focus();
}

function sendInput(data) {
  if (!selected) return;
  send({ t: 'input', sid: selected, data });
}

function send(obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
}

function connect() {
  if (!cfg || !cfg.token) { setStatus('Нет конфигурации (token)', 'bad'); return; }
  const base = cfg.relayUrl || 'wss://lite.codecopy.ru/ws';
  const url = `${base}?token=${encodeURIComponent(cfg.token)}&room=${encodeURIComponent(cfg.room || 'default')}&role=app`;
  setStatus('Подключение…', 'wait');
  try { ws = new WebSocket(url); } catch (e) { setStatus('Ошибка WS', 'bad'); scheduleReconnect(); return; }

  ws.onopen = () => { setStatus('● На связи', 'ok'); send({ t: 'hello' }); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'state') { renderTabs(m.sessions || []); }
    else if (m.t === 'data') { if (m.sid === selected && term) term.write(m.data || ''); }
    else if (m.t === 'exit') { if (m.sid === selected && term) term.write('\r\n\x1b[90m[сессия завершена]\x1b[0m\r\n'); }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'leave') { setStatus('ПК отключился', 'wait'); }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'join') { setStatus('● На связи', 'ok'); send({ t: 'hello' }); }
  };
  ws.onclose = () => { if (!manualClose) { setStatus('Переподключение…', 'wait'); scheduleReconnect(); } };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

function wirePrompt() {
  const send_btn = $('send');
  const pmt = $('pmt');
  const fire = () => {
    const text = pmt.value;
    if (!text) return;
    sendInput(text + '\r'); // как Enter — промпт уходит и выполняется
    pmt.value = '';
    if (term) term.focus();
  };
  send_btn.onclick = fire;
  // Enter в поле = отправить (Shift+Enter — перенос строки)
  pmt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); }
  });
}

function start(config) {
  cfg = config;
  if (!term) { initTerm(); wirePrompt(); }
  manualClose = false;
  try { ws && ws.close(); } catch (_) {}
  connect();
}

// Android вызывает это после загрузки страницы.
window.__bootLite = (config) => start(config);

// Браузерный путь: конфиг из query (для теста на десктопе/в обычном браузере).
document.addEventListener('DOMContentLoaded', () => {
  const q = new URLSearchParams(location.search);
  if (q.get('token')) {
    start({
      relayUrl: q.get('relay') || 'wss://lite.codecopy.ru/ws',
      token: q.get('token') || '',
      room: q.get('room') || 'default',
    });
  } else {
    // ждём __bootLite от Android; покажем заглушку-статус
    if (!term) { initTerm(); wirePrompt(); }
    setStatus('Ожидание конфигурации…', 'wait');
  }
});
