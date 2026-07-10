// Адаптер S3 модуля «Внешние хранилища»: чистые операции над одним подключением, без стора
// и без IPC (это слой lib/storage.js). Клиент — @aws-sdk/client-s3 (v3): совместим с AWS,
// MinIO, Cloudflare R2, Yandex Object Storage и т.п. через endpoint + forcePathStyle.
// Секреты сюда приходят УЖЕ расшифрованными (dec — в lib/storage.js).
//
// Контракт адаптера (его же обязан реализовать любой будущий адаптер — WebDAV/FTP/…):
// test, listBuckets, ls, stat, readRange, readObject, presign, aclGet, aclSet,
// upload, download, copy, remove, removePrefix, mkdir. Все броски — Error с человеческим
// message (humanErr), наружу их превращает в {ok:false,error} слой IPC.

const {
  S3Client, ListBucketsCommand, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand,
  PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand, DeleteObjectCommand,
  GetObjectAclCommand, PutObjectAclCommand, GetBucketLocationCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- клиент
// cfg: { endpoint, region, forcePathStyle, anonymous, accessKeyId, secret, sessionToken }
function makeClient(cfg) {
  const conf = {
    region: cfg.region || 'us-east-1',
    forcePathStyle: !!cfg.forcePathStyle,
    requestHandler: { requestTimeout: 30000, connectionTimeout: 8000 },
    maxAttempts: 3,
  };
  if (cfg.endpoint) conf.endpoint = cfg.endpoint;
  if (cfg.anonymous) {
    // Публичный бакет без ключей: подпись выключается кастомным signer-заглушкой.
    conf.credentials = { accessKeyId: '', secretAccessKey: '' };
    conf.signer = { sign: async (req) => req };
  } else {
    conf.credentials = {
      accessKeyId: cfg.accessKeyId || '',
      secretAccessKey: cfg.secret || '',
      ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
    };
  }
  return new S3Client(conf);
}

function humanErr(e) {
  const name = (e && (e.name || e.Code)) || '';
  const msg = String((e && e.message) || e || '');
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Хост не найден (DNS): ' + msg.slice(0, 140);
  if (/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return 'Нет соединения с хранилищем: ' + msg.slice(0, 140);
  if (name === 'ENOENT') return 'Локальный файл не найден: ' + msg.slice(0, 160);
  if (name === 'InvalidAccessKeyId') return 'Неверный Access Key ID';
  if (name === 'SignatureDoesNotMatch') return 'Неверный Secret Key (подпись не совпала)';
  if (name === 'ExpiredToken' || name === 'InvalidToken' || name === 'TokenRefreshRequired') return 'Временный токен истёк — обновите Session Token в подключении';
  if (name === 'AccessDenied' || name === 'AllAccessDisabled') return 'Доступ запрещён (нет прав на операцию)';
  if (name === 'NoSuchBucket') return 'Бакет не существует';
  if (name === 'NoSuchKey' || name === 'NotFound') return 'Объект не найден';
  if (name === 'InvalidObjectState') return 'Объект в архивном классе хранения (Glacier) — сначала восстановите его';
  if (name === 'EntityTooLarge') return 'Объект больше 5 ГБ — серверное копирование недоступно';
  if (name === 'TimeoutError' || name === 'RequestTimeout') return 'Таймаут запроса — хранилище не отвечает';
  if (name === 'RequestTimeTooSkewed') return 'Часы этого компьютера расходятся с хранилищем — проверьте системное время';
  if (name === 'PermanentRedirect') {
    const region = e && (e.$response && e.$response.headers && e.$response.headers['x-amz-bucket-region']);
    return 'Бакет в другом регионе' + (region ? ` (${region}) — укажите его в подключении` : ' — проверьте регион в подключении');
  }
  // AWS шлёт этот код и про регион, и про битые/пустые ключи — различаем по тексту
  if (name === 'AuthorizationHeaderMalformed') {
    if (/region/i.test(msg)) {
      const m = msg.match(/expecting\s+'([a-z0-9-]+)'/i);
      return 'Бакет в другом регионе' + (m ? ` (${m[1]}) — укажите его в подключении` : ' — проверьте регион в подключении');
    }
    return 'Некорректные ключи доступа — проверьте Access Key ID';
  }
  if (name === 'NotImplemented' || name === 'MethodNotAllowed') return 'Операция не поддерживается этим хранилищем';
  if (name === 'AbortError' || /aborted/i.test(msg)) return 'Операция отменена';
  if (!name || name === 'Error') return msg.slice(0, 200);   // свои броски — без префикса «Error: »
  return name + ': ' + msg.slice(0, 200);
}
// wrap идемпотентен (маркер __human): двойное оборачивание не даёт «Error: Error: …»
const wrap = (e) => { if (e && e.__human) return e; const err = new Error(humanErr(e)); err.__human = true; return err; };
const hErr = (msg) => { const err = new Error(msg); err.__human = true; return err; };
// ACL недоступны на этом хранилище? Решаем по КОДУ ошибки на месте вызова, а не строкой-сентинелом
// через humanErr — иначе NotImplemented любой другой операции маскировался бы под ACL-ответ.
const isAclUnsupported = (e) => ['AccessControlListNotSupported', 'NotImplemented', 'MethodNotAllowed'].includes((e && (e.name || e.Code)) || '');

// ключ → сегментное URL-кодирование (слэши сохраняются)
function encodeKey(key) { return String(key).split('/').map(encodeURIComponent).join('/'); }

// Публичный (неподписанный) URL объекта: кастомная база → endpoint path-style → AWS virtual-host.
function publicUrl(cfg, bucket, key) {
  const k = encodeKey(key);
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl.replace(/\/+$/, '') + '/' + k;
  if (cfg.endpoint) {
    const base = cfg.endpoint.replace(/\/+$/, '');
    if (cfg.forcePathStyle) return `${base}/${bucket}/${k}`;
    const u = new URL(base);
    return `${u.protocol}//${bucket}.${u.host}/${k}`;
  }
  return `https://${bucket}.s3.${cfg.region || 'us-east-1'}.amazonaws.com/${k}`;
}

// ---------------------------------------------------------------- операции
async function test(client, cfg) {
  try {
    if (cfg.defaultBucket) {
      // с ограниченными правами (или анонимно) ListBuckets часто запрещён — проверяем сам бакет
      const r = await client.send(new ListObjectsV2Command({ Bucket: cfg.defaultBucket, MaxKeys: 1 }));
      return { ok: true, info: `бакет «${cfg.defaultBucket}» доступен (${r.KeyCount || 0}+ объектов)` };
    }
    const r = await client.send(new ListBucketsCommand({}));
    const n = (r.Buckets || []).length;
    return { ok: true, info: n + ' ' + plural(n, 'бакет', 'бакета', 'бакетов') };
  } catch (e) { throw wrap(e); }
}
function plural(n, one, few, many) { const m = n % 100, d = n % 10; return (m > 10 && m < 20) ? many : d === 1 ? one : (d > 1 && d < 5) ? few : many; }

async function listBuckets(client) {
  try {
    const r = await client.send(new ListBucketsCommand({}));
    return (r.Buckets || []).map((b) => ({ name: b.Name, createdAt: b.CreationDate ? +b.CreationDate : null }));
  } catch (e) { throw wrap(e); }
}

async function ls(client, { bucket, prefix, token }) {
  try {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix || '', Delimiter: '/', MaxKeys: 1000,
      ...(token ? { ContinuationToken: token } : {}),
    }));
    const dirs = (r.CommonPrefixes || []).map((p) => ({
      prefix: p.Prefix, name: p.Prefix.slice((prefix || '').length).replace(/\/$/, '') || p.Prefix,
    }));
    const files = (r.Contents || [])
      .filter((o) => o.Key !== prefix) // сам «папочный» маркер (ключ == префиксу) в списке не показываем
      .map((o) => ({
        key: o.Key, name: o.Key.slice((prefix || '').length) || o.Key,
        size: o.Size || 0, mtime: o.LastModified ? +o.LastModified : null, storageClass: o.StorageClass || 'STANDARD',
      }));
    return { dirs, files, nextToken: r.IsTruncated ? r.NextContinuationToken : null };
  } catch (e) { throw wrap(e); }
}

