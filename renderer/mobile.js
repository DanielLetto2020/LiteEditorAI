// mobile.js — UI удалённого пульта LiteEditor (Android-WebView / браузер).
//
// ВЕСЬ обмен идёт по WebSocket (включая вход): fetch из file://-WebView виснет на
// CORS-preflight, а WS работает без CORS. Поток:
//   • есть сохранённый токен → connect(token) → сразу авторизованы (role=app).
//   • нет токена → connect('') (пред-авторизация) → отправляем {t:"login",...} →
//     ждём {t:"auth_ok",token} | {t:"auth_err",error}.
// Любая JS-ошибка шлётся на сервер ({t:"report"}) и показывается баннером — чтобы
// «чёрный экран»/«тишину» можно было диагностировать удалённо (таблица reports).
// Терминала-эмулятора на пульте НЕТ: ПК шлёт «проекцию экрана» (текстовые кадры
// с теневого headless-xterm, см. remote.js на ПК), пульт лишь рисует их в <pre>.

// Кодек стилизованных строк кадра (ОБЩИЙ с ПК, см. lib/sgrline.js): ПК шлёт цвета
// как мини-SGR внутри строк, тут parseLine разбирает их в спаны. esbuild бандлит CJS.
const sgrline = require('../lib/sgrline.js');

let ws = null;
let relayUrl = '';   // адрес релея задаётся пользователем на экране входа (self-hosting), хранится в lite_relay
let token = '';
let selected = null;
let activeProj = null;   // активный проект на пульте: меню «Проекты» выбирает его, селектор над терминалом листает его вкладки
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

