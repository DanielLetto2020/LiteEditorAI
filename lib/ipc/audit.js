// Доменный модуль «Аудит» (статический и исторический аудит проекта: типы файлов, техдолг, дубликаты, сироты).

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gitignore = require('../gitignore');
const { git } = require('./git');

const AUDIT_HANDLES = ['audit:scan', 'audit:export'];

const AUDIT_MAX_FILES = 60000;
const AUDIT_LINE_MAX_BYTES = 4 * 1024 * 1024;
const AUDIT_FILES_OUT = 20000;
const AUDIT_EXT_CAT = (() => {
  /** @type {Record<string, string>} */
  const m = {};
  const add = (cat, exts) => exts.forEach((e) => { m[e] = cat; });
  add('code', ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'rb', 'php', 'swift', 'm', 'mm', 'lua', 'dart', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'fish', 'pl', 'r', 'jl', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'sql', 'gradle', 'groovy']);
  add('web', ['html', 'htm', 'css', 'scss', 'sass', 'less', 'styl']);
  add('config', ['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'plist', 'lock', 'properties', 'editorconfig', 'gitignore', 'dockerignore']);
  add('docs', ['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org', 'tex']);
  add('data', ['csv', 'tsv', 'ndjson']);
  add('image', ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'heic']);
  add('media', ['mp4', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'm4v']);
  add('archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']);
  add('font', ['ttf', 'otf', 'woff', 'woff2', 'eot']);
  add('binary', ['pdf', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'jar', 'pyc']);
  return m;
})();
const AUDIT_BINARY_CATS = new Set(['image', 'media', 'archive', 'font', 'binary']);
function auditCat(ext) { return AUDIT_EXT_CAT[ext] || 'other'; }

const AUDIT_MARKER_RE = /\b(TODO|FIXME|HACK|XXX|BUG)\b/;
const AUDIT_MINIFIED_MAXLINE = 1000;
const AUDIT_FIND_CAP = 800;
const AUDIT_GIT_COMMITS = 2000;
/** @type {Array<[string, RegExp]>} */
const AUDIT_SECRET_RULES = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['GitHub token', /gh[posru]_[0-9A-Za-z]{36,}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ['Stripe key', /sk_live_[0-9A-Za-z]{16,}/],
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Generic secret', /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
const AUDIT_JUNK_SEG = new Set(['node_modules', 'dist', 'build', '.next', 'out', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.cache', '.parcel-cache']);

function auditJunkReason(rel, cat, bytes) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  for (const s of segs) if (AUDIT_JUNK_SEG.has(s)) return 'каталог сборки/зависимостей под git (' + s + ')';
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) return 'файл окружения (.env) под git — риск утечки';
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return 'служебный файл ОС';
  if (/\.(log|tmp|temp|swp|swo|bak|orig)$/.test(base)) return 'временный/лог-файл';
  if (/\.min\.(js|css)$/.test(base)) return 'минифицированный бандл (часто генерируется)';
  if (cat === 'archive') return 'архив под git';
  if (AUDIT_BINARY_CATS.has(cat) && bytes > 1024 * 1024) return 'крупный бинарь (>1 МБ) под git';
  return null;
}

async function auditScanText(full) {
  let buf;
  try { buf = await fs.promises.readFile(full); } catch { return null; }
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) if (buf[i] === 0) return null;
  if (buf.length === 0) return { lines: 0, maxLine: 0, markers: [], secrets: [] };
  const rows = buf.toString('utf8').split('\n');
  let lines = rows.length;
  if (rows[rows.length - 1] === '') lines -= 1;
  let maxLine = 0;
  const markers = [], secrets = [];
  for (let i = 0; i < rows.length; i++) {
    const ln = rows[i];
    if (ln.length > maxLine) maxLine = ln.length;
    if (markers.length < 12) { const m = AUDIT_MARKER_RE.exec(ln); if (m) markers.push({ line: i + 1, kind: m[1], text: ln.trim().slice(0, 160) }); }
    if (secrets.length < 8) for (const [rule, re] of AUDIT_SECRET_RULES) if (re.test(ln)) { secrets.push({ line: i + 1, rule, text: ln.trim().slice(0, 120) }); break; }
  }
  return { lines, maxLine, markers, secrets };
}

