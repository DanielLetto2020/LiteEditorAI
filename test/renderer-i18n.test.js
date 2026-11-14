// Тест DOM-локализации фронта (renderer/i18n.js): буквальная подстановка спецпоследовательностей
// $& / $$ / $' / $` в переводах, сохранение русских омонимов и переперевод шаблонных узлов при
// горячем переключении языков (ru → en → zh → ru), а также сброс снимка при внешнем изменении узла.
// Запуск: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/renderer-i18n.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

// Минимальный DOM-каркас для запуска renderer/i18n.js в чистом Node без браузера.
class MockNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.isConnected = true;
  }
  get parentElement() { return this.parentNode instanceof MockElement ? this.parentNode : null; }
}

class MockText extends MockNode {
  constructor(text) {
    super(3);
    this.nodeValue = text;
  }
}

class MockElement extends MockNode {
  constructor(tagName = 'DIV') {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map();
    this.children = [];
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, val) { this.attrs.set(name, String(val)); }
  removeAttribute(name) { this.attrs.delete(name); }
  matches(_sel) { return this.attrs.has('data-no-i18n'); }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur instanceof MockElement && cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

const g = /** @type {any} */ (globalThis);
g.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
g.Element = MockElement;
g.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
g.MutationObserver = class {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
};

const docEl = new MockElement('HTML');
const body = docEl.appendChild(new MockElement('BODY'));

g.document = {
  documentElement: docEl,
  body,
  createTreeWalker(root, _what, /** @type {any} */ filter) {
    const list = [];
    function walk(node) {
      for (const ch of (node.children || [])) {
        const verdict = filter.acceptNode(ch);
        if (verdict === g.NodeFilter.FILTER_REJECT) continue;
        if (verdict === g.NodeFilter.FILTER_ACCEPT) list.push(ch);
        if (ch.children && ch.children.length) walk(ch);
      }
    }
    walk(root);
    let idx = 0;
    return { nextNode: () => (idx < list.length ? list[idx++] : null) };
  },
};
g.window = { lite: null };

(async () => {
  const { applyLocale, translate, t } = await import(
    pathToFileURL(path.join(__dirname, '..', 'renderer', 'i18n.js')).href
  );

  const EN_DICT = {
    'Без названия': 'Untitled',
    'Безымянный': 'Untitled',
    'Цена и шаблон': 'Price $$ & match $& and tail $\'',
    'Найдено {0} файлов': 'Found {0} files',
    '#{0} / {1}': 'Item #{0} of {1}',
    'Закрыть': 'Close',
    'Закрыть вкладку': 'Close',
  };

  const ZH_DICT = {
    'Без названия': '无标题',
    'Безымянный': '未命名',
    'Цена и шаблон': '价格 $$ 与 $&',
    'Найдено {0} файлов': '找到 {0} 个文件',
    '#{0} / {1}': '第 {0} 项（共 {1} 项）',
    'Закрыть': '关闭',
    'Закрыть вкладку': '关闭标签页',
  };

  const n1 = body.appendChild(new MockElement('SPAN'));
  const tHomonym1 = n1.appendChild(new MockText('  Без названия  '));
  const n2 = body.appendChild(new MockElement('SPAN'));
  const tHomonym2 = n2.appendChild(new MockText('Безымянный'));
  const n3 = body.appendChild(new MockElement('DIV'));
  const tDollar = n3.appendChild(new MockText('  Цена и шаблон  '));
  const n4 = body.appendChild(new MockElement('DIV'));
  const tPattern = n4.appendChild(new MockText('Найдено 5 файлов'));
  const n5 = body.appendChild(new MockElement('DIV'));
  const tNonCyrPattern = n5.appendChild(new MockText('#3 / 10'));
  const btn1 = body.appendChild(new MockElement('BUTTON'));
  btn1.setAttribute('title', 'Закрыть');
  const btn2 = body.appendChild(new MockElement('BUTTON'));
  btn2.setAttribute('title', 'Закрыть вкладку');
  const noI18n = body.appendChild(new MockElement('CODE'));
  noI18n.setAttribute('data-no-i18n', '');
  const tSkipped = noI18n.appendChild(new MockText('Без названия'));

  // 1. Переключение ru → en
  applyLocale({ code: 'en', dict: EN_DICT, rtl: false });
  eq(tHomonym1.nodeValue, '  Untitled  ', 'окружающие пробелы сохранены при переводе');
  eq(tHomonym2.nodeValue, 'Untitled', 'второй омоним тоже переведён в Untitled');
  // В String.replace без функции '$$' превращалось бы в один '$', а '$&' — в 'Цена и шаблон'!
  eq(tDollar.nodeValue, '  Price $$ & match $& and tail $\'  ', 'спецпоследовательности $, $$, $&, $\' вставляются буквально');
  eq(tPattern.nodeValue, 'Found 5 files', 'шаблонный узел переведён');
  eq(tNonCyrPattern.nodeValue, 'Item #3 of 10', 'шаблон без кириллицы в DOM переведён');
  eq(btn1.getAttribute('title'), 'Close', 'атрибут title 1 переведён');
  eq(btn2.getAttribute('title'), 'Close', 'атрибут title 2 (омоним) переведён');
  eq(tSkipped.nodeValue, 'Без названия', 'data-no-i18n не переводится');
  eq(t('Найдено {0} файлов', 8), 'Found 8 files', 't() подставляет аргумент в шаблон');

  // 2. Горячее переключение en → zh (оба омонима в en были 'Untitled', но в zh у них РАЗНЫЕ переводы!)
  applyLocale({ code: 'zh', dict: ZH_DICT, rtl: false });
  eq(tHomonym1.nodeValue, '  无标题  ', 'первый омоним получил точный китайский перевод из своего русского исходника');
  eq(tHomonym2.nodeValue, '未命名', 'второй омоним получил свой отдельный китайский перевод');
  eq(tPattern.nodeValue, '找到 5 个文件', 'шаблонный узел перепереведён при смене en → zh');
  eq(tNonCyrPattern.nodeValue, '第 3 项（共 10 项）', 'шаблон без кириллицы перепереведён на zh');
  eq(btn1.getAttribute('title'), '关闭', 'атрибут 1 переведён на zh без потери омонима');
  eq(btn2.getAttribute('title'), '关闭标签页', 'атрибут 2 переведён на zh без потери омонима');

  // 3. Возврат zh → ru: оба омонима и шаблонные узлы возвращаются к точным русским исходникам
  applyLocale({ code: 'ru', dict: {}, rtl: false });
  eq(tHomonym1.nodeValue, '  Без названия  ', 'первый омоним точно восстановлен на русском');
  eq(tHomonym2.nodeValue, 'Безымянный', 'второй омоним точно восстановлен на русском (не стал «Без названия»)');
  eq(tDollar.nodeValue, '  Цена и шаблон  ', 'строка со знаками $ восстановлена на русском');
  eq(tPattern.nodeValue, 'Найдено 5 файлов', 'шаблонный узел восстановлен на русском');
  eq(tNonCyrPattern.nodeValue, '#3 / 10', 'шаблон без кириллицы восстановлен');
  eq(btn1.getAttribute('title'), 'Закрыть', 'атрибут 1 восстановлен');
  eq(btn2.getAttribute('title'), 'Закрыть вкладку', 'атрибут 2 точно восстановлен');

  // 4. Внешнее обновление текста узла при активном en должно сбрасывать старый снимок
  applyLocale({ code: 'en', dict: EN_DICT, rtl: false });
  eq(tPattern.nodeValue, 'Found 5 files', 'переведено в 5 files');
  tPattern.nodeValue = 'Найдено 42 файлов';
  translate(n4);
  eq(tPattern.nodeValue, 'Found 42 files', 'внешнее изменение узла переведено заново с новым числом');
  applyLocale({ code: 'ru', dict: {}, rtl: false });
  eq(tPattern.nodeValue, 'Найдено 42 файлов', 'после возврата на ru сохранилось новое число 42, а не старое 5');

  ok(passed >= 20, 'достаточное покрытие проверок');
  console.log(`✓ renderer-i18n: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
