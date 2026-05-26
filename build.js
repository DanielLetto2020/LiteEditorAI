// Bundles the renderer (xterm + CodeMirror) into renderer/dist/.
// The main/preload processes are plain Node and are NOT bundled.
const esbuild = require('esbuild');
const path = require('path');

const opts = {
  entryPoints: [path.join(__dirname, 'renderer', 'renderer.js')],
  bundle: true,
  outfile: path.join(__dirname, 'renderer', 'dist', 'bundle.js'),
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
};

async function run() {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('[build] watching renderer…');
  } else {
    await esbuild.build(opts);
    console.log('[build] renderer bundled');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
