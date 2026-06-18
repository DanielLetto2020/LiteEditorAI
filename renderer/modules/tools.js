// LiteEditor — модуль «Инструменты»: devtools-комбайн правого слота (швейцарский нож).
// Системная панель (НЕ привязана к проекту, как db/containers): 18 вкладок-инструментов,
// все преобразования — чисто клиентские (в рендерере), бэкенда нет вообще. Из window.lite
// нужны только copyText / readClipboard (буфер) — оба моста уже есть, новых не добавляем.
// Изолирован по образцу db.js: всё из ядра — через host; UI-хелперы — из ui.js; темизация —
// только CSS-токены. Ввод каждой вкладки персистится в STORE.toolsUi (как dbUi).
// host: { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels }
import { el, icon, iconBtn, toast, renderDiffInto } from '../ui.js';
import jsyaml from 'js-yaml';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// ============================ чистые преобразования ============================
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- base64 (UTF-8-safe; btoa/atob работают только с латиницей-1) ----
function bytesToB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin); }
function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function b64Encode(text, urlsafe) { let r = bytesToB64(enc.encode(text)); if (urlsafe) r = r.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); return r; }
function b64Decode(text) { let s = text.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return dec.decode(b64ToBytes(s)); }
function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return dec.decode(b64ToBytes(s)); }

