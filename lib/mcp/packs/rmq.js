// MCP-пак для модуля «RabbitMQ» (7 read-only инструментов; без publish, purge, delete, kill).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { redactText, redactValue, sanitizeText } = require('../redact');

function clamp(n, lo, hi, d) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}

function findRmqMeta(rmq, id) {
  if (!rmq || !id) return null;
  const c = rmq.findConn(String(id));
  if (!c) return null;
  return {
    id: c.id,
    name: c.name || c.host || c.id,
    host: c.host || '',
    port: c.port || 15672,
    vhost: c.vhost || '/',
    isProd: /prod/i.test(c.name || ''),
  };
}

function publicRmqInfo(c) {
  return {
    id: c.id,
    name: c.name || '',
    host: c.host || '',
    port: c.port || 15672,
    protocol: c.protocol || 'http',
    vhost: c.vhost || '/',
    user: c.user || '',
  };
}

function requireRmq(deps, id) {
  const rmq = deps.getRmqApi();
  if (!rmq) throw new Error('Модуль «RabbitMQ» недоступен');
  const meta = findRmqMeta(rmq, id);
  if (!meta) throw new Error(`Подключение RabbitMQ «${id}» не найдено`);
  return { rmq, meta };
}

function createRmqPack() {
  return defineMcpPack({
    id: 'rmq',
    name: 'RabbitMQ',
    description: 'Overview узла, виртуальные хосты, очереди, обменники, подключения и безопасный peek сообщений (read-only).',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const rmq = deps.getRmqApi();
      const list = rmq ? rmq.list() : [];
      return list.map((c) => ({
        type: 'rmq',
        id: c.id,
        name: c.name || c.host || c.id,
        subtitle: [c.host ? `${c.host}:${c.port || 15672}` : '', c.vhost].filter(Boolean).join(' · '),
        isProd: /prod/i.test(c.name || ''),
      }));
    },
    tools: [
      {
        name: 'rmq_list_connections',
        title: 'Список подключений RabbitMQ',
        description: 'Показать подключения RabbitMQ, разрешённые для текущего проекта.',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'rmq', id: null, discovery: true }),
        async handler(_args, ctx) {
          const rmq = ctx.deps.getRmqApi();
          const all = rmq ? rmq.list() : [];
          const connections = [];
          let unboundCount = 0;
          for (const c of all) {
            if (isResourceBound(ctx.binding, 'rmq', c.id, c)) connections.push(publicRmqInfo(c));
            else unboundCount++;
          }
          return { ok: true, connections, unboundCount };
        },
      },
      {
        name: 'rmq_overview',
        title: 'Обзор узла RabbitMQ',
        description: 'Версия брокера, счётчики очередей, сообщений, каналов и нод.',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const rmq = deps.getRmqApi();
          return { type: 'rmq', id: args.connectionId, meta: findRmqMeta(rmq, args.connectionId) };
        },
        async handler(args, ctx) {
          const { rmq } = requireRmq(ctx.deps, args.connectionId);
          return { ok: true, ...(redactValue(await rmq.overview(String(args.connectionId)))) };
        },
      },
      {
        name: 'rmq_vhosts',
        title: 'Virtual hosts RabbitMQ',
        description: 'Список виртуальных хостов и их статистик.',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const rmq = deps.getRmqApi();
          return { type: 'rmq', id: args.connectionId, meta: findRmqMeta(rmq, args.connectionId) };
        },
        async handler(args, ctx) {
          const { rmq } = requireRmq(ctx.deps, args.connectionId);
          const data = await rmq.vhosts(String(args.connectionId));
          return { ok: true, vhosts: redactValue(data && data.vhosts ? data.vhosts : []) };
        },
      },
      {
        name: 'rmq_queues',
        title: 'Очереди RabbitMQ',
        description: 'Список очередей (с фильтрацией по vhost/поиску, ограничение до 200).',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            vhost: { type: 'string' },
            search: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: 200 },
          },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const rmq = deps.getRmqApi();
          return { type: 'rmq', id: args.connectionId, meta: findRmqMeta(rmq, args.connectionId) };
        },
        async handler(args, ctx) {
          const { rmq } = requireRmq(ctx.deps, args.connectionId);
          const data = await rmq.queues(String(args.connectionId), {
            vhost: args.vhost ? String(args.vhost) : '',
            search: args.search ? String(args.search) : '',
          });
          const limit = clamp(args.limit, 1, 200, 100);
          let list = Array.isArray(data && (data.items || data.queues)) ? (data.items || data.queues) : [];
          if (args.search) {
            const q = String(args.search).toLowerCase();
            list = list.filter((it) => String((it && it.name) || '').toLowerCase().includes(q));
          }
          return {
            ok: true,
            queues: redactValue(list.slice(0, limit)),
            total: list.length,
            truncated: list.length > limit,
          };
        },
      },
      {
        name: 'rmq_exchanges',
        title: 'Обменники RabbitMQ',
        description: 'Список exchanges выбранного vhost.',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            vhost: { type: 'string' },
            search: { type: 'string' },
          },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const rmq = deps.getRmqApi();
          return { type: 'rmq', id: args.connectionId, meta: findRmqMeta(rmq, args.connectionId) };
        },
        async handler(args, ctx) {
          const { rmq } = requireRmq(ctx.deps, args.connectionId);
          const data = await rmq.exchanges(String(args.connectionId), {
            vhost: args.vhost ? String(args.vhost) : '',
            search: args.search ? String(args.search) : '',
          });
          let list = Array.isArray(data && (data.items || data.exchanges)) ? (data.items || data.exchanges) : [];
          if (args.search) {
            const q = String(args.search).toLowerCase();
            list = list.filter((it) => String((it && it.name) || '').toLowerCase().includes(q));
          }
          return { ok: true, exchanges: redactValue(list.slice(0, 200)), truncated: list.length > 200 };
        },
      },
      {
        name: 'rmq_connections',
        title: 'Активные клиенты RabbitMQ',
        description: 'Список активных клиентских соединений (без учётных данных).',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const rmq = deps.getRmqApi();
          return { type: 'rmq', id: args.connectionId, meta: findRmqMeta(rmq, args.connectionId) };
        },
        async handler(args, ctx) {
          const { rmq } = requireRmq(ctx.deps, args.connectionId);
          const data = await rmq.connections(String(args.connectionId));
          const list = Array.isArray(data && (data.items || data.connections)) ? (data.items || data.connections) : [];
          return { ok: true, connections: redactValue(list.slice(0, 200)), truncated: list.length > 200 };
        },
      },
      {
        name: 'rmq_peek',
        title: 'Чтение сообщений из очереди RabbitMQ',
        description: 'Неразрушающий peek сообщений (ack_requeue_true, без удаления из очереди). До 20 сообщений.',
        mode: 'read',
        resourceType: 'rmq',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            vhost: { type: 'string' },
            queue: { type: 'string' },
            count: { type: 'number', minimum: 1, maximum: 20 },
          },
          required: ['connectionId', 'queue'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const rmq = deps.getRmqApi();
          return { type: 'rmq', id: args.connectionId, meta: findRmqMeta(rmq, args.connectionId) };
        },
        async handler(args, ctx) {
          const { rmq } = requireRmq(ctx.deps, args.connectionId);
          const count = clamp(args.count, 1, 20, 5);
          const data = await rmq.peek(String(args.connectionId), {
            vhost: args.vhost ? String(args.vhost) : '',
            queue: String(args.queue),
            count,
            truncate: 16384,
          });
          const rawMsgs = Array.isArray(data && (data.items || data.messages)) ? (data.items || data.messages) : [];
          const messages = rawMsgs.map((m) => ({
            ...redactValue(m),
            payload: typeof m.payload === 'string' ? sanitizeText(redactText(m.payload), 8192) : m.payload,
          }));
          return { ok: true, messages };
        },
      },
    ],
  });
}

module.exports = { createRmqPack };
