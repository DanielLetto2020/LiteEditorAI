// MCP-пак для модуля «Базы данных» (9 read-only инструментов).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { redactValue, sanitizeText } = require('../redact');
const { stripSqlLiterals } = require('../../sqlro');

/** @param {any} db @param {any} connId */
function findDbMeta(db, connId) {
  if (!db || !connId) return null;
  const c = db.findConn(String(connId));
  if (!c) return null;
  return {
    id: c.id,
    name: c.name || c.database || c.host || c.id,
    type: c.type,
    isProd: !!c.isProd,
    noCloud: !!c.noCloud,
    readOnly: !!c.readOnly,
  };
}

/** @param {any} c */
function publicConnInfo(c) {
  return {
    id: c.id,
    name: c.name || '',
    type: c.type,
    host: c.host || '',
    port: c.port || null,
    database: c.database || '',
    isProd: !!c.isProd,
    noCloud: !!c.noCloud,
    readOnly: !!c.readOnly,
    sshEnabled: !!c.sshEnabled,
  };
}

/** @param {any} deps @param {string} id */
function requireDb(deps, id) {
  const db = deps.getDbApi();
  if (!db) throw new Error('Модуль «Базы данных» недоступен');
  const meta = findDbMeta(db, id);
  if (!meta) throw new Error(`Подключение БД «${id}» не найдено`);
  return { db, meta };
}

