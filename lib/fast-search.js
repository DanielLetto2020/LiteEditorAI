// Быстрый листинг и поиск по файлам проектов вне главного потока Electron.
// Первичный движок — системный ripgrep (`rg`), работающий в отдельном нативном процессе со стримингом
// JSON/строк и мгновенным прерыванием по лимиту или отмене.
// Прозрачный запасной путь (если `rg` не установлен или регулярное выражение использует обратные
// ссылки/lookaround из JS RegExp) — фоновый поток `worker_threads` с обходом через `lib/gitignore.js`
// и мгновенной отменой через SharedArrayBuffer + Atomics. Главный поток не читает файлы проекта вовсе.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const gitignore = require('./gitignore');
const { WRITE_TMP_SUFFIX } = require('./store');

const DEFAULT_LIST_CAP = 30000;
const DEFAULT_SEARCH_CAP = 1000;
const DEFAULT_SEARCH_FILE_MAX = 1024 * 1024;
const GSX_DEFAULTS = {
  totalCap: 5000,
  perFileCap: 50,
  maxFileSize: 2 * 1024 * 1024,
  flushHits: 200,
  flushMs: 120,
  textMax: 260,
};

// Конструкции JS RegExp, которых нет в базовом конечном автомате ripgrep (без PCRE2):
// обратные ссылки \1..\9 и lookaround (?= / (?! / (?<= / (?<!.
const RG_UNSUPPORTED_RE = /\\[1-9]|\(\?(?:=|!|<=|<!)/;

// ── Маска вида "*.js, src/**" → предикат по относительному пути (как в gsearch) ──
function gsxMaskPred(raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const res = [];
  for (const p of parts) {
    let body = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '*') {
        if (p[i + 1] === '*') { body += '.*'; i++; }
        else body += '[^/]*';
      } else if (ch === '?') body += '.';
      else if ('.+^${}()|[]\\'.includes(ch)) body += '\\' + ch;
      else body += ch;
    }
    try { res.push({ re: new RegExp('^' + body + '$', 'i'), full: p.includes('/') }); } catch (_) {}
  }
  if (!res.length) return null;
  return (rel) => {
    const name = rel.split('/').pop() || '';
    return res.some((r) => r.re.test(r.full ? rel : name));
  };
}

function buildSearchRegExp(query, opts = {}) {
  let src = opts.regex ? String(query) : String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) src = '\\b(?:' + src + ')\\b';
  return new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
}

// ── Обход дерева проекта (используется внутри worker_threads; также экспортирован для совместимости) ──
async function walkProjectFiles(root, onFile, stop, ignoreDirs = gitignore.DEFAULT_IGNORE_DIRS) {
  let rootReal = root;
  try { rootReal = await fs.promises.realpath(root); } catch (_) {}
  const ig = gitignore.forProject(root, ignoreDirs);
  /** @type {Array<{ dir: string, real: string, up: any }>} */
  const stack = [{ dir: root, real: rootReal, up: null }];
  while (stack.length) {
    if (stop && stop()) return;
    const node = /** @type {{ dir: string, real: string, up: any }} */ (stack.pop());
    const dir = node.dir;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full);
      let isDir = d.isDirectory();
      /** @type {string | null} */
      let real = null;
      if (d.isSymbolicLink()) {
        try { isDir = (await fs.promises.stat(full)).isDirectory(); } catch (_) { isDir = false; }
        if (isDir && !ignoreDirs.has(d.name) && !ig.ignores(rel, true)) {
          try { real = await fs.promises.realpath(full); } catch (_) { continue; }
        }
      }
      if (isDir) {
        if (ignoreDirs.has(d.name) || ig.ignores(rel, true)) continue;
        if (real === null) real = path.join(node.real, d.name);
        else {
          let a = node;
          while (a && a.real !== real) a = a.up;
          if (a) continue; // петля симлинков — каталог уже есть на пути от корня
        }
        stack.push({ dir: full, real, up: node });
        continue;
      }
      if (d.name.endsWith(WRITE_TMP_SUFFIX) || ig.ignores(rel, false)) continue;
      if (stop && stop()) return;
      await onFile(full, rel);
    }
  }
}

function isBinaryProbe(buf) {
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) if (buf[i] === 0) return true;
  return false;
}

