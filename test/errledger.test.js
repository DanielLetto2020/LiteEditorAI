// Тест реестра ошибок: событие «реестр изменился» не должно подниматься на КАЖДУЮ повторную
// ошибку одной сигнатуры. Единственный подписчик шлёт сообщение в окно редактора, а неудачная
// отправка сама пишется в лог как ERROR и возвращается сюда — получался вечный цикл с записью
// errors.json каждые 0.7 с. Запуск: node test/errledger.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const errledger = require('../errledger');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errledger-'));
errledger.init(dir);

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

let fired = 0;
errledger.onChange(() => { fired++; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = 900;   // чуть больше дебаунса реестра (700 мс)

(async () => {
  // --- Новая сигнатура → событие поднимается ---
  errledger.record({ level: 'error', source: 'main', message: 'Error sending from webFrameMain: disposed' });
  await wait(GAP);
  ok(fired === 1, 'новая запись подняла событие (' + fired + ')');

  // --- Повторы той же ошибки → счётчик растёт, событие МОЛЧИТ ---
  const before = fired;
  for (let i = 0; i < 5; i++) { errledger.record({ level: 'error', source: 'main', message: 'Error sending from webFrameMain: disposed' }); await wait(150); }
  await wait(GAP);
  ok(fired === before, 'повторы той же сигнатуры не поднимают событие (было ' + before + ', стало ' + fired + ')');
  const e = errledger.list().entries.find((x) => x.sample.includes('webFrameMain'));
  ok(e && e.count === 6, 'счётчик всё равно вырос: ' + (e && e.count));

  // --- Другая ошибка → событие снова поднимается ---
  errledger.record({ level: 'error', source: 'main', message: 'совсем другая беда' });
  await wait(GAP);
  ok(fired === before + 1, 'новая сигнатура поднимает событие (' + fired + ')');

  // --- Регрессия закрытой ошибки → событие поднимается ---
  const id = errledger.list().entries.find((x) => x.sample.includes('другая беда')).id;
  errledger.setStatus(id, 'resolved');
  const afterResolve = fired;
  errledger.record({ level: 'error', source: 'main', message: 'совсем другая беда' });
  await wait(GAP);
  ok(fired === afterResolve + 1, 'регрессия поднимает событие (' + fired + ' против ' + afterResolve + ')');
  ok(errledger.list().entries.find((x) => x.id === id).regressed === true, 'запись помечена как регрессия');

  // --- Файл на диске валиден ---
  errledger.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'errors.json'), 'utf8'));
  ok(raw && raw.entries && Object.keys(raw.entries).length === 2, 'на диске ровно две записи');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`✓ errledger: ${passed} проверок пройдено`);
  process.exit(0);
})();
