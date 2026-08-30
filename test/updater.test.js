// Тесты апдейтера: выбор файла релиза, классификация установки и текст стейджеров.
// Всё это — код, ошибка в котором обнаруживается ПОСЛЕ перезапуска, когда приложение уже закрыто:
// скачали не тот архив, приняли deb за portable, сломали кавычки в скрипте — и пользователь остаётся
// перед пустым экраном без способа откатиться. Поэтому именно эти части проверяются тестом.
// Запуск: node test/updater.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const u = require('../lib/updater');

// Тесты проекта — чистый node без раннера, поэтому async-функцию гоняем через отдельный процесс:
// так проверка остаётся линейной и падает ровно там, где сломалось.
function unpackSync(file, destDir) {
  const code = `require(${JSON.stringify(path.resolve(__dirname, '../lib/updater'))})`
    + `.unpack(${JSON.stringify(file)}, ${JSON.stringify(destDir)}, 'linux')`
    + `.then((r) => { process.stdout.write(JSON.stringify(r)); });`;
  return JSON.parse(cp.execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }));
}

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

// --- сравнение версий ---
assert.deepStrictEqual(u.parseVer('alpha v1.1.175'), [1, 1, 175]); passed++;
assert.deepStrictEqual(u.parseVer('v1.1.175-alpha'), [1, 1, 175]); passed++;
assert.deepStrictEqual(u.parseVer('мусор'), [0, 0, 0]); passed++;
ok(u.verNewer('v1.1.176', 'alpha v1.1.175'), 'патч больше — новее');
ok(u.verNewer('v1.2.0', 'v1.1.999'), 'минор старше патча');
ok(u.verNewer('v2.0.0', 'v1.9.9'), 'мажор старше минора');
ok(!u.verNewer('v1.1.175', 'alpha v1.1.175'), 'та же версия не новее');
ok(!u.verNewer('v1.1.174', 'v1.1.175'), 'старая версия не новее');
ok(!u.verNewer('', 'v1.1.175'), 'пустой тег не считается обновлением');

// --- классификация установки ---
const dev = u.classify({ platform: 'linux', execPath: '/home/u/p/node_modules/electron/dist/electron', isPackaged: false });
eq(dev.kind, 'dev', 'запуск из исходников распознан');

const deb = u.classify({ platform: 'linux', execPath: '/opt/LiteEditorAI/liteeditor-ai', isPackaged: true });
eq(deb.kind, 'deb', '/opt — системная установка из пакета');
for (const p of ['/usr/lib/liteeditor/liteeditor-ai', '/snap/liteeditor/x1/liteeditor-ai', '/app/bin/liteeditor-ai']) {
  eq(u.classify({ platform: 'linux', execPath: p, isPackaged: true }).kind, 'deb', p + ' — системный префикс');
}

const port = u.classify({ platform: 'linux', execPath: '/home/u/Apps/LiteEditorAI/liteeditor-ai', isPackaged: true });
eq(port.kind, 'portable', 'распаковка в домашний каталог — portable');
eq(port.appDir, '/home/u/Apps/LiteEditorAI', 'подменяем каталог приложения');
eq(port.parentDir, '/home/u/Apps', 'временный .old создаётся рядом');
// Каталог с «opt» в середине пути — не системный: проверка идёт по префиксу, а не по вхождению.
eq(u.classify({ platform: 'linux', execPath: '/home/u/opt/LiteEditorAI/liteeditor-ai', isPackaged: true }).kind,
  'portable', '«opt» внутри домашнего пути не делает установку системной');

const mac = u.classify({ platform: 'darwin', execPath: '/Applications/LiteEditorAI.app/Contents/MacOS/LiteEditorAI', isPackaged: true });
eq(mac.kind, 'mac', 'macOS распознан');
eq(mac.appDir, '/Applications/LiteEditorAI.app', 'на macOS подменяется весь бандл, а не бинарь');
eq(mac.parentDir, '/Applications', 'родитель бандла — куда кладём .old');

const win = u.classify({ platform: 'win32', execPath: 'C:\\Users\\u\\LiteEditorAI\\LiteEditorAI.exe', isPackaged: true });
eq(win.kind, 'portable', 'Windows-сборка всегда portable (zip)');

