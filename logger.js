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
// Сегодняшний файл потолок объёма не режет (живая сессия), поэтому у него свой предел: зацикленная
// ошибка в любом окне (console-message, log:renderer, unhandledrejection) иначе растила его до
// заполнения диска. Сверх потолка пишем только fatal. И предел на строку: рендерер может прислать
// многомегабайтную строку (вывод терминала, ответ модели в ошибке) — в лог нужно начало, а не всё.
const MAX_DAY_BYTES = 50 * 1024 * 1024;
const MAX_LINE_CHARS = 16 * 1024;
// matches both the structured log (lite-) and the raw launcher capture (launch-)
const FILE_RE = /^(lite|launch)-\d{4}-\d{2}-\d{2}\.log$/;

let logDir = null;
let dirReady = false;   // каталог логов уже создан — mkdir не на каждую строку

// Предохранители от петель записи. 17–23.07.2026 диск заполнился: файл лога и перенаправленный
// лаунчером stderr отвечали ENOSPC, и логгер 2,6 млн раз писал об ошибке записи — каждой такой
// записью порождая следующую (механика — у guardStdStreams). Сбойный канал теперь отдыхает.
const PAUSE_MS = 60 * 1000;
let fileOffUntil = 0;   // файл лога не трогаем до этого момента
let stdOffUntil = 0;    // запасной stderr — тоже
let dayFile = '', dayBytes = 0, dayCapNoted = false;   // учёт объёма сегодняшнего файла (MAX_DAY_BYTES)

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
  let body = parts.map(fmt).join(' ');
  if (body.length > MAX_LINE_CHARS) body = body.slice(0, MAX_LINE_CHARS) + ` … [обрезано ${body.length - MAX_LINE_CHARS} символов]`;
  const line = `${ts()} [${String(level).toUpperCase()}] [${src}] ${body}\n`;
  // Питаем реестр ошибок (warn/error/fatal схлопываются по сигнатуре). Не должно влиять на
  // запись лога и не должно бросать — реестр сам глушит ошибки.
  const lvl = String(level).toLowerCase();
  if (lvl === 'warn' || lvl === 'error' || lvl === 'fatal') {
    try { errledger.record({ level: lvl, source: src, message: body }); } catch (_) {}
  }
  if (!logDir) return line;
  const now = Date.now();
  let note = '';
  if (now >= fileOffUntil) {
    try {
      if (!dirReady) { fs.mkdirSync(logDir, { recursive: true }); dirReady = true; }
      const file = logPath();
      if (file !== dayFile) {   // новый день или первый вызов: сколько уже лежит в файле
        dayFile = file; dayCapNoted = false;
        try { dayBytes = fs.statSync(file).size; } catch (_) { dayBytes = 0; }
      }
      if (dayBytes >= MAX_DAY_BYTES && lvl !== 'fatal') {
        if (!dayCapNoted) {
          dayCapNoted = true;
          const cap = `${ts()} [WARN] [logger] лог за сегодня достиг ${Math.round(MAX_DAY_BYTES / 1048576)} МБ — дальше до полуночи пишутся только fatal\n`;
          fs.appendFileSync(file, cap); dayBytes += Buffer.byteLength(cap);
        }
        return line;
      }
      fs.appendFileSync(file, line);
      dayBytes += Buffer.byteLength(line);
      return line;
    } catch (e) {
      dirReady = false;
      fileOffUntil = now + PAUSE_MS;
      note = `[logger] write failed (${e && e.message}); file log paused for ${PAUSE_MS / 1000}s\n`;
    }
  }
  // Файл недоступен — не теряем диагностику: пишем в stderr (сырой лог лаунчера). NOT console.error:
  // wrapConsole() вернул бы строку сюда же, в тот же сбой. Ошибка stderr приходит событием и
  // выключает его на паузу (слушатель в guardStdStreams); синхронный бросок — так же.
  if (now >= stdOffUntil) {
    try { process.stderr.write(note + line); } catch (_) { stdOffUntil = now + PAUSE_MS; }
  }
  return line;
}

// Слушатели 'error' на stdout/stderr. В главном процессе Electron stderr после ошибки записи НЕ
// разрушается: каждая следующая запись снова поднимает 'error' на следующем тике. Без слушателя
// это uncaughtException → обработчик ниже пишет fatal → файл не пишется → stderr → снова 'error'.
// Проверено в test/logger.test.js: одно исключение превращалось в ~15 000 в секунду.
function guardStdStreams() {
  for (const s of [process.stdout, process.stderr]) {
    try {
      if (s && typeof s.on === 'function') s.on('error', () => { if (s === process.stderr) stdOffUntil = Date.now() + PAUSE_MS; });
    } catch (_) {}
  }
}

// Одна и та же беда на каждом тике не должна превращаться в миллионы строк: одинаковые исключения
// пишем не чаще раза в секунду, число пропущенных — отдельной строкой info (в реестр ошибок она
// не идёт и сигнатуру записи не меняет).
function repeatGate(label, level) {
  let lastSig = '', lastAt = 0, skipped = 0;
  return (err) => {
    const sig = String((err && err.stack) || err).slice(0, 2000);
    const now = Date.now();
    if (sig === lastSig && now - lastAt < 1000) { skipped++; return; }
    if (skipped) write('info', 'main', [`${label}: предыдущее повторилось ещё ${skipped} раз`]);
    lastSig = sig; lastAt = now; skipped = 0;
    write(level, 'main', [label, err]);
  };
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
  guardStdStreams();
  process.on('uncaughtException', repeatGate('uncaughtException', 'fatal'));
  process.on('unhandledRejection', repeatGate('unhandledRejection', 'error'));
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
