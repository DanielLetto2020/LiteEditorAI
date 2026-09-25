#!/usr/bin/env node
'use strict';
// Двусторонняя синхронизация каталога между ПК и сервером.
//
//   lite-sync status <путь>        где свежее и что разошлось
//   lite-sync push   <путь> --go   ПК     -> сервер
//   lite-sync pull   <путь> --go   сервер -> ПК
//   lite-sync auto   <путь> --go   сам выберет направление
//
// Без --go — сухой прогон: ничего не передаётся и не удаляется.
//
// Главного экземпляра нет: свежий тот, где работали последний раз. Направление
// вычисляется сравнением трёх списков файлов — что на ПК, что на сервере и что
// было на момент последней синхронизации (манифест). Git для этого не нужен:
// синку всё равно, есть он в проекте или нет.
//
// Правила:
//   - синхронизируется ВСЁ содержимое каталога, включая node_modules и .git;
//   - файл, изменённый с обеих сторон, не трогается вовсе — только показывается;
//   - удалённое и перезаписанное складывается в корзину на принимающей стороне.
//
// Нужно: ssh по ключу до своего сервера, rsync с обеих сторон, одинаковый абсолютный
// путь проекта на обеих машинах. Адрес сервера — LITE_SERVER или поле server в
// ~/.lite-sync/config.json (его пишет мастер подключения в редакторе).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const STATE_DIR = process.env.LITE_SYNC_DIR || path.join(HOME, '.lite-sync');
// больше — «кто свежее» начинает врать; переопределяется только для проверок
const CLOCK_TOLERANCE_S = Number(process.env.LITE_SYNC_CLOCK_TOLERANCE ?? 5);
const MTIME_TOLERANCE_MS = 2000;  // файловые системы округляют время по-разному
// Сколько дней корзина хранит снимки. Срока годности у неё не было вовсе: к
// 2026-09-02 она набрала 31 ГБ и заняла диск сервера почти целиком.
const TRASH_KEEP_DAYS = Number(process.env.LITE_SYNC_TRASH_DAYS ?? 3);
// Обход корзины — работа для раза в час, а не для каждого прогона демона.
const PRUNE_EVERY_MS = 60 * 60 * 1000;

// ------------------------------------------------------------------ утилиты

// Ошибка, о которой можно сказать человеку. Бросаем, а не выходим: модуль грузят и
// сам редактор (подключение проекта), и демон — process.exit закрыл бы их целиком.
// Код выхода для командной строки ставит обёртка вокруг main() внизу файла.
class SyncError extends Error {}

function fail(message) {
  throw new SyncError(message);
}

function encodeName(projectPath) {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

// Адрес сервера: user@host или имя из ~/.ssh/config. Он уходит отдельным аргументом
// ssh и rsync, поэтому начинаться с «-» не может (иначе это опция вроде
// -oProxyCommand=…), а пробелы и кавычки ему не нужны.
const SERVER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;
function validServer(value) {
  return typeof value === 'string' && value.length <= 255 && SERVER_RE.test(value);
}

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8')) || {}; } catch { return {}; }
}

// Адрес сервера: переменная окружения, иначе поле server в конфиге.
function resolveTarget() {
  const value = process.env.LITE_SERVER || readConfigFile().server || '';
  if (!value) fail('не знаю адрес сервера: задайте его в мастере подключения (облачко у проекта) или LITE_SERVER=пользователь@хост');
  if (!validServer(value)) fail(`негодный адрес сервера: ${String(value).slice(0, 80)}`);
  return value;
}

// Необязательное дополнение рядом с утилитой (lite-sync-claude.js): перенос
// авторизации и памяти агента между машинами. В поставку оно не входит — без него
// синхронизируются только файлы проектов.
function loadAddon() {
  try {
    // @ts-ignore -- файла в поставке нет намеренно
    return require('./lite-sync-claude.js');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('lite-sync-claude')) return null;
    throw e;
  }
}
const addon = loadAddon();

