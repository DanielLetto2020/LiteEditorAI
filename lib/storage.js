// Бэкенд модуля «Внешние хранилища»: подключения (scope проект/общие) + адаптеры.
// Первый адаптер — S3 (lib/storage-s3.js); интерфейс адаптера описан там же. Секреты шифрует
// safeStorage (схема enc/dec — как lib/db.js / lib/kafka.js), в рендерер уходит только hasSecret.
// Все ответы — строго { ok:true, ... } | { ok:false, error } (общая обёртка ipcMain.handle в
// main.js логирует {ok:false} сама). Долгие передачи шлют прогресс событиями st:progress/st:done/
// st:opErr в ОКНО-ВЛАДЕЛЬЦА (e.sender), отмена — st:cancel {opId}.
//
// main.js: registerStorageIpc({ ipcMain, safeStorage, dialog, getConnections, setConnections }).

const s3 = require('./storage-s3');
const path = require('path');

let _safe = null, _get = null, _set = null;

// ---------------------------------------------------------------- secrets (как lib/db.js)
function enc(text) {
  if (!text) return '';
  try { if (_safe && _safe.isEncryptionAvailable()) return 'v1:' + _safe.encryptString(text).toString('base64'); } catch (_) {}
  return 'b64:' + Buffer.from(String(text), 'utf8').toString('base64'); // fallback: только обфускация
}
function dec(blob) {
  if (!blob) return '';
  try {
    if (blob.startsWith('v1:')) return _safe.decryptString(Buffer.from(blob.slice(3), 'base64'));
    if (blob.startsWith('b64:')) return Buffer.from(blob.slice(4), 'base64').toString('utf8');
  } catch (_) {}
  return '';
}

// ---------------------------------------------------------------- store
function loadConns() { const a = _get(); return Array.isArray(a) ? a : []; }
function saveConns(a) { _set(a); }
function publicConn(c) { const { secretEnc, sessionTokenEnc, ...rest } = c; return { ...rest, hasSecret: !!secretEnc }; }
function publicList() { return loadConns().map(publicConn); }
function connById(id) {
  const c = loadConns().find((x) => x.id === id);
  if (!c) throw new Error('Подключение не найдено');
  return c;
}

// ---------------------------------------------------------------- адаптеры и клиенты
// Пока адаптер один; таблица — точка расширения (WebDAV/FTP добавляются записью сюда).
const ADAPTERS = { s3 };
function adapterOf(c) {
  const a = ADAPTERS[c.adapter || 's3'];
  if (!a) throw new Error('Неизвестный адаптер: ' + c.adapter);
  return a;
}
// Расшифрованный конфиг для адаптера (секреты живут только в main-процессе).
function cfgOf(c) {
  return {
    endpoint: c.endpoint || '', region: c.region || 'us-east-1',
    forcePathStyle: !!c.forcePathStyle, anonymous: !!c.anonymous,
    accessKeyId: c.accessKeyId || '', secret: dec(c.secretEnc), sessionToken: dec(c.sessionTokenEnc),
    defaultBucket: c.defaultBucket || '', publicBaseUrl: c.publicBaseUrl || '',
  };
}
const clients = new Map(); // id -> { client, stamp } — кэш живых клиентов; сбрасывается при save/delete
function clientFor(c) {
  const hit = clients.get(c.id);
  if (hit) return hit.client;
  const client = adapterOf(c).makeClient(cfgOf(c));
  clients.set(c.id, { client });
  return client;
}
function evict(id) { const h = clients.get(id); if (h) { try { h.client.destroy && h.client.destroy(); } catch (_) {} clients.delete(id); } }

// Запрет записи: read-only и анонимные подключения мутировать хранилище не могут.
// Энфорс здесь (первая линия — UI прячет кнопки, но границей безопасности является бэкенд).
function guardWrite(c) {
  if (c.readOnly) throw new Error('Подключение помечено «только чтение»');
  if (c.anonymous) throw new Error('Анонимное подключение — запись недоступна');
}

// ---------------------------------------------------------------- просмотр (лимиты как в проекте)
const MAX_TEXT_VIEW = 2 * 1024 * 1024;    // текст в вивере — 2 МБ (как fs:readFile)
const MAX_IMG_VIEW = 12 * 1024 * 1024;    // картинка — 12 МБ (как fs:readDataUrl)
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const looksBinary = (buf) => buf.subarray(0, 8192).includes(0); // NUL-детект, как lib/remotehost.js

