// mobile.js — UI удалённого пульта LiteEditor (Android-WebView / браузер).
//
// ВЕСЬ обмен идёт по WebSocket (включая вход): fetch из file://-WebView виснет на
// CORS-preflight, а WS работает без CORS. Поток:
//   • есть сохранённый токен → connect(token) → сразу авторизованы (role=app).
//   • нет токена → connect('') (пред-авторизация) → отправляем {t:"login",...} →
//     ждём {t:"auth_ok",token} | {t:"auth_err",error}.
// Любая JS-ошибка шлётся на сервер ({t:"report"}) и показывается баннером — чтобы
// «чёрный экран»/«тишину» можно было диагностировать удалённо (таблица reports).
// Терминал на пульте держим на том же xterm 5-стеке, что и редактор: это критично
// для одинаковой ширины Unicode/emoji/box-drawing символов между ПК и Android WebView.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

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
let awaitingRestart = false;   // ждём подтверждения перезапуска редактора на ПК
let restartGraceUntil = 0;     // окно, в котором leave старой копии — ожидаемый шум (не «ПК отключился»)
let resyncTerm = false;        // нужно пересобрать терминал и перезапросить буфер (после рестарта/возврата ПК)

const $ = (id) => document.getElementById(id);

// localStorage на file:// может бросать — оборачиваем (fallback в память).
const mem = {};
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return (k in mem) ? mem[k] : null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { mem[k] = v; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) { delete mem[k]; } }

// ----------------------------------------------- идентичность устройства (pairing)
// Стабильный per-устройство id (одобряется на ПК один раз). Имя — модель из UA для
// наглядности в модалке одобрения на ПК.
function deviceId() {
  let id = lsGet('lite_device_id');
  if (!id) { id = 'd' + randHex(16); lsSet('lite_device_id', id); }   // 128 бит, неугадываемо
  return id;
}
// Криптостойкие случайные байты → hex. device_id ключует одобрение устройства на релее:
// предсказуемый id позволил бы перебором найти чужой одобренный → обойти пайринг. Поэтому
// CSPRNG (crypto.getRandomValues, есть в целевом WebView Chrome 79). Фолбэк — на крайний случай.
function randHex(nBytes) {
  try {
    const buf = new Uint8Array(nBytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    let s = '';
    for (let i = 0; i < nBytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
}
function deviceName() {
  let ua = ''; try { ua = (navigator && navigator.userAgent) || ''; } catch (_) {}
  const m = /Android[^;]*;\s*([^);]+)\)/.exec(ua);
  return (m && m[1] && m[1].trim()) ? m[1].trim() : 'Пульт';
}
let pairCode = '';        // показанный код подтверждения текущей заявки
let pairingShown = false; // экран пайринга уже показан (не спамим заявками на каждый need_pairing)

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

function setStatus(text, cls) { pushLog('status: ' + text); const el = $('top-status'); if (el) { el.textContent = text; el.className = cls || ''; } }

// --- Меню в шапке: оверлей + экраны «Аккаунт» и «Логи» ---
function showOverlay(title, bodyEl) {
  let ov = $('overlay');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'overlay';
    ov.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:60;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:14px';
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
function nativeDeviceInfo() {
  try {
    if (window.LiteDevice && window.LiteDevice.systemInfo) {
      const raw = window.LiteDevice.systemInfo();
      return raw ? JSON.parse(raw) : {};
    }
  } catch (e) { return { error: String((e && e.message) || e) }; }
  return {};
}
function collectDiagnostics() {
  const vv = window.visualViewport;
  const host = $('term');
  let lsOk = false;
  try { localStorage.setItem('__lite_diag', '1'); localStorage.removeItem('__lite_diag'); lsOk = true; } catch (_) {}
  let alt = false;
  try { alt = inAltBuffer(); } catch (_) {}
  return {
    time: new Date().toISOString(),
    pultVersion: window.PULT_VER || '',
    native: nativeDeviceInfo(),
    web: {
      userAgent: navigator.userAgent,
      language: navigator.language || '',
      platform: navigator.platform || '',
      cookieEnabled: !!navigator.cookieEnabled,
      online: navigator.onLine,
      localStorage: lsOk,
    },
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenWidth: screen && screen.width,
      screenHeight: screen && screen.height,
      screenAvailWidth: screen && screen.availWidth,
      screenAvailHeight: screen && screen.availHeight,
      orientation: screen && screen.orientation && screen.orientation.type,
      visualViewport: vv ? { width: vv.width, height: vv.height, offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft, scale: vv.scale } : null,
      pageXOffset: window.pageXOffset,
      pageYOffset: window.pageYOffset,
      bodyHeight: document.body && document.body.clientHeight,
      bodyTransform: document.body && document.body.style.transform,
    },
    terminal: {
      inited: termInited,
      ok: termOk,
      mode: termMode,
      readerLoading,
      readerTextLength: readerText.length,
      selected,
      cols: term && term.cols,
      rows: term && term.rows,
      fontSize: termFontSize(),
      altBuffer: alt,
      queueLength: outputQueue.length,
      writing: outputWriting,
      hostWidth: host && host.clientWidth,
      hostHeight: host && host.clientHeight,
      hostScrollTop: host && host.scrollTop,
      mobileGrid: host ? mobileGridForHost(host) : null,
      fitProposed: (() => { try { return fit && fit.proposeDimensions ? fit.proposeDimensions() : null; } catch (_) { return null; } })(),
      dom: measureTermDom(),
      sessionSize: selected ? termSizeOf(selected) : null,
      sessions: (lastSessions || []).length,
      projects: (lastProjects || []).length,
    },
    connection: {
      relayUrl,
      hasToken: !!token,
      wsState: ws ? ws.readyState : null,
      selected,
    },
  };
}
function diagnosticsText() {
  try { return JSON.stringify(collectDiagnostics(), null, 2); }
  catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }, null, 2); }
}
function showSystemInfo() {
  const b = document.createElement('div');
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:#b7c2d0;font:11px/1.4 monospace;max-height:62vh;overflow:auto';
  pre.textContent = diagnosticsText();
  const row = document.createElement('div'); row.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap';
  const cp = document.createElement('button'); cp.textContent = 'Копировать';
  cp.style.cssText = 'background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:8px 12px';
  cp.onclick = () => { try { navigator.clipboard.writeText(pre.textContent || ''); } catch (_) {} };
  const rf = document.createElement('button'); rf.textContent = 'Обновить';
  rf.style.cssText = 'background:#1c2530;color:#d6deeb;border:1px solid #2a323d;border-radius:6px;padding:8px 12px';
  rf.onclick = () => { pre.textContent = diagnosticsText(); };
  row.appendChild(cp); row.appendChild(rf);
  b.appendChild(pre); b.appendChild(row);
  showOverlay('Система', b);
}
// ☰ → оверлей-меню группами (как менюбар ПК-редактора: Аккаунт / Файл / Логи).
function openMenu() {
  const b = document.createElement('div');
  const sect = (title) => { const s = document.createElement('div'); s.textContent = title; s.style.cssText = 'font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:#7fdbca;margin:10px 2px 6px'; b.appendChild(s); };
  const mk = (label, fn) => {
    const x = document.createElement('button');
    x.textContent = label;
    x.style.cssText = 'display:block;width:100%;text-align:left;background:#161c24;color:#d6deeb;border:1px solid #2a323d;border-radius:8px;padding:12px 14px;font-size:15px;margin-bottom:6px';
    x.onclick = () => { const ov = $('overlay'); if (ov) ov.style.display = 'none'; fn(); };
    b.appendChild(x);
  };
  sect('Аккаунт'); mk('Информация', showAccount);
  sect('Устройство'); mk('🔗 Подключить это устройство', startPairing);
  sect('Файл'); mk('📁 Стор — файлы с ПК', showStore); mk('Создать папку', showNewFolder);
  sect('Редактор (ПК)'); mk('⟲ Перезапустить редактор', showRestartPC);
  sect('Диагностика'); mk('Система', showSystemInfo); mk('Логи', showLogs);
  showOverlay('Меню', b);
}

// ----------------------------------------------------------------- стор (файлы с ПК)
// Read-only: листаем разрешённые на ПК папки и скачиваем файлы/папки (папка → zip).
// Скачивание стримится чанками по релею; сохраняем через нативный мост LiteNative
// (в «Загрузки»), а в браузере (отладка) — через blob-ссылку.
let storeBox = null;
let storePath = '';
let storeStack = [];
let storeReqSeq = 0;
const storePending = {};   // reqId → {name,size,recv,token,parts}
let historyReqSeq = 0;
const historyPending = {}; // reqId → {pre, parts, size, got, timer}

