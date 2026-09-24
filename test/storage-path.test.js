// Тест безопасности: safeRelSegments не даёт ключу объекта увести «Скачать папку» за пределы
// выбранного каталога. Ключ в бакете — произвольная строка (в т.ч. из чужого/публичного бакета),
// поэтому '..' и сепараторы в нём — не путь, а данные.
// Запуск: node test/storage-path.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const path = require('path');
const { safeRelSegments } = require('../lib/safe-name');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
const join = (rel) => path.join('/dest', ...safeRelSegments(rel));
const inside = (rel) => { const p = join(rel); return p === '/dest' || p.startsWith('/dest' + path.sep); };

// --- Нормальные ключи не ломаются ---
assert.deepStrictEqual(safeRelSegments('a/b/c.txt'), ['a', 'b', 'c.txt']); passed++;
assert.deepStrictEqual(safeRelSegments('file.txt'), ['file.txt']); passed++;
assert.deepStrictEqual(safeRelSegments('a//b'), ['a', 'b']); passed++;           // пустые сегменты
assert.deepStrictEqual(safeRelSegments('папка/файл.md'), ['папка', 'файл.md']); passed++;
assert.deepStrictEqual(safeRelSegments('.hidden/x'), ['.hidden', 'x']); passed++; // скрытый — обычное имя
assert.deepStrictEqual(safeRelSegments('a/...b/c'), ['a', '...b', 'c']); passed++; // три точки — легальное имя

// --- Traversal обезврежен ---
assert.deepStrictEqual(safeRelSegments('../../etc/passwd'), ['etc', 'passwd']); passed++;
assert.deepStrictEqual(safeRelSegments('a/../../b'), ['a', 'b']); passed++;
assert.deepStrictEqual(safeRelSegments('./x'), ['x']); passed++;
ok(inside('../../../../home/user/.bashrc'), 'глубокий traversal остаётся внутри каталога');
ok(inside('..'), 'ключ из одного «..»');
ok(inside('../'), 'traversal с хвостовым слешем');
ok(inside('a/../../../../../../tmp/pwn'), 'traversal вперемешку с именами');

// --- Windows-специфика: обратный слеш и двоеточие внутри сегмента ---
assert.deepStrictEqual(safeRelSegments('a\\..\\..\\b'), ['a_.._.._b']); passed++;
assert.deepStrictEqual(safeRelSegments('C:/x'), ['C_', 'x']); passed++;          // диск-относительный путь
ok(!safeRelSegments('a\\b').some((s) => s.includes('\\')), 'обратных слешей в сегментах не остаётся');

// --- Вырожденные ключи не пишут в саму папку ---
assert.deepStrictEqual(safeRelSegments(''), ['object']); passed++;
assert.deepStrictEqual(safeRelSegments('///'), ['object']); passed++;
assert.deepStrictEqual(safeRelSegments('../..'), ['object']); passed++;
ok(join('') !== '/dest', 'пустой ключ не даёт путь самого каталога');

// --- NUL-байт вырезается ---
ok(!safeRelSegments('a\0b/c').some((s) => s.includes('\0')), 'NUL-байт удалён');

// --- Скачивание объекта не трогает уже лежащий локальный файл, пока объект не докачан целиком ---
// Раньше любая ошибка (404/403/обрыв/отмена) делала unlink(destPath) — даже до записи первого байта,
// и файл человека с тем же именем пропадал. Заглушка S3 API на 127.0.0.1 (без сети и реального S3).
const http = require('http');
const fs = require('fs');
const os = require('os');
const s3 = require('../lib/storage-s3');

(async () => {
  const srv = http.createServer((req, res) => {
    if (req.url.includes('missing')) { res.writeHead(404, { 'content-type': 'application/xml' }); res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>no</Message></Error>'); return; }
    if (req.url.includes('slow')) { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000000' }); res.write(Buffer.alloc(65536, 1)); return; }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' }); res.end('hello');
  });
  await new Promise((r) => { srv.listen(0, '127.0.0.1', () => r(null)); });
  const client = s3.makeClient({ endpoint: 'http://127.0.0.1:' + /** @type {import('net').AddressInfo} */ (srv.address()).port, forcePathStyle: true, accessKeyId: 'a', secret: 'b', region: 'us-east-1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-'));
  const dest = path.join(dir, 'report.txt');
  const settle = (p) => p.then(() => 'ok', (e) => e.message);
  try {
    fs.writeFileSync(dest, 'PRECIOUS');
    ok(await settle(s3.download(client, { bucket: 'b', key: 'missing', destPath: dest, onProgress: null }).done) !== 'ok', '404 — ошибка');
    ok(fs.readFileSync(dest, 'utf8') === 'PRECIOUS', '404 не удалил существующий файл');

    const early = s3.download(client, { bucket: 'b', key: 'ok', destPath: dest, onProgress: null });
    early.abort();
    ok(await settle(early.done) !== 'ok', 'ранняя отмена — ошибка');
    ok(fs.readFileSync(dest, 'utf8') === 'PRECIOUS', 'ранняя отмена не удалила существующий файл');

    const mid = s3.download(client, { bucket: 'b', key: 'slow', destPath: dest, onProgress: () => mid.abort() });
    ok(await settle(mid.done) !== 'ok', 'отмена посреди потока — ошибка');
    ok(fs.readFileSync(dest, 'utf8') === 'PRECIOUS', 'отмена посреди потока не обрезала существующий файл');

    ok(await settle(s3.download(client, { bucket: 'b', key: 'ok', destPath: dest, onProgress: null }).done) === 'ok', 'успешное скачивание');
    ok(fs.readFileSync(dest, 'utf8') === 'hello', 'успешное скачивание заменило файл');
    assert.deepStrictEqual(fs.readdirSync(dir), ['report.txt']); passed++; // временных .part не осталось
  } finally {
    client.destroy();
    srv.close();
    if (srv.closeAllConnections) srv.closeAllConnections();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`✓ storage-path: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