// ── Реализации для worker_threads ──────────────────────────────────────────────────
async function workerListFiles({ root, cap }) {
  /** @type {string[]} */
  const files = [];
  let capped = false;
  await walkProjectFiles(
    root,
    (_full, rel) => {
      if (files.length >= cap) { capped = true; return; }
      files.push(rel);
    },
    () => capped,
  );
  return { files, capped };
}

async function workerSearchProject({ root, query, opts, cap, maxFileSize }) {
  const re = buildSearchRegExp(query, opts);
  /** @type {Array<{ file: string, line: number, col: number, text: string }>} */
  const matches = [];
  let capped = false;
  await walkProjectFiles(
    root,
    async (full, rel) => {
      if (matches.length >= cap) { capped = true; return; }
      let stat;
      try { stat = await fs.promises.stat(full); } catch (_) { return; }
      if (!stat.isFile() || !stat.size || stat.size > maxFileSize) return;
      let buf;
      try { buf = await fs.promises.readFile(full); } catch (_) { return; }
      if (isBinaryProbe(buf)) return;
      const rows = buf.toString('utf8').split('\n');
      for (let i = 0; i < rows.length; i++) {
        re.lastIndex = 0;
        const m = re.exec(rows[i]);
        if (!m) continue;
        if (matches.length >= cap) { capped = true; return; }
        matches.push({ file: rel, line: i + 1, col: m.index + 1, text: rows[i].slice(0, 240) });
      }
    },
    () => capped,
  );
  return { matches, capped };
}

async function workerGlobalSearch({ roots, query, opts, caps, cancelBuf }, emit) {
  const o = opts || {};
  const mode = (o.mode === 'names' || o.mode === 'both') ? o.mode : 'content';
  const re = buildSearchRegExp(query, o);
  const incl = gsxMaskPred(o.include);
  const excl = gsxMaskPred(o.exclude);
  const flag = cancelBuf ? new Int32Array(cancelBuf) : null;
  const isCancelled = () => (flag ? Atomics.load(flag, 0) !== 0 : false);

  const totalCap = caps.totalCap || GSX_DEFAULTS.totalCap;
  const perFileCap = caps.perFileCap || GSX_DEFAULTS.perFileCap;
  const maxFileSize = caps.maxFileSize || GSX_DEFAULTS.maxFileSize;
  const flushHits = caps.flushHits || GSX_DEFAULTS.flushHits;
  const flushMs = caps.flushMs || GSX_DEFAULTS.flushMs;
  const textMax = caps.textMax || GSX_DEFAULTS.textMax;

  let total = 0;
  let files = 0;
  let scanned = 0;
  let capped = false;
  /** @type {any[]} */
  let batch = [];
  let lastFlush = 0;

  const flush = (force) => {
    if (!batch.length || isCancelled()) return;
    if (!force && batch.length < flushHits && Date.now() - lastFlush < flushMs) return;
    const hits = batch;
    batch = [];
    lastFlush = Date.now();
    emit({ type: 'hits', hits });
  };

  for (const r of roots) {
    if (isCancelled() || capped) break;
    const root = r && r.path ? String(r.path) : '';
    if (!root) continue;
    try { if (!(await fs.promises.stat(root)).isDirectory()) continue; } catch (_) { continue; }
    emit({ type: 'progress', rootId: r.id, name: r.name, total, scanned });

    await walkProjectFiles(
      root,
      async (full, rawRel) => {
        if (isCancelled()) return;
        if (total >= totalCap) { capped = true; return; }
        const rel = rawRel.split(path.sep).join('/');
        if (incl && !incl(rel)) return;
        if (excl && excl(rel)) return;
        scanned++;
        if (scanned % 500 === 0) {
          emit({ type: 'progress', rootId: r.id, name: r.name, total, scanned });
        }
        let fileHits = 0;
        if (mode === 'names' || mode === 'both') {
          re.lastIndex = 0;
          const m = re.exec(rel);
          if (m) {
            batch.push({ rootId: r.id, file: rel, line: 0, text: rel, mcol: m.index, len: m[0].length });
            total++;
            fileHits++;
          }
        }
        if ((mode === 'content' || mode === 'both') && total < totalCap) {
          let stat;
          try { stat = await fs.promises.stat(full); } catch (_) { if (fileHits) { files++; flush(false); } return; }
          if (!stat.isFile() || !stat.size || stat.size > maxFileSize) {
            if (fileHits) { files++; flush(false); }
            return;
          }
          let raw;
          try { raw = await fs.promises.readFile(full); } catch (_) { if (fileHits) { files++; flush(false); } return; }
          if (isBinaryProbe(raw)) {
            if (fileHits) { files++; flush(false); }
            return;
          }
          const rows = raw.toString('utf8').split('\n');
          let perFile = 0;
          for (let i = 0; i < rows.length && total < totalCap && perFile < perFileCap; i++) {
            re.lastIndex = 0;
            const m = re.exec(rows[i]);
            if (!m) continue;
            const from = Math.max(0, m.index - 60);
            const text = (from ? '…' : '') + rows[i].slice(from, from + textMax);
            batch.push({
              rootId: r.id,
              file: rel,
              line: i + 1,
              text,
              mcol: m.index - from + (from ? 1 : 0),
              len: m[0].length,
            });
            total++;
            perFile++;
            fileHits++;
          }
        }
        if (fileHits) files++;
        if (total >= totalCap) capped = true;
        flush(false);
      },
      () => isCancelled() || capped,
    );
  }

  flush(true);
  return { total, files, scanned, capped };
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const task = workerData || {};
  (async () => {
    try {
      if (task.op === 'listFiles') {
        const res = await workerListFiles(task);
        port.postMessage({ type: 'done', result: res });
      } else if (task.op === 'searchProject') {
        const res = await workerSearchProject(task);
        port.postMessage({ type: 'done', result: res });
      } else if (task.op === 'globalSearch') {
        const res = await workerGlobalSearch(task, (ev) => port.postMessage(ev));
        port.postMessage({ type: 'done', result: res });
      } else {
        port.postMessage({ type: 'error', error: `Неизвестная задача fast-search: ${String(task.op)}` });
      }
    } catch (err) {
      port.postMessage({ type: 'error', error: String((err && err.message) || err) });
    }
  })();
}

