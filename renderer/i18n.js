// ============================================================================
// renderer/i18n.js — локализация интерфейса на стороне фронта.
//
// Работает БЕЗ переписывания трёх тысяч мест в коде: словарь приходит из main
// (preload → window.lite.i18n), а DOM переводится по точным совпадениям строк —
// то, что в словаре есть, заменяется; всё остальное (имена проектов и файлов,
// вывод терминала, код в вивере, данные пользователя) остаётся как есть.
//
// Три уровня:
//   1) t(s, ...args)        — явный перевод в коде (сообщения, шаблоны с {0})
//   2) translate(root)      — проход по готовому DOM: текст + title/placeholder/…
//   3) observe()            — MutationObserver: всё, что модули дорисуют потом
//
// Смена языка на лету — через обратный индекс (перевод → исходная строка), так
// что второй проход находит уже переведённые узлы и не требует перезагрузки окна.
// ============================================================================

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-hint'];
// Живой текст, который переводить нельзя ни при каких совпадениях.
const SKIP_SEL = '.xterm, .cm-editor, .CodeMirror, [data-no-i18n], script, style, code.hljs';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CANVAS']);

let locale = 'ru';
let dict = Object.create(null);        // ru-строка → перевод
let reverse = Object.create(null);     // перевод → ru-строка (для смены языка на лету)
let patterns = [];                     // { re, order, out }
let patternIndex = new Map();
let observer = null;
let applying = false;                  // защита от реакции наблюдателя на наши же правки

function compilePatterns(d) {
  patterns = [];
  patternIndex = new Map();
  for (const [k, v] of Object.entries(d)) {
    if (!/\{\d\}/.test(k)) continue;
    const parts = k.split(/\{(\d)\}/);
    let re = '^';
    const order = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) re += parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else { re += '([\\s\\S]*?)'; order.push(Number(parts[i])); }
    }
    const entry = { re: new RegExp(re + '$'), order, out: v };
    patterns.push(entry);
    const anchor = (k.match(/[А-Яа-яЁё]+/) || [''])[0].toLowerCase();
    if (!patternIndex.has(anchor)) patternIndex.set(anchor, []);
    patternIndex.get(anchor).push(entry);
  }
}

function setDict(code, d) {
  locale = String(code || 'ru');
  dict = Object.create(null);
  reverse = Object.create(null);
  for (const [k, v] of Object.entries(d || {})) {
    if (!v || k === '@@meta') continue;
    dict[k] = v;
    if (!reverse[v]) reverse[v] = k;
  }
  compilePatterns(dict);
}

// Исходная (русская) строка для текста, который уже мог быть переведён.
function sourceOf(text) {
  if (dict[text]) return text;          // это ключ (русский исходник)
  if (reverse[text]) return reverse[text];
  return text;
}

function byPattern(s) {
  if (!patterns.length) return null;
  const anchor = (s.match(/[А-Яа-яЁё]+/) || [''])[0].toLowerCase();
  const list = patternIndex.get(anchor);
  if (!list) return null;
  for (const p of list) {
    const m = p.re.exec(s);
    if (m) return p.out.replace(/\{(\d)\}/g, (_, i) => m[p.order.indexOf(Number(i)) + 1] ?? '');
  }
  return null;
}

export function t(src, ...args) {
  let s = String(src == null ? '' : src);
  if (locale !== 'ru') {
    const key = sourceOf(s);
    if (dict[key]) s = dict[key];
    else { const p = byPattern(s); if (p != null) s = p; }
  }
  if (args.length) s = s.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] ?? ''));
  return s;
}

export function getLocale() { return locale; }
export function isTranslating() { return locale !== 'ru'; }

// --------------------------------------------------------------- DOM-перевод
function translateText(node) {
  const raw = node.nodeValue;
  if (!raw) return;
  const text = raw.trim();
  if (text.length < 1 || text.length > 400) return;
  const key = sourceOf(text);
  const hit = dict[key] || (locale === 'ru' && reverse[text] ? reverse[text] : null);
  const out = hit || byPattern(key);
  if (out == null || out === text) return;
  node.nodeValue = raw.replace(text, out);          // сохраняем окружающие пробелы
}

function translateAttrs(elem) {
  for (const a of ATTRS) {
    if (!elem.hasAttribute || !elem.hasAttribute(a)) continue;
    const val = elem.getAttribute(a);
    const text = (val || '').trim();
    if (!text) continue;
    const key = sourceOf(text);
    const out = dict[key] || (locale === 'ru' && reverse[text] ? reverse[text] : null) || byPattern(key);
    if (out != null && out !== text) elem.setAttribute(a, out);
  }
}

export function translate(root = document.body) {
  if (!root) return;
  applying = true;
  try {
    if (root.nodeType === Node.TEXT_NODE) { translateText(root); return; }
    if (root.closest && root.closest(SKIP_SEL)) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(n.tagName)) return NodeFilter.FILTER_REJECT;
          if (n.matches && n.matches(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) translateText(n);
      else translateAttrs(n);
    }
  } finally { applying = false; }
}

// Всё, что модули дорисовывают после старта (innerHTML, appendChild, смена title).
export function observe(root = document.documentElement) {
  if (observer || !root) return;
  observer = new MutationObserver((records) => {
    if (applying || locale === 'ru') return;
    applying = true;
    try {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) {
            if (n.nodeType === Node.TEXT_NODE) translateText(n);
            else if (n.nodeType === Node.ELEMENT_NODE) { applying = false; translate(n); applying = true; }
          }
        } else if (r.type === 'attributes' && r.target && r.target.nodeType === Node.ELEMENT_NODE) {
          if (!(r.target.closest && r.target.closest(SKIP_SEL))) translateAttrs(r.target);
        } else if (r.type === 'characterData' && r.target) {
          if (!(r.target.parentElement && r.target.parentElement.closest(SKIP_SEL))) translateText(r.target);
        }
      }
    } finally { applying = false; }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// ------------------------------------------------------------------- запуск
// Словарь приезжает синхронно из preload — до первого прохода по DOM, чтобы
// интерфейс не мигал русским текстом.
export function initI18n() {
  try {
    const api = window.lite && window.lite.i18n;
    if (!api) return 'ru';
    const cur = api.current ? api.current() : { code: 'ru', dict: {} };
    setDict(cur.code, cur.dict);
    document.documentElement.setAttribute('lang', locale);
    if (cur.rtl) document.documentElement.setAttribute('dir', 'rtl');
    if (locale !== 'ru') {
      const run = () => { translate(document.body); observe(); };
      if (document.body) run(); else document.addEventListener('DOMContentLoaded', run, { once: true });
    } else observe();
    if (api.onChange) api.onChange((next) => applyLocale(next));
  } catch (e) { try { window.lite && window.lite.log('warn', 'i18n init', String(e)); } catch (_) {} }
  return locale;
}

// Смена языка на лету: пересобираем словарь и проходим DOM ещё раз. Обратный
// индекс прошлого языка позволяет найти исходную строку у уже переведённых узлов.
export function applyLocale(next) {
  if (!next || !next.code) return;
  const prevReverse = reverse;
  setDict(next.code, next.dict);
  for (const [translated, ru] of Object.entries(prevReverse)) if (!reverse[translated]) reverse[translated] = ru;
  document.documentElement.setAttribute('lang', locale);
  if (next.rtl) document.documentElement.setAttribute('dir', 'rtl'); else document.documentElement.removeAttribute('dir');
  translate(document.body);
  observe();
}