function showStore() {
  const b = document.createElement('div');
  b.innerHTML = '';
  const bar = document.createElement('div'); bar.id = 'store-bar';
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;min-height:24px';
  const list = document.createElement('div'); list.id = 'store-list';
  const prog = document.createElement('div'); prog.id = 'store-prog';
  prog.style.cssText = 'margin-top:10px;font-size:12px;color:#7fdbca;min-height:16px;word-break:break-word';
  b.appendChild(bar); b.appendChild(list); b.appendChild(prog);
  storeBox = b; storePath = ''; storeStack = [];
  showOverlay('Файлы с ПК', b);
  reqStoreList('');
}
function setStoreStatus(t) { const p = storeBox && storeBox.querySelector('#store-prog'); if (p) p.textContent = t || ''; }
function reqStoreList(path) { storePath = path; setStoreStatus('Загрузка…'); send({ t: 'store:list', reqId: 'l' + (storeReqSeq++), path }); }
function renderStore(path, entries) {
  if (!storeBox) return;
  storePath = path;
  const bar = storeBox.querySelector('#store-bar');
  const list = storeBox.querySelector('#store-list');
  if (!bar || !list) return;
  bar.innerHTML = ''; list.innerHTML = '';
  if (path || storeStack.length) {
    const back = document.createElement('button');
    back.textContent = '←'; back.style.cssText = 'background:#1c2530;color:#cfe3ee;border:1px solid #2a323d;border-radius:6px;width:34px;height:30px;flex:0 0 auto;font-size:16px';
    back.onclick = () => { const prev = storeStack.length ? storeStack.pop() : ''; reqStoreList(prev); };
    bar.appendChild(back);
  }
  const crumb = document.createElement('span');
  crumb.style.cssText = 'font-size:11px;color:#9fb0c0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left';
  crumb.textContent = path || 'Разрешённые папки';
  bar.appendChild(crumb);
  if (!entries || !entries.length) {
    const e = document.createElement('div'); e.style.cssText = 'color:#5a6675;font-size:12px;padding:10px;line-height:1.5';
    e.textContent = path ? 'Пусто' : 'Нет разрешённых папок. Добавь их в редакторе на ПК: Настройки → «Доступ с пульта».';
    list.appendChild(e); return;
  }
  for (const en of entries) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid #161c24';
    const ic = document.createElement('span'); ic.textContent = en.isDir ? '📁' : '📄'; ic.style.cssText = 'flex:0 0 auto';
    const nm = document.createElement('span');
    nm.textContent = en.name + (en.isDir ? '' : '  ' + fmtSize(en.size));
    nm.style.cssText = 'flex:1;color:#d6deeb;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    if (en.isDir) nm.onclick = () => { storeStack.push(storePath); reqStoreList(en.path); };
    const dl = document.createElement('button');
    dl.textContent = '⬇'; dl.title = en.isDir ? 'Скачать папку (zip)' : 'Скачать файл';
    dl.style.cssText = 'background:#1c2530;color:#7fdbca;border:1px solid #2a323d;border-radius:6px;width:34px;height:30px;flex:0 0 auto;font-size:15px';
    dl.onclick = (e) => { e.stopPropagation(); startStoreDownload(en); };
    row.appendChild(ic); row.appendChild(nm); row.appendChild(dl);
    list.appendChild(row);
  }
}
function fmtSize(n) { n = n || 0; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(0) + ' КБ'; return (n / 1048576).toFixed(1) + ' МБ'; }
function startStoreDownload(en) {
  const reqId = 'd' + (storeReqSeq++);
  storePending[reqId] = { name: en.isDir ? (en.name + '.zip') : en.name, size: 0, recv: 0, token: null, parts: null };
  setStoreStatus('Запрос: ' + en.name + '…');
  send({ t: en.isDir ? 'store:getZip' : 'store:get', reqId, path: en.path });
}
// Собрать base64-части в файл в браузере (отладка без нативного моста). Декодируем КАЖДУЮ
// часть отдельно — куски кодировались независимо, склейка base64 была бы невалидной.
function browserSave(name, parts) {
  try {
    const bufs = parts.map((p) => { const bin = atob(p); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; });
    const url = URL.createObjectURL(new Blob(bufs));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 1500);
  } catch (_) {}
}


function requestHistory(sid, opts) {
  opts = opts || {};
  if (!sid) return '';
  const bound = opts.bindTo || opts.pre || null;
  if (bound && bound._historyReqId && historyPending[bound._historyReqId]) {
    clearTimeout(historyPending[bound._historyReqId].timer);
    delete historyPending[bound._historyReqId];
  }
  const reqId = 'h' + (historyReqSeq++);
  const timer = setTimeout(() => {
    const h = historyPending[reqId];
    if (!h) return;
    if (h.onTimeout) h.onTimeout(h);
    else if (h.pre) h.pre.textContent = h.timeoutText || 'История не ответила.';
    delete historyPending[reqId];
  }, opts.timeoutMs || 8000);
  historyPending[reqId] = {
    sid,
    pre: opts.pre || null,
    parts: [],
    size: 0,
    got: 0,
    timer,
    timeoutText: opts.timeoutText || 'История не ответила.',
    onBegin: opts.onBegin,
    onProgress: opts.onProgress,
    onEnd: opts.onEnd,
    onError: opts.onError,
    onTimeout: opts.onTimeout,
  };
  if (bound) bound._historyReqId = reqId;
  send({ t: 'history:get', reqId, sid });
  return reqId;
}

function showHistory() {
  const b = document.createElement('div');
  const head = document.createElement('div');
  head.style.cssText = 'font-size:12px;color:#9fb0c0;margin-bottom:8px;line-height:1.4';
  head.textContent = selected ? ('Сессия: ' + selected) : 'Сессия не выбрана';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:#d6deeb;background:#0d1117;border:1px solid #2a323d;border-radius:8px;padding:10px;font:12px/1.45 monospace;max-height:62vh;overflow:auto';
  pre.textContent = selected ? 'Загрузка истории…' : 'Нет активной сессии';
  const row = document.createElement('div'); row.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap';
  const refresh = document.createElement('button'); refresh.textContent = 'Обновить';
  refresh.style.cssText = 'background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:8px 12px';
  const copy = document.createElement('button'); copy.textContent = 'Копировать';
  copy.style.cssText = 'background:#1c2530;color:#d6deeb;border:1px solid #2a323d;border-radius:6px;padding:8px 12px';
  copy.onclick = () => { try { navigator.clipboard.writeText(pre.textContent || ''); } catch (_) {} };
  const load = () => {
    if (!selected) return;
    pre.textContent = 'Загрузка истории…';
    requestHistory(selected, {
      pre,
      bindTo: pre,
      timeoutText: 'История не ответила.\n\nПерезапусти редактор на ПК из текущей версии проекта: старая ПК-сторона не умеет отдавать полную текстовую историю.',
    });
  };
  refresh.onclick = load;
  row.appendChild(refresh); row.appendChild(copy);
  b.appendChild(head); b.appendChild(pre); b.appendChild(row);
  showOverlay('История', b);
  load();
}

// Перезапуск редактора на ПК с пульта. Действие разрушительное (рвёт открытые терминалы
// и запущенных агентов), поэтому с подтверждением. После рестарта пульт переподключится сам.
function showRestartPC() {
  const b = document.createElement('div');
  const warn = document.createElement('div');
  warn.style.cssText = 'color:#e0af68;font-size:13px;line-height:1.5;margin-bottom:14px';
  warn.textContent = 'Редактор на ПК закроется и запустится заново. Все открытые терминалы и запущенные в них агенты прервутся. Пульт переподключится автоматически через несколько секунд.';
  const go = document.createElement('button');
  go.textContent = '⟲ Перезапустить редактор на ПК';
  go.style.cssText = 'background:#5a1620;color:#fff;border:0;border-radius:8px;padding:12px 14px;font-size:15px;width:100%';
  go.onclick = () => {
    awaitingRestart = true;
    send({ t: 'restartApp' });
    const ov = $('overlay'); if (ov) ov.style.display = 'none';
    setStatus('Перезапуск редактора на ПК…', 'wait');
    // Успех приходит явным {t:'restarted'} от новой копии (пульт↔релей не рвётся, поэтому
    // обрыв связи — НЕ показатель). Если за 50с подтверждения нет — считаем, что не вышло
    // (новая копия не поднялась / старый ПК-код). На ПК «наследнику» даётся 45с.
    setTimeout(() => {
      if (!awaitingRestart) return;
      awaitingRestart = false;
      const online = ws && ws.readyState === 1;
      setStatus(online ? '● На связи (перезапуск не подтверждён)' : 'Нет связи', online ? 'ok' : 'wait');
    }, 50000);
  };
  b.appendChild(warn); b.appendChild(go);
  showOverlay('Перезапустить редактор', b);
}

