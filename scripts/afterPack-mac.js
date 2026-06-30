// electron-builder afterPack hook (macOS).
//
// Почему он есть: build.mac.identity = null отключает собственную подпись electron-builder.
// Главный бинарник Electron приходит ad-hoc-подписанным из дистрибутива, поэтому приложение
// стартует. Но node-pty/native-модули (`pty.node`, и КРИТИЧНО — `spawn-helper`, который node-pty
// запускает через posix_spawn при создании каждого терминала) компилируются на CI заново и
// остаются БЕЗ подписи. На Apple Silicon ядро убивает любой неподписанный Mach-O при exec →
// терминал падает с «posix_spawnp failed» (см. логи mac-пользователей до v1.1.5x). На Intel то же
// даёт отказ Gatekeeper на вложенном бинарнике.
//
// Фикс: после сборки бандла (но до упаковки в dmg/zip) проставляем всему .app ad-hoc-подпись
// (`codesign --sign -`) с нашими entitlements. Подпись без сертификата Apple (ad-hoc) достаточна,
// чтобы ядро разрешило exec вложенных бинарников. Карантин (Gatekeeper при скачивании) этим НЕ
// снимается — пользователю всё ещё нужен `xattr -dr com.apple.quarantine` (это задокументировано),
// но запуск терминала после де-карантина теперь работает.
//
// Хук вызывается electron-builder отдельно для каждой arch (arm64 и x64); codesign на arm64-раннере
// умеет ad-hoc-подписывать и x64-бандл.

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPackMac(context) {
  if (context.electronPlatformName !== 'darwin') return; // только macOS

  const appName = context.packager.appInfo.productFilename; // "LiteEditorAI"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, '..', 'assets', 'entitlements.mac.plist');

  // --force: перезаписать существующую (ad-hoc от Electron) подпись.
  // --deep: подписать ВСЕ вложенные бинарники (pty.node, spawn-helper, фреймворки, хелперы).
  // --sign -: ad-hoc (без сертификата Apple).
  // Без --options runtime: hardened runtime требуется только для нотаризации, а её нет; зато
  // наши entitlements (allow-unsigned-executable-memory / disable-library-validation) применяются.
  const args = ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath];

  console.log(`[afterPack-mac] ad-hoc codesign (${context.arch}): ${appPath}`);
  execFileSync('codesign', args, { stdio: 'inherit' });

  // Санити-проверка: подпись валидна?
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
};
