// Метка «sync» в плашке проекта: какие пути считаются синхронизируемыми.
// Главный случай — проект, подключённый в корень симлинком: демон знает его по
// настоящему пути, редактор — по симлинку, и метка обязана появиться всё равно.
// Запуск: node test/sync.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// --- стенд: настоящий каталог + симлинк на него, как на живой машине ---
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-sync-test-'));
const realDir = path.join(work, 'LiteEditorHomeDir', 'kudatut-v2');
const rootDir = path.join(work, 'projects', 'home');
fs.mkdirSync(realDir, { recursive: true });
fs.mkdirSync(rootDir, { recursive: true });
const linked = path.join(rootDir, 'kudatut-v2');
fs.symlinkSync(realDir, linked);
const plain = path.join(rootDir, 'LiteWebEditor');
fs.mkdirSync(plain);
const outside = path.join(rootDir, 'outsource-site1');
fs.mkdirSync(outside);

const cfgFile = path.join(work, 'config.json');
process.env.LITE_SYNC_CONFIG = cfgFile;
const write = (obj) => fs.writeFileSync(cfgFile, JSON.stringify(obj));
const load = () => { delete require.cache[require.resolve('../lib/sync')]; return require('../lib/sync'); };

// --- проект через симлинк помечается (иначе метки не увидят kudatut-v2 и informer) ---
write({ projects: [{ path: realDir, claude: true }, { path: plain, claude: true }] });
let sync = load();
let hit = sync.match([linked, plain, outside]);
ok(hit.includes(linked), 'проект через симлинк — синхронизируется');
ok(hit.includes(plain), 'обычный проект — синхронизируется');
ok(!hit.includes(outside), 'проект вне конфига — без метки');
ok(hit.length === 2, 'лишнего не помечено');
ok(hit[0] === linked, 'путь возвращается в исходном виде, а не разрешённым');

// --- обмен выключен целиком → меток нет ---
write({ enabled: false, projects: [{ path: realDir }] });
ok(load().match([linked]).length === 0, 'enabled:false — меток нет');

// --- конфига нет / он битый → пусто, без исключения ---
write({ projects: [{ path: realDir }] });
fs.unlinkSync(cfgFile);
ok(load().match([linked]).length === 0, 'конфига нет — пусто');
fs.writeFileSync(cfgFile, '{ это не json');
ok(load().match([linked]).length === 0, 'битый конфиг — пусто, без падения');

// --- мусор на входе не роняет ---
write({ projects: [{ path: realDir }, null, 'строкой-тоже-можно', { nope: 1 }] });
sync = load();
ok(sync.match([linked, null, 42, '', undefined]).length === 1, 'мусор во входных путях отфильтрован');
ok(sync.match(null).length === 0, 'вместо массива — не массив');

// --- проект есть в конфиге, но папку удалили: сравниваем как есть, не падаем ---
const gone = path.join(work, 'projects', 'home', 'deleted-project');
write({ projects: [{ path: gone }] });
ok(load().match([gone]).includes(gone), 'удалённая папка — путь всё равно сопоставляется');

fs.rmSync(work, { recursive: true, force: true });
console.log(`sync.test.js: ${passed} проверок пройдено`);