// Хост релея ↔ WS-URL. Пользователь вводит голый host[:port], строим wss://host/ws.
function relayUrlFromHost(h) {
  h = String(h || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  return h ? ('wss://' + h + '/ws') : '';
}
function relayHostFromUrl(u) {
  return String(u || '').replace(/^wss?:\/\//i, '').replace(/\/ws$/i, '').replace(/\/.*$/, '');
}

// ----------------------------------------------- идентичность устройства (pairing)
// Стабильный per-устройство id (одобряется на ПК один раз). Имя — модель из UA для
// наглядности в модалке одобрения на ПК.
function deviceId() {
  let id = lsGet('lite_device_id');
  if (id) return id;
  // Предпочитаем НАТИВНЫЙ стабильный id (ANDROID_ID) — он переживает переустановку APK,
  // поэтому после обновления пульта повторный пайринг по коду не нужен. localStorage
  // стирается при удалении приложения, а нативный id — нет. В браузере (нет моста) —
  // CSPRNG-фолбэк (предсказуемый id дал бы перебор чужого одобренного устройства).
  try {
    if (window.LiteDevice && typeof window.LiteDevice.deviceId === 'function') {
      const nid = window.LiteDevice.deviceId();
      if (nid) id = nid;
    }
  } catch (_) {}
  if (!id) id = 'd' + randHex(16);   // 128 бит, неугадываемо
  lsSet('lite_device_id', id);
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
      selected,
      frame: frame ? {
        seq: frame.seq, lines: frame.lines.length, cols: frame.cols, rows: frame.rows, alt: frame.alt,
      } : null,
      hostWidth: host && host.clientWidth,
      hostHeight: host && host.clientHeight,
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
// --- Верхние панели: шторка-фон, проекты (top sheet) и бургер-дропдаун ---------
// Шторка общая: тап мимо панели закрывает её. Сами экраны (стор/аккаунт/логи)
// остаются оверлеями showOverlay — выпадающим сделано только само меню.
function setShade(on) { const sh = $('shade'); if (sh) sh.style.display = on ? 'block' : 'none'; }
function closeTopPanels() {
  const pm = $('projmodal'); if (pm) pm.style.display = 'none';
  const dm = $('dropmenu'); if (dm) dm.style.display = 'none';
  const td = $('termdrop'); if (td) td.style.display = 'none';
  setShade(false);
}
function wireTopPanels() {
  const sh = $('shade'); if (sh) sh.onclick = closeTopPanels;
  const x = $('pm-x'); if (x) x.onclick = closeTopPanels;
}
function showProjects() {
  const pm = $('projmodal'); if (!pm) return;
  const dm = $('dropmenu'); if (dm) dm.style.display = 'none';
  renderTree();
  setShade(true);
  pm.style.display = 'flex';
}
// ☰ → выпадающий вниз список под шапкой (те же пункты, что были в модалке).
function openMenu() {
  const dm = $('dropmenu'); if (!dm) return;
  if (dm.style.display === 'block') { closeTopPanels(); return; }   // повторный тап — закрыть
  const pm = $('projmodal'); if (pm) pm.style.display = 'none';
  dm.innerHTML = '';
  const sect = (title) => { const s = document.createElement('div'); s.className = 'dm-sect'; s.textContent = title; dm.appendChild(s); };
  const mk = (label, fn) => {
    const x = document.createElement('button');
    x.textContent = label;
    x.onclick = () => { closeTopPanels(); fn(); };
    dm.appendChild(x);
  };
  sect('Аккаунт'); mk('Информация', showAccount);
  sect('Устройство'); mk('🔗 Подключить это устройство', startPairing);
  sect('Файл'); mk('📁 Стор — файлы с ПК', showStore); mk('Создать папку', showNewFolder);
  sect('Редактор (ПК)'); mk('⟲ Перезапустить редактор', showRestartPC);
  sect('Диагностика'); mk('Система', showSystemInfo); mk('Логи', showLogs);
  // Прижать к низу шапки (высота шапки зависит от устройства/масштаба).
  const tb = $('topbar');
  if (tb) dm.style.top = Math.round(tb.getBoundingClientRect().bottom + 4) + 'px';
  setShade(true);
  dm.style.display = 'block';
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
  const msg = { t: 'history:get', reqId, sid };
  if (typeof opts.before === 'number') msg.before = opts.before;   // окно: кусок ДО смещения
  if (typeof opts.size === 'number') msg.size = opts.size;         // размер куска
  send(msg);
  return reqId;
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

// ----------------------------------------------------------------- задачи (модалка)
// Зеркало панели «Задачи» редактора: те же файлы notes/<id>.json на ПК (проектные —
// по id проекта, общие — __global__). ПК отдаёт список по {t:'tasks:get}, принимает
// сохранение {t:'tasks:set}, и {t:'tasks:toTerminal} вставляет текст в терминал проекта.
// Модель задачи идентична редактору: { id, text, status:'todo'|'doing'|'done', prio:0|1|2 }.
const TASK_GLOBAL_ID = '__global__';
const TASK_STATUS = ['todo', 'doing', 'done'];
const TASK_STATUS_LABEL = { todo: 'К выполнению', doing: 'В работе', done: 'Выполнено' };
const TASK_PRIO_LABEL = ['Обычная', 'Важная', 'Срочная'];
let tasksTab = (lsGet('tasks_tab') === 'global') ? 'global' : 'project';
let tasksFilter = 'active';      // 'active' | 'all' | 'done'
let tasksList = [];              // загруженный список текущей вкладки
let tasksLoadedId = null;        // id списка, лежащего в tasksList
let tasksLoading = false;
let tasksError = '';
let tasksBox = null;             // тело модалки (живёт, пока открыт оверлей)
let tasksReqSeq = 0;
const tasksPending = {};         // reqId → cb(notes, id, timedOut)

// Какой список показывает активная вкладка: общий — всегда; проектный — активный проект (если валиден).
function tasksTargetId() {
  if (tasksTab === 'global') return TASK_GLOBAL_ID;
  if (activeProj && activeProj !== ORPHAN && knownProjIds()[activeProj]) return activeProj;
  return null;
}
// Низкоуровневый запрос списка с ПК (с таймаутом, чтобы спиннер не висел при офлайне).
function tasksGet(id, cb) {
  const reqId = 'k' + (tasksReqSeq++);
  const timer = setTimeout(() => { if (tasksPending[reqId]) { delete tasksPending[reqId]; cb(null, id, true); } }, 10000);
  tasksPending[reqId] = (notes, rid) => { clearTimeout(timer); cb(notes, rid, false); };
  send({ t: 'tasks:get', reqId, id });
}
function tasksSave() { if (tasksLoadedId) send({ t: 'tasks:set', id: tasksLoadedId, notes: tasksList }); }

// Загрузка списка под текущую вкладку (всегда свежая, если id сменился/сброшен).
function tasksLoad() {
  const id = tasksTargetId();
  tasksError = '';
  if (!id) { tasksLoadedId = null; tasksList = []; tasksLoading = false; renderTasks(); return; }
  if (id === tasksLoadedId) { renderTasks(); return; }
  tasksLoading = true; renderTasks();
  tasksGet(id, (notes, rid, timedOut) => {
    if (tasksTargetId() !== id) return;   // вкладку переключили, пока грузили
    tasksLoading = false;
    if (timedOut || !notes) { tasksList = []; tasksLoadedId = null; tasksError = 'Нет ответа от ПК (редактор запущен и на связи?)'; renderTasks(); return; }
    notes.forEach((n) => { if (TASK_STATUS.indexOf(n.status) < 0) n.status = 'todo'; if (typeof n.prio !== 'number') n.prio = 0; });
    tasksList = notes; tasksLoadedId = id; renderTasks();
  });
}
function tasksCounts() { const done = tasksList.filter((n) => n.status === 'done').length; return { all: tasksList.length, done, active: tasksList.length - done }; }
function tasksVisible() {
  if (tasksFilter === 'active') return tasksList.filter((n) => n.status !== 'done');
  if (tasksFilter === 'done') return tasksList.filter((n) => n.status === 'done');
  return tasksList.slice();
}
function tasksSwitchTab(name) {
  if (name === tasksTab) return;
  tasksTab = name; lsSet('tasks_tab', name);
  tasksLoadedId = null; tasksError = '';
  tasksLoad();
}
// Переставить задачу относительно соседа в ВИДИМОМ порядке (свап в массиве).
function tasksMove(note, dir) {
  const vis = tasksVisible();
  const sib = vis[vis.indexOf(note) + dir];
  if (!sib) return;
  const a = tasksList.indexOf(note), b = tasksList.indexOf(sib);
  if (a < 0 || b < 0) return;
  const t = tasksList[a]; tasksList[a] = tasksList[b]; tasksList[b] = t;
  tasksSave(); renderTasks();
}
// Перенос задачи между списками (проект↔общие): дочитываем целевой, дописываем, убираем из текущего.
function tasksMoveOther(note) {
  const fromProject = tasksLoadedId !== TASK_GLOBAL_ID;
  let destId, destName;
  if (fromProject) { destId = TASK_GLOBAL_ID; destName = 'Общие'; }
  else {
    const pid = (activeProj && activeProj !== ORPHAN && knownProjIds()[activeProj]) ? activeProj : null;
    if (!pid) { setStatus('Нет активного проекта — некуда перенести', 'wait'); return; }
    destId = pid; destName = projName(pid);
  }
  tasksGet(destId, (dest, rid, timedOut) => {
    if (timedOut) { setStatus('Перенос не удался: нет ответа ПК', 'wait'); return; }
    dest = Array.isArray(dest) ? dest : [];
    dest.unshift({ id: note.id, text: note.text, status: note.status, prio: note.prio });
    send({ t: 'tasks:set', id: destId, notes: dest });
    const ix = tasksList.indexOf(note); if (ix >= 0) tasksList.splice(ix, 1);
    tasksSave(); renderTasks();
    setStatus('Перенесено в «' + destName + '»', 'ok');
  });
}
// «В терминал»: для общих задач целевой проект — активный (как в редакторе).
function tasksSendToTerminal(note, alsoDelete) {
  const projId = (tasksLoadedId === TASK_GLOBAL_ID)
    ? ((activeProj && activeProj !== ORPHAN && knownProjIds()[activeProj]) ? activeProj : '')
    : tasksLoadedId;
  if (!projId) { setStatus('Нет активного проекта — некуда отправить', 'wait'); return; }
  if (!note.text) { setStatus('Задача пустая', 'wait'); return; }
  send({ t: 'tasks:toTerminal', projId, text: note.text });
  setStatus('Отправлено в терминал', 'ok');
  if (alsoDelete) { const ix = tasksList.indexOf(note); if (ix >= 0) tasksList.splice(ix, 1); tasksSave(); renderTasks(); }
}

// --- сборка UI модалки ---
function tasksMsg(t) { const d = document.createElement('div'); d.style.cssText = 'color:#5a6675;font-size:13px;line-height:1.5;padding:14px 4px'; d.textContent = t; return d; }
function tasksSubtitle(t) { const d = document.createElement('div'); d.style.cssText = 'color:#7fdbca;font-size:11px;margin:-4px 0 10px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; d.textContent = t; return d; }
function tasksMiniBtn(label) { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'flex:0 0 auto;width:32px;height:30px;border-radius:6px;border:1px solid #2a323d;background:#1c2530;color:#cfe3ee;font-size:14px'; return b; }
function tasksActBtn(label) { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'flex:1 1 auto;min-height:34px;border-radius:6px;border:1px solid #2a323d;background:#16202b;color:#9fd0c8;font-size:12px;padding:5px 8px'; return b; }
function tasksStatusCss(s) { return s === 'done' ? 'background:#16321f;color:#7fdbca' : (s === 'doing' ? 'background:#2a2412;color:#e0af68' : 'background:#1c2530;color:#9fb0c0'); }
function tasksPrioCss(p) { return p === 2 ? 'color:#f7768e;border-color:#5a2730' : (p === 1 ? 'color:#e0af68' : 'color:#9fb0c0'); }

function tasksTabsRow() {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:6px;margin-bottom:10px';
  const mk = (name, label) => {
    const on = tasksTab === name;
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'flex:1;padding:9px;border-radius:7px;font-size:13px;border:1px solid ' + (on ? '#1f6feb' : '#2a323d') + ';background:' + (on ? '#1f6feb' : '#11161d') + ';color:' + (on ? '#fff' : '#9fb0c0');
    b.onclick = () => tasksSwitchTab(name);
    return b;
  };
  wrap.appendChild(mk('project', '📁 Проект'));
  wrap.appendChild(mk('global', '🌐 Общие'));
  return wrap;
}
function tasksAddBtn() {
  const b = document.createElement('button');
  b.textContent = '＋ Новая задача';
  b.style.cssText = 'width:100%;background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:11px;font-size:14px;margin-bottom:10px';
  b.onclick = () => showTaskEditor(null);
  return b;
}
function tasksChipsRow() {
  const c = tasksCounts();
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:6px;margin-bottom:10px';
  const mk = (f, label, n) => {
    const on = tasksFilter === f;
    const b = document.createElement('button');
    b.textContent = label + (n ? (' ' + n) : '');
    b.style.cssText = 'flex:1;padding:7px;border-radius:6px;font-size:12px;border:1px solid ' + (on ? '#1f6feb' : '#2a323d') + ';background:' + (on ? '#16243a' : '#11161d') + ';color:' + (on ? '#eaf2fb' : '#9fb0c0');
    b.onclick = () => { tasksFilter = f; renderTasks(); };
    return b;
  };
  wrap.appendChild(mk('active', 'Активные', c.active));
  wrap.appendChild(mk('all', 'Все', c.all));
  wrap.appendChild(mk('done', 'Готово', c.done));
  return wrap;
}
function tasksCard(note, vis) {
  const card = document.createElement('div');
  card.style.cssText = 'border:1px solid #1f2630;border-radius:8px;padding:8px;margin-bottom:8px;background:#0e141b' + (note.status === 'done' ? ';opacity:.6' : '');
  // строка 1: статус + текст
  const top = document.createElement('div'); top.style.cssText = 'display:flex;align-items:flex-start;gap:8px';
  const st = document.createElement('button');
  st.textContent = note.status === 'done' ? '✓' : (note.status === 'doing' ? '◐' : '○');
  st.title = TASK_STATUS_LABEL[note.status];
  st.style.cssText = 'flex:0 0 auto;width:32px;height:32px;border-radius:6px;border:1px solid #2a323d;font-size:15px;' + tasksStatusCss(note.status);
  st.onclick = () => { note.status = TASK_STATUS[(TASK_STATUS.indexOf(note.status) + 1) % 3]; tasksSave(); renderTasks(); };
  const txt = document.createElement('div');
  txt.textContent = note.text || '(пусто)';
  txt.style.cssText = 'flex:1;color:#d6deeb;font-size:14px;line-height:1.4;word-break:break-word;white-space:pre-wrap' + (note.status === 'done' ? ';text-decoration:line-through' : '');
  txt.onclick = () => showTaskEditor(note);
  top.appendChild(st); top.appendChild(txt);
  // строка 2: важность + ↑↓ + правка + удалить
  const meta = document.createElement('div'); meta.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px';
  const flag = document.createElement('button');
  flag.textContent = '⚑' + (note.prio > 0 ? (' ' + TASK_PRIO_LABEL[note.prio]) : '');
  flag.title = 'Важность: ' + TASK_PRIO_LABEL[note.prio];
  flag.style.cssText = 'flex:0 0 auto;height:30px;border-radius:6px;border:1px solid #2a323d;padding:0 8px;font-size:12px;background:#1c2530;' + tasksPrioCss(note.prio);
  flag.onclick = () => { note.prio = (note.prio + 1) % 3; tasksSave(); renderTasks(); };
  const spacer = document.createElement('div'); spacer.style.flex = '1';
  const vi = vis.indexOf(note);
  const up = tasksMiniBtn('↑'); up.disabled = vi <= 0; if (up.disabled) up.style.opacity = '.4'; up.onclick = () => tasksMove(note, -1);
  const down = tasksMiniBtn('↓'); down.disabled = vi >= vis.length - 1; if (down.disabled) down.style.opacity = '.4'; down.onclick = () => tasksMove(note, 1);
  const edit = tasksMiniBtn('✎'); edit.onclick = () => showTaskEditor(note);
  const del = tasksMiniBtn('🗑'); del.style.color = '#f7768e';
  del.onclick = () => showTaskConfirm('Удалить задачу совсем (а не пометить выполненной)?', () => { const ix = tasksList.indexOf(note); if (ix >= 0) tasksList.splice(ix, 1); tasksSave(); renderTasks(); });
  meta.appendChild(flag); meta.appendChild(spacer); meta.appendChild(up); meta.appendChild(down); meta.appendChild(edit); meta.appendChild(del);
  // строка 3: в терминал / в терминал и удалить / перенос
  const acts = document.createElement('div'); acts.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px';
  const send1 = tasksActBtn('⌨ В терминал'); send1.onclick = () => tasksSendToTerminal(note, false);
  const send2 = tasksActBtn('⌨ + удалить'); send2.onclick = () => tasksSendToTerminal(note, true);
  const toGlobal = tasksLoadedId !== TASK_GLOBAL_ID;
  const moveBtn = tasksActBtn(toGlobal ? '→ В общие' : '→ В проект'); moveBtn.onclick = () => tasksMoveOther(note);
  acts.appendChild(send1); acts.appendChild(send2); acts.appendChild(moveBtn);
  card.appendChild(top); card.appendChild(meta); card.appendChild(acts);
  return card;
}
// Главный рендер тела модалки (режим списка).
function renderTasks() {
  if (!tasksBox) return;
  tasksBox.innerHTML = '';
  tasksBox.appendChild(tasksTabsRow());
  if (tasksTab === 'project') { const id = tasksTargetId(); tasksBox.appendChild(tasksSubtitle(id ? ('Проект: ' + projName(id)) : 'Проект не выбран')); }
  if (tasksLoading) { tasksBox.appendChild(tasksMsg('Загрузка…')); return; }
  const id = tasksTargetId();
  if (!id) { tasksBox.appendChild(tasksMsg('Выберите проект в меню «📁 Проекты», чтобы вести его задачи, либо переключитесь на «🌐 Общие».')); return; }
  if (tasksError) tasksBox.appendChild(tasksMsg('⚠ ' + tasksError));
  tasksBox.appendChild(tasksAddBtn());
  tasksBox.appendChild(tasksChipsRow());
  const rows = tasksVisible();
  if (!rows.length) {
    tasksBox.appendChild(tasksMsg(tasksFilter === 'done' ? 'Выполненных задач пока нет.' : tasksFilter === 'active' ? 'Активных задач нет — добавьте новую кнопкой выше.' : 'Пусто — добавьте первую задачу.'));
    return;
  }
  rows.forEach((n) => tasksBox.appendChild(tasksCard(n, rows)));
}
// Редактор задачи (новая/правка) — отдельный экран внутри модалки. Системная клавиатура
// уместна (как на экранах входа/«Создать папку»): это обычная textarea, не xterm.
function showTaskEditor(note) {
  if (!tasksBox) return;
  tasksBox.innerHTML = '';
  const h = document.createElement('div'); h.style.cssText = 'color:#7fdbca;font-size:14px;margin-bottom:10px'; h.textContent = note ? 'Редактировать задачу' : 'Новая задача';
  const ta = document.createElement('textarea');
  ta.value = note ? (note.text || '') : '';
  ta.setAttribute('autocapitalize', 'sentences');
  ta.style.cssText = 'width:100%;min-height:120px;background:#11161d;color:#d6deeb;border:1px solid #2a323d;border-radius:8px;padding:12px;font-size:15px;resize:vertical';
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:12px';
  const cancel = document.createElement('button');
  cancel.textContent = 'Отмена';
  cancel.style.cssText = 'flex:1;background:#1c2530;color:#cfe3ee;border:1px solid #2a323d;border-radius:8px;padding:11px;font-size:14px';
  cancel.onclick = () => renderTasks();
  const ok = document.createElement('button');
  ok.textContent = note ? 'Сохранить' : 'Добавить';
  ok.style.cssText = 'flex:1;background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:11px;font-size:14px';
  ok.onclick = () => {
    const text = ta.value.trim();
    if (!text) { renderTasks(); return; }
    if (note) note.text = text;
    else { tasksList.unshift({ id: 'n' + Date.now().toString(36), text, status: 'todo', prio: 0 }); if (tasksFilter === 'done') tasksFilter = 'active'; }
    tasksSave(); renderTasks();
  };
  row.appendChild(cancel); row.appendChild(ok);
  tasksBox.appendChild(h); tasksBox.appendChild(ta); tasksBox.appendChild(row);
  setTimeout(() => { try { ta.focus(); } catch (_) {} }, 60);
}
// Подтверждение удаления — экран внутри модалки (без нативного confirm: он блокирует WebView).
function showTaskConfirm(text, onYes) {
  if (!tasksBox) return;
  tasksBox.innerHTML = '';
  const msg = document.createElement('div'); msg.style.cssText = 'color:#e0af68;font-size:14px;line-height:1.5;margin-bottom:14px'; msg.textContent = text;
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px';
  const no = document.createElement('button');
  no.textContent = 'Отмена';
  no.style.cssText = 'flex:1;background:#1c2530;color:#cfe3ee;border:1px solid #2a323d;border-radius:8px;padding:11px;font-size:14px';
  no.onclick = () => renderTasks();
  const yes = document.createElement('button');
  yes.textContent = 'Удалить';
  yes.style.cssText = 'flex:1;background:#5a1620;color:#fff;border:0;border-radius:8px;padding:11px;font-size:14px';
  yes.onclick = () => onYes();
  row.appendChild(no); row.appendChild(yes);
  tasksBox.appendChild(msg); tasksBox.appendChild(row);
}
// Кнопка «✓ Задачи» в тулбаре → открыть модалку (всегда свежая загрузка списка).
function showTasks() {
  const b = document.createElement('div');
  tasksBox = b;
  tasksLoadedId = null; tasksError = '';
  showOverlay('Задачи', b);
  tasksLoad();
}

// ----------------------------------------------------------------- вход
function showLogin(errText) {
  $('login').style.display = 'flex';
  $('app').style.display = 'none';
  const hostInp = $('lg-host');
  if (hostInp && !hostInp.value) hostInp.value = relayHostFromUrl(relayUrl);
  if (errText !== undefined) $('lg-err').textContent = errText || '';
}
function setAuthBusy(b) { const g = $('lg-go'); if (g) g.disabled = b; }
function authError(msg) { clearTimeout(authTimer); authTimer = null; authPending = null; setAuthBusy(false); $('lg-err').textContent = msg; }

function submitAuth() {
  const hostInp = $('lg-host');
  const host = hostInp ? hostInp.value.trim() : '';
  const login = $('lg-login').value.trim().toLowerCase();
  const pass = $('lg-pass').value;
  $('lg-err').textContent = '';
  if (!host) { $('lg-err').textContent = 'Укажите хост релея'; return; }
  if (login.length < 3 || pass.length < 4) { $('lg-err').textContent = 'Логин ≥3, пароль ≥4 символа'; return; }
  const url = relayUrlFromHost(host);
  if (!url) { $('lg-err').textContent = 'Некорректный хост релея'; return; }
  // Сменили хост — закрываем старый пред-авторизованный сокет, чтобы переоткрыть на новый релей.
  if (url !== relayUrl) { try { ws && ws.close(); } catch (_) {} ws = null; }
  relayUrl = url;
  lsSet('lite_relay', relayUrl);
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

// ------------------------------------------------ терминал: проекция экрана (mosh-принцип)
// На пульте НЕТ эмулятора терминала. ПК держит теневой headless-xterm каждой сессии и
// шлёт сюда ВИДИМЫЙ ЭКРАН простым текстом: полный кадр (~5КБ) на select/реконнект,
// дальше — line-диффы с debounce ~200мс. Сколько бы перерисовок ни делал TUI-агент,
// по сети идёт итоговое состояние, а не процесс рисования. Рендер — обычный <pre>;
// никакого фита сетки и ресайза PTY: PTY всегда живёт в родной сетке ПК, поэтому
// переключение пульт↔редактор мгновенно и ничего не ломает.
let screenEl = null;        // <pre class="screen"> — поверхность кадра
let frame = null;           // {sid, seq, lines[], cursor:[x,y], alt, cols, rows}
let termInited = false;
let termHostWired = false;
let viewportWired = false;
let renderQueued = false;
let fullReqAt = 0;
let screenFollow = true;    // прилипание к низу кадра (низ = поле ввода агента)
// Дефолтные цвета экрана (для inverse-спанов: свап с ними) — читаются из CSS в initScreen.
let screenFg = '#d6deeb', screenBg = '#0d1117';

// --- Ленивая история над кадром (как лента маркетплейса, только вверх) ---------
// Скролл подошёл к верху → подгружаем ещё кусок транскрипта с ПК и пришиваем СВЕРХУ
// (позиция глаз сохраняется через якорь по scrollHeight). Вернулись в самый низ →
// выгружаем всю подгруженную историю (память не копим; понадобится — подгрузим снова).
let histText = '';          // подгруженный кусок транскрипта (выше живого кадра)
let histStart = -1;         // смещение начала histText в транскрипте ПК; 0 = упёрлись в начало; -1 = не грузили
let histLoading = false;
let histAnchor = null;      // {top, height} — восстановить позицию после пришивания сверху
// renderScreen полностью пересобирает <pre> (textContent=''), из-за чего scrollTop
// схлопывается в 0 и браузер шлёт «фантомный» scroll-event. Без флага он трактуется
// как «пользователь долистал до верха» → ложная подгрузка истории при каждом кадре
// (в т.ч. на каждый символ при наборе). Подавляем scroll-обработчик на время пересборки.
let suppressScroll = false;
const HIST_CHUNK = 48 * 1024;
const HIST_SEP = '\n┄┄┄┄┄┄┄┄ выше — история ┄┄┄┄┄┄┄┄\n';

function resetHistory() { histText = ''; histStart = -1; histLoading = false; histAnchor = null; }
function maybeLoadHistory() {
  if (!selected || histLoading || histStart === 0) return;
  histLoading = true;
  const sid = selected;
  requestHistory(sid, {
    before: histStart >= 0 ? histStart : undefined,
    size: HIST_CHUNK,
    timeoutMs: 10000,
    onEnd: (text, h, m) => {
      histLoading = false;
      if (selected !== sid) return;
      histStart = (m && typeof m.start === 'number') ? m.start : 0;
      if (text) {
        if (screenEl) histAnchor = { top: screenEl.scrollTop, height: screenEl.scrollHeight };
        histText = text + histText;
        renderScreen();
      }
    },
    onError: () => { histLoading = false; },
    onTimeout: () => { histLoading = false; },
  });
}

// Широкая сетка ПК переносится pre-wrap'ом → кадр выше экрана планшета. Скролл
// локальный (нативный pan), но по умолчанию прилипаем к низу: там промпт агента.
// Пользователь свайпнул вверх читать — не дёргаем; вернулся к низу — липнем снова.
function screenAtBottom() {
  if (!screenEl) return true;
  return screenEl.scrollTop + screenEl.clientHeight >= screenEl.scrollHeight - 24;
}
function initScreen() {
  const host = $('term');
  if (!host) return;
  host.innerHTML = '';
  screenEl = document.createElement('pre');
  screenEl.className = 'screen';
  screenEl.textContent = 'Выбери терминал слева';
  screenEl.addEventListener('scroll', () => {
    if (suppressScroll) return;                            // программная пересборка кадра — не реагируем
    const atB = screenAtBottom();
    screenFollow = atB;
    if (atB) {
      if (histText) { resetHistory(); renderScreen(); }   // вернулись вниз → чистим историю из памяти
    } else if (screenEl.scrollTop < 200) {
      maybeLoadHistory();                                  // подошли к верху → ещё кусок истории
    }
  }, { passive: true });
  host.appendChild(screenEl);
  try {
    const cs = getComputedStyle(screenEl);
    if (cs.color) screenFg = cs.color;
    if (cs.backgroundColor) screenBg = cs.backgroundColor;
  } catch (_) {}
  wireTermHost(host);
}
// Строка кадра в работе — объект {text, spans, curIdx?}: плоский текст + спаны стилей
// (из parseLine; у плоского кадра spans пуст). Любая резка текста идёт через cutRange,
// который синхронно ремапит спаны и индекс курсора — геометрия не разъезжается.
function cutRange(row, start, len) {
  row.text = row.text.slice(0, start) + row.text.slice(start + len);
  if (row.curIdx !== undefined && row.curIdx > start) row.curIdx = Math.max(start, row.curIdx - len);
  if (row.spans.length) {
    const out = [];
    for (let i = 0; i < row.spans.length; i++) {
      const sp = row.spans[i];
      if (sp.s > start) sp.s = Math.max(start, sp.s - len);
      if (sp.e > start) sp.e = Math.max(start, sp.e - len);
      if (sp.e > sp.s) out.push(sp);
    }
    row.spans = out;
  }
}
// Косметика строк агентского TUI на узком экране: полноширинные линейки/рамки
// (130 символов «─») при pre-wrap превращаются в 3 строки каждая. Схлопываем
// ЛЮБОЙ длинный прогон одинакового «штриха» до 24 — где бы он ни стоял в строке.
// Правую границу рамки (хвост из пробелов и «│») срезаем. Строки НЕ удаляются.
function frameLineView(row) {
  const m = /\s{2,}[│|]\s*$/.exec(row.text);   // '│ > текст      │' → '│ > текст'
  if (m) cutRange(row, m.index, row.text.length - m.index);
  const re = /([─━═╌┄┅┈┉=_~‐‒–—-])\1{23,}/g;
  const cuts = [];
  let r;
  while ((r = re.exec(row.text))) cuts.push([r.index + 24, r[0].length - 24]);
  for (let i = cuts.length - 1; i >= 0; i--) cutRange(row, cuts[i][0], cuts[i][1]);   // с конца — индексы не плывут
}
// Курсор ▌ — подменой символа по индексу в ПЛОСКОМ тексте. В styled-кадре индекс
// прислал ПК (curIdx: там известны ширины ячеек — эмодзи/CJK левее не сдвигают
// курсор); в плоском — cursor[0] как раньше. Вставка ПОСЛЕ схлопывания рамок
// (cutRange уже отремапил curIdx) — символ курсора не разрезает прогон линейки.
function insertCursor(row) {
  const t = row.text;
  let i = row.curIdx;
  if (i === undefined || i < 0) i = t.length;
  if (i >= t.length) { row.text = t + ' '.repeat(i - t.length) + '▌'; return; }
  let len = 1;
  const code = t.charCodeAt(i);
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < t.length) len = 2;   // суррогатная пара (эмодзи)
  row.text = t.slice(0, i) + '▌' + t.slice(i + len);
  const d = 1 - len;
  if (d && row.spans.length) {
    for (let k = 0; k < row.spans.length; k++) {
      const sp = row.spans[k];
      if (sp.s > i) sp.s += d;
      if (sp.e > i) sp.e += d;
    }
  }
}
// Спан стиля → инлайн-стили DOM-спана. Цвета — палитра/RGB из colorHex; inverse —
// свап с дефолтными цветами экрана. Только textContent — XSS-поверхности нет.
function styleSpan(el, sp) {
  let fg = sgrline.colorHex(sp.fg), bg = sgrline.colorHex(sp.bg);
  if (sp.fl & 16) { const f = fg; fg = bg || screenBg; bg = f || screenFg; }
  if (fg) el.style.color = fg;
  if (bg) el.style.backgroundColor = bg;
  if (sp.fl & 1) el.style.fontWeight = 'bold';
  if (sp.fl & 2) el.style.opacity = '0.65';
  if (sp.fl & 4) el.style.fontStyle = 'italic';
  if (sp.fl & 8) el.style.textDecoration = 'underline';
}
// Строка кадра → DOM-узлы (текст + цветные спаны) внутрь parent.
function appendRow(parent, row) {
  const t = row.text, spans = row.spans;
  if (!spans.length) { if (t) parent.appendChild(document.createTextNode(t)); return; }
  let pos = 0;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (sp.s > pos) parent.appendChild(document.createTextNode(t.slice(pos, sp.s)));
    const el = document.createElement('span');
    styleSpan(el, sp);
    el.textContent = t.slice(sp.s, sp.e);
    parent.appendChild(el);
    pos = sp.e;
  }
  if (pos < t.length) parent.appendChild(document.createTextNode(t.slice(pos)));
}
function renderScreen() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!screenEl) return;
    if (!frame) { screenEl.textContent = selected ? 'Ожидание экрана…' : 'Выбери терминал слева'; return; }
    const stick = screenFollow || screenAtBottom();
    const styled = !!frame.styled;
    // 1) строки кадра → {text, spans} (styled-кадр разбираем из мини-SGR)
    let rows = [];
    for (let i = 0; i < frame.lines.length; i++) {
      rows.push(styled ? sgrline.parseLine(frame.lines[i] || '') : { text: frame.lines[i] || '', spans: [] });
    }
    const c = frame.cursor || [0, 0];
    const cy = c[1];
    // Пустой хвост кадра обрезаем (но строку с курсором сохраняем): у свежего шелла
    // промпт на 1-й строке, а 40+ пустых строк ниже прижимали его за верх экрана.
    let last = rows.length - 1;
    while (last > 0 && !(rows[last].text || '').trim()) last--;
    rows = rows.slice(0, Math.max(last, cy) + 1);
    // 2) индекс курсора в плоском тексте, потом схлопывание рамок, потом сам курсор
    const hasCur = cy >= 0 && cy < rows.length;
    if (hasCur) rows[cy].curIdx = (styled && typeof frame.curIdx === 'number' && frame.curIdx >= 0) ? frame.curIdx : c[0];
    for (let i = 0; i < rows.length; i++) frameLineView(rows[i]);
    if (hasCur) insertCursor(rows[cy]);
    // 3) сборка: [история] + кадр; подряд идущие НЕстилизованные строки батчим в один
    //    текстовый узел; строка с курсором — <span class=cur-line> (подсветка поля ввода).
    suppressScroll = true;                  // пересборка ниже схлопнет scrollTop → глушим фантомный scroll
    const prevTop = screenEl.scrollTop;     // позиция до пересборки (нужна, когда не липнем к низу)
    screenEl.textContent = '';
    if (histText) screenEl.appendChild(document.createTextNode(histText + HIST_SEP));
    let buf = '';
    const flushBuf = () => { if (buf) { screenEl.appendChild(document.createTextNode(buf)); buf = ''; } };
    for (let i = 0; i < rows.length; i++) {
      const nl = i < rows.length - 1 ? '\n' : '';
      if (hasCur && i === cy) {
        flushBuf();
        const cur = document.createElement('span');
        cur.className = 'cur-line';
        appendRow(cur, rows[i]);
        screenEl.appendChild(cur);
        buf = nl;
      } else if (rows[i].spans.length) {
        flushBuf();
        appendRow(screenEl, rows[i]);
        buf = nl;
      } else {
        buf += rows[i].text + nl;
      }
    }
    flushBuf();
    if (histAnchor) {   // пришили историю сверху → вернуть глаза на то же место
      screenEl.scrollTop = histAnchor.top + (screenEl.scrollHeight - histAnchor.height);
      histAnchor = null;
    } else if (stick) {
      screenEl.scrollTop = screenEl.scrollHeight;
    } else {
      screenEl.scrollTop = prevTop;   // не липнем — сохраняем позицию, НЕ прыгаем в верх (иначе ложная подгрузка)
    }
    // Снимаем подавление после того, как браузер отстрелит scroll-события пересборки.
    // Порядок в event loop: scroll-шаги идут ДО rAF-колбэков, поэтому к следующему rAF
    // фантомные события уже отработали и реальный пользовательский скролл снова в силе.
    requestAnimationFrame(() => { suppressScroll = false; });
  });
}
// Кадр с ПК: full — заменить экран целиком; diff — точечно изменившиеся строки.
// Дыра в seq (реконнект/потерянный кадр) → перезапросить полный кадр.
function applyScreenMsg(m) {
  if (!m || m.sid !== selected) return;
  if (m.full) {
    frame = {
      sid: m.sid, seq: m.seq || 0, lines: (m.lines || []).slice(),
      cursor: m.cursor || [0, 0], alt: !!m.alt, cols: m.cols || 0, rows: m.rows || 0,
      // st — кадр стилизованный (строки с мини-SGR); режим меняется ТОЛЬКО с full
      // (флип на ПК сбрасывает диффер), поэтому в диффах st не смотрим.
      styled: !!m.st, curIdx: (typeof m.curIdx === 'number') ? m.curIdx : -1,
    };
  } else {
    if (!frame || frame.sid !== m.sid || m.seq !== frame.seq + 1) { requestFullFrame(); return; }
    const diff = m.diff || [];
    for (let i = 0; i < diff.length; i++) {
      const d = diff[i];
      if (d && d.length === 2 && d[0] >= 0) frame.lines[d[0]] = d[1];
    }
    frame.seq = m.seq;
    if (m.cursor) frame.cursor = m.cursor;
    frame.curIdx = (typeof m.curIdx === 'number') ? m.curIdx : -1;
    frame.alt = !!m.alt;
  }
  renderScreen();
}
// Запрос полного кадра ({t:'select'} на ПК сбрасывает диффер). Троттлим: поток
// устаревших диффов после реконнекта не должен превращаться в шквал select'ов.
function requestFullFrame(force) {
  if (!selected) return;
  const now = Date.now();
  if (!force && now - fullReqAt < 1000) return;
  fullReqAt = now;
  send({ t: 'select', sid: selected, styled: 1 });   // styled — просим цветные кадры (старый ПК флаг игнорирует)
}
// Кнопка «⟳» в тулбаре: сброс кадра + свежий полный кадр с ПК.
function refreshScreen() {
  frame = null;
  screenFollow = true;
  resetHistory();
  renderScreen();
  requestFullFrame(true);
}
function wireTermHost(host) {
  if (!host || termHostWired) return;
  termHostWired = true;
  host.addEventListener('click', () => { if (!kbdShown) showKbd(true); });   // тап по терминалу → своя клавиатура
}
function wireViewportEvents() {
  if (viewportWired) return;
  viewportWired = true;
  // Текст в <pre> переуложится сам (pre-wrap); следим только за плавающей клавиатурой.
  window.addEventListener('resize', () => keepKbdInViewport());
  window.addEventListener('orientationchange', () => { hardResetScroll(); });
}
// Жест по кадру — НАТИВНЫЙ локальный скролл <pre> (кадр выше экрана из-за переносов):
// листает сам кадр, прилипание к низу — в renderScreen. Прокрутка СОДЕРЖИМОГО агента
// (транскрипт TUI на ПК) — кнопками PgUp/PgDn (шлют колесо в PTY). Кастомный
// touch-обработчик не нужен.

