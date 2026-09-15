// Тест слежения за деревом проекта (lib/tree-watch.js): на Linux наблюдение ставится на каталоги,
// а не на каждый файл, и не заходит в игнорируемые каталоги. Работает на живой файловой системе.
// Запуск: node test/tree-watch.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watchTree } = require('../lib/tree-watch.js');

if (process.platform !== 'linux') {
  console.log('− tree-watch: пропущен, поведение по каталогам только для Linux');
  process.exit(0);
}

const IGNORE = new Set(['node_modules', '.git', 'vendor']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return; await sleep(20); }
  throw new Error('не дождался: ' + what);
}
// Сколько inotify-наблюдений реально держит процесс — счёт ядра, а не наш.
function kernelWatches() {
  let n = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.readlinkSync('/proc/self/fd/' + fd) !== 'anon_inode:inotify') continue;
      n += fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8').split('\n').filter((l) => l.startsWith('inotify')).length;
    } catch (_) {}
  }
  return n;
}
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(Date.now())); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-treewatch-'));
const watchers = [];
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

(async () => {
  try {
    // дерево: 3 рабочих каталога и тяжёлые игнорируемые
    for (let i = 0; i < 20; i++) touch(path.join(dir, 'src', 'a', `f${i}.js`));
    for (let i = 0; i < 30; i++) touch(path.join(dir, 'node_modules', `pkg${i}`, 'lib', 'index.js'));
    for (let i = 0; i < 10; i++) touch(path.join(dir, 'vendor', `v${i}`, 'x.php'));
    touch(path.join(dir, '.git', 'objects', 'ab', 'cd'));
    fs.mkdirSync(path.join(dir, 'src', 'b'));
    fs.symlinkSync(path.join(dir, 'node_modules'), path.join(dir, 'src', 'link'));

    const events = [];
    const w = watchTree(dir, { ignore: IGNORE });
    watchers.push(w);
    w.on('change', (type, rel) => events.push(rel));
    const errors = [];
    w.on('error', (e) => errors.push(e));
    await w.ready;

    // наблюдения — только на каталоги вне игнора: корень, src, src/a, src/b; симлинк не раскрыт
    ok(w.size() === 4, `ожидали 4 каталога под слежением, вышло ${w.size()}`);
    ok(kernelWatches() === 4, `ядро должно видеть 4 наблюдения, видит ${kernelWatches()}`);

    // правка файла глубоко в дереве приходит путём от корня
    touch(path.join(dir, 'src', 'a', 'f3.js'));
    await waitFor(() => events.includes(path.join('src', 'a', 'f3.js')), 'событие src/a/f3.js');
    ok(true, 'правка вложенного файла');

    // внутри игнорируемого каталога событий нет вовсе
    touch(path.join(dir, 'node_modules', 'pkg1', 'lib', 'index.js'));
    touch(path.join(dir, 'vendor', 'v1', 'x.php'));
    await sleep(300);
    ok(!events.some((e) => e.startsWith('node_modules') || e.startsWith('vendor')), 'события из node_modules/vendor пришли: ' + events.join(', '));

    // новый каталог получает наблюдение, файл в нём виден
    fs.mkdirSync(path.join(dir, 'src', 'new', 'deep'), { recursive: true });
    await waitFor(() => w.size() === 6, 'наблюдение на src/new и src/new/deep');
    touch(path.join(dir, 'src', 'new', 'deep', 'g.js'));
    await waitFor(() => events.includes(path.join('src', 'new', 'deep', 'g.js')), 'событие из нового каталога');
    ok(true, 'новый каталог под слежением');

    // новый игнорируемый каталог не обходится
    touch(path.join(dir, 'src', 'b', 'node_modules', 'z', 'i.js'));
    await waitFor(() => events.includes(path.join('src', 'b', 'node_modules')), 'событие о появлении node_modules');
    await sleep(100);
    ok(w.size() === 6, `в новый node_modules не заходим, каталогов ${w.size()}`);

    // каталог переехал: со старого пути наблюдение снято, на новом поставлено
    fs.renameSync(path.join(dir, 'src', 'new'), path.join(dir, 'src', 'b', 'moved'));
    await waitFor(() => w.size() === 6 && events.includes(path.join('src', 'b', 'moved')), 'переезд каталога');
    events.length = 0;
    touch(path.join(dir, 'src', 'b', 'moved', 'deep', 'h.js'));
    await waitFor(() => events.includes(path.join('src', 'b', 'moved', 'deep', 'h.js')), 'событие по новому пути');
    ok(!events.some((e) => e.startsWith(path.join('src', 'new'))), 'событие пришло по старому пути: ' + events.join(', '));

    // каталог удалён: наблюдения сняты, событие о пропаже пришло
    fs.rmSync(path.join(dir, 'src', 'a'), { recursive: true });
    await waitFor(() => w.size() === 5 && events.includes(path.join('src', 'a')), 'удаление каталога');
    ok(kernelWatches() === 5, `после удаления ядро должно видеть 5 наблюдений, видит ${kernelWatches()}`);
    ok(errors.length === 0, 'лишняя ошибка: ' + errors.map((e) => e.message).join(', '));

    w.close();
    ok(w.size() === 0 && kernelWatches() === 0, 'close() снимает все наблюдения');

    // потолок каталогов: слежение заканчивается ошибкой и ничего не держит
    const capped = watchTree(dir, { ignore: IGNORE, maxDirs: 2 });
    watchers.push(capped);
    const capErr = await new Promise((resolve) => capped.on('error', resolve));
    ok(capErr.code === 'ELIMIT', 'ожидали ELIMIT, пришло ' + capErr.code);
    ok(capped.size() === 0 && kernelWatches() === 0, 'после потолка наблюдений не остаётся');

    // корня нет — бросает сразу, как fs.watch
    assert.throws(() => watchTree(path.join(dir, 'нет-такого'), { ignore: IGNORE }));
    checks++;

    // не Linux — нативный recursive без своих надстроек
    const native = watchTree(dir, { platform: 'darwin' });
    watchers.push(native);
    ok(typeof native.close === 'function' && !('size' in native), 'на других платформах — обычный fs.watch');

    console.log(`✓ tree-watch: ${checks} проверок пройдено`);
    finish(0);
  } catch (e) {
    console.error('✗ tree-watch:', e.message);
    finish(1);
  }
})();

function finish(code) {
  for (const w of watchers) { try { w.close(); } catch (_) {} }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
