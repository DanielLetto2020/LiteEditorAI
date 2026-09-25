// Утилита синхронизации ПК ↔ сервер (scripts/server-sync): всё, что проверяется без сервера.
// Адрес сервера и его проверка на опасные значения, откуда берётся адрес, ошибки без
// process.exit (модуль грузит сам редактор), план обмена, запись настроек мастером.
// Запуск: node test/lite-sync.test.js  (без зависимостей, чистый node, настоящий ~/.lite-sync не трогает).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// каталог состояния — до require: модули запоминают его при загрузке
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-sync-cli-test-'));
process.env.LITE_SYNC_DIR = path.join(work, 'state');
delete process.env.LITE_SERVER;

const sync = require('../scripts/server-sync/lite-sync.js');
const linker = require('../scripts/server-sync/lite-sync-link.js');
const cfgFile = path.join(work, 'state', 'config.json');
const writeCfg = (obj) => { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(obj)); };
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const throwsSync = (fn) => { try { fn(); return false; } catch (e) { return e instanceof sync.SyncError; } };

// --- адрес сервера: только то, что ssh поймёт как адрес, а не как опцию ---
for (const good of ['user@example.com', 'deploy@10.0.0.5', 'my-vps', 'u_1@host-2.local']) ok(sync.validServer(good), `годный адрес: ${good}`);
for (const bad of ['', '-oProxyCommand=touch /tmp/x', 'user@-oProxyCommand=x', 'a b', "u@h'x", 'u@h;id', 'u@@h', '@host', 'x'.repeat(300)]) {
  ok(!sync.validServer(bad), `негодный адрес: ${JSON.stringify(bad).slice(0, 40)}`);
}

// --- откуда берётся адрес: LITE_SERVER сильнее конфига; без адреса — ошибка, а не выход ---
// (у владельца рядом лежит приватное дополнение; адреса оно не подсказывает)
ok(throwsSync(() => sync.resolveTarget()), 'адреса нет — SyncError, процесс жив');
writeCfg({ server: 'me@box', projects: [] });
ok(sync.resolveTarget() === 'me@box', 'адрес из конфига');
process.env.LITE_SERVER = 'env@box';
ok(sync.resolveTarget() === 'env@box', 'LITE_SERVER сильнее конфига');
process.env.LITE_SERVER = '-oProxyCommand=x';
ok(throwsSync(() => sync.resolveTarget()), 'опасный LITE_SERVER отвергается');
delete process.env.LITE_SERVER;
writeCfg({ server: '-oProxyCommand=x' });
ok(throwsSync(() => sync.resolveTarget()), 'опасный адрес в конфиге отвергается');

// --- ошибки бросаются, а не завершают процесс ---
ok(throwsSync(() => sync.listLocal(path.join(work, 'нет-такой-папки'))), 'нечитаемый каталог — SyncError');

// --- экранирование для удалённой оболочки ---
ok(sync.shq("a'b") === "'a'\\''b'", 'одинарная кавычка экранируется');
ok(sync.shq('$(id)') === "'$(id)'", 'подстановка команды остаётся текстом');
ok(linker.shq === sync.shq, 'процедура подключения экранирует тем же кодом');

// --- путь проекта из заявки ---
ok(linker.safePath('/home/me/app') === '/home/me/app', 'абсолютный путь принят');
for (const bad of ['home/me/app', '/home/me/../etc', '/a\nb']) {
  let threw = false; try { linker.safePath(bad); } catch (_) { threw = true; }
  ok(threw, `путь отвергнут: ${JSON.stringify(bad)}`);
}

// --- план обмена: три списка (здесь, там, манифест) ---
const f = (size, mtime) => ({ type: 'f', size, mtime });
const manifest = new Map([['a', f(1, 1000)], ['b', f(1, 1000)], ['c', f(1, 1000)], ['d', f(1, 1000)]]);
const local = new Map([['a', f(2, 9000)], ['b', f(1, 1000)], ['c', f(5, 9000)], ['n', f(1, 9000)]]);           // a изменён, c изменён, d удалён, n новый
const remote = new Map([['a', f(1, 1000)], ['b', f(3, 9000)], ['c', f(6, 9500)], ['d', f(1, 1000)]]);          // b изменён, c изменён
const plan = sync.analyze(local, remote, manifest);
ok(plan.toPush.includes('a') && plan.toPush.includes('n'), 'изменённое и новое здесь уезжает на сервер');
ok(plan.toPull.includes('b'), 'изменённое на сервере приезжает');
ok(plan.conflicts.length === 1 && plan.conflicts[0] === 'c', 'правка с обеих сторон — спор, файл не трогается');
ok(plan.deleteRemote.includes('d'), 'удалённое здесь удаляется там (через корзину)');
const preferred = sync.analyze(local, remote, manifest, 'local');
ok(preferred.conflicts.includes('c'), '--prefer сам спор не снимает: сторону выбирает main()');

