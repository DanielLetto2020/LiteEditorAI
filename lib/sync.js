'use strict';
// Какие проекты домашняя машина держит в синхронизации с сервером.
//
// Источник — конфиг демона синхронизации (~/.lite-sync/config.json; сам демон
// живёт в scripts/server-sync/). Пишут его мастер подключения и процедура
// подключения проекта (lite-sync-link.js); здесь только чтение — для метки «sync».
//
// Сравнивать приходится РАЗРЕШЁННЫЕ пути, а не строки. Часть проектов подключена
// в корень симлинками (projects/home/kudatut-v2 → projects/LiteEditorHomeDir/kudatut-v2):
// демон хранит настоящий путь, а редактор — тот, которым проект открыли. Сравнение
// строк в лоб оставило бы без метки ровно те проекты, что подключены симлинком.

const fs = require('fs');
const os = require('os');
const path = require('path');

function configFile() {
  if (process.env.LITE_SYNC_CONFIG) return process.env.LITE_SYNC_CONFIG;
  const dir = process.env.LITE_SYNC_DIR || path.join(os.homedir(), '.lite-sync');
  return path.join(dir, 'config.json');
}

function real(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }   // папки нет — сравним как есть
}

// Пути из конфига демона, разрешённые. Пустое множество означает «синхронизации
// нет»: демон не установлен, конфиг не создан или обмен выключен целиком —
// во всех этих случаях меток в плашках просто не будет.
function syncedPaths() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (!cfg || cfg.enabled === false) return new Set();
    const list = Array.isArray(cfg.projects) ? cfg.projects : [];
    return new Set(list.map((p) => (typeof p === 'string' ? p : p && p.path)).filter(Boolean).map(real));
  } catch (_) {
    return new Set();
  }
}

// Из присланных путей — те, что синхронизируются. Возвращаются В ИСХОДНОМ виде:
// рендерер сопоставляет их со своими же строками, realpath ему недоступен.
function match(paths) {
  const synced = syncedPaths();
  if (!synced.size) return [];
  return (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p && synced.has(real(p)));
}

// То же для главного процесса — без блокировки. realpathSync на отвалившемся sshfs/NFS висит
// бесконечно, а опрос меток идёт по таймеру: весь редактор замирал бы вместе с ним. Асинхронный
// realpath висит в пуле потоков, а не в главном; путь, не ответивший за REAL_TIMEOUT_MS, минуту
// сравниваем как есть и повторно не спрашиваем — зависшие вызовы не копятся и не съедают пул.
const REAL_TIMEOUT_MS = 1500;
const inflight = new Map();   // путь → обещание realpath
const slowUntil = new Map();  // путь → до какого момента не спрашивать
async function realAsync(p) {
  if ((slowUntil.get(p) || 0) > Date.now()) return p;
  let pr = inflight.get(p);
  if (!pr) {
    pr = fs.promises.realpath(p).catch(() => p).finally(() => inflight.delete(p));
    inflight.set(p, pr);
  }
  let timer;
  const res = await Promise.race([pr, new Promise((r) => { timer = setTimeout(() => r(null), REAL_TIMEOUT_MS); })]);
  clearTimeout(timer);
  if (res === null) { slowUntil.set(p, Date.now() + 60000); return p; }
  return res;
}
async function matchAsync(paths) {
  let list;
  try {
    const cfg = JSON.parse(await fs.promises.readFile(configFile(), 'utf8'));
    if (!cfg || cfg.enabled === false) return [];
    list = (Array.isArray(cfg.projects) ? cfg.projects : []).map((p) => (typeof p === 'string' ? p : p && p.path)).filter(Boolean);
  } catch (_) { return []; }
  if (!list.length) return [];
  const synced = new Set(await Promise.all(list.map(realAsync)));
  const input = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p);
  const reals = await Promise.all(input.map(realAsync));
  return input.filter((_, i) => synced.has(reals[i]));
}

module.exports = { syncedPaths, match, matchAsync, configFile };
