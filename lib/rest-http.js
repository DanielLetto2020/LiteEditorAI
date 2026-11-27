// Чистый HTTP/HTTPS/GraphQL-движок для модуля HTTP-клиента: тайминги, сжатие, 10 МБ лимит, safe redirects.
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { performance } = require('perf_hooks');

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function decodeCompressed(buf, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase().trim();
  if (!buf.length || !enc || enc === 'identity') return buf;
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) {
    // отдаём как есть, если сервер прислал битый/лживый Content-Encoding
  }
  return buf;
}

function singleRequestOnce(urlStr, opts, signal) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); }
    catch (err) { reject(new Error(`Некорректный URL: ${urlStr}`, { cause: err })); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Неподдерживаемая схема: ${parsed.protocol}`));
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    let tLookup = t0;
    let tConnect = t0;
    let tTls = t0;
    let tFirstByte = 0;

    const reqHeaders = { ...opts.headers };
    let bodyBuf = null;
    if (opts.body != null && opts.method !== 'GET' && opts.method !== 'HEAD') {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8');
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
        reqHeaders['Content-Length'] = String(bodyBuf.length);
      }
    }

    const reqOpts = {
      method: opts.method,
      headers: reqHeaders,
      timeout: opts.timeoutMs,
      ...(parsed.protocol === 'https:' ? { rejectUnauthorized: opts.rejectUnauthorized !== false } : {}),
    };

    let settled = false;
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      reject(err);
    };

    const req = mod.request(parsed, reqOpts, (res) => {
      const status = res.statusCode || 0;
      const chunks = [];
      let totalBytes = 0;
      let truncated = false;

      res.once('readable', () => { if (!tFirstByte) tFirstByte = performance.now(); });

      res.on('data', (chunk) => {
        if (!tFirstByte) tFirstByte = performance.now();
        if (truncated) return;
        const remain = MAX_BODY_BYTES - totalBytes;
        if (chunk.length > remain) {
          if (remain > 0) chunks.push(chunk.subarray(0, remain));
          totalBytes = MAX_BODY_BYTES;
          truncated = true;
          res.destroy();
        } else {
          chunks.push(chunk);
          totalBytes += chunk.length;
        }
      });

      const done = () => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        const tEnd = performance.now();
        if (!tFirstByte) tFirstByte = tEnd;
        const rawBuf = Buffer.concat(chunks);
        const decoded = truncated ? rawBuf : decodeCompressed(rawBuf, res.headers['content-encoding']);
        const hasZero = decoded.subarray(0, 4096).includes(0);
        resolve({
          status,
          statusText: res.statusMessage || '',
          headers: res.headers,
          bodyText: hasZero ? '' : decoded.toString('utf8'),
          isBinary: hasZero,
          bytes: decoded.length,
          rawBytes: rawBuf.length,
          truncated,
          finalUrl: urlStr,
          timing: {
            dnsMs: Math.max(0, Math.round(tLookup - t0)),
            tcpMs: Math.max(0, Math.round(tConnect - tLookup)),
            tlsMs: parsed.protocol === 'https:' ? Math.max(0, Math.round(tTls - tConnect)) : 0,
            ttfbMs: Math.max(0, Math.round(tFirstByte - (parsed.protocol === 'https:' ? tTls : tConnect))),
            downloadMs: Math.max(0, Math.round(tEnd - tFirstByte)),
            totalMs: Math.max(0, Math.round(tEnd - t0)),
          },
        });
      };

      res.on('end', done);
      res.on('close', () => { if (truncated) done(); });
      res.on('error', (err) => {
        if (truncated) done();
        else finishErr(err);
      });
    });

    req.on('socket', (sock) => {
      sock.on('lookup', () => { tLookup = performance.now(); });
      sock.on('connect', () => { tConnect = performance.now(); tTls = tConnect; });
      sock.on('secureConnect', () => { tTls = performance.now(); });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Превышен таймаут (${opts.timeoutMs} мс)`));
    });

    req.on('error', finishErr);

    const onAbort = () => {
      req.destroy(new Error('Запрос отменён пользователем'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Выполнить HTTP/HTTPS запрос с ручными редиректами (до 10, с зачисткой Authorization/Cookie при cross-origin).
 * @param {any} opts
 * @param {{ signal?: AbortSignal }} [ctx]
 */
async function executeRequest(opts, { signal } = {}) {
  let currentUrl = String(opts.url || '').trim();
  if (!/^https?:\/\//i.test(currentUrl)) currentUrl = 'http://' + currentUrl;

  let method = String(opts.method || 'GET').toUpperCase();
  let headers = { ...(opts.headers || {}) };
  let body = opts.body != null ? opts.body : null;
  const followRedirects = opts.followRedirects !== false;
  const timeoutMs = Math.max(500, Math.min(120000, Number(opts.timeoutMs) || 30000));

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await singleRequestOnce(currentUrl, {
      method,
      headers,
      body,
      timeoutMs,
      rejectUnauthorized: opts.rejectUnauthorized,
    }, signal);

    const loc = res.headers && res.headers.location;
    if (!followRedirects || !loc || res.status < 300 || res.status >= 400) {
      return { ...res, redirects: hop };
    }

    const prevOrigin = new URL(currentUrl).origin;
    const nextUrlObj = new URL(String(loc), currentUrl);
    if (nextUrlObj.protocol !== 'http:' && nextUrlObj.protocol !== 'https:') {
      throw new Error(`Редирект на неподдерживаемую схему: ${nextUrlObj.protocol}`);
    }

    // При смене origin (cross-origin) удаляем чувствительные заголовки.
    if (nextUrlObj.origin !== prevOrigin) {
      for (const k of Object.keys(headers)) {
        if (SENSITIVE_REDIRECT_HEADERS.has(k.toLowerCase())) delete headers[k];
      }
    }

    if (res.status === 301 || res.status === 302 || res.status === 303) {
      if (method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = null;
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'content-type') delete headers[k];
        }
      }
    }
    currentUrl = nextUrlObj.toString();
  }

  throw new Error(`Превышен лимит редиректов (${MAX_REDIRECTS})`);
}

/**
 * Быстрый probe локальных портов на наличие OpenAPI / Swagger схем.
 * @param {Array<{ port: number, process?: string } | number>} ports
 */
async function probeLocalEndpoints(ports) {
  const uniquePorts = [...new Set((Array.isArray(ports) ? ports : [])
    .map((p) => (typeof p === 'number' ? p : Number(p && p.port)))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535))].slice(0, 16);

  const specPaths = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/docs/openapi.json'];
  const discovered = [];

  await Promise.all(uniquePorts.map(async (port) => {
    const baseUrl = `http://127.0.0.1:${port}`;
    const item = { port, baseUrl, openApiUrl: null, title: '', specText: '' };
    for (const sp of specPaths) {
      try {
        const res = await executeRequest({ method: 'GET', url: baseUrl + sp, timeoutMs: 600, followRedirects: false });
        if (res.status >= 200 && res.status < 300 && res.bodyText) {
          const j = JSON.parse(res.bodyText);
          if (j && (j.openapi || j.swagger) && j.paths) {
            item.openApiUrl = baseUrl + sp;
            item.title = (j.info && j.info.title) || `API :${port}`;
            item.specText = res.bodyText;
            break;
          }
        }
      } catch (_) {}
    }
    discovered.push(item);
  }));

  return discovered.sort((a, b) => a.port - b.port);
}

module.exports = {
  MAX_BODY_BYTES,
  executeRequest,
  probeLocalEndpoints,
};
