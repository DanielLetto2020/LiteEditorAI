// Bundles the renderer (xterm + CodeMirror) into renderer/dist/.
// The main/preload processes are plain Node and are NOT bundled.
//
// ES-модули с разбиением на чанки (splitting). Раньше оба бандла были iife без разбиения: окно
// любого модуля разбирало весь module-bundle.js — 7 МБ со всеми 22 модулями и сотней грамматик
// CodeMirror (кэш кода V8 для file:// не работает, так что разбор повторялся на каждое окно).
// Теперь окно грузит общий код и СВОЙ модуль (module-entry.js импортирует его динамически), а
// грамматики редких языков и highlight.js подтягиваются при первом использовании.
//   dist/bundle.js         — окно редактора (renderer.js), + bundle.css
//   dist/module-bundle.js  — оболочка окна модуля (module-entry.js), + module-bundle.css
//   dist/chunks/*.js       — общий код и лениво загружаемые части
// Страницы подключают бандлы как <script type="module"> (ES-модули по file:// Electron грузит).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outdir = path.join(__dirname, 'renderer', 'dist');
const chunksDir = path.join(outdir, 'chunks');
const loader = { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' };

const opts = {
  entryPoints: {
    bundle: path.join(__dirname, 'renderer', 'renderer.js'),
    'module-bundle': path.join(__dirname, 'renderer', 'module-entry.js'),
  },
  absWorkingDir: __dirname,   // пути в metafile — от каталога проекта, откуда бы ни запускали
  bundle: true,
  outdir,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  format: 'esm',
  splitting: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
  loader,
};

// Старые чанки не удаляем сразу: у запущенного редактора в памяти имена чанков ЕГО сборки, и окно
// модуля, открытое после пересборки (лаунчер собирает при каждом запуске), догружало бы их по
// старым именам. Чанк, которого нет в текущей сборке, удаляется, когда ему больше STALE_MS.
const STALE_MS = 3 * 24 * 3600 * 1000;
function pruneStaleChunks(metafile) {
  const current = new Set(Object.keys(metafile.outputs).map((p) => path.resolve(__dirname, p)));
  let entries;
  try { entries = fs.readdirSync(chunksDir); } catch (_) { return; }
  const now = Date.now();
  for (const f of entries) {
    const full = path.join(chunksDir, f);
    if (current.has(full)) continue;
    try { if (now - fs.statSync(full).mtimeMs > STALE_MS) fs.unlinkSync(full); } catch (_) {}
  }
}

// --if-changed (так зовёт лаунчер ./lite-editor на каждом запуске): сборка пропускается, если ни
// один исходник рендерера, build.js и package-lock.json не новее собранных бандлов. Раньше каждый
// запуск тратил ~0,4 с на сборку и переписывал ~20 МБ карт исходников. Ручной `node build.js`,
// npm start и сборки релиза собирают всегда.
const OUTPUTS = ['bundle.js', 'bundle.css', 'module-bundle.js', 'module-bundle.css'].map((f) => path.join(outdir, f));
function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (full !== outdir) walk(full); continue; }
      if (!/\.(m?js|css|json)$/.test(e.name)) continue;
      try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch (_) {}
    }
  };
  walk(path.join(__dirname, 'renderer'));
  for (const f of ['build.js', 'package-lock.json', 'package.json']) {
    try { newest = Math.max(newest, fs.statSync(path.join(__dirname, f)).mtimeMs); } catch (_) {}
  }
  return newest;
}
function upToDate() {
  let oldestOut = Infinity;
  for (const f of OUTPUTS) {
    try { oldestOut = Math.min(oldestOut, fs.statSync(f).mtimeMs); } catch (_) { return false; }
  }
  return newestSource() <= oldestOut;
}

async function run() {
  if (process.argv.includes('--if-changed') && upToDate()) {
    console.log('[build] исходники не менялись — сборка пропущена');
    return;
  }
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('[build] watching renderer + module shell…');
  } else {
    const r = await esbuild.build(opts);
    pruneStaleChunks(r.metafile);
    console.log('[build] renderer + module shell bundled');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