// Полный рекурсивный листинг под префиксом (без делимитера) — для «Скачать папку».
// Папочные маркеры (ключ на «/») пропускаем — это не файлы. Жёсткий max — защита от гигантских префиксов.
async function listAll(client, { bucket, prefix, max }) {
  try {
    const out = [];
    let token = null;
    for (;;) {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || '', MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      for (const o of (r.Contents || [])) {
        if (o.Key.endsWith('/')) continue;
        out.push({ key: o.Key, size: o.Size || 0 });
        if (max && out.length > max) throw hErr(`Под префиксом больше ${max} файлов — скачивание папки ограничено`);
      }
      if (!r.IsTruncated) break;
      token = r.NextContinuationToken;
    }
    return out;
  } catch (e) { throw wrap(e); }
}

async function stat(client, { bucket, key }) {
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      size: r.ContentLength || 0, etag: (r.ETag || '').replace(/"/g, ''),
      mtime: r.LastModified ? +r.LastModified : null, contentType: r.ContentType || '',
      storageClass: r.StorageClass || 'STANDARD', metadata: r.Metadata || {},
    };
  } catch (e) { throw wrap(e); }
}

async function readRange(client, { bucket, key, start, end }) {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
    return Buffer.from(await r.Body.transformToByteArray());
  } catch (e) {
    // объект меньше запрошенного диапазона отдаёт InvalidRange только при start>0 — при start=0 S3 вернёт всё
    throw wrap(e);
  }
}

