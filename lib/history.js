// Локальная история файлов (как Local History в PhpStorm): снимки текстовых файлов в
// <dir>/<sha1(absPath)>/<ts>-<tag>.snap, рядом meta.json с исходным путём.
// Используется в main.js (fs:writeFile, вотчер проекта, hist:*); тесты — test/history.test.js.
//
// Точки съёма: 'save' — состояние ДО записи из вивера/замены по проекту, 'ext' — состояние ПОСЛЕ
// внешнего изменения (агент/git/другой редактор). Всё best-effort: ошибки истории глотаются.
// { force: true } — мимо троттла (но не мимо дедупа): перед разрушающим действием по воле человека
// (откат к версии из истории, замена по проекту) текущее состояние должно попасть в историю всегда.
//
// Два правила, ради которых код вынесен сюда:
//   • троттл проверяется ДО чтения файла. Раньше файл (до 2 МБ) читался и декодировался целиком,
//     а «снимок был 15 с назад» выяснялось потом — дописываемый лог в проекте перечитывался на
//     каждом событии вотчера (раз в 180 мс), автосейв вивера — каждые 400 мс;
//   • у истории есть общий срок и объём (prune). Ротация была только на файл (25 версий), и к
//     22.09.2026 каталог вырос до 919 МБ: логи, сборочные артефакты, файлы, которых уже нет.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^(\d{10,16})-(save|ext)\.snap$/;
const DAY = 86400000;
const DEFAULTS = {
  maxPerFile: 25,                        // ротация: столько версий держим на файл
  maxBytes: 2 * 1024 * 1024,             // крупнее — не снимаем (лимит вивера)
  minGapMs: { save: 45000, ext: 15000 }, // троттл на файл: серия автосейвов ≠ серия версий
  maxAgeMs: 30 * DAY,                    // prune: каталог, в который не писали дольше, удаляется
  goneGraceMs: 7 * DAY,                  // prune: файла на диске нет — историю держим ещё неделю (восстановить)
  maxTotalBytes: 300 * 1024 * 1024,      // prune: общий потолок; сверх — удаляем давно не менявшиеся
};

function key(absFile) { return crypto.createHash('sha1').update(String(absFile)).digest('hex').slice(0, 20); }

async function snapNames(dir) {
  try { return (await fs.promises.readdir(dir)).filter((n) => NAME_RE.test(n)).sort(); } catch (_) { return []; }
}

/**
 * @param {{ dir: string, maxPerFile?: number, maxBytes?: number, minGapMs?: Record<string, number>,
 *   maxAgeMs?: number, goneGraceMs?: number, maxTotalBytes?: number, now?: () => number }} opts
 */