// Одно соединение на все вызовы: без мультиплексирования каждый запуск тратил бы
// секунды на рукопожатия, а демон дёргает сервер часто.
// Сокет мультиплексора — в своём каталоге (0700), а не в общем /tmp: там его мог заранее создать
// другой пользователь машины, и наши ssh подключались бы к ЕГО мастеру — он отдавал бы нам
// подложные листинги, а по ним синхронизация удаляла бы файлы. %C — хеш параметров соединения:
// короткое имя укладывается в предел длины пути unix-сокета.
// ServerAlive: повисшее соединение (уснул ноутбук, сменилась сеть) обрывается за ~минуту, а не
// держит spawnSync бесконечно — иначе демон навсегда считал проект «занятым».
const MUX_DIR = path.join(STATE_DIR, 'ssh');
// Лениво, перед первым ssh: модуль грузит и сам редактор (метка «sync» в плашке) — у тех, кто
// синхронизацией не пользуется, каталогов в домашней папке появляться не должно.
function ensureMuxDir() {
  try { fs.mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(MUX_DIR, 0o700); } catch { /* нет прав — ssh сам скажет */ }
}
const SSH_OPTS = [
  '-C',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(MUX_DIR, 'cm-%C')}`,
  '-o', 'ControlPersist=120s',
];
// Те же опции — и rsync (-e): без них он ходил отдельным ssh без BatchMode и keepalive. Кавычки —
// по правилам rsync (он сам режет строку по пробелам, понимает кавычки, но не обратную косую).
const RSYNC_SSH = ['ssh', ...SSH_OPTS].map((a) => (/[\s']/.test(a) && !a.includes('"') ? `"${a}"` : a)).join(' ');

// Строка, безопасная для оболочки. JSON.stringify для этого не годится: он даёт
// ДВОЙНЫЕ кавычки, а внутри них sh по-прежнему разворачивает подстановку команд —
// путь с $(...) в имени исполнялся бы и здесь, и на сервере (воспроизведено 2026-08-26).
function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// soft: сервера нет — вернуть null вместо остановки. Годится только для работы,
// без которой можно обойтись (уборка в корзине); обмен файлами без сервера бессмыслен.
function ssh(target, command, { input = null, encoding = 'utf8', maxBuffer = 256 * 1024 * 1024, soft = false } = {}) {
  ensureMuxDir();
  const res = spawnSync('ssh', [...SSH_OPTS, target, command], { input, encoding: /** @type {BufferEncoding} */ (encoding), maxBuffer });
  if (res.status !== 0) {
    if (soft) return null;
    fail(`сервер ответил ошибкой: ${(res.stderr || '').trim() || res.status}`);
  }
  return res.stdout;
}

// ------------------------------------------------------- списки файлов

// Один и тот же обход с обеих сторон. Разделитель — нулевой байт: имена файлов
// могут содержать что угодно, кроме него.
const FIND = `find . -mindepth 1 -printf '%y\\t%P\\t%s\\t%T@\\0'`;

function parseListing(raw) {
  const files = new Map();
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const [type, filePath, size, mtime] = record.split('\t');
    if (!filePath) continue;
    // Имя с переводом строки не пройдёт через списки rsync --files-from и удаления построчно:
    // «a⏎src» там превратилось бы в два пути, и удаление задело бы чужой каталог «src». Не трогаем такое.
    if (filePath.includes('\n')) continue;
    files.set(filePath, {
      type,                               // f — файл, d — каталог, l — ссылка
      size: Number(size),
      mtime: Math.round(Number(mtime) * 1000),
    });
  }
  return files;
}

function listLocal(dir) {
  // find отвечает единицей, если хоть один подкаталог не прочитался — например,
  // данные postgres из контейнера лежат под чужим uid. Остальное дерево он при
  // этом печатает целиком, поэтому такой отказ — не повод падать: недоступное
  // просто не синхронизируется, ровно как и на серверной стороне (там `|| true`).
  // Настоящий сбой отличаем по пустому выводу: список без единой записи означает,
  // что каталог не прочитан вовсе, и принять это за «всё удалили» нельзя.
  const res = spawnSync('bash', ['-c', `cd ${shq(dir)} && ${FIND}`], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0 && !res.stdout) {
    fail(`не удалось прочитать ${dir}: ${(res.stderr || '').trim() || res.status}`);
  }
  if (res.status !== 0) {
    const denied = (res.stderr || '').trim().split('\n').filter(Boolean);
    console.log(`### не читается, пропускаю: ${denied.length} (напр. ${denied[0]})`);
  }
  return parseListing(res.stdout);
}