// ----------------------------------------------------------- pairing (одобрение на ПК)
// Безопасность: даже зная пароль, чужое устройство не получит управление терминалом, пока
// его не одобрят на ПК. Пульт шлёт заявку с проверочным кодом (показан тут и на ПК — сверить).
function startPairing() {
  pairCode = String(Math.floor(1000 + Math.random() * 9000));   // 4 цифры
  send({ t: 'pair:request', name: deviceName(), pubkey: '', code: pairCode });
  showPairing(pairCode);
}
function showPairing(code) {
  const b = document.createElement('div');
  const info = document.createElement('div');
  info.style.cssText = 'color:#7fdbca;font-size:14px;line-height:1.5;margin-bottom:14px';
  info.textContent = 'Откройте редактор на ПК — там появится запрос на одобрение этого устройства. Сверьте код:';
  const big = document.createElement('div');
  big.textContent = code;
  big.style.cssText = 'font-size:40px;font-weight:700;letter-spacing:8px;text-align:center;color:#fff;background:#161c24;border:1px solid #2a323d;border-radius:10px;padding:16px;margin-bottom:12px';
  const note = document.createElement('div');
  note.style.cssText = 'color:#5a6675;font-size:12px;line-height:1.4';
  note.textContent = 'После одобрения на ПК терминал подключится автоматически.';
  b.appendChild(info); b.appendChild(big); b.appendChild(note);
  showOverlay('Подключение устройства', b);
}

// Создание папки — это КОМАНДА на ПК: вводим имя на планшете, ПК создаёт её в рабочем
// каталоге и открывает терминалом (новая вкладка прилетит в список через {t:'state'}).
function showNewFolder() {
  const b = document.createElement('div');
  const inp = document.createElement('input');
  inp.placeholder = 'Имя папки';
  inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('spellcheck', 'false');
  inp.style.cssText = 'width:100%;background:#11161d;color:#d6deeb;border:1px solid #2a323d;border-radius:8px;padding:12px;font-size:16px;margin-bottom:12px';
  const go = document.createElement('button');
  go.textContent = 'Создать на ПК';
  go.style.cssText = 'background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:12px 14px;font-size:15px;width:100%';
  const note = document.createElement('div');
  note.style.cssText = 'color:#5a6675;font-size:12px;margin-top:10px;line-height:1.4';
  note.textContent = 'Папка создаётся на ПК в рабочем каталоге редактора и сразу открывается терминалом.';
  const submit = () => {
    const name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    send({ t: 'newFolder', name });
    const ov = $('overlay'); if (ov) ov.style.display = 'none';
    setStatus('Создаю папку «' + name + '» на ПК…', 'wait');
    // Ack-протокола нет: если ПК не ответит новой вкладкой за 8с — вернём обычный статус
    // (например, на ПК не задан рабочий каталог или редактор не перезапущен после обновления).
    setTimeout(() => {
      const online = ws && ws.readyState === 1;
      setStatus(online ? '● На связи' : 'Нет связи', online ? 'ok' : 'wait');
    }, 8000);
  };
  go.onclick = submit;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  b.appendChild(inp); b.appendChild(go); b.appendChild(note);
  showOverlay('Создать папку', b);
  setTimeout(() => inp.focus(), 60);
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
// Основной рендерер — @xterm/xterm 5 с теми же Unicode-таблицами, что desktop/headless.
// Это убирает рассинхрон ширины символов между редактором и Android WebView.
// Если упадёт — текстовый фолбэк. Ширина подстраивается под планшет: fit + ресайз PTY на ПК.
let term = null;
let fit = null;
let termOk = false;
let termInited = false;
let termHostWired = false;
let viewportWired = false;
let relayoutTimer = null;
let delayedRelayoutTimer = null;
let rebuildTimer = null;
let outputEpoch = 0;
let outputWriting = false;
let outputQueue = [];
const OUTPUT_CHUNK = 8192;
const MOBILE_SCROLLBACK = 20000;
const PULT_MIN_COLS = 50;
const PULT_MAX_COLS = 120;
const PULT_MIN_ROWS = 16;
const PULT_MAX_ROWS = 48;
const TEXT_SCROLLBACK_MAX_CHARS = 4 * 1024 * 1024;
let lastSentSize = { sid: '', cols: 0, rows: 0 };
// Дефолт — полноценный xterm (TUI Claude/vim рисуются). Текстовый ридер остаётся
// только ручным фолбэком (кнопка «Текст»). Ключ term_mode2 — чтобы старое сохранённое
// 'text' (был дефолтом во время отладки) не залипало на этой версии.
let termMode = lsGet('term_mode2') || 'xterm';
let readerPre = null;
let readerText = '';
let readerSid = '';
let readerLoading = false;
let readerLiveText = '';
let readerFollow = true;

function setTermFontSize(size) {
  try {
    if (term && term.options) term.options.fontSize = size;
    else if (term && term.setOption) term.setOption('fontSize', size);
  } catch (_) {}
}
function termFontSize() {
  try {
    if (term && term.options) return term.options.fontSize;
    if (term && term.getOption) return term.getOption('fontSize');
  } catch (_) {}
  return null;
}
function isTextMode() { return termMode === 'text'; }
function updateTermModeButton() {
  const b = document.querySelector('.tk[data-key="mode"]');
  if (!b) return;
  b.textContent = isTextMode() ? 'Текст' : 'TTY';
  b.title = isTextMode() ? 'Стабильный текстовый режим' : 'Полный xterm-режим';
  b.classList.toggle('on', isTextMode());
}
function disposeXterm() {
  resetOutputQueue();
  if (term) { try { term.dispose(); } catch (_) {} }
  term = null; fit = null; termOk = false;
}
function stripAnsiForReader(data) {
  return String(data || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x07/g, '');
}
function appendTranscriptText(out, data) {
  out = String(out || '');
  const text = stripAnsiForReader(data);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      const j = out.lastIndexOf('\n');
      out = j >= 0 ? out.slice(0, j + 1) : '';
    } else if (ch === '\b' || ch === '\x7f') {
      const j = out.lastIndexOf('\n');
      if (out.length > (j + 1)) out = out.slice(0, -1);
    } else if (ch === '\n' || ch === '\t' || ch >= ' ') {
      out += ch;
    }
  }
  if (out.length > TEXT_SCROLLBACK_MAX_CHARS) out = out.slice(out.length - TEXT_SCROLLBACK_MAX_CHARS);
  return out;
}
function readerAtBottom() {
  if (!readerPre) return true;
  return readerPre.scrollTop + readerPre.clientHeight >= readerPre.scrollHeight - 16;
}
function renderReader(text) {
  if (!readerPre) return;
  const stick = readerFollow || readerAtBottom();
  readerPre.textContent = text != null ? String(text) : (readerText || '');
  if (stick) readerPre.scrollTop = readerPre.scrollHeight;
}
function initReader() {
  disposeXterm();
  const host = $('term');
  if (!host) return;
  host.innerHTML = '';
  readerPre = document.createElement('pre');
  readerPre.className = 'term-reader';
  readerPre.textContent = 'Выбери терминал слева';
  readerPre.addEventListener('scroll', () => { readerFollow = readerAtBottom(); }, { passive: true });
  host.appendChild(readerPre);
  readerText = ''; readerSid = ''; readerLoading = false; readerLiveText = ''; readerFollow = true;
}
function initOutputSurface() {
  if (isTextMode()) initReader();
  else initTerm();
  updateTermModeButton();
}
function clearReader() {
  readerText = ''; readerLiveText = ''; readerLoading = false; readerFollow = true;
  renderReader(selected ? 'Загрузка истории…' : 'Нет активной сессии');
}
function appendReaderLive(data) {
  if (!readerPre) initReader();
  if (readerLoading) {
    readerLiveText = appendTranscriptText(readerLiveText, data);
    return;
  }
  readerFollow = readerAtBottom();
  readerText = appendTranscriptText(readerText, data);
  renderReader();
}
function requestReaderHistory() {
  if (!selected || !isTextMode()) return;
  const sid = selected;
  readerSid = sid;
  readerLoading = true;
  readerLiveText = '';
  readerFollow = true;
  renderReader('Загрузка истории…');
  requestHistory(sid, {
    timeoutText: 'История не ответила. Перезапусти редактор на ПК из текущей версии проекта.',
    onBegin: (h) => { if (selected === sid && isTextMode()) renderReader('Загрузка истории 0%'); },
    onProgress: (h) => { if (selected === sid && isTextMode() && h.size) renderReader('Загрузка истории ' + Math.min(100, Math.floor(h.got * 100 / h.size)) + '%'); },
    onEnd: (text) => {
      if (selected !== sid || !isTextMode()) return;
      readerLoading = false;
      readerText = String(text || '') + readerLiveText;
      if (readerText.length > TEXT_SCROLLBACK_MAX_CHARS) readerText = readerText.slice(readerText.length - TEXT_SCROLLBACK_MAX_CHARS);
      readerLiveText = '';
      readerFollow = true;
      renderReader(readerText || 'История пока пустая.');
    },
    onError: (err) => {
      if (selected !== sid || !isTextMode()) return;
      readerLoading = false;
      renderReader('Ошибка истории: ' + (err || ''));
    },
    onTimeout: () => {
      if (selected !== sid || !isTextMode()) return;
      readerLoading = false;
      renderReader('История не ответила. Перезапусти редактор на ПК из текущей версии проекта.');
    },
  });
}
function toggleTermMode() {
  termMode = isTextMode() ? 'xterm' : 'text';
  lsSet('term_mode2', termMode);
  initOutputSurface();
  if (selected) selectSession(selected);
  else updateTermModeButton();
}

