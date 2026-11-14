// Тесты кольцевого буфера вывода PTY (lib/ptyring.js).
// Запуск: node test/ptyring.test.js
'use strict';

const assert = require('assert');
const { createPtyRing, createRingStore, alignCut } = require('../lib/ptyring');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

// 1. Базовая запись и чтение в пределах лимита
{
  const r = createPtyRing(512);
  eq(r.read(), '', 'пустой буфер отдаёт пустую строку');
  eq(r.size(), 0, 'начальный размер 0');
  r.push('hello ');
  r.push('world\r\n');
  eq(r.read(), 'hello world\r\n', 'чанки склеиваются в порядке поступления');
  eq(r.size(), 13, 'размер равен суммарной длине');
  r.clear();
  eq(r.read(), '', 'после clear буфер пуст');
  eq(r.size(), 0, 'после clear размер 0');
}

// 2. Вытеснение старых данных при переполнении (лимит минимум 256)
{
  const r = createPtyRing(300);
  for (let i = 0; i < 50; i++) {
    r.push(`line-${String(i).padStart(2, '0')}: abcdefghij\n`); // 20 символов
  }
  const out = r.read();
  ok(out.length <= 300, `длина ${out.length} не превышает лимит 300`);
  ok(out.endsWith('line-49: abcdefghij\n'), 'сохранён самый свежий хвост');
  ok(!out.includes('line-00:'), 'старые строки вытеснены');
}

// 3. Одиночный огромный кусок больше лимита
{
  const r = createPtyRing(300);
  r.push('начало');
  const huge = 'X'.repeat(1000) + 'TAIL_END';
  r.push(huge);
  const out = r.read();
  eq(out.length, 300, 'огромный чанк обрезан ровно по лимиту');
  ok(out.endsWith('TAIL_END'), 'хвост огромного чанка сохранён');
}

// 4. Защита суррогатных пар UTF-16 (emoji 🚀 = \uD83D\uDE80)
{
  const rocket = '🚀'; // length === 2: 0xD83D, 0xDE80
  const s = 'A' + rocket + 'B';
  // Разрез ровно посередине суррогатной пары (индекс 2 — trailing surrogate)
  eq(alignCut(s, 2), 3, 'разрез сдвинут за вторую половину суррогатной пары');
  eq(s.slice(alignCut(s, 2)), 'B', 'битый суррогат не остаётся в начале строки');
}

// 5. Защита CSI и OSC последовательностей на границе обрезки
{
  const csi = 'prefix\x1b[38;2;255;128;0mColoredText';
  const cutInsideCsi = csi.indexOf('255');
  const safeCut = alignCut(csi, cutInsideCsi);
  eq(csi.slice(safeCut), 'ColoredText', 'оборванная CSI SGR последовательность пропущена целиком');

  const osc = 'prefix\x1b]0;Claude Task Title\x07Prompt$ ';
  const cutInsideOsc = osc.indexOf('Task');
  const safeOscCut = alignCut(osc, cutInsideOsc);
  eq(osc.slice(safeOscCut), 'Prompt$ ', 'оборванная OSC последовательность до BEL пропущена целиком');
}

// 6. Хранилище по сессиям createRingStore
{
  const store = createRingStore(300);
  store.push('p1::t1', 'one');
  store.push('p2::t1', 'two');
  store.push('p1::t1', '-more');
  eq(store.read('p1::t1'), 'one-more', 'изоляция сессий: первая');
  eq(store.read('p2::t1'), 'two', 'изоляция сессий: вторая');
  eq(store.read('missing'), '', 'неизвестная сессия отдаёт пустую строку');
  store.delete('p1::t1');
  eq(store.read('p1::t1'), '', 'удалённая сессия очищена');
  eq(store.read('p2::t1'), 'two', 'соседняя сессия не затронута');
  store.clear();
  eq(store.size('p2::t1'), 0, 'clear очищает все сессии');
}

console.log(`✓ ptyring: ${passed} проверок пройдено`);
