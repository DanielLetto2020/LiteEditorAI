// Кодек «стилизованных строк» кадра пульта: цвета/атрибуты ячеек едут внутри строки
// как минимальное SGR-подмножество (\x1b[...m). Зачем так: диффер кадров в remote.js
// сравнивает строки по равенству — стилизованная строка остаётся обычной строкой, и
// смена ОДНОГО ЦВЕТА без смены текста честно попадает в line-дифф без правок диффера.
//
// Контракт: каждая строка САМОДОСТАТОЧНА (стиль не перетекает между строками; строка
// начинается с дефолтного стиля) — иначе точечные line-диффы ломали бы состояние парсера.
//
// Стиль ячейки: { fg, bg, fl }
//   fg/bg: -1 = дефолт терминала · 0..255 = палитра · (RGB | 0xRRGGBB) = truecolor
//   fl: битовая маска 1=bold 2=dim 4=italic 8=underline 16=inverse
//
// Используется с ОБЕИХ сторон: main.js (encodeLine — ПК снимает кадр с headless-xterm)
// и renderer/mobile.js (parseLine/colorHex — пульт рисует спаны; бандлится esbuild в APK,
// поэтому код держим в духе es2015: без spread/optional chaining).
// Тест: node test/sgrline.test.js (round-trip encode→parse).

const RGB = 0x1000000;

// SGR-код перехода К стилю c (с префиксом сброса — стиль всегда абсолютный, не дельта).
function sgrOf(c) {
  if (c.fg === -1 && c.bg === -1 && c.fl === 0) return '\x1b[0m';
  const p = ['0'];
  if (c.fl & 1) p.push('1');
  if (c.fl & 2) p.push('2');
  if (c.fl & 4) p.push('3');
  if (c.fl & 8) p.push('4');
  if (c.fl & 16) p.push('7');
  if (c.fg !== -1) {
    if (c.fg & RGB) { const v = c.fg & 0xffffff; p.push('38', '2', String((v >> 16) & 255), String((v >> 8) & 255), String(v & 255)); }
    else if (c.fg < 8) p.push(String(30 + c.fg));
    else if (c.fg < 16) p.push(String(90 + c.fg - 8));
    else p.push('38', '5', String(c.fg));
  }
  if (c.bg !== -1) {
    if (c.bg & RGB) { const v = c.bg & 0xffffff; p.push('48', '2', String((v >> 16) & 255), String((v >> 8) & 255), String(v & 255)); }
    else if (c.bg < 8) p.push(String(40 + c.bg));
    else if (c.bg < 16) p.push(String(100 + c.bg - 8));
    else p.push('48', '5', String(c.bg));
  }
  return '\x1b[' + p.join(';') + 'm';
}

// Строка кадра из ячеек [{ch, fg, bg, fl}]. Хвост из «невидимых» ячеек (пробел без
// фона/подчёркивания/инверсии) обрезается — как translateToString(true) в плоском режиме.
function encodeLine(cells) {
  let end = cells.length;
  while (end > 0) {
    const c = cells[end - 1];
    if ((!c.ch || c.ch === ' ') && c.bg === -1 && !(c.fl & (8 | 16))) end--; else break;
  }
  let out = '';
  let fg = -1, bg = -1, fl = 0;   // начало строки = дефолт (самодостаточность)
  for (let i = 0; i < end; i++) {
    const c = cells[i];
    if (c.fg !== fg || c.bg !== bg || c.fl !== fl) {
      out += sgrOf(c);
      fg = c.fg; bg = c.bg; fl = c.fl;
    }
    out += c.ch || ' ';
  }
  return out;
}

