'use strict';
// Какие проекты домашняя машина держит в синхронизации с сервером.
//
// Источник — конфиг демона синхронизации (~/.lite-sync/config.json; сам демон
// живёт в scripts/server-sync/). Редактор им не управляет и ничего туда не
// пишет: только читает, чтобы поставить в плашке проекта метку «sync».
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

// Есть ли на этой машине синхронизация вообще. В публичной сборке каталога
// scripts/server-sync/ нет (он приватный и в релиз не уезжает), а у чужого
// пользователя нет и конфига — значит метку «sync» показывать незачем: она
// говорила бы о механизме, которого у него не существует.
function available() {
  try { return fs.existsSync(configFile()); } catch (_) { return false; }
}

module.exports = { syncedPaths, match, configFile, available };