function initTerm() {
  try {
    term = new Terminal({
      allowProposedApi: true,
      fontSize: 12,
      fontFamily: '"Droid Sans Mono", "Roboto Mono", monospace',
      cursorBlink: true,
      scrollback: MOBILE_SCROLLBACK,
      customGlyphs: true,
      theme: { background: '#0d1117', foreground: '#d6deeb', cursor: '#7fdbca' },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch (e) {
      sendReport('xterm-unicode11', (e && e.message) || String(e), (e && e.stack) || '');
    }
    const host = $('term');
    term.open(host);
    // РЕНДЕРЕР: DOM (по умолчанию в xterm 4), НЕ Canvas. На планшетах дробный
    // devicePixelRatio (напр. 1.33) ломал замер ячейки в canvas-рендерере xterm 4
    // → текст уезжал за экран и кривой скрол. DOM-рендерер меряет ячейку из реального
    // DOM-элемента и работает корректно при любом DPR (см. xterm.js #2662, фикс в 5.0).
    term.onData((d) => sendInput(d));   // ввод (если подключена физическая/BT-клавиатура)
    // Глушим СИСТЕМНУЮ экранную клавиатуру: на старом Android-WebView она двигает UI и
    // рвёт скрол. inputmode=none не даёт ей всплывать; ввод идёт со своей клавиатуры (#kbd).
    const ta = host.querySelector('textarea');
    if (ta) { ta.setAttribute('inputmode', 'none'); ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('autocomplete', 'off'); }
    wireTermHost(host);
    termOk = true;
    scheduleTermRelayout('init', 40);
  } catch (e) {
    termOk = false;
    sendReport('xterm-init', (e && e.message) || String(e), (e && e.stack) || '');
    initPre();
  }
}
function wireTermHost(host) {
  if (!host || termHostWired) return;
  termHostWired = true;
  host.addEventListener('click', () => { if (!kbdShown) showKbd(true); });   // тап по терминалу → своя клавиатура
  attachTouchScroll(host);            // независимый скрол истории жестом на планшете
}
function wireViewportEvents() {
  if (viewportWired) return;
  viewportWired = true;
  window.addEventListener('resize', () => scheduleTermRelayout('window-resize', 80));
  window.addEventListener('orientationchange', () => {
    hardResetScroll();
    scheduleTerminalRebuild('orientation');
    scheduleTermRelayout('orientation-early', 80);
    scheduleTermRelayout('orientation-mid', 260);
    scheduleTermRelayout('orientation-late', 700);
  });
}
// Показываем сетку ТОГО ЖЕ размера, что на ПК (PTY), и масштабируем шрифт под ширину
// планшета — НЕ трогаем размер PTY (иначе на ПК сыпется). Высота клавиатуры на число
// колонок не влияет, поэтому открытие клавиатуры терминал не ломает.
function termSizeOf(sid) {
  const s = (lastSessions || []).find((x) => x.sid === sid);
  return { cols: (s && s.cols) || 80, rows: (s && s.rows) || 24 };
}
// Реальная высота строки моноширинного шрифта (в долях fontSize) — замеряем один раз.
// Угадывание коэффициента приводило
// к переоценке высоты сетки и вылезанию терминала за нижнюю границу.
let _lineRatio = 0;
function lineRatio() {
  if (_lineRatio) return _lineRatio;
  try {
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-family:monospace;font-size:100px;line-height:normal;white-space:pre';
    p.textContent = 'Mg|';
    document.body.appendChild(p);
    _lineRatio = (p.offsetHeight / 100) || 1.2;
    document.body.removeChild(p);
  } catch (_) { _lineRatio = 1.2; }
  return _lineRatio;
}
function clampNum(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function mobileGridForHost(host) {
  const w = Math.max(0, (host && host.clientWidth) || 0) - 8;
  const h = Math.max(0, (host && host.clientHeight) || 0) - 8;
  if (w < 120 || h < 120) return null;
  // Пульт должен быть читаемым. Не наследуем desktop-сетку 130x50+, а выбираем
  // собственный grid под экран и затем ресайзим PTY на ПК под этот grid.
  const targetFont = w < 620 ? 11 : 12;
  const ratio = lineRatio();
  let cols = Math.floor(w / (targetFont * 0.62));
  let rows = Math.floor(h / (targetFont * ratio));
  cols = clampNum(cols, PULT_MIN_COLS, PULT_MAX_COLS);
  rows = clampNum(rows, PULT_MIN_ROWS, PULT_MAX_ROWS);
  let font = Math.min(
    targetFont,
    Math.floor(w / cols / 0.62),
    Math.floor(h / rows / ratio)
  );
  font = clampNum(font || targetFont, 9, 14);
  return { cols, rows, font };
}
function reportMobileResize(cols, rows) {
  if (!selected || !cols || !rows) return;
  if (lastSentSize.sid === selected && lastSentSize.cols === cols && lastSentSize.rows === rows) return;
  lastSentSize = { sid: selected, cols, rows };
  send({ t: 'resize', sid: selected, cols, rows });
}
function measureTermDom() {
  const host = $('term');
  if (!host) return null;
  const screenEl = host.querySelector('.xterm-screen');
  const rowsEl = host.querySelector('.xterm-rows');
  const viewportEl = host.querySelector('.xterm-viewport');
  return {
    screenWidth: screenEl ? screenEl.offsetWidth : 0,
    screenHeight: screenEl ? screenEl.offsetHeight : 0,
    rowsWidth: rowsEl ? rowsEl.offsetWidth : 0,
    rowsHeight: rowsEl ? rowsEl.offsetHeight : 0,
    viewportWidth: viewportEl ? viewportEl.offsetWidth : 0,
    viewportHeight: viewportEl ? viewportEl.offsetHeight : 0,
  };
}
function enforceTermFit(cols, rows) {
  const host = $('term');
  if (!termOk || !term || !host) return;
  requestAnimationFrame(() => {
    const m = measureTermDom();
    if (!m) return;
    let nextRows = rows;
    let nextCols = cols;
    if (m.screenHeight > host.clientHeight + 2 && rows > PULT_MIN_ROWS) {
      const rowPx = Math.max(1, m.screenHeight / rows);
      nextRows = Math.max(PULT_MIN_ROWS, rows - Math.ceil((m.screenHeight - host.clientHeight) / rowPx) - 1);
    }
    if (m.screenWidth > host.clientWidth + 2 && cols > PULT_MIN_COLS) {
      const colPx = Math.max(1, m.screenWidth / cols);
      nextCols = Math.max(PULT_MIN_COLS, cols - Math.ceil((m.screenWidth - host.clientWidth) / colPx) - 1);
    }
    if (nextCols !== cols || nextRows !== rows) {
      try { term.resize(nextCols, nextRows); term.scrollToBottom(); } catch (_) {}
      reportMobileResize(nextCols, nextRows);
    }
  });
}
// Сетку терминала на планшете выбираем ПОД ПЛАНШЕТ (как ttyd/wetty/VS Code в браузере):
// ставим читаемый шрифт → FitAddon делит вьюпорт на ЗАМЕРЕННУЮ ячейку → получаем
// cols/rows, при которых текст ГАРАНТИРОВАННО влезает (не уезжает за экран). Затем
// ресайзим PTY на ПК под эту сетку (пульт «владеет» размером, пока подключён; ПК
// зеркалит ту же сетку — см. pty:remoteSize на стороне ПК). Раньше мы зеркалили
// широкую сетку ПК (134 кол.) и ужимали шрифт до 7px — нечитаемо и с переполнением.
function applyTermSize() {
  if (isTextMode()) return;
  if (!termOk || !selected) return;
  const host = $('term');
  if (!host) return;
  if ((host.clientWidth || 0) < 120 || (host.clientHeight || 0) < 120) {
    scheduleTermRelayout('host-not-ready', 160);
    return;
  }
  // Читаемый шрифт под ширину экрана (телефон/планшет). FitAddon сам подберёт число колонок.
  const w = host.clientWidth;
  const fontPx = w < 560 ? 12 : (w < 900 ? 13 : 14);
  setTermFontSize(fontPx);
  requestAnimationFrame(() => {
    try { if (fit) fit.fit(); }
    catch (e) { sendReport('xterm-fit', (e && e.message) || String(e), (e && e.stack) || ''); }
    // Подстраховка границами (на очень узких/широких экранах FitAddon может выйти за рамки).
    const cols = clampNum(term.cols || 80, PULT_MIN_COLS, PULT_MAX_COLS);
    const rows = clampNum(term.rows || 24, PULT_MIN_ROWS, PULT_MAX_ROWS);
    if (cols !== term.cols || rows !== term.rows) { try { term.resize(cols, rows); } catch (_) {} }
    // Страховка по ШИРИНЕ: на узких экранах видимый скроллбар/субпиксель иногда подрезает
    // последнюю колонку («не влезает по ширине»). Пока контент (.xterm-screen) шире области
    // прокрутки (.xterm-viewport без скроллбара) — ужимаем на колонку. Чтение offsetWidth
    // форсит reflow, поэтому замер в цикле актуален; guard — от зацикливания.
    try {
      const vp = host.querySelector('.xterm-viewport');
      const screen = host.querySelector('.xterm-screen');
      let guard = 0;
      while (vp && screen && term.cols > PULT_MIN_COLS && screen.offsetWidth > vp.clientWidth + 1 && guard++ < 8) {
        term.resize(term.cols - 1, term.rows);
      }
    } catch (_) {}
    try {
      term.scrollToBottom();
      if (term.refresh) term.refresh(0, Math.max(0, (term.rows || 1) - 1));
    } catch (_) {}
    reportMobileResize(term.cols, term.rows);   // планшет диктует размер PTY на ПК
    keepKbdInViewport();
  });
}
function scheduleTermRelayout(_reason, delay) {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    relayoutTimer = null;
    try { window.scrollTo(0, 0); } catch (_) {}
    try { if (document.documentElement) document.documentElement.scrollTop = 0; } catch (_) {}
    try { if (document.body) document.body.scrollTop = 0; } catch (_) {}
    keepKbdInViewport();
    applyTermSize();
    clearTimeout(delayedRelayoutTimer);
    delayedRelayoutTimer = setTimeout(() => {
      try { window.scrollTo(0, 0); } catch (_) {}
      try { if (document.documentElement) document.documentElement.scrollTop = 0; } catch (_) {}
      try { if (document.body) document.body.scrollTop = 0; } catch (_) {}
      keepKbdInViewport();
      applyTermSize();
    }, 220);
  }, delay == null ? 80 : delay);
}
function scheduleTerminalRebuild(reason) {
  if (!termInited) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (!selected) { scheduleTermRelayout(reason || 'rebuild-no-session', 80); return; }
    refreshTerm(reason || 'rebuild');
  }, 360);
}
function resetOutputQueue() {
  outputEpoch++;
  outputQueue = [];
  outputWriting = false;
}
function chunkTerminalData(data, epoch) {
  data = String(data || '');
  for (let i = 0; i < data.length; i += OUTPUT_CHUNK) {
    let end = Math.min(data.length, i + OUTPUT_CHUNK);
    const c = data.charCodeAt(end - 1);
    // Do not split UTF-16 surrogate pairs between writes.
    if (end < data.length && c >= 0xD800 && c <= 0xDBFF) end--;
    if (end <= i) end = Math.min(data.length, i + OUTPUT_CHUNK);
    outputQueue.push({ epoch, data: data.slice(i, end) });
    i = end - OUTPUT_CHUNK;
  }
}
function pumpOutputQueue() {
  if (outputWriting || !termOk || !term) return;
  while (outputQueue.length && outputQueue[0].epoch !== outputEpoch) outputQueue.shift();
  const item = outputQueue.shift();
  if (!item) return;
  outputWriting = true;
  try {
    term.write(item.data, () => {
      outputWriting = false;
      if (item.epoch === outputEpoch) pumpOutputQueue();
    });
  } catch (e) {
    outputWriting = false;
    sendReport('xterm-write', (e && e.message) || '', (e && e.stack) || '');
    termOk = false;
    initPre();
    appendPre(item.data);
  }
}
function writeOut(data) {
  if (isTextMode()) { appendReaderLive(data); return; }
  if (termOk && term) {
    const epoch = outputEpoch;
    chunkTerminalData(data, epoch);
    pumpOutputQueue();
    return;
  }
  appendPre(data);
}
function clearOut() {
  resetOutputQueue();
  if (isTextMode()) { clearReader(); return; }
  if (termOk) { try { term.reset(); } catch (_) {} return; }
  lineBuf = ['']; curRow = 0; curCol = 0; if (pre) pre.textContent = '';
}
function focusOut() { if (!isTextMode() && termOk) { try { term.focus(); } catch (_) {} } }

