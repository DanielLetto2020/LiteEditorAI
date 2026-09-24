// Тест локальной истории (lib/history.js): троттл до чтения файла, дедуп, ротация и общая чистка
// (срок, пропавшие файлы, потолок объёма). Запуск: node test/history.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistory, key } = require('../lib/history');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const DAY = 86400000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
const store = path.join(root, 'store');
const proj = path.join(root, 'proj');
fs.mkdirSync(proj);

// Счётчик чтений исходного файла: троттл должен срабатывать ДО readFile.
const realRead = fs.promises.readFile;
let reads = 0;
let watched = null;
fs.promises.readFile = function (p, ...rest) { if (p === watched) reads++; return realRead.call(this, p, ...rest); };

(async () => {
  // Настоящие часы: mtime файлов на диске должны быть сравнимы с clock (так поймали «омоложение»
  // каталога свежим meta.json).
  let clock = Date.now();
  const h = createHistory({ dir: store, now: () => clock, maxPerFile: 3 });
  const f = path.join(proj, 'app.log');
  watched = f;

  // --- первый снимок пишется ---
  fs.writeFileSync(f, 'v1');
  ok(await h.snapshotFromDisk(f, 'ext') === true, 'первый снимок записан');
  ok(reads === 1, 'файл прочитан один раз: ' + reads);

  // --- внутри окна троттла файл не читается вовсе ---
  fs.writeFileSync(f, 'v2');
  clock += 5000;
  ok(await h.snapshotFromDisk(f, 'ext') === false, 'через 5 с снимок не нужен');
  ok(reads === 1, 'троттл сработал до чтения файла: чтений ' + reads);

  // --- после окна: читается и пишется ---
  clock += 20000;
  ok(await h.snapshotFromDisk(f, 'ext') === true, 'через 25 с снимок записан');
  // --- дедуп: то же содержимое — нового снимка нет ---
  clock += 20000;
  ok(await h.snapshotFromDisk(f, 'ext') === false, 'неизменённый файл не снимается повторно');

  // --- ротация по maxPerFile ---
  for (let i = 3; i <= 6; i++) { clock += 20000; fs.writeFileSync(f, 'v' + i); await h.snapshotFromDisk(f, 'ext'); }
  await new Promise((r) => setTimeout(r, 50));   // unlink ротации идёт без await
  const items = await h.list(f);
  ok(items.length === 3, 'ротация оставила 3 версии: ' + items.length);
  ok(await h.read(f, items[0].name) === 'v6', 'последняя версия читается');
  await assert.rejects(() => h.read(f, '../../etc/passwd'), /bad name/); passed++;

  // --- снимок переданного текста (замена по проекту) уважает тот же троттл ---
  ok(await h.snapshot(f, 'другое', 'ext') === false, 'snapshot() внутри окна троттла — пропуск');

  // --- force (откат к версии из истории): мимо троттла, но не мимо дедупа; часы стоят на месте ---
  ok(await h.snapshot(f, 'другое', 'save', { force: true }) === true, 'force-снимок внутри окна троттла записан');
  ok(await h.snapshot(f, 'другое', 'save', { force: true }) === false, 'force не отменяет дедуп');
  fs.writeFileSync(f, 'v7');
  ok(await h.snapshotFromDisk(f, 'save', { force: true }) === true, 'force-снимок с диска в ту же миллисекунду записан');
  await new Promise((r) => setTimeout(r, 50));   // unlink ротации идёт без await
  const forced = await h.list(f);
  ok(forced.length === 3 && forced[0].ts > forced[1].ts && forced[1].ts > forced[2].ts,
    'снимки одной миллисекунды не затёрли друг друга: ' + forced.map((x) => x.name).join(', '));
  ok(await h.read(f, forced[0].name) === 'v7' && await h.read(f, forced[1].name) === 'другое', 'порядок снимков сохранён');

  // --- чистка ---
  const mk = (absFile, ageMs, bytes) => {
    const d = path.join(store, key(absFile));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${clock - ageMs}-save.snap`), 'x'.repeat(bytes));
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ file: absFile }));
    return d;
  };
  const alive = path.join(proj, 'alive.txt'); fs.writeFileSync(alive, 'a');
  const old = mk(alive, 40 * DAY, 10);                        // старше 30 дней → удалить
  const fresh = mk(path.join(proj, 'fresh.txt'), 1 * DAY, 10); // файла нет, но свежий → держать неделю
  const gone = mk(path.join(proj, 'gone.txt'), 10 * DAY, 10);  // файла нет и старше недели → удалить
  const alive2 = path.join(proj, 'alive2.txt'); fs.writeFileSync(alive2, 'b');
  const keep = mk(alive2, 0, 10);                               // жив и свежий — остаётся
  fs.mkdirSync(path.join(store, 'not-a-history-dir'));         // чужой каталог не трогаем

  const r1 = await h.prune();
  ok(!fs.existsSync(old), 'каталог старше срока удалён');
  ok(!fs.existsSync(gone), 'история пропавшего файла старше недели удалена');
  ok(fs.existsSync(fresh), 'история пропавшего файла моложе недели сохранена');
  ok(fs.existsSync(keep), 'живой свежий каталог сохранён');
  ok(fs.existsSync(path.join(store, 'not-a-history-dir')), 'посторонний каталог не тронут');
  ok(r1.removed === 2, 'удалено ровно два каталога: ' + r1.removed);

  // --- потолок объёма: самые давно не менявшиеся уходят первыми ---
  const hc = createHistory({ dir: store, now: () => clock, maxTotalBytes: 2500 });
  const a = mk(path.join(proj, 'a'), 3 * 3600000, 1000);
  mk(path.join(proj, 'b'), 2 * 3600000, 1000);
  const c = mk(path.join(proj, 'c'), 1 * 3600000, 1000);
  fs.writeFileSync(path.join(proj, 'a'), ''); fs.writeFileSync(path.join(proj, 'b'), ''); fs.writeFileSync(path.join(proj, 'c'), '');
  const r2 = await hc.prune();
  ok(r2.keptBytes <= 2500, 'после чистки объём в потолке: ' + r2.keptBytes);
  ok(!fs.existsSync(a), 'самый старый по изменению каталог удалён первым');
  ok(fs.existsSync(c), 'самый свежий каталог остался');

  fs.promises.readFile = realRead;
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`history: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
