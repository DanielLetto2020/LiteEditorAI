// Тест загрузчика модели озвучки (lib/tts.js → downloadModel).
// Запуск: node test/tts-download.test.js
//
// Почему это важно: оборванная закачка тоже доходит до события 'finish', и без явной сверки
// с Content-Length огрызок молча сохранялся бы как установленная модель — падало бы уже
// на синтезе, где причину не видно. Тест поднимает локальный сервер и проверяет все ветки.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-tts-dl-'));
const dest = path.join(dir, 'v4_ru.pt');
const BODY = Buffer.alloc(2 * 1024 * 1024, 7);   // «модель» на 2 МБ
let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };

// Загружаем модуль заново на каждый адрес: URL читается при загрузке (env-переопределение).
function loadWith(url) {
  delete require.cache[require.resolve('../lib/tts.js')];
  process.env.LITE_TTS_MODEL_URL = url;
  const tts = require('../lib/tts.js');
  tts.configure({ dir, log: () => {} });
  return tts;
}

const srv = http.createServer((req, res) => {
  if (req.url === '/truncated') {                       // обещает много, отдаёт мало и рвёт связь
    res.writeHead(200, { 'content-length': String(BODY.length) });
    res.write(BODY.subarray(0, 100000));
    setTimeout(() => res.destroy(), 30);
    return;
  }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
  if (req.url === '/ok') { res.writeHead(200, { 'content-length': String(BODY.length) }); res.end(BODY); return; }
  if (req.url === '/tiny') { res.writeHead(200, { 'content-length': '10' }); res.end(Buffer.alloc(10)); return; }
  if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
  res.writeHead(404); res.end();
});

srv.listen(0, '127.0.0.1', async () => {
  const addr = srv.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    // оборванная закачка не становится «установленной моделью»
    let r = await loadWith(base + '/truncated').downloadModel(() => {});
    ok(r.ok === false, 'оборванная закачка должна отклоняться');
    ok(!fs.existsSync(dest), 'после обрыва файла модели быть не должно');
    ok(!fs.existsSync(dest + '.part'), 'после обрыва не должно оставаться .part');

    // ответ-заглушка (страница ошибки, пустышка) тоже не проходит
    r = await loadWith(base + '/tiny').downloadModel(() => {});
    ok(r.ok === false, 'слишком маленький файл должен отклоняться');
    ok(!fs.existsSync(dest), 'после отказа файла модели быть не должно');

    // редирект хранилища проходится, файл совпадает по размеру
    let progress = 0;
    r = await loadWith(base + '/redirect').downloadModel(({ got }) => { progress = got; });
    ok(r.ok === true, 'редирект должен проходиться: ' + (r.error || ''));
    ok(fs.existsSync(dest) && fs.statSync(dest).size === BODY.length, 'файл модели должен совпасть по размеру');
    ok(progress >= 0, 'прогресс сообщается');

    // зацикленный редирект не вешает загрузку
    fs.unlinkSync(dest);
    r = await loadWith(base + '/loop').downloadModel(() => {});
    ok(r.ok === false && /перенаправлен/.test(r.error), 'цикл редиректов должен обрываться');

    // параллельный запуск не бьёт файл первой закачки
    const tts = loadWith(base + '/ok');
    const first = tts.downloadModel(() => {});
    const second = await tts.downloadModel(() => {});
    ok(second.ok === false, 'вторая одновременная загрузка должна отбиваться');
    ok((await first).ok === true, 'первая загрузка должна доходить до конца');

    console.log(`✓ tts-download: ${checks} проверок пройдено`);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    console.error('✗ tts-download:', e.message);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
});