// Кнопка «⟳» в тулбаре: после ресайза под клавиатуру xterm иногда «осыпается»
// (строки DOM-рендерера съезжают). Полностью пересобираем терминал с нуля и
// перезапрашиваем буфер сессии у ПК (на {t:'select'} он шлёт весь буфер заново) —
// вёрстка собирается чисто.
function refreshTerm(reason) {
  resetOutputQueue();
  _lineRatio = 0; // orientation/font metrics can change after Android WebView relayout
  const host = $('term');
  if (isTextMode()) {
    initReader();
    if (selected) {
      send({ t: 'select', sid: selected, snapshot: false });
      requestReaderHistory();
    }
    return;
  }
  if (term) { try { term.dispose(); } catch (_) {} }
  term = null; fit = null; termOk = false;
  if (host) host.innerHTML = '';
  initTerm();              // создаёт свежий xterm в #term
  scheduleTermRelayout(reason || 'refresh', 80);         // подгоняем сетку/шрифт под текущую ширину
  if (selected) setTimeout(() => { clearOut(); send({ t: 'select', sid: selected }); }, 240);  // после resize ПК перешлёт snapshot → перерисовка
  // НЕ фокусируем — ввод идёт со своей клавиатуры, системную не поднимаем.
}

// Скрол истории терминала жестом. В обычном буфере листаем локальный scrollback xterm.
// В alternate-buffer/TUI локального scrollback нет — шлём «колесо» в PTY, чтобы листался
// сам агент/less/vim/Claude Code. Это ключевое отличие от desktop-мыши на планшете.
function attachTouchScroll(host) {
  let ty = null;
  host.addEventListener('touchstart', (e) => { if (e.touches.length === 1) ty = e.touches[0].clientY; }, { passive: true });
  host.addEventListener('touchmove', (e) => {
    if (ty === null || e.touches.length !== 1 || !termOk) return;
    const y = e.touches[0].clientY;
    const lineH = Math.max(8, host.clientHeight / (term.rows || 24));
    const lines = Math.trunc((ty - y) / lineH);
    if (lines !== 0) {
      if (inAltBuffer()) wheelScroll(lines < 0, Math.min(8, Math.abs(lines)));
      else { try { term.scrollLines(lines); } catch (_) {} }
      ty = y;
      e.preventDefault();
    }
  }, { passive: false });
  host.addEventListener('touchend', () => { ty = null; }, { passive: true });
  host.addEventListener('touchcancel', () => { ty = null; }, { passive: true });
}

