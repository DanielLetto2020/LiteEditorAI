// Интеграционные тесты для lib/rest-http.js: тайминги, gzip, cross-origin redirect, abort и 10 МБ лимит.
'use strict';

const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { executeRequest, probeLocalEndpoints, MAX_BODY_BYTES } = require('../lib/rest-http');

async function listen(handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('net').AddressInfo} */ (srv.address());
  return { srv, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function run() {
  let passed = 0;

  // Target backend server on different port (simulates cross-origin)
  const target = await listen((req, res) => {
    if (req.url === '/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers.authorization || null, cookie: req.headers.cookie || null, custom: req.headers['x-keep'] || null }));
      return;
    }
    if (req.url === '/gzip') {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ compressed: true }), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(gz);
      return;
    }
    if (req.url === '/huge') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      for (let i = 0; i < 12; i++) res.write(chunk);
      res.end();
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        try { res.writeHead(200); res.end('done'); } catch (_) {}
      }, 2000);
      return;
    }
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'Test OpenAPI' }, paths: { '/echo': { get: { summary: 'Echo' } } } }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  // Primary server on distinct port for cross-origin vs same-origin redirect tests
  const front = await listen((req, res) => {
    if (req.url === '/redir-cross') {
      res.writeHead(302, { Location: `${target.baseUrl}/echo` });
      res.end();
      return;
    }
    if (req.url === '/redir-same') {
      res.writeHead(302, { Location: '/same-dest' });
      res.end();
      return;
    }
    if (req.url === '/same-dest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers.authorization || null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // 1. gzip decompression + timings
    const gz = await executeRequest({ method: 'GET', url: `${target.baseUrl}/gzip` });
    assert.strictEqual(gz.status, 200);
    assert.strictEqual(JSON.parse(gz.bodyText).compressed, true);
    assert(gz.timing && typeof gz.timing.totalMs === 'number' && gz.timing.totalMs >= 0);
    passed++;

    // 2. same-origin redirect keeps Authorization
    const same = await executeRequest({
      method: 'GET',
      url: `${front.baseUrl}/redir-same`,
      headers: { Authorization: 'Bearer keep-me' },
    });
    assert.strictEqual(JSON.parse(same.bodyText).auth, 'Bearer keep-me');
    passed++;

    // 3. cross-origin redirect strips Authorization & Cookie while keeping non-secret headers
    const cross = await executeRequest({
      method: 'GET',
      url: `${front.baseUrl}/redir-cross`,
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=123', 'X-Keep': 'ok' },
    });
    const crossJson = JSON.parse(cross.bodyText);
    assert.strictEqual(crossJson.auth, null);
    assert.strictEqual(crossJson.cookie, null);
    assert.strictEqual(crossJson.custom, 'ok');
    passed++;

    // 4. 10 MB response cap
    const huge = await executeRequest({ method: 'GET', url: `${target.baseUrl}/huge` });
    assert.strictEqual(huge.truncated, true);
    assert(huge.bytes <= MAX_BODY_BYTES);
    passed++;

    // 5. AbortController cancellation
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 80);
    await assert.rejects(
      () => executeRequest({ method: 'GET', url: `${target.baseUrl}/slow` }, { signal: ctrl.signal }),
      /отменён/i
    );
    passed++;

    // 6. probeLocalEndpoints discovers OpenAPI 3
    const probed = await probeLocalEndpoints([{ port: target.port }]);
    assert.strictEqual(probed.length, 1);
    assert.strictEqual(probed[0].openApiUrl, `${target.baseUrl}/openapi.json`);
    assert.strictEqual(probed[0].title, 'Test OpenAPI');
    passed++;
  } finally {
    target.srv.close();
    front.srv.close();
  }

  console.log(`rest-http.test.js: ${passed} checks passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