// Применить SGR-параметры к стилю (терпимо к кодам, которых сами не шлём).
// null = дефолтный стиль (спан не нужен).
function applySgr(prev, ps) {
  const st = prev ? { fg: prev.fg, bg: prev.bg, fl: prev.fl } : { fg: -1, bg: -1, fl: 0 };
  const a = ps.length ? ps.split(';') : ['0'];
  for (let k = 0; k < a.length; k++) {
    const n = a[k] === '' ? 0 : parseInt(a[k], 10);
    if (isNaN(n)) continue;
    if (n === 0) { st.fg = -1; st.bg = -1; st.fl = 0; }
    else if (n === 1) st.fl |= 1;
    else if (n === 2) st.fl |= 2;
    else if (n === 3) st.fl |= 4;
    else if (n === 4) st.fl |= 8;
    else if (n === 7) st.fl |= 16;
    else if (n === 22) st.fl &= ~3;
    else if (n === 23) st.fl &= ~4;
    else if (n === 24) st.fl &= ~8;
    else if (n === 27) st.fl &= ~16;
    else if (n >= 30 && n <= 37) st.fg = n - 30;
    else if (n >= 90 && n <= 97) st.fg = 8 + (n - 90);
    else if (n === 39) st.fg = -1;
    else if (n >= 40 && n <= 47) st.bg = n - 40;
    else if (n >= 100 && n <= 107) st.bg = 8 + (n - 100);
    else if (n === 49) st.bg = -1;
    else if ((n === 38 || n === 48) && a[k + 1] === '5') {
      const v = parseInt(a[k + 2], 10);
      if (!isNaN(v)) { if (n === 38) st.fg = v; else st.bg = v; }
      k += 2;
    } else if ((n === 38 || n === 48) && a[k + 1] === '2') {
      const r = parseInt(a[k + 2], 10) & 255, g = parseInt(a[k + 3], 10) & 255, b = parseInt(a[k + 4], 10) & 255;
      const v = RGB | (r << 16) | (g << 8) | b;
      if (n === 38) st.fg = v; else st.bg = v;
      k += 4;
    }
  }
  return (st.fg === -1 && st.bg === -1 && st.fl === 0) ? null : st;
}

// Стилизованная строка → { text: плоский текст, spans: [{s, e, fg, bg, fl}] }.
// spans — только стилизованные участки (дефолтные промежутки рисуются текстом),
// отсортированы, не пересекаются. Не-SGR escape-последовательности выбрасываются.
function parseLine(s) {
  let text = '';
  const spans = [];
  let st = null;     // текущий стиль (null = дефолт)
  let open = null;   // открытый спан
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      if (s[i + 1] === '[') {
        let j = i + 2;
        while (j < s.length && (s[j] === ';' || (s[j] >= '0' && s[j] <= '9'))) j++;
        if (s[j] === 'm') {
          st = applySgr(st, s.slice(i + 2, j));
          if (open && (!st || st.fg !== open.fg || st.bg !== open.bg || st.fl !== open.fl)) {
            if (text.length > open.s) { open.e = text.length; spans.push(open); }
            open = null;
          }
          if (st && !open) open = { s: text.length, e: -1, fg: st.fg, bg: st.bg, fl: st.fl };
        }
        i = (s[j] ? j + 1 : s.length);   // не-m CSI тоже пропускаем целиком
      } else if (s[i + 1] === '(' || s[i + 1] === ')' || s[i + 1] === '#' || s[i + 1] === '%') {
        i += 3;                           // ESC + intermediate + финальный (напр. выбор charset)
      } else i += 2;                      // одиночный ESC + следующий символ — мимо
      continue;
    }
    text += s[i]; i++;
  }
  if (open && text.length > open.s) { open.e = text.length; spans.push(open); }
  return { text, spans };
}

// Палитра xterm-256 → hex для инлайн-стилей спанов на пульте.
// Базовые 16 — палитра VS Code (читаема на тёмном фоне пульта).
const BASE16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const CUBE = [0, 95, 135, 175, 215, 255];
function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
function colorHex(v) {
  if (v === -1 || v === undefined || v === null) return null;
  if (v & RGB) { const c = v & 0xffffff; return '#' + ('00000' + c.toString(16)).slice(-6); }
  if (v < 16) return BASE16[v];
  if (v < 232) { const n = v - 16; return '#' + hex2(CUBE[(n / 36) | 0]) + hex2(CUBE[((n / 6) | 0) % 6]) + hex2(CUBE[n % 6]); }
  const g = 8 + (v - 232) * 10;
  return '#' + hex2(g) + hex2(g) + hex2(g);
}

module.exports = { RGB, encodeLine, parseLine, colorHex };