// Каталога на сервере нет или он не открывается — это НЕ «на сервере всё удалили». Раньше `|| true`
// превращал такой отказ в пустой листинг, и сверка уносила в корзину весь проект на ПК.
const NODIR_MARK = '__LITE_SYNC_NODIR__';
/** @returns {Map<string, any> & { missing?: boolean }} */
function parseRemoteListing(raw) {
  /** @type {Map<string, any> & { missing?: boolean }} */
  const files = parseListing(raw === NODIR_MARK ? '' : raw);
  if (raw === NODIR_MARK) files.missing = true;
  return files;
}
function listRemote(target, dir) {
  return parseRemoteListing(ssh(target, `cd ${shq(dir)} 2>/dev/null || { printf '%s' ${NODIR_MARK}; exit 0; }; ${FIND} || true`));
}

// Дешёвый пульс: если сводка не изменилась, полный список тянуть незачем.
function remoteSummary(target, dir) {
  const out = ssh(target, `cd ${shq(dir)} 2>/dev/null && ${FIND} | md5sum | cut -c1-32 || echo пусто`);
  return out.trim();
}

// ------------------------------------------------------------- манифест

function manifestPath(projectPath) {
  return path.join(STATE_DIR, 'state', `${encodeName(projectPath)}.json`);
}

function loadManifest(projectPath) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(projectPath), 'utf8'));
    return { syncedAt: data.syncedAt || 0, files: new Map(Object.entries(data.files || {})) };
  } catch {
    return { syncedAt: 0, files: new Map() };   // первая синхронизация
  }
}

function saveManifest(projectPath, files, keepConflicts) {
  const file = manifestPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const plain = {};
  for (const [key, value] of files) plain[key] = value;
  // спорные файлы намеренно оставляем в прежнем виде: пока их не разрулили,
  // они должны определяться как спорные и в следующий раз
  for (const [key, value] of keepConflicts) plain[key] = value;
  // через tmp + rename: оборванная запись оставила бы манифест битым, и следующий прогон считал бы
  // синхронизацию первой
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ syncedAt: Date.now(), files: plain }, null, 0));
  fs.renameSync(tmp, file);
}

// Забыть манифест: следующая сверка — первая, без удалений. Нужен, когда одна сторона заведена
// заново (процедура подключения создала пустой каталог), — иначе старый манифест объявил бы
// удалённым с той стороны всё, что в нём записано.
function forgetManifest(projectPath) {
  fs.rmSync(manifestPath(projectPath), { force: true });
}

// Одна сторона пуста целиком, а в манифесте файлы есть. Так выглядит не «человек удалил всё», а
// несмонтированный диск (пустая точка монтирования), пропавший или переименованный каталог,
// переустановленный сервер. Удаление по такому листингу унесло бы весь проект с другой стороны.
// Направление, которое удалений в эту сторону не делает (push при пустом сервере, pull при
// пустом ПК), не опасно и разрешено. Возвращает текст отказа или null.
/**
 * @param {Map<string, any>} local
 * @param {Map<string, any> & { missing?: boolean }} remote
 * @param {number} manifestSize
 * @param {string} command
 */
function wipeRisk(local, remote, manifestSize, command) {
  if (!manifestSize || command === 'status' || command === 'adopt') return null;
  if (remote.size === 0 && command !== 'push') {
    return `на сервере каталог проекта ${remote.missing ? 'не найден' : 'пуст'}, а до этого там было ${manifestSize} — по такому списку удалилось бы всё здесь. `
      + 'Если сервер ещё не готов (диск, путь) — поправьте его. Если копию на сервере нужно создать заново — выполните push';
  }
  if (local.size === 0 && command !== 'pull') {
    return `каталог проекта на ПК пуст, а до этого там было ${manifestSize} — по такому списку удалилось бы всё на сервере. `
      + 'Проверьте, смонтирован ли диск. Если копию на ПК нужно восстановить с сервера — выполните pull';
  }
  return null;
}