function createHistory(opts) {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now || Date.now;
  const dirOf = (absFile) => path.join(o.dir, key(absFile));
  const gapOf = (tag) => o.minGapMs[tag] || 15000;

  // Свежий снимок уже есть — новый не нужен. По имени последнего снимка, без чтения файлов.
  function throttled(names, tag) {
    if (!names.length) return false;
    const m = NAME_RE.exec(names[names.length - 1]);
    return now() - Number(m[1]) < gapOf(tag);
  }

  async function write(dir, names, absFile, content, tag) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > o.maxBytes || content.includes('\0')) return false;
    if (names.length) {
      const prev = await fs.promises.readFile(path.join(dir, names[names.length - 1]), 'utf8').catch(() => null);
      if (prev === content) return false;   // дедуп: содержимое не изменилось
    }
    await fs.promises.mkdir(dir, { recursive: true });
    // Метка строго новее последней: два снимка в одну миллисекунду (force подряд — диск, затем
    // несохранённый текст) делили бы имя, и второй молча затирал бы первый.
    const last = names.length ? Number(NAME_RE.exec(names[names.length - 1])[1]) : 0;
    await fs.promises.writeFile(path.join(dir, `${Math.max(now(), last + 1)}-${tag}.snap`), content, 'utf8');
    fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ file: absFile }), 'utf8').catch(() => {});
    const all = await snapNames(dir);
    for (const n of all.slice(0, Math.max(0, all.length - o.maxPerFile))) fs.promises.unlink(path.join(dir, n)).catch(() => {});
    return true;
  }

  // Снимок переданного содержимого (замена по проекту уже держит текст в руках).
  async function snapshot(absFile, content, tag, { force = false } = {}) {
    try {
      const dir = dirOf(absFile);
      const names = await snapNames(dir);
      if (!force && throttled(names, tag)) return false;
      return await write(dir, names, absFile, content, tag);
    } catch (_) { return false; }
  }

  // Снимок файла с диска: сначала троттл, потом stat, и только потом чтение.
  async function snapshotFromDisk(absFile, tag, { force = false } = {}) {
    try {
      const dir = dirOf(absFile);
      const names = await snapNames(dir);
      if (!force && throttled(names, tag)) return false;
      const st = await fs.promises.stat(absFile);
      if (!st.isFile() || st.size > o.maxBytes) return false;
      return await write(dir, names, absFile, await fs.promises.readFile(absFile, 'utf8'), tag);
    } catch (_) { return false; }
  }

  async function list(absFile) {
    const dir = dirOf(absFile);
    const names = (await snapNames(dir)).reverse();
    return Promise.all(names.map(async (n) => {
      const m = NAME_RE.exec(n);
      let size = 0; try { size = (await fs.promises.stat(path.join(dir, n))).size; } catch (_) {}
      return { name: n, ts: Number(m[1]), tag: m[2], size };
    }));
  }

  async function read(absFile, name) {
    if (!NAME_RE.test(String(name || ''))) throw new Error('bad name');   // защита от traversal
    return fs.promises.readFile(path.join(dirOf(absFile), name), 'utf8');
  }

  // Общая чистка: срок, пропавшие файлы, потолок объёма. Идёт фоном, по одному каталогу за раз,
  // чтобы не забирать главный процесс. Возвращает сводку для лога.
  async function prune() {
    const t = now();
    const res = { dirs: 0, removed: 0, freedBytes: 0, keptBytes: 0 };
    let entries;
    try { entries = await fs.promises.readdir(o.dir, { withFileTypes: true }); } catch (_) { return res; }
    const alive = [];   // { dir, newest, bytes }
    const drop = async (d) => {
      await fs.promises.rm(d.dir, { recursive: true, force: true }).catch(() => {});
      res.removed++; res.freedBytes += d.bytes;
    };
    for (const ent of entries) {
      if (!ent.isDirectory() || !/^[0-9a-f]{20}$/.test(ent.name)) continue;
      res.dirs++;
      const dir = path.join(o.dir, ent.name);
      // Возраст — по меткам в именах снимков: meta.json переписывается при каждом снимке, и его
      // mtime в чистом каталоге «омолаживал» бы давно заброшенную историю. Снимков нет — по mtime.
      let newestSnap = 0, newestAny = 0, bytes = 0;
      let files;
      try { files = await fs.promises.readdir(dir); } catch (_) { continue; }
      for (const f of files) {
        try {
          const st = await fs.promises.stat(path.join(dir, f));
          bytes += st.size;
          newestAny = Math.max(newestAny, st.mtimeMs);
          const m = NAME_RE.exec(f);
          if (m) newestSnap = Math.max(newestSnap, Number(m[1]));
        } catch (_) {}
      }
      const newest = newestSnap || newestAny;
      const d = { dir, newest, bytes };
      const age = t - newest;
      if (age > o.maxAgeMs) { await drop(d); continue; }
      if (age > o.goneGraceMs) {
        let src = null;
        try { src = JSON.parse(await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8')).file; } catch (_) {}
        const exists = src ? await fs.promises.access(src).then(() => true, () => false) : true;
        if (!exists) { await drop(d); continue; }
      }
      alive.push(d);
    }
    let total = alive.reduce((s, d) => s + d.bytes, 0);
    if (total > o.maxTotalBytes) {
      alive.sort((a, b) => a.newest - b.newest);   // давно не менявшиеся — первыми
      for (const d of alive) {
        if (total <= o.maxTotalBytes) break;
        await drop(d); total -= d.bytes;
      }
    }
    res.keptBytes = total;
    return res;
  }

  return { snapshot, snapshotFromDisk, list, read, prune, dirOf };
}

module.exports = { createHistory, key, NAME_RE, DEFAULTS };
