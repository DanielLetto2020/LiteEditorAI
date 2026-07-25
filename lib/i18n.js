// ============================================================================
// lib/i18n.js — ядро локализации (main-процесс).
//
// Локали — ПОДКЛЮЧАЕМЫЕ ФАЙЛЫ, два каталога:
//   1) <приложение>/locales/<код>.json   — встроенные (ru, en, zh)
//   2) ~/.LiteEditorAI/locales/<код>.json — пользовательские: свой язык или правки
//      к встроенному (перекрывают ключи того же кода, приложение не пересобирать)
//
// Ключ = сама русская строка (msgid, как в gettext). Подстановки — {0}, {1}…
// Файл может содержать служебный ключ "@@meta": { "name": "English",
// "nativeName": "English", "rtl": false } — им подписан язык в настройках.
//
// Русский особый: он же исходный язык, поэтому работает без файла (identity).
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILTIN_DIR = path.join(__dirname, '..', 'locales');
const USER_DIR = path.join(os.homedir(), '.LiteEditorAI', 'locales');
const META = '@@meta';

// Имена языков на самих языках — для кодов без @@meta в файле.
const KNOWN = {
  ru: { name: 'Russian', nativeName: 'Русский' },
  en: { name: 'English', nativeName: 'English' },
  zh: { name: 'Chinese (Simplified)', nativeName: '简体中文' },
};

let current = 'ru';
let currentRtl = false;
let dict = {};                 // ru-ключ → перевод
let patterns = [];             // { re, out } для строк с {N}
let patternIndex = new Map();  // первое слово ключа → [шаблоны] (чтобы не гонять все регулярки)

// Файлы локалей крупные (en/zh — сотни килобайт), а спрашивают их часто: словарь
// уходит в КАЖДОЕ окно синхронным IPC. Поэтому парсим один раз и держим по mtime —
// без кэша открытие каждого окна модуля ждало разбор всех локалей разом.
const jsonCache = new Map();           // path → { mtimeMs, size, data }
function readJson(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { jsonCache.delete(file); return null; }
  const hit = jsonCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch (_) { return null; }
}

function localeFiles(code) {
  return [path.join(BUILTIN_DIR, `${code}.json`), path.join(USER_DIR, `${code}.json`)];
}

// Словарь языка: английский как база (если язык переведён не полностью, строка
// покажется по-английски, а не по-русски — для не-русскоязычного это читаемо),
// поверх — встроенный файл языка, поверх — пользовательские перекрытия.
function loadDict(code) {
  const out = {};
  const files = code === 'en' ? localeFiles('en') : [...localeFiles('en'), ...localeFiles(code)];
  for (const f of files) {
    const d = readJson(f);
    if (d && typeof d === 'object') Object.assign(out, d);
  }
  delete out[META];
  return out;
}

function metaFor(code) {
  let meta = { ...(KNOWN[code] || {}) };
  for (const f of localeFiles(code)) {
    const d = readJson(f);
    if (d && d[META] && typeof d[META] === 'object') meta = { ...meta, ...d[META] };
  }
  return {
    code,
    name: meta.name || code,
    nativeName: meta.nativeName || meta.name || code,
    rtl: !!meta.rtl,
    builtin: fs.existsSync(path.join(BUILTIN_DIR, `${code}.json`)) || code === 'ru',
  };
}

// Все доступные языки: ru всегда + все *.json из обоих каталогов.
function available() {
  const codes = new Set(['ru']);
  for (const dir of [BUILTIN_DIR, USER_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      const m = /^([a-zA-Z][a-zA-Z0-9_-]{0,15})\.json$/.exec(n);
      if (m) codes.add(m[1].toLowerCase());
    }
  }
  return [...codes].map(metaFor).sort((a, b) => (a.code === 'ru' ? -1 : b.code === 'ru' ? 1 : a.code.localeCompare(b.code)));
}

// Шаблоны ({0}) компилируем в регулярки и раскладываем по первому слову ключа.
function buildPatterns(d) {
  patterns = [];
  patternIndex = new Map();
  for (const [k, v] of Object.entries(d)) {
    if (!k.includes('{0}') && !/\{\d\}/.test(k)) continue;
    const parts = k.split(/\{(\d)\}/);            // [текст, индекс, текст, …]
    let re = '^';
    const order = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) re += parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else { re += '([\\s\\S]*?)'; order.push(Number(parts[i])); }
    }
    re += '$';
    const entry = { re: new RegExp(re), order, out: v };
    patterns.push(entry);
    const anchor = (k.match(/[А-Яа-яЁё]+/) || [''])[0].toLowerCase();
    if (!patternIndex.has(anchor)) patternIndex.set(anchor, []);
    patternIndex.get(anchor).push(entry);
  }
}

function setLocale(code) {
  current = String(code || 'ru').toLowerCase();
  dict = current === 'ru' ? {} : loadDict(current);
  currentRtl = current === 'ru' ? false : !!metaFor(current).rtl;
  buildPatterns(dict);
  return current;
}

function isRtl() { return currentRtl; }

function locale() { return current; }
function dictionary() { return dict; }
function patternList() {
  return patterns.map((p) => ({ source: p.re.source, order: p.order, out: p.out }));
}

// Перевод строки + подстановка аргументов: t('Найдено {0}', 3).
function t(src, ...args) {
  let s = String(src == null ? '' : src);
  if (current !== 'ru' && dict[s]) s = dict[s];
  else if (current !== 'ru' && patterns.length) {
    const anchor = (s.match(/[А-Яа-яЁё]+/) || [''])[0].toLowerCase();
    for (const p of (patternIndex.get(anchor) || [])) {
      const m = p.re.exec(s);
      if (m) { s = p.out.replace(/\{(\d)\}/g, (_, i) => m[p.order.indexOf(Number(i)) + 1] ?? ''); break; }
    }
  }
  if (args.length) s = s.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] ?? ''));
  return s;
}

setLocale('ru');

module.exports = { t, setLocale, locale, isRtl, available, dictionary, patternList, USER_DIR, BUILTIN_DIR };
