// Тест быстрого листинга и поиска по файлам (lib/fast-search.js):
// проверяет оба движка — системный ripgrep (`useRg: true`, если установлен) и фолбэк `worker_threads`
// (`useRg: false`), включая .gitignore, скрытые файлы, кириллицу, лимиты, маски и отмену gsearch.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fastSearch = require('../lib/fast-search');

if (__dirname.includes('.stryker-tmp') || process.env.STRYKER_MUTATOR_WORKER) {
  console.log('fast-search: пропущен под Stryker');
  process.exit(0);
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-fastsearch-'));
  const rootA = path.join(tmp, 'proj-a');
  const rootB = path.join(tmp, 'proj-b');

  try {
    fs.mkdirSync(path.join(rootA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(rootA, 'ignored-build'), { recursive: true });
    fs.mkdirSync(path.join(rootA, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(rootA, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'docs'), { recursive: true });

    fs.writeFileSync(path.join(rootA, '.gitignore'), 'ignored-build/\n*.secret\n');
    fs.writeFileSync(path.join(rootA, 'src', 'app.js'), [
      'const greeting = "Привет, мир — needleToken";',
      'function run() { return greeting; }',
      'const dup = "foo foo";',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(rootA, '.env.example'), 'API_KEY=needleToken\n');
    fs.writeFileSync(path.join(rootA, '.github', 'workflows', 'ci.yml'), 'name: needleToken\n');
    fs.writeFileSync(path.join(rootA, 'ignored-build', 'bundle.js'), 'needleToken\n');
    fs.writeFileSync(path.join(rootA, 'dump.secret'), 'needleToken\n');
    fs.writeFileSync(path.join(rootA, 'node_modules', 'pkg', 'index.js'), 'needleToken\n');
    fs.writeFileSync(path.join(rootA, 'src', '.app.js.abc.lite-tmp'), 'needleToken\n');
    // Бинарный файл с NUL — не должен попадать в текстовый поиск
    fs.writeFileSync(path.join(rootA, 'src', 'bin.dat'), Buffer.from([0x00, 0x01, ...Buffer.from('needleToken')]));
    // Петля симлинка на корень
    fs.symlinkSync('..', path.join(rootA, 'src', 'loop-up'));

    fs.writeFileSync(path.join(rootB, 'docs', 'guide.md'), '# Документация\nПоиск needleToken во втором проекте.\n');

    const rgBin = await fastSearch.detectRipgrep();
    const modes = [false];
    if (rgBin) modes.unshift(true);

    for (const useRg of modes) {
      const tag = useRg ? 'rg' : 'worker';

      // 1. listFiles: видит обычные и скрытые неигнорируемые файлы, отсекает .gitignore, node_modules, .litewrite.tmp и петли
      const listed = await fastSearch.listFiles(rootA, { useRg });
      ok(!('error' in listed), `${tag}: listFiles без ошибки`);
      const set = new Set((listed.files || []).map((f) => f.split(path.sep).join('/')));
      ok(set.has('src/app.js'), `${tag}: src/app.js найден`);
      ok(set.has('.env.example'), `${tag}: скрытый .env.example найден`);
      ok(set.has('.github/workflows/ci.yml'), `${tag}: .github/workflows/ci.yml найден`);
      ok(!set.has('ignored-build/bundle.js'), `${tag}: папка из .gitignore скрыта`);
      ok(!set.has('dump.secret'), `${tag}: маска *.secret из .gitignore скрыта`);
      ok(!set.has('node_modules/pkg/index.js'), `${tag}: node_modules скрыт`);
      ok(![...set].some((f) => f.endsWith('.lite-tmp')), `${tag}: временный файл автосейва скрыт`);

      // Лимит cap в listFiles
      const cappedList = await fastSearch.listFiles(rootA, { cap: 2, useRg });
      ok(cappedList.files && cappedList.files.length === 2 && cappedList.capped === true, `${tag}: cap=2 выставляет capped=true`);

      // 2. searchProject: точный символьный столбец после кириллицы, отсечение бинарей и мусора
      const sr = await fastSearch.searchProject(rootA, 'needleToken', { caseSensitive: true, useRg });
      ok(!('error' in sr) && Array.isArray(sr.matches), `${tag}: searchProject без ошибки`);
      const appHit = (sr.matches || []).find((m) => m.file.split(path.sep).join('/') === 'src/app.js');
      ok(!!appHit && appHit.line === 1, `${tag}: найдено совпадение в src/app.js:1`);
      const expectedCol = 'const greeting = "Привет, мир — '.length + 1;
      ok(!!appHit && appHit.col === expectedCol, `${tag}: символьный col после кириллицы точен (${appHit && appHit.col} === ${expectedCol})`);
      ok(!(sr.matches || []).some((m) => m.file.includes('bin.dat')), `${tag}: бинарный файл пропущен`);
      ok(!(sr.matches || []).some((m) => m.file.includes('ignored-build')), `${tag}: игнорируемый каталог пропущен`);

      // Некорректный регэксп честно возвращает ошибку
      const badRe = await fastSearch.searchProject(rootA, '([unclosed', { regex: true, useRg });
      ok('error' in badRe && !!badRe.error, `${tag}: битый регэксп возвращает error`);

      // Регэксп с обратной ссылкой \1 (даже при useRg=true прозрачно отрабатывает через worker фолбэк!)
      const backRef = await fastSearch.searchProject(rootA, '\\b(foo)\\s+\\1\\b', { regex: true, useRg });
      ok(Array.isArray(backRef.matches) && backRef.matches.length === 1 && backRef.matches[0].line === 3, `${tag}: обратная ссылка \\1 нашла "foo foo"`);

      // 3. startGlobalSearch: стриминг пачками по двум проектам, маски include/exclude и режим both
      /** @type {any[]} */
      const hits = [];
      const ctrl = fastSearch.startGlobalSearch({
        roots: [
          { id: 'a', name: 'Proj A', path: rootA },
          { id: 'b', name: 'Proj B', path: rootB },
        ],
        query: 'needleToken',
        opts: { mode: 'content', caseSensitive: true, include: '*.js, *.md', exclude: '*.yml' },
        useRg,
        onHits: (b) => hits.push(...b),
      });
      ok(ctrl.ok, `${tag}: gsearch стартовал`);
      const done = await ctrl.promise;
      ok(done.total === 2 && done.files === 2 && hits.length === 2, `${tag}: gsearch с масками нашёл ровно 2 файла (app.js и guide.md), получено ${done.total}`);
      ok(hits.every((h) => h.text.slice(h.mcol, h.mcol + h.len) === 'needleToken'), `${tag}: подсветка mcol..mcol+len указывает ровно на совпадение`);

      // Режим names
      /** @type {any[]} */
      const nameHits = [];
      const nameCtrl = fastSearch.startGlobalSearch({
        roots: [{ id: 'a', name: 'Proj A', path: rootA }, { id: 'b', name: 'Proj B', path: rootB }],
        query: 'guide',
        opts: { mode: 'names' },
        useRg,
        onHits: (b) => nameHits.push(...b),
      });
      const nameDone = await nameCtrl.promise;
      ok(nameDone.total === 1 && nameHits[0].file === 'docs/guide.md' && nameHits[0].line === 0, `${tag}: режим names нашёл docs/guide.md`);

      // Отмена на лету
      const cancelCtrl = fastSearch.startGlobalSearch({
        roots: [{ id: 'a', name: 'Proj A', path: rootA }, { id: 'b', name: 'Proj B', path: rootB }],
        query: 'needleToken',
        opts: { mode: 'content' },
        useRg,
      });
      cancelCtrl.cancel();
      const cancelDone = await cancelCtrl.promise;
      ok(cancelDone.cancelled === true, `${tag}: отмена корректно выставляет cancelled=true`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`fast-search: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
