// Rasterise assets/icon.svg into PNGs used by the window + the .desktop launcher.
const path = require('path');
const fs = require('fs');

const assets = path.join(__dirname, '..', 'assets');
const svg = path.join(assets, 'icon.svg');

(async () => {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (_) {
    console.error('sharp не установлен — иконку оставляю как SVG. (npm i, потом npm run gen-icons)');
    process.exit(0);
  }
  const buf = fs.readFileSync(svg);
  for (const size of [256, 512]) {
    await sharp(buf).resize(size, size).png().toFile(path.join(assets, `icon-${size}.png`));
  }
  await sharp(buf).resize(512, 512).png().toFile(path.join(assets, 'icon.png'));
  console.log('Иконки сгенерированы: icon.png, icon-256.png, icon-512.png');
})();