// ---- hex ----
function textToHex(t) { return Array.from(enc.encode(t), (x) => x.toString(16).padStart(2, '0')).join(' '); }
function hexToText(h) { const clean = h.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, ''); if (clean.length % 2) throw new Error('Нечётное число hex-символов'); const a = new Uint8Array(clean.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(clean.substr(i * 2, 2), 16); return dec.decode(a); }
function hexDump(t) {
  const b = enc.encode(t); const lines = [];
  for (let o = 0; o < b.length; o += 16) {
    const slice = b.slice(o, o + 16);
    const hex = Array.from(slice, (x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(16 * 3 - 1, ' ');
    const asc = Array.from(slice, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(o.toString(16).padStart(8, '0') + '  ' + hex + '  ' + asc);
  }
  return lines.join('\n');
}

// ---- HTML-сущности ----
function htmlEncode(t, all) {
  let r = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  if (all) r = r.replace(/[\u0080-\uffff]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  return r;
}
function htmlDecode(t) { const ta = document.createElement('textarea'); ta.innerHTML = t; return ta.value; } // textarea не исполняет — безопасно

// ---- JSON ↔ YAML ----
function jsonToYaml(t) { return jsyaml.dump(JSON.parse(t), { indent: 2, lineWidth: -1, noRefs: true }); }
function yamlToJson(t) { return JSON.stringify(jsyaml.load(t), null, 2); }

// ---- query-string ↔ JSON ----
function queryToJson(t) {
  let q = t.trim(); const qi = q.indexOf('?'); if (qi >= 0) q = q.slice(qi + 1);
  const p = new URLSearchParams(q); const o = {};
  for (const [k, v] of p) { if (k in o) { if (!Array.isArray(o[k])) o[k] = [o[k]]; o[k].push(v); } else o[k] = v; }
  return JSON.stringify(o, null, 2);
}
function jsonToQuery(t) {
  const o = JSON.parse(t); if (o == null || typeof o !== 'object' || Array.isArray(o)) throw new Error('Ожидался объект {…}');
  const p = new URLSearchParams();
  for (const k of Object.keys(o)) { const v = o[k]; if (Array.isArray(v)) v.forEach((x) => p.append(k, x == null ? '' : String(x))); else p.append(k, v == null ? '' : String(v)); }
  return p.toString();
}

// ---- CSV ↔ JSON ----
function parseCsv(text, delim) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function csvToJson(text, delim, header) {
  const rows = parseCsv(text, delim).filter((r) => !(r.length === 1 && r[0] === ''));
  if (!rows.length) return '[]';
  if (header) { const keys = rows[0]; const out = rows.slice(1).map((r) => { const o = {}; keys.forEach((k, i) => { o[k] = r[i] != null ? r[i] : ''; }); return o; }); return JSON.stringify(out, null, 2); }
  return JSON.stringify(rows, null, 2);
}
function jsonToCsv(text, delim) {
  const arr = JSON.parse(text); if (!Array.isArray(arr)) throw new Error('Ожидался массив объектов');
  const keys = []; arr.forEach((o) => Object.keys(o || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  const esc = (v) => { v = v == null ? '' : String(v); return (v.includes(delim) || v.includes('"') || v.includes('\n') || v.includes('\r')) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [keys.map(esc).join(delim)];
  for (const o of arr) lines.push(keys.map((k) => esc(o ? o[k] : '')).join(delim));
  return lines.join('\n');
}

// ---- JSONPath (упрощённый: .a.b[0] / a.b.0 / $.a) ----
function jsonPath(jsonText, path) {
  const data = JSON.parse(jsonText);
  const tokens = path.replace(/^\$/, '').match(/[^.[\]'"]+/g) || [];
  let cur = data;
  for (const tk of tokens) {
    if (cur == null) throw new Error('Путь обрывается на null/undefined у «' + tk + '»');
    cur = cur[/^\d+$/.test(tk) ? Number(tk) : tk];
  }
  if (cur === undefined) throw new Error('Ничего не найдено по этому пути');
  return typeof cur === 'object' && cur !== null ? JSON.stringify(cur, null, 2) : String(cur);
}

// ---- MD5 (инлайн, чтобы не тянуть зависимость; crypto.subtle MD5 не умеет) ----
function md5(bytes) {
  const add32 = (a, b) => (a + b) & 0xffffffff;
  const cmn = (q, a, b, x, s, t) => { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); };
  const ff = (a, b, c, d, x, s, t) => cmn((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a, b, c, d, x, s, t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
  const ii = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);
  const len = bytes.length; const nblk = (((len + 8) >> 6) + 1) * 16; const x = new Array(nblk).fill(0);
  for (let i = 0; i < len; i++) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  x[len >> 2] |= 0x80 << ((len % 4) * 8); x[nblk - 2] = len * 8;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d; const k = x.slice(i, i + 16);
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    a = add32(a, oa); b = add32(b, ob); c = add32(c, oc); d = add32(d, od);
  }
  const hex = '0123456789abcdef'; let out = '';
  for (const n of [a, b, c, d]) for (let i = 0; i < 4; i++) { const byte = (n >>> (i * 8)) & 0xff; out += hex[(byte >> 4) & 0xf] + hex[byte & 0xf]; }
  return out;
}
async function sha(algo, bytes) { const buf = await crypto.subtle.digest(algo, bytes); return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join(''); }

// ---- транслит + регистр ----
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
function translit(s) { return s.replace(/[а-яё]/gi, (c) => { const low = c.toLowerCase(); const t = TRANSLIT[low] != null ? TRANSLIT[low] : c; return c === low ? t : (t.charAt(0).toUpperCase() + t.slice(1)); }); }
function splitWords(s) { return s.replace(/[_\-./\\]+/g, ' ').replace(/([a-zа-яё\d])([A-ZА-ЯЁ])/g, '$1 $2').trim().split(/\s+/).filter(Boolean); }
const cap = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);
function caseVariants(s) {
  const w = splitWords(s);
  return [
    ['camelCase', w.map((x, i) => (i === 0 ? x.toLowerCase() : cap(x))).join('')],
    ['PascalCase', w.map(cap).join('')],
    ['snake_case', w.map((x) => x.toLowerCase()).join('_')],
    ['kebab-case', w.map((x) => x.toLowerCase()).join('-')],
    ['CONSTANT_CASE', w.map((x) => x.toUpperCase()).join('_')],
    ['Title Case', w.map(cap).join(' ')],
    ['lower', s.toLowerCase()],
    ['UPPER', s.toUpperCase()],
    ['Транслит (RU→lat)', translit(s)],
  ];
}

// ---- cron ----
function cronField(expr, min, max) {
  const set = new Set();
  for (const part of expr.split(',')) {
    let step = 1, range = part; const sl = part.split('/');
    if (sl.length === 2) { step = parseInt(sl[1], 10); range = sl[0]; }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const ab = range.split('-'); lo = parseInt(ab[0], 10); hi = parseInt(ab[1], 10); }
    else { lo = hi = parseInt(range, 10); }
    if (isNaN(lo) || isNaN(hi) || isNaN(step) || step < 1) throw new Error('Поле cron не разобрано: «' + part + '»');
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) set.add(v);
  }
  return set;
}
function parseCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('Нужно 5 полей: «минута час день месяц день-недели»');
  const dow = cronField(f[4], 0, 7); if (dow.has(7)) dow.add(0); // воскресенье = 0 и 7
  return { min: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), mon: cronField(f[3], 1, 12), dow, raw: f };
}
function cronNext(c, from, count) {
  const res = []; const d = new Date(from.getTime()); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const domStar = c.raw[2] === '*', dowStar = c.raw[4] === '*';
  for (let i = 0; i < 525600 * 5 && res.length < count; i++) {
    if (c.min.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.mon.has(d.getMonth() + 1)) {
      const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
      // стандарт cron: если ограничены ОБА (день месяца и день недели) — совпадение по ЛЮБОМУ
      const dayOk = (domStar && dowStar) ? true : (domStar ? dowOk : (dowStar ? domOk : (domOk || dowOk)));
      if (dayOk) res.push(new Date(d.getTime()));
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return res;
}
function cronDescribe(c) {
  const r = c.raw;
  const part = (i, one, many) => (r[i] === '*' ? many : one + ' ' + r[i]);
  return [
    'Минуты: ' + (r[0] === '*' ? 'каждую минуту' : r[0]),
    'Часы: ' + (r[1] === '*' ? 'каждый час' : r[1]),
    'Дни месяца: ' + (r[2] === '*' ? 'любой' : r[2]),
    'Месяцы: ' + (r[3] === '*' ? 'любой' : r[3]),
    'Дни недели: ' + (r[4] === '*' ? 'любой' : r[4] + ' (0/7 = вс)'),
  ].join('\n');
}

// ---- color ----
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; } else { const dd = max - min; s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min); h = max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h /= 6; }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100; let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const h2 = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = h2(p, q, h + 1 / 3); g = h2(p, q, h); b = h2(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
function parseColor(str) {
  let s = str.trim(), m;
  if ((m = s.match(/^#?([0-9a-fA-F]{3,8})$/))) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('') + 'ff';
    else if (h.length === 4) h = h.split('').map((c) => c + c).join('');
    else if (h.length === 6) h += 'ff';
    else if (h.length !== 8) throw new Error('Неверная длина hex (3/4/6/8 символов)');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255 };
  }
  if ((m = s.match(/rgba?\(([^)]+)\)/i))) { const p = m[1].split(/[,\s/]+/).filter(Boolean); const r = +p[0], g = +p[1], b = +p[2], a = p[3] != null ? +p[3] : 1; if ([r, g, b].some(isNaN)) throw new Error('rgb(): ожидались числа'); return { r, g, b, a }; }
  if ((m = s.match(/hsla?\(([^)]+)\)/i))) { const p = m[1].replace(/%/g, '').split(/[,\s/]+/).filter(Boolean); const rgb = hslToRgb(+p[0], +p[1], +p[2]); return { r: rgb[0], g: rgb[1], b: rgb[2], a: p[3] != null ? +p[3] : 1 }; }
  throw new Error('Не распознан цвет — поддерживаются #hex, rgb(), hsl()');
}
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

// ---- diff (LCS по строкам → unified-подобный текст для renderDiffInto) ----
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n'), n = A.length, m = B.length;
  if (n * m > 4000000) throw new Error('Слишком большие тексты для построчного диффа');
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0, changes = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push(' ' + A[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + A[i]); i++; changes++; } else { out.push('+' + B[j]); j++; changes++; } }
  while (i < n) { out.push('-' + A[i++]); changes++; }
  while (j < m) { out.push('+' + B[j++]); changes++; }
  return { text: out.join('\n'), changes };
}

// ---- timestamp / относительное время ----
function relTime(ms) {
  const diff = ms - Date.now(); const past = diff < 0; let s = Math.abs(diff) / 1000;
  const units = [['год', 31536000], ['мес', 2592000], ['дн', 86400], ['ч', 3600], ['мин', 60], ['с', 1]];
  for (const [label, sec] of units) { if (s >= sec || label === 'с') { const v = Math.floor(s / sec); return (past ? '' : 'через ') + v + ' ' + label + (past ? ' назад' : ''); } }
  return 'сейчас';
}

// ---- lorem / тестовые данные ----
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum'.split(' ');
const NAMES = ['Александр', 'Мария', 'Дмитрий', 'Анна', 'Сергей', 'Екатерина', 'Иван', 'Ольга', 'Павел', 'Наталья'];
const SURN = ['Иванов', 'Петров', 'Смирнов', 'Кузнецов', 'Соколов', 'Попов', 'Лебедев', 'Новиков'];
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function loremWords(n) { const out = []; for (let i = 0; i < n; i++) out.push(pick(LOREM)); return out.join(' '); }
function loremSentence() { const n = 6 + rnd(10); return cap(loremWords(n)) + '.'; }
function loremParagraph() { const n = 3 + rnd(5); return Array.from({ length: n }, loremSentence).join(' '); }
function fakeEmail() { return translit(pick(NAMES)).toLowerCase() + '.' + translit(pick(SURN)).toLowerCase() + rnd(100) + '@example.com'; }

// ---- изображения / base64 ----
function fmtBytes(n) { if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ'; return (n / 1048576).toFixed(2) + ' МБ'; }
function normB64(t) { let s = t.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; }
function sniffImageMime(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b.length >= 5 && b[0] === 0x3c) return 'image/svg+xml'; // начинается с '<' → вероятно SVG
  return 'application/octet-stream';
}
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/svg+xml': 'svg' };
function extFromMime(m) { return MIME_EXT[m] || 'bin'; }

// ---- JSON-вьюер: множественные числа + сводка + позиция ошибки ----
function plural(n, one, few, many) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return one; if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few; return many; }
function jsonStats(data) {
  let nodes = 0, depth = 0;
  (function walk(v, d) { nodes++; if (d > depth) depth = d; if (v && typeof v === 'object') { const items = Array.isArray(v) ? v : Object.values(v); for (const x of items) walk(x, d + 1); } })(data, 0);
  return 'Узлов: ' + nodes + ' · глубина: ' + depth;
}
function jsonErrAt(text, e) {
  const msg = String(e && e.message || e); const m = msg.match(/position (\d+)/);
  if (!m) return msg;
  const pos = +m[1]; let line = 1, col = 1;
  for (let i = 0; i < pos && i < text.length; i++) { if (text[i] === '\n') { line++; col = 1; } else col++; }
  return msg + ' (строка ' + line + ', столбец ' + col + ')';
}

