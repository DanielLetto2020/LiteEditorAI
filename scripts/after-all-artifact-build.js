// Хук electron-builder (afterAllArtifactBuild): оборачивает бинарник внутри портативного
// Linux tar.gz так, чтобы запуск шёл с --no-sandbox до старта C++ zygote Chromium.
// В .deb этого не нужно: postinst ставит системный AppArmor-профиль в /etc/apparmor.d/.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const WRAPPER_SCRIPT = `#!/bin/sh
# Portable Linux archive runs without root SUID chrome-sandbox or /etc/apparmor.d profile;
# pass --no-sandbox before Chromium zygote initializes (required on Ubuntu 24.04+).
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$HERE/liteeditor-ai.bin" --no-sandbox "$@"
`;

/**
 * Найти корень распакованного бандла (сам каталог или подкаталог первого уровня).
 * @param {string} dir
 * @returns {string|null}
 */
function findBundleRoot(dir) {
  const hasApp = (d) => fs.existsSync(path.join(d, 'liteeditor-ai'))
    && fs.existsSync(path.join(d, 'resources'));
  if (hasApp(dir)) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    if (hasApp(sub)) return sub;
  }
  return null;
}

/**
 * Обернуть бинарник `liteeditor-ai` внутри портативного `.tar.gz` в shell-скрипт с `--no-sandbox`.
 * @param {string} tarGzPath
 * @returns {void}
 */
function patchTarGz(tarGzPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-portable-'));
  try {
    cp.execFileSync('tar', ['-xzf', tarGzPath, '-C', tmp]);
    const appDir = findBundleRoot(tmp);
    if (!appDir) {
      throw new Error(`afterAllArtifactBuild: app root not found inside ${tarGzPath}`);
    }
    const binOrig = path.join(appDir, 'liteeditor-ai');
    const binReal = path.join(appDir, 'liteeditor-ai.bin');
    if (!fs.existsSync(binReal)) {
      fs.renameSync(binOrig, binReal);
      fs.writeFileSync(binOrig, WRAPPER_SCRIPT, { mode: 0o755 });
    }
    const outTmp = tarGzPath + '.repack.tar.gz';
    if (appDir === tmp) {
      cp.execFileSync('tar', ['-czf', outTmp, '-C', tmp, '.']);
    } else {
      cp.execFileSync('tar', ['-czf', outTmp, '-C', tmp, path.basename(appDir)]);
    }
    fs.renameSync(outTmp, tarGzPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {{ artifactPaths?: string[] }} buildResult
 * @returns {Promise<string[]>}
 */
async function afterAllArtifactBuild(buildResult) {
  const paths = (buildResult && Array.isArray(buildResult.artifactPaths)) ? buildResult.artifactPaths : [];
  for (const p of paths) {
    if (/linux.*\.tar\.gz$/i.test(path.basename(p))) {
      patchTarGz(p);
      console.log('[portable-tar] wrapped liteeditor-ai -> liteeditor-ai.bin --no-sandbox:', path.basename(p));
    }
  }
  return [];
}

module.exports = Object.assign(afterAllArtifactBuild, { patchTarGz });
