// Комплексные модульные тесты ядра IDE-вивера «Проект» (renderer/modules/files/*):
//   1. BufferPool: независимые буферы, preview-вкладки, промоут, защита грязного буфера,
//      pin + порядок вкладок, reorder, сплит-группы, MRU, remapPaths, dropUnder, навигация Назад/Вперёд,
//      детектор/конвертер отступов и EOL;
//   2. SymbolIndex: извлечение символов 15+ языков + расчёт endLine (незалипание вне тела функции/класса),
//      wordAtOffset, findIdentifierRanges, extractImportSpecAtLine, resolveImportTarget,
//      фоновый индексер проекта (createProjectSymbolIndex), валидация JSON/YAML и форматирование кода;
//   3. SmartComplete: автодополнение относительных путей импортов (./, ../, подпапки);
//   4. GitHunks & Graph: разбор unified-диффа по ханкам с патчами отката, findHunkAtLine, stepHunkAnchor,
//      топологическая раскладка цветного графа коммитов (ветвления + merge) и генерация SVG;
//   5. Overlays & Preview: fuzzyScore и маршрутизация превью (SVG открывается как код с переключением превью).
// Запуск: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/viewer-ide.test.js

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); passed++; };
const deq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const toUrl = (rel) => pathToFileURL(path.join(__dirname, '..', rel)).href;

