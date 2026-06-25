// Bundles the renderer (xterm + CodeMirror) into renderer/dist/.
// The main/preload processes are plain Node and are NOT bundled.
const esbuild = require('esbuild');
const path = require('path');

const loader = { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' };

// Main editor window bundle.
const opts = {
  entryPoints: [path.join(__dirname, 'renderer', 'renderer.js')],
  bundle: true,
  outfile: path.join(__dirname, 'renderer', 'dist', 'bundle.js'),
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
  loader,
};

// Module-window shell bundle (v1.1+): hosts one module in its own BrowserWindow.
const moduleOpts = {
  entryPoints: [path.join(__dirname, 'renderer', 'module-entry.js')],
  bundle: true,
  outfile: path.join(__dirname, 'renderer', 'dist', 'module-bundle.js'),
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
  loader,
};

async function run() {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(opts);
    const mctx = await esbuild.context(moduleOpts);
    await ctx.watch();
    await mctx.watch();
    console.log('[build] watching renderer + module shell…');
  } else {
    await Promise.all([esbuild.build(opts), esbuild.build(moduleOpts)]);
    console.log('[build] renderer + module shell bundled');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
