// Доменный модуль «WEB/SEO аудит» (HTTP/TLS/DNS/WHOIS/DOM-рендер в изолированной сессии BrowserWindow).

'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const SEO_HANDLES = ['seo:scan', 'seo:render', 'seo:links', 'seo:devServers', 'seo:export'];

const SEO_TIMEOUT = 12000;
const SEO_BODY_CAP = 3 * 1024 * 1024;
const SEO_MAX_REDIRECTS = 6;
const SEO_DEV_PORTS = [3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];
const SEO_LINKS_MAX = 60;
const SEO_RENDER_TIMEOUT = 20000;
const SEO_PARTITION = 'seo-audit';

const SEO_DOM_SCRIPT = `(async () => {
  const q = (s) => document.querySelector(s);
  const meta = (s) => { const e = q(s); return e ? (e.getAttribute('content') || '').trim() : null; };
  const hs = {}; for (let i = 1; i <= 6; i++) hs['h' + i] = [...document.querySelectorAll('h' + i)].map(e => (e.textContent || '').trim().slice(0, 80)).slice(0, 40);
  const loc = location.origin, internal = [], external = [];
  for (const el of document.querySelectorAll('a[href]')) { let href; try { href = new URL(el.getAttribute('href'), location.href).href; } catch { continue; } if (!/^https?:/.test(href)) continue; (href.startsWith(loc) ? internal : external).push(href.split('#')[0]); }
  const imgs = [...document.querySelectorAll('img')].map(im => ({ alt: im.getAttribute('alt'), w: im.getAttribute('width'), h: im.getAttribute('height'), lazy: im.getAttribute('loading') === 'lazy' }));
  const og = {}; for (const m of document.querySelectorAll('meta[property^="og:"]')) og[m.getAttribute('property').slice(3)] = m.getAttribute('content');
  const tw = {}; for (const m of document.querySelectorAll('meta[name^="twitter:"]')) tw[m.getAttribute('name').slice(8)] = m.getAttribute('content');
  const tech = []; const W = window; const add = (n) => { if (n && !tech.includes(n)) tech.push(n); };
  if (W.React || document.querySelector('[data-reactroot]')) add('React');
  if (W.__NEXT_DATA__) add('Next.js'); if (W.__NUXT__) add('Nuxt'); if (W.__remixContext) add('Remix');
  if (W.Vue || document.querySelector('[data-v-app]')) add('Vue');
  if (document.querySelector('[ng-version]')) add('Angular'); if (document.querySelector('[data-svelte-h]')) add('Svelte');
  if (W.jQuery) add('jQuery' + (W.jQuery.fn && W.jQuery.fn.jquery ? ' ' + W.jQuery.fn.jquery : ''));
  if (W.gtag || W.dataLayer) add('Google Analytics/GTM'); if (W.ym || W.Ya) add('Яндекс.Метрика');
  const gen = meta('meta[name="generator"]'); if (gen) add(gen);
  const srcs = [...document.scripts].map(s => s.src).join(' ');
  if (/wp-content|wp-includes/.test(srcs)) add('WordPress'); if (/tilda/.test(srcs)) add('Tilda'); if (/bitrix/i.test(srcs)) add('1C-Bitrix'); if (/cdn\\.shopify/.test(srcs)) add('Shopify');
  let lcp = 0, cls = 0;
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  await new Promise(r => setTimeout(r, 450));
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = (performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint') || {}).startTime || 0;
  const perf = { ttfb: Math.round(nav.responseStart || 0), fcp: Math.round(fcp), dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0), lcp: Math.round(lcp), cls: Math.round(cls * 1000) / 1000, domNodes: document.getElementsByTagName('*').length };
  return {
    title: (q('title') && q('title').textContent.trim()) || null,
    description: meta('meta[name="description"]'), canonical: (q('link[rel="canonical"]') && q('link[rel="canonical"]').getAttribute('href')) || null,
    viewport: meta('meta[name="viewport"]'), robotsMeta: meta('meta[name="robots"]'), lang: document.documentElement.getAttribute('lang') || null,
    h: hs, h1Count: hs.h1.length, links: { internal: [...new Set(internal)].slice(0, 250), external: [...new Set(external)].slice(0, 250) },
    imgCount: imgs.length, imgNoAlt: imgs.filter(i => i.alt == null).length, imgNoDim: imgs.filter(i => !i.w || !i.h).length, imgNoLazy: imgs.filter(i => !i.lazy).length,
    og, twitter: tw, hasJsonLd: !!document.querySelector('script[type="application/ld+json"]'), textLen: ((document.body && document.body.innerText) || '').length, tech, perf,
  };
})()`;

function seoIsLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i.test(host) || /\.local$/i.test(host);
}
function seoNormalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    const host = s.split('/')[0];
    s = (seoIsLocalHost(host.split(':')[0]) ? 'http://' : 'https://') + s;
  }
  try { return new URL(s); } catch { return null; }
}

/**
 * @param {URL} u
 * @param {string} [method]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function seoRequestOnce(u, method, timeoutMs) {
  const to = timeoutMs || SEO_TIMEOUT;
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    /** @type {import('http').ClientRequest} */
    let req;
    try {
      req = mod.request(u, {
        method: method || 'GET',
        rejectUnauthorized: false,
        headers: { 'User-Agent': 'LiteEditor-Audit/1.0', 'Accept': 'text/html,*/*' },
        timeout: to,
      }, (res) => {
        const chunks = []; let len = 0;
        const done = () => resolve({
          ok: true, status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0, bytes: len,
        });
        res.on('data', (c) => {
          if (len >= SEO_BODY_CAP) return;
          chunks.push(c); len += c.length;
          if (len >= SEO_BODY_CAP) { done(); req.destroy(); }
        });
        res.on('end', done);
        res.on('close', () => { if (!res.complete) resolve({ ok: false, error: 'соединение прервано' }); });
      });
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); return; }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'таймаут (' + to + ' мс)' }); });
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    req.end();
  });
}

async function seoFetchChain(start) {
  const redirects = [];
  let u = start;
  for (let i = 0; i <= SEO_MAX_REDIRECTS; i++) {
    const r = await seoRequestOnce(u, 'GET');
    if (!r.ok) return { ...r, finalUrl: u.href, redirects };
    const loc = r.headers && r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      if (i >= SEO_MAX_REDIRECTS) break;
      let next; try { next = new URL(loc, u); } catch { return { ...r, finalUrl: u.href, redirects }; }
      if (!/^https?:$/.test(next.protocol)) return { ok: false, error: `редирект на неподдерживаемый адрес: ${next.href.slice(0, 200)}`, finalUrl: u.href, redirects };
      redirects.push({ from: u.href, status: r.status, to: next.href });
      u = next; continue;
    }
    return { ...r, finalUrl: u.href, redirects };
  }
  return { ok: false, error: 'слишком много редиректов', finalUrl: u.href, redirects };
}