// ── Обнаружение системного ripgrep (`rg`) ──────────────────────────────────────────
/** @type {Promise<string | null> | null} */
let rgDetectPromise = null;

function probeRgBin(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 2500, windowsHide: true }, (err, stdout) => {
      if (!err && stdout && stdout.includes('ripgrep')) resolve(bin);
      else resolve(null);
    });
  });
}

function detectRipgrep(opts = {}) {
  if (opts.force) rgDetectPromise = null;
  if (rgDetectPromise) return rgDetectPromise;
  rgDetectPromise = (async () => {
    const home = os.homedir();
    const candidates = [
      'rg',
      '/usr/bin/rg',
      '/usr/local/bin/rg',
      '/snap/bin/rg',
      path.join(home, '.local', 'bin', 'rg'),
      path.join(home, '.cargo', 'bin', 'rg'),
      path.join(home, '.kimi-code', 'bin', 'rg'),
    ];
    for (const c of candidates) {
      if (c !== 'rg') {
        try { if (!fs.existsSync(c)) continue; } catch (_) { continue; }
      }
      const ok = await probeRgBin(c);
      if (ok) return ok;
    }
    return null;
  })();
  return rgDetectPromise;
}

function rgBaseArgs(ignoreDirs = gitignore.DEFAULT_IGNORE_DIRS) {
  const args = [
    '--hidden',
    '--follow',
    '--no-require-git',
    '--no-ignore-parent',
    '--no-ignore-global',
    '--no-config',
  ];
  for (const d of ignoreDirs) {
    args.push('-g', `!${d}`);
  }
  args.push('-g', `!*${WRITE_TMP_SUFFIX}`);
  return args;
}

function normalizeRgRel(raw, sep = path.sep) {
  const clean = String(raw || '').replace(/^\.[\\/]+/, '');
  return sep === '/' ? clean.replace(/\\/g, '/') : clean.split(/[\\/]/).join(sep);
}

function decodeRgField(field) {
  if (!field) return '';
  if (typeof field.text === 'string') return field.text;
  if (typeof field.bytes === 'string') return Buffer.from(field.bytes, 'base64').toString('utf8');
  return '';
}