// Тонкий тулбар над терминалом (для стилуса): спецклавиши.
const TKEYS = { 'c-c': '\x03', 'esc': '\x1b', 'tab': '\t', 'up': '\x1b[A', 'down': '\x1b[B', 'enter': '\r' };
// Терминал в alternate-буфере? (полноэкранный TUI — Claude/vim/less). Флаг приходит
// с ПК в каждом кадре: прокручивать надо само приложение на ПК (колесом мыши).
function inAltBuffer() { return !!(frame && frame.alt); }
// Послать на ПК-PTY N «щелчков» колеса (SGR-режим мыши 1006: 64 — вверх, 65 — вниз; в углу 1;1).
// Claude/vim/less/htop включают mouse-tracking → прокручивают свою область. Для обычного шелла
// (мышь не включена) кнопки идут другой веткой (локальный скрол истории), сюда не попадают.
function wheelScroll(up, notches) {
  const code = up ? 64 : 65;
  let s = '';
  for (let i = 0; i < notches; i++) s += '\x1b[<' + code + ';1;1M';
  sendInput(s);
}
// Прокрутка на страницу: в TUI — колесо на ПК (листается транскрипт агента);
// в обычном буфере — локальный скролл кадра (прошлое за кадром — через «Историю»).
function pageScroll(up) {
  if (inAltBuffer()) { wheelScroll(up, 3); return; }
  if (screenEl) {
    screenEl.scrollTop += (up ? -1 : 1) * Math.max(120, Math.floor(screenEl.clientHeight * 0.85));
    screenFollow = screenAtBottom();
  }
}
function wireTermbar() {
  for (const b of document.querySelectorAll('.tk')) {
    b.onclick = (e) => {
      e.preventDefault();
      if (b.dataset.key === 'side') { showProjects(); return; }   // проекты — верхней шторкой
      if (b.dataset.key === 'tasks') { showTasks(); return; }     // задачи — модалкой
      if (b.dataset.key === 'refresh') { refreshScreen(); return; }
      if (b.dataset.key === 'kbd') { toggleKbd(); return; }
      if (b.dataset.key === 'pgup') { pageScroll(true); return; }
      if (b.dataset.key === 'pgdn') { pageScroll(false); return; }
      const seq = TKEYS[b.dataset.key]; if (seq != null) sendInput(seq);
    };
  }
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

// id сессий-сирот (проект удалён на ПК, а PTY жив) сводим к псевдо-проекту «Прочее»,
// чтобы доступ к таким терминалам не терялся ни в выборе проектов, ни в выпадашке.
const ORPHAN = '__orphan__';
function knownProjIds() { const k = {}; (lastProjects || []).forEach((p) => { k[p.id] = 1; }); return k; }
function projKeyOf(s) { const known = knownProjIds(); return (s.projId && known[s.projId]) ? s.projId : ORPHAN; }
function sessionsForProj(projId) { return (lastSessions || []).filter((s) => projKeyOf(s) === projId); }
function projName(projId) {
  if (projId === ORPHAN) return 'Прочее';
  const p = (lastProjects || []).find((x) => x.id === projId);
  return p ? p.name : '—';
}

// Меню «Проекты»: только категории → проекты (терминалы переехали в выпадашку над терминалом).
// Тап по проекту делает его активным; вкладки-терминалы листаются селектором над терминалом.
function renderTree() {
  const box = $('tabs');
  if (!box) return;
  box.innerHTML = '';
  const projects = lastProjects || [];

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
  // Плашка проекта: имя + бейдж с числом открытых терминалов (если есть). Тап — выбрать проект.
  const addProj = (id, name) => {
    const pr = document.createElement('div');
    pr.className = 'proj-pick' + (id === activeProj ? ' active' : '');
    const nm = document.createElement('span'); nm.className = 'pp-name'; nm.textContent = name;
    pr.appendChild(nm);
    const n = sessionsForProj(id).length;
    if (n) { const b = document.createElement('span'); b.className = 'pp-count'; b.textContent = n; pr.appendChild(b); }
    pr.onclick = () => selectProject(id);
    box.appendChild(pr);
  };

  for (const g of groups) {
    const collapsed = addCat(g[0]);
    if (!collapsed) for (const p of g[1]) addProj(p.id, p.name);
  }
  // Сироты-сессии — отдельным псевдо-проектом «Прочее» (доступ к их терминалам не теряется).
  if (sessionsForProj(ORPHAN).length) { addCat('Прочее'); addProj(ORPHAN, 'Прочее'); }
}

// Выбор проекта из меню «Проекты»: делаем активным и переходим в один из его терминалов
// (текущий, если он этого проекта; иначе первый; если ни одного открытого — открываем новый).
function selectProject(projId) {
  activeProj = projId;
  closeTopPanels();
  const list = sessionsForProj(projId);
  if (list.length) {
    const cur = list.find((s) => s.sid === selected) || list[0];
    selectSession(cur.sid);
  } else if (projId !== ORPHAN) {
    openProjTerminal(projId);   // PTY ещё нет — поднять на ПК (state выберет новую сессию)
    updateTermSel();
    renderTree();
  }
}

// Выпадашка над терминалом: все терминалы активного проекта + «новый терминал».
function renderTermDropdown() {
  const td = $('termdrop');
  if (!td) return;
  td.innerHTML = '';
  if (!activeProj) {
    const e = document.createElement('div'); e.className = 'td-empty';
    e.textContent = 'Выберите проект в меню «📁 Проекты».';
    td.appendChild(e);
    return;
  }
  const list = sessionsForProj(activeProj);
  const canClose = list.length > 1;
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'td-term' + (s.sid === selected ? ' active' : '');
    const nm = document.createElement('span');
    nm.className = 'td-name'; nm.textContent = s.tab || s.label || s.sid;
    nm.onclick = () => { closeTopPanels(); selectSession(s.sid); };
    row.appendChild(nm);
    // Крестик — только если терминалов 2+ (последний закрывать нельзя).
    if (canClose) {
      const x = document.createElement('button');
      x.className = 'td-x'; x.textContent = '×';
      x.onclick = (e) => { e.stopPropagation(); send({ t: 'close', sid: s.sid }); };
      row.appendChild(x);
    }
    td.appendChild(row);
  }
  if (activeProj !== ORPHAN) {   // сироты-проекта на ПК нет — новый терминал открывать некуда
    const add = document.createElement('button');
    add.className = 'td-new'; add.textContent = '＋ Новый терминал';
    add.onclick = () => { openProjTerminal(activeProj); };   // openProjTerminal сам закроет панели
    td.appendChild(add);
  }
}

