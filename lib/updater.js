'use strict';
// Самообновление редактора: «нажал кнопку → приложение закрылось и открылось новой версией».
//
// Почему свой апдейтер, а не electron-updater. Он диктует форматы дистрибуции: Windows пришлось бы
// перевести с portable-zip на NSIS-инсталлятор, а macOS он обновляет через Squirrel.Mac, который
// ТРЕБУЕТ подписи Apple Developer ID ($99/год) — у нас подпись ad-hoc, значит мак остался бы без
// автообновления в любом случае. Свой код закрывает все три платформы и не ломает существующие
// артефакты релиза.
//
// Главная трудность не в скачивании, а в подмене файлов: нельзя перезаписать каталог приложения,
// пока приложение из него работает (на Windows файлы прямо залочены, на Linux/macOS — подменишь
// файлы под живым процессом и получишь полутруп). Поэтому применение обновления делает ВНЕШНИЙ
// скрипт-стейджер: приложение пишет его, запускает отвязанным (detached) и выходит; стейджер ждёт
// смерти процесса, меняет каталог местами и запускает новую версию.
//
// Каталог меняется целиком (`mv старый .old` → `mv новый на место`), а не копированием поверх:
// это атомарно, не оставляет мусора от прошлых версий (старые .node, выпиленные модули) и даёт
// откат — при неудаче стейджер возвращает `.old` обратно.
//
// От типа установки зависит, возможно ли обновление вообще (`classify`):
//   portable (win-zip, linux tar.gz, mac .app в записываемом месте) — бесшовно, без пароля;
//   deb (файлы в /opt под root) — только через pkexec, с системным диалогом пароля;
//   dev (запуск из исходников, npm start) — не наше дело, обновляется через git.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const GH_REPO = 'DanielLetto2020/LiteEditorAI';
const UA = 'LiteEditorAI-updater';

// ---------------------------------------------------------------- версии

// Вытащить тройку из «alpha v1.1.175», «v1.1.175-alpha», «1.1.175».
function parseVer(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

// Строго ли версия a новее b.
function verNewer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

// ---------------------------------------------------------------- тип установки

// Чистая классификация по окружению — без обращения к диску, чтобы её можно было прогнать тестом
// для любой платформы. Проверку прав на запись делает `describeInstall` отдельно.
//
// env: { platform, execPath, isPackaged }
// → { kind: 'dev'|'portable'|'deb'|'mac', appDir, parentDir, exec }
//   appDir    — что подменяем целиком (каталог приложения; на macOS — сам бандл .app);
//   parentDir — где создаётся временный «.old» (нужны права на запись именно здесь);
//   exec      — чем запускать новую версию после подмены.
const SYSTEM_PREFIXES = ['/opt/', '/usr/', '/snap/', '/var/lib/flatpak/', '/app/'];

function classify(env = {}) {
  const platform = env.platform || process.platform;
  const execPath = env.execPath || process.execPath;
  // Из исходников (npm start, ./lite-editor) обновляться нечем: там нет собранного дистрибутива,
  // а есть git-репозиторий. Плашку показываем, кнопку «Обновить» — нет.
  if (!env.isPackaged) return { kind: 'dev', appDir: null, parentDir: null, exec: execPath };

  if (platform === 'darwin') {
    // .../LiteEditorAI.app/Contents/MacOS/LiteEditorAI → подменяем весь бандл.
    const i = execPath.indexOf('.app/');
    const appDir = i > 0 ? execPath.slice(0, i + 4) : path.dirname(execPath);
    return { kind: 'mac', appDir, parentDir: path.dirname(appDir), exec: execPath };
  }

  if (platform === 'win32') {
    const appDir = path.dirname(execPath);
    return { kind: 'portable', appDir, parentDir: path.dirname(appDir), exec: execPath };
  }

  // Linux: системный префикс = установка из .deb, файлы принадлежат root.
  const norm = execPath.replace(/\\/g, '/');
  if (SYSTEM_PREFIXES.some((p) => norm.startsWith(p))) {
    return { kind: 'deb', appDir: path.dirname(execPath), parentDir: null, exec: execPath };
  }
  const appDir = path.dirname(execPath);
  return { kind: 'portable', appDir, parentDir: path.dirname(appDir), exec: execPath };
}

// Можно ли писать в каталог. Пытаться и ловить ошибку надёжнее, чем считать права по stat:
// на пути могут быть монтирования только для чтения, ACL, SELinux.
function dirWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (_) { return false; }
}

// Полная картина для UI: тип установки + вердикт «сможем ли обновиться сами».
/**
 * @param {{platform?:string, execPath?:string, isPackaged?:boolean}} [env]
 * @returns {{kind:string, appDir:string|null, parentDir:string|null, exec:string,
 *   writable:boolean, canSelfUpdate:boolean, needsPassword?:boolean, reason?:string}}
 */
