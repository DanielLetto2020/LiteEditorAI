// MCP-пак для модуля «Внешние хранилища» (S3 / MinIO, 6 read-only инструментов; без presign и записи).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { isSensitivePath, redactText, redactValue, sanitizeText } = require('../redact');

function clamp(n, lo, hi, d) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}

function findStorageMeta(st, id) {
  if (!st || !id) return null;
  const c = st.findConn(String(id));
  if (!c) return null;
  return {
    id: c.id,
    name: c.name || c.endpoint || c.id,
    endpoint: c.endpoint || '',
    bucket: c.bucket || '',
    isProd: /prod/i.test(c.name || ''),
  };
}

function publicStorageInfo(c) {
  return {
    id: c.id,
    name: c.name || '',
    adapter: c.adapter || 's3',
    endpoint: c.endpoint || '',
    region: c.region || '',
    bucket: c.bucket || '',
    scope: c.scope || 'global',
    readOnly: !!c.readOnly,
  };
}

function requireStorage(deps, id) {
  const st = deps.getStorageApi();
  if (!st) throw new Error('Модуль «Внешние хранилища» недоступен');
  const meta = findStorageMeta(st, id);
  if (!meta) throw new Error(`Подключение хранилища «${id}» не найдено`);
  return { st, meta };
}

function createStoragePack() {
  return defineMcpPack({
    id: 'storage',
    name: 'Хранилища (S3)',
    description: 'Бакеты, просмотр префиксов, метаданные и безопасное чтение текстовых объектов (read-only).',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const st = deps.getStorageApi();
      const list = st ? st.listMeta() : [];
      return list.map((c) => ({
        type: 'storage',
        id: c.id,
        name: c.name || c.endpoint || c.id,
        subtitle: [c.endpoint, c.bucket].filter(Boolean).join(' · '),
        isProd: /prod/i.test(c.name || ''),
      }));
    },
    tools: [
      {
        name: 'st_list_connections',
        title: 'Список подключений хранилищ',
        description: 'Показать S3/MinIO подключения, разрешённые для текущего проекта.',
        mode: 'read',
        resourceType: 'storage',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'storage', id: null, discovery: true }),
        async handler(_args, ctx) {
          const st = ctx.deps.getStorageApi();
          const all = st ? st.listMeta() : [];
          const connections = [];
          let unboundCount = 0;
          for (const c of all) {
            if (isResourceBound(ctx.binding, 'storage', c.id, c)) connections.push(publicStorageInfo(c));
            else unboundCount++;
          }
          return { ok: true, connections, unboundCount };
        },
      },
      {
        name: 'st_buckets',
        title: 'Список бакетов',
        description: 'Список доступных бакетов в подключении.',
        mode: 'read',
        resourceType: 'storage',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const st = deps.getStorageApi();
          return { type: 'storage', id: args.connectionId, meta: findStorageMeta(st, args.connectionId) };
        },
        async handler(args, ctx) {
          const { st } = requireStorage(ctx.deps, args.connectionId);
          return { ok: true, ...(redactValue(await st.buckets(String(args.connectionId)))) };
        },
      },
      {
        name: 'st_ls',
        title: 'Листинг объектов бакета',
        description: 'Список папок (префиксов) и объектов по указанному prefix.',
        mode: 'read',
        resourceType: 'storage',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            bucket: { type: 'string' },
            prefix: { type: 'string' },
            token: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: 200 },
          },
          required: ['connectionId', 'bucket'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const st = deps.getStorageApi();
          return { type: 'storage', id: args.connectionId, meta: findStorageMeta(st, args.connectionId) };
        },
        async handler(args, ctx) {
          const { st } = requireStorage(ctx.deps, args.connectionId);
          const data = await st.ls(String(args.connectionId), {
            bucket: String(args.bucket),
            prefix: args.prefix ? String(args.prefix) : '',
            token: args.token ? String(args.token) : undefined,
          });
          const limit = clamp(args.limit, 1, 200, 100);
          const objects = Array.isArray(data && data.objects) ? data.objects : [];
          const prefixes = Array.isArray(data && data.prefixes) ? data.prefixes : [];
          return {
            ok: true,
            prefixes: prefixes.slice(0, limit),
            objects: redactValue(objects.slice(0, limit)),
            nextToken: data && data.nextToken ? data.nextToken : null,
            truncated: objects.length > limit || prefixes.length > limit || !!(data && data.nextToken),
          };
        },
      },
      {
        name: 'st_stat',
        title: 'Метаданные объекта',
        description: 'Размер, ETag, contentType и дата изменения объекта (HEAD).',
        mode: 'read',
        resourceType: 'storage',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            bucket: { type: 'string' },
            key: { type: 'string' },
          },
          required: ['connectionId', 'bucket', 'key'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const st = deps.getStorageApi();
          return { type: 'storage', id: args.connectionId, meta: findStorageMeta(st, args.connectionId) };
        },
        async handler(args, ctx) {
          const { st } = requireStorage(ctx.deps, args.connectionId);
          const meta = await st.stat(String(args.connectionId), {
            bucket: String(args.bucket),
            key: String(args.key),
          });
          return { ok: true, meta: redactValue(meta) };
        },
      },
      {
        name: 'st_read_text',
        title: 'Чтение текстового объекта',
        description: 'Прочитать первые N байт (до 128 КБ) текстового объекта; бинарные файлы и секретные ключи (.env, .pem, .key) отклоняются.',
        mode: 'read',
        resourceType: 'storage',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            bucket: { type: 'string' },
            key: { type: 'string' },
            maxBytes: { type: 'number', minimum: 256, maximum: 131072 },
          },
          required: ['connectionId', 'bucket', 'key'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const st = deps.getStorageApi();
          return { type: 'storage', id: args.connectionId, meta: findStorageMeta(st, args.connectionId) };
        },
        async handler(args, ctx) {
          const key = String(args.key);
          const sens = isSensitivePath(key);
          if (sens && sens.blocked) {
            throw new Error(`Доступ к чувствительному объекту «${key}» заблокирован: ${sens.reason || 'политика безопасности'}`);
          }
          const { st } = requireStorage(ctx.deps, args.connectionId);
          const maxBytes = clamp(args.maxBytes, 256, 131072, 65536);
          const res = await st.readText(String(args.connectionId), {
            bucket: String(args.bucket),
            key,
            maxBytes,
          });
          if (res.kind !== 'text') {
            return { ok: true, kind: res.kind, size: res.size, meta: redactValue(res.meta), note: 'Бинарный объект не возвращается в текстовом виде' };
          }
          return {
            ok: true,
            kind: 'text',
            size: res.size,
            truncated: !!res.truncated,
            meta: redactValue(res.meta),
            content: sanitizeText(redactText(res.content || ''), maxBytes),
          };
        },
      },
      {
        name: 'st_acl_get',
        title: 'Права доступа (ACL) объекта',
        description: 'Проверить публичность и grants объекта.',
        mode: 'read',
        resourceType: 'storage',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            bucket: { type: 'string' },
            key: { type: 'string' },
          },
          required: ['connectionId', 'bucket', 'key'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const st = deps.getStorageApi();
          return { type: 'storage', id: args.connectionId, meta: findStorageMeta(st, args.connectionId) };
        },
        async handler(args, ctx) {
          const { st } = requireStorage(ctx.deps, args.connectionId);
          const acl = await st.aclGet(String(args.connectionId), {
            bucket: String(args.bucket),
            key: String(args.key),
          });
          return { ok: true, acl: redactValue(acl) };
        },
      },
    ],
  });
}

module.exports = { createStoragePack };