// --- мастер: адрес в конфиг, существующие проекты не теряются ---
writeCfg({ projects: [{ path: '/home/me/old' }] });
ok(!linker.configured(), 'без адреса — не настроено');
let threw = false; try { linker.setServer('-oProxyCommand=x'); } catch (_) { threw = true; }
ok(threw, 'опасный адрес не записывается');
linker.setServer('me@box');
let cfg = readCfg();
ok(cfg.server === 'me@box' && cfg.runner === 'editor', 'адрес записан, демон — за редактором');
ok(cfg.projects.length === 1 && cfg.projects[0].path === '/home/me/old', 'проекты сохранены');
ok(linker.configured(), 'с адресом — настроено');
writeCfg({ server: 'me@box', projects: [] });
linker.setServer('other@box', { runner: null });
ok(readCfg().runner === undefined, 'runner не навязывается, если его не просили');

// --- подключение проекта дописывает его один раз ---
writeCfg({ server: 'me@box', projects: [] });
linker.addToConfig('/home/me/app');
linker.addToConfig('/home/me/app');
cfg = readCfg();
ok(cfg.projects.length === 1, 'проект не дублируется');
const expected = { path: '/home/me/app', ...((sync.addon && sync.addon.projectDefaults) || {}) };
ok(JSON.stringify(cfg.projects[0]) === JSON.stringify(expected), 'запись проекта — путь (+ поля дополнения, если оно есть)');
ok(linker.isLinked('/home/me/app') && !linker.isLinked('/home/me/other'), 'isLinked по конфигу');

// --- защита от удаления всего проекта по пустому листингу одной стороны ---
const two = new Map([['a', f(1, 1)], ['b', f(2, 2)]]);
const none = new Map();
const gone = sync.parseRemoteListing(sync.NODIR_MARK);
ok(gone.size === 0 && gone.missing === true, 'каталога на сервере нет — пустой список с пометкой missing');
ok(sync.parseRemoteListing('').missing !== true, 'пустой, но существующий каталог — без пометки');
ok(sync.wipeRisk(two, gone, 2, 'auto') !== null, 'сервер без каталога при непустом манифесте — auto отказывает');
ok(sync.wipeRisk(two, none, 2, 'pull') !== null, 'пустой сервер — pull тоже удалил бы всё здесь, отказ');
ok(sync.wipeRisk(two, none, 2, 'push') === null, 'пустой сервер — push разрешён (восстановить копию на сервере)');
ok(sync.wipeRisk(none, two, 2, 'auto') !== null, 'пустой ПК (несмонтированный диск) — auto отказывает');
ok(sync.wipeRisk(none, two, 2, 'pull') === null, 'пустой ПК — pull разрешён (вернуть с сервера)');
ok(sync.wipeRisk(none, none, 0, 'auto') === null, 'первая синхронизация (манифеста нет) — не мешаем');
ok(sync.wipeRisk(none, two, 2, 'status') === null, 'status ничего не меняет — не мешаем');
ok(sync.wipeRisk(two, two, 2, 'auto') === null, 'обе стороны на месте — не мешаем');

// --- имя с переводом строки в листинг не попадает (списки для rsync и удаления — построчные) ---
const nl = sync.parseListing('f\tok.txt\t1\t1\0f\tbad\nsrc\t1\t1\0');
ok(nl.has('ok.txt') && nl.size === 1, 'имя с \\n пропущено');

// --- забыть манифест ---
const mf = sync.manifestPath('/home/me/app');
fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, '{}');
sync.forgetManifest('/home/me/app');
ok(!fs.existsSync(mf), 'манифест удалён — следующая сверка первая, без удалений');

fs.rmSync(work, { recursive: true, force: true });
console.log(`lite-sync.test.js: ${passed} проверок пройдено`);