function describeInstall(env = {}) {
  const c = classify(env);
  if (c.kind === 'dev') {
    return { ...c, writable: false, canSelfUpdate: false, reason: 'запуск из исходников' };
  }
  if (c.kind === 'deb') {
    // Обновление возможно, но через системный диалог пароля — UI обязан предупредить заранее.
    return { ...c, writable: false, canSelfUpdate: true, needsPassword: true };
  }
  const writable = dirWritable(c.appDir) && dirWritable(c.parentDir);
  return {
    ...c,
    writable,
    canSelfUpdate: writable,
    ...(writable ? {} : { reason: 'нет прав на запись в каталог приложения' }),
  };
}

// ---------------------------------------------------------------- выбор файла релиза

// Какой ассет релиза качать для этой установки. Имена задаёт electron-builder:
//   liteeditor-ai_1.1.176-alpha_amd64.deb              — Linux deb
//   LiteEditorAI-1.1.176-alpha-linux.tar.gz            — Linux portable
//   LiteEditorAI-1.1.176-alpha-win.zip                 — Windows portable
//   LiteEditorAI-1.1.176-alpha-mac.zip                 — macOS x64
//   LiteEditorAI-1.1.176-alpha-arm64-mac.zip           — macOS arm64
// dmg для обновления не годится: его пришлось бы монтировать, zip несёт тот же бандл.
function pickAsset(assets, env = {}) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && typeof a.name === 'string');
  const platform = env.platform || process.platform;
  const arch = env.arch || process.arch;
  const kind = env.kind || classify(env).kind;
  const by = (re) => list.find((a) => re.test(a.name));

  if (platform === 'darwin') {
    // ⚠️ Порядок проверок важен: «-mac.zip» подстрока «-arm64-mac.zip», поэтому x64-вариант
    // ищется с явным запретом arm64, иначе Intel-машина скачает сборку под Apple Silicon.
    return arch === 'arm64' ? by(/arm64-mac\.zip$/i) : by(/^(?!.*arm64).*-mac\.zip$/i);
  }
  if (platform === 'win32') return by(/-win\.zip$/i);
  if (kind === 'deb') return by(/\.deb$/i);
  return by(/linux.*\.tar\.gz$/i) || by(/\.tar\.gz$/i);
}

// ---------------------------------------------------------------- GitHub API

// Последний опубликованный релиз. Публичный репозиторий → токен не нужен.
// Никогда не бросает: отдаёт {error}, чтобы UI тихо деградировал (проверка идёт в фоне).
function fetchLatest(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.request(
      `https://api.github.com/repos/${GH_REPO}/releases/latest`,
      { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (res.statusCode >= 400) return resolve({ error: j.message || ('HTTP ' + res.statusCode) });
            resolve({
              tag: j.tag_name || '',
              name: j.name || '',
              notes: j.body || '',
              url: j.html_url || '',
              // digest у ассета — «sha256:…», GitHub считает его сам. Благодаря этому проверка
              // целостности не требует ни отдельного файла сумм в релизе, ни правок CI.
              assets: (j.assets || []).map((a) => ({
                name: a.name, size: a.size, digest: a.digest || '', url: a.browser_download_url,
              })),
            });
          } catch (_) { resolve({ error: 'Не удалось разобрать ответ GitHub' }); }
        });
      },
    );
    req.on('error', (e) => resolve({ error: String(e.message || e) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'таймаут проверки обновления' }); });
    req.end();
  });
}

// ---------------------------------------------------------------- скачивание

