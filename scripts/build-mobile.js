// Бандлит UI пульта (renderer/mobile.js) в ассеты Android-APK.
// Выход: android/app/src/main/assets/app.js (app.css — пустая заглушка, стили в index.html).
// Запускается на ХОСТЕ (нужен node + esbuild), ДО сборки APK в podman.
const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '..');
const opts = {
  entryPoints: [path.join(root, 'renderer', 'mobile.js')],
  bundle: true,
  outfile: path.join(root, 'android', 'app', 'src', 'main', 'assets', 'app.js'),
  platform: 'browser',
  format: 'iife',
  target: ['es2015'],   // старые Android WebView не парсят esnext → транспилируем вниз
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
};

esbuild.build(opts)
  .then(() => console.log('[build-mobile] APK-ассеты собраны → android/app/src/main/assets/app.{js,css}'))
  .catch((e) => { console.error(e); process.exit(1); });
