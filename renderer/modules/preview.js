// Правая колонка Live Preview (#preview-pane): изолированный webview, вьюпорты, console/network логи, скриншоты -> агент.
import { el, icon, iconBtn } from '../ui.js';
import { t } from '../i18n.js';

function formatAgentReport({ url = '', viewport = 'desktop', consoleErrors = [], failedRequests = [], screenshotPath = '' }) {
  const out = [];
  out.push(`Проблема в предпросмотре (${viewport}): ${url || 'about:blank'}`);
  if (screenshotPath) out.push(`Скриншот: ${screenshotPath}`);
  const errs = consoleErrors.slice(-10);
  if (errs.length) {
    out.push('Ошибки консоли:');
    for (const e of errs) {
      const loc = e.sourceId ? ` (${e.sourceId}:${e.line || 0})` : '';
      out.push(`- [${e.level || 'error'}] ${String(e.message || '').slice(0, 300)}${loc}`);
    }
  }
  const net = failedRequests.slice(-10);
  if (net.length) {
    out.push('Сетевые сбои:');
    for (const n of net) {
      const st = n.statusCode ? `HTTP ${n.statusCode}` : (n.error || 'ERR_FAILED');
      out.push(`- ${n.method || 'GET'} ${String(n.url || '').slice(0, 220)} -> ${st}`);
    }
  }
  if (!errs.length && !net.length && !screenshotPath) {
    out.push('(Ошибок в консоли/сети не зафиксировано)');
  }
  return out.join('\n') + '\n';
}