// --------------------------------------------------------------- сравнение

// Размер словами: сводку читает человек, а «14680064» ему ничего не говорит.
function humanBytes(bytes) {
  if (!bytes) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function same(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  // у каталога время меняется от любой возни внутри — сравнивать его бессмысленно,
  // важно лишь то, что каталог есть с обеих сторон
  if (a.type === 'd') return true;
  if (a.type === 'f' && a.size !== b.size) return false;
  return Math.abs(a.mtime - b.mtime) <= MTIME_TOLERANCE_MS;
}

// Что изменилось на одной стороне относительно последней синхронизации.
function sideDelta(current, manifest) {
  const changed = [];
  const deleted = [];
  for (const [key, value] of current) {
    const old = manifest.get(key);
    if (!old || !same(value, old)) changed.push(key);
  }
  for (const key of manifest.keys()) if (!current.has(key)) deleted.push(key);
  return { changed, deleted };
}

// prefer — сторона, выбранная человеком явно ('local' | 'remote'). Она сильнее
// свежести: если он сказал «взять мою версию», файл едет на сервер, даже когда
// серверный новее. В автоматической сверке prefer не задаётся, и всё решает время.
function analyze(local, remote, manifest, prefer = null) {
  const first = manifest.size === 0;
  const l = sideDelta(local, manifest.files ?? manifest);
  const r = sideDelta(remote, manifest.files ?? manifest);

  // При самой первой синхронизации манифеста нет, и «изменилось» будет всё подряд.
  // Тогда спор объявляем только там, где файлы реально различаются.
  const changedLocal = new Set(l.changed);
  const changedRemote = new Set(r.changed);

  const conflicts = [];
  const byTime = [];      // база для сравнения отсутствует — решаем по свежести
  const toPush = [];
  const toPull = [];

  const base = manifest.files ?? manifest;

  for (const key of changedLocal) {
    if (changedRemote.has(key)) {
      if (same(local.get(key), remote.get(key))) continue;   // уже одинаковые

      // Настоящий спор — только когда есть от чего отсчитывать: файл был в манифесте
      // и с тех пор изменился на обеих сторонах. Если записи нет (файл новый для
      // синка или выпал из манифеста прошлым спором), объявлять спор нельзя —
      // иначе он повиснет навсегда. Берём более свежую сторону, как и договаривались:
      // главный тот, где работали последний раз. Прежняя версия уедет в корзину.
      if (!base.has(key)) {
        byTime.push(key);
        const takeLocal = prefer ? prefer === 'local' : local.get(key).mtime >= remote.get(key).mtime;
        if (takeLocal) toPush.push(key);
        else toPull.push(key);
        continue;
      }
      conflicts.push(key);
      continue;
    }
    toPush.push(key);
  }
  for (const key of changedRemote) {
    if (!changedLocal.has(key)) toPull.push(key);
  }

  // удаления: только те, что не были одновременно изменены на другой стороне
  const deleteRemote = l.deleted.filter((key) => remote.has(key) && !changedRemote.has(key));
  const deleteLocal = r.deleted.filter((key) => local.has(key) && !changedLocal.has(key));

  return { first, toPush, toPull, conflicts, byTime, deleteRemote, deleteLocal };
}

// --------------------------------------------------------------- передача

function withFilesList(paths, action) {
  // Свой каталог (mkdtemp, 0700), а не предсказуемое имя в общем /tmp: туда другой пользователь мог
  // заранее положить ссылку, и запись списка перезаписала бы файл, на который она указывает.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-sync-'));
  const listFile = path.join(dir, 'files.list');
  try {
    fs.writeFileSync(listFile, `${paths.join('\n')}\n`);   // внутри try: при ENOSPC каталог тоже убирается
    return action(listFile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function trashDir(projectPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(STATE_DIR, 'trash', encodeName(projectPath), stamp);
}

// 23 — часть файлов не передалась (чаще всего права), 24 — файл исчез, пока шла
// передача (обычное дело: рядом работает сборка или git). Ни то, ни другое не повод
// объявлять весь обмен неудачным: остальное доехало, а несделанное всплывёт снова.
const RSYNC_PARTIAL = new Set([23, 24]);

function runRsync(args) {
  ensureMuxDir();
  const res = spawnSync('rsync', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !RSYNC_PARTIAL.has(res.status)) {
    fail(`rsync не справился: ${(res.stderr || '').trim()}`);
  }
  if (res.status !== 0) {
    console.log(`### часть файлов не доехала (rsync ${res.status}): ${(res.stderr || '').trim().split('\n')[0]}`);
  }
  return res.stdout;
}

// Транскрипты сессий агента только дописываются в конец: старая версия — это
// начало новой, и терять при перезаписи там нечего. В корзину же они ложились
// целиком при каждом изменении — один файл на 40 МБ оказался там 194 раза за
// трое суток и съел 8 ГБ (2026-09-02). Их переносим без резервной копии.
// Смотрим и на путь каталога, и на относительный: синхронизировать могут как
// саму папку памяти, так и что-то выше неё.
function isAppendOnlyLog(projectPath, rel) {
  return rel.endsWith('.jsonl') && `${projectPath}/${rel}`.includes('/.claude/projects/');
}

function transfer({ direction, target, projectPath, paths, dry, remoteHome }) {
  if (!paths.length) return 0;
  const localDir = `${projectPath.replace(/\/$/, '')}/`;
  const remoteDir = `${target}:${projectPath.replace(/\/$/, '')}/`;
  const backup = direction === 'push'
    ? `${remoteHome}/.lite-sync/trash/${encodeName(projectPath)}/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    : trashDir(projectPath);

  const send = (list, backupDir) => withFilesList(list, (listFile) => {
    // --timeout: rsync сам обрывает обмен, по которому 5 минут не шло ни байта
    const args = ['-a', '--relative', '--timeout=300', '-e', RSYNC_SSH, '--files-from', listFile];
    if (backupDir) args.push('--backup', `--backup-dir=${backupDir}`);
    if (dry) args.push('--dry-run');
    args.push(direction === 'push' ? localDir : remoteDir);
    args.push(direction === 'push' ? remoteDir : localDir);
    runRsync(args);
    return list.length;
  });

  const plain = paths.filter((rel) => isAppendOnlyLog(projectPath, rel));
  const saved = paths.filter((rel) => !isAppendOnlyLog(projectPath, rel));
  return (saved.length ? send(saved, backup) : 0) + (plain.length ? send(plain, null) : 0);
}

// Удаление с сохранением копии в корзине — на той стороне, где файлы исчезли не сами.
function applyDeletions({ side, target, projectPath, paths, dry, remoteHome }) {
  if (!paths.length || dry) return paths.length;

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const script = (base, trash) => `
    cd ${shq(base)} || exit 1
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      tgt=${shq(trash)}/"$f"
      mkdir -p "$(dirname "$tgt")" 2>/dev/null
      mv -- "$f" "$tgt" 2>/dev/null || rm -rf -- "$f"
    done`;

  const input = `${paths.join('\n')}\n`;
  if (side === 'remote') {
    ssh(target, script(projectPath, `${remoteHome}/.lite-sync/trash/${encodeName(projectPath)}/${stamp}-deleted`), { input });
  } else {
    const res = spawnSync('bash', ['-c', script(projectPath, `${trashDir(projectPath)}-deleted`)], { input, encoding: 'utf8' });
    if (res.status !== 0) fail(`не удалось убрать удалённые файлы: ${res.stderr}`);
  }
  return paths.length;
}

// ------------------------------------------------------------------ корзина

// Снимок в корзине — это <корзина>/<проект>/<время>. Удаляем только каталоги с
// таким именем: что бы ни лежало в корзине помимо них, это не наша забота.
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-deleted)?$/;

function pruneLocalTrash(now = Date.now()) {
  const root = path.join(STATE_DIR, 'trash');
  const cutoff = now - TRASH_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }

  let removed = 0;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let snapshots;
    try { snapshots = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const snapshot of snapshots) {
      if (!snapshot.isDirectory() || !SNAPSHOT_NAME.test(snapshot.name)) continue;
      const full = path.join(dir, snapshot.name);
      try {
        if (fs.statSync(full).mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        // права, занятый файл — сказать и идти дальше: уборка не повод рушить обмен
        console.log(`### снимок ${snapshot.name} убрать не вышло: ${err.message}`);
      }
    }
  }
  return removed;
}

// На сервере то же самое делает find: тащить по ssh листинг из десятков тысяч
// файлов ради этого незачем. Сервера может не оказаться — тогда вернём null и
// ограничимся здешней корзиной.
function pruneRemoteTrash(target, remoteHome) {
  const root = `${remoteHome}/.lite-sync/trash`;
  const find = `find ${shq(root)} -mindepth 2 -maxdepth 2 -type d -mtime +${TRASH_KEEP_DAYS} -print -exec rm -rf -- {} + 2>/dev/null; exit 0`;
  const out = ssh(target, find, { soft: true });
  return out === null ? null : out.split('\n').filter(Boolean).length;
}

// Раз в час, не чаще: демон дёргает синхронизацию каждые несколько секунд, а
// обходить корзину на каждый чих — только зря греть диск. Отметку времени
// держит сам файл: заводить ради неё формат состояния не стоит.
function duePrune(now = Date.now()) {
  const marker = path.join(STATE_DIR, 'trash-pruned');
  try {
    if (now - fs.statSync(marker).mtimeMs < PRUNE_EVERY_MS) return false;
  } catch { /* отметки ещё нет — значит пора */ }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(marker, `${new Date(now).toISOString()}\n`);
  } catch { /* не записалась — почистим в следующий раз */ }
  return true;
}