async function readObject(client, { bucket, key, maxBytes }) {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (maxBytes && r.ContentLength > maxBytes) { try { r.Body.destroy && r.Body.destroy(); } catch (_) {} throw new Error('Файл слишком большой'); }
    return Buffer.from(await r.Body.transformToByteArray());
  } catch (e) { throw wrap(e); }
}

async function presign(client, { bucket, key, ttl, method }) {
  try {
    const cmd = method === 'PUT' ? new PutObjectCommand({ Bucket: bucket, Key: key }) : new GetObjectCommand({ Bucket: bucket, Key: key });
    const seconds = Math.max(60, Math.min(7 * 24 * 3600, +ttl || 3600)); // SigV4: максимум 7 суток
    const url = await getSignedUrl(client, cmd, { expiresIn: seconds });
    return { url, expiresAt: Date.now() + seconds * 1000 };
  } catch (e) { throw wrap(e); }
}

const ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers';
async function aclGet(client, { bucket, key }) {
  try {
    const r = await client.send(new GetObjectAclCommand({ Bucket: bucket, Key: key }));
    const pub = (r.Grants || []).some((g) => g.Grantee && g.Grantee.URI === ALL_USERS && (g.Permission === 'READ' || g.Permission === 'FULL_CONTROL'));
    return { public: pub, supported: true };
  } catch (e) {
    if (isAclUnsupported(e)) return { public: false, supported: false };
    throw wrap(e);
  }
}
async function aclSet(client, { bucket, key, public: pub }) {
  try {
    await client.send(new PutObjectAclCommand({ Bucket: bucket, Key: key, ACL: pub ? 'public-read' : 'private' }));
    return { public: !!pub, supported: true };
  } catch (e) {
    if (isAclUnsupported(e)) {
      const err = hErr('На этом хранилище ACL объектов отключены — публичность задаётся политикой бакета');
      err.aclUnsupported = true;
      throw err;
    }
    throw wrap(e);
  }
}