function createDbPack() {
  return defineMcpPack({
    id: 'db',
    name: 'Базы данных',
    description: 'Схемы, таблицы, связи, DDL и безопасные read-only SELECT-запросы к PostgreSQL, MySQL и SQLite.',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const db = deps.getDbApi();
      const list = db ? db.list() : [];
      return list.map((c) => ({
        type: 'db',
        id: c.id,
        name: c.name || c.database || c.host || c.id,
        subtitle: [c.type, c.host, c.database].filter(Boolean).join(' · '),
        isProd: !!c.isProd,
        noCloud: !!c.noCloud,
        readOnly: !!c.readOnly,
      }));
    },
    tools: [
      {
        name: 'db_list_connections',
        title: 'Список подключений БД',
        description: 'Показать подключения к БД, разрешённые политикой текущего проекта (с учётом пресетов и привязок).',
        mode: 'read',
        resourceType: 'db',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'db', id: null, discovery: true }),
        async handler(_args, ctx) {
          const db = ctx.deps.getDbApi();
          const all = db ? db.list() : [];
          const allowed = [];
          let unboundCount = 0;
          for (const c of all) {
            if (isResourceBound(ctx.binding, 'db', c.id, c)) allowed.push(publicConnInfo(c));
            else unboundCount++;
          }
          return {
            ok: true,
            preset: ctx.binding.preset,
            connections: allowed,
            unboundCount,
          };
        },
      },
      {
        name: 'db_ping',
        title: 'Проверка доступности БД',
        description: 'Проверить соединение с выбранной БД.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId'],
          properties: { connectionId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const meta = findDbMeta(deps.getDbApi(), args.connectionId);
          return { type: 'db', id: args.connectionId, meta };
        },
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          return await db.ping(args.connectionId);
        },
      },
      {
        name: 'db_schema',
        title: 'Схема и таблицы БД',
        description: 'Получить список схем, таблиц и представлений в БД.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId'],
          properties: { connectionId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          return await db.schema(args.connectionId);
        },
      },
      {
        name: 'db_table_meta',
        title: 'Метаданные таблицы',
        description: 'Колонки, типы данных, PK/FK, индексы и DDL указанной таблицы.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId', 'table'],
          properties: {
            connectionId: { type: 'string', minLength: 1, maxLength: 80 },
            schema: { type: 'string', maxLength: 128 },
            table: { type: 'string', minLength: 1, maxLength: 128 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          return await db.tableMeta(args.connectionId, args.schema || '', args.table);
        },
      },
      {
        name: 'db_relations',
        title: 'Внешние ключи (ER)',
        description: 'Получить все связи FOREIGN KEY между таблицами БД.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId'],
          properties: { connectionId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          return await db.relations(args.connectionId);
        },
      },
      {
        name: 'db_objects',
        title: 'Функции, процедуры, последовательности',
        description: 'Список функций, хранимых процедур, sequences и оценок числа строк.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId'],
          properties: { connectionId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          return await db.objects(args.connectionId);
        },
      },
      {
        name: 'db_object_ddl',
        title: 'DDL объекта БД',
        description: 'Получить исходный DDL функции, процедуры или последовательности.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId', 'name', 'kind'],
          properties: {
            connectionId: { type: 'string', minLength: 1, maxLength: 80 },
            schema: { type: 'string', maxLength: 128 },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            kind: { type: 'string', enum: ['function', 'procedure', 'sequence'] },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          const r = await db.objectDdl(args.connectionId, args.schema || '', args.name, args.kind);
          return { ok: true, ddl: sanitizeText(r && r.ddl ? r.ddl : '', 32768) };
        },
      },
      {
        name: 'db_object_info',
        title: 'Размер таблицы и оценка строк',
        description: 'Размер таблицы на диске (data + indexes) и ориентировочное количество строк.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId', 'table'],
          properties: {
            connectionId: { type: 'string', minLength: 1, maxLength: 80 },
            schema: { type: 'string', maxLength: 128 },
            table: { type: 'string', minLength: 1, maxLength: 128 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db } = requireDb(ctx.deps, args.connectionId);
          return await db.objectInfo(args.connectionId, args.schema || '', args.table);
        },
      },
      {
        name: 'db_query',
        title: 'Read-only SQL-запрос',
        description: 'Выполнить один read-only SQL-запрос (SELECT / WITH / EXPLAIN / SHOW). В prod требует явный LIMIT.',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId', 'sql'],
          properties: {
            connectionId: { type: 'string', minLength: 1, maxLength: 80 },
            sql: { type: 'string', minLength: 1, maxLength: 16384 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            timeoutMs: { type: 'integer', minimum: 500, maximum: 30000 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'db', id: args.connectionId, meta: findDbMeta(deps.getDbApi(), args.connectionId) }),
        async handler(args, ctx) {
          const { db, meta } = requireDb(ctx.deps, args.connectionId);
          ctx.setAuditMeta({ sql: args.sql });
          if (ctx.constraints && ctx.constraints.noCloudBlockRows) {
            return {
              ok: false,
              error: 'Для этой БД включён флаг noCloud («не отправлять строки в облачные модели»). Используйте db_schema / db_table_meta / db_relations или локальную модель.',
            };
          }
          const maxRows = Math.min(Number(args.limit) || 200, (ctx.constraints && ctx.constraints.maxLimit) || 200);
          const timeoutMs = Math.min(Number(args.timeoutMs) || 15000, (ctx.constraints && ctx.constraints.maxTimeoutMs) || 30000);
          if (meta.isProd && /^\s*(?:SELECT|WITH)\b/i.test(args.sql)) {
            const stripped = stripSqlLiterals(args.sql, meta.type);
            if (!/\bLIMIT\s+\d+/i.test(stripped)) {
              return { ok: false, error: `Для prod-БД обязательно укажите LIMIT (максимум ${maxRows})` };
            }
          }
          const res = await db.queryRo(args.connectionId, args.sql, { timeoutMs });
          if (res && res.error) return { ok: false, error: res.error };
          const allRows = Array.isArray(res && res.rows) ? res.rows : [];
          const clipped = allRows.length > maxRows;
          const rows = allRows.slice(0, maxRows);
          return redactValue({
            ok: true,
            columns: (res && res.columns) || [],
            rows,
            rowCount: rows.length,
            clipped,
            truncated: !!(res && res.truncated) || clipped,
          }, { maxStringBytes: 8192 });
        },
      },
    ],
  });
}

module.exports = { createDbPack };