function byteOffsetToCharIndex(str, byteOffset) {
  if (!byteOffset || byteOffset <= 0) return 0;
  // Быстрый путь для чистого ASCII (код каждого символа < 128 → 1 байт = 1 символ UTF-16).
  let ascii = true;
  const lim = Math.min(str.length, byteOffset);
  for (let i = 0; i < lim; i++) {
    if (str.charCodeAt(i) >= 0x80) { ascii = false; break; }
  }
  if (ascii) return Math.min(str.length, byteOffset);
  return Buffer.from(str, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}

function canUseRgForQuery(query, opts = {}) {
  if (opts.regex && RG_UNSUPPORTED_RE.test(String(query))) return false;
  return true;
}

function runWorkerOnce(task, hooks = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new Worker(__filename, { workerData: task });
    w.unref();
    if (hooks.onWorker) hooks.onWorker(w);
    w.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'hits' && hooks.onHits) hooks.onHits(msg.hits);
      else if (msg.type === 'progress' && hooks.onProgress) hooks.onProgress(msg);
      else if (msg.type === 'done') {
        settled = true;
        resolve(msg.result);
      } else if (msg.type === 'error') {
        settled = true;
        reject(new Error(msg.error || 'worker error'));
      }
    });
    w.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    w.on('exit', (code) => {
      if (!settled) {
        settled = true;
        if (code === 0) resolve(null);
        else reject(new Error(`fast-search worker exited with code ${code}`));
      }
    });
  });
}

// ── Публичные методы ───────────────────────────────────────────────────────────────

/**
 * Рекурсивный список файлов проекта для Ctrl+P (files:listAll).
 * @param {string} root
 * @param {{ cap?: number, useRg?: boolean }} [opts]
 */