// Открыть/закрыть выпадашку терминалов, прижав её к низу селектор-бара.
function toggleTermDropdown() {
  const td = $('termdrop');
  if (!td) return;
  if (td.style.display === 'block') { closeTopPanels(); return; }
  const pm = $('projmodal'); if (pm) pm.style.display = 'none';
  const dm = $('dropmenu'); if (dm) dm.style.display = 'none';
  renderTermDropdown();
  const sel = $('termsel');
  if (sel) td.style.top = Math.round(sel.getBoundingClientRect().bottom + 2) + 'px';
  setShade(true);
  td.style.display = 'block';
}

// Подпись селектор-бара: «Проект · Терминал N».
function updateTermSel() {
  const lbl = $('termsel-label');
  if (!lbl) return;
  if (!activeProj) { lbl.textContent = 'Выбери проект'; return; }
  const s = (lastSessions || []).find((x) => x.sid === selected);
  const tname = s ? (s.tab || s.label || s.sid) : '—';
  lbl.textContent = projName(activeProj) + ' · ' + tname;
}

function selectSession(sid) {
  selected = sid;
  const s = (lastSessions || []).find((x) => x.sid === sid);
  if (s) activeProj = projKeyOf(s);   // следуем за проектом выбранного терминала
  frame = null;
  screenFollow = true;
  resetHistory();
  renderScreen();
  send({ t: 'select', sid, styled: 1 });   // ПК ответит немедленным полным кадром (styled — просим цвета)
  updateTermSel();
  renderTermDropdown();
  renderTree();
}
// Открыть терминал проекта на ПК (＋ или тап по вкладке-плейсхолдеру). Новая сессия
// прилетит в state — запоминаем проект, чтобы выбрать её автоматически.
let pendingOpenProj = '';
function openProjTerminal(projId) {
  pendingOpenProj = projId;
  send({ t: 'open', projId });
  closeTopPanels();
  setStatus('Открываю терминал…', 'wait');
  setTimeout(() => {
    if (pendingOpenProj !== projId) return;   // успели открыть/переключить
    pendingOpenProj = '';
    const online = ws && ws.readyState === 1;
    setStatus(online ? '● На связи' : 'Нет связи', online ? 'ok' : 'wait');
  }, 8000);
}
function sendInput(data) { if (selected) send({ t: 'input', sid: selected, data }); }
function send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} } }

