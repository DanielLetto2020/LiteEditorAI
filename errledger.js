// LiteEditor — реестр ошибок (errors ledger). Действенный слой над firehose-логом:
// только WARN/ERROR/FATAL, СХЛОПНУТЫЕ по сигнатуре в записи со статусом open|resolved|ignored.
// Решает «агент чинит по логам, но никак не отмечает»: статус правят и человек (UI), и агент
// (редактирует errors.json по схеме из CLAUDE.md — редактор fs.watch-ит каталог и отражает живьём).
//
// Грузится напрямую через require (НЕ бандлится), как logger.js — правки применяются на след. запуске.
// Питается из logger.write() (см. logger.js). Сам НИКОГДА не логирует → нет рекурсии с логгером.
// Запись — атомарная (tmp + rename), debounce; внешние правки (агент) подхватываются watch() каталога.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 600;          // потолок; сверх — режем не-open и старые по lastSeen
const WRITE_DEBOUNCE_MS = 700;

let file = null;
let data = { version: 1, entries: {} };
let currentProject = null;        // путь активного проекта — тег для новых ошибок (лучшая догадка)
let lastWritten = '';             // что мы сами записали — чтобы отличать свою запись от внешней
let writeTimer = null;
let watcher = null;
let reloadTimer = null;
const changeCbs = [];

// Сигнатура схлопывает «один класс ошибки» в одну запись: глушим волатильные части
// (пути, хеши, числа), чтобы 20 одинаковых падений = 1 запись с count, а не 20 строк.
function mask(s) {
  return String(s == null ? '' : s)
    .replace(/[A-Za-z]:\\[^\s'"]+/g, 'PATH')   // windows-пути
    .replace(/\/[^\s'"]+/g, 'PATH')            // unix-пути
    .replace(/\b[0-9a-f]{7,}\b/gi, 'HEX')      // хеши/сиды/идентификаторы
    .replace(/\d+/g, '#')                      // числа
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
function sigOf(source, level, message) { return `${source}|${level}|${mask(message)}`; }
function idOf(sig) { return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 10); }
function serialize() { return JSON.stringify(data); }
function fireChange() { for (const cb of changeCbs) { try { cb(); } catch (_) {} } }

function init(dir) {
  file = path.join(dir, 'errors.json');
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.entries) { data = parsed; lastWritten = raw; }
    }
  } catch (_) { data = { version: 1, entries: {} }; }
  if (!data.entries) data.entries = {};
  return module.exports;
}

// Тег проекта для новых ошибок (рендерер шлёт при смене активного проекта).
function setContext(p) { currentProject = p || null; }

function flush() {
  if (!file) return;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    const str = serialize();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, str);
    fs.renameSync(tmp, file);     // атомарно: читатель видит либо старое, либо новое
    lastWritten = str;
  } catch (_) {}
}
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush(); fireChange(); }, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) writeTimer.unref();
}

function enforceCap() {
  const ids = Object.keys(data.entries);
  if (ids.length <= MAX_ENTRIES) return;
  const arr = ids.map((id) => data.entries[id]).sort((a, b) => {
    const rank = (e) => (e.status === 'open' ? 1 : 0); // не-open кандидаты на удаление первыми
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.lastSeen - b.lastSeen;                     // затем самые старые
  });
  const over = ids.length - MAX_ENTRIES;
  for (let i = 0; i < over; i++) delete data.entries[arr[i].id];
}

// Вызывается из logger.write() на каждый warn/error/fatal. Дёшево и не бросает.
function record(rec = {}) {
  if (!file) return;
  const lvl = String(rec.level || '').toLowerCase();
  if (lvl !== 'warn' && lvl !== 'error' && lvl !== 'fatal') return;
  const msg = String(rec.message == null ? '' : rec.message);
  const src = rec.source || 'main';
  const id = idOf(sigOf(src, lvl, msg));
  const now = Date.now();
  let e = data.entries[id];
  if (!e) {
    e = data.entries[id] = { id, sig: sigOf(src, lvl, msg), level: lvl, source: src, sample: msg.slice(0, 600),
      project: currentProject, firstSeen: now, lastSeen: now, count: 0, status: 'open',
      note: null, commit: null, resolvedAt: null, regressed: false };
  }
  e.count++; e.lastSeen = now; e.sample = msg.slice(0, 600); e.level = lvl;
  if (currentProject) e.project = currentProject;
  if (e.status === 'resolved') { e.status = 'open'; e.regressed = true; e.resolvedAt = null; } // регрессия
  enforceCap();
  scheduleWrite();
}

function list() {
  const entries = Object.values(data.entries).sort((a, b) => b.lastSeen - a.lastSeen);
  return { entries, open: entries.filter((e) => e.status === 'open').length };
}
function setStatus(id, status, note, commit) {
  const e = data.entries[id];
  if (!e) return { ok: false, error: 'запись не найдена' };
  if (!['open', 'resolved', 'ignored'].includes(status)) return { ok: false, error: 'bad status' };
  e.status = status;
  if (status === 'resolved') {
    e.resolvedAt = Date.now(); e.regressed = false;
    if (note != null) e.note = String(note).slice(0, 500);
    if (commit != null) e.commit = String(commit).slice(0, 80);
  } else if (status === 'open') { e.resolvedAt = null; }
  flush(); fireChange();
  return { ok: true };
}
function clearResolved() {
  let n = 0;
  for (const id of Object.keys(data.entries)) if (data.entries[id].status !== 'open') { delete data.entries[id]; n++; }
  flush(); fireChange();
  return { ok: true, removed: n };
}

// Внешняя правка (агент отредактировал errors.json) — перечитать и отразить.
function reloadExternal() {
  if (!file) return;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw === lastWritten) return; // это была наша же запись
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries) { data = parsed; lastWritten = raw; fireChange(); }
  } catch (_) {}
}
// Сторожим КАТАЛОГ, а не файл: атомарный rename меняет inode и сбивает watch файла.
function watch() {
  if (!file || watcher) return;
  try {
    watcher = fs.watch(path.dirname(file), (_evt, fn) => {
      if (fn && fn !== 'errors.json') return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadExternal, 200);
      if (reloadTimer.unref) reloadTimer.unref();
    });
  } catch (_) {}
}
function onChange(cb) { if (typeof cb === 'function') changeCbs.push(cb); }

module.exports = { init, setContext, record, list, setStatus, clearResolved, flush, watch, onChange };
