// Organise built artifacts from dist-release/ into release/{ubuntu,windows}/ with
// the naming <Name>_<version>_<YYYYMMDDHHMM> and a per-OS readme.
// Build first:  npm run dist:linux   and/or   npm run dist:win
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const NAME = 'LiteEditor';
const version = pkg.version.replace(/-alpha$/, '');     // 1.0.11-alpha -> 1.0.11
const distDir = path.join(root, 'dist-release');

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
const human = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;

function newest(re) {
  if (!fs.existsSync(distDir)) return null;
  const files = fs.readdirSync(distDir).filter((f) => re.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(distDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].f : null;
}
function place(srcName, osDir, ext, readme) {
  if (!srcName) { console.log(`  пропуск ${osDir}: артефакт не найден в dist-release/`); return; }
  const outDir = path.join(root, 'release', osDir);
  fs.mkdirSync(outDir, { recursive: true });
  const target = `${NAME}_${version}_${stamp}${ext}`;
  fs.copyFileSync(path.join(distDir, srcName), path.join(outDir, target));
  fs.writeFileSync(path.join(outDir, 'readme.md'), readme(target));
  console.log(`  ${osDir}/${target}`);
}

const ubuntuReadme = (file) => `# LiteEditor ${version} — Ubuntu (x64)

Собрано: ${human}. Версия: \`alpha v${version}\`.

## Установка
Двойной клик по \`${file}\` (откроется «Установка приложений») — или в терминале:

\`\`\`bash
sudo dpkg -i "${file}"
sudo apt -f install      # если ругнётся на зависимости
\`\`\`

## Запуск
Иконка **LiteEditor** в меню приложений, либо команда \`lite-editor\` в терминале.
Приложение стартует с программным рендером (без GPU) и \`--no-sandbox\` — так и задумано.

## Удаление
\`\`\`bash
sudo apt remove lite-editor
\`\`\`

Требуется Ubuntu 22.04+/64-бит.
`;

const windowsReadme = (file) => `# LiteEditor ${version} — Windows (x64)

Собрано: ${human}. Версия: \`alpha v${version}\`.

## Запуск (установка не нужна, portable)
1. Распакуй **весь** архив \`${file}\` в любую папку.
2. Запусти **LiteEditor.exe** из этой папки.

Windows SmartScreen может предупредить (приложение без цифровой подписи):
«Подробнее» → «Выполнить в любом случае».

## ⚠️ Это первый тестовый билд
Сборка собрана кросс-компиляцией с Linux и **не тестировалась на Windows**.
Если что-то не работает — особенно **терминал** — напиши, что именно (скриншот/текст ошибки).

Требуется Windows 10/11 x64.
`;

console.log(`release ${NAME} v${version} (${stamp}):`);
place(newest(/\.deb$/), 'ubuntu', '.deb', ubuntuReadme);
place(newest(/win.*\.zip$|\.zip$/), 'windows', '.zip', windowsReadme);
console.log('готово.');
