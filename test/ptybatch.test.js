// Тест склейки вывода PTY (lib/ptybatch.js): после тишины кусок уходит сразу, под потоком —
// пачками по окну или по размеру, flush досылает остаток, порядок данных сохраняется.
// Запуск: node test/ptybatch.test.js
const assert = require('assert');
const { createBatcher } = require('../lib/ptybatch');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

// Поддельные часы и таймеры: тест не зависит от скорости машины.
let clock = 1000;
const timers = new Map();
let seq = 0;
const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + ms }); return id; };
const clearTimer = (id) => { timers.delete(id); };
function advance(ms) {
  clock += ms;
  for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
}

const sent = [];
const b = createBatcher((d) => sent.push(d), { windowMs: 5, maxBytes: 100, now: () => clock, setTimer, clearTimer });

// --- кусок после тишины уходит сразу (эхо набора не ждёт) ---
b.push('a');
ok(sent.length === 1 && sent[0] === 'a', 'первый кусок отправлен без задержки');

// --- поток: куски внутри окна копятся и уходят одной пачкой ---
advance(1); b.push('b');
advance(1); b.push('c');
advance(1); b.push('d');
ok(sent.length === 1, 'куски внутри окна не отправлены по одному');
advance(5);
ok(sent.length === 2 && sent[1] === 'bcd', 'пачка ушла по таймеру: ' + JSON.stringify(sent));

// --- набрался maxBytes — отправка сразу, не дожидаясь окна ---
b.push('x'.repeat(60));
b.push('y'.repeat(60));
ok(sent.length === 3 && sent[2].length === 120, 'пачка ушла по размеру');
ok(timers.size === 0, 'таймер снят после отправки по размеру');

// --- после паузы снова мгновенно ---
advance(50);
b.push('z');
ok(sent[sent.length - 1] === 'z', 'после тишины снова без задержки');

// --- flush досылает остаток (перед pty:exit) ---
advance(1); b.push('tail');
ok(sent[sent.length - 1] === 'z', 'хвост ещё в буфере');
b.flush();
ok(sent[sent.length - 1] === 'tail' && timers.size === 0, 'flush отправил хвост и снял таймер');
b.flush();
ok(sent[sent.length - 1] === 'tail' && sent.filter((s) => s === 'tail').length === 1, 'пустой flush ничего не шлёт');

// --- порядок и целостность данных на длинном потоке ---
const out = [];
const b2 = createBatcher((d) => out.push(d), { windowMs: 5, maxBytes: 64, now: () => clock, setTimer, clearTimer });
let expect = '';
for (let i = 0; i < 1000; i++) { const s = 'line' + i + '\n'; expect += s; b2.push(s); if (i % 7 === 0) advance(1); }
advance(10); b2.flush();
ok(out.join('') === expect, 'склеенный поток совпадает с исходным побайтно');
ok(out.length < 1000 / 3, 'сообщений заметно меньше, чем кусков: ' + out.length);

console.log(`ptybatch: ${passed} проверок пройдено`);
