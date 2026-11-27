// Unit-тесты для lib/preview-url.js: localhost-гард, опасные схемы, git exclude и отчёт агенту.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isLoopbackHost,
  validatePreviewUrl,
  ensureGitInfoExclude,
  formatPreviewAgentReport,
} = require('../lib/preview-url');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

check('isLoopbackHost identifies localhost, IPv4/IPv6 loopback and *.localhost', () => {
  assert.strictEqual(isLoopbackHost('localhost'), true);
  assert.strictEqual(isLoopbackHost('127.0.0.1'), true);
  assert.strictEqual(isLoopbackHost('::1'), true);
  assert.strictEqual(isLoopbackHost('[::1]'), true);
  assert.strictEqual(isLoopbackHost('app.localhost'), true);
  assert.strictEqual(isLoopbackHost('example.com'), false);
  assert.strictEqual(isLoopbackHost('192.168.1.10'), false);
});

check('validatePreviewUrl blocks dangerous schemes and enforces allowExternal', () => {
  assert.strictEqual(validatePreviewUrl('http://localhost:3000/app').ok, true);
  assert.strictEqual(validatePreviewUrl('127.0.0.1:5173').url, 'http://127.0.0.1:5173/');
  assert.strictEqual(validatePreviewUrl('https://example.com', { allowExternal: false }).ok, false);
  assert.strictEqual(validatePreviewUrl('https://example.com', { allowExternal: true }).ok, true);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'devtools://devtools']) {
    assert.strictEqual(validatePreviewUrl(bad, { allowExternal: true }).ok, false, `must reject ${bad}`);
  }
});

check('ensureGitInfoExclude appends pattern idempotently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-prev-git-'));
  try {
    fs.mkdirSync(path.join(tmp, '.git', 'info'), { recursive: true });
    assert.strictEqual(ensureGitInfoExclude(tmp, '.lite/'), true);
    assert.strictEqual(ensureGitInfoExclude(tmp, '.lite/'), true);
    const content = fs.readFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'utf8');
    assert.strictEqual(content.match(/\.lite\//g).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('formatPreviewAgentReport formats errors, failed requests and screenshot path', () => {
  const rep = formatPreviewAgentReport({
    url: 'http://localhost:3000/dashboard',
    viewport: 'mobile',
    consoleErrors: [{ level: 'error', message: 'Uncaught TypeError: x is null', sourceId: 'app.js', line: 42 }],
    failedRequests: [{ method: 'GET', url: 'http://localhost:3000/api/me', statusCode: 500 }],
    screenshotPath: '/proj/.lite/shots/preview-1.png',
  });
  assert(rep.includes('mobile'));
  assert(rep.includes('/proj/.lite/shots/preview-1.png'));
  assert(rep.includes('Uncaught TypeError'));
  assert(rep.includes('HTTP 500'));
});

console.log(`preview-url.test.js: ${passed} checks passed`);
