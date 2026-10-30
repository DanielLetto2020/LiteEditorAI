// Тесты потокового ZIP-писателя («Скачать папку как ZIP» в «Удалённых хостах»).
// Архив проверяется независимым распаковщиком (unzip из системы), а не нашим же чтением:
// ошибка в заголовках, которую мы сами прочли бы «правильно», у человека даёт битый архив.
// Отдельно — откат файла, оборвавшегося посреди передачи: архив обязан остаться целым без него.
// Запуск: node test/zipwrite.test.js  (без зависимостей; без unzip в PATH тест пропускается).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { Readable } = require('stream');
const { ZipWriter } = require('../lib/zipwrite');

const hasUnzip = cp.spawnSync('unzip', ['-v']).status === 0;
if (!hasUnzip) { console.log('zipwrite: unzip не найден — пропуск'); process.exit(0); }

const feedOf = (buf, chunk = 7000) => (sink) => new Promise((res, rej) => {
  const parts = []; for (let i = 0; i < buf.length; i += chunk) parts.push(buf.subarray(i, i + chunk));
  const rs = Readable.from(parts);
  rs.on('error', rej); sink.on('error', rej); sink.on('finish', res);
  rs.pipe(sink);
});
// источник, падающий посреди передачи (как FTP с оборванным каналом)
const brokenFeed = (sink) => new Promise((res, rej) => {
  sink.write(crypto.randomBytes(50000));
  setTimeout(() => { const e = new Error('обрыв'); sink.destroy(e); rej(e); }, 10);
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-zip-'));
  try {
    const file = path.join(dir, 'a.zip');
    const text = Buffer.from('привет, архив\n'.repeat(1000), 'utf8');
    const bin = crypto.randomBytes(300000);
    const z = await ZipWriter.create(file);
    await z.addDir('site', Date.UTC(2024, 0, 2));
    await z.addFile('site/index.html', Date.now(), text.length, feedOf(text));
    await assert.rejects(z.addFile('site/broken.bin', Date.now(), 999999, brokenFeed), /обрыв/);
    await z.addFile('site/data.bin', Date.now(), bin.length, feedOf(bin));
    await z.addDir('site/пустая', Date.now());
    await z.addFile('site/пустой.txt', Date.now(), 0, feedOf(Buffer.alloc(0)));
    // подсказка размера ≥ 4 ГБ — запись уходит в ZIP64 (на маленьких данных проверяем формат)
    await z.addFile('site/big.bin', Date.now(), 0xFFFFFFFF + 10, feedOf(bin));
    await z.finish();

    const t = cp.spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.strictEqual(t.status, 0, 'unzip -t: ' + t.stdout + t.stderr);
    assert.ok(!/broken\.bin/.test(t.stdout), 'оборвавшийся файл не должен попасть в архив');

    const out = path.join(dir, 'out');
    assert.strictEqual(cp.spawnSync('unzip', ['-q', file, '-d', out]).status, 0);
    assert.ok(fs.readFileSync(path.join(out, 'site/index.html')).equals(text));
    assert.ok(fs.readFileSync(path.join(out, 'site/data.bin')).equals(bin));
    assert.ok(fs.readFileSync(path.join(out, 'site/big.bin')).equals(bin));
    assert.strictEqual(fs.statSync(path.join(out, 'site/пустой.txt')).size, 0);
    assert.ok(fs.statSync(path.join(out, 'site/пустая')).isDirectory());

    // пустой архив (папка без файлов) — тоже валидный
    const empty = path.join(dir, 'e.zip');
    const ze = await ZipWriter.create(empty);
    await ze.addDir('x', null);
    await ze.finish();
    assert.strictEqual(cp.spawnSync('unzip', ['-t', empty]).status, 0);
    console.log('zipwrite: ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