async function listFiles(root, opts = {}) {
  if (!root) return { error: 'нет корня' };
  const cap = opts.cap || DEFAULT_LIST_CAP;
  try {
    const st = await fs.promises.stat(root);
    if (!st.isDirectory()) return { files: [], capped: false };
  } catch (_) {
    return { files: [], capped: false };
  }

  const rgBin = opts.useRg === false ? null : await detectRipgrep();
  if (rgBin) {
    const rgRes = await new Promise((resolve) => {
      /** @type {string[]} */
      const files = [];
      let capped = false;
      let killed = false;
      let carry = '';
      let spawnFailed = false;

      const args = [...rgBaseArgs(), '--files'];
      const child = spawn(rgBin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      const pushLine = (line) => {
        if (!line || capped) return;
        const rel = normalizeRgRel(line.replace(/\r$/, ''), path.sep);
        if (!rel) return;
        if (files.length >= cap) {
          capped = true;
          if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
          return;
        }
        files.push(rel);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (capped) return;
        const data = carry + chunk;
        const parts = data.split('\n');
        carry = parts.pop() || '';
        for (const line of parts) {
          pushLine(line);
          if (capped) break;
        }
      });
      child.on('error', () => { spawnFailed = true; resolve(null); });
      child.on('close', () => {
        if (spawnFailed) return;
        if (!capped && carry) pushLine(carry);
        resolve({ files, capped });
      });
    });
    if (rgRes) return rgRes;
  }

  try {
    return await runWorkerOnce({ op: 'listFiles', root, cap });
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/**
 * Поиск по одному проекту (files:search).
 * @param {string} root
 * @param {string} query
 * @param {{ regex?: boolean, caseSensitive?: boolean, cap?: number, maxFileSize?: number, useRg?: boolean }} [opts]
 */
async function searchProject(root, query, opts = {}) {
  if (!root || !query) return { matches: [], capped: false };
  try {
    buildSearchRegExp(query, opts);
  } catch (_) {
    return { error: 'некорректное регулярное выражение' };
  }

  const cap = opts.cap || DEFAULT_SEARCH_CAP;
  const maxFileSize = opts.maxFileSize || DEFAULT_SEARCH_FILE_MAX;
  try {
    const st = await fs.promises.stat(root);
    if (!st.isDirectory()) return { matches: [], capped: false };
  } catch (_) {
    return { matches: [], capped: false };
  }

  const rgBin = (opts.useRg === false || !canUseRgForQuery(query, opts)) ? null : await detectRipgrep();
  if (rgBin) {
    const rgRes = await new Promise((resolve) => {
      /** @type {Array<{ file: string, line: number, col: number, text: string }>} */
      const matches = [];
      let capped = false;
      let killed = false;
      let carry = '';
      let fallbackNeeded = false;

      const args = [
        ...rgBaseArgs(),
        '--json',
        '--max-filesize', String(maxFileSize),
        opts.caseSensitive ? '-s' : '-i',
      ];
      if (!opts.regex) args.push('-F');
      args.push('-e', String(query));

      const child = spawn(rgBin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      const handleJsonLine = (line) => {
        if (!line || capped) return;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }
        if (!msg || msg.type !== 'match' || !msg.data) return;
        if (matches.length >= cap) {
          capped = true;
          if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
          return;
        }
        const d = msg.data;
        const rel = normalizeRgRel(decodeRgField(d.path), path.sep);
        const rawLine = decodeRgField(d.lines).replace(/\n$/, '');
        const sub = Array.isArray(d.submatches) && d.submatches[0];
        const col = (sub ? byteOffsetToCharIndex(rawLine, sub.start) : 0) + 1;
        matches.push({
          file: rel,
          line: d.line_number || 1,
          col,
          text: rawLine.slice(0, 240),
        });
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (capped) return;
        const data = carry + chunk;
        const parts = data.split('\n');
        carry = parts.pop() || '';
        for (const line of parts) {
          handleJsonLine(line);
          if (capped) break;
        }
      });
      child.on('error', () => { fallbackNeeded = true; resolve(null); });
      child.on('close', (code) => {
        if (fallbackNeeded) return;
        // code === 2 у rg без убиения означает синтаксис регэкспа, неподдерживаемый Rust regex → фолбэк в worker.
        if (code === 2 && !killed && !matches.length) {
          resolve(null);
          return;
        }
        if (!capped && carry) handleJsonLine(carry);
        resolve({ matches, capped });
      });
    });
    if (rgRes) return rgRes;
  }

  try {
    return await runWorkerOnce({ op: 'searchProject', root, query, opts, cap, maxFileSize });
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/**
 * Стриминговый глобальный поиск по набору корней (gsearch:start).
 * Возвращает контроллер `{ cancel(), promise }`.
 * @param {{
 *   roots: Array<{ id: string, name?: string, path: string }>,
 *   query: string,
 *   opts?: { mode?: string, regex?: boolean, wholeWord?: boolean, caseSensitive?: boolean, include?: string, exclude?: string },
 *   caps?: Partial<typeof GSX_DEFAULTS>,
 *   useRg?: boolean,
 *   onHits?: (hits: any[]) => void,
 *   onProgress?: (p: { rootId: string, name?: string, total: number, scanned: number }) => void,
 *   shouldStop?: () => boolean,
 * }} params
 */
function startGlobalSearch(params) {
  const o = params.opts || {};
  const mode = (o.mode === 'names' || o.mode === 'both') ? o.mode : 'content';
  const caps = Object.assign({}, GSX_DEFAULTS, params.caps || {});
  let re;
  try {
    re = buildSearchRegExp(params.query, o);
  } catch (_) {
    return {
      ok: false,
      error: 'некорректное регулярное выражение',
      cancel: () => {},
      promise: Promise.resolve({ total: 0, files: 0, scanned: 0, capped: false, cancelled: false, error: 'некорректное регулярное выражение' }),
    };
  }

  let cancelled = false;
  const cancelBuf = new SharedArrayBuffer(4);
  const cancelArr = new Int32Array(cancelBuf);
  /** @type {import('child_process').ChildProcess | null} */
  let activeChild = null;

  const isCancelled = () => {
    if (cancelled) return true;
    if (params.shouldStop && params.shouldStop()) {
      cancelled = true;
      Atomics.store(cancelArr, 0, 1);
      if (activeChild) { try { activeChild.kill('SIGTERM'); } catch (_) {} }
      return true;
    }
    return false;
  };

  const cancel = () => {
    cancelled = true;
    Atomics.store(cancelArr, 0, 1);
    if (activeChild) {
      try { activeChild.kill('SIGTERM'); } catch (_) {}
    }
  };

  const promise = (async () => {
    const rgBin = (params.useRg === false || !canUseRgForQuery(params.query, o)) ? null : await detectRipgrep();
    const incl = gsxMaskPred(o.include);
    const excl = gsxMaskPred(o.exclude);

    // Если rg доступен и маски не требуют ручного пересчёта каждого файла в режиме content,
    // запускаем нативный rg по каждому корню. При масках include/exclude в content также используем rg,
    // передавая маски через --iglob и перепроверяя gsxMaskPred на совпадениях.
    if (rgBin) {
      let total = 0;
      let files = 0;
      let scanned = 0;
      let capped = false;
      let needWorkerFallback = false;
      /** @type {any[]} */
      let batch = [];
      let lastFlush = 0;

      const flush = (force) => {
        if (!batch.length || isCancelled()) return;
        if (!force && batch.length < caps.flushHits && Date.now() - lastFlush < caps.flushMs) return;
        const hits = batch;
        batch = [];
        lastFlush = Date.now();
        if (params.onHits) params.onHits(hits);
      };

      const maskArgs = [];
      for (const part of String(o.include || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        maskArgs.push('--iglob', part);
      }
      for (const part of String(o.exclude || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        maskArgs.push('--iglob', '!' + part);
      }

      for (const r of params.roots) {
        if (isCancelled() || capped || needWorkerFallback) break;
        const root = r && r.path ? String(r.path) : '';
        if (!root) continue;
        try { if (!(await fs.promises.stat(root)).isDirectory()) continue; } catch (_) { continue; }
        if (params.onProgress) params.onProgress({ rootId: r.id, name: r.name, total, scanned });

        const touchedInRoot = new Set();

        // Шаг 1 (для режимов 'names' и 'both'): быстрый поток имён файлов через `rg --files`.
        if (mode === 'names' || mode === 'both') {
          await new Promise((resolve) => {
            let carry = '';
            let killed = false;
            const args = [...rgBaseArgs(), ...maskArgs, '--files'];
            const child = spawn(rgBin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            activeChild = child;

            const onFileLine = (line) => {
              if (!line || capped || isCancelled()) {
                if (!killed && (capped || cancelled)) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
                return;
              }
              const rel = normalizeRgRel(line.replace(/\r$/, ''), '/');
              if (!rel) return;
              if (incl && !incl(rel)) return;
              if (excl && excl(rel)) return;
              if (mode === 'names') {
                scanned++;
                if (scanned % 500 === 0 && params.onProgress) {
                  params.onProgress({ rootId: r.id, name: r.name, total, scanned });
                }
              }
              re.lastIndex = 0;
              const m = re.exec(rel);
              if (!m) return;
              if (total >= caps.totalCap) {
                capped = true;
                if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
                return;
              }
              batch.push({ rootId: r.id, file: rel, line: 0, text: rel, mcol: m.index, len: m[0].length });
              total++;
              if (!touchedInRoot.has(rel)) { touchedInRoot.add(rel); files++; }
              if (total >= caps.totalCap) {
                capped = true;
                if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
              }
              flush(false);
            };

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
              const data = carry + chunk;
              const parts = data.split('\n');
              carry = parts.pop() || '';
              for (const l of parts) {
                onFileLine(l);
                if (capped || cancelled) break;
              }
            });
            child.on('error', () => { needWorkerFallback = true; activeChild = null; resolve(null); });
            child.on('close', () => {
              activeChild = null;
              if (!capped && !cancelled && carry) onFileLine(carry);
              resolve(null);
            });
          });
        }

        // Шаг 2 (для режимов 'content' и 'both'): стриминг совпадений по содержимому через `rg --json`.
        if ((mode === 'content' || mode === 'both') && !capped && !isCancelled() && !needWorkerFallback) {
          await new Promise((resolve) => {
            let carry = '';
            let killed = false;
            let summaryCounted = false;
            let endFiles = 0;
            const perFileCounts = new Map();

            const args = [
              ...rgBaseArgs(),
              ...maskArgs,
              '--json',
              '--max-count', String(caps.perFileCap),
              '--max-filesize', String(caps.maxFileSize),
              o.caseSensitive ? '-s' : '-i',
            ];
            if (!o.regex) args.push('-F');
            if (o.wholeWord) args.push('-w');
            args.push('-e', String(params.query));

            const child = spawn(rgBin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            activeChild = child;

            const onJsonLine = (line) => {
              if (!line) return;
              if (isCancelled()) {
                if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
                return;
              }
              let msg;
              try { msg = JSON.parse(line); } catch (_) { return; }
              if (!msg) return;
              if (msg.type === 'summary' && msg.data && msg.data.stats) {
                summaryCounted = true;
                scanned += Math.max(endFiles, +msg.data.stats.searches || 0) - endFiles;
                return;
              }
              if (msg.type === 'end') {
                endFiles++;
                scanned++;
                if (scanned % 500 === 0 && params.onProgress) {
                  params.onProgress({ rootId: r.id, name: r.name, total, scanned });
                }
                return;
              }
              if (msg.type !== 'match' || !msg.data || capped) return;
              const d = msg.data;
              const rel = normalizeRgRel(decodeRgField(d.path), '/');
              if (incl && !incl(rel)) return;
              if (excl && excl(rel)) return;
              const prevCnt = perFileCounts.get(rel) || 0;
              if (prevCnt >= caps.perFileCap) return;
              if (total >= caps.totalCap) {
                capped = true;
                if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
                return;
              }
              const rawLine = decodeRgField(d.lines).replace(/\n$/, '');
              const sub = Array.isArray(d.submatches) && d.submatches[0];
              const mIndex = sub ? byteOffsetToCharIndex(rawLine, sub.start) : 0;
              const matchText = sub && sub.match ? decodeRgField(sub.match) : '';
              const mLen = matchText.length;
              const from = Math.max(0, mIndex - 60);
              const text = (from ? '…' : '') + rawLine.slice(from, from + caps.textMax);

              batch.push({
                rootId: r.id,
                file: rel,
                line: d.line_number || 1,
                text,
                mcol: mIndex - from + (from ? 1 : 0),
                len: mLen,
              });
              perFileCounts.set(rel, prevCnt + 1);
              total++;
              if (!touchedInRoot.has(rel)) { touchedInRoot.add(rel); files++; }
              if (total >= caps.totalCap) {
                capped = true;
                if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }
              }
              flush(false);
            };

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
              const data = carry + chunk;
              const parts = data.split('\n');
              carry = parts.pop() || '';
              for (const l of parts) {
                onJsonLine(l);
                if (capped || cancelled) break;
              }
            });
            child.on('error', () => { needWorkerFallback = true; activeChild = null; resolve(null); });
            child.on('close', (code) => {
              activeChild = null;
              if (code === 2 && !killed && total === 0 && files === 0 && !summaryCounted) {
                needWorkerFallback = true;
                resolve(null);
                return;
              }
              if (!capped && !cancelled && carry) onJsonLine(carry);
              resolve(null);
            });
          });
        }
      }

      if (!needWorkerFallback) {
        flush(true);
        return { total, files, scanned, capped, cancelled, error: '' };
      }
      // Если rg неожиданно отказал до выдачи результатов — идём в воркер.
    }

    try {
      const res = await runWorkerOnce(
        { op: 'globalSearch', roots: params.roots, query: params.query, opts: o, caps, cancelBuf },
        {
          onHits: (hits) => { if (!isCancelled() && params.onHits) params.onHits(hits); },
          onProgress: (p) => { if (!isCancelled() && params.onProgress) params.onProgress(p); },
        },
      );
      return {
        total: (res && res.total) || 0,
        files: (res && res.files) || 0,
        scanned: (res && res.scanned) || 0,
        capped: !!(res && res.capped),
        cancelled: isCancelled(),
        error: '',
      };
    } catch (err) {
      return {
        total: 0,
        files: 0,
        scanned: 0,
        capped: false,
        cancelled: isCancelled(),
        error: String((err && err.message) || err),
      };
    }
  })();

  return { ok: true, cancel, promise };
}

module.exports = {
  detectRipgrep,
  gsxMaskPred,
  walkProjectFiles,
  listFiles,
  searchProject,
  startGlobalSearch,
  GSX_DEFAULTS,
};
