// Тесты компилятора .gitignore (lib/gitignore.js) и его связки с watchTree (lib/tree-watch.js).
// Запуск: node test/gitignore.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileGitignore, forProject, findIgnoreRoot, DEFAULT_IGNORE_DIRS } = require('../lib/gitignore');
const { watchTree } = require('../lib/tree-watch');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

(async () => {
  // 1. Базовые правила: комментарии, маски, привязка к корню, dir-only, отрицания `!`
  const gi = compileGitignore([
    '# комментарий',
    '',
    '*.log',
    '!important.log',
    '/coverage/',
    'renderer/dist/',
    '.stryker-tmp',
    'docs/**/draft-*.md',
    '\\#literal-hash.txt',
  ].join('\n'));

  ok(gi.ignores('node_modules', true), 'базовый DEFAULT_IGNORE_DIRS срабатывает для каталога');
  ok(gi.ignoresPath('node_modules/pkg/index.js'), 'путь внутри node_modules игнорируется');
  ok(gi.ignores('debug.log', false), '*.log в корне игнорируется');
  ok(gi.ignores('sub/app.log', false), '*.log в подпапке игнорируется');
  eq(gi.ignores('important.log', false), false, '!important.log возвращает файл');
  eq(gi.ignores('sub/important.log', false), false, '!important.log возвращает файл и в подпапке');

  ok(gi.ignores('coverage', true), '/coverage/ игнорирует корневой каталог');
  eq(gi.ignores('coverage', false), false, 'хвостовой слэш /coverage/ не матчит одноимённый файл');
  eq(gi.ignores('packages/a/coverage', true), false, 'ведущий слэш привязывает правило к корню');

  ok(gi.ignores('renderer/dist', true), 'вложенный каталог renderer/dist/ игнорируется');
  ok(gi.ignoresPath('renderer/dist/app.js'), 'файл внутри игнорируемого каталога отсекается ignoresPath');
  ok(gi.ignores('.stryker-tmp', true), '.stryker-tmp игнорируется');

  ok(gi.ignores('docs/draft-1.md', false), 'docs/**/draft-*.md матчит нулевой уровень подпапок');
  ok(gi.ignores('docs/a/b/draft-spec.md', false), 'docs/**/draft-*.md матчит глубокую вложенность');
  eq(gi.ignores('docs/a/b/final.md', false), false, 'неподходящий файл не игнорируется');
  ok(gi.ignores('#literal-hash.txt', false), 'экранированный \\# матчится как символ');
  eq(gi.ignores('src/main.js', false), false, 'обычный исходник не игнорируется');

  // 2. Кэш forProject по mtime/size и инвалидация при правке .gitignore
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-gitignore-test-'));
  try {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'generated/\n*.tmp\n', 'utf8');
    fs.mkdirSync(path.join(tmp, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'generated', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.infection', 'run1'), { recursive: true });

    const m1 = forProject(tmp);
    ok(m1.ignores('generated', true), 'forProject прочитал .gitignore');
    eq(m1.ignores('.infection', true), false, '.infection пока не в .gitignore');
    eq(findIgnoreRoot(path.join(tmp, 'src', 'deep')), tmp, 'findIgnoreRoot нашёл корень проекта из глубокой папки');

    // Дописываем новое правило в .gitignore → кэш должен обновиться
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'generated/\n.infection/\n*.tmp\n', 'utf8');
    const m2 = forProject(tmp);
    ok(m2.ignores('.infection', true), 'обновлённый .gitignore перечитан по размеру/mtime');

    // 3. Связка с watchTree на Linux: каталоги из .gitignore не получают inotify-наблюдений
    if (process.platform === 'linux') {
      const w = watchTree(tmp, {
        ignore: DEFAULT_IGNORE_DIRS,
        ignoreFilter: (rel, _name, isDir) => forProject(tmp).ignores(rel, isDir),
      });
      await w.ready;
      // Должны наблюдаться только tmp, tmp/src и tmp/src/deep = 3 каталога (generated и .infection отсечены!)
      eq(w.size(), 3, 'watchTree поставил наблюдения только на 3 неигнорируемых каталога');
      w.close();
    }

    console.log(`✓ gitignore: ${passed} проверок пройдено`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
