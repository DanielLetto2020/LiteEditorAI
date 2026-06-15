// LiteEditor — file logger for the main process.
// Writes timestamped lines to <dir>/lite-YYYY-MM-DD.log (one file per day),
// keeps only the last RETENTION_DAYS days, and installs process-level crash
// hooks. Loaded directly via require (NOT bundled), so edits apply on the next
// launch. Crash-safe by design: every line is flushed with appendFileSync, so
// the last line before a hard exit is never lost. The renderer forwards its own
// errors here over IPC ('log:renderer'); native (C++) crashes that bypass JS —
// e.g. a GPU/renderer process abort — are reported by main.js via Electron's
// child-process-gone / render-process-gone events plus crashReporter minidumps.
const fs = require('fs');
const path = require('path');
const errledger = require('./errledger'); // реестр ошибок питается отсюда (см. write())

const RETENTION_DAYS = 5;
// Суммарный потолок на все лог-файлы: даже если за день логов много или машина не
// перезапускалась, каталог не разрастается бесконтрольно. Сверх — режем самые старые.
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // перепрунинг каждые 6 ч (а не только на старте)
// matches both the structured log (lite-) and the raw launcher capture (launch-)
const FILE_RE = /^(lite|launch)-\d{4}-\d{2}-\d{2}\.log$/;

let logDir = null;

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function dayStamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function ts(d = new Date()) {
  return `${dayStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function logPath() { return path.join(logDir, `lite-${dayStamp()}.log`); }

function fmt(a) {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  if (a === undefined) return 'undefined';
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}

// One log line. Synchronous append guarantees durability right before a crash.
function write(level, src, parts) {
  const body = parts.map(fmt).join(' ');
  const line = `${ts()} [${String(level).toUpperCase()}] [${src}] ${body}\n`;
  // Питаем реестр ошибок (warn/error/fatal схлопываются по сигнатуре). Не должно влиять на
  // запись лога и не должно бросать — реестр сам глушит ошибки.
  const lvl = String(level).toLowerCase();
  if (lvl === 'warn' || lvl === 'error' || lvl === 'fatal') {
    try { errledger.record({ level: lvl, source: src, message: body }); } catch (_) {}
  }
  if (logDir) {
    try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(logPath(), line); }
    // If the log dir is unwritable at runtime, don't silently lose crash diagnostics —
    // emit to stderr (the raw launcher capture). NOT console.error: wrapConsole() routes
    // that back through write(), which would recurse on the same failure.
    catch (e) { try { process.stderr.write(`[logger] write failed (${e && e.message}); line: ${line}`); } catch (_) {} }
  }
  return line;
}

// Drop log files older than the retention window (by mtime, robust to clock skew),
// then enforce the total-size cap by deleting the oldest survivors until under budget.
// Never deletes today's file (it's the live session). Idempotent — safe on a timer.
function prune() {
  if (!logDir) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const today = `lite-${dayStamp()}.log`;
  const launchToday = `launch-${dayStamp()}.log`;
  try {
    let surviving = [];
    for (const f of fs.readdirSync(logDir)) {
      if (!FILE_RE.test(f)) continue;
      const fp = path.join(logDir, f);
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      if (st.mtimeMs < cutoff && f !== today && f !== launchToday) { try { fs.unlinkSync(fp); continue; } catch (_) {} }
      surviving.push({ f, fp, size: st.size, mtime: st.mtimeMs });
    }
    // Size cap: oldest first, but keep today's files regardless.
    let total = surviving.reduce((s, x) => s + x.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      surviving.sort((a, b) => a.mtime - b.mtime);
      for (const x of surviving) {
        if (total <= MAX_TOTAL_BYTES) break;
        if (x.f === today || x.f === launchToday) continue;
        try { fs.unlinkSync(x.fp); total -= x.size; } catch (_) {}
      }
    }
  } catch (_) {}
}

// Tee console.* into the log so existing console output is persisted too, while
// still echoing to the terminal/journal (the original behaviour).
function wrapConsole() {
  for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...args) => { try { orig(...args); } catch (_) {} write(m === 'log' ? 'info' : m, 'main', args); };
  }
}

function init(dir) {
  logDir = dir;
  prune();
  // Перепрунинг по таймеру: на старте мало (машина может работать сутками). unref —
  // таймер не держит процесс живым и не мешает выходу.
  try { const t = setInterval(prune, PRUNE_INTERVAL_MS); if (t.unref) t.unref(); } catch (_) {}
  wrapConsole();
  process.on('uncaughtException', (err) => write('fatal', 'main', ['uncaughtException', err]));
  process.on('unhandledRejection', (reason) => write('error', 'main', ['unhandledRejection', reason]));
  write('info', 'logger', [`started → ${logPath()} (retention ${RETENTION_DAYS}d)`]);
  return module.exports;
}

module.exports = {
  init,
  // structured logging from the main process: log('info'|'warn'|'error'|'fatal', ...)
  log: (level, ...args) => write(level, 'main', args),
  // logging forwarded from the renderer over IPC
  renderer: (level, ...args) => write(level || 'info', 'renderer', args),
  // Удалить один лог-файл (валидация по FILE_RE — без path-traversal).
  removeFile: (name) => {
    if (!logDir || !FILE_RE.test(String(name || ''))) return false;
    try { fs.unlinkSync(path.join(logDir, name)); return true; } catch (_) { return false; }
  },
  // Очистить все логи КРОМЕ сегодняшних (живую сессию не трогаем). Возвращает число удалённых.
  clearOld: () => {
    if (!logDir) return 0;
    const today = `lite-${dayStamp()}.log`, lt = `launch-${dayStamp()}.log`;
    let n = 0;
    try {
      for (const f of fs.readdirSync(logDir)) {
        if (!FILE_RE.test(f) || f === today || f === lt) continue;
        try { fs.unlinkSync(path.join(logDir, f)); n++; } catch (_) {}
      }
    } catch (_) {}
    return n;
  },
};