// --- выбор ассета релиза ---
const ASSETS = [
  { name: 'liteeditor-ai_1.1.176-alpha_amd64.deb' },
  { name: 'LiteEditorAI-1.1.176-alpha-linux-x64.tar.gz' },
  { name: 'LiteEditorAI-1.1.176-alpha-win.zip' },
  { name: 'LiteEditorAI-1.1.176-alpha-mac.zip' },
  { name: 'LiteEditorAI-1.1.176-alpha-arm64-mac.zip' },
  { name: 'LiteEditorAI-1.1.176-alpha.dmg' },
  { name: 'LiteEditorAI-1.1.176-alpha-arm64.dmg' },
];
const pick = (env) => (u.pickAsset(ASSETS, env) || {}).name;
eq(pick({ platform: 'win32', kind: 'portable' }), 'LiteEditorAI-1.1.176-alpha-win.zip', 'Windows → win.zip');
eq(pick({ platform: 'linux', kind: 'deb' }), 'liteeditor-ai_1.1.176-alpha_amd64.deb', 'deb-установка → .deb');
eq(pick({ platform: 'linux', kind: 'portable' }), 'LiteEditorAI-1.1.176-alpha-linux-x64.tar.gz', 'portable Linux → tar.gz');
// Регрессия, которую легко внести: «-mac.zip» — подстрока «-arm64-mac.zip».
eq(pick({ platform: 'darwin', arch: 'x64', kind: 'mac' }), 'LiteEditorAI-1.1.176-alpha-mac.zip', 'Intel-мак не берёт arm64-сборку');
eq(pick({ platform: 'darwin', arch: 'arm64', kind: 'mac' }), 'LiteEditorAI-1.1.176-alpha-arm64-mac.zip', 'Apple Silicon → arm64');
ok(!/\.dmg$/.test(pick({ platform: 'darwin', arch: 'arm64', kind: 'mac' })), 'dmg для обновления не выбирается');
eq(u.pickAsset([], { platform: 'win32', kind: 'portable' }), undefined, 'пустой релиз — не падаем');
eq(u.pickAsset([{ name: 'README.md' }], { platform: 'linux', kind: 'deb' }), undefined, 'нет подходящего файла — undefined');
// Релиз без tar.gz (старые версии) — фолбэк не должен подсунуть чужую платформу.
eq(u.pickAsset([{ name: 'x-win.zip' }, { name: 'y.deb' }], { platform: 'linux', kind: 'portable' }), undefined,
  'portable Linux не берёт win.zip вместо архива');

// --- текст стейджеров ---
const sh = u.unixStager({ pid: 4242, appDir: '/home/u/Apps/LiteEditorAI', newDir: '/tmp/new', exec: '/home/u/Apps/LiteEditorAI/liteeditor-ai' });
ok(sh.includes('kill -0 4242'), 'unix-стейджер ждёт выхода конкретного процесса');
ok(sh.includes('mv "$APP" "$OLD"'), 'старый каталог отодвигается, а не удаляется');
ok(sh.includes('mv "$OLD" "$APP"'), 'есть откат при неудачной подмене');
ok(sh.includes('--no-sandbox'), 'новая версия стартует с обязательным --no-sandbox');
ok(!sh.includes('rm -rf "$APP"'), 'каталог приложения никогда не удаляется напрямую');
// Апостроф в пути (каталог «Максим'с») не должен разрывать кавычки и превращать путь в команду.
const shq = u.unixStager({ pid: 1, appDir: "/home/u/it's/App", newDir: '/tmp/n', exec: "/home/u/it's/App/bin" });
ok(shq.includes(`'/home/u/it'\\''s/App'`), 'апостроф в пути экранирован');
const shmac = u.unixStager({ pid: 7, appDir: '/Applications/LiteEditorAI.app', newDir: '/tmp/n', exec: 'x', mac: true });
ok(shmac.includes('com.apple.quarantine'), 'на macOS снимается карантин — иначе Gatekeeper не пустит');
ok(shmac.includes('open -n'), 'бандл запускается через open, а не бинарём напрямую');
ok(!shmac.includes('--no-sandbox'), 'мак-ветка не тянет линуксовый флаг');

const cmd = u.winStager({ pid: 99, appDir: 'C:\\App', newDir: 'C:\\new', exec: 'C:\\App\\LiteEditorAI.exe' });
ok(cmd.includes('tasklist /fi "PID eq 99"'), 'win-стейджер ждёт освобождения залоченных файлов');
ok(cmd.includes('move "%OLD%" "%APP%"'), 'есть откат и на Windows');
ok(cmd.includes('start "" "C:\\App\\LiteEditorAI.exe"'), 'новая версия запускается после подмены');