// Тонкий тулбар над терминалом (для стилуса): спецклавиши.
const TKEYS = { 'c-c': '\x03', 'esc': '\x1b', 'tab': '\t', 'up': '\x1b[A', 'down': '\x1b[B', 'enter': '\r', 'c-d': '\x04' };
// Терминал в alternate-буфере? (полноэкранный TUI — Claude/vim/less): у него НЕТ scrollback,
// локальный скрол истории не работает, прокручивать надо само приложение на ПК (колесом мыши).
function inAltBuffer() {
  try {
    if (!term || !term.buffer) return false;
    if (term.buffer.active && term.buffer.active.type) return term.buffer.active.type === 'alternate';
    return !!(term.buffer.alternate && term.buffer.active === term.buffer.alternate);
  }
  catch (_) { return false; }
}
// Послать на ПК-PTY N «щелчков» колеса (SGR-режим мыши 1006: 64 — вверх, 65 — вниз; в углу 1;1).
// Claude/vim/less/htop включают mouse-tracking → прокручивают свою область. Для обычного шелла
// (мышь не включена) кнопки идут другой веткой (локальный скрол истории), сюда не попадают.
function wheelScroll(up, notches) {
  const code = up ? 64 : 65;
  let s = '';
  for (let i = 0; i < notches; i++) s += '\x1b[<' + code + ';1;1M';
  sendInput(s);
}
// Прокрутка на страницу: в TUI — колесо на ПК, в обычном буфере — локальная история xterm.
function pageScroll(up) {
  if (isTextMode()) {
    if (readerPre) readerPre.scrollTop += (up ? -1 : 1) * Math.max(120, Math.floor(readerPre.clientHeight * 0.88));
    return;
  }
  if (inAltBuffer()) { wheelScroll(up, 3); return; }
  try { term.scrollPages(up ? -1 : 1); } catch (_) {}
}
// Свернуть/развернуть панель проектов: на телефоне даёт терминалу полную ширину
// (больше колонок). Состояние переживает перезапуск пульта.
function toggleSidebar(force) {
  const c = $('content'); if (!c) return;
  const collapsed = (force == null) ? c.classList.toggle('side-collapsed') : c.classList.toggle('side-collapsed', !!force);
  lsSet('side_collapsed', collapsed ? '1' : '');
  const tk = document.querySelector('.tk[data-key="side"]'); if (tk) tk.classList.toggle('on', collapsed);
  scheduleTermRelayout('sidebar-toggle', 60);   // ширина терминала изменилась → пере-фит сетки/PTY
}
function wireTermbar() {
  for (const b of document.querySelectorAll('.tk')) {
    b.onclick = (e) => {
      e.preventDefault();
      if (b.dataset.key === 'side') { toggleSidebar(); return; }
      if (b.dataset.key === 'refresh') { refreshTerm(); return; }
      if (b.dataset.key === 'mode') { toggleTermMode(); return; }
      if (b.dataset.key === 'kbd') { toggleKbd(); return; }
      if (b.dataset.key === 'hist') { showHistory(); return; }
      if (b.dataset.key === 'pgup') { pageScroll(true); return; }
      if (b.dataset.key === 'pgdn') { pageScroll(false); return; }
      const seq = TKEYS[b.dataset.key]; if (seq != null) sendInput(seq);
    };
  }
  if (lsGet('side_collapsed')) toggleSidebar(true);   // восстановить свёрнутое состояние
}

// ---------------------------------------------------- своя экранная клавиатура
// Системная клавиатура Android на старом WebView (Chrome 79) двигает весь UI и рвёт
// скрол терминала. Поэтому системную глушим (inputmode=none на textarea xterm), а ввод
// даём через СВОЮ панель снизу. Она — обычный flex-ребёнок #main под терминалом, поэтому
// НЕ панорамирует окно и не прячет промпт: терминал просто ужимается над клавиатурой.
let kbdShown = false;
let kbdShift = false;
let kbdLayer = 'abc';   // 'abc' | 'sym1' | 'sym2'
let kbdLang = 'ru';     // 'ru' | 'en' — русский по умолчанию
let kbdPlaced = false;  // выставлена ли стартовая позиция плавающего окна
let kbdScale = parseFloat(lsGet('kbd_scale')) || 1;   // масштаб кнопок: 1 / 1.2 / 1.4 / 2

// Масштаб клавиатуры: размеры клавиш через CSS-переменную --kbs, ширина окна растёт пропорционально.
function applyKbdScale() {
  const host = $('kbd'); if (!host) return;
  host.style.setProperty('--kbs', String(kbdScale));
  const w = Math.min(Math.round(320 * kbdScale), Math.round(window.innerWidth * 0.96));
  host.style.width = w + 'px';
  keepKbdInViewport();
  const wrap = $('kbd-scale');
  if (wrap) for (const b of wrap.querySelectorAll('button')) b.classList.toggle('on', parseFloat(b.dataset.s) === kbdScale);
}
function keepKbdInViewport() {
  const host = $('kbd'); if (!host || host.style.display === 'none') return;
  const ww = window.innerWidth || 320;
  const wh = window.innerHeight || 480;
  const w = host.offsetWidth || 320;
  const h = host.offsetHeight || 200;
  const curLeft = parseInt(host.style.left || '0', 10);
  const curTop = parseInt(host.style.top || '0', 10);
  const left = Math.max(0, Math.min(Number.isFinite(curLeft) ? curLeft : 0, Math.max(0, ww - w)));
  const top = Math.max(0, Math.min(Number.isFinite(curTop) ? curTop : 0, Math.max(0, wh - h)));
  host.style.left = left + 'px';
  host.style.top = top + 'px';
  host.style.right = 'auto';
  host.style.bottom = 'auto';
}
// Буквенный слой зависит от языка; слои символов общие.
const KBD_LETTERS = {
  ru: [
    ['й','ц','у','к','е','н','г','ш','щ','з','х'],
    ['ф','ы','в','а','п','р','о','л','д','ж','э'],
    ['shift','я','ч','с','м','и','т','ь','б','ю','bs'],
    ['sym1','lang',',','space','.','enter'],
  ],
  en: [
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['shift','z','x','c','v','b','n','m','bs'],
    ['sym1','lang',',','space','.','enter'],
  ],
};
const KBD_SYM = {
  sym1: [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['@','#','$','_','&','-','+','(',')','/'],
    ['sym2','*','"','\'',':',';','!','?','bs'],
    ['abc',',','space','.','enter'],
  ],
  sym2: [
    ['~','`','|','^','=','{','}','[',']','\\'],
    ['<','>','%','+','-','*','/','(',')','_'],
    ['sym1','@','#','$','&','!','?','bs'],
    ['abc',',','space','.','enter'],
  ],
};
function kbdRows() {
  return kbdLayer === 'abc' ? (KBD_LETTERS[kbdLang] || KBD_LETTERS.ru) : (KBD_SYM[kbdLayer] || KBD_SYM.sym1);
}
const KBD_WIDE = ['shift', 'bs', 'enter', 'sym1', 'sym2', 'abc', 'lang'];
function kbLabel(k) {
  if (k === 'shift') return kbdShift ? '⬆' : '⇧';
  if (k === 'bs') return '⌫';
  if (k === 'enter') return '⏎';
  if (k === 'space') return 'пробел';
  if (k === 'sym1') return '?123';
  if (k === 'sym2') return '=\\<';
  if (k === 'abc') return kbdLang === 'ru' ? 'абв' : 'abc';
  if (k === 'lang') return kbdLang === 'ru' ? '🌐РУ' : '🌐EN';
  return (kbdLayer === 'abc' && kbdShift && k.length === 1) ? k.toUpperCase() : k;
}
function kbHit(k) {
  if (k === 'shift') { kbdShift = !kbdShift; buildKbd(); return; }
  if (k === 'sym1') { kbdLayer = 'sym1'; buildKbd(); return; }
  if (k === 'sym2') { kbdLayer = 'sym2'; buildKbd(); return; }
  if (k === 'abc') { kbdLayer = 'abc'; buildKbd(); return; }
  if (k === 'lang') { kbdLang = kbdLang === 'ru' ? 'en' : 'ru'; kbdLayer = 'abc'; buildKbd(); return; }
  if (k === 'bs') { sendInput('\x7f'); return; }       // DEL (backspace в терминале)
  if (k === 'enter') { sendInput('\r'); return; }
  if (k === 'space') { sendInput(' '); return; }
  sendInput((kbdLayer === 'abc' && kbdShift && k.length === 1) ? k.toUpperCase() : k);
}
function buildKbd() {
  const host = $('kbd-keys'); if (!host) return;
  host.innerHTML = '';
  const rows = kbdRows();
  for (const row of rows) {
    const r = document.createElement('div'); r.className = 'kb-row';
    for (const k of row) {
      const b = document.createElement('button');
      b.className = 'kb-key' + (KBD_WIDE.indexOf(k) >= 0 ? ' kb-wide' : '') + (k === 'space' ? ' kb-space' : '');
      b.textContent = kbLabel(k);
      b.onclick = (e) => { e.preventDefault(); kbHit(k); };   // как в тулбаре — надёжно
      r.appendChild(b);
    }
    host.appendChild(r);
  }
}
function showKbd(on) {
  kbdShown = on;
  const host = $('kbd'); if (!host) return;
  if (on) {
    buildKbd();
    host.style.display = 'flex';
    applyKbdScale();
    if (!kbdPlaced) {   // первый показ — внизу по центру
      const w = host.offsetWidth || 320, h = host.offsetHeight || 200;
      host.style.left = Math.max(4, Math.round((window.innerWidth - w) / 2)) + 'px';
      host.style.top = Math.max(4, window.innerHeight - h - 12) + 'px';
      host.style.right = 'auto'; host.style.bottom = 'auto';
      kbdPlaced = true;
    }
    keepKbdInViewport();
  } else {
    host.style.display = 'none';
  }
  const tk = document.querySelector('.tk[data-key="kbd"]'); if (tk) tk.classList.toggle('on', on);
}
function toggleKbd() { showKbd(!kbdShown); }

