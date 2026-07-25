#!/usr/bin/env node
// ============================================================================
// i18n-extract.js — собирает ВСЕ русские строки интерфейса в locales/ru.json
// (источник истины для переводчиков) и сверяет с ним остальные локали.
//
//   node scripts/i18n-extract.js               # обновить locales/ru.json + отчёт по локалям
//   node scripts/i18n-extract.js --check       # только отчёт, код возврата 1 при пропусках
//   node scripts/i18n-extract.js --missing en  # выгрузить непереведённое в /tmp (порциями работать)
//   node scripts/i18n-extract.js --verbose     # показать примеры пропусков/лишних ключей
//
// Ключ перевода = САМА русская строка (как msgid в gettext): не нужно придумывать
// имена и переписывать 3 тысячи мест в коде. Строки с подстановками (`${...}`)
// сохраняются шаблоном с {0}, {1}… — движок сопоставляет их по шаблону.
//
// HTML-шаблоны внутри JS (`innerHTML = '<h2>Настройки</h2>…'`) НЕ попадают в словарь
// целиком: из них извлекаются отдельные тексты и переводимые атрибуты — ровно так,
// как их потом видит DOM-переводчик (см. renderer/i18n.js).
// ============================================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = path.join(ROOT, 'locales');
const CYR = /[А-Яа-яЁё]/;

const INCLUDE_DIRS = ['renderer', 'lib'];
const INCLUDE_FILES = ['main.js', 'preload.js', 'errledger.js'];
const SKIP_RE = /^(test|tmp|scripts|android|relay|mcp|module-kit|node_modules|dist|dist-release|release|assets|locales)[\\/]|[\\/]dist[\\/]/;

// ------------------------------------------------------------------ сканер JS
// Один проход по символам: различает код, строки, шаблоны, regex-литералы и
// комментарии. Без этого regex вида /['"]/ уводит наивный парсер в сторону и
// половина строк файла теряется.
const BEFORE_REGEX = /[({[,;:!&|?+\-*=~^%<>]$|\b(return|typeof|case|in|of|delete|void|instanceof|new|do|else|yield|await)$/;

function scanJs(src) {
  const strings = [];          // { text, template }
  let i = 0;
  let prev = '';               // последний значимый символ/слово перед текущей позицией

  const readString = (quote) => {
    let raw = '';
    i++;                                        // открывающая кавычка
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { raw += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === quote) { i++; break; }
      raw += c;
      i++;
    }
    return raw;
  };

  const readTemplate = () => {
    let raw = '';
    let n = 0;
    i++;                                        // открывающий `
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { raw += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') {     // подстановка → {N}, вложенность и строки учитываем
        i += 2;
        let depth = 1;
        let q = null;
        while (i < src.length && depth > 0) {
          const d = src[i];
          if (q) {
            if (d === '\\') { i += 2; continue; }
            if (d === q) q = null;
            i++;
            continue;
          }
          if (d === '"' || d === "'" || d === '`') { q = d; i++; continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          i++;
        }
        raw += '{' + (n++) + '}';
        continue;
      }
      raw += c;
      i++;
    }
    return raw;
  };

  while (i < src.length) {
    const c = src[i];
    const nx = src[i + 1];
    if (c === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && nx === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '/' && BEFORE_REGEX.test(prev)) {  // regex-литерал: проглотить целиком
      i++;
      let cls = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) { i++; break; }
        else if (d === '\n') break;
        i++;
      }
      while (/[a-z]/.test(src[i] || '')) i++;    // флаги
      prev = '/';
      continue;
    }
    if (c === '"' || c === "'") { strings.push({ text: readString(c), template: false }); prev = '"'; continue; }
    if (c === '`') { strings.push({ text: readTemplate(), template: true }); prev = '`'; continue; }
    if (!/\s/.test(c)) {
      prev = /[A-Za-z_$]/.test(c) ? (prev.match(/[A-Za-z_$]+$/) ? prev + c : c) : c;
    } else if (prev && !/[A-Za-z_$]$/.test(prev)) {
      // пробел не сбрасывает слово, но сбрасывает одиночный символ-разделитель
    }
    i++;
  }
  return strings;
}

function unescape(raw) {
  return raw
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '')
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, '\\');
}

// HTML-сущности → символы: в DOM окажется именно символ, значит и ключ должен быть таким
// («О&nbsp;программе» в разметке = «О программе» в текстовом узле).
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', deg: '°', copy: '©' };
function decodeEntities(s) {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (ENTITIES[name] !== undefined ? ENTITIES[name] : m))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

const looksLikeHtml = (s) => /<[a-zA-Z][^>]*>/.test(s);
const looksLikeCode = (s) => /\bconst\s|\blet\s|=>|\bfunction\b|\breturn\s|;\s*\n/.test(s) && !looksLikeHtml(s);

