// Тест кэширования SVG-прототипов в renderer/ui.js: icon(), fileTypeSvg(), folderTypeSvg()
// парсят шаблон через <template>.innerHTML один раз на уникальный ключ и возвращают независимые клоны cloneNode(true).
// Запуск: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/ui-icons.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

let templateParses = 0;

class MockElement {
  constructor(tagName = 'DIV') {
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.textContent = '';
    this.attrs = new Map();
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) || null; }
  cloneNode(deep = false) {
    const copy = new MockElement(this.tagName);
    copy.className = this.className;
    copy.textContent = this.textContent;
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    if (deep) {
      for (const ch of this.children) copy.appendChild(ch.cloneNode(true));
    }
    return copy;
  }
}

function parseSvgSnippet(html) {
  const svg = new MockElement('svg');
  const openTag = (html.match(/^<svg\b([^>]*)>/i) || ['', ''])[1];
  for (const m of openTag.matchAll(/([\w-]+)="([^"]*)"/g)) {
    if (m[1] === 'class') svg.className = m[2];
    svg.setAttribute(m[1], m[2]);
  }
  const inner = html.replace(/^<svg\b[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
  for (const tag of inner.matchAll(/<(\w+)\b([^>]*?)\/?>/g)) {
    const child = new MockElement(tag[1]);
    for (const a of tag[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(a[1], a[2]);
    svg.appendChild(child);
  }
  return svg;
}

class MockTemplate {
  constructor() {
    this.content = { firstChild: null };
  }
  set innerHTML(html) {
    templateParses++;
    this.content.firstChild = parseSvgSnippet(String(html).trim());
  }
}

const g = /** @type {any} */ (globalThis);
g.HTMLElement = MockElement;
g.document = {
  createElement(tag) {
    if (String(tag).toLowerCase() === 'template') return new MockTemplate();
    return new MockElement(tag);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

(async () => {
  const { icon, fileTypeSvg, folderTypeSvg } = await import(
    pathToFileURL(path.join(__dirname, '..', 'renderer', 'ui.js')).href
  );

  // 1. icon(name, size) парсит SVG ровно один раз на пару (name, size) и отдаёт независимые клоны
  templateParses = 0;
  const a1 = /** @type {any} */ (icon('folder', 16));
  const a2 = /** @type {any} */ (icon('folder', 16));
  const a3 = /** @type {any} */ (icon('folder', 16));
  eq(templateParses, 1, 'icon(folder, 16) распарсен ровно 1 раз для трёх вызовов');
  ok(a1 !== a2 && a2 !== a3, 'каждый вызов icon() возвращает отдельный DOM-узел');
  eq(a1.getAttribute('width'), '16', 'размер 16 сохранён');
  ok(a1.children.length > 0 && a1.children[0] !== a2.children[0], 'глубокое клонирование дочерних <path>');

  // Мутация выданного узла не портит прототип в кэше
  a1.className = 'mutated';
  a1.setAttribute('data-test', 'dirty');
  a1.children[0].setAttribute('fill', 'red');
  const a4 = /** @type {any} */ (icon('folder', 16));
  eq(templateParses, 1, 'повторный вызов после мутации клона по-прежнему берёт прототип из кэша');
  eq(a4.className, 'ic', 'прототип не затронут изменением className у клона');
  eq(a4.getAttribute('data-test'), null, 'прототип не затронут setAttribute у клона');
  eq(a4.children[0].getAttribute('fill'), null, 'дочерний path прототипа не затронут');

  // Другой размер — отдельный ключ кэша
  const s14 = /** @type {any} */ (icon('folder', 14));
  eq(templateParses, 2, 'icon(folder, 14) создаёт отдельный прототип');
  eq(s14.getAttribute('width'), '14', 'ширина 14');
  icon('folder', 14);
  eq(templateParses, 2, 'повторный icon(folder, 14) берётся из кэша');

  // Неизвестное имя иконки — пустой <svg>, тоже кэшируется
  const unk1 = /** @type {any} */ (icon('__no_such_icon__', 16));
  const unk2 = /** @type {any} */ (icon('__no_such_icon__', 16));
  eq(templateParses, 3, 'неизвестная иконка парсится один раз');
  eq(unk1.children.length, 0, 'неизвестная иконка без дочерних фигур');
  ok(unk1 !== unk2, 'неизвестная иконка тоже клонируется');

  // 2. fileTypeSvg кэширует прототип по итоговому цвету (расширения одной группы делят прототип)
  const beforeFiles = templateParses;
  const fJs = /** @type {any} */ (fileTypeSvg('index.js'));
  const fMjs = /** @type {any} */ (fileTypeSvg('worker.mjs'));
  const fCjs = /** @type {any} */ (fileTypeSvg('legacy.cjs'));
  eq(templateParses - beforeFiles, 1, '.js, .mjs и .cjs делят один прототип по цвету #e8d44d');
  ok(fJs !== fMjs && fMjs !== fCjs, 'значки файлов — независимые клоны');
  eq(fJs.children[0].getAttribute('fill'), '#e8d44d', 'цвет JS-значка');

  const fTs = /** @type {any} */ (fileTypeSvg('types.ts'));
  eq(templateParses - beforeFiles, 2, '.ts создаёт свой прототип по цвету #4a9be0');
  eq(fTs.children[0].getAttribute('fill'), '#4a9be0', 'цвет TS-значка');

  // 3. folderTypeSvg кэширует закрытую и открытую папку отдельно
  const beforeFolders = templateParses;
  const dClosed1 = /** @type {any} */ (folderTypeSvg(false));
  const dClosed2 = /** @type {any} */ (folderTypeSvg(false));
  const dOpen1 = /** @type {any} */ (folderTypeSvg(true));
  const dOpen2 = /** @type {any} */ (folderTypeSvg(true));
  eq(templateParses - beforeFolders, 2, 'два прототипа папок (open / closed)');
  ok(dClosed1 !== dClosed2 && dOpen1 !== dOpen2, 'значки папок — независимые клоны');
  eq(dClosed1.children[0].getAttribute('style'), 'fill:var(--green)', 'закрытая папка');
  eq(dOpen1.children[0].getAttribute('style'), 'fill:var(--green-bright)', 'открытая папка');

  console.log(`ui-icons.test: ${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
