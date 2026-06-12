// Тест кодека стилизованных строк пульта: encode (ПК) → parse (пульт) должен вернуть
// тот же плоский текст и те же стили. Запуск: node test/sgrline.test.js
const assert = require('assert');
const { RGB, encodeLine, parseLine, colorHex } = require('../lib/sgrline');

let passed = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

const cell = (ch, fg, bg, fl) => ({ ch, fg: fg === undefined ? -1 : fg, bg: bg === undefined ? -1 : bg, fl: fl || 0 });
const plain = (s) => s.split('').map((ch) => cell(ch));

// --- Плоский текст: без кодов, хвостовые пробелы обрезаны -----------------------
{
  const enc = encodeLine(plain('hello  '));
  eq(enc, 'hello', 'плоская строка без SGR, trimRight');
  eq(parseLine(enc), { text: 'hello', spans: [] }, 'round-trip плоской строки');
}

// --- Пустая строка ---------------------------------------------------------------
eq(encodeLine([]), '', 'пустая строка');
eq(parseLine(''), { text: '', spans: [] }, 'парс пустой строки');

// --- Базовый цвет + сброс в середине ----------------------------------------------
{
  const cells = [cell('o', 2), cell('k', 2), cell(' '), cell('!', -1)];
  const enc = encodeLine(cells);
  const p = parseLine(enc);
  eq(p.text, 'ok !', 'текст после цвета');
  eq(p.spans, [{ s: 0, e: 2, fg: 2, bg: -1, fl: 0 }], 'один спан зелёного');
}

// --- Яркие цвета (8..15), 256-палитра, RGB ----------------------------------------
{
  const cells = [cell('a', 9), cell('b', 208), cell('c', RGB | 0x1e90ff)];
  const p = parseLine(encodeLine(cells));
  eq(p.text, 'abc', 'текст трёх цветов');
  eq(p.spans, [
    { s: 0, e: 1, fg: 9, bg: -1, fl: 0 },
    { s: 1, e: 2, fg: 208, bg: -1, fl: 0 },
    { s: 2, e: 3, fg: RGB | 0x1e90ff, bg: -1, fl: 0 },
  ], 'спаны: яркий, палитра-256, RGB');
}

// --- Фон и атрибуты ----------------------------------------------------------------
{
  const cells = [cell('X', 0, 11, 1 | 4), cell('Y', -1, -1, 8), cell('Z', -1, -1, 16)];
  const p = parseLine(encodeLine(cells));
  eq(p.text, 'XYZ', 'текст с атрибутами');
  eq(p.spans, [
    { s: 0, e: 1, fg: 0, bg: 11, fl: 5 },
    { s: 1, e: 2, fg: -1, bg: -1, fl: 8 },
    { s: 2, e: 3, fg: -1, bg: -1, fl: 16 },
  ], 'bold+italic+bg / underline / inverse');
}

// --- Хвост: цветной фон НЕ обрезается, дефолтные пробелы — обрезаются --------------
{
  const cells = [cell('a'), cell(' ', -1, 4), cell(' '), cell(' ')];
  const p = parseLine(encodeLine(cells));
  eq(p.text, 'a ', 'пробел с фоном остался, дефолтные ушли');
  eq(p.spans, [{ s: 1, e: 2, fg: -1, bg: 4, fl: 0 }], 'спан фона на пробеле');
}

// --- Подчёркнутый/инвертированный пробел в хвосте тоже видимый ----------------------
{
  const p = parseLine(encodeLine([cell('a'), cell(' ', -1, -1, 16)]));
  eq(p.text, 'a ', 'инвертированный пробел не обрезан');
}

// --- Wide-символы и эмодзи (ячейки уже без continuation — ширину режет main.js) -----
{
  const cells = [cell('д', 3), cell('а', 3), cell('🙂', -1)];
  const p = parseLine(encodeLine(cells));
  eq(p.text, 'да🙂', 'кириллица + эмодзи');
  eq(p.spans, [{ s: 0, e: 2, fg: 3, bg: -1, fl: 0 }], 'спан не зацепил эмодзи');
}

// --- Соседние ячейки одного стиля → один спан (range-кодирование) -------------------
{
  const cells = [cell('a', 1), cell('b', 1), cell('c', 1)];
  const enc = encodeLine(cells);
  eq(enc.indexOf('\x1b'), 0, 'код один, в начале');
  eq(enc.lastIndexOf('\x1b'), 0, 'второго кода нет');
  eq(parseLine(enc).spans, [{ s: 0, e: 3, fg: 1, bg: -1, fl: 0 }], 'один спан на три ячейки');
}

// --- Толерантность парсера: чужие CSI и одиночные ESC выбрасываются ------------------
{
  const p = parseLine('a\x1b[2Kb\x1b(Bc');
  eq(p.text, 'abc', 'не-SGR последовательности выброшены');
}

// --- colorHex ------------------------------------------------------------------------
eq(colorHex(-1), null, 'дефолт → null');
eq(colorHex(2), '#0dbc79', 'базовый зелёный');
eq(colorHex(196), '#ff0000', 'куб 256: красный');
eq(colorHex(232), '#080808', 'грейскейл: первый');
eq(colorHex(RGB | 0x1e90ff), '#1e90ff', 'truecolor');
eq(colorHex(RGB | 0x00007f), '#00007f', 'truecolor с ведущими нулями');

console.log(`sgrline: ${passed} проверок прошло`);