function auditHashFile(full) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(full);
    s.on('error', () => resolve(null));
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function auditDupes(root, files) {
  const bySize = new Map();
  for (const f of files) { if (f.bytes < 16) continue; const a = bySize.get(f.bytes); if (a) a.push(f); else bySize.set(f.bytes, [f]); }
  const cand = [];
  for (const arr of bySize.values()) if (arr.length > 1) cand.push(...arr);
  if (!cand.length || cand.length > 4000) return { groups: [], skipped: cand.length > 4000 };
  const byHash = new Map();
  for (const f of cand) {
    const h = await auditHashFile(path.join(root, f.rel)); if (h == null) continue;
    const k = f.bytes + ':' + h;
    const a = byHash.get(k); if (a) a.push(f); else byHash.set(k, [f]);
  }
  const groups = [];
  for (const arr of byHash.values()) if (arr.length > 1) groups.push({ bytes: arr[0].bytes, files: arr.map((x) => x.rel) });
  groups.sort((a, b) => b.bytes * b.files.length - a.bytes * a.files.length);
  return { groups: groups.slice(0, 200), skipped: false };
}

async function auditGitHistory(root, fileSet) {
  const out = await git(root, ['-c', 'core.quotePath=false', 'log', '-n', String(AUDIT_GIT_COMMITS), '--no-merges', '--pretty=format:\x01%aI', '--name-only', '--relative']);
  if (out == null) return null;
  const commits = new Map(), lastDate = new Map();
  let cur = null;
  for (const ln of out.split('\n')) {
    if (ln[0] === '\x01') { cur = ln.slice(1); continue; }
    if (!ln || !fileSet.has(ln)) continue;
    commits.set(ln, (commits.get(ln) || 0) + 1);
    if (!lastDate.has(ln) && cur) lastDate.set(ln, cur);
  }
  return { commits, lastDate };
}

const AUDIT_ORPHAN_CORPUS_MAX = 64 * 1024 * 1024;
async function auditOrphans(root, files) {
  if (files.length > 1500) return { items: [], skipped: true };
  const corpus = [];
  let corpusBytes = 0;
  for (const f of files) {
    if (AUDIT_BINARY_CATS.has(f.cat) || f.bytes > AUDIT_LINE_MAX_BYTES) continue;
    if ((corpusBytes += f.bytes) > AUDIT_ORPHAN_CORPUS_MAX) return { items: [], skipped: true };
    let buf; try { buf = await fs.promises.readFile(path.join(root, f.rel)); } catch { continue; }
    if (buf.includes(0)) continue;
    corpus.push({ rel: f.rel, lower: buf.toString('utf8').toLowerCase() });
  }
  const ENTRY = /^(index|main|app|mod|__init__|readme|license|changelog|setup|conftest)\b/i;
  const items = [];
  let checked = 0;
  for (const f of files) {
    if (items.length >= 200) break;
    if (++checked % 25 === 0) await new Promise((r) => setImmediate(r));
    if (f.cat !== 'code' && f.cat !== 'web') continue;
    const base = f.rel.split('/').pop() || '';
    if (ENTRY.test(base) || base.startsWith('.')) continue;
    const b = base.toLowerCase(), n = b.replace(/\.[^.]+$/, '');
    const referenced = corpus.some((o) => o.rel !== f.rel && (o.lower.includes(b) || o.lower.includes(n)));
    if (!referenced) items.push({ rel: f.rel, bytes: f.bytes });
  }
  return { items, skipped: false };
}

