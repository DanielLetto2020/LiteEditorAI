// electron-builder afterPack hook (macOS). Делает mac-сборку рабочей без сертификата Apple.
//
// Чинит ДВЕ независимые причины «не удалось запустить шелл» / «posix_spawnp failed» при создании
// терминала (node-pty запускает вспомогательный бинарник `spawn-helper` через posix_spawn):
//
// 1) БИТ ИСПОЛНЕНИЯ. В npm-пакете node-pty `spawn-helper` в `prebuilds/darwin-*` лежит с правами
//    0664 — БЕЗ +x. На Intel-Mac `build/Release/pty.node` (собран arm64 на CI-раннере) не грузится →
//    node-pty падает в фолбэк `prebuilds/darwin-x64`, берёт оттуда неисполняемый `spawn-helper` →
//    posix_spawn = EACCES. Детерминированно ломает терминал на Intel. `chmod +x` это и чинит.
// 2) ПОДПИСЬ. build.mac.identity=null отключает подпись electron-builder. Главный бинарник Electron
//    приходит ad-hoc-подписанным, поэтому окно стартует, а заново скомпилированные/prebuild-бинарники
//    node-pty — нет. На Apple Silicon ядро убивает неподписанный Mach-O при exec. Ad-hoc подпись
//    (`codesign --sign -`) с нашими entitlements этого достаточно, чтобы ядро разрешило exec.
//
// Карантин Gatekeeper (при скачивании) этим НЕ снимается — пользователю всё ещё нужен
// `xattr -dr com.apple.quarantine ...` ИЛИ «Открыть всё равно» (см. README), но после де-карантина
// терминал теперь запускается. Хук вызывается отдельно для каждой arch (arm64 и x64); codesign на
// arm64-раннере умеет ad-hoc-подписывать и x64-бандл.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Рекурсивно найти файлы с заданным базовым именем под dir (без внешних зависимостей).
function findByName(dir, name, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findByName(full, name, out);
    else if (e.name === name) out.push(full);
  }
  return out;
}

module.exports = async function afterPackMac(context) {
  if (context.electronPlatformName !== 'darwin') return; // только macOS

  const appName = context.packager.appInfo.productFilename; // "LiteEditorAI"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, '..', 'assets', 'entitlements.mac.plist');
  const ptyRoot = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty');

  // (1) +x всем spawn-helper (build/Release + все prebuilds/darwin-*) — критично для Intel-фолбэка.
  const helpers = findByName(ptyRoot, 'spawn-helper');
  for (const h of helpers) {
    try { fs.chmodSync(h, 0o755); console.log(`[afterPack-mac] chmod +x: ${h}`); }
    catch (e) { console.warn(`[afterPack-mac] chmod не удался для ${h}: ${e.message}`); }
  }
  if (!helpers.length) console.warn('[afterPack-mac] ⚠ spawn-helper не найден под ' + ptyRoot);

  // (2) Ad-hoc подпись. Сначала ЯВНО подписываем вложенные нативные бинарники node-pty (spawn-helper
  // + *.node) — --deep не всегда надёжно спускается в Resources/app.asar.unpacked, поэтому не
  // полагаемся только на него. Затем подписываем сам бандл целиком.
  const nodeBins = findByName(ptyRoot, 'pty.node');
  const sign = (target) => execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, target], { stdio: 'inherit' });
  for (const t of [...helpers, ...nodeBins]) {
    try { sign(t); console.log(`[afterPack-mac] signed: ${t}`); }
    catch (e) { console.warn(`[afterPack-mac] codesign не удался для ${t}: ${e.message}`); }
  }

  console.log(`[afterPack-mac] ad-hoc codesign bundle (${context.arch}): ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath], { stdio: 'inherit' });

  // Санити-проверка: подпись бандла валидна?
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
};
