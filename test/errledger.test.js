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

  // --- id из IPC не достаёт до прототипа ---
  const r = errledger.setStatus('__proto__', 'resolved', 'x', 'y');
  ok(r.ok === false, 'id «__proto__» — «запись не найдена», а не правка Object.prototype');
  ok(({}).status === undefined && ({}).note === undefined, 'Object.prototype не тронут');

  // --- Кривая правка агентом: не-объект в entries не роняет реестр ---
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'errledger-'));
  fs.writeFileSync(path.join(dir2, 'errors.json'), JSON.stringify({ version: 1, entries: { a: null, b: 'x', c: { id: 'c', status: 'resolved', lastSeen: 1 } } }));
  errledger.init(dir2);
  let listed = null; try { listed = errledger.list(); } catch (_) {}
  ok(listed && listed.entries.length === 1, 'list() работает, мусорные элементы отброшены');
  let cleared = null; try { cleared = errledger.clearResolved(); } catch (_) {}
  ok(cleared && cleared.ok && cleared.removed === 1, 'clearResolved() не падает на мусоре');
  fs.rmSync(dir2, { recursive: true, force: true });

  // --- Агент отметил ошибку в файле, а у редактора отложенная запись своей копии: отметка не теряется ---
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'errledger-'));
  errledger.init(dir3);
  errledger.record({ level: 'error', source: 'x', message: 'boom' });
  errledger.flush();
  const f3 = path.join(dir3, 'errors.json');
  const j3 = JSON.parse(fs.readFileSync(f3, 'utf8'));
  const id3 = Object.keys(j3.entries)[0];
  Object.assign(j3.entries[id3], { status: 'resolved', resolvedAt: Date.now() + 60000, note: 'fixed', commit: 'abc' });
  fs.writeFileSync(f3, JSON.stringify(j3));                 // правка агента, ещё не перечитанная watch()
  errledger.record({ level: 'error', source: 'y', message: 'другая' });
  errledger.flush();
  const k3 = JSON.parse(fs.readFileSync(f3, 'utf8'));
  ok(k3.entries[id3].status === 'resolved' && k3.entries[id3].note === 'fixed', 'отметка агента пережила запись редактора');
  ok(Object.keys(k3.entries).length === 2, 'новая ошибка редактора тоже записана');
  // повторение ПОСЛЕ отметки — регрессия, а не «исправлено»
  j3.entries[id3].resolvedAt = 1; fs.writeFileSync(f3, JSON.stringify({ version: 1, entries: { [id3]: { ...k3.entries[id3], resolvedAt: 1 } } }));
  errledger.record({ level: 'error', source: 'x', message: 'boom' });
  errledger.flush();
  const r3 = JSON.parse(fs.readFileSync(f3, 'utf8'));
  ok(r3.entries[id3].status === 'open' && r3.entries[id3].regressed === true, 'повтор после отметки — регрессия');
  fs.rmSync(dir3, { recursive: true, force: true });

  // --- Правка человека в UI в те же миллисекунды, что и внешняя правка агента: обе живы ---
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'errledger-'));
  errledger.init(dir4);
  errledger.record({ level: 'error', source: 'a', message: 'A' });
  errledger.record({ level: 'error', source: 'b', message: 'B' });
  errledger.flush();
  const f4 = path.join(dir4, 'errors.json');
  const j4 = JSON.parse(fs.readFileSync(f4, 'utf8'));
  const idA = Object.keys(j4.entries).find((k) => j4.entries[k].source === 'a');
  const idB = Object.keys(j4.entries).find((k) => j4.entries[k].source === 'b');
  Object.assign(j4.entries[idA], { status: 'resolved', resolvedAt: Date.now() + 60000 });
  fs.writeFileSync(f4, JSON.stringify(j4));                 // агент отметил A
  errledger.setStatus(idB, 'ignored');                       // человек в UI — B, до перечитывания файла
  const k4 = JSON.parse(fs.readFileSync(f4, 'utf8'));
  ok(k4.entries[idA].status === 'resolved', 'отметка агента по A сохранилась');
  ok(k4.entries[idB].status === 'ignored', 'правка человека по B не откатилась файловой копией');
  errledger.clearResolved();
  const left4 = JSON.parse(fs.readFileSync(f4, 'utf8')).entries;
  ok(!left4[idA] && !left4[idB], 'очистка не возвращает удалённые записи');
  fs.rmSync(dir4, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`✓ errledger: ${passed} проверок пройдено`);
  process.exit(0);
})();
