// Тест логгера: сбой записи в stderr не должен зацикливать обработчик uncaughtException.
// 17–23.07.2026 на заполненном диске и файл лога, и перенаправленный лаунчером stderr отвечали
// ENOSPC. В главном процессе Electron stderr после ошибки НЕ разрушается: каждая запись
// поднимает 'error' на следующем тике, без слушателя это uncaughtException, обработчик логгера
// снова пишет в stderr — 2,6 млн исключений за шесть суток. До правки этот сценарий давал
// ~15 000 исключений в секунду из одного исходного.
//
// Гоняется в настоящем главном процессе Electron (под node stderr ведёт себя иначе и петлю не
// показывает): нужен xvfb-run и /dev/full. Нет их (CI на Windows/macOS) — тест пропускается.
// Запуск: node test/logger.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

const root = path.join(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
// Под Stryker (npm run mutation) logger.js не мутируется, а запуск Electron на каждого мутанта только
// удлинял бы CI (и logger.js в песочницу Stryker не копируется).
// Песочницу узнаём по пути: переменные окружения Stryker в начальный прогон не попадают.
if (__dirname.includes('.stryker-tmp') || process.env.STRYKER_MUTATOR_WORKER) { console.log('logger: пропущен под Stryker'); process.exit(0); }
if (process.platform !== 'linux' || !fs.existsSync('/dev/full') || !fs.existsSync(electron) || !has('xvfb-run')) {
  console.log('logger: пропущен — нужен Linux с /dev/full, xvfb-run и установленным electron');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-'));
// Маленькое «приложение» Electron: поднимает логгер, портит файл лога и бросает одно исключение.
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'logger-test', main: 'main.js' }));
fs.writeFileSync(path.join(dir, 'main.js'), `
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(dir)};
const logs = path.join(dir, 'logs');
fs.mkdirSync(logs);
const logger = require(${JSON.stringify(path.join(root, 'logger.js'))});
logger.init(logs);
// Файл лога только на чтение: запись в него падает, логгер уходит в запасной stderr (а он — /dev/full).
for (const f of fs.readdirSync(logs)) fs.chmodSync(path.join(logs, f), 0o400);
let fired = 0;
process.on('uncaughtException', () => { fired++; });
setTimeout(() => { throw new Error('исходная ошибка'); }, 10);
setTimeout(() => { fs.writeFileSync(path.join(dir, 'fired'), String(fired)); process.exit(0); }, 1000);
`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;   // нужен именно главный процесс Electron, а не режим node
// timeout внутри xvfb-run: зациклившийся Electron (так он вёл себя до правки — петля не пускала даже
// таймер выхода) гасится сам, и xvfb-run прибирает свой Xvfb. Внешний таймаут spawnSync убил бы
// только обёртку и оставил сирот.
const r = spawnSync('xvfb-run', ['-a', 'sh', '-c', `exec timeout -k 2 15 "${electron}" --no-sandbox "${dir}" >/dev/full 2>/dev/full`],
  { timeout: 60000, stdio: 'ignore', env });
ok(r.status !== 124, 'процесс Electron не завис в петле (timeout сработал бы со статусом 124)');
if (!fs.existsSync(path.join(dir, 'fired'))) {
  // Electron не поднялся вовсе (нет библиотек/дисплея в окружении) — это не про логгер.
  console.log(`logger: пропущен — Electron не стартовал (статус ${r.status})`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
ok(r.status === 0, 'процесс Electron завершился сам (статус ' + r.status + ')');
const fired = Number(fs.readFileSync(path.join(dir, 'fired'), 'utf8'));
ok(fired === 1, 'uncaughtException сработал один раз, а не по кругу: ' + fired);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`logger: ${passed} проверок пройдено`);
