// Слежение за деревом проекта: какие файлы поменялись на диске, пока агент правит код в терминале.
// Используется в main.js (IPC fs:watch); тесты — test/tree-watch.test.js.
//
// Почему не просто fs.watch(root, { recursive: true }). На Linux Node (24, внутри Electron 42) обходит
// дерево сам и ставит отдельное inotify-наблюдение на КАЖДЫЙ файл и каталог — включая node_modules,
// vendor и .git, отсечь их нечем. Лимит наблюдений общий на пользователя (fs.inotify.max_user_watches,
// часто 65 536), и один проект с зависимостями съедал его целиком: у соседних программ (dev-сервер
// с HMR, IDE) слежение отваливалось. Замер 2026-09-15: kudatut-v2 — 64 380 наблюдений.
//
// Поэтому на Linux наблюдение ставится на каждый КАТАЛОГ (inotify на каталоге и так сообщает о файлах
// внутри), каталоги из ignore не обходятся вовсе, новые каталоги довешиваются по событию, удалённые
// снимаются. Тот же проект — 456 наблюдений. Потолок maxDirs: огромное дерево не отнимает лимит
// у других программ, а честно заканчивается событием 'error' → в UI ручной ⟳.
//
// На macOS и Windows нативный recursive работает одним дескриптором (FSEvents / ReadDirectoryChangesW),
// там он отдаётся как есть.
//
// Контракт как у fs.FSWatcher: событие 'change' (type, путь относительно root), событие 'error', close().

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_MAX_DIRS = 10000;

// ready и size есть только у Linux-варианта: ready — первичный обход закончен, size — сколько каталогов под слежением.
/** @typedef {import('events').EventEmitter & { close(): void, ready?: Promise<void>, size?: () => number }} TreeWatcher */

/**
 * Следить за деревом root. Не вышло поставить наблюдение на сам root — бросает, как fs.watch.
 * @param {string} root
 * @param {{ ignore?: Set<string>, maxDirs?: number, platform?: string }} [opts]
 *   ignore — имена каталогов, в которые не заходить; platform — для тестов.
 * @returns {TreeWatcher}
 */
function watchTree(root, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'linux') return fs.watch(root, { recursive: true });
  return watchTreeLinux(path.resolve(root), opts.ignore || new Set(), opts.maxDirs || DEFAULT_MAX_DIRS);
}

/**
 * @param {string} root абсолютный, нормализованный
 * @param {Set<string>} ignore
 * @param {number} maxDirs
 * @returns {TreeWatcher}
 */
function watchTreeLinux(root, ignore, maxDirs) {
  const ee = /** @type {TreeWatcher} */ (new EventEmitter());
  const dirs = new Map(); // абсолютный путь каталога → fs.FSWatcher
  let closed = false;

  const close = () => {
    closed = true;
    for (const w of dirs.values()) { try { w.close(); } catch (_) {} }
    dirs.clear();
  };
  const fail = (err) => {
    if (closed) return;
    close();
    ee.emit('error', err);
  };
  // Снять наблюдение с каталога и со всего, что под ним (каталог удалён или переехал).
  const drop = (dir) => {
    if (!dirs.has(dir)) return; // файл или неотслеживаемый каталог — под ним наблюдений нет
    const prefix = dir + path.sep;
    for (const [d, w] of dirs) {
      if (d === dir || d.startsWith(prefix)) { try { w.close(); } catch (_) {} dirs.delete(d); }
    }
  };

  // Поставить наблюдение на один каталог. true — поставлено, поддерево надо обойти; false — уже стоит
  // или каталог недоступен. Кончился лимит (свой потолок или ENOSPC ядра) — бросает: дальше следить нельзя.
  const watchDir = (dir) => {
    if (closed || dirs.has(dir)) return false;
    if (dirs.size >= maxDirs) {
      throw Object.assign(new Error(`слишком много каталогов для слежения: больше ${maxDirs}`), { code: 'ELIMIT' });
    }
    let w;
    try {
      w = fs.watch(dir, (type, name) => onEvent(dir, type, name));
    } catch (err) {
      if (err.code === 'ENOSPC' || dir === root) throw err;
      return false; // EACCES, или каталог исчез между readdir и watch — просто пропускаем
    }
    w.on('error', (err) => { if (dir === root) fail(err); else drop(dir); });
    dirs.set(dir, w);
    return true;
  };

  // Обойти поддерево, на корне которого наблюдение уже стоит. Симлинки на каталоги не раскрываются —
  // как и у нативного recursive (заодно нет риска петли).
  const walk = async (start) => {
    const stack = [start];
    while (stack.length) {
      if (closed) return;
      const dir = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of entries) {
        if (!ent.isDirectory() || ignore.has(ent.name)) continue;
        const child = path.join(dir, ent.name);
        if (watchDir(child)) stack.push(child);
      }
    }
  };

  const onEvent = (dir, type, name) => {
    if (closed || !dirs.has(dir)) return; // наблюдение уже снято: хвост событий удалённого каталога
    if (name == null) { ee.emit('change', type, path.relative(root, dir)); return; }
    const full = path.join(dir, String(name));
    const rel = path.relative(root, full);
    if (type !== 'rename') { ee.emit('change', type, rel); return; }
    // rename — путь появился, исчез или переехал. Новый каталог получает наблюдение на всё поддерево,
    // с исчезнувшего оно снимается.
    fs.promises.lstat(full).then((st) => {
      if (closed) return;
      try {
        if (st.isDirectory() && !ignore.has(path.basename(full)) && watchDir(full)) walk(full).catch(fail);
      } catch (err) { fail(err); return; }
      ee.emit('change', type, rel);
    }, () => {
      if (closed) return;
      if (String(name) !== path.basename(dir)) { drop(full); ee.emit('change', type, rel); return; }
      // Имя совпало с самим каталогом: это может быть его «прощальное» событие (inotify IN_DELETE_SELF /
      // IN_MOVE_SELF приходят с именем наблюдаемого каталога). Каталог жив — значит, исчез одноимённый
      // путь внутри; не жив — наблюдение снимается молча, о пропаже сообщит родитель.
      fs.promises.lstat(dir).then(() => {
        if (closed) return;
        drop(full); ee.emit('change', type, rel);
      }, () => {
        if (closed) return;
        if (dir === root) fail(Object.assign(new Error('каталог проекта удалён или переехал'), { code: 'ENOENT' }));
        else drop(dir);
      });
    });
  };

  watchDir(root); // корень — синхронно: не вышло (нет каталога, кончился лимит) — бросаем вызывающему
  ee.close = close;
  ee.size = () => dirs.size;
  ee.ready = walk(root).catch(fail);
  return ee;
}

module.exports = { watchTree, DEFAULT_MAX_DIRS };