// Ассет весит 115–180 МБ, поэтому качаем потоком в файл и считаем sha256 на лету — второй проход
// по такому файлу ради хеша стоил бы лишних секунд и чтения с диска.
// onProgress({loaded,total,pct}) вызывается не чаще ~4 раз в секунду: чаще — только зря дёргать IPC.
// Возвращает { ok, file } | { ok:false, error, canceled }.
function download(asset, destDir, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  return new Promise((resolve) => {
    fs.mkdirSync(destDir, { recursive: true });
    const file = path.join(destDir, asset.name);
    const part = file + '.part';
    try { fs.rmSync(part, { force: true }); } catch (_) {}

    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let loaded = 0;
    let lastTick = 0;
    let canceled = false;
    let current = null;

    const fail = (error) => {
      try { out.destroy(); } catch (_) {}
      try { fs.rmSync(part, { force: true }); } catch (_) {}
      resolve({ ok: false, error, canceled });
    };

    // GitHub отдаёт ассет 302-редиректом на objects.githubusercontent.com — https.get сам за ним
    // не идёт, ведём цепочку руками (с потолком, чтобы кольцо редиректов не крутилось вечно).
    const get = (url, hops) => {
      if (hops > 5) return fail('слишком много перенаправлений');
      const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/octet-stream' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, url).toString(), hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return fail('HTTP ' + res.statusCode); }
        const total = asset.size || parseInt(res.headers['content-length'] || '0', 10) || 0;
        res.on('data', (chunk) => {
          hash.update(chunk);
          loaded += chunk.length;
          const now = Date.now();
          if (now - lastTick > 250) {
            lastTick = now;
            onProgress({ loaded, total, pct: total ? Math.min(99, Math.floor((loaded / total) * 100)) : 0 });
          }
        });
        res.pipe(out);
        out.on('error', (e) => fail(String(e.message || e)));
        out.on('finish', () => {
          if (canceled) return fail('отменено');
          const got = 'sha256:' + hash.digest('hex');
          // Мы качаем код, который потом запустим. Расхождение хеша — единственный внятный сигнал,
          // что по дороге что-то подменили или файл побился; молча ставить такое нельзя.
          if (asset.digest && got !== asset.digest) return fail('контрольная сумма не совпала');
          if (asset.size && loaded !== asset.size) return fail('размер файла не совпал');
          try { fs.rmSync(file, { force: true }); fs.renameSync(part, file); } catch (e) { return fail(String(e.message || e)); }
          onProgress({ loaded, total: loaded, pct: 100 });
          resolve({ ok: true, file });
        });
      });
      current = req;
      req.on('error', (e) => fail(canceled ? 'отменено' : String(e.message || e)));
      req.setTimeout(120000, () => { req.destroy(new Error('таймаут загрузки')); });
    };

    if (opts.signal) {
      opts.signal.onAbort = () => { canceled = true; try { current && current.destroy(); } catch (_) {} };
    }
    get(asset.url, 0);
  });
}

// ---------------------------------------------------------------- распаковка

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: String((stderr || err.message || '').trim()).slice(0, 400) });
      resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

// Распаковать скачанный архив в отдельный каталог и вернуть путь к КОРНЮ приложения внутри него.
// Инструменты берём системные, без npm-зависимостей:
//   tar   — есть в Linux и в Windows 10+ (bsdtar понимает и zip), на Windows фолбэк на PowerShell;
//   ditto — macOS, единственный правильный способ распаковать .app: unzip теряет симлинки внутри
//           Frameworks и ad-hoc-подпись, после чего бандл не запускается.
async function unpack(file, destDir, platform = process.platform) {
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(destDir, { recursive: true });

  if (platform === 'darwin') {
    const r = await run('ditto', ['-x', '-k', file, destDir]);
    if (!r.ok) return { ok: false, error: 'распаковка не удалась: ' + r.error };
  } else if (file.endsWith('.zip')) {
    let r = await run('tar', ['-xf', file, '-C', destDir]);
    if (!r.ok) {
      r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]);
      if (!r.ok) return { ok: false, error: 'распаковка не удалась: ' + r.error };
    }
  } else {
    const r = await run('tar', ['-xzf', file, '-C', destDir]);
    if (!r.ok) return { ok: false, error: 'распаковка не удалась: ' + r.error };
  }

  // Архивы electron-builder кладут содержимое в одну папку верхнего уровня (или, у win-zip,
  // прямо в корень) — найти реальный корень надёжнее, чем угадывать его по имени версии.
  const root = findAppRoot(destDir, platform);
  if (!root) return { ok: false, error: 'в архиве не нашлось приложения' };
  return { ok: true, root };
}

// Корень распакованного приложения: каталог, где лежит исполняемый файл (или сам .app на macOS).
function findAppRoot(dir, platform = process.platform) {
  const looksLikeApp = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch (_) { return false; }
    if (platform === 'darwin') return names.some((n) => n.endsWith('.app'));
    if (platform === 'win32') return names.some((n) => /\.exe$/i.test(n)) && names.includes('resources');
    return names.includes('resources') && names.some((n) => !n.includes('.'));
  };
  if (looksLikeApp(dir)) {
    if (platform === 'darwin') {
      const app = fs.readdirSync(dir).find((n) => n.endsWith('.app'));
      return path.join(dir, app);
    }
    return dir;
  }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { return null; }
  for (const e of entries) {
    const r = findAppRoot(path.join(dir, e.name), platform);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------- применение

// Текст стейджера для unix (Linux portable и macOS). Живёт отдельной функцией, чтобы тест мог
// проверить сам скрипт: ошибка здесь означает приложение, которое не открылось после обновления,
// а это худший из возможных исходов — пользователь остаётся без инструмента и без объяснений.
function unixStager({ pid, appDir, newDir, exec, mac = false }) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return `#!/bin/sh
# Стейджер обновления LiteEditorAI — создан приложением, удаляет себя после работы.
APP=${q(appDir)}
NEW=${q(newDir)}
OLD="$APP.old-$$"
# Ждём выхода старого процесса (до 30 с). Подменять каталог под живым процессом нельзя.
i=0
while kill -0 ${pid} 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
mv "$APP" "$OLD" || exit 1
if mv "$NEW" "$APP"; then
  rm -rf "$OLD"
else
  # Не смогли поставить новую версию — возвращаем старую, пользователь не остаётся ни с чем.
  mv "$OLD" "$APP"
  exit 1
fi
${mac ? 'xattr -dr com.apple.quarantine "$APP" 2>/dev/null\nopen -n "$APP"\n' : `exec ${q(exec)} --no-sandbox\n`}`;
}