/**
 * @param {object} deps
 * @param {{ handle: Function, on: Function }} deps.ipcMain
 * @param {any} deps.dialog
 * @param {Set<string>} deps.ignoreDirs
 * @param {string} deps.writeTmpSuffix
 * @param {(file: string, data: string | Buffer) => void} deps.atomicWriteSync
 * @param {(e: any) => any} deps.senderWin
 * @param {() => any} deps.getMainWindow
 */
function registerAuditIpc(deps) {
  const { ipcMain, dialog, ignoreDirs, writeTmpSuffix, atomicWriteSync, senderWin, getMainWindow } = deps;

  async function auditWalkFs(root, out) {
    const ig = gitignore.forProject(root, ignoreDirs);
    const stack = ['.'];
    while (stack.length) {
      const rel = stack.pop() || '.';
      let ents;
      try { ents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) {
        if (out.length >= AUDIT_MAX_FILES) return true;
        const childRel = rel === '.' ? ent.name : rel + '/' + ent.name;
        if (ent.isDirectory()) {
          if (!ignoreDirs.has(ent.name) && !ig.ignores(childRel, true)) stack.push(childRel);
        } else if (ent.isFile() && !ent.name.endsWith(writeTmpSuffix) && !ig.ignores(childRel, false)) {
          out.push(childRel);
        }
      }
    }
    return false;
  }

  ipcMain.handle('audit:scan', async (_e, { root, opts }) => {
    if (!root || !fs.existsSync(root)) return { error: 'Нет каталога проекта' };
    const wanted = (opts && opts.source) === 'fs' ? 'fs' : 'git';
    let source = wanted, capped = false, gitless = false;
    let relPaths = null;

    if (wanted === 'git') {
      const top = await git(root, ['rev-parse', '--show-toplevel']);
      if (top == null) { source = 'fs'; gitless = true; }
      else {
        const out = await git(root, ['ls-files', '-z']);
        if (out == null) { source = 'fs'; gitless = true; }
        else relPaths = out.split('\0').filter(Boolean);
      }
    }
    if (relPaths == null) { relPaths = []; capped = await auditWalkFs(root, relPaths); }
    else if (relPaths.length >= AUDIT_MAX_FILES) { relPaths = relPaths.slice(0, AUDIT_MAX_FILES); capped = true; }

    const byExtMap = new Map();
    const byCatMap = new Map();
    const files = [];
    const junk = [], todos = [], secrets = [], minified = [];
    let totFiles = 0, totLines = 0, totBytes = 0, skippedBig = 0;

    for (const rel of relPaths) {
      const full = path.join(root, rel);
      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }
      if (!st.isFile()) continue;
      const bytes = st.size;
      const dot = path.extname(rel);
      const ext = dot ? dot.slice(1).toLowerCase() : '';
      const key = ext || '—';
      const cat = auditCat(ext);
      let lines = null;
      const isBinary = AUDIT_BINARY_CATS.has(cat);
      if (!isBinary && bytes <= AUDIT_LINE_MAX_BYTES) {
        const scan = await auditScanText(full);
        if (scan) {
          lines = scan.lines;
          if (scan.maxLine >= AUDIT_MINIFIED_MAXLINE) minified.push({ rel, maxLine: scan.maxLine, bytes, lines });
          for (const m of scan.markers) if (todos.length < AUDIT_FIND_CAP) todos.push({ rel, line: m.line, kind: m.kind, text: m.text });
          for (const s of scan.secrets) if (secrets.length < AUDIT_FIND_CAP) secrets.push({ rel, line: s.line, rule: s.rule, text: s.text });
        }
      } else if (!isBinary) { skippedBig++; }
      const hasLines = lines != null;

      const reason = auditJunkReason(rel, cat, bytes);
      if (reason) junk.push({ rel, reason, bytes });

      totFiles++; totBytes += bytes; if (hasLines) totLines += lines;
      let e = byExtMap.get(key);
      if (!e) { e = { ext: key, cat, files: 0, lines: 0, bytes: 0 }; byExtMap.set(key, e); }
      e.files++; e.bytes += bytes; if (hasLines) e.lines += lines;
      let c = byCatMap.get(cat);
      if (!c) { c = { cat, files: 0, lines: 0, bytes: 0 }; byCatMap.set(cat, c); }
      c.files++; c.bytes += bytes; if (hasLines) c.lines += lines;
      files.push({ rel, ext: key, cat, bytes, lines: hasLines ? lines : 0, hasLines, mtime: st.mtimeMs });
    }

    const dupes = await auditDupes(root, files);
    const orphans = await auditOrphans(root, files);

    const splitAge = (dated) => {
      const sorted = dated.slice().sort((a, b) => b.when.localeCompare(a.when));
      const recent = sorted.slice(0, 40);
      const seen = new Set(recent.map((x) => x.rel));
      const stale = sorted.filter((x) => !seen.has(x.rel)).slice(-40).reverse();
      return { recent, stale };
    };
    let history;
    if (source === 'git') {
      const h = await auditGitHistory(root, new Set(files.map((f) => f.rel)));
      if (h) {
        const churn = [...h.commits.entries()].map(([rel, commits]) => ({ rel, commits })).sort((a, b) => b.commits - a.commits).slice(0, 60);
        const dated = files.filter((f) => h.lastDate.has(f.rel)).map((f) => ({ rel: f.rel, when: h.lastDate.get(f.rel), bytes: f.bytes }));
        history = { mode: 'git', churn, ...splitAge(dated), windowCommits: AUDIT_GIT_COMMITS };
      }
    }
    if (!history) {
      const dated = files.map((f) => ({ rel: f.rel, when: new Date(f.mtime).toISOString(), bytes: f.bytes }));
      history = { mode: 'mtime', churn: [], ...splitAge(dated) };
    }

    const slim = (f) => ({ rel: f.rel, ext: f.ext, cat: f.cat, bytes: f.bytes, lines: f.lines, hasLines: f.hasLines });
    const byExt = [...byExtMap.values()].sort((a, b) => b.bytes - a.bytes);
    const byCat = [...byCatMap.values()].sort((a, b) => b.bytes - a.bytes);
    const langs = byExt.filter((e) => e.cat === 'code' || e.cat === 'web').sort((a, b) => b.lines - a.lines).slice(0, 8);
    const filesSorted = files.sort((a, b) => b.bytes - a.bytes);
    const filesOut = filesSorted.slice(0, AUDIT_FILES_OUT).map(slim);
    const filesCapped = filesSorted.length > AUDIT_FILES_OUT;
    minified.sort((a, b) => b.maxLine - a.maxLine);
    junk.sort((a, b) => b.bytes - a.bytes);

    return {
      root, source, gitless, capped, scannedAt: Date.now(),
      totals: { files: totFiles, lines: totLines, bytes: totBytes, skippedBig },
      byExt, byCat, langs, files: filesOut, filesCapped,
      junk, todos, secrets, minified: minified.slice(0, 200),
      dupes: dupes.groups, dupesSkipped: dupes.skipped,
      orphans: orphans.items, orphansSkipped: orphans.skipped,
      history,
    };
  });

  ipcMain.handle('audit:export', async (e, { content, defaultName }) => {
    try {
      const r = await dialog.showSaveDialog(senderWin(e) || getMainWindow(), {
        defaultPath: defaultName || 'audit-report.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'JSON', extensions: ['json'] }, { name: 'Все файлы', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      atomicWriteSync(r.filePath, String(content == null ? '' : content));
      return { ok: true, file: r.filePath };
    } catch (err) { return { error: String((err && err.message) || err) }; }
  });
}

module.exports = { registerAuditIpc, AUDIT_HANDLES };