// ---------------------------------------------------------------- передачи (с прогрессом и отменой)
const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
function mimeOf(name) { return MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream'; }

// upload: multipart через lib-storage (файлы >5 МБ бьются на части сами). Возвращает {abort, done}.
function upload(client, { bucket, key, filePath, onProgress }) {
  let size;
  try { size = fs.statSync(filePath).size; } catch (e) { throw wrap(e); }
  const up = new Upload({
    client,
    // ContentLength известен из stat — без него SDK ворчит на стрим неизвестной длины
    params: { Bucket: bucket, Key: key, Body: fs.createReadStream(filePath), ContentType: mimeOf(key), ContentLength: size },
    queueSize: 3, partSize: 8 * 1024 * 1024, leavePartsOnError: false,
  });
  up.on('httpUploadProgress', (p) => { if (onProgress) onProgress(p.loaded || 0, p.total || size); });
  const done = up.done().then(() => ({ ok: true })).catch((e) => { throw wrap(e); });
  return { abort: () => up.abort().catch(() => {}), done };
}

// download: GetObject → стрим на диск (не в память), прогресс по чанкам. Возвращает {abort, done}.
function download(client, { bucket, key, destPath, onProgress }) {
  const ctl = new AbortController();
  const done = (async () => {
    let r, out;
    try {
      r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: ctl.signal });
      const total = r.ContentLength || 0;
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      // отмена могла прийти между send и подпиской на abort — addEventListener на уже-abort-нутый
      // сигнал ретроактивно не сработает, и файл молча докачался бы целиком
      if (ctl.signal.aborted) { try { r.Body.destroy(); } catch (_) {} throw hErr('Операция отменена'); }
      out = fs.createWriteStream(destPath);
      let loaded = 0;
      await new Promise((resolve, reject) => {
        r.Body.on('data', (chunk) => { loaded += chunk.length; if (onProgress) onProgress(loaded, total); });
        r.Body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        ctl.signal.addEventListener('abort', () => { try { r.Body.destroy(new Error('aborted')); } catch (_) {} });
        r.Body.pipe(out);
      });
      return { ok: true };
    } catch (e) {
      try { if (out) out.destroy(); fs.unlinkSync(destPath); } catch (_) {} // недокачанный файл не оставляем
      throw wrap(e);
    }
  })();
  return { abort: () => ctl.abort(), done };
}

const COPY_LIMIT = 5 * 1024 * 1024 * 1024; // CopyObject у S3 ограничен 5 ГБ (multipart-copy не реализован)
async function copy(client, { bucket, from, to }) {
  try {
    const meta = await stat(client, { bucket, key: from });
    if (meta.size > COPY_LIMIT) throw hErr('Объект больше 5 ГБ — серверное копирование/переименование недоступно');
    await client.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: encodeURIComponent(bucket) + '/' + encodeKey(from) }));
    return { ok: true };
  } catch (e) { throw wrap(e); }
}

async function remove(client, { bucket, keys }) {
  try {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 1) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: batch[0] })); deleted += 1; continue; }
      const r = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((k) => ({ Key: k })), Quiet: true } }));
      deleted += batch.length - ((r.Errors || []).length);
      if (r.Errors && r.Errors.length) throw hErr(`Удалено ${deleted}, ошибка на «${r.Errors[0].Key}»: ${r.Errors[0].Message}`);
    }
    return { deleted };
  } catch (e) { throw wrap(e); }
}

// Удалить всё под префиксом («папку»). Защитный лимит проверяется ДО удаления (второй проход):
// сначала считаем объекты листингом, и если их больше лимита — отказ БЕЗ единого удаления
// (раньше лимит срабатывал постфактум и «защита» успевала снести ~20k объектов).
const REMOVE_PREFIX_LIMIT = 20000;
async function removePrefix(client, { bucket, prefix }) {
  try {
    let token = null, count = 0;
    for (;;) {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      count += (r.Contents || []).length;
      if (count > REMOVE_PREFIX_LIMIT) throw hErr(`Под префиксом больше ${REMOVE_PREFIX_LIMIT} объектов — удаление из редактора ограничено (ничего не удалено)`);
      if (!r.IsTruncated) break;
      token = r.NextContinuationToken;
    }
    // удаляем «первую страницу оставшегося» до пустоты: токен после удаления страницы указывает
    // в уже изменившийся листинг, полагаться на него нельзя
    let deleted = 0;
    for (;;) {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }));
      const keys = (r.Contents || []).map((o) => o.Key);
      if (!keys.length) break;
      deleted += (await remove(client, { bucket, keys })).deleted;
      if (!r.IsTruncated) break;
    }
    return { deleted };
  } catch (e) { throw wrap(e); }
}

async function mkdir(client, { bucket, prefix }) {
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix.endsWith('/') ? prefix : prefix + '/', Body: '' }));
    return { ok: true };
  } catch (e) { throw wrap(e); }
}

// Что умеет ЭТОТ адаптер — UI прячет недоступные действия (у будущего WebDAV не будет presign/ACL).
const caps = { buckets: true, presign: true, acl: true, publicUrl: true };

module.exports = {
  makeClient, humanErr, publicUrl, encodeKey, mimeOf, caps,
  test, listBuckets, ls, listAll, stat, readRange, readObject, presign, aclGet, aclSet,
  upload, download, copy, remove, removePrefix, mkdir,
};