// ---------------------------------------------------------------- IPC
function registerStorageIpc({ ipcMain, safeStorage, dialog, getConnections, setConnections }) {
  _safe = safeStorage; _get = getConnections; _set = setConnections;

  const ops = new Map(); // opId -> { abort } — живые передачи (отмена + уборка при смерти окна)

  ipcMain.handle('st:list', () => ({ ok: true, connections: publicList(), secure: !!(safeStorage && safeStorage.isEncryptionAvailable()) }));

  // Создание/правка. Секреты приходят только когда меняются; нет — оставляем прежние блобы.
  ipcMain.handle('st:save', (_e, { conn } = {}) => {
    if (!conn || !conn.name) return { ok: false, error: 'нет данных подключения' };
    const list = loadConns();
    const idx = conn.id ? list.findIndex((x) => x.id === conn.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...conn };
    delete rec.hasSecret;
    if (conn.secretKey != null) rec.secretEnc = conn.secretKey ? enc(conn.secretKey) : '';
    if (conn.sessionToken != null) rec.sessionTokenEnc = conn.sessionToken ? enc(conn.sessionToken) : '';
    delete rec.secretKey; delete rec.sessionToken;
    if (!rec.id) rec.id = 'st' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (!rec.scope) rec.scope = '__global__';
    if (!rec.adapter) rec.adapter = 's3';
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveConns(list);
    evict(rec.id);
    return { ok: true, id: rec.id, connection: publicConn(rec) };
  });

  ipcMain.handle('st:delete', (_e, { id } = {}) => {
    saveConns(loadConns().filter((x) => x.id !== id));
    evict(id);
    return { ok: true };
  });

  // Перенос «Проект ⇄ Общие»: смена одного поля = одна атомарная запись (задвоение невозможно).
  ipcMain.handle('st:setScope', (_e, { id, scope } = {}) => {
    if (!scope) return { ok: false, error: 'нет scope' };
    const list = loadConns();
    const rec = list.find((x) => x.id === id);
    if (!rec) return { ok: false, error: 'Подключение не найдено' };
    rec.scope = String(scope);
    saveConns(list);
    return { ok: true, connection: publicConn(rec) };
  });

  // Тест: поля формы поверх сохранённых; секрет — введённый, иначе сохранённый блоб.
  ipcMain.handle('st:test', async (_e, { conn } = {}) => {
    try {
      const saved = conn && conn.id ? (loadConns().find((x) => x.id === conn.id) || {}) : {};
      const merged = { ...saved, ...conn };
      if (conn && conn.secretKey != null) merged.secretEnc = conn.secretKey ? enc(conn.secretKey) : '';
      if (conn && conn.sessionToken != null) merged.sessionTokenEnc = conn.sessionToken ? enc(conn.sessionToken) : '';
      const a = adapterOf(merged);
      const cfg = cfgOf(merged);
      const client = a.makeClient(cfg);
      try { return { ok: true, ...(await a.test(client, cfg)) }; }
      finally { try { client.destroy && client.destroy(); } catch (_) {} }
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // Обёртки: dataCall — чтение, writeCall — мутация (плюс guardWrite).
  const dataCall = (fn) => async (_e, args = {}) => {
    try { const c = connById(args.id); return { ok: true, ...(await fn(c, args)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };
  const writeCall = (fn) => async (_e, args = {}) => {
    try { const c = connById(args.id); guardWrite(c); return { ok: true, ...(await fn(c, args)) }; }
    catch (e) { return { ok: false, error: String(e.message || e), ...(e.aclUnsupported ? { aclUnsupported: true } : {}) }; }
  };

  ipcMain.handle('st:buckets', dataCall(async (c) => ({ buckets: await adapterOf(c).listBuckets(clientFor(c)) })));
  ipcMain.handle('st:ls', dataCall(async (c, { bucket, prefix, token }) => adapterOf(c).ls(clientFor(c), { bucket, prefix: prefix || '', token })));
  ipcMain.handle('st:stat', dataCall(async (c, { bucket, key }) => ({ meta: await adapterOf(c).stat(clientFor(c), { bucket, key }) })));

  // Просмотр: картинка → dataUrl (≤12 МБ), текст → Range-GET первых 2 МБ + NUL-детект.
  ipcMain.handle('st:read', dataCall(async (c, { bucket, key }) => {
    const a = adapterOf(c);
    const client = clientFor(c);
    const meta = await a.stat(client, { bucket, key });
    const ext = path.extname(String(key)).toLowerCase();
    if (IMG_EXT.has(ext)) {
      if (meta.size > MAX_IMG_VIEW) return { kind: 'binary', size: meta.size, meta, note: 'Картинка больше 12 МБ — скачайте для просмотра' };
      const buf = await a.readObject(client, { bucket, key, maxBytes: MAX_IMG_VIEW });
      return { kind: 'image', dataUrl: 'data:' + (meta.contentType || a.mimeOf(key)) + ';base64,' + buf.toString('base64'), size: meta.size, meta };
    }
    const end = Math.min(meta.size, MAX_TEXT_VIEW) - 1;
    if (end < 0) return { kind: 'text', content: '', size: 0, truncated: false, meta }; // пустой объект
    const buf = await a.readRange(client, { bucket, key, start: 0, end });
    if (looksBinary(buf)) return { kind: 'binary', size: meta.size, meta };
    return { kind: 'text', content: buf.toString('utf8'), size: meta.size, truncated: meta.size > MAX_TEXT_VIEW, meta };
  }));

  ipcMain.handle('st:presign', dataCall(async (c, { bucket, key, ttl, method }) => {
    if (c.anonymous) throw new Error('Анонимное подключение — подписанные ссылки недоступны (объекты и так публичны)');
    if (method === 'PUT') guardWrite(c); // подписанная ссылка НА ЗАПИСЬ с read-only профиля — дыра
    return adapterOf(c).presign(clientFor(c), { bucket, key, ttl, method });
  }));
  ipcMain.handle('st:publicUrl', dataCall(async (c, { bucket, key }) => ({ url: adapterOf(c).publicUrl(cfgOf(c), bucket, key) })));
  ipcMain.handle('st:aclGet', dataCall(async (c, { bucket, key }) => adapterOf(c).aclGet(clientFor(c), { bucket, key })));
  ipcMain.handle('st:aclSet', writeCall(async (c, { bucket, key, public: pub }) => adapterOf(c).aclSet(clientFor(c), { bucket, key, public: pub })));

  ipcMain.handle('st:mkdir', writeCall(async (c, { bucket, prefix }) => adapterOf(c).mkdir(clientFor(c), { bucket, prefix })));
  ipcMain.handle('st:copy', writeCall(async (c, { bucket, from, to }) => adapterOf(c).copy(clientFor(c), { bucket, from, to })));
  // rename = copy + delete: НЕ атомарно по природе S3 (фронт предупреждает в подтверждении)
  ipcMain.handle('st:rename', writeCall(async (c, { bucket, from, to }) => {
    const a = adapterOf(c);
    await a.copy(clientFor(c), { bucket, from, to });
    await a.remove(clientFor(c), { bucket, keys: [from] });
    return {};
  }));
  ipcMain.handle('st:remove', writeCall(async (c, { bucket, keys }) => adapterOf(c).remove(clientFor(c), { bucket, keys: Array.isArray(keys) ? keys : [] })));
  ipcMain.handle('st:removePrefix', writeCall(async (c, { bucket, prefix }) => adapterOf(c).removePrefix(clientFor(c), { bucket, prefix })));

  // ------------------------------------------------ передачи (прогресс → окно-владелец)
  // Троттл эмита ~5 к/с — прогресс большого файла не должен заспамить IPC.
  function progressSender(sender, opId, phase, key) {
    let last = 0;
    return (loaded, total) => {
      const now = Date.now();
      if (now - last < 200 && loaded !== total) return;
      last = now;
      if (!sender.isDestroyed()) sender.send('st:progress', { opId, phase, key, loaded, total });
    };
  }
  function runOp(sender, opId, key, task) {
    ops.set(opId, task);
    sender.once('destroyed', () => { const t = ops.get(opId); if (t) { ops.delete(opId); t.abort(); } });
    task.done
      .then(() => { if (ops.delete(opId) && !sender.isDestroyed()) sender.send('st:done', { opId, key }); })
      .catch((e) => { if (ops.delete(opId) && !sender.isDestroyed()) sender.send('st:opErr', { opId, key, error: String(e.message || e) }); });
  }

  ipcMain.handle('st:upload', (e, { id, bucket, key, filePath, opId } = {}) => {
    try {
      const c = connById(id); guardWrite(c);
      if (!opId || !filePath) return { ok: false, error: 'нет opId/filePath' };
      const task = adapterOf(c).upload(clientFor(c), { bucket, key, filePath, onProgress: progressSender(e.sender, opId, 'upload', key) });
      runOp(e.sender, opId, key, task);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  });

  ipcMain.handle('st:download', (e, { id, bucket, key, destPath, opId } = {}) => {
    try {
      const c = connById(id);
      if (!opId || !destPath) return { ok: false, error: 'нет opId/destPath' };
      const task = adapterOf(c).download(clientFor(c), { bucket, key, destPath, onProgress: progressSender(e.sender, opId, 'download', key) });
      runOp(e.sender, opId, key, task);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  });

  ipcMain.on('st:cancel', (_e, { opId } = {}) => { const t = ops.get(opId); if (t) { ops.delete(opId); t.abort(); } });

  // ------------------------------------------------ диалоги выбора файлов/папок
  ipcMain.handle('st:pickUploads', async (e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Загрузить в хранилище', properties: ['openFile', 'multiSelections'] });
    return { ok: true, paths: r.canceled ? [] : r.filePaths };
  });
  ipcMain.handle('st:pickDownloadDir', async (e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Куда скачать', properties: ['openDirectory', 'createDirectory'] });
    return { ok: true, dir: r.canceled ? '' : r.filePaths[0] };
  });

  return {};
}

module.exports = { registerStorageIpc, _test: { enc, dec, publicConn, cfgOf } };