// Перетаскивание плавающего окна клавиатуры за шапку + закрытие крестиком.
function wireKbd() {
  const host = $('kbd'); const head = $('kbd-head'); const x = $('kbd-x');
  if (x) x.onclick = () => showKbd(false);
  const sc = $('kbd-scale');
  if (sc) for (const b of sc.querySelectorAll('button')) {
    b.onclick = (e) => { e.stopPropagation(); kbdScale = parseFloat(b.dataset.s) || 1; lsSet('kbd_scale', String(kbdScale)); applyKbdScale(); };
  }
  if (!host || !head) return;
  let ox = 0, oy = 0, dragging = false;
  const begin = (px, py) => { const r = host.getBoundingClientRect(); ox = px - r.left; oy = py - r.top; dragging = true; };
  const move = (px, py) => {
    if (!dragging) return;
    const left = Math.max(0, Math.min(px - ox, window.innerWidth - host.offsetWidth));
    const top = Math.max(0, Math.min(py - oy, window.innerHeight - host.offsetHeight));
    host.style.left = left + 'px'; host.style.top = top + 'px';
    host.style.right = 'auto'; host.style.bottom = 'auto';
  };
  const end = () => { dragging = false; };
  head.addEventListener('touchstart', (e) => { const t = e.touches[0]; begin(t.clientX, t.clientY); }, { passive: true });
  head.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
  head.addEventListener('touchend', end, { passive: true });
  head.addEventListener('mousedown', (e) => { begin(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  window.addEventListener('mouseup', end);
}

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
// открытые терминалы. Категории сворачиваются (по дефолту открыто только «Избранное»),
// у каждой — свой цвет-градиент для быстрого различения глазами.
const FAV_NAME = '★ Избранное';
let catState = null;           // {имяКатегории: true=свёрнута}
function catMap() {
  if (catState) return catState;
  try { catState = JSON.parse(lsGet('cats_collapsed') || '{}'); } catch (_) { catState = {}; }
  if (!catState || typeof catState !== 'object') catState = {};
  return catState;
}
function isCatCollapsed(name) { const m = catMap(); return (name in m) ? !!m[name] : (name !== FAV_NAME); }
function toggleCat(name) { const m = catMap(); m[name] = !isCatCollapsed(name); lsSet('cats_collapsed', JSON.stringify(m)); renderTree(); }
function catHue(name) {
  if (name === FAV_NAME) return 45;     // золотой
  if (name === 'Все') return 205;       // нейтральный синий
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}
const ADD_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

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
  if (fav.length) groups.push([FAV_NAME, fav]);
  Object.keys(cats).sort((a, b) => (a === 'Все') - (b === 'Все') || a.localeCompare(b)).forEach((c) => groups.push([c, cats[c]]));

  // Заголовок категории: кликабельный, с шевроном и цветным градиентом. Возвращает collapsed.
  const addCat = (name) => {
    const collapsed = isCatCollapsed(name);
    const h = document.createElement('div');
    h.className = 'cat' + (collapsed ? ' collapsed' : '');
    const hue = catHue(name);
    h.style.borderLeftColor = 'hsl(' + hue + ',65%,62%)';
    h.style.background = 'linear-gradient(90deg, hsla(' + hue + ',65%,55%,.22), hsla(' + hue + ',65%,55%,.02))';
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▾';
    const lbl = document.createElement('span'); lbl.className = 'cat-lbl'; lbl.textContent = name;
    h.appendChild(chev); h.appendChild(lbl);
    h.onclick = () => toggleCat(name);
    box.appendChild(h);
    return collapsed;
  };
  const addSession = (s, canClose) => {
    const t = document.createElement('div');
    t.className = 'tab' + (s.sid === selected ? ' active' : '');
    const nm = document.createElement('span');
    nm.className = 'tab-name'; nm.textContent = s.tab || s.label || s.sid;
    nm.onclick = () => selectSession(s.sid);
    t.appendChild(nm);
    // Крестик — только если у проекта 2+ терминала (последний закрывать нельзя).
    if (canClose) {
      const x = document.createElement('button');
      x.className = 'tab-x'; x.textContent = '×';
      x.onclick = (e) => { e.stopPropagation(); send({ t: 'close', sid: s.sid }); };
      t.appendChild(x);
    }
    box.appendChild(t);
  };
  const addProj = (p) => {
    const pr = document.createElement('div');
    pr.className = 'proj';
    const nm = document.createElement('span'); nm.className = 'proj-name'; nm.textContent = p.name;
    const plus = document.createElement('button'); plus.className = 'add-term'; plus.title = 'Открыть терминал';
    plus.innerHTML = ADD_SVG;   // статичная SVG-иконка (без пользовательских данных)
    plus.onclick = (e) => { e.stopPropagation(); send({ t: 'open', projId: p.id }); };
    pr.appendChild(nm); pr.appendChild(plus);
    box.appendChild(pr);
    const list = byProj[p.id] || [];
    for (const s of list) addSession(s, list.length > 1);
  };

  for (const g of groups) {
    const collapsed = addCat(g[0]);
    // Свёрнуто — прячем ВСЕ плашки категории (включая проекты с открытым терминалом).
    // Доступ к запущенной вкладке не теряется: её вывод виден в терминале, для смены — развернуть.
    if (!collapsed) for (const p of g[1]) addProj(p);
  }
  const known = {}; projects.forEach((p) => { known[p.id] = 1; });
  const orphans = sessions.filter((s) => !s.projId || !known[s.projId]);
  if (orphans.length) { addCat('Прочее'); orphans.forEach((s) => addSession(s, orphans.length > 1)); }  // сессии всегда видны
}
function selectSession(sid) {
  selected = sid;
  clearOut();
  if (isTextMode()) {
    send({ t: 'select', sid, snapshot: false });
    requestReaderHistory();
    renderTree();
    return;
  }
  applyTermSize();     // выбрать читаемый grid планшета и ресайзить под него PTY на ПК
  setTimeout(() => send({ t: 'select', sid }), 180); // сначала resize PTY, потом snapshot под новый grid
  renderTree();
  focusOut();
}
function sendInput(data) { if (selected) send({ t: 'input', sid: selected, data }); }
function send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} } }

// После перезапуска/возврата ПК sessionId может совпасть со старым (он детерминирован),
// поэтому обычная проверка «сессия существует» не перезапрашивает буфер нового PTY.
// Здесь принудительно пересобираем терминал и тянем буфер заново (как кнопка ⟳).
function resyncTerminal() {
  const sid = (selected && lastSessions.some((s) => s.sid === selected)) ? selected
            : (lastSessions[0] && lastSessions[0].sid);
  if (!sid) return false;       // вкладок ещё нет (ПК не успел поднять) — попробуем на следующем state
  selected = sid; renderTree(); refreshTerm();
  if (isTextMode()) requestReaderHistory();
  return true;
}