// Тот же стейджер для Windows. cmd вместо PowerShell: не зависит от политики выполнения скриптов.
function winStager({ pid, appDir, newDir, exec }) {
  return `@echo off
rem Стейджер обновления LiteEditorAI — создан приложением, удаляет себя после работы.
set "APP=${appDir}"
set "NEW=${newDir}"
set "OLD=%APP%.old-%RANDOM%"
rem Ждём выхода старого процесса: пока exe запущен, его файлы залочены.
for /l %%i in (1,1,60) do (
  tasklist /fi "PID eq ${pid}" 2>nul | find "${pid}" >nul || goto :ready
  ping -n 2 127.0.0.1 >nul
)
:ready
move "%APP%" "%OLD%" || exit /b 1
move "%NEW%" "%APP%"
if errorlevel 1 (
  move "%OLD%" "%APP%"
  exit /b 1
)
rmdir /s /q "%OLD%"
start "" "${exec}"
del "%~f0"
`;
}

// Записать стейджер и запустить его ОТВЯЗАННО от приложения. detached + unref обязательны:
// иначе стейджер умрёт вместе с родителем ровно в тот момент, когда должен начать работу.
/**
 * @param {string} script
 * @param {string} dir
 * @param {string} [platform]
 * @param {(err: Error) => void} [onError]
 */
function launchStager(script, dir, platform = process.platform, onError = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const isWin = platform === 'win32';
  const file = path.join(dir, isWin ? 'lite-update.cmd' : 'lite-update.sh');
  fs.writeFileSync(file, script, { mode: isWin ? 0o644 : 0o755 });
  const child = isWin
    ? spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', [file], { detached: true, stdio: 'ignore' });
  // Без обработчика 'error' несостоявшийся запуск стейджера роняет процесс необработанным
  // событием — и вместо обновления пользователь получает падение редактора.
  child.on('error', (e) => { try { onError(e); } catch (_) {} });
  child.unref();
  return file;
}

// Установка .deb: единственный путь, где не обойтись без прав root. pkexec показывает штатный
// системный диалог пароля (тот же, что у менеджера обновлений), после чего dpkg перезаписывает
// /opt под работающим процессом — это безопасно, старые inode живут до выхода, — и приложение
// перезапускает себя само.
function installDeb(file) {
  return new Promise((resolve) => {
    execFile('pkexec', ['dpkg', '-i', file], { timeout: 300000 }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true });
      const msg = String(stderr || err.message || '');
      // 126/127 у pkexec — «пользователь отменил» и «нет агента авторизации».
      if (err.code === 126) return resolve({ ok: false, error: 'установка отменена', canceled: true });
      if (err.code === 127) return resolve({ ok: false, error: 'в системе нет pkexec — обновите пакет вручную' });
      resolve({ ok: false, error: msg.slice(0, 400) || 'dpkg вернул ошибку' });
    });
  });
}

// Каталог загрузок обновления. Внутри storeDir (~/.LiteEditorAI), рядом с остальным состоянием.
function updatesDir(storeDir) {
  return path.join(storeDir || path.join(os.homedir(), '.LiteEditorAI'), 'updates');
}

// Подчистить всё, что осталось от прошлых обновлений: архивы по 150 МБ копить незачем.
function cleanup(storeDir) {
  try { fs.rmSync(updatesDir(storeDir), { recursive: true, force: true }); } catch (_) {}
}

module.exports = {
  GH_REPO,
  parseVer, verNewer,
  classify, describeInstall, dirWritable,
  pickAsset,
  fetchLatest, download,
  unpack, findAppRoot,
  unixStager, winStager, launchStager,
  installDeb,
  updatesDir, cleanup,
};
