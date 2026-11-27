// Чистые утилиты URL-гарда, отчётов агенту и .git/info/exclude для встроенного предпросмотра.
'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
}

/**
 * Проверить URL для webview предпросмотра.
 * По умолчанию разрешены только loopback-хосты по http/https.
 * При allowExternal=true разрешаются внешние http/https, но file/javascript/data/chrome/devtools всегда запрещены.
 * @param {string} rawUrl
 * @param {{ allowExternal?: boolean }} [opts]
 */
function validatePreviewUrl(rawUrl, { allowExternal = false } = {}) {
  let s = String(rawUrl || '').trim();
  if (!s) return { ok: false, error: 'Пустой URL' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^https?:/i.test(s)) {
    return { ok: false, error: 'Запрещённая схема URL (разрешены только http/https)' };
  }
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;

  let u;
  try { u = new URL(s); }
  catch (err) { return { ok: false, error: `Некорректный URL: ${err.message}` }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `Запрещённая схема: ${u.protocol}` };
  }

  const local = isLoopbackHost(u.hostname);
  if (!local && !allowExternal) {
    return { ok: false, isLocal: false, error: 'Внешние адреса заблокированы политикой «Только localhost»' };
  }
  return { ok: true, url: u.toString(), isLocal: local };
}

/**
 * Безопасно добавить паттерн (например ".lite/") в .git/info/exclude,
 * поддерживая обычный .git и worktree (.git файл с "gitdir: ...").
 * @param {string} projectDir
 * @param {string} [pattern]
 */
function ensureGitInfoExclude(projectDir, pattern = '.lite/') {
  try {
    if (!projectDir || !fs.existsSync(projectDir)) return false;
    const dotGit = path.join(projectDir, '.git');
    if (!fs.existsSync(dotGit)) return false;
    let gitDir = dotGit;
    const st = fs.statSync(dotGit);
    if (st.isFile()) {
      const txt = fs.readFileSync(dotGit, 'utf8');
      const m = txt.match(/^gitdir:\s*(.+)$/im);
      if (!m) return false;
      gitDir = path.resolve(projectDir, m[1].trim());
    }
    const infoDir = path.join(gitDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    const excludeFile = path.join(infoDir, 'exclude');
    const cur = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    const lines = cur.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(pattern)) return true;
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludeFile, `${sep}${pattern}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Сформировать компактный отчёт предпросмотра для отправки агенту в терминал.
 * @param {{ url?: string, viewport?: string, consoleErrors?: any[], failedRequests?: any[], screenshotPath?: string }} opts
 */
function formatPreviewAgentReport({ url = '', viewport = 'desktop', consoleErrors = [], failedRequests = [], screenshotPath = '' } = {}) {
  const out = [];
  out.push(`Проблема в предпросмотре (${viewport}): ${url || 'about:blank'}`);
  if (screenshotPath) out.push(`Скриншот: ${screenshotPath}`);
  const errs = (Array.isArray(consoleErrors) ? consoleErrors : []).slice(-10);
  if (errs.length) {
    out.push('Ошибки консоли:');
    for (const e of errs) {
      const loc = e.sourceId ? ` (${e.sourceId}:${e.line || 0})` : '';
      out.push(`- [${e.level || 'error'}] ${String(e.message || '').slice(0, 300)}${loc}`);
    }
  }
  const net = (Array.isArray(failedRequests) ? failedRequests : []).slice(-10);
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

module.exports = {
  isLoopbackHost,
  validatePreviewUrl,
  ensureGitInfoExclude,
  formatPreviewAgentReport,
};