// --- поиск корня приложения в распакованном архиве ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-upd-'));
try {
  // Linux: архив кладёт всё в одну папку верхнего уровня.
  const lin = path.join(tmp, 'lin', 'LiteEditorAI-1.1.176-linux-x64');
  fs.mkdirSync(path.join(lin, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(lin, 'liteeditor-ai'), '');
  eq(u.findAppRoot(path.join(tmp, 'lin'), 'linux'), lin, 'корень найден внутри вложенной папки');

  // Windows: содержимое лежит прямо в корне распаковки.
  const w = path.join(tmp, 'win');
  fs.mkdirSync(path.join(w, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(w, 'LiteEditorAI.exe'), '');
  eq(u.findAppRoot(w, 'win32'), w, 'корень найден без вложенности');

  // macOS: корень — сам бандл .app.
  const m = path.join(tmp, 'mac');
  fs.mkdirSync(path.join(m, 'LiteEditorAI.app', 'Contents'), { recursive: true });
  eq(u.findAppRoot(m, 'darwin'), path.join(m, 'LiteEditorAI.app'), 'на macOS корень — бандл');

  // Битый архив: приложения нет → null, а не случайный каталог.
  const bad = path.join(tmp, 'bad', 'docs');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'readme.txt'), '');
  eq(u.findAppRoot(path.join(tmp, 'bad'), 'linux'), null, 'в архиве без приложения корень не выдумывается');

  // --- права на запись ---
  ok(u.dirWritable(tmp), 'домашний временный каталог доступен на запись');
  ok(!u.dirWritable(path.join(tmp, 'нет-такого')), 'несуществующий каталог не считается доступным');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- вердикт «сможем ли обновиться сами» ---
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-inst-'));
  try {
    const dev = u.describeInstall({ platform: 'linux', execPath: '/home/u/proj/node_modules/electron/dist/electron', isPackaged: false });
    eq(dev.canSelfUpdate, false, 'из исходников не обновляемся');
    eq(dev.reason, 'запуск из исходников', 'и говорим почему');
    eq(dev.needsPassword, undefined, 'пароль тут ни при чём');

    const deb = u.describeInstall({ platform: 'linux', execPath: '/opt/LiteEditorAI/liteeditor-ai', isPackaged: true });
    eq(deb.canSelfUpdate, true, 'deb обновляется — через pkexec');
    eq(deb.needsPassword, true, 'но требует пароля: UI обязан предупредить');
    eq(deb.writable, false, 'системный каталог не считается записываемым');

    // Записываемый каталог: обычный распакованный tar.gz в домашней папке.
    const appDir = path.join(d, 'Apps', 'LiteEditorAI');
    fs.mkdirSync(appDir, { recursive: true });
    const good = u.describeInstall({ platform: 'linux', execPath: path.join(appDir, 'liteeditor-ai'), isPackaged: true });
    eq(good.canSelfUpdate, true, 'portable в записываемом каталоге обновляется сам');
    eq(good.writable, true, 'права на запись увидены');
    eq(good.reason, undefined, 'при успехе причина не выдумывается');

    // Тот же portable, но каталог только для чтения (установили в общее место).
    const roParent = path.join(d, 'ro');
    const roApp = path.join(roParent, 'LiteEditorAI');
    fs.mkdirSync(roApp, { recursive: true });
    fs.chmodSync(roApp, 0o555);
    fs.chmodSync(roParent, 0o555);
    const ro = u.describeInstall({ platform: 'linux', execPath: path.join(roApp, 'liteeditor-ai'), isPackaged: true });
    eq(ro.canSelfUpdate, false, 'без прав на запись обновиться нельзя');
    ok(ro.reason && ro.reason.length > 0, 'и причина названа — UI отправит на страницу загрузки');
    fs.chmodSync(roParent, 0o755); fs.chmodSync(roApp, 0o755);   // иначе каталог не удалить

    const mac = u.describeInstall({ platform: 'darwin', execPath: path.join(d, 'X.app', 'Contents', 'MacOS', 'X'), isPackaged: true });
    eq(mac.kind, 'mac', 'macOS-бандл распознан и на этапе вердикта');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// --- распаковка настоящего архива ---
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-unp-'));
  try {
    // Собираем такой же tar.gz, какой кладёт в релиз electron-builder.
    const src = path.join(d, 'src', 'LiteEditorAI-1.1.176-linux-x64');
    fs.mkdirSync(path.join(src, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(src, 'liteeditor-ai'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'resources', 'app.asar'), 'x');
    const arch = path.join(d, 'app.tar.gz');
    cp.execFileSync('tar', ['-czf', arch, '-C', path.join(d, 'src'), 'LiteEditorAI-1.1.176-linux-x64']);

    const r = unpackSync(arch, path.join(d, 'out'));
    ok(r.ok, 'настоящий tar.gz распакован: ' + (r.error || ''));
    ok(fs.existsSync(path.join(r.root, 'liteeditor-ai')), 'исполняемый файл на месте');
    ok(fs.existsSync(path.join(r.root, 'resources', 'app.asar')), 'ресурсы на месте');
    ok((fs.statSync(path.join(r.root, 'liteeditor-ai')).mode & 0o111) !== 0, 'права на запуск не потеряны');

    // Архив без приложения — честная ошибка, а не случайный каталог.
    const junk = path.join(d, 'junk.tar.gz');
    fs.mkdirSync(path.join(d, 'j', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(d, 'j', 'docs', 'readme.txt'), 'x');
    cp.execFileSync('tar', ['-czf', junk, '-C', path.join(d, 'j'), 'docs']);
    const r2 = unpackSync(junk, path.join(d, 'out2'));
    eq(r2.ok, false, 'в архиве без приложения распаковка не «удаётся»');
    ok(/не нашлось/.test(r2.error), 'сообщение объясняет, что не так: ' + r2.error);

    // Битый файл — ошибка распаковки, а не падение.
    const broken = path.join(d, 'broken.tar.gz');
    fs.writeFileSync(broken, 'это не архив');
    const r3 = unpackSync(broken, path.join(d, 'out3'));
    eq(r3.ok, false, 'битый архив не проходит');

    // Повторная распаковка в тот же каталог не смешивает версии со старой.
    const r4 = unpackSync(arch, path.join(d, 'out'));
    ok(r4.ok, 'повторная распаковка поверх прошлой работает');
    eq(fs.readdirSync(path.join(d, 'out')).length, 1, 'каталог распаковки очищается перед работой');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// --- запись и запуск стейджера ---
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-stg-'));
  try {
    const f = u.launchStager('#!/bin/sh\nexit 0\n', path.join(d, 'stage'), 'linux');
    eq(path.basename(f), 'lite-update.sh', 'unix-стейджер лежит в .sh');
    eq(fs.readFileSync(f, 'utf8'), '#!/bin/sh\nexit 0\n', 'скрипт записан как есть');
    ok((fs.statSync(f).mode & 0o111) !== 0, 'стейджер исполняемый — иначе обновление не начнётся');

    // Windows-ветка: на этой машине cmd.exe нет, и запуск провалится — важно, что это
    // приходит колбэком, а не необработанным событием, роняющим редактор.
    const w = u.launchStager('@echo off\r\n', path.join(d, 'stage-win'), 'win32', () => {});
    eq(path.basename(w), 'lite-update.cmd', 'win-стейджер лежит в .cmd');
    ok(fs.existsSync(w), 'файл создан даже если запустить его нечем');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// --- каталог загрузок и уборка ---
ok(u.updatesDir('/home/u/.LiteEditorAI').startsWith('/home/u/.LiteEditorAI'), 'загрузки лежат в каталоге состояния');
eq(path.basename(u.updatesDir('/home/u/.LiteEditorAI')), 'updates', 'подкаталог называется updates');
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-clean-'));
  try {
    fs.mkdirSync(path.join(d, 'updates', 'v1.1.176'), { recursive: true });
    fs.writeFileSync(path.join(d, 'updates', 'v1.1.176', 'app.tar.gz'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(d, 'settings.json'), '{}');
    u.cleanup(d);
    eq(fs.existsSync(path.join(d, 'updates')), false, 'скачанное убрано — 150 МБ не копятся');
    ok(fs.existsSync(path.join(d, 'settings.json')), 'остальное состояние не тронуто');
    u.cleanup(d);   // повторный вызов на пустом месте не падает
    ok(true, 'уборка дважды подряд безопасна');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

console.log(`updater: ok (${passed} проверок)`);