function seoMatch(re, html) { const m = re.exec(html); return m ? (m[1] || '').trim() : null; }
function seoMetaContent(html, nameAttr, val) {
  const re = new RegExp('<meta[^>]*' + nameAttr + '\\s*=\\s*["\']' + val + '["\'][^>]*>', 'i');
  const tag = seoMatch(new RegExp('(' + re.source + ')', 'i'), html);
  if (!tag) return null;
  return seoMatch(/content\s*=\s*["']([^"']*)["']/i, tag);
}
function seoParseHtml(html) {
  html = String(html || '');
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html])[0];
  /** @type {Record<string, string>} */
  const ogs = {};
  const ogRe = /<meta[^>]*property\s*=\s*["']og:([a-z]+)["'][^>]*content\s*=\s*["']([^"']*)["']/gi;
  let m; while ((m = ogRe.exec(head))) ogs[m[1]] = m[2];
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  const imgs = (html.match(/<img\b[^>]*>/gi) || []);
  const imgsNoAlt = imgs.filter((t) => !/\balt\s*=/i.test(t)).length;
  return {
    title: seoMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, head),
    description: seoMetaContent(head, 'name', 'description'),
    keywords: seoMetaContent(head, 'name', 'keywords'),
    robotsMeta: seoMetaContent(head, 'name', 'robots'),
    canonical: (() => { const t = seoMatch(/(<link[^>]*rel\s*=\s*["']canonical["'][^>]*>)/i, head); return t ? seoMatch(/href\s*=\s*["']([^"']*)["']/i, t) : null; })(),
    viewport: seoMetaContent(head, 'name', 'viewport'),
    charset: seoMatch(/<meta[^>]*charset\s*=\s*["']?([\w-]+)/i, head),
    lang: seoMatch(/<html[^>]*\blang\s*=\s*["']([^"']*)["']/i, html),
    h1Count: h1,
    imgCount: imgs.length,
    imgNoAlt: imgsNoAlt,
    og: ogs,
    hasJsonLd: /<script[^>]*type\s*=\s*["']application\/ld\+json["']/i.test(head),
    /** @type {any[]} */
    issues: [],
  };
}

/**
 * @param {URL} u
 * @returns {Promise<any>}
 */
function seoTls(u) {
  return new Promise((resolve) => {
    const port = u.port ? Number(u.port) : 443;
    const socket = tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false, timeout: SEO_TIMEOUT }, () => {
      const c = socket.getPeerCertificate(true);
      const proto = socket.getProtocol();
      const cipher = socket.getCipher() || /** @type {{ name?: string }} */ ({});
      const authorized = socket.authorized;
      const authError = socket.authorizationError ? String(socket.authorizationError) : '';
      socket.end();
      if (!c || !c.valid_to) { resolve({ ok: false, error: 'сертификат не получен' }); return; }
      const to = new Date(c.valid_to).getTime();
      const daysLeft = Math.round((to - Date.now()) / 86400000);
      const san = (c.subjectaltname || '').split(',').map((s) => s.replace(/^\s*DNS:/, '').trim()).filter(Boolean);
      const chain = []; let cur = c; const seen = new Set();
      while (cur && cur.subject && !seen.has(cur.fingerprint)) { seen.add(cur.fingerprint); chain.push(((cur.subject && cur.subject.CN) || (cur.issuer && cur.issuer.O) || '?')); cur = cur.issuerCertificate; if (chain.length > 8) break; }
      resolve({
        ok: true, protocol: proto, cipher: cipher.name || '', authorized, authError,
        subject: (c.subject && c.subject.CN) || '', issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '',
        validFrom: c.valid_from, validTo: c.valid_to, daysLeft, san: san.slice(0, 20), chain,
      });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'таймаут TLS' }); });
    socket.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  });
}

async function seoDns(host) {
  /** @type {any} */
  const r = { a: [], aaaa: [], mx: [], ns: [], txt: [], caa: [] };
  const safe = async (fn, key, map) => { try { const v = await fn(); r[key] = map ? v.map(map) : v; } catch {} };
  await Promise.all([
    safe(() => dns.promises.resolve4(host), 'a'),
    safe(() => dns.promises.resolve6(host), 'aaaa'),
    safe(() => dns.promises.resolveMx(host), 'mx', (x) => x.exchange + ' (' + x.priority + ')'),
    safe(() => dns.promises.resolveNs(host), 'ns'),
    safe(() => dns.promises.resolveCaa(host), 'caa', (x) => JSON.stringify(x)),
  ]);
  /** @type {string[][]} */
  let txt = []; try { txt = await dns.promises.resolveTxt(host); } catch {}
  r.txt = txt.map((parts) => parts.join('')).slice(0, 30);
  const spf = r.txt.find((t) => /^v=spf1/i.test(t)) || null;
  let dmarc = null;
  try { const d = await dns.promises.resolveTxt('_dmarc.' + host); dmarc = d.map((p) => p.join('')).find((t) => /^v=DMARC1/i.test(t)) || null; } catch {}
  r.mail = {
    spf: { found: !!spf, value: spf || '' },
    dmarc: { found: !!dmarc, value: dmarc || '', policy: dmarc ? (/(p=[a-z]+)/i.exec(dmarc) || ['', ''])[1] : '' },
  };
  return r;
}

async function seoProbeFile(origin, pth) {
  let u; try { u = new URL(pth, origin); } catch { return { found: false }; }
  const r = await seoRequestOnce(u, 'GET');
  if (!r.ok) return { found: false, error: r.error };
  return { found: r.status === 200, status: r.status, bytes: r.bytes || (r.body ? r.body.length : 0), sample: (r.body || '').slice(0, 400) };
}

function seoSecurityHeaders(headers, isHttps) {
  const h = headers || {};
  const get = (k) => h[k] != null ? String(h[k]) : null;
  const rows = [];
  const add = (key, label, value, sev, advice) => rows.push({ key, label, value: value || '', present: !!value, sev, advice });
  add('csp', 'Content-Security-Policy', get('content-security-policy'),
    get('content-security-policy') ? 'ok' : 'warn', 'Защита от XSS/инъекций. Задайте политику источников скриптов и стилей.');
  add('hsts', 'Strict-Transport-Security (HSTS)', get('strict-transport-security'),
    !isHttps ? 'info' : (get('strict-transport-security') ? 'ok' : 'warn'),
    isHttps ? 'Принуждает браузер к HTTPS. Добавьте max-age ≥ 15552000; includeSubDomains.' : 'Актуально только для HTTPS.');
  add('xfo', 'X-Frame-Options', get('x-frame-options'),
    get('x-frame-options') || /frame-ancestors/i.test(get('content-security-policy') || '') ? 'ok' : 'warn',
    'Защита от кликджекинга. Поставьте SAMEORIGIN или frame-ancestors в CSP.');
  add('xcto', 'X-Content-Type-Options', get('x-content-type-options'),
    /nosniff/i.test(get('x-content-type-options') || '') ? 'ok' : 'warn', 'Поставьте nosniff — отключает MIME-sniffing.');
  add('refpol', 'Referrer-Policy', get('referrer-policy'),
    get('referrer-policy') ? 'ok' : 'info', 'Контролирует утечку Referer. Рекомендуется strict-origin-when-cross-origin.');
  add('permpol', 'Permissions-Policy', get('permissions-policy'),
    get('permissions-policy') ? 'ok' : 'info', 'Ограничивает доступ к камере/гео/микрофону и т.п.');
  return rows;
}

function seoCookies(headers) {
  let sc = headers && headers['set-cookie'];
  if (!sc) return [];
  if (!Array.isArray(sc)) sc = [sc];
  return sc.slice(0, 40).map((line) => {
    const name = (line.split('=')[0] || '').trim();
    return {
      name, secure: /;\s*secure/i.test(line), httpOnly: /;\s*httponly/i.test(line),
      sameSite: (/;\s*samesite\s*=\s*(\w+)/i.exec(line) || ['', ''])[1],
    };
  });
}

function seoIssues(seo) {
  const out = [];
  if (!seo.title) out.push({ sev: 'crit', title: 'Нет <title>', advice: 'Добавьте заголовок страницы — ключевой SEO-сигнал.' });
  else if (seo.title.length < 10 || seo.title.length > 65) out.push({ sev: 'warn', title: 'Длина <title> = ' + seo.title.length, advice: 'Оптимально 10–65 символов.' });
  if (!seo.description) out.push({ sev: 'warn', title: 'Нет meta description', advice: 'Добавьте описание 50–160 символов — попадает в сниппет выдачи.' });
  else if (seo.description.length < 50 || seo.description.length > 160) out.push({ sev: 'info', title: 'Длина description = ' + seo.description.length, advice: 'Оптимально 50–160 символов.' });
  if (!seo.canonical) out.push({ sev: 'info', title: 'Нет canonical', advice: 'Укажите canonical, чтобы избежать дублей.' });
  if (!seo.viewport) out.push({ sev: 'warn', title: 'Нет viewport', advice: 'Без него страница не адаптивна на мобильных.' });
  if (!seo.lang) out.push({ sev: 'info', title: 'Нет lang у <html>', advice: 'Укажите язык — важно для доступности и поиска.' });
  if (seo.h1Count === 0) out.push({ sev: 'warn', title: 'Нет <h1>', advice: 'Добавьте один главный заголовок H1.' });
  else if (seo.h1Count > 1) out.push({ sev: 'info', title: seo.h1Count + ' тегов <h1>', advice: 'Обычно на странице один H1.' });
  if (seo.imgNoAlt > 0) out.push({ sev: 'info', title: seo.imgNoAlt + ' картинок без alt', advice: 'Добавьте alt — доступность и image-SEO.' });
  if (!seo.og || !seo.og.title) out.push({ sev: 'info', title: 'Нет OpenGraph', advice: 'og:title/description/image улучшают превью в соцсетях.' });
  return out;
}

function seoScore(findings) {
  let s = 100;
  for (const f of findings) s -= (f.sev === 'crit' ? 25 : f.sev === 'warn' ? 10 : f.sev === 'info' ? 3 : 0);
  return Math.max(0, Math.min(100, s));
}

function seoWhoisQuery(server, query) {
  return new Promise((resolve) => {
    let data = '';
    const s = net.connect(43, server);
    s.setTimeout(8000);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(query + '\r\n'));
    s.on('data', (d) => { data += d; if (data.length > 200000) s.destroy(); });
    s.on('end', () => resolve(data));
    s.on('close', () => resolve(data));
    s.on('timeout', () => { s.destroy(); resolve(data); });
    s.on('error', () => resolve(data || null));
  });
}

async function seoWhois(host) {
  const labels = host.split('.');
  const domain = labels.length > 2 ? labels.slice(-2).join('.') : host;
  try {
    const ref = await seoWhoisQuery('whois.iana.org', domain);
    let raw = ref || '';
    const m = /refer:\s*(\S+)/i.exec(raw);
    if (m) { const r2 = await seoWhoisQuery(m[1].trim(), domain); if (r2) raw = r2; }
    if (!raw) return null;
    const g = (re) => { const x = re.exec(raw); return x ? x[1].trim() : null; };
    return {
      domain,
      registrar: g(/Registrar:\s*(.+)/i),
      created: g(/(?:Creation Date|created|Registered on):\s*(.+)/i),
      expires: g(/(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date|paid-till|Expiration Date):\s*(.+)/i),
      ns: [...raw.matchAll(/Name Server:\s*(\S+)/ig)].map((x) => x[1].toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6),
    };
  } catch { return null; }
}

async function seoGeo(host) {
  let ip; try { const ips = await dns.promises.resolve4(host); ip = ips[0]; } catch { return null; }
  if (!ip) return null;
  return new Promise((resolve) => {
    const req = http.get('http://ip-api.com/json/' + ip + '?fields=status,country,city,isp,org,as,query', { timeout: 6000 }, (r) => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', (c) => { d += c; if (d.length > 65536) { req.destroy(); resolve(null); } });
      r.on('end', () => { try { const j = JSON.parse(d); resolve(j.status === 'success' ? j : null); } catch { resolve(null); } });
      r.on('close', () => { if (!r.complete) resolve(null); });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function seoCheckLinks(urls, base) {
  const uniq = [...new Set(urls)].filter(Boolean).slice(0, SEO_LINKS_MAX);
  const broken = []; let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const idx = i++; let lu; try { lu = new URL(uniq[idx], base); } catch { continue; }
      if (!/^https?:$/.test(lu.protocol)) continue;
      const r = await seoRequestOnce(lu, 'HEAD', 6000);
      let status = r.ok ? r.status : 0;
      if (r.ok && (status === 405 || status === 501)) { const g = await seoRequestOnce(lu, 'GET', 6000); status = g.ok ? g.status : 0; }
      const ok = status >= 200 && status < 400;
      if (!ok) broken.push({ url: lu.href, status: r.ok ? status : ('ошибка: ' + r.error) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, uniq.length || 1) }, worker));
  return { checked: uniq.length, broken: broken.slice(0, 40) };
}

function seoWithTimeout(p, ms, fallback) {
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

/**
 * @param {object} deps
 * @param {{ handle: Function, on: Function }} deps.ipcMain
 * @param {any} deps.BrowserWindow
 * @param {any} deps.dialog
 * @param {(file: string, data: string | Buffer) => void} deps.atomicWriteSync
 * @param {(e: any) => any} deps.senderWin
 * @param {() => any} deps.getMainWindow
 */
function registerSeoIpc({ ipcMain, BrowserWindow, dialog, atomicWriteSync, senderWin, getMainWindow }) {
  let seoSessionHardened = false;
  function seoHardenSession(ses) {
    if (seoSessionHardened) return;
    seoSessionHardened = true;
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
  }

  ipcMain.handle('seo:scan', async (_e, { url }) => {
    const u = seoNormalizeUrl(url);
    if (!u) return { error: 'Некорректный адрес' };
    const local = seoIsLocalHost(u.hostname);
    /** @type {any} */
    const out = { url: u.href, host: u.hostname, scheme: u.protocol.replace(':', ''), local, scannedAt: new Date().toISOString() };

    const fetched = await seoFetchChain(u);
    out.fetch = fetched.ok
      ? { ok: true, status: fetched.status, finalUrl: fetched.finalUrl, server: fetched.headers['server'] || '', contentType: fetched.headers['content-type'] || '', bytes: fetched.bytes, ms: fetched.ms, redirects: fetched.redirects }
      : { ok: false, error: fetched.error, redirects: fetched.redirects || [] };
    if (!fetched.ok) return out;

    const headers = fetched.headers;
    out.headers = headers;
    const isHttps = new URL(fetched.finalUrl).protocol === 'https:';
    out.security = seoSecurityHeaders(headers, isHttps);
    out.cookies = seoCookies(headers);
    out.seo = seoParseHtml(fetched.body);
    out.seo.issues = seoIssues(out.seo);

    const origin = new URL(fetched.finalUrl).origin;
    const [robots, sitemap, secTxt, gitHead, envFile] = await Promise.all([
      seoProbeFile(origin, '/robots.txt'), seoProbeFile(origin, '/sitemap.xml'), seoProbeFile(origin, '/.well-known/security.txt'),
      seoProbeFile(origin, '/.git/HEAD'), seoProbeFile(origin, '/.env'),
    ]);
    out.files = { robots, sitemap, securityTxt: secTxt };
    out.exposed = {
      git: gitHead.found && /^ref:|^[0-9a-f]{40}/i.test(gitHead.sample || ''),
      env: envFile.found && /[A-Z_]+\s*=/.test(envFile.sample || ''),
    };

    if (isHttps) { try { out.tls = await seoTls(new URL(fetched.finalUrl)); } catch (e) { out.tls = { ok: false, error: String(e) }; } }
    if (!local) {
      try { out.dns = await seoDns(u.hostname); } catch (e) { out.dns = { error: String(e) }; }
      [out.whois, out.geo] = await Promise.all([
        seoWhois(u.hostname).catch(() => null),
        seoGeo(u.hostname).catch(() => null),
      ]);
    }

    const findings = [];
    for (const s of out.security) if (s.sev === 'crit' || s.sev === 'warn') findings.push({ cat: 'Безопасность', sev: s.sev, title: s.label + ' — отсутствует', advice: s.advice });
    for (const c of out.cookies) if (isHttps && !c.secure) findings.push({ cat: 'Безопасность', sev: 'info', title: 'Кука ' + c.name + ' без Secure', advice: 'На HTTPS все куки должны быть Secure.' });
    if (out.tls && out.tls.ok && out.tls.daysLeft < 21) findings.push({ cat: 'Безопасность', sev: out.tls.daysLeft < 0 ? 'crit' : 'warn', title: 'Сертификат: ' + out.tls.daysLeft + ' дн до истечения', advice: 'Обновите TLS-сертификат.' });
    if (out.exposed.git) findings.push({ cat: 'Безопасность', sev: 'crit', title: 'Открыт каталог .git/', advice: 'Доступ к /.git/ позволяет выкачать исходники. Закройте на уровне веб-сервера.' });
    if (out.exposed.env) findings.push({ cat: 'Безопасность', sev: 'crit', title: 'Открыт файл .env', advice: 'В /.env обычно ключи и пароли. Немедленно закройте доступ и смените секреты.' });
    { const leak = String(headers['x-powered-by'] || '') + ' ' + String(headers['server'] || ''); if (/[\d]+\.[\d]+/.test(leak)) findings.push({ cat: 'Безопасность', sev: 'info', title: 'Утечка версии ПО в заголовках', advice: 'Скройте версии в Server/X-Powered-By (' + leak.trim() + ').' }); }
    if (!out.files.robots.found) findings.push({ cat: 'SEO', sev: 'info', title: 'Нет robots.txt', advice: 'Добавьте robots.txt с ссылкой на sitemap.' });
    if (!out.files.sitemap.found) findings.push({ cat: 'SEO', sev: 'info', title: 'Нет sitemap.xml', advice: 'Добавьте карту сайта для индексации.' });
    for (const i of out.seo.issues) findings.push({ cat: 'SEO', sev: i.sev, title: i.title, advice: i.advice });
    if (out.dns && out.dns.mail) {
      if (!out.dns.mail.spf.found) findings.push({ cat: 'Почта', sev: 'info', title: 'Нет SPF-записи', advice: 'Добавьте TXT v=spf1 — защита от подделки писем.' });
      if (!out.dns.mail.dmarc.found) findings.push({ cat: 'Почта', sev: 'info', title: 'Нет DMARC-записи', advice: 'Добавьте _dmarc TXT v=DMARC1.' });
    }
    out.findings = findings;
    out.scores = {
      security: seoScore(findings.filter((f) => f.cat === 'Безопасность')),
      seo: seoScore(findings.filter((f) => f.cat === 'SEO')),
    };
    return out;
  });

  ipcMain.handle('seo:render', async (_e, { url }) => {
    const u = seoNormalizeUrl(url);
    if (!u) return { ok: false, error: 'Некорректный адрес' };
    /** @type {any} */
    let win = null;
    /** @type {any} */
    const network = { requests: 0, bytes: 0, byType: {}, uncompressed: 0, thirdParty: 0, heavy: [], mixed: 0 };
    const consoleMsgs = [];
    try {
      win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: SEO_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, images: true, disableDialogs: true } });
      const wc = win.webContents;
      seoHardenSession(wc.session);
      wc.setAudioMuted(true);
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e, navUrl) => { if (!/^https?:/i.test(navUrl)) e.preventDefault(); });
      wc.on('console-message', (e) => { const message = e.message; const level = e.level === 'error' ? 3 : e.level === 'warning' ? 2 : 0; if (level >= 2 && consoleMsgs.length < 30) consoleMsgs.push({ level, text: String(message).slice(0, 300) }); if (/Mixed Content/i.test(message)) network.mixed++; });

      let dbg = false; const reqInfo = new Map();
      try {
        wc.debugger.attach('1.3'); dbg = true;
        wc.debugger.on('message', (_ev, method, params) => {
          if (method === 'Network.responseReceived') {
            const r = params.response || {};
            const hh = r.headers || {};
            reqInfo.set(params.requestId, { type: params.type, mime: r.mimeType || '', url: r.url || '', enc: hh['content-encoding'] || hh['Content-Encoding'] || '' });
          } else if (method === 'Network.loadingFinished') {
            const info = reqInfo.get(params.requestId) || {}; const size = params.encodedDataLength || 0;
            network.requests++; network.bytes += size;
            const t = info.type || 'Other'; network.byType[t] = (network.byType[t] || 0) + size;
            if (!info.enc && size > 2048 && /text|javascript|json|css|html|svg|xml/i.test(info.mime)) network.uncompressed += size;
            try { if (info.url) { const h = new URL(info.url).host; if (h && h !== u.host) network.thirdParty++; } } catch (_) {}
            if (size > 150 * 1024 && info.url) network.heavy.push({ url: info.url, bytes: size, type: t });
          }
        });
        await wc.debugger.sendCommand('Network.enable');
      } catch (_) {}

      const loaded = new Promise((res) => { wc.once('did-finish-load', () => res({ ok: true })); wc.on('did-fail-load', (_e2, code, desc, _u, isMainFrame) => { if (isMainFrame) res({ fail: desc || String(code) }); }); });
      const timer = new Promise((res) => setTimeout(() => res({ timeout: true }), SEO_RENDER_TIMEOUT));
      win.loadURL(u.href).catch(() => {});
      const loadRes = await Promise.race([loaded, timer]);
      await new Promise((r) => setTimeout(r, 400));

      const dom = await seoWithTimeout(
        wc.executeJavaScript(SEO_DOM_SCRIPT, true).catch((e) => ({ error: String((e && e.message) || e) })),
        8000, { error: 'таймаут извлечения DOM' });

      let shotDesktop = null, shotMobile = null;
      try { const img = await seoWithTimeout(wc.capturePage(), 6000, null); if (img && !img.isEmpty()) shotDesktop = img.resize({ width: 520 }).toDataURL(); } catch (_) {}
      try {
        if (dbg) {
          await seoWithTimeout(wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }), 3000, null);
          await new Promise((r) => setTimeout(r, 300));
          const img2 = await seoWithTimeout(wc.capturePage(), 6000, null); if (img2 && !img2.isEmpty()) shotMobile = img2.resize({ width: 280 }).toDataURL();
          await seoWithTimeout(wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'), 3000, null);
        }
      } catch (_) {}

      network.heavy.sort((a, b) => b.bytes - a.bytes); network.heavy = network.heavy.slice(0, 12);

      try { if (dbg) wc.debugger.detach(); } catch (_) {}
      if (loadRes && loadRes.fail && network.requests === 0 && (!dom || (!dom.title && (!dom.perf || !dom.perf.domNodes)))) {
        return { ok: false, error: 'страница не загрузилась: ' + loadRes.fail };
      }
      return { ok: true, url: u.href, dom, perf: (dom && dom.perf) || null, network, console: consoleMsgs.slice(0, 30), screenshot: { desktop: shotDesktop, mobile: shotMobile }, loadResult: loadRes };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    }
  });

  ipcMain.handle('seo:links', async (_e, { urls, base }) => {
    let b; try { b = new URL(base); } catch { return { checked: 0, broken: [] }; }
    return seoCheckLinks(Array.isArray(urls) ? urls : [], b);
  });

  ipcMain.handle('seo:devServers', async () => {
    const tryHost = (host, port) => new Promise((resolve) => {
      const s = net.connect({ host, port, timeout: 350 }, () => { s.destroy(); resolve(true); });
      s.on('timeout', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
    });
    const probe = async (port) => ((await tryHost('127.0.0.1', port)) || (await tryHost('::1', port))) ? port : null;
    const open = (await Promise.all(SEO_DEV_PORTS.map(probe))).filter(Boolean);
    return { ports: open };
  });

  ipcMain.handle('seo:export', async (e, { content, defaultName }) => {
    try {
      const r = await dialog.showSaveDialog(senderWin(e) || getMainWindow(), {
        defaultPath: defaultName || 'seo-report.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'JSON', extensions: ['json'] }, { name: 'Все файлы', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      atomicWriteSync(r.filePath, String(content == null ? '' : content));
      return { ok: true, file: r.filePath };
    } catch (err) { return { error: String((err && err.message) || err) }; }
  });
}

module.exports = { registerSeoIpc, SEO_HANDLES };