// ============================ модуль ============================
export function initTools(host) {
  const { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let toolsOpen = false;
  let filterText = '';
  const st = (STORE.toolsUi && typeof STORE.toolsUi === 'object') ? STORE.toolsUi : {};
  let active = typeof st.__tab === 'string' ? st.__tab : 'base64';
  let tabsWrapEl = null, contentEl = null;
  let persistTimer = null;
  function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(() => { try { persist('toolsUi', st); } catch (_) {} }, 400); }
  function stFor(id) { if (!st[id] || typeof st[id] !== 'object') st[id] = {}; return st[id]; }

  // вкладки, сгруппированы по категориям (иконки — только из набора ICONS)
  const CATS = [
    ['Кодеки', [['base64', 'Base64', 'key'], ['url', 'URL', 'globe'], ['hex', 'Hex', 'grid'], ['html', 'HTML-сущности', 'file']]],
    ['Данные', [['jsonview', 'JSON-вьюер', 'braces'], ['jsonyaml', 'JSON ↔ YAML', 'layers'], ['query', 'Query ↔ JSON', 'arrow-right'], ['csv', 'CSV ↔ JSON', 'columns'], ['jsonpath', 'JSONPath', 'search']]],
    ['Медиа', [['img', 'Base64 ↔ Картинка', 'image']]],
    ['Крипто', [['hash', 'Хэши', 'key'], ['jwt', 'JWT', 'key']]],
    ['Время', [['ts', 'Timestamp', 'refresh'], ['cron', 'Cron', 'refresh']]],
    ['Текст', [['case', 'Регистр / транслит', 'pencil'], ['lines', 'Строки', 'note'], ['regex', 'Regex', 'search'], ['diff', 'Diff', 'diff'], ['lorem', 'Lorem', 'note']]],
    ['Цвет', [['color', 'Цвет', 'palette']]],
  ];

  // -------- мелкие DOM-хелперы --------
  function actBtn(name, title, on) { const b = iconBtn('tl-ic', name, title, 16); b.onclick = on; return b; }
  function seg(options, current, on) {
    const wrap = el('div', 'tl-seg');
    options.forEach(([v, l]) => {
      const b = el('button', 'tl-segbtn' + (v === current ? ' active' : ''), l);
      b.onclick = () => { if (b.classList.contains('active')) return; wrap.querySelectorAll('.tl-segbtn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); on(v); };
      wrap.appendChild(b);
    });
    return wrap;
  }
  function chk(label, checked, on) { const w = el('label', 'tl-chk'); const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!checked; i.onchange = () => on(i.checked); w.append(i, el('span', null, label)); return w; }
  function spacer() { return el('div', 'tl-sp'); }
  function area(ph, cls) { const t = el('textarea', 'tl-area' + (cls ? ' ' + cls : '')); t.placeholder = ph || ''; t.spellcheck = false; return t; }

  // Универсальный конструктор «вход → выход» (живой, с персистом и кнопками буфера).
  // cfg: { id, modes?, optsRender?(box, refresh, ctx), compute(text, ctx)->string|Promise, inPh, outPh, rows }
  function buildIO(root, cfg) {
    const s = stFor(cfg.id);
    const ctx = { mode: s.mode != null ? s.mode : (cfg.modes ? cfg.modes[0][0] : null), opts: {} };
    let seq = 0, timer = null;

    const head = el('div', 'tl-bar');
    if (cfg.modes) head.appendChild(seg(cfg.modes, ctx.mode, (v) => { ctx.mode = v; s.mode = v; persistSoon(); run(); }));
    head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить из буфера', async () => { try { const t = await lite.readClipboard(); input.value = t || ''; onIn(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
    root.appendChild(head);

    const input = area(cfg.inPh || 'Ввод…'); if (cfg.rows) input.rows = cfg.rows; input.value = s.text || '';
    root.appendChild(input);

    if (cfg.optsRender) { const box = el('div', 'tl-bar tl-opts'); cfg.optsRender(box, () => run(), ctx); root.appendChild(box); }

    const oh = el('div', 'tl-bar tl-outhead');
    oh.appendChild(el('span', 'tl-lbl', cfg.outPh || 'Результат'));
    oh.appendChild(spacer());
    oh.appendChild(actBtn('copy', 'Копировать результат', () => { if (output.value) { lite.copyText(output.value); toast('Скопировано'); } }));
    root.appendChild(oh);
    const output = area('', 'tl-out'); output.readOnly = true; root.appendChild(output);
    const status = el('div', 'tl-status'); root.appendChild(status);

    async function run() {
      const text = input.value;
      if (!text) { output.value = ''; status.textContent = ''; status.classList.remove('err'); return; }
      try {
        let r = cfg.compute(text, ctx);
        if (r instanceof Promise) { const my = ++seq; r = await r; if (my !== seq) return; }
        output.value = r == null ? '' : r; status.textContent = ''; status.classList.remove('err');
      } catch (e) { output.value = ''; status.textContent = String(e && e.message || e); status.classList.add('err'); }
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 120); }
    input.addEventListener('input', onIn);
    run();
  }

  // ------------------------------ конкретные вкладки ------------------------------
  const RENDER = {
    base64: (root) => buildIO(root, {
      id: 'base64', modes: [['enc', 'Кодировать'], ['dec', 'Декодировать']], rows: 5,
      optsRender: (box, refresh, ctx) => { if (ctx.opts.url == null) ctx.opts.url = false; box.appendChild(chk('url-safe (-_ без =)', ctx.opts.url, (v) => { ctx.opts.url = v; refresh(); })); },
      compute: (t, ctx) => ctx.mode === 'enc' ? b64Encode(t, ctx.opts.url) : b64Decode(t),
      inPh: 'Текст или base64…',
    }),
    url: (root) => buildIO(root, {
      id: 'url', modes: [['enc', 'Кодировать'], ['dec', 'Декодировать']], rows: 5,
      optsRender: (box, refresh, ctx) => { if (ctx.opts.full == null) ctx.opts.full = false; box.appendChild(chk('полный URL (encodeURI)', ctx.opts.full, (v) => { ctx.opts.full = v; refresh(); })); },
      compute: (t, ctx) => ctx.mode === 'enc' ? (ctx.opts.full ? encodeURI(t) : encodeURIComponent(t)) : (ctx.opts.full ? decodeURI(t) : decodeURIComponent(t)),
    }),
    hex: (root) => buildIO(root, {
      id: 'hex', modes: [['enc', 'Текст→Hex'], ['dec', 'Hex→Текст'], ['dump', 'Hex-dump']], rows: 5,
      compute: (t, ctx) => ctx.mode === 'enc' ? textToHex(t) : ctx.mode === 'dec' ? hexToText(t) : hexDump(t),
    }),
    html: (root) => buildIO(root, {
      id: 'html', modes: [['enc', 'Кодировать'], ['dec', 'Декодировать']], rows: 5,
      optsRender: (box, refresh, ctx) => { if (ctx.opts.all == null) ctx.opts.all = false; box.appendChild(chk('кодировать не-ASCII (&#NNNN;)', ctx.opts.all, (v) => { ctx.opts.all = v; refresh(); })); },
      compute: (t, ctx) => ctx.mode === 'enc' ? htmlEncode(t, ctx.opts.all) : htmlDecode(t),
    }),
    jsonyaml: (root) => buildIO(root, {
      id: 'jsonyaml', modes: [['j2y', 'JSON→YAML'], ['y2j', 'YAML→JSON'], ['pretty', 'JSON pretty'], ['min', 'JSON minify']], rows: 7,
      compute: (t, ctx) => ctx.mode === 'j2y' ? jsonToYaml(t) : ctx.mode === 'y2j' ? yamlToJson(t) : ctx.mode === 'pretty' ? JSON.stringify(JSON.parse(t), null, 2) : JSON.stringify(JSON.parse(t)),
      inPh: 'JSON или YAML…',
    }),
    query: (root) => buildIO(root, {
      id: 'query', modes: [['q2j', 'Query→JSON'], ['j2q', 'JSON→Query']], rows: 5,
      compute: (t, ctx) => ctx.mode === 'q2j' ? queryToJson(t) : jsonToQuery(t),
      inPh: '?a=1&b=2  или  {"a":"1"}',
    }),
    csv: (root) => buildIO(root, {
      id: 'csv', modes: [['c2j', 'CSV→JSON'], ['j2c', 'JSON→CSV']], rows: 7,
      optsRender: (box, refresh, ctx) => {
        if (ctx.opts.delim == null) ctx.opts.delim = ','; if (ctx.opts.header == null) ctx.opts.header = true;
        box.appendChild(el('span', 'tl-lbl', 'Разделитель'));
        box.appendChild(seg([[',', 'запятая'], [';', '; '], ['\t', 'таб']], ctx.opts.delim, (v) => { ctx.opts.delim = v; refresh(); }));
        box.appendChild(chk('первая строка — заголовки', ctx.opts.header, (v) => { ctx.opts.header = v; refresh(); }));
      },
      compute: (t, ctx) => ctx.mode === 'c2j' ? csvToJson(t, ctx.opts.delim, ctx.opts.header) : jsonToCsv(t, ctx.opts.delim),
    }),
    cron: (root) => buildIO(root, {
      id: 'cron', rows: 1,
      compute: (t) => { const c = parseCron(t); const next = cronNext(c, new Date(), 7); return cronDescribe(c) + '\n\nБлижайшие запуски:\n' + (next.length ? next.map((d) => '• ' + d.toLocaleString('ru-RU')).join('\n') : '— нет в ближайшие 5 лет'); },
      inPh: '*/5 * * * *', outPh: 'Расшифровка',
    }),
    lines: (root) => buildIO(root, {
      id: 'lines', rows: 8,
      optsRender: (box, refresh, ctx) => {
        const o = ctx.opts; const defs = [['trim', 'Trim строк'], ['noEmpty', 'Без пустых'], ['uniq', 'Уникальные'], ['sort', 'Сортировать'], ['reverse', 'Реверс'], ['number', 'Нумерация']];
        for (const [k, l] of defs) box.appendChild(chk(l, o[k], (v) => { o[k] = v; refresh(); }));
      },
      compute: (t, ctx) => {
        const o = ctx.opts; let ls = t.split('\n');
        if (o.trim) ls = ls.map((x) => x.trim());
        if (o.noEmpty) ls = ls.filter((x) => x.trim() !== '');
        if (o.uniq) { const seen = new Set(); ls = ls.filter((x) => (seen.has(x) ? false : seen.add(x))); }
        if (o.sort) ls = ls.slice().sort((a, b) => a.localeCompare(b, 'ru'));
        if (o.reverse) ls = ls.reverse();
        if (o.number) ls = ls.map((x, i) => (i + 1) + '. ' + x);
        return ls.join('\n');
      },
      outPh: 'Результат (строк: меняется на лету)',
    }),
    jsonview: renderJsonView,
    img: renderImg,
    jsonpath: renderJsonPath,
    hash: renderHash,
    jwt: renderJwt,
    ts: renderTs,
    case: renderCase,
    regex: renderRegex,
    diff: renderDiff,
    lorem: renderLorem,
    color: renderColor,
  };

  // ---- JSON-вьюер (дерево со сворачиванием + подсветка) ----
  function renderJsonView(root) {
    const s = stFor('jsonview');
    const head = el('div', 'tl-bar'); head.appendChild(el('span', 'tl-lbl', 'JSON')); head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); input.value = t || ''; onIn(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
    root.appendChild(head);
    const input = area('{ "hello": "world", "list": [1, 2, 3] }'); input.rows = 5; input.value = s.text || ''; root.appendChild(input);

    const tools = el('div', 'tl-bar');
    const expandBtn = el('button', 'tl-btn', 'Развернуть всё'); expandBtn.onclick = () => setAll(true);
    const collapseBtn = el('button', 'tl-btn', 'Свернуть всё'); collapseBtn.onclick = () => setAll(false);
    tools.append(expandBtn, collapseBtn, spacer());
    tools.appendChild(actBtn('copy', 'Копировать форматированный', () => { if (lastData !== undefined) { lite.copyText(JSON.stringify(lastData, null, 2)); toast('Скопировано'); } }));
    root.appendChild(tools);

    const status = el('div', 'tl-status'); root.appendChild(status);
    const tree = el('div', 'tl-json'); root.appendChild(tree);

    let lastData, timer = null;
    function valSpan(v) {
      if (v === null) return el('span', 'tl-json-val tl-json-null', 'null');
      const t = typeof v;
      if (t === 'string') return el('span', 'tl-json-val tl-json-str', JSON.stringify(v));
      if (t === 'number') return el('span', 'tl-json-val tl-json-num', String(v));
      if (t === 'boolean') return el('span', 'tl-json-val tl-json-bool', String(v));
      return el('span', 'tl-json-val', String(v));
    }
    function toggleNode(node, open) {
      if (!node.classList.contains('collapsible')) return;
      node.dataset.open = open ? '1' : '0';
      const tog = node.querySelector(':scope > .tl-json-row > .tl-json-tog'); if (tog) tog.textContent = open ? '▾' : '▸';
    }
    function buildNode(value, key, isIndex) {
      const isArr = Array.isArray(value);
      const isObj = value !== null && typeof value === 'object';
      const node = el('div', 'tl-json-node');
      const row = el('div', 'tl-json-row'); node.appendChild(row);
      const addKey = () => {
        if (key === null) return;
        row.appendChild(el('span', isIndex ? 'tl-json-index' : 'tl-json-key', isIndex ? String(key) : JSON.stringify(key)));
        row.appendChild(el('span', 'tl-json-colon', ': '));
      };
      if (isObj) {
        const open = isArr ? '[' : '{', close = isArr ? ']' : '}';
        const n = isArr ? value.length : Object.keys(value).length;
        const tog = el('span', 'tl-json-tog', n ? '▾' : ''); row.appendChild(tog);
        addKey();
        row.appendChild(el('span', 'tl-json-punct', open));
        if (n) {
          node.classList.add('collapsible'); node.dataset.open = '1';
          row.appendChild(el('span', 'tl-json-count', n + (isArr ? ' ' + plural(n, 'элемент', 'элемента', 'элементов') : ' ' + plural(n, 'ключ', 'ключа', 'ключей'))));
          row.appendChild(el('span', 'tl-json-punct tl-json-closeinline', close));
          row.onclick = () => toggleNode(node, node.dataset.open !== '1');
          const children = el('div', 'tl-json-children');
          if (isArr) value.forEach((v, i) => children.appendChild(buildNode(v, i, true)));
          else Object.keys(value).forEach((k) => children.appendChild(buildNode(value[k], k, false)));
          node.appendChild(children);
          const closeRow = el('div', 'tl-json-row tl-json-close'); closeRow.appendChild(el('span', 'tl-json-punct', close)); node.appendChild(closeRow);
        } else {
          row.appendChild(el('span', 'tl-json-punct', close)); // пустой {} / []
        }
      } else {
        node.classList.add('leaf');
        row.appendChild(el('span', 'tl-json-tog')); // выравнивание под ▾
        addKey();
        row.appendChild(valSpan(value));
      }
      return node;
    }
    function setAll(open) { tree.querySelectorAll('.tl-json-node.collapsible').forEach((n) => toggleNode(n, open)); }
    function run() {
      status.textContent = ''; status.classList.remove('err'); tree.innerHTML = ''; lastData = undefined;
      const v = input.value.trim(); if (!v) return;
      let data; try { data = JSON.parse(v); } catch (e) { status.textContent = jsonErrAt(v, e); status.classList.add('err'); return; }
      lastData = data;
      tree.appendChild(buildNode(data, null, false));
      status.textContent = jsonStats(data);
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 200); }
    input.addEventListener('input', onIn); run();
  }

  // ---- Base64 ↔ Картинка ----
  function renderImg(root) {
    const s = stFor('img');
    const ctx = { mode: s.mode === 'b2f' ? 'b2f' : 'f2b' };
    const head = el('div', 'tl-bar');
    head.appendChild(seg([['f2b', 'Файл → Base64'], ['b2f', 'Base64 → Картинка']], ctx.mode, (v) => { ctx.mode = v; s.mode = v; persistSoon(); render(); }));
    root.appendChild(head);
    const bodyWrap = el('div', 'tl-img-wrap'); root.appendChild(bodyWrap);

    function metaRow(k, v) { const r = el('div', 'tl-ts-row'); r.appendChild(el('span', 'tl-ts-key', k)); r.appendChild(el('span', 'tl-ts-val', v)); return r; }
    function downloadDataUri(dataUri, filename) { const a = document.createElement('a'); a.href = dataUri; a.download = filename || 'image'; document.body.appendChild(a); a.click(); a.remove(); }
    function buildPreview(dataUri, meta) {
      const box = el('div', 'tl-img-prev');
      const img = document.createElement('img'); img.className = 'tl-img-thumb'; img.src = dataUri;
      const info = el('div', 'tl-img-meta');
      const dimRow = metaRow('Размеры', '…'); const dimVal = dimRow.lastChild;
      img.onload = () => { dimVal.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px'; };
      img.onerror = () => { dimVal.textContent = 'не удалось отрисовать'; };
      if (meta.name) info.appendChild(metaRow('Имя', meta.name));
      info.appendChild(metaRow('Тип', meta.mime || '—'));
      if (meta.size != null) info.appendChild(metaRow('Размер', fmtBytes(meta.size)));
      info.appendChild(dimRow);
      const dl = el('button', 'tl-btn', 'Скачать'); dl.onclick = () => downloadDataUri(dataUri, meta.name || ('image.' + extFromMime(meta.mime)));
      info.appendChild(dl);
      box.append(img, info);
      return box;
    }
    function outBlock(title, value) {
      const wrap = el('div', 'tl-img-block');
      const oh = el('div', 'tl-bar tl-outhead'); oh.appendChild(el('span', 'tl-lbl', title)); oh.appendChild(spacer());
      oh.appendChild(actBtn('copy', 'Копировать', () => { if (value) { lite.copyText(value); toast('Скопировано'); } }));
      wrap.appendChild(oh);
      const t = area('', 'tl-out'); t.readOnly = true; t.rows = 4; t.value = value; wrap.appendChild(t);
      return wrap;
    }

    function render() { bodyWrap.innerHTML = ''; if (ctx.mode === 'f2b') renderF2B(); else renderB2F(); }

    function renderF2B() {
      const drop = el('div', 'tl-drop');
      drop.append(icon('image', 30), el('div', 'tl-drop-h', 'Перетащите изображение сюда'), el('div', 'tl-drop-sub', 'или нажмите, чтобы выбрать файл'));
      const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
      drop.onclick = () => file.click();
      file.onchange = () => { if (file.files && file.files[0]) loadFile(file.files[0]); };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); };
      bodyWrap.append(drop, file);
      const result = el('div', 'tl-img-result'); bodyWrap.appendChild(result);

      function loadFile(f) {
        if (!/^image\//.test(f.type) && !/\.(svg|png|jpe?g|gif|webp|bmp|ico)$/i.test(f.name)) { toast('Это не изображение', { kind: 'err' }); return; }
        const r = new FileReader();
        r.onload = () => {
          const dataUri = String(r.result); const raw = dataUri.replace(/^data:[^,]*,/, '');
          result.innerHTML = '';
          result.appendChild(buildPreview(dataUri, { name: f.name, mime: f.type || '', size: f.size }));
          result.appendChild(outBlock('Data-URI', dataUri));
          result.appendChild(outBlock('Base64 (без префикса)', raw));
        };
        r.onerror = () => toast('Не удалось прочитать файл', { kind: 'err' });
        r.readAsDataURL(f);
      }
    }

    function renderB2F() {
      const ihead = el('div', 'tl-bar'); ihead.appendChild(el('span', 'tl-lbl', 'Base64 или data:-URI')); ihead.appendChild(spacer());
      ihead.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); input.value = t || ''; onIn(); } catch (_) {} }));
      ihead.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
      bodyWrap.appendChild(ihead);
      const input = area('data:image/png;base64,iVBORw0…   или   iVBORw0…'); input.rows = 5; input.value = s.b2f || ''; bodyWrap.appendChild(input);
      const status = el('div', 'tl-status'); bodyWrap.appendChild(status);
      const result = el('div', 'tl-img-result'); bodyWrap.appendChild(result);
      let timer = null;
      function run() {
        result.innerHTML = ''; status.textContent = ''; status.classList.remove('err');
        const v = input.value.trim(); if (!v) return;
        try {
          let dataUri, mime, bytes;
          if (/^data:/i.test(v)) {
            dataUri = v;
            const head2 = v.slice(0, v.indexOf(',')); const payload = v.slice(v.indexOf(',') + 1);
            const mm = head2.match(/^data:([^;]*)/i); mime = mm ? mm[1] : '';
            bytes = /;base64/i.test(head2) ? b64ToBytes(normB64(payload)) : enc.encode(decodeURIComponent(payload));
          } else {
            const b64 = normB64(v); bytes = b64ToBytes(b64); mime = sniffImageMime(bytes);
            dataUri = 'data:' + mime + ';base64,' + b64;
          }
          result.appendChild(buildPreview(dataUri, { mime, size: bytes.length }));
        } catch (e) { status.textContent = 'Не удалось декодировать base64'; status.classList.add('err'); }
      }
      function onIn() { s.b2f = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 250); }
      input.addEventListener('input', onIn); run();
    }

    render();
  }

  // ---- JSONPath (две точки ввода) ----
  function renderJsonPath(root) {
    const s = stFor('jsonpath');
    const head = el('div', 'tl-bar'); head.appendChild(el('span', 'tl-lbl', 'JSON')); head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить JSON', async () => { try { const t = await lite.readClipboard(); jin.value = t || ''; run(); save(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { jin.value = ''; run(); save(); }));
    root.appendChild(head);
    const jin = area('{ "user": { "roles": ["admin"] } }', ''); jin.rows = 7; jin.value = s.json || ''; root.appendChild(jin);
    const pathBar = el('div', 'tl-bar'); pathBar.appendChild(el('span', 'tl-lbl', 'Путь'));
    const path = el('input', 'tl-input'); path.placeholder = '.user.roles[0]'; path.value = s.path || ''; pathBar.appendChild(path);
    root.appendChild(pathBar);
    const oh = el('div', 'tl-bar tl-outhead'); oh.appendChild(el('span', 'tl-lbl', 'Результат')); oh.appendChild(spacer());
    oh.appendChild(actBtn('copy', 'Копировать', () => { if (output.value) { lite.copyText(output.value); toast('Скопировано'); } }));
    root.appendChild(oh);
    const output = area('', 'tl-out'); output.readOnly = true; root.appendChild(output);
    const status = el('div', 'tl-status'); root.appendChild(status);
    function save() { s.json = jin.value; s.path = path.value; persistSoon(); }
    function run() {
      if (!jin.value.trim() || !path.value.trim()) { output.value = ''; status.textContent = ''; status.classList.remove('err'); return; }
      try { output.value = jsonPath(jin.value, path.value.trim()); status.textContent = ''; status.classList.remove('err'); }
      catch (e) { output.value = ''; status.textContent = String(e && e.message || e); status.classList.add('err'); }
    }
    const deb = () => { save(); run(); };
    jin.addEventListener('input', deb); path.addEventListener('input', deb);
    run();
  }

  // ---- Хэши ----
  function renderHash(root) {
    const s = stFor('hash');
    const head = el('div', 'tl-bar'); head.appendChild(el('span', 'tl-lbl', 'Текст')); head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); input.value = t || ''; onIn(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
    root.appendChild(head);
    const input = area('Текст для хэширования…'); input.rows = 5; input.value = s.text || ''; root.appendChild(input);
    const rows = {};
    for (const algo of ['MD5', 'SHA-1', 'SHA-256', 'SHA-512']) {
      const r = el('div', 'tl-hashrow');
      r.appendChild(el('span', 'tl-hashname', algo));
      const val = el('input', 'tl-input tl-mono'); val.readOnly = true; r.appendChild(val);
      r.appendChild(actBtn('copy', 'Копировать ' + algo, () => { if (val.value) { lite.copyText(val.value); toast(algo + ' скопирован'); } }));
      rows[algo] = val; root.appendChild(r);
    }
    let seq = 0, timer = null;
    async function run() {
      const bytes = enc.encode(input.value);
      if (!input.value) { for (const k in rows) rows[k].value = ''; return; }
      rows['MD5'].value = md5(bytes);
      const my = ++seq;
      const [s1, s256, s512] = await Promise.all([sha('SHA-1', bytes), sha('SHA-256', bytes), sha('SHA-512', bytes)]);
      if (my !== seq) return;
      rows['SHA-1'].value = s1; rows['SHA-256'].value = s256; rows['SHA-512'].value = s512;
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 120); }
    input.addEventListener('input', onIn); run();
  }

  // ---- JWT ----
  function renderJwt(root) {
    const s = stFor('jwt');
    const head = el('div', 'tl-bar'); head.appendChild(el('span', 'tl-lbl', 'JWT-токен')); head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); input.value = t || ''; onIn(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
    root.appendChild(head);
    const input = area('eyJhbGciOi...'); input.rows = 4; input.value = s.text || ''; root.appendChild(input);
    const note = el('div', 'tl-note', '⚠ Подпись не проверяется — только декодирование.'); root.appendChild(note);
    const times = el('div', 'tl-jwt-times'); root.appendChild(times);
    function block(title) { root.appendChild(el('div', 'tl-lbl', title)); const t = area('', 'tl-out'); t.readOnly = true; t.rows = 5; root.appendChild(t); return t; }
    const hOut = block('Header'); const pOut = block('Payload');
    let timer = null;
    function run() {
      times.innerHTML = '';
      if (!input.value.trim()) { hOut.value = ''; pOut.value = ''; return; }
      try {
        const j = decodeJwt(input.value);
        hOut.value = JSON.stringify(j.header, null, 2); hOut.classList.remove('err-area');
        pOut.value = JSON.stringify(j.payload, null, 2);
        const p = j.payload || {};
        const fmt = (k, label) => { if (p[k] == null) return; const d = new Date(p[k] * 1000); const exp = k === 'exp' && d.getTime() < Date.now(); times.appendChild(el('div', 'tl-jwt-time' + (exp ? ' err' : ''), label + ': ' + d.toLocaleString('ru-RU') + ' (' + relTime(d.getTime()) + ')' + (exp ? ' — истёк' : ''))); };
        fmt('iat', 'Выдан'); fmt('nbf', 'Активен с'); fmt('exp', 'Истекает');
      } catch (e) { hOut.value = ''; pOut.value = ''; times.appendChild(el('div', 'tl-jwt-time err', String(e && e.message || e))); }
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 120); }
    input.addEventListener('input', onIn); run();
  }
  function decodeJwt(token) {
    const parts = token.trim().split('.');
    if (parts.length < 2) throw new Error('Не похоже на JWT (нужно ≥2 части через точку)');
    let header, payload;
    try { header = JSON.parse(b64urlDecode(parts[0])); } catch (_) { throw new Error('Header не декодируется'); }
    try { payload = JSON.parse(b64urlDecode(parts[1])); } catch (_) { throw new Error('Payload не декодируется'); }
    return { header, payload, signature: parts[2] || '' };
  }

  // ---- Timestamp ----
  function renderTs(root) {
    const s = stFor('ts');
    const head = el('div', 'tl-bar');
    const nowBtn = el('button', 'tl-btn', 'Сейчас'); nowBtn.onclick = () => { input.value = String(Math.floor(Date.now() / 1000)); onIn(); };
    head.appendChild(nowBtn); head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); input.value = (t || '').trim(); onIn(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
    root.appendChild(head);
    const input = el('input', 'tl-input'); input.placeholder = 'Unix (сек/мс) или дата (2026-06-18 12:00)'; input.value = s.text || ''; root.appendChild(input);
    const out = el('div', 'tl-ts-out'); root.appendChild(out);
    let timer = null;
    function run() {
      out.innerHTML = ''; const v = input.value.trim(); if (!v) return;
      let date;
      if (/^-?\d+$/.test(v)) { let n = Number(v); if (v.length <= 11) n *= 1000; date = new Date(n); } else { const p = Date.parse(v); if (isNaN(p)) { out.appendChild(el('div', 'tl-status err', 'Не распознано как unix-время или дата')); return; } date = new Date(p); }
      if (isNaN(date.getTime())) { out.appendChild(el('div', 'tl-status err', 'Неверная дата')); return; }
      const rows = [
        ['Локально', date.toLocaleString('ru-RU')],
        ['UTC', date.toUTCString()],
        ['ISO 8601', date.toISOString()],
        ['Относительно', relTime(date.getTime())],
        ['Unix (сек)', String(Math.floor(date.getTime() / 1000))],
        ['Unix (мс)', String(date.getTime())],
      ];
      for (const [k, val] of rows) {
        const r = el('div', 'tl-ts-row'); r.appendChild(el('span', 'tl-ts-key', k)); r.appendChild(el('span', 'tl-ts-val', val));
        const cp = actBtn('copy', 'Копировать', () => { lite.copyText(val); toast('Скопировано'); }); r.appendChild(cp); out.appendChild(r);
      }
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 120); }
    input.addEventListener('input', onIn); run();
  }

  // ---- Регистр / транслит ----
  function renderCase(root) {
    const s = stFor('case');
    const head = el('div', 'tl-bar'); head.appendChild(el('span', 'tl-lbl', 'Текст')); head.appendChild(spacer());
    head.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); input.value = t || ''; onIn(); } catch (_) {} }));
    head.appendChild(actBtn('eraser', 'Очистить', () => { input.value = ''; onIn(); }));
    root.appendChild(head);
    const input = area('Например: Привет мир / hello_world'); input.rows = 3; input.value = s.text || ''; root.appendChild(input);
    const list = el('div', 'tl-varlist'); root.appendChild(list);
    let timer = null;
    function run() {
      list.innerHTML = ''; if (!input.value.trim()) return;
      for (const [name, val] of caseVariants(input.value)) {
        const r = el('div', 'tl-varrow'); r.appendChild(el('span', 'tl-varname', name)); r.appendChild(el('span', 'tl-varval', val || '—'));
        r.appendChild(actBtn('copy', 'Копировать', () => { if (val) { lite.copyText(val); toast('Скопировано'); } })); list.appendChild(r);
      }
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 120); }
    input.addEventListener('input', onIn); run();
  }

  // ---- Regex-тестер ----
  function renderRegex(root) {
    const s = stFor('regex');
    const pb = el('div', 'tl-bar');
    const pat = el('input', 'tl-input tl-mono'); pat.placeholder = 'паттерн, напр. (\\w+)@(\\w+)'; pat.value = s.pattern || ''; pb.appendChild(pat);
    const flags = el('input', 'tl-input tl-flags'); flags.placeholder = 'gimsu'; flags.value = s.flags != null ? s.flags : 'g'; flags.title = 'Флаги: g i m s u y'; pb.appendChild(flags);
    root.appendChild(pb);
    const th = el('div', 'tl-bar'); th.appendChild(el('span', 'tl-lbl', 'Тестовый текст')); th.appendChild(spacer());
    th.appendChild(actBtn('clipboard', 'Вставить', async () => { try { const t = await lite.readClipboard(); text.value = t || ''; run(); save(); } catch (_) {} }));
    root.appendChild(th);
    const text = area('Текст для проверки…'); text.rows = 5; text.value = s.text || ''; root.appendChild(text);
    const status = el('div', 'tl-status'); root.appendChild(status);
    const hl = el('div', 'tl-regex-hl'); root.appendChild(hl);
    const matchBox = el('div', 'tl-regex-matches'); root.appendChild(matchBox);
    function save() { s.pattern = pat.value; s.flags = flags.value; s.text = text.value; persistSoon(); }
    function run() {
      hl.innerHTML = ''; matchBox.innerHTML = ''; status.textContent = ''; status.classList.remove('err');
      if (!pat.value) return;
      let re; try { re = new RegExp(pat.value, flags.value || ''); } catch (e) { status.textContent = String(e && e.message || e); status.classList.add('err'); return; }
      const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      const src = text.value; let last = 0; let count = 0;
      try {
        for (const m of src.matchAll(gre)) {
          count++;
          if (m.index > last) hl.appendChild(document.createTextNode(src.slice(last, m.index)));
          const mk = el('mark', 'tl-mark', m[0]); hl.appendChild(mk); last = m.index + m[0].length;
          if (m[0] === '' ) { last++; } // защита от пустых совпадений
          const row = el('div', 'tl-match'); row.appendChild(el('span', 'tl-match-n', '#' + count));
          row.appendChild(el('span', 'tl-match-v', JSON.stringify(m[0])));
          if (m.length > 1) row.appendChild(el('span', 'tl-match-g', 'группы: ' + m.slice(1).map((g) => JSON.stringify(g)).join(', ')));
          if (count <= 200) matchBox.appendChild(row);
        }
      } catch (e) { status.textContent = String(e && e.message || e); status.classList.add('err'); return; }
      if (last < src.length) hl.appendChild(document.createTextNode(src.slice(last)));
      status.textContent = count ? ('Совпадений: ' + count + (count > 200 ? ' (показаны первые 200)' : '')) : 'Совпадений нет';
    }
    const deb = () => { save(); run(); };
    pat.addEventListener('input', deb); flags.addEventListener('input', deb); text.addEventListener('input', deb);
    run();
  }

  // ---- Diff двух текстов ----
  function renderDiff(root) {
    const s = stFor('diff');
    const grid = el('div', 'tl-diff-grid');
    const a = area('Текст A…'); a.rows = 7; a.value = s.a || '';
    const b = area('Текст B…'); b.rows = 7; b.value = s.b || '';
    grid.append(wrapLbl('A', a), wrapLbl('B', b)); root.appendChild(grid);
    const status = el('div', 'tl-status'); root.appendChild(status);
    const view = el('div', 'tl-diff-view'); root.appendChild(view);
    let timer = null;
    function wrapLbl(lbl, node) { const w = el('div', 'tl-diff-col'); w.appendChild(el('span', 'tl-lbl', lbl)); w.appendChild(node); return w; }
    function run() {
      status.textContent = ''; status.classList.remove('err'); view.innerHTML = '';
      if (!a.value && !b.value) return;
      try {
        const d = lineDiff(a.value, b.value);
        if (!d.changes) { status.textContent = 'Тексты идентичны'; return; }
        renderDiffInto(view, d.text, null); status.textContent = 'Различий (строк): ' + d.changes;
      } catch (e) { status.textContent = String(e && e.message || e); status.classList.add('err'); }
    }
    function onIn() { s.a = a.value; s.b = b.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 160); }
    a.addEventListener('input', onIn); b.addEventListener('input', onIn); run();
  }

  // ---- Lorem / тестовые данные ----
  function renderLorem(root) {
    const s = stFor('lorem');
    const bar = el('div', 'tl-bar');
    let kind = s.kind || 'para';
    bar.appendChild(seg([['para', 'Абзацы'], ['sent', 'Предложения'], ['words', 'Слова']], kind, (v) => { kind = v; s.kind = v; persistSoon(); }));
    bar.appendChild(el('span', 'tl-lbl', 'кол-во'));
    const cnt = el('input', 'tl-input tl-num'); cnt.type = 'number'; cnt.min = '1'; cnt.value = s.count || '3'; bar.appendChild(cnt);
    const gen = el('button', 'tl-btn primary', 'Сгенерировать'); bar.appendChild(gen);
    root.appendChild(bar);
    const fakeBar = el('div', 'tl-bar');
    fakeBar.appendChild(el('span', 'tl-lbl', 'Фейк-данные:'));
    for (const [label, fn] of [['email', fakeEmail], ['имя', () => pick(NAMES) + ' ' + pick(SURN)], ['число', () => String(rnd(100000))]]) {
      const fb = el('button', 'tl-btn', label); fb.onclick = () => { out.value = fn(); }; fakeBar.appendChild(fb);
    }
    root.appendChild(fakeBar);
    const oh = el('div', 'tl-bar tl-outhead'); oh.appendChild(el('span', 'tl-lbl', 'Результат')); oh.appendChild(spacer());
    oh.appendChild(actBtn('copy', 'Копировать', () => { if (out.value) { lite.copyText(out.value); toast('Скопировано'); } }));
    root.appendChild(oh);
    const out = area('', 'tl-out'); out.readOnly = true; out.rows = 8; root.appendChild(out);
    gen.onclick = () => {
      const n = Math.max(1, Math.min(500, parseInt(cnt.value, 10) || 1)); s.count = String(n); persistSoon();
      out.value = kind === 'para' ? Array.from({ length: n }, loremParagraph).join('\n\n') : kind === 'sent' ? Array.from({ length: n }, loremSentence).join(' ') : loremWords(n);
    };
  }

  // ---- Цвет ----
  function renderColor(root) {
    const s = stFor('color');
    const bar = el('div', 'tl-bar');
    const input = el('input', 'tl-input tl-mono'); input.placeholder = '#3b82f6  ·  rgb(59,130,246)  ·  hsl(217,91%,60%)'; input.value = s.text || '#3b82f6'; bar.appendChild(input);
    const swatch = el('div', 'tl-swatch'); bar.appendChild(swatch);
    root.appendChild(bar);
    const status = el('div', 'tl-status'); root.appendChild(status);
    const out = el('div', 'tl-color-out'); root.appendChild(out);
    let timer = null;
    function run() {
      out.innerHTML = ''; status.textContent = ''; status.classList.remove('err');
      if (!input.value.trim()) { swatch.style.background = 'transparent'; return; }
      let col; try { col = parseColor(input.value); } catch (e) { status.textContent = String(e && e.message || e); status.classList.add('err'); swatch.style.background = 'transparent'; return; }
      const { r, g, b, a } = col; swatch.style.background = `rgba(${r},${g},${b},${a})`;
      const hsl = rgbToHsl(r, g, b);
      const fmts = [
        ['HEX', '#' + hex2(r) + hex2(g) + hex2(b) + (a < 1 ? hex2(a * 255) : '')],
        ['RGB', a < 1 ? `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})` : `rgb(${r}, ${g}, ${b})`],
        ['HSL', a < 1 ? `hsla(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%, ${+a.toFixed(3)})` : `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`],
      ];
      for (const [k, val] of fmts) {
        const r2 = el('div', 'tl-ts-row'); r2.appendChild(el('span', 'tl-ts-key', k)); r2.appendChild(el('span', 'tl-ts-val tl-mono', val));
        r2.appendChild(actBtn('copy', 'Копировать', () => { lite.copyText(val); toast('Скопировано'); })); out.appendChild(r2);
      }
    }
    function onIn() { s.text = input.value; persistSoon(); clearTimeout(timer); timer = setTimeout(run, 120); }
    input.addEventListener('input', onIn); run();
  }

  // ------------------------------ оболочка панели ------------------------------
  function renderTabs() {
    if (!tabsWrapEl) return;
    tabsWrapEl.innerHTML = ''; const q = filterText.trim().toLowerCase();
    for (const [cat, items] of CATS) {
      const vis = items.filter(([id, label]) => !q || label.toLowerCase().includes(q) || id.includes(q));
      if (!vis.length) continue;
      tabsWrapEl.appendChild(el('div', 'tl-cat', cat));
      const row = el('div', 'tl-catrow');
      for (const [id, label, ic] of vis) {
        const b = el('button', 'tl-tab' + (id === active ? ' active' : ''));
        b.append(icon(ic, 14), el('span', null, label));
        b.onclick = () => { if (active === id) return; active = id; st.__tab = id; persistSoon(); renderTabs(); renderActive(); };
        row.appendChild(b);
      }
      tabsWrapEl.appendChild(row);
    }
  }
  function renderActive() {
    if (!contentEl) return; contentEl.innerHTML = '';
    const fn = RENDER[active] || RENDER.base64;
    try { fn(contentEl); } catch (e) { contentEl.appendChild(el('div', 'tl-status err', 'Ошибка инструмента: ' + (e && e.message || e))); }
  }
  function renderBody() {
    const body = $('#tools-body'); if (!body) return;
    body.innerHTML = '';
    const top = el('div', 'tl-top');
    const filter = el('input', 'tl-filter'); filter.type = 'search'; filter.placeholder = 'Фильтр инструментов…'; filter.value = filterText;
    filter.oninput = () => { filterText = filter.value; renderTabs(); };
    top.appendChild(filter); body.appendChild(top);
    tabsWrapEl = el('div', 'tl-tabs'); body.appendChild(tabsWrapEl);
    contentEl = el('div', 'tl-content'); body.appendChild(contentEl);
    renderTabs(); renderActive();
  }

  // ------------------------------ контракт панели правого слота ------------------------------
  function setToolsOpen(open, opts = {}) {
    if (open === toolsOpen) { if (open) renderBody(); return; }
    if (open) closeOtherPanels('tools');
    const delta = layout.tools + GUTTER;
    toolsOpen = open;
    $('#tools-pane').classList.toggle('hidden', !open);
    $('#gutter-tools').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderBody();
    setTimeout(refitActiveTerminal, 150);
  }

  return {
    isOpen: () => toolsOpen,
    setOpen: setToolsOpen,
    toggle: () => setToolsOpen(!toolsOpen),
  };
}
