// Доменный модуль «Мониторинг сайтов» (target → checks, фоновый опрос + vm-песочница предикатов).

'use strict';

const http = require('http');
const https = require('https');
const vm = require('vm');

/**
 * @param {object} deps
 * @param {{ handle: (ch: string, fn: (event: any, ...args: any[]) => any) => void, on: (ch: string, fn: (event: any, ...args: any[]) => any) => void }} deps.ipcMain
 * @param {any} deps.BrowserWindow
 * @param {any} deps.Notification
 * @param {(key: string) => any} deps.readStoreKey
 * @param {(key: string, val: any) => void} deps.writeStoreKey
 * @param {{ markSnapshotBrokenIfReadFailed: (key: string) => void }} deps.appStore
 * @param {(win: any, ch: string, payload?: any) => boolean} deps.sendTo
 * @param {() => any} deps.getMainWindow
 * @param {() => Iterable<any>} deps.getModuleWindows
 * @param {() => void} deps.onSitesChanged
 */
function registerSitemonIpc(deps) {
  const {
    ipcMain, BrowserWindow, Notification,
    readStoreKey, writeStoreKey, appStore,
    sendTo, getMainWindow, getModuleWindows, onSitesChanged,
  } = deps;

  const SM_HISTORY = 60;
  const SM_BODY_CAP = 2 * 1024 * 1024;
  /** @type {any[]} */
  let smTargets = [];

  function smNewId(p) { return (p || 'sm') + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function smNormUrl(url) { let u = String(url || '').trim(); if (!u) return null; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; try { new URL(u); return u; } catch (_) { return null; } }
  function smClampInt(v) { return Math.max(15, Math.min(86400, Number(v) || 60)); }
  function smCleanHeaders(h) { if (!h || typeof h !== 'object') return null; const out = {}; let n = 0; for (const k of Object.keys(h)) { if (n++ >= 20) break; const key = String(k).trim(); if (!key) continue; out[key] = String(h[k]); } return Object.keys(out).length ? out : null; }

  /**
   * @param {string} rawUrl
   * @param {{ headers?: Record<string, string> | null, timeoutMs?: number, insecureTls?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  function smFetch(rawUrl, opts = {}) {
    const headers = (opts.headers && typeof opts.headers === 'object') ? opts.headers : null;
    const timeoutMs = opts.timeoutMs || 12000;
    const rejectUnauthorized = opts.insecureTls !== true;
    return new Promise((resolve) => {
      let redirects = 6;
      /** @type {import('http').ClientRequest | null} */
      let req = null;
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let hard = null;
      let hdrs = headers;
      const finish = (r) => { if (settled) return; settled = true; if (hard) clearTimeout(hard); if (!r.ok || r.capped) { try { if (req) req.destroy(); } catch (_) {} } resolve(r); };
      hard = setTimeout(() => finish({ ok: false, error: 'таймаут' }), timeoutMs * 3);
      const go = (urlStr) => {
        let u; try { u = new URL(urlStr); } catch (_) { return finish({ ok: false, error: 'некорректный URL' }); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return finish({ ok: false, error: 'только http/https' });
        const mod = u.protocol === 'https:' ? https : http;
        const t0 = Date.now();
        try {
          req = mod.request(u, { method: 'GET', rejectUnauthorized, headers: Object.assign({ 'User-Agent': 'LiteEditor-Monitor/1.0', 'Accept': '*/*' }, hdrs || {}), timeout: timeoutMs }, (res) => {
            if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
              res.resume();
              if (redirects <= 0) return finish({ ok: false, error: 'слишком много редиректов' });
              redirects--;
              let next; try { next = new URL(res.headers.location, u); } catch (_) { return finish({ ok: false, error: 'плохой редирект' }); }
              if (hdrs && (next.host !== u.host || (u.protocol === 'https:' && next.protocol === 'http:'))) hdrs = null;
              return go(next.toString());
            }
            const chunks = []; let len = 0, capped = false;
            const done = () => finish({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0, bytes: len, capped });
            res.on('data', (c) => { if (len < SM_BODY_CAP) { chunks.push(c); len += c.length; } if (len >= SM_BODY_CAP) { capped = true; done(); } });
            res.on('end', done);
            res.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
          });
        } catch (e) { return finish({ ok: false, error: String((e && e.message) || e) }); }
        const r0 = req;
        r0.on('timeout', () => { try { r0.destroy(); } catch (_) {} if (req === r0) finish({ ok: false, error: 'таймаут' }); });
        r0.on('error', (e) => { if (req === r0) finish({ ok: false, error: (/** @type {any} */ (e) && /** @type {any} */ (e).code === 'ENOTFOUND') ? 'домен не найден' : String((e && e.message) || e) }); });
        r0.end();
      };
      go(rawUrl);
    });
  }

  const SM_RENDER_PARTITION = 'sitemon-render';
  let smRenderSesReady = false;
  function smRenderSession(ses) {
    if (smRenderSesReady || !ses) return;
    smRenderSesReady = true;
    try {
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
      ses.on('will-download', (e) => e.preventDefault());
    } catch (_) {}
  }

  /**
   * @param {string} url
   * @param {string[]} selectors
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  function smRenderCapture(url, selectors, timeoutMs) {
    return new Promise((resolve) => {
      /** @type {any} */
      let win = null;
      let done = false;
      const finish = (r) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {} resolve(r); };
      const to = setTimeout(() => finish({ error: 'таймаут рендера' }), (timeoutMs || 15000) + 3000);
      try {
        win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: false, images: false, contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: true, partition: SM_RENDER_PARTITION, disableDialogs: true } });
        smRenderSession(win.webContents.session);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (e, navUrl) => { if (!/^https?:/i.test(String((e && e.url) || navUrl || ''))) e.preventDefault(); });
        try { win.webContents.setAudioMuted(true); } catch (_) {}
        win.webContents.on('did-finish-load', async () => {
          try {
            await new Promise((r) => setTimeout(r, 1200));
            const text = await win.webContents.executeJavaScript('(document.body?document.body.innerText:"").slice(0,500000)');
            /** @type {Record<string, any>} */
            const sel = {};
            for (const s of (selectors || [])) { try { sel[s] = await win.webContents.executeJavaScript('(function(){try{var e=document.querySelector(' + JSON.stringify(s) + ');return e?(e.textContent||"").trim():null;}catch(_){return null;}})()'); } catch (_) { sel[s] = null; } }
            clearTimeout(to); finish({ text, sel });
          } catch (e) { clearTimeout(to); finish({ error: String((e && e.message) || e) }); }
        });
        win.webContents.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => { if (isMainFrame) { clearTimeout(to); finish({ error: desc || ('ошибка загрузки ' + code) }); } });
        win.loadURL(url, { userAgent: 'LiteEditor-Monitor/1.0' }).catch(() => {});
      } catch (e) { clearTimeout(to); finish({ error: String((e && e.message) || e) }); }
    });
  }

  function smJsonPath(obj, p) {
    if (obj === undefined || obj === null) return undefined;
    const parts = String(p || '').replace(/\[(\d+)\]/g, '.$1').replace(/\[["']?([^"'\]]+)["']?\]/g, '.$1').split('.').map((s) => s.trim()).filter(Boolean);
    let cur = obj;
    for (const part of parts) { if (cur === null || cur === undefined) return undefined; cur = cur[part]; }
    return cur;
  }
  function smExtract(spec, cap) {
    switch (spec.source) {
      case 'status': return cap.status;
      case 'latency': return cap.ms;
      case 'text': return cap.text || '';
      case 'header': return cap.headers ? cap.headers[String(spec.path || '').toLowerCase()] : undefined;
      case 'json': return smJsonPath(cap.json, spec.path);
      case 'css': return cap.sel ? cap.sel[spec.path] : undefined;
      case 'regex': { try { const m = new RegExp(spec.path).exec(cap.text || ''); return m ? (m[1] !== undefined ? m[1] : m[0]) : undefined; } catch (_) { return undefined; } }
      default: return undefined;
    }
  }
  function smNum(v) { return parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/[^0-9.eE+-]/g, '')); }
  function smCompare(val, cmp, exp) {
    const s = (v) => (v === undefined || v === null ? '' : String(v));
    switch (cmp) {
      case 'eq': { if (s(val).trim() === s(exp).trim()) return true; const a = smNum(val), b = smNum(exp); return isFinite(a) && isFinite(b) && a === b; }
      case 'ne': return s(val).trim() !== s(exp).trim();
      case 'lt': return smNum(val) < smNum(exp);
      case 'le': return smNum(val) <= smNum(exp);
      case 'gt': return smNum(val) > smNum(exp);
      case 'ge': return smNum(val) >= smNum(exp);
      case 'contains': return s(val).includes(s(exp));
      case 'ncontains': return !s(val).includes(s(exp));
      case 'matches': { try { return new RegExp(exp).test(s(val)); } catch (_) { return false; } }
      case 'exists': return val !== undefined && val !== null && s(val) !== '';
      default: return false;
    }
  }
  function smNorm(v) { if (v === undefined) return '∅u'; if (v === null) return '∅n'; return typeof v === 'object' ? JSON.stringify(v) : String(v); }
  function smFmtVal(v) { if (v === undefined) return '∅'; if (v === null) return 'null'; let s; if (typeof v === 'object') { try { s = JSON.stringify(v); } catch (_) { return '[object]'; } } else s = String(v); return s.length > 120 ? s.slice(0, 117) + '…' : s; }
  function smFmtShort(v) { const s = String(v); return s.length > 40 ? s.slice(0, 37) + '…' : s; }

  const SM_PRED_WRAP = '"use strict";const input=JSON.parse(__j);(function(){var r;'
    + 'try{r=(0,eval)(\'"use strict";(\'+__code+\'\\n)\')(input);}'
    + 'catch(e){var m;try{m=String((e&&e.message)||e);}catch(_){m="ошибка предиката";}return JSON.stringify({__err:m});}'
    + 'if(r===null||typeof r!=="object")return "null";'
    + 'var v=r.value,o={status:r.status==null?null:String(r.status),ok:typeof r.ok==="boolean"?r.ok:null,label:r.label==null?null:String(r.label)};'
    + 'if(v!=null){if(typeof v==="object"){try{v=JSON.stringify(v);}catch(_){v=undefined;}o.value=v===undefined?"[object]":v;}else o.value=String(v);}else if(v===null)o.value=null;'
    + 'return JSON.stringify(o);})()';
  function smRunCustom(code, input) {
    let j; try { j = JSON.stringify(input === undefined ? null : input); } catch (_) { j = 'null'; }
    const ctx = Object.create(null); ctx.__j = j; ctx.__code = String(code || '').trim();
    const out = JSON.parse(vm.runInNewContext(SM_PRED_WRAP, ctx, { timeout: 1500, contextName: 'sitemon-predicate', microtaskMode: 'afterEvaluate' }));
    if (out && typeof out.__err === 'string') throw new Error(out.__err);
    return out;
  }

  function smBuildCapture(target) {
    const checks = target.checks || [];
    const anyCustom = checks.some((c) => c.kind === 'custom');
    const needJson = anyCustom || checks.some((c) => c.kind === 'basic' && c.spec && c.spec.source === 'json');
    const cssSel = []; for (const c of checks) if (c.kind === 'basic' && c.spec && c.spec.source === 'css' && c.spec.path) cssSel.push(c.spec.path);
    const needDom = !!target.render && (anyCustom || cssSel.length > 0 || checks.some((c) => c.kind === 'basic' && c.spec && (c.spec.source === 'text' || c.spec.source === 'regex')));
    return smFetch(target.url, { headers: target.headers, timeoutMs: 12000, insecureTls: !!target.insecureTls }).then(async (res) => {
      /** @type {any} */
      const cap = { url: target.url, ok: !!res.ok, status: res.ok ? (res.status || 0) : 0, ms: res.ms || 0, headers: res.headers || {}, text: res.ok ? (res.body || '') : '', json: undefined, sel: {}, error: res.ok ? '' : (res.error || 'нет связи') };
      if (needJson && cap.ok) { try { cap.json = JSON.parse(res.body || ''); } catch (_) { cap.json = undefined; } }
      if (needDom && cap.ok) { const dom = await smRenderCapture(target.url, cssSel, 15000); if (dom && !dom.error) { cap.text = dom.text || cap.text; cap.sel = dom.sel || {}; cap.rendered = true; } else if (dom) cap.renderError = dom.error; }
      return cap;
    });
  }

  function smNormStatus(out) {
    let s = out && out.status;
    if (s != null) {
      s = String(s).toLowerCase().trim();
      if (s === 'ok' || s === 'green' || s === 'good' || s === 'up' || s === 'success' || s === 'pass') return 'ok';
      if (s === 'warn' || s === 'warning' || s === 'yellow' || s === 'degraded') return 'warn';
      if (s === 'info' || s === 'blue' || s === 'note' || s === 'notice') return 'info';
      if (s === 'alert' || s === 'red' || s === 'bad' || s === 'down' || s === 'triggered' || s === 'critical' || s === 'fail' || s === 'error') return 'triggered';
    }
    if (out && typeof out.ok === 'boolean') return out.ok ? 'ok' : 'triggered';
    return null;
  }

  function smEvalCheck(check, cap, mutate) {
    try {
      if (check.kind === 'custom') {
        const input = { url: cap.url, ok: cap.ok, status: cap.status, ms: cap.ms, headers: cap.headers, text: cap.text, json: cap.json, error: cap.error };
        const out = smRunCustom(check.code, input);
        if (out === null || typeof out !== 'object') return { state: 'error', value: '', error: 'предикат вернул не объект {status,…}' };
        const state = smNormStatus(out);
        if (!state) return { state: 'error', value: '', error: 'нет статуса: верните {status:"ok|warn|alert|info"} или {ok:true|false}' };
        const label = out.label != null ? String(out.label) : (out.value != null ? smFmtVal(out.value) : '');
        return { state, value: label, error: '' };
      }
      const spec = check.spec || {};
      const levelState = spec.level === 'warn' ? 'warn' : spec.level === 'info' ? 'info' : 'triggered';
      if (spec.cmp === 'up') {
        const ok = cap.ok && cap.status > 0 && cap.status < 400;
        return { state: ok ? 'ok' : 'triggered', value: cap.ok ? ('HTTP ' + cap.status + ' · ' + cap.ms + ' мс') : (cap.error || 'нет связи'), error: '' };
      }
      if (!cap.ok) return { state: 'error', value: '', error: cap.error || 'сайт недоступен' };
      const raw = smExtract(spec, cap);
      if (spec.cmp === 'changed') {
        const cur = smNorm(raw);
        if (check.baseline === undefined || check.baseline === null) { if (mutate) check.baseline = cur; return { state: 'ok', value: 'эталон: ' + smFmtVal(raw), error: '' }; }
        if (cur !== check.baseline) { const was = check.baseline; if (mutate) check.baseline = cur; return { state: levelState, value: smFmtShort(was) + ' → ' + smFmtVal(raw), error: '', changed: true }; }
        return { state: 'ok', value: smFmtVal(raw), error: '' };
      }
      const ok = smCompare(raw, spec.cmp, spec.expected);
      return { state: ok ? 'ok' : levelState, value: smFmtVal(raw), error: '' };
    } catch (e) { return { state: 'error', value: '', error: String((e && e.message) || e) }; }
  }

  function smDayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function smBumpStats(check, state, ms) {
    const key = smDayKey(Date.now());
    check.stats = Array.isArray(check.stats) ? check.stats : [];
    let b = check.stats[check.stats.length - 1];
    if (!b || b.d !== key) { b = { d: key, total: 0, ok: 0, warn: 0, trig: 0, info: 0, err: 0, msSum: 0, msN: 0 }; check.stats.push(b); if (check.stats.length > 31) check.stats = check.stats.slice(-31); }
    b.total++;
    if (state === 'ok') b.ok++; else if (state === 'warn') b.warn++; else if (state === 'triggered') b.trig++; else if (state === 'info') b.info++; else if (state === 'error') b.err++;
    if (typeof ms === 'number' && ms > 0) { b.msSum += ms; b.msN++; }
  }

  function smNotify(target, check, kind) {
    try {
      if (Notification.isSupported && !Notification.isSupported()) return;
      const who = target.name || target.url;
      let title, body;
      if (kind === 'change') { title = '🔔 ' + check.title; body = who + ' · ' + (check.value || 'изменилось'); }
      else if (kind === 'triggered') { title = '🔴 ' + check.title; body = who + ' · ' + (check.error || check.value || 'тревога'); }
      else if (kind === 'warn') { title = '🟡 ' + check.title; body = who + ' · ' + (check.value || 'внимание'); }
      else { title = '✅ ' + check.title; body = who + ' · снова в норме'; }
      new Notification({ title, body, silent: false }).show();
    } catch (_) {}
  }

  function smCommit(target, check, ev, ms) {
    check.checkedAt = Date.now();
    smBumpStats(check, ev.state, ms);
    check.value = ev.value; check.error = ev.error || '';
    const prev = check.state || 'unknown';
    const raw = ev.state;
    let flip = false;
    if (ev.changed) { flip = true; check.pend = null; }
    else if (raw === prev) { check.pend = null; }
    else { const deb = Math.max(1, Number(check.debounce) || 1); if (!check.pend || check.pend.state !== raw) check.pend = { state: raw, n: 1 }; else check.pend.n++; if (check.pend.n >= deb) { flip = true; check.pend = null; } }
    const before = check.state;
    if (flip) check.state = raw;
    const hstate = ev.changed ? 'triggered' : (check.state || 'unknown');
    check.history = (check.history || []).concat({ t: check.checkedAt, s: hstate, v: (typeof ev.value === 'string' ? ev.value.slice(0, 60) : ev.value) }).slice(-SM_HISTORY);
    if (check.notify !== false) {
      const isChange = ev.changed || (check.kind === 'basic' && check.spec && check.spec.cmp === 'changed');
      const attention = (s) => s === 'triggered' || s === 'warn';
      if (ev.changed) smNotify(target, check, 'change');
      else if (!isChange && flip && before && before !== 'unknown') {
        if (attention(check.state)) smNotify(target, check, check.state);
        else if (check.state === 'ok' && attention(before)) smNotify(target, check, 'up');
      }
    }
  }

  async function smCheckTarget(target) {
    if (!target || target.checking) return; target.checking = true;
    const gen = target.gen || 0;
    let stale = false;
    try {
      if (target.checks && target.checks.length) {
        const cap = await smBuildCapture(target);
        stale = (target.gen || 0) !== gen;
        if (!stale) for (const check of target.checks) smCommit(target, check, smEvalCheck(check, cap, true), cap.ms);
      }
    } catch (_) {}
    target.checking = false;
    target.nextAt = stale ? 0 : Date.now() + smClampInt(target.intervalSec) * 1000;
    smPersist(); smBroadcast();
  }

  const smSid = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null);
  function smCheckPublic(c) { return { id: c.id, title: c.title, kind: c.kind, spec: c.spec, code: c.code, meta: c.meta, notify: c.notify !== false, debounce: c.debounce || 1, state: c.state || 'unknown', value: c.value, error: c.error, checkedAt: c.checkedAt, history: (c.history || []).slice(-SM_HISTORY), stats: (c.stats || []).slice(-31) }; }
  function smTargetPersist(t) { return { id: t.id, name: t.name, url: t.url, intervalSec: t.intervalSec, render: !!t.render, insecureTls: !!t.insecureTls, headers: t.headers || null, serverId: t.serverId || null, checks: (t.checks || []).map((c) => ({ id: c.id, title: c.title, kind: c.kind, spec: c.spec, code: c.code, meta: c.meta, notify: c.notify !== false, debounce: c.debounce || 1, state: c.state, value: c.value, error: c.error, baseline: c.baseline, checkedAt: c.checkedAt, history: (c.history || []).slice(-SM_HISTORY), stats: (c.stats || []).slice(-31) })) }; }
  function smPublic() { return smTargets.map((t) => ({ id: t.id, name: t.name, url: t.url, intervalSec: t.intervalSec, render: !!t.render, insecureTls: !!t.insecureTls, headers: t.headers || null, serverId: t.serverId || null, checks: (t.checks || []).map(smCheckPublic) })); }
  function smPersist() { try { writeStoreKey('siteMon', smTargets.map(smTargetPersist)); } catch (_) {} }
  function smBroadcast() {
    const p = smPublic();
    try { onSitesChanged(); } catch (_) {}
    sendTo(getMainWindow(), 'sitemon:update', p);
    for (const w of getModuleWindows()) sendTo(w, 'sitemon:update', p);
  }
  function smMigrateOld(s) {
    const url = smNormUrl(s.url) || String(s.url || '');
    const hist = Array.isArray(s.history) ? s.history.map((h) => ({ t: h.t, s: h.up ? 'ok' : 'triggered', v: h.ms })) : [];
    return { id: s.id || smNewId('t'), name: s.name, url, intervalSec: smClampInt(s.intervalSec), render: false, headers: null,
      checks: [{ id: smNewId('c'), title: 'Доступность', kind: 'basic', spec: { source: 'status', cmp: 'up' }, notify: true, debounce: 1, state: s.up === true ? 'ok' : s.up === false ? 'triggered' : 'unknown', value: s.up === true ? ('HTTP ' + (s.code || '')) : (s.error || ''), checkedAt: s.checkedAt, history: hist }],
      checking: false, nextAt: 0 };
  }
  function smLoad() {
    const raw = readStoreKey('siteMon');
    if (raw === undefined) appStore.markSnapshotBrokenIfReadFailed('siteMon');
    if (!Array.isArray(raw)) { smTargets = []; return; }
    smTargets = raw.map((x) => {
      if (x && Array.isArray(x.checks)) return { id: x.id || smNewId('t'), name: x.name, url: x.url, intervalSec: smClampInt(x.intervalSec), render: !!x.render, insecureTls: !!x.insecureTls, headers: x.headers || null, serverId: smSid(x.serverId), checks: x.checks.map((c) => Object.assign({}, c, { pend: null })), checking: false, nextAt: 0 };
      return smMigrateOld(x || {});
    });
  }

  function smSanitizeCheck(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'пустой чек' };
    const kind = c.kind === 'custom' ? 'custom' : 'basic';
    const title = String(c.title || '').trim().slice(0, 200) || (kind === 'custom' ? 'Кастомный чек' : 'Проверка');
    const base = { id: c.id || smNewId('c'), title, kind, notify: c.notify !== false, debounce: Math.max(1, Math.min(10, Number(c.debounce) || 1)), state: 'unknown', history: Array.isArray(c.history) ? c.history.slice(-SM_HISTORY) : [] };
    if (kind === 'custom') {
      const code = String(c.code || '').trim();
      if (!code) return { ok: false, error: 'пустой код предиката' };
      if (code.length > 20000) return { ok: false, error: 'слишком длинный код предиката' };
      return { ok: true, check: Object.assign(base, { code, meta: (c.meta && typeof c.meta === 'object') ? c.meta : {} }) };
    }
    const spec = (c.spec && typeof c.spec === 'object') ? c.spec : {};
    const cmp = String(spec.cmp || 'up');
    if (cmp !== 'up' && !spec.source) return { ok: false, error: 'не задан источник значения' };
    const level = (spec.level === 'warn' || spec.level === 'info') ? spec.level : 'alert';
    return { ok: true, check: Object.assign(base, { spec: { source: String(spec.source || 'status'), cmp, path: spec.path != null ? String(spec.path) : '', expected: spec.expected != null ? String(spec.expected) : '', level } }) };
  }

  ipcMain.handle('sitemon:list', () => smPublic());
  ipcMain.handle('sitemon:addTarget', (_e, { name, url, intervalSec, render, insecureTls, headers, serverId } = {}) => {
    const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' };
    const t = { id: smNewId('t'), name: String(name || '').trim() || new URL(u).hostname, url: u, intervalSec: smClampInt(intervalSec), render: !!render, insecureTls: !!insecureTls, headers: smCleanHeaders(headers), serverId: smSid(serverId),
      checks: [{ id: smNewId('c'), title: 'Доступность', kind: 'basic', spec: { source: 'status', cmp: 'up' }, notify: true, debounce: 1, state: 'unknown', history: [] }], checking: false, nextAt: 0 };
    smTargets.push(t); smPersist(); smBroadcast(); smCheckTarget(t);
    return { ok: true, id: t.id };
  });
  ipcMain.handle('sitemon:editTarget', (_e, { id, name, url, intervalSec, render, insecureTls, headers, serverId } = {}) => {
    const t = smTargets.find((x) => x.id === id); if (!t) return { ok: false, error: 'нет цели' };
    if (name != null) t.name = String(name).trim() || t.name;
    if (url != null) { const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' }; t.url = u; }
    if (intervalSec != null) t.intervalSec = smClampInt(intervalSec);
    if (render != null) t.render = !!render;
    if (insecureTls != null) t.insecureTls = !!insecureTls;
    if (headers !== undefined) t.headers = smCleanHeaders(headers);
    if (serverId !== undefined) t.serverId = smSid(serverId);
    t.gen = (t.gen || 0) + 1; t.nextAt = 0; smPersist(); smBroadcast(); smCheckTarget(t); return { ok: true };
  });
  ipcMain.handle('sitemon:removeTarget', (_e, { id } = {}) => { smTargets = smTargets.filter((x) => x.id !== id); smPersist(); smBroadcast(); return { ok: true }; });
  ipcMain.handle('sitemon:addCheck', (_e, { targetId, check } = {}) => {
    const t = smTargets.find((x) => x.id === targetId); if (!t) return { ok: false, error: 'нет цели' };
    const san = smSanitizeCheck(check); if (!san.ok) return { ok: false, error: san.error };
    t.checks = t.checks || []; t.checks.push(san.check); t.gen = (t.gen || 0) + 1; t.nextAt = 0; smPersist(); smBroadcast(); smCheckTarget(t);
    return { ok: true, id: san.check.id };
  });
  ipcMain.handle('sitemon:editCheck', (_e, { targetId, checkId, patch } = {}) => {
    const t = smTargets.find((x) => x.id === targetId); if (!t) return { ok: false, error: 'нет цели' };
    const c = (t.checks || []).find((x) => x.id === checkId); if (!c) return { ok: false, error: 'нет чека' };
    if (patch && typeof patch === 'object') {
      if (patch.title != null) c.title = String(patch.title).trim().slice(0, 200) || c.title;
      if (patch.spec && c.kind === 'basic') c.spec = { source: String(patch.spec.source || 'status'), cmp: String(patch.spec.cmp || 'up'), path: patch.spec.path != null ? String(patch.spec.path) : '', expected: patch.spec.expected != null ? String(patch.spec.expected) : '', level: (patch.spec.level === 'warn' || patch.spec.level === 'info') ? patch.spec.level : 'alert' };
      if (patch.code != null && c.kind === 'custom') c.code = String(patch.code);
      if (patch.meta) c.meta = patch.meta;
      if (patch.notify != null) c.notify = !!patch.notify;
      if (patch.debounce != null) c.debounce = Math.max(1, Math.min(10, Number(patch.debounce) || 1));
      c.state = 'unknown'; c.baseline = undefined; c.pend = null; c.error = ''; c.value = undefined;
      t.gen = (t.gen || 0) + 1;
    }
    t.nextAt = 0; smPersist(); smBroadcast(); smCheckTarget(t); return { ok: true };
  });
  ipcMain.handle('sitemon:removeCheck', (_e, { targetId, checkId } = {}) => {
    const t = smTargets.find((x) => x.id === targetId); if (!t) return { ok: false, error: 'нет цели' };
    t.checks = (t.checks || []).filter((x) => x.id !== checkId); smPersist(); smBroadcast(); return { ok: true };
  });
  ipcMain.handle('sitemon:checkNow', (_e, { id } = {}) => {
    if (id) { const t = smTargets.find((x) => x.id === id); if (t) { t.nextAt = 0; smCheckTarget(t); } }
    else { for (const t of smTargets) { t.nextAt = 0; smCheckTarget(t); } }
    return { ok: true };
  });
  ipcMain.handle('sitemon:sample', async (_e, { url, headers, render, insecureTls } = {}) => {
    const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' };
    const res = await smFetch(u, { headers: smCleanHeaders(headers), timeoutMs: 15000, insecureTls: !!insecureTls });
    if (!res.ok) return { ok: false, error: res.error || 'нет связи' };
    const body = res.body || '';
    const ctype = String((res.headers && res.headers['content-type']) || '').toLowerCase();
    /** @type {any} */
    const out = { ok: true, status: res.status, headers: res.headers, bytes: res.bytes, capped: !!res.capped, ctype, body, bodyTrunc: !!res.capped, isJson: false, kind: 'text' };
    try { out.json = JSON.parse(body); out.isJson = true; out.kind = 'json'; }
    catch (_) { out.kind = (ctype.includes('html') || /^\s*<(?:!doctype|html|\?xml|body|head)/i.test(body)) ? 'html' : 'text'; }
    if (render) { const dom = await smRenderCapture(u, [], 15000); if (dom && !dom.error) { out.renderedText = dom.text || ''; out.rendered = true; } else if (dom) out.renderError = dom.error; }
    return out;
  });
  ipcMain.handle('sitemon:dryRun', async (_e, { url, headers, render, insecureTls, check } = {}) => {
    const u = smNormUrl(url); if (!u) return { ok: false, error: 'Некорректный URL' };
    const san = smSanitizeCheck(check); if (!san.ok) return { ok: false, error: san.error };
    try {
      const cap = await smBuildCapture({ url: u, headers: smCleanHeaders(headers), render: !!render, insecureTls: !!insecureTls, checks: [san.check] });
      const ev = smEvalCheck(Object.assign({}, san.check, { baseline: undefined }), cap, false);
      return { ok: true, state: ev.state, value: ev.value, error: ev.error, capStatus: cap.status, capOk: cap.ok, capError: cap.error, rendered: !!cap.rendered, renderError: cap.renderError };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  const smTimer = setInterval(() => { const now = Date.now(); for (const t of smTargets) if (!t.checking && (!t.nextAt || now >= t.nextAt)) smCheckTarget(t); }, 5000);
  if (smTimer.unref) smTimer.unref();
  smLoad();
  setTimeout(() => { for (const t of smTargets) smCheckTarget(t); }, 3000);

  return { getPublic: smPublic };
}

module.exports = { registerSitemonIpc };