(async () => {
  const bp = await import(toUrl('renderer/modules/files/buffer-pool.js'));
  const si = await import(toUrl('renderer/modules/files/symbol-index.js'));
  const sc = await import(toUrl('renderer/modules/files/smart-complete.js'));
  const gh = await import(toUrl('renderer/modules/files/git-hunks.js'));
  const md = await import(toUrl('renderer/modules/files/modals.js'));

  // =========================================================================
  // 1. EOL, детектор и конвертер отступов
  // =========================================================================
  eq(bp.eolOfText('a\r\nb\r\nc\r\n'), '\r\n', 'определён CRLF');
  eq(bp.eolOfText('a\nb\nc\n'), '\n', 'определён LF');
  eq(bp.toDiskEol('x\ny\n', '\r\n'), 'x\r\ny\r\n', 'конвертация в CRLF при записи');
  eq(bp.toDiskEol('x\r\ny\r\n', '\n'), 'x\ny\n', 'конвертация в LF при записи');
  ok(bp.isVirtualTabId('diff:/proj/a.js') && bp.isVirtualTabId('cdiff:abc1234:a.js') && !bp.isVirtualTabId('/proj/a.js'), 'виртуальные id вкладок');

  {
    const ind4 = bp.detectIndentSpec('function a() {\n    const x = 1;\n    if (x) {\n        return x;\n    }\n}\n');
    eq(ind4.useTabs, false, 'детектор: пробелы');
    eq(ind4.tabSize, 4, 'детектор: шаг 4 пробела');

    const indTab = bp.detectIndentSpec('func main() {\n\tfmt.Println(1)\n\tif true {\n\t\treturn\n\t}\n}\n');
    eq(indTab.useTabs, true, 'детектор: табуляция');

    const convertedTo4 = bp.convertIndentation('if (a) {\n  run();\n    nested();\n}', { useTabs: false, tabSize: 4 });
    eq(convertedTo4, 'if (a) {\n    run();\n        nested();\n}', 'конвертация 2 пробелов в 4 пробела');

    const convertedToTabs = bp.convertIndentation('if (a) {\n    run();\n}', { useTabs: true, tabSize: 4 });
    eq(convertedToTabs, 'if (a) {\n\trun();\n}', 'конвертация 4 пробелов в табы');
  }

  // =========================================================================
  // 2. BufferPool: preview, pin, dirty-защита, split, MRU, remap/drop, nav
  // =========================================================================
  {
    const pool = bp.createBufferPool();
    pool.ensureBuffer('/proj/a.js', { title: 'a.js' });
    pool.ensureBuffer('/proj/b.js', { title: 'b.js' });
    pool.ensureBuffer('/proj/c.js', { title: 'c.js' });

    // Одиночный клик открывает preview-вкладку; следующий одиночный клик заменяет её
    pool.openTabInGroup('primary', '/proj/a.js', { preview: true });
    eq(pool.groupState('primary').previewTab, '/proj/a.js', 'a.js открыт как preview');
    pool.openTabInGroup('primary', '/proj/b.js', { preview: true });
    deq(pool.groupState('primary').tabs, ['/proj/b.js'], 'чистый preview a.js заменён на b.js');
    ok(!pool.hasBuffer('/proj/a.js'), 'вытесненный чистый буфер a.js выгружен из пула');

    // Если preview-буфер стал грязным, новый preview НЕ затирает его!
    pool.getBuffer('/proj/b.js').dirty = true;
    pool.openTabInGroup('primary', '/proj/c.js', { preview: true });
    deq(pool.groupState('primary').tabs, ['/proj/b.js', '/proj/c.js'], 'грязный b.js сохранён при открытии нового preview c.js');

    // Промоут preview в постоянную вкладку
    pool.promotePreview('/proj/c.js');
    eq(pool.groupState('primary').previewTab, null, 'c.js промоутирован из preview');

    // Pin переносит вкладку в начало левой зоны
    pool.togglePin('primary', '/proj/c.js');
    deq(pool.groupState('primary').tabs, ['/proj/c.js', '/proj/b.js'], 'закреплённая вкладка c.js встала первой');

    // Открытие третьей вкладки и проверка MRU + reorder внутри незакреплённых
    pool.ensureBuffer('/proj/d.js', { title: 'd.js' });
    pool.openTabInGroup('primary', '/proj/d.js', { preview: false });
    deq(pool.groupState('primary').tabs, ['/proj/c.js', '/proj/b.js', '/proj/d.js'], 'пины остаются слева при открытии новых');
    pool.reorderTab('primary', '/proj/d.js', 1);
    deq(pool.groupState('primary').tabs, ['/proj/c.js', '/proj/d.js', '/proj/b.js'], 'перестановка обычных вкладок работает');
    pool.reorderTab('primary', '/proj/d.js', 0);
    deq(pool.groupState('primary').tabs, ['/proj/c.js', '/proj/d.js', '/proj/b.js'], 'обычная вкладка не залезает в зону пинов');

    // Сплит-группа независима от основной
    pool.openTabInGroup('split', '/proj/d.js', { preview: false });
    eq(pool.groupState('split').active, '/proj/d.js', 'd.js открыт и в правой сплит-группе');

    // Переименование папки обновляет оба сплита, буферы и MRU
    pool.remapPaths('/proj', '/proj2');
    ok(pool.hasBuffer('/proj2/d.js') && !pool.hasBuffer('/proj/d.js'), 'remapPaths перенёс ключи буферов');
    eq(pool.groupState('split').active, '/proj2/d.js', 'remapPaths обновил сплит');
    ok(pool.groupState('primary').pinned.has('/proj2/c.js'), 'remapPaths обновил множество пинов');

    // Удаление файла вычищает его из всех групп
    const dropped = pool.dropUnder('/proj2/d.js');
    deq(dropped, ['/proj2/d.js'], 'dropUnder вернул удалённый буфер');
    eq(pool.groupState('split').tabs.length, 0, 'вкладка удалена из сплита');

    // История переходов по позициям курсора (коалесценция близких строк <= 4)
    pool.pushNav({ group: 'primary', tabId: '/proj2/c.js', line: 10, col: 2 });
    pool.pushNav({ group: 'primary', tabId: '/proj2/c.js', line: 12, col: 5 }); // коалесцируется
    pool.pushNav({ group: 'primary', tabId: '/proj2/b.js', line: 80, col: 1 });
    ok(pool.canNavBack() && !pool.canNavFwd(), 'можно шагнуть назад');
    const backHit = pool.stepNav(-1);
    eq(backHit.tabId, '/proj2/c.js', 'шаг назад вернул c.js');
    eq(backHit.line, 12, 'близкая строка в c.js была склеена в 12');
    const fwdHit = pool.stepNav(1);
    eq(fwdHit.tabId, '/proj2/b.js', 'шаг вперёд вернул b.js');

    // Сериализация воркспейса исключает виртуальные вкладки диффов
    pool.ensureBuffer('diff:/proj2/b.js', { kind: 'diff', path: '/proj2/b.js' });
    pool.openTabInGroup('primary', 'diff:/proj2/b.js', { preview: true });
    const ws = pool.serializeWorkspace('/proj2');
    ok(!ws.tabs.some((id) => id.startsWith('diff:')), 'виртуальный дифф не попадает в персист воркспейса');
    deq(ws.pinned, ['/proj2/c.js'], 'пины сериализованы');
  }

  // =========================================================================
  // 3. SymbolIndex: символы 15+ языков, незалипание endLine, импорты, индекс проекта, JSON/YAML
  // =========================================================================
  {
    const jsCode = [
      'export class UserService {',
      '  async findById(id) {',
      '    return id;',
      '  }',
      '}',
      '',
      '// Комментарий вне класса и функций (строка 7)',
      'const topFlag = true;',
      '',
      'export function helperFn(a, b) {',
      '  return a + b;',
      '}',
    ].join('\n');

    const syms = si.extractFileSymbols(jsCode, 'js');
    ok(syms.some((s) => s.name === 'UserService' && s.kind === 'class'), 'JS: найден класс UserService');
    ok(syms.some((s) => s.name === 'findById' && s.kind === 'method'), 'JS: найден метод findById');
    ok(syms.some((s) => s.name === 'helperFn' && s.kind === 'fn'), 'JS: найдена функция helperFn');

    const atMethod = si.enclosingSymbolAtLine(syms, 3);
    eq(atMethod && atMethod.name, 'findById', 'строка 3 внутри метода findById');
    const atGap = si.enclosingSymbolAtLine(syms, 7);
    eq(atGap, null, 'строка 7 вне класса и функций — символ НЕ залипает!');
    const atHelper = si.enclosingSymbolAtLine(syms, 11);
    eq(atHelper && atHelper.name, 'helperFn', 'строка 11 внутри helperFn');
  }

  {
    // PHP + Python + Go + Rust + Markdown
    const phpSyms = si.extractFileSymbols('<?php\nnamespace App\\Http;\nfinal class OrderController {\n  public function store(Request $r): Response {\n    return new Response();\n  }\n}\n', 'php');
    ok(phpSyms.some((s) => s.name === 'OrderController' && s.kind === 'class'), 'PHP: класс распознан');
    ok(phpSyms.some((s) => s.name === 'store'), 'PHP: метод store распознан');

    const pySyms = si.extractFileSymbols('class Worker:\n    def process(self, job):\n        return job\n\nx = 10\n', 'py');
    eq(si.enclosingSymbolAtLine(pySyms, 3)?.name, 'process', 'Python: внутри def process по отступам');
    eq(si.enclosingSymbolAtLine(pySyms, 5), null, 'Python: после выхода из отступа символ не залипает');

    const goSyms = si.extractFileSymbols('package main\ntype Server struct {\n  port int\n}\nfunc (s *Server) Start() error {\n  return nil\n}\n', 'go');
    ok(goSyms.some((s) => s.name === 'Server') && goSyms.some((s) => s.name === 'Start'), 'Go: struct и receiver-метод');

    const rsSyms = si.extractFileSymbols('pub struct Config {}\npub async fn connect() {}\n', 'rs');
    ok(rsSyms.some((s) => s.name === 'Config') && rsSyms.some((s) => s.name === 'connect'), 'Rust: struct и async fn');
  }

  {
    // Поиск слова, диапазонов для Rename и резолв импортов
    const sample = "import { fooBar } from './utils/helper';\nconst x = fooBar(1) + fooBar2;";
    const w = si.wordAtOffset(sample, 11);
    eq(w && w.word, 'fooBar', 'wordAtOffset на идентификаторе');
    const ranges = si.findIdentifierRanges(sample, 'fooBar');
    eq(ranges.length, 2, 'findIdentifierRanges нашёл ровно 2 целых вхождения (не задев fooBar2)');

    const spec = si.extractImportSpecAtLine(sample.split('\n')[0], 26);
    eq(spec, './utils/helper', 'extractImportSpecAtLine вернул путь импорта');
    const resolved = si.resolveImportTarget(
      '/repo',
      '/repo/src/app.ts',
      spec,
      ['src/app.ts', 'src/utils/helper/index.ts', 'package.json'],
    );
    eq(resolved, '/repo/src/utils/helper/index.ts', 'resolveImportTarget разрешил ./utils/helper -> index.ts');
  }

  {
    // Фоновый индекс символов проекта
    const virtualFs = new Map([
      ['/repo/src/math.ts', 'export function calcTotal(items) { return items.length; }\n'],
      ['/repo/src/user.ts', 'export class AccountManager {\n  login() {}\n}\n'],
    ]);
    const idx = si.createProjectSymbolIndex({
      listAll: async () => ['src/math.ts', 'src/user.ts', 'node_modules/pkg/index.js'],
      readFile: async (abs) => ({ content: virtualFs.get(abs) || '' }),
    });
    await idx.startIndex('/repo');
    const defs = idx.findDefinitions('calcTotal');
    eq(defs.length, 1, 'ProjectSymbolIndex нашёл экспортированную функцию calcTotal');
    eq(defs[0].rel, 'src/math.ts', 'путь определения calcTotal');
    const searchHits = idx.searchSymbols('Account');
    eq(searchHits[0]?.name, 'AccountManager', 'поиск #Account нашёл AccountManager');
  }

  {
    // Валидация JSON/YAML и форматтер
    eq(si.validateDocumentSyntax('{"ok": true}', 'json').length, 0, 'валидный JSON без ошибок');
    const badJson = si.validateDocumentSyntax('{\n  "a": 1,\n  "b": \n}', 'json');
    eq(badJson.length, 1, 'битый JSON даёт диагностику');
    ok(badJson[0].line >= 3, 'диагностика JSON указывает строку ошибки');

    eq(si.validateDocumentSyntax('name: app\nport: 8080\n', 'yaml').length, 0, 'валидный YAML без ошибок');
    const badYaml = si.validateDocumentSyntax('name: app\n  bad_indent: [1, 2\n', 'yml');
    eq(badYaml.length, 1, 'битый YAML даёт диагностику');
    eq(badYaml[0].line, 2, 'диагностика YAML указывает точную строку');

    const prettyJson = si.formatCodeText('{"a":1,"b":[2,3]}', 'json', { useTabs: false, tabSize: 2 });
    eq(prettyJson, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n', 'форматирование JSON с отступом 2 пробела');

    const trimmedMd = si.formatCodeText('Заголовок  \nОбычная строка   ', 'md', { useTabs: false, tabSize: 2 }, true);
    eq(trimmedMd, 'Заголовок  \nОбычная строка\n', 'форматтер сохраняет двойной пробел переноса в Markdown и чистит остальные хвосты');
  }

  // =========================================================================
  // 4. SmartComplete: автодополнение путей в импортах
  // =========================================================================
  {
    const relFiles = ['src/index.ts', 'src/components/Button.tsx', 'src/utils/date.ts'];
    const hit1 = sc.completeRelativePaths("import Btn from './", '/repo', '/repo/src/index.ts', relFiles);
    ok(hit1 && hit1.options.some((o) => o.label === 'components/'), 'подсказка подпапки components/');
    ok(hit1 && hit1.options.some((o) => o.label === 'utils/'), 'подсказка подпапки utils/');

    const hit2 = sc.completeRelativePaths("import { fmt } from '../utils/", '/repo', '/repo/src/components/Button.tsx', relFiles);
    ok(hit2 && hit2.options.some((o) => o.label === 'date.ts'), 'подсказка файла ../utils/date.ts');
  }

  // =========================================================================
  // 5. GitHunks и цветной SVG-граф коммитов
  // =========================================================================
  {
    const sampleDiff = [
      'diff --git a/app.js b/app.js',
      'index 1111111..2222222 100644',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -2,3 +2,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 20;',
      '+const c = 30;',
      ' export default a;',
      '@@ -20,2 +21,1 @@',
      '-oldCall();',
      ' keep();',
    ].join('\n');

    const parsed = gh.parseUnifiedDiff(sampleDiff);
    eq(parsed.hunks.length, 2, 'разобрано 2 ханка');
    eq(parsed.hunks[0].type, 'mod', 'первый ханк — модификация');
    eq(parsed.hunks[0].oldExcerpt, 'const b = 2;', 'извлечён старый текст ханка для Inline Peek');
    ok(parsed.hunks[0].patch.startsWith('diff --git a/app.js b/app.js\n') && parsed.hunks[0].patch.includes('@@ -2,3 +2,4 @@'), 'собран валидный изолированный патч для git apply -R');
    eq(parsed.hunks[1].type, 'del', 'второй ханк — удаление');

    const found = gh.findHunkAtLine(parsed.hunks, 3);
    eq(found && found.index, 0, 'findHunkAtLine нашёл 1-й ханк на строке 3');
    eq(gh.stepHunkAnchor(parsed.hunks, 1, 1), 3, 'F7 переходит к первому ханку на строку 3');
    eq(gh.stepHunkAnchor(parsed.hunks, 3, 1), 21, 'F7 со строки 3 переходит ко второму ханку на строку 21');
    eq(gh.stepHunkAnchor(parsed.hunks, 21, 1), 3, 'F7 с последнего ханка циклически возвращается к первому');

    const graphCommits = [
      { h: 'c4', p: ['c3', 'f2'] }, // merge-коммит
      { h: 'f2', p: ['c2'] },       // ветка фичи
      { h: 'c3', p: ['c2'] },       // основная ветка
      { h: 'c2', p: ['c1'] },       // общий предок
      { h: 'c1', p: [] },           // корень
    ];
    const rows = gh.layoutCommitGraph(graphCommits);
    eq(rows.length, 5, 'рассчитаны 5 строк графа');
    ok(rows[0].isMerge === true && rows[0].bottomEdges.length === 2, 'merge-коммит разветвляется на 2 дорожки');
    ok(rows[1].cols >= 2, 'параллельные ветки идут в 2 колонках');
    const svg = gh.buildCommitGraphSvg(rows[0], 2);
    ok(svg.startsWith('<svg ') && svg.includes('<path ') && svg.includes('</svg>'), 'buildCommitGraphSvg генерирует кривые слияния');
  }

  // =========================================================================
  // 6. Fuzzy-ранжирование Quick Open и типы превью
  // =========================================================================
  {
    const sExact = md.fuzzyScore('files.js', 'renderer/modules/files.js');
    const sSub = md.fuzzyScore('files.js', 'renderer/modules/my-files.js.bak');
    const sFuz = md.fuzzyScore('fjs', 'renderer/modules/files.js');
    ok(sExact > sSub && sSub > sFuz && sFuz > 0, 'точное имя файла > подстрока > fuzzy-совпадение');
    eq(md.fuzzyScore('zzz999', 'renderer/modules/files.js'), -1, 'несовпадающий запрос возвращает -1');

    eq(md.previewKindFor('diagram.svg'), 'svg', 'SVG открывается в режиме кода + живого SVG-превью, а не только как картинка');
    eq(md.previewKindFor('README.md'), 'markdown', 'Markdown распознан');
    eq(md.previewKindFor('photo.webp'), 'image', 'растровые изображения распознаны');
    eq(md.previewKindFor('server.php'), null, 'обычный код не включает режим превью');
  }

  console.log(`✓ viewer-ide: ${passed} проверок пройдено`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