// После перезапуска/возврата ПК sessionId может совпасть со старым (он детерминирован),
// поэтому обычная проверка «сессия существует» не перезапрашивает экран нового PTY.
// Здесь принудительно сбрасываем кадр и тянем свежий полный (стоит ~5КБ — дёшево).
function resyncTerminal() {
  const sid = (selected && lastSessions.some((s) => s.sid === selected)) ? selected
            : (lastSessions[0] && lastSessions[0].sid);
  if (!sid) return false;       // вкладок ещё нет (ПК не успел поднять) — попробуем на следующем state
  selected = sid;
  const s = (lastSessions || []).find((x) => x.sid === sid);
  if (s) activeProj = projKeyOf(s);
  updateTermSel(); renderTree();
  frame = null;
  screenFollow = true;
  resetHistory();
  renderScreen();
  requestFullFrame(true);
  return true;
}

// ----------------------------------------------------------------- соединение
// hello несёт идентичность устройства: ПК ведёт список подключённых пультов
// (бейдж у версии в редакторе) и может адресно запросить сисинфо или кикнуть.
function sendHello() {
  send({ t: 'hello', device: deviceId(), name: deviceName(), ver: window.PULT_VER || '' });
}
// ПК отключил доступ этому устройству (модалка «Пульты»). Не удаление: токен храним,
// реконнект останавливаем до явного «Повторить» (если доступ вернули — подключимся).
let kicked = false;
function showKicked() {
  kicked = true;
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  setStatus('Доступ отключён', 'bad');
  const b = document.createElement('div');
  const t = document.createElement('div');
  t.style.cssText = 'color:#e0af68;font-size:14px;line-height:1.5;margin-bottom:14px';
  t.textContent = 'Доступ этого устройства отключён в редакторе на ПК (лейбл «Пульты» у версии). Включите доступ обратно и нажмите «Повторить».';
  const go = document.createElement('button');
  go.textContent = 'Повторить подключение';
  go.style.cssText = 'background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:12px 14px;font-size:15px;width:100%';
  go.onclick = () => {
    kicked = false;
    const ov = $('overlay'); if (ov) ov.style.display = 'none';
    setStatus('Подключение…', 'wait');
    connect();
  };
  b.appendChild(t); b.appendChild(go);
  showOverlay('Доступ отключён', b);
}
// Ответ на запрос с ПК. what='info' — только диагностика (без запроса геолокации и
// её пермишена); what='geo' — только местоположение; пусто — и то и другое (совместимость).
function replySysInfo(what) {
  const wantInfo = what !== 'geo';
  const wantGeo = what !== 'info';
  const info = wantInfo ? diagnosticsText() : '';
  let sent = false;
  const done = (loc) => { if (sent) return; sent = true; send({ t: 'sysinfo', device: deviceId(), what: what || '', info, loc }); };
  if (!wantGeo) { done(null); return; }
  try {
    if (!navigator.geolocation) { done({ error: 'геолокация недоступна' }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => done({ error: (e && e.message) || 'нет доступа к геолокации' }),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
    setTimeout(() => done({ error: 'таймаут геолокации' }), 10000);   // страховка: ответ уходит всегда
  } catch (e) { done({ error: String((e && e.message) || e) }); }
}
function connect() {
  const url = `${relayUrl}?token=${encodeURIComponent(token)}&role=app&device=${encodeURIComponent(deviceId())}`;
  if (token) setStatus('Подключение…', 'wait');
  try { ws = new WebSocket(url); } catch (e) { sendReport('ws-fail', String(e), url); scheduleReconnect(); return; }

  ws.onopen = () => {
    pairingShown = false;   // новое соединение → разрешаем заново показать пайринг при need_pairing
    if (token) { setStatus('● На связи', 'ok'); resyncTerm = true; sendHello(); }   // (пере)подключились → перезапросить терминал
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
      sendHello();
    } else if (m.t === 'auth_err') {
      authError(m.error || 'Ошибка входа');
    } else if (m.t === 'state') {
      lastSessions = m.sessions || []; lastProjects = m.projects || []; renderTree();
      // Ждали открытия терминала проекта (тап по плейсхолдеру/＋) → выбрать новую сессию.
      if (pendingOpenProj) {
        const list = lastSessions.filter((s) => s.projId === pendingOpenProj);
        if (list.length) {
          pendingOpenProj = '';
          setStatus('● На связи', 'ok');
          selectSession(list[list.length - 1].sid);   // новый PTY — последний в списке проекта
          return;
        }
      }
      const exists = selected && lastSessions.some((s) => s.sid === selected);
      const target = m.active || (lastSessions[0] && lastSessions[0].sid);
      if (resyncTerm) {                       // после рестарта/возврата ПК — перезапросить свежий кадр
        if (resyncTerminal()) resyncTerm = false;   // удалось — сброс; нет вкладок — ждём следующий state
      } else if (!exists) { selected = null; if (target) selectSession(target); }   // сессия исчезла/первый вход — выбрать валидную
      // НЕ следуем за активной ПК: вкладку на пульте выбирает пользователь, PC-active игнорируем
      // Активный проект мог исчезнуть (удалён на ПК / сироты закрылись) — синхронизируем подпись и открытую выпадашку.
      if (activeProj && activeProj !== ORPHAN && !knownProjIds()[activeProj]) activeProj = null;
      if (activeProj === ORPHAN && !sessionsForProj(ORPHAN).length) activeProj = null;
      updateTermSel();
      const td = $('termdrop'); if (td && td.style.display === 'block') renderTermDropdown();
    }
    else if (m.t === 'screen') { applyScreenMsg(m); }
    else if (m.t === 'exit') {
      if (m.sid === selected) { frame = null; resetHistory(); if (screenEl) screenEl.textContent = '[сессия завершена]'; }
    }
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
    else if (m.t === 'tasks:data') {
      const cb = tasksPending[m.reqId];
      if (cb) { delete tasksPending[m.reqId]; try { cb(m.notes || [], m.id); } catch (_) {} }
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
      resyncTerm = true; sendHello();   // одобрено → перезапросить терминал
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
      setStatus('Редактор перезапущен ✓', 'ok'); sendHello();
    }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'leave') {
      // во время/сразу после перезапуска уход старой копии — ожидаемый шум: статус НЕ трогаем
      if (!(awaitingRestart || Date.now() < restartGraceUntil)) setStatus('ПК отключился', 'wait');
    }
    else if (m.t === 'peer' && m.role === 'pc' && m.event === 'join') {
      awaitingRestart = false; restartGraceUntil = 0; resyncTerm = true;
      setStatus('● На связи', 'ok'); sendHello();
    }
    else if (m.t === 'sysinfo:get') {
      // Адресный запрос: отвечает только устройство с совпадающим id (релей шлёт всем).
      if (!m.device || m.device === deviceId()) replySysInfo(m.what || '');
    }
    else if (m.t === 'kick') {
      if (!m.device || m.device === deviceId()) showKicked();
    }
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function scheduleReconnect() {
  if (kicked) return;   // доступ отключён с ПК — ждём явного «Повторить»
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!ws) connect(); }, 3000);
}