function isJunk(s) {
  const t = s.trim();
  if (!t || !CYR.test(t)) return true;
  // Односимвольные ключи («а», «б» — карта раскладки US↔RU в ui.js) переводить нельзя:
  // подмена по точному совпадению задела бы любую такую букву в интерфейсе.
  if (t.length < 2) return true;
  if (t.length > 400) return true;                        // портянки-инструкции агенту: не UI
  if (/\[[А-Яа-яЁё]-[А-Яа-яЁё]\]/.test(t)) return true;   // класс регулярки [А-Яа-я]
  if (/^\{\d+\}$/.test(t)) return true;
  if (looksLikeCode(t)) return true;
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return true;          // одни знаки
  return false;
}

// Текст и переводимые атрибуты из HTML-фрагмента (файл целиком или шаблон в JS).
function fromHtml(src, out) {
  const body = src.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const s = decodeEntities(unescape(m[1])).replace(/[ \t]+/g, ' ').trim();
    if (!isJunk(s)) out.push(s);
  }
  // текст после последнего тега (шаблоны часто заканчиваются текстом)
  const tail = body.split('>').pop();
  if (tail && !tail.includes('<')) {
    const s = decodeEntities(unescape(tail)).replace(/[ \t]+/g, ' ').trim();
    if (!isJunk(s)) out.push(s);
  }
  for (const m of body.matchAll(/\b(?:title|placeholder|aria-label|alt|data-hint)\s*=\s*(["'])(.*?)\1/g)) {
    const s = decodeEntities(unescape(m[2])).replace(/[ \t]+/g, ' ').trim();
    if (!isJunk(s)) out.push(s);
  }
  for (const sc of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    pushJs(sc[1], out);
  }
}

function pushJs(src, out) {
  for (const { text, template } of scanJs(src)) {
    if (!CYR.test(text)) continue;
    const s = unescape(text);
    if (looksLikeHtml(s)) { fromHtml(s, out); continue; }   // HTML-шаблон → по частям
    const one = template ? s : s;
    if (!isJunk(one)) out.push(one.replace(/\s+/g, ' ').trim() === one.trim() ? one : one);
  }
}

function collectFiles() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (SKIP_RE.test(path.relative(ROOT, abs))) continue;
      if (e.isDirectory()) walk(abs);
      else if (/\.(js|html)$/.test(e.name)) files.push(abs);
    }
  };
  for (const d of INCLUDE_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  for (const f of INCLUDE_FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f));
  return files;
}

// ------------------------------------------------------------------- сборка
const keys = new Map();                        // строка → Set(файлы)
for (const abs of collectFiles()) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  if (abs.endsWith('.html')) fromHtml(src, out); else pushJs(src, out);
  for (const s of out) {
    if (!keys.has(s)) keys.set(s, new Set());
    keys.get(s).add(rel);
  }
}

const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
const check = process.argv.includes('--check');
fs.mkdirSync(LOCALES, { recursive: true });

const ru = {};
for (const k of sorted) ru[k] = k;             // русский = identity

if (!check) {
  fs.writeFileSync(path.join(LOCALES, 'ru.json'), JSON.stringify(ru, null, 1) + '\n');
  const chars = sorted.reduce((a, k) => a + k.length, 0);
  console.log(`[i18n] locales/ru.json — ${sorted.length} строк, ${chars} символов`);
}

let missingTotal = 0;
for (const file of fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json') && f !== 'ru.json')) {
  const code = path.basename(file, '.json');
  let dict = {};
  try { dict = JSON.parse(fs.readFileSync(path.join(LOCALES, file), 'utf8')); }
  catch (e) { console.log(`[i18n] ${code}: НЕВАЛИДНЫЙ JSON — ${e.message}`); process.exitCode = 1; continue; }
  const missing = sorted.filter((k) => !dict[k] || !String(dict[k]).trim());
  const stale = Object.keys(dict).filter((k) => !ru[k] && k !== '@@meta');
  missingTotal += missing.length;
  const pct = sorted.length ? Math.round(((sorted.length - missing.length) / sorted.length) * 100) : 100;
  console.log(`[i18n] ${code}: ${sorted.length - missing.length}/${sorted.length} (${pct}%)` + (stale.length ? ` · устарело: ${stale.length}` : ''));
  if (process.argv.includes('--verbose')) {
    missing.slice(0, 40).forEach((k) => console.log('   нет: ' + JSON.stringify(k.slice(0, 90))));
    stale.slice(0, 20).forEach((k) => console.log('   лишний: ' + JSON.stringify(k.slice(0, 90))));
  }
  const mi = process.argv.indexOf('--missing');
  if (mi > -1 && process.argv[mi + 1] === code) {
    const out = path.join(os.tmpdir(), `i18n-missing-${code}.json`);
    fs.writeFileSync(out, JSON.stringify(missing, null, 1) + '\n');
    console.log(`   → ${missing.length} строк выгружено в ${out}`);
  }
}
if (check && missingTotal) process.exitCode = 1;