export function initPreview(host) {
  const { lite, withHk, getActiveProject, getLayout, setLayoutProp, onLayoutChange, sendToActiveTerminal, toast } = host;

  let currentUrl = '';
  let viewport = 'desktop'; // desktop | tablet | mobile
  let allowExternal = false;
  let logsOpen = false;
  let logTab = 'console'; // console | network
  /** @type {any[]} */
  let consoleLogs = [];
  /** @type {any[]} */
  let networkErrors = [];
  /** @type {any} */
  let wvEl = null;
  let wvReady = false;
  /** @type {HTMLInputElement | null} */
  let urlInEl = null;
  /** @type {HTMLElement | null} */
  let stageWrapEl = null;
  /** @type {HTMLElement | null} */
  let stageEl = null;
  /** @type {HTMLElement | null} */
  let emptyEl = null;
  /** @type {HTMLElement | null} */
  let logsEl = null;
  /** @type {HTMLElement | null} */
  let logListEl = null;

  const pane = () => document.getElementById('preview-pane');
  const gutter = () => document.getElementById('gutter-preview');
  const hdrBtn = () => document.getElementById('btn-preview');
  const isOpen = () => !!(getLayout && getLayout().previewOpen);

  function updateBadge() {
    const cnt = consoleLogs.filter((x) => x.level === 'error').length + networkErrors.length;
    const badge = document.getElementById('preview-btn-badge');
    if (badge) {
      badge.textContent = cnt > 99 ? '99+' : (cnt > 0 ? String(cnt) : '');
      badge.classList.toggle('show', cnt > 0);
    }
  }

  function syncOpenDom() {
    const on = isOpen();
    const p = pane(), g = gutter(), b = hdrBtn();
    if (p) p.classList.toggle('hidden', !on);
    if (g) g.classList.toggle('hidden', !on);
    if (b) b.classList.toggle('on', on);
  }

  function renderLogs() {
    updateBadge();
    if (!logsEl || !logListEl) return;
    logsEl.classList.toggle('hidden', !logsOpen);
    if (!logsOpen) return;
    logListEl.replaceChildren();
    const list = logTab === 'console' ? consoleLogs : networkErrors;
    if (!list.length) {
      logListEl.appendChild(el('div', 'preview-log-row', logTab === 'console' ? 'Ошибок/предупреждений консоли нет' : 'Сетевых сбоев (4xx/5xx/ERR) нет'));
      return;
    }
    for (const item of list.slice(-60).reverse()) {
      const cls = logTab === 'console'
        ? (item.level === 'error' ? 'err' : item.level === 'warn' ? 'warn' : '')
        : 'err';
      const txt = logTab === 'console'
        ? `[${item.level}] ${item.message}${item.sourceId ? ` (${item.sourceId}:${item.line || 0})` : ''}`
        : `${item.method || 'GET'} ${item.url} -> ${item.statusCode ? 'HTTP ' + item.statusCode : item.error}`;
      const r = el('div', 'preview-log-row ' + cls, txt);
      r.setAttribute('data-no-i18n', '');
      logListEl.appendChild(r);
    }
  }

  function applyViewportDom() {
    if (!stageWrapEl) return;
    stageWrapEl.classList.toggle('vp-tablet', viewport === 'tablet');
    stageWrapEl.classList.toggle('vp-mobile', viewport === 'mobile');
    stageWrapEl.classList.toggle('vp-framed', viewport !== 'desktop');
    const p = pane();
    if (p) {
      p.querySelectorAll('.preview-vp-btn').forEach((b) => {
        if (b instanceof HTMLElement) b.classList.toggle('on', b.dataset.vp === viewport);
      });
    }
  }

  function ensureWebview() {
    if (wvEl || !stageEl) return wvEl;
    const wv = /** @type {any} */ (document.createElement('webview'));
    wv.className = 'preview-webview';
    wv.setAttribute('partition', 'persist:lite-preview');
    wv.setAttribute('src', currentUrl || 'about:blank');

    wv.addEventListener('dom-ready', () => {
      wvReady = true;
      if (emptyEl) emptyEl.classList.toggle('hidden', !!currentUrl);
    });
    wv.addEventListener('did-navigate', (e) => {
      if (e && e.url && e.url !== 'about:blank') {
        currentUrl = e.url;
        if (urlInEl && document.activeElement !== urlInEl) urlInEl.value = currentUrl;
        if (emptyEl) emptyEl.classList.add('hidden');
      }
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      if (e && e.url && e.url !== 'about:blank') {
        currentUrl = e.url;
        if (urlInEl && document.activeElement !== urlInEl) urlInEl.value = currentUrl;
      }
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e || e.errorCode === -3) return; // ERR_ABORTED ignore
      toast(`${t('Ошибка загрузки предпросмотра')}: ${e.errorDescription || e.errorCode}`, { kind: 'warn' });
    });

    stageEl.insertBefore(wv, emptyEl);
    wvEl = wv;
    return wvEl;
  }

  function navigateTo(raw) {
    let u = String(raw || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    currentUrl = u;
    if (urlInEl) urlInEl.value = u;
    if (emptyEl) emptyEl.classList.add('hidden');
    const wv = ensureWebview();
    if (wv) {
      try {
        if (wvReady && typeof wv.loadURL === 'function') wv.loadURL(u);
        else wv.setAttribute('src', u);
      } catch (_) {
        wv.setAttribute('src', u);
      }
    }
  }

  async function captureShot() {
    if (!wvEl || !wvReady || typeof wvEl.getWebContentsId !== 'function') {
      toast('Сначала откройте страницу в предпросмотре', { kind: 'warn' });
      return null;
    }
    const proj = getActiveProject ? getActiveProject() : null;
    const r = await lite.preview.capture({
      webContentsId: wvEl.getWebContentsId(),
      projectDir: proj && proj.path ? proj.path : '',
    });
    if (!r || !r.ok) {
      toast((r && r.error) || 'Не удалось снять скриншот', { kind: 'err' });
      return null;
    }
    return r.path;
  }

  async function sendToAgent() {
    const shotPath = (wvEl && wvReady && currentUrl) ? await captureShot() : '';
    const report = formatAgentReport({
      url: currentUrl,
      viewport,
      consoleErrors: consoleLogs,
      failedRequests: networkErrors,
      screenshotPath: shotPath || '',
    });
    sendToActiveTerminal(report);
    toast('Отчёт предпросмотра и скриншот отправлены агенту', { kind: 'ok' });
  }

  function renderPane() {
    syncOpenDom();
    const root = pane();
    if (!root || root.firstChild) return;

    const head = el('div', 'preview-head');
    const bBack = iconBtn('icon-btn', 'chevron-left', 'Назад', 15);
    bBack.onclick = () => { if (wvEl && wvReady && wvEl.canGoBack && wvEl.canGoBack()) wvEl.goBack(); };
    const bFwd = iconBtn('icon-btn', 'chevron-right', 'Вперёд', 15);
    bFwd.onclick = () => { if (wvEl && wvReady && wvEl.canGoForward && wvEl.canGoForward()) wvEl.goForward(); };
    const bRel = iconBtn('icon-btn', 'refresh', 'Обновить страницу', 15);
    bRel.onclick = () => { if (wvEl && wvReady) wvEl.reload(); else if (currentUrl) navigateTo(currentUrl); };

    const uIn = /** @type {HTMLInputElement} */ (document.createElement('input'));
    uIn.type = 'text'; uIn.className = 'preview-url-in';
    uIn.placeholder = 'http://localhost:3000';
    uIn.value = currentUrl; uIn.setAttribute('data-no-i18n', '');
    uIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); navigateTo(uIn.value); } };
    urlInEl = uIn;

    const bClose = iconBtn('icon-btn', 'x', withHk ? withHk('Скрыть предпросмотр', 'togglePreview') : 'Скрыть предпросмотр', 15);
    bClose.id = 'preview-close-btn';
    bClose.onclick = () => setOpen(false);
    head.append(bBack, bFwd, bRel, uIn, bClose);

    const tb = el('div', 'preview-toolbar');
    const vpGrp = el('div', 'preview-vp-grp');
    for (const [id, ic, lbl] of [['desktop', 'laptop', 'Десктоп (100%)'], ['tablet', 'tablet', 'Планшет (768px)'], ['mobile', 'smartphone', 'Телефон (390px)']]) {
      const vb = iconBtn('icon-btn preview-vp-btn', ic, lbl, 14);
      vb.dataset.vp = id;
      vb.onclick = () => { viewport = id; applyViewportDom(); };
      vpGrp.appendChild(vb);
    }

    const extLbl = el('label', 'preview-ext-chk');
    extLbl.title = t('По умолчанию разрешены только localhost/127.0.0.1 адреса');
    const extCb = /** @type {HTMLInputElement} */ (document.createElement('input'));
    extCb.type = 'checkbox'; extCb.checked = allowExternal;
    extCb.onchange = async () => {
      allowExternal = extCb.checked;
      await lite.preview.setAllowExternal(allowExternal);
    };
    extLbl.append(extCb, el('span', null, 'Внешние URL'));

    const sp = el('span', 'grow');
    const bShot = iconBtn('icon-btn', 'image', 'Сделать скриншот', 15);
    bShot.onclick = async () => {
      const p = await captureShot();
      if (p) { lite.copyText(p); toast('Скриншот сохранён (путь скопирован)'); }
    };
    const bAgent = el('button', 'btn primary', 'Агенту');
    bAgent.style.padding = '3px 8px'; bAgent.style.fontSize = '11.5px';
    bAgent.title = t('Снять скриншот, собрать ошибки консоли и сети и отправить активному агенту');
    bAgent.onclick = sendToAgent;
    const bDev = iconBtn('icon-btn', 'wrench', 'DevTools', 15);
    bDev.onclick = () => {
      if (wvEl && wvReady && wvEl.getWebContentsId) lite.preview.openDevTools(wvEl.getWebContentsId());
    };
    const bLogs = el('button', 'btn', 'Логи');
    bLogs.style.padding = '3px 8px'; bLogs.style.fontSize = '11.5px';
    bLogs.onclick = () => { logsOpen = !logsOpen; renderLogs(); };

    tb.append(vpGrp, extLbl, sp, bShot, bAgent, bDev, bLogs);

    const wrap = el('div', 'preview-stage-wrap');
    const stage = el('div', 'preview-stage');
    const emp = el('div', 'preview-empty');
    emp.append(
      icon('globe', 26),
      el('div', null, 'Введите адрес localhost или нажмите на чип порта в нижней строке терминала'),
    );
    stage.appendChild(emp);
    wrap.appendChild(stage);
    stageWrapEl = wrap; stageEl = stage; emptyEl = emp;

    const logs = el('div', 'preview-logs hidden');
    const lbar = el('div', 'preview-logs-bar');
    const bCon = el('button', 'btn', 'Консоль'); bCon.style.padding = '2px 7px'; bCon.style.fontSize = '11px';
    bCon.onclick = () => { logTab = 'console'; renderLogs(); };
    const bNet = el('button', 'btn', 'Сеть (ошибки)'); bNet.style.padding = '2px 7px'; bNet.style.fontSize = '11px';
    bNet.onclick = () => { logTab = 'network'; renderLogs(); };
    const lsp = el('span', 'grow');
    const bLClr = el('button', 'btn', 'Очистить'); bLClr.style.padding = '2px 7px'; bLClr.style.fontSize = '11px';
    bLClr.onclick = async () => { consoleLogs = []; networkErrors = []; await lite.preview.clearLogs(); renderLogs(); };
    lbar.append(bCon, bNet, lsp, bLClr);
    const llist = el('div', 'preview-log-list');
    logs.append(lbar, llist);
    logsEl = logs; logListEl = llist;

    root.append(head, tb, wrap, logs);
    applyViewportDom();
    if (currentUrl) ensureWebview();
    renderLogs();
  }

  function setOpen(open) {
    const want = !!open;
    if (want === isOpen()) {
      if (want) renderPane();
      return;
    }
    setLayoutProp('previewOpen', want);
    syncOpenDom();
    if (want) renderPane();
    onLayoutChange();
  }

  function toggle() { setOpen(!isOpen()); }

  function openUrl(url) {
    if (!isOpen()) setOpen(true);
    else renderPane();
    navigateTo(url);
  }

  function init() {
    syncOpenDom();
    const b = hdrBtn();
    if (b) b.addEventListener('click', () => toggle());
    if (lite.preview && typeof lite.preview.onEvent === 'function') {
      lite.preview.onEvent((ev) => {
        if (!ev) return;
        if (ev.kind === 'console' && ev.entry && (ev.entry.level === 'error' || ev.entry.level === 'warn')) {
          consoleLogs.push(ev.entry);
          if (consoleLogs.length > 150) consoleLogs.shift();
          renderLogs();
        } else if (ev.kind === 'network' && ev.entry) {
          networkErrors.push(ev.entry);
          if (networkErrors.length > 150) networkErrors.shift();
          renderLogs();
        } else if (ev.kind === 'blocked') {
          toast(ev.error || 'URL заблокирован политикой предпросмотра', { kind: 'warn' });
        } else if (ev.kind === 'hotkey' && ev.action === 'togglePreview') {
          toggle();
        }
      });
    }
    if (isOpen()) renderPane();
  }

  return { init, isOpen, setOpen, toggle, openUrl };
}