function enterApp() {
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
  if (!termInited) { termInited = true; initScreen(); wireTermbar(); wireTopPanels(); }
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
    keepKbdInViewport();
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
  setTimeout(hardResetScroll, 60);
  setTimeout(hardResetScroll, 180);
  setTimeout(hardResetScroll, 360);
};

function start(config) {
  // Приоритет: явный ?relay= из URL → сохранённый пользователем хост → пусто (спросим на входе).
  if (config && config.relayUrl) relayUrl = config.relayUrl;
  else { const saved = lsGet('lite_relay'); if (saved) relayUrl = saved; }
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
    const ts = $('termsel'); if (ts) ts.onclick = toggleTermDropdown;   // селектор → выпадашка терминалов активного проекта
    wireViewportEvents(); // единая точка resize/orientation для xterm и плавающей клавиатуры
    lockViewport();      // клавиатура не должна двигать UI (старые WebView)
    wireKbd();           // плавающая своя клавиатура (перетаскивание + крестик)
    token = lsGet('lite_token') || '';
    if (token && relayUrl) enterApp(); else showLogin('');
    // Без указанного хоста релея не подключаемся — ждём ввода на экране входа (submitAuth).
    if (relayUrl) connect();   // с токеном → авторизуемся; без → пред-авторизованный сокет для входа
    // Вотчдог кадра: раз в секунду. Если сессия выбрана, а кадра нет (ПК перезапускался,
    // PTY ещё не поднялся, select потерялся в сети) — сами перезапрашиваем полный кадр,
    // пока не получим (requestFullFrame троттлит до 1 запроса/сек).
    setInterval(() => {
      if (ws && ws.readyState === 1 && token && selected && !frame) requestFullFrame();
    }, 1000);
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