// ------------------------------------------------------------------ отчёт

function preview(title, paths, limit = 12) {
  if (!paths.length) return;
  console.log(`  ${title}: ${paths.length}`);
  for (const item of paths.slice(0, limit)) console.log(`      ${item}`);
  if (paths.length > limit) console.log(`      … и ещё ${paths.length - limit}`);
}

// -------------------------------------------------------------------- main

function main() {
  const [command, rawPath, ...rest] = process.argv.slice(2);
  const go = rest.includes('--go');
  // чью сторону взять в спорных файлах; без этого спор висит, пока его не разрулят руками
  const preferIndex = rest.indexOf('--prefer');
  const prefer = preferIndex >= 0 ? rest[preferIndex + 1] : null;
  if (prefer && !['local', 'remote'].includes(prefer)) fail('--prefer принимает local или remote');
  // для каталога памяти агента: MEMORY.md объединять, а не выбирать сторону (умеет только дополнение)
  const mergeMemory = rest.includes('--merge-memory') && Boolean(addon && addon.mergeMemoryIndex);

  if (!command || !rawPath) {
    console.log(`lite-sync <status|push|pull|auto|adopt> <абсолютный путь> [--go] [--prefer local|remote]

  status  показать, что разошлось
  push    отправить свои изменения на сервер
  pull    забрать изменения с сервера
  auto    определить направление самому
  adopt   принять текущее состояние как согласованное (после ручной заливки)`);
    process.exit(2);
  }
  if (!['status', 'push', 'pull', 'auto', 'adopt'].includes(command)) fail(`неизвестная команда: ${command}`);

  const projectPath = path.resolve(rawPath);
  if (!fs.existsSync(projectPath)) fail(`каталога нет: ${projectPath}`);

  const target = resolveTarget();

  // часы: если они разъехались, «кто свежее» перестаёт что-либо значить
  const localNow = Math.floor(Date.now() / 1000);
  const remoteNow = Number(ssh(target, 'date +%s').trim());
  const drift = Math.abs(localNow - remoteNow);
  if (drift > CLOCK_TOLERANCE_S) {
    fail(`часы разошлись на ${drift} с — синхронизация отменена, сначала поправьте время`);
  }
  const remoteHome = ssh(target, 'echo $HOME').trim();

  console.log(`### ${command} | ${projectPath}`);
  console.log(`### сервер: ${target}, расхождение часов ${drift} с${go ? '' : ' | СУХОЙ ПРОГОН'}`);

  const local = listLocal(projectPath);
  const remote = listRemote(target, projectPath);
  const manifest = loadManifest(projectPath);
  const risk = wipeRisk(local, remote, manifest.files.size, command);
  if (risk) fail(risk);
  const plan = analyze(local, remote, manifest, prefer);

  console.log(`### файлов: здесь ${local.size}, на сервере ${remote.size}, в манифесте ${manifest.files.size}`);
  if (plan.first) console.log('### манифеста нет — первая синхронизация этого каталога');

  // «принять как есть»: считаем нынешнее совпадающее состояние согласованным
  // и просто запоминаем его. Нужно после ручной первой заливки, иначе весь
  // каталог выглядит изменённым с обеих сторон.
  if (command === 'adopt') {
    const agreed = new Map();
    for (const [key, value] of local) if (same(value, remote.get(key))) agreed.set(key, value);
    const differ = [...local.keys()].filter((k) => remote.has(k) && !same(local.get(k), remote.get(k)));
    if (go) saveManifest(projectPath, agreed, new Map());
    console.log(`\n### согласовано файлов: ${agreed.size}`);
    preview('различаются (останутся спорными)', differ);
    if (!go) console.log('\n### сухой прогон. Повторите с --go, чтобы запомнить состояние');
    return;
  }

  // индекс памяти объединяем до всего остального — тогда он перестаёт быть спорным
  if (mergeMemory && go) {
    for (const key of [...plan.conflicts]) {
      if (!key.endsWith('MEMORY.md')) continue;
      const report = addon.mergeMemoryIndex({ target, projectPath, relPath: key, runRsync });
      if (report === null) continue;
      plan.conflicts.splice(plan.conflicts.indexOf(key), 1);
      console.log(`\n### ${key}: объединён построчно`);
      for (const line of report.split('\n').slice(0, 6)) console.log(`    ${line}`);
    }
  }

  if (plan.conflicts.length) {
    if (prefer) {
      console.log(`\n⚠ спорных файлов ${plan.conflicts.length}, беру сторону: ${prefer === 'local' ? 'ПК' : 'сервера'}`);
    } else {
      console.log('\n⚠ ПРАВИЛИ С ОБЕИХ СТОРОН — эти файлы не трогаю, решите сами:');
      preview('спорных', plan.conflicts, 20);
      console.log('    разрулить: повторите с --prefer local (взять домашние) или --prefer remote (взять серверные)');
    }
  }

  let push = plan.toPush;
  let pull = plan.toPull;
  let delRemote = plan.deleteRemote;
  let delLocal = plan.deleteLocal;

  if (prefer === 'local') push = push.concat(plan.conflicts);
  if (prefer === 'remote') pull = pull.concat(plan.conflicts);

  // Файл, закрытый правами (секрет rabbitmq или данные postgres из контейнера —
  // они принадлежат подчинённому uid), rsync прочитать не сможет. В манифест он
  // после этого не попадёт и будет всплывать в каждом прогоне, а прогон каждый
  // раз заканчиваться жалобой. Отсеиваем такие файлы здесь и говорим об этом один раз.
  const denied = [];
  push = push.filter((rel) => {
    try {
      fs.accessSync(path.join(projectPath, rel), fs.constants.R_OK);
      return true;
    } catch {
      denied.push(rel);
      return false;
    }
  });
  if (denied.length) preview('пропускаю, нет прав на чтение', denied, 5);

  if (command === 'push') { pull = []; delLocal = []; }
  if (command === 'pull') { push = []; delRemote = []; }
  if (command === 'status') {
    console.log('');
    preview('уедет на сервер', push);
    preview('приедет с сервера', pull);
    preview('удалится на сервере', delRemote);
    preview('удалится здесь', delLocal);
    if (!push.length && !pull.length && !delRemote.length && !delLocal.length && !plan.conflicts.length) {
      console.log('  всё совпадает, делать нечего');
    }
    return;
  }

  if (plan.byTime.length) {
    console.log('');
    preview('решено по свежести (в манифесте не было базы для сравнения)', plan.byTime);
  }

  console.log('');
  preview('уедет на сервер', push);
  preview('приедет с сервера', pull);
  preview('удалится на сервере', delRemote);
  preview('удалится здесь', delLocal);

  if (!go) {
    console.log('\n### сухой прогон окончен, ничего не изменено. Повторите с --go');
    return;
  }

  const dry = false;
  transfer({ direction: 'push', target, projectPath, paths: push, dry, remoteHome });
  transfer({ direction: 'pull', target, projectPath, paths: pull, dry, remoteHome });
  applyDeletions({ side: 'remote', target, projectPath, paths: delRemote, dry, remoteHome });
  applyDeletions({ side: 'local', target, projectPath, paths: delLocal, dry, remoteHome });

  if (duePrune()) {
    const here = pruneLocalTrash();
    const there = pruneRemoteTrash(target, remoteHome);
    if (here || there) {
      console.log(`\n### корзина: снимков старше ${TRASH_KEEP_DAYS} дн. убрано здесь ${here}, на сервере ${there ?? 'не спрашивал'}`);
    }
  }

  // после обмена пересчитываем обе стороны и запоминаем только то, что совпало
  const afterLocal = listLocal(projectPath);
  const afterRemote = listRemote(target, projectPath);
  const agreed = new Map();
  for (const [key, value] of afterLocal) if (same(value, afterRemote.get(key))) agreed.set(key, value);

  const keep = new Map();
  if (!prefer) {
    // спор оставляем в манифесте нетронутым, чтобы он всплыл и в следующий раз
    for (const key of plan.conflicts) {
      const old = manifest.files.get(key);
      if (old) keep.set(key, old);
    }
  }
  saveManifest(projectPath, agreed, keep);

  console.log(`\n### готово: отправлено ${push.length}, получено ${pull.length}, удалено там ${delRemote.length}, здесь ${delLocal.length}`);

  // Сколько весило перенесённое. Размер лежит в описании файла с той стороны,
  // откуда файл едет: отправленное меряем по здешнему списку, полученное — по
  // серверному. Каталоги пропускаем: у них размер к делу не относится.
  const weigh = (keys, listing) => keys.reduce((sum, key) => {
    const item = listing.get(key);
    return sum + (item && item.type === 'f' ? Number(item.size) || 0 : 0);
  }, 0);
  const pushedBytes = weigh(push, local);
  const pulledBytes = weigh(pull, remote);
  if (pushedBytes || pulledBytes) {
    console.log(`### объём: отправлено ${humanBytes(pushedBytes)}, получено ${humanBytes(pulledBytes)}`);
  }

  // Машинная сводка последней строкой — её читает демон (`lite-sync-daemon.js`).
  // Человеческие строки выше он тоже умеет разбирать и остаётся при них, если
  // окажется новее этого файла; здесь же всё сразу и без регулярных выражений.
  console.log(`### сводка ${JSON.stringify({
    ok: true,
    pushed: push.length,
    pulled: pull.length,
    deletedRemote: delRemote.length,
    deletedLocal: delLocal.length,
    conflicts: plan.conflicts.length,
    pushedBytes,
    pulledBytes,
  })}`);
  if (plan.conflicts.length && !prefer) {
    console.log(`### спорных осталось: ${plan.conflicts.length} (не тронуты, всплывут снова)`);
  } else if (plan.conflicts.length) {
    console.log(`### спорных разрулено: ${plan.conflicts.length} (взята сторона ${prefer === 'local' ? 'ПК' : 'сервера'}, прежнее — в корзине)`);
  }
  console.log(`### корзина: ${path.join(STATE_DIR, 'trash', encodeName(projectPath))} и та же папка на сервере`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

module.exports = { SyncError, validServer, readConfigFile, addon, STATE_DIR, SSH_OPTS, ensureMuxDir, listLocal, listRemote, parseListing, parseRemoteListing, NODIR_MARK, wipeRisk, forgetManifest, manifestPath, analyze, sideDelta, same, encodeName, remoteSummary, resolveTarget, ssh, shq, CLOCK_TOLERANCE_S, isAppendOnlyLog, transfer, pruneLocalTrash, duePrune, TRASH_KEEP_DAYS };