// ----------------------------------------------------------------- соединение
function connect() {
  const url = `${relayUrl}?token=${encodeURIComponent(token)}&role=app&device=${encodeURIComponent(deviceId())}`;
  if (token) setStatus('Подключение…', 'wait');
  try { ws = new WebSocket(url); } catch (e) { sendReport('ws-fail', String(e), url); scheduleReconnect(); return; }

  ws.onopen = () => {
    pairingShown = false;   // новое соединение → разрешаем заново показать пайринг при need_pairing
    if (token) { setStatus('● На связи', 'ok'); resyncTerm = true; send({ t: 'hello' }); }   // (пере)подключились → перезапросить терминал
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
      const exists = selected && lastSessions.some((s) => s.sid === selected);
      const target = m.active || (lastSessions[0] && lastSessions[0].sid);
      if (resyncTerm) {                       // после рестарта/возврата ПК — пересобрать и перезапросить буфер
        if (resyncTerminal()) resyncTerm = false;   // удалось — сброс; нет вкладок — ждём следующий state
      } else if (!exists) { selected = null; if (target) selectSession(target); }   // сессия исчезла/первый вход — выбрать валидную
      else applyTermSize();   // НЕ следуем за активной ПК: вкладку на пульте выбирает пользователь, PC-active игнорируем
                              // (размер сессии на ПК мог измениться — перемасштабировать шрифт)
    }
    else if (m.t === 'data') { if (m.sid === selected) writeOut(m.data || ''); }
    else if (m.t === 'exit') { if (m.sid === selected) writeOut('\r\n[сессия завершена]\r\n'); }
    else if (m.t === 'history:begin') {
      const h = historyPending[m.reqId]; if (!h) return;
      clearTimeout(h.timer);
      h.parts = []; h.size = m.size || 0; h.got = 0;
      if (h.onBegin) h.onBegin(h, m);
      else if (h.pre) h.pre.textContent = 'Загрузка истории 0%';
    }
    else if (m.t === 'history:chunk') {
      const h = historyPending[m.reqId]; if (!h) return;
      const data = m.data || '';
      h.parts.push(data);
      h.got += data.length;
      if (h.onProgress) h.onProgress(h, m);
      else if (h.pre && h.size) h.pre.textContent = 'Загрузка истории ' + Math.min(100, Math.floor(h.got * 100 / h.size)) + '%';
    }
    else if (m.t === 'history:end') {
      const h = historyPending[m.reqId]; if (!h) return;
      clearTimeout(h.timer);
      const text = h.parts.join('');
      if (h.onEnd) h.onEnd(text, h, m);
      else if (h.pre) {
        h.pre.textContent = text || 'История пока пустая.';
        h.pre.scrollTop = h.pre.scrollHeight;
      }
      delete historyPending[m.reqId];
    }
    else if (m.t === 'history:err') {
      const h = historyPending[m.reqId];
      if (h) clearTimeout(h.timer);
      if (h && h.onError) h.onError(m.error || '', h, m);
      else if (h && h.pre) h.pre.textContent = 'Ошибка истории: ' + (m.error || '');
      if (h) delete historyPending[m.reqId];
    }
    else if (m.t === 'store:tree') { renderStore(m.path || '', m.entries || []); setStoreStatus(''); }
    else if (m.t === 'store:begin') {
      const d = storePending[m.reqId]; if (!d) return;
      d.name = m.name || d.name; d.size = m.size || 0; d.recv = 0;
      if (window.LiteNative && window.LiteNative.start) {
        try { d.token = window.LiteNative.start(d.name, m.mime || ''); } catch (_) { d.token = ''; }
        if (!d.token) { setStoreStatus('Не удалось сохранить на устройстве'); delete storePending[m.reqId]; return; }
      } else { d.parts = []; }   // браузер: копим части
      setStoreStatus('Скачивание ' + d.name + ' 0%');
    }
    else if (m.t === 'store:chunk') {
      const d = storePending[m.reqId]; if (!d) return;
      const b64 = m.data || '';
      if (d.token) { try { window.LiteNative.chunk(d.token, b64); } catch (_) {} }
      else if (d.parts) d.parts.push(b64);
      d.recv += Math.floor(b64.length * 3 / 4);
      const pct = d.size ? Math.min(100, Math.floor(d.recv * 100 / d.size)) : 0;
      setStoreStatus('Скачивание ' + d.name + ' ' + pct + '%');
    }
    else if (m.t === 'store:end') {
      const d = storePending[m.reqId]; if (!d) return;
      if (d.token) { try { window.LiteNative.finish(d.token); } catch (_) {} }
      else if (d.parts) browserSave(d.name, d.parts);
      setStoreStatus('✓ Скачано: ' + d.name);
      delete storePending[m.reqId];
    }
    else if (m.t === 'store:err') {
      const d = storePending[m.reqId];
      if (d && d.token) { try { window.LiteNative.abort(d.token); } catch (_) {} }
      if (d) delete storePending[m.reqId];
      setStoreStatus('Ошибка: ' + (m.error || ''));
    }
    else if (m.t === 'pair:approved') {
      pairingShown = false;
      const ov = $('overlay'); if (ov) ov.style.display = 'none';
      setStatus('Устройство одобрено ✓', 'ok');
      resyncTerm = true; send({ t: 'hello' });   // одобрено → перезапросить терминал
    }
    else if (m.t === 'pair:denied') {
      pairingShown = false;
      const ov = $('overlay'); if (ov) ov.style.display = 'none';
      setStatus('ПК отклонил устройство', 'wait');
      showFatal('Устройство отклонено на ПК. Меню → «Подключить это устройство», чтобы повторить.');
    }
    else if (m.t === 'need_pairing') {
      // Релей требует одобрения этого устройства → показать экран пайринга и отправить заявку.
      if (!pairingShown) { pairingShown = true; startPairing(); }
    }
    else if (m.t === 'restarted') {
      awaitingRestart = false; restartGraceUntil = Date.now() + 8000; resyncTerm = true;
      setStatus('Редактор перезапущен ✓', 'ok'); send({ t: 'hello' });
    }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'leave') {
      // во время/сразу после перезапуска уход старой копии — ожидаемый шум: статус НЕ трогаем
      if (!(awaitingRestart || Date.now() < restartGraceUntil)) setStatus('ПК отключился', 'wait');
    }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'join') {
      awaitingRestart = false; restartGraceUntil = 0; resyncTerm = true;
      setStatus('● На связи', 'ok'); send({ t: 'hello' });
    }
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!ws) connect(); }, 3000);
}


function enterApp() {
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
  if (!termInited) { termInited = true; initOutputSurface(); wireTermbar(); }
  const w = $('whoami'); if (w) w.textContent = lsGet('lite_login') || '';
}

// --------------------------------------------------- клавиатура / вьюпорт
// Старые Android-WebView (Chrome 79) при открытии экранной клавиатуры панорамируют
// окно ИЛИ прокручивают документ к полю фокуса (скрытая textarea xterm внизу) — UI
// «уезжает» вверх, пропадают шапка и тулбар. windowSoftInputMode=adjustResize это не
// лечит на старых движках. Жёстко прибиваем <body> к ВИДИМОЙ области через visualViewport:
//   • высота body = vv.height (видимая часть без клавиатуры) → ужимается только терминал;
//   • любой сдвиг окна (pan) гасим обратным translateY(vv.offsetTop);
//   • любую прокрутку документа сбрасываем в 0.
// visualViewport поддержан с Chrome 61, так что работает и на целевом старом WebView.
let vpApply = null;   // ссылка на выравнивание — дёргается из window.__kbChanged
function lockViewport() {
  const vv = window.visualViewport;
  const b = document.body;
  let raf = 0;
  function apply() {
    raf = 0;
    if (vv) {
      b.style.height = Math.round(vv.height) + 'px';
      const off = Math.round(vv.offsetTop || 0);
      b.style.transform = off ? 'translateY(' + off + 'px)' : '';
    }
    if (window.pageYOffset || (document.documentElement && document.documentElement.scrollTop)) {
      try { window.scrollTo(0, 0); } catch (_) {}
    }
    scheduleTermRelayout('viewport-apply', 70);
  }
  vpApply = apply;
  function schedule() { if (!raf) raf = requestAnimationFrame ? requestAnimationFrame(apply) : (apply(), 0); }
  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
  window.addEventListener('resize', schedule);
  // Документ не должен скроллиться сам — сразу возвращаем наверх.
  window.addEventListener('scroll', () => { if (window.pageYOffset) { try { window.scrollTo(0, 0); } catch (_) {} } }, { passive: true });
  apply();
}

// Зовётся из нативного кода (MainActivity) на показ/скрытие клавиатуры. Жёстко
// обнуляет любую остаточную прокрутку/сдвиг — UI возвращается на место. Клавиатура
// закрывается с анимацией, поэтому добиваем выравнивание ещё несколько раз.
function hardResetScroll() {
  try { window.scrollTo(0, 0); } catch (_) {}
  try { if (document.documentElement) document.documentElement.scrollTop = 0; } catch (_) {}
  try { if (document.body) document.body.scrollTop = 0; } catch (_) {}
  if (vpApply) vpApply();
  keepKbdInViewport();
}
window.__kbChanged = function () {
  hardResetScroll();
  scheduleTermRelayout('keyboard-change', 80);
  setTimeout(hardResetScroll, 60);
  setTimeout(hardResetScroll, 180);
  setTimeout(hardResetScroll, 360);
};

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
    const lver = $('login-ver'); if (lver && window.PULT_VER) lver.textContent = 'пульт v' + window.PULT_VER;   // версия на экране входа из единого источника
    const mb = $('menu-btn'); if (mb) mb.onclick = openMenu;
    wireViewportEvents(); // единая точка resize/orientation для xterm и плавающей клавиатуры
    lockViewport();      // клавиатура не должна двигать UI (старые WebView)
    wireKbd();           // плавающая своя клавиатура (перетаскивание + крестик)
    token = lsGet('lite_token') || '';
    if (token) enterApp(); else showLogin('');
    connect();           // с токеном → авторизуемся; без → пред-авторизованный сокет для входа
    sendReport('boot', 'app started v' + (window.PULT_VER || ''), diagnosticsText());
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
