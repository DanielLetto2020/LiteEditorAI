// MCP-пак для модуля «Kafka» (7 read-only инструментов; без produce, create, delete, resetOffsets).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { redactText, redactValue, sanitizeText } = require('../redact');

function clamp(n, lo, hi, d) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}

function findKafkaMeta(kafka, id) {
  if (!kafka || !id) return null;
  const c = kafka.findConn(String(id));
  if (!c) return null;
  return {
    id: c.id,
    name: c.name || c.brokers || c.id,
    brokers: c.brokers || '',
    isProd: /prod/i.test(c.name || ''),
  };
}

function publicKafkaInfo(c) {
  return {
    id: c.id,
    name: c.name || '',
    brokers: c.brokers || '',
    ssl: !!c.ssl,
    saslMechanism: c.saslMechanism || '',
  };
}

function requireKafka(deps, id) {
  const kafka = deps.getKafkaApi();
  if (!kafka) throw new Error('Модуль «Kafka» недоступен');
  const meta = findKafkaMeta(kafka, id);
  if (!meta) throw new Error(`Подключение Kafka «${id}» не найдено`);
  return { kafka, meta };
}

function createKafkaPack() {
  return defineMcpPack({
    id: 'kafka',
    name: 'Kafka',
    description: 'Метаданные кластера, топики, партиции, consumer groups, lag и безопасный peek сообщений (read-only).',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const kafka = deps.getKafkaApi();
      const list = kafka ? kafka.list() : [];
      return list.map((c) => ({
        type: 'kafka',
        id: c.id,
        name: c.name || c.brokers || c.id,
        subtitle: c.brokers || '',
        isProd: /prod/i.test(c.name || ''),
      }));
    },
    tools: [
      {
        name: 'kafka_list_connections',
        title: 'Список подключений Kafka',
        description: 'Показать кластеры Kafka, разрешённые для текущего проекта.',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'kafka', id: null, discovery: true }),
        async handler(_args, ctx) {
          const kafka = ctx.deps.getKafkaApi();
          const all = kafka ? kafka.list() : [];
          const connections = [];
          let unboundCount = 0;
          for (const c of all) {
            if (isResourceBound(ctx.binding, 'kafka', c.id, c)) connections.push(publicKafkaInfo(c));
            else unboundCount++;
          }
          return { ok: true, connections, unboundCount };
        },
      },
      {
        name: 'kafka_overview',
        title: 'Обзор кластера Kafka',
        description: 'Брокеры, controllerId и сводные счётчики кластера.',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const kafka = deps.getKafkaApi();
          return { type: 'kafka', id: args.connectionId, meta: findKafkaMeta(kafka, args.connectionId) };
        },
        async handler(args, ctx) {
          const { kafka } = requireKafka(ctx.deps, args.connectionId);
          return { ok: true, ...(redactValue(await kafka.overview(String(args.connectionId)))) };
        },
      },
      {
        name: 'kafka_topics',
        title: 'Топики Kafka',
        description: 'Список топиков кластера с количеством партиций и внутренним флагом.',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            includeInternal: { type: 'boolean' },
            limit: { type: 'number', minimum: 1, maximum: 500 },
          },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const kafka = deps.getKafkaApi();
          return { type: 'kafka', id: args.connectionId, meta: findKafkaMeta(kafka, args.connectionId) };
        },
        async handler(args, ctx) {
          const { kafka } = requireKafka(ctx.deps, args.connectionId);
          const data = await kafka.topics(String(args.connectionId), { internal: !!args.includeInternal });
          const limit = clamp(args.limit, 1, 500, 200);
          let list = Array.isArray(data && (data.items || data.topics)) ? (data.items || data.topics) : [];
          if (!args.includeInternal) list = list.filter((t) => !(t && t.internal));
          return { ok: true, topics: redactValue(list.slice(0, limit)), total: list.length, truncated: list.length > limit };
        },
      },
      {
        name: 'kafka_topic_detail',
        title: 'Детали топика Kafka',
        description: 'Партиции, лидеры, реплики, офсеты и конфигурация топика.',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            topic: { type: 'string' },
          },
          required: ['connectionId', 'topic'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const kafka = deps.getKafkaApi();
          return { type: 'kafka', id: args.connectionId, meta: findKafkaMeta(kafka, args.connectionId) };
        },
        async handler(args, ctx) {
          const { kafka } = requireKafka(ctx.deps, args.connectionId);
          const data = await kafka.topicDetail(String(args.connectionId), { topic: String(args.topic) });
          return { ok: true, ...(redactValue(data)) };
        },
      },
      {
        name: 'kafka_groups',
        title: 'Consumer groups Kafka',
        description: 'Список групп потребителей.',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string' } },
          required: ['connectionId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const kafka = deps.getKafkaApi();
          return { type: 'kafka', id: args.connectionId, meta: findKafkaMeta(kafka, args.connectionId) };
        },
        async handler(args, ctx) {
          const { kafka } = requireKafka(ctx.deps, args.connectionId);
          const data = await kafka.groups(String(args.connectionId));
          const list = Array.isArray(data && (data.items || data.groups)) ? (data.items || data.groups) : [];
          return { ok: true, groups: redactValue(list.slice(0, 300)), truncated: list.length > 300 };
        },
      },
      {
        name: 'kafka_group_detail',
        title: 'Детали consumer group Kafka',
        description: 'Состояние группы, участники, коммиты и lag по партициям.',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            groupId: { type: 'string' },
          },
          required: ['connectionId', 'groupId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const kafka = deps.getKafkaApi();
          return { type: 'kafka', id: args.connectionId, meta: findKafkaMeta(kafka, args.connectionId) };
        },
        async handler(args, ctx) {
          const { kafka } = requireKafka(ctx.deps, args.connectionId);
          const data = await kafka.groupDetail(String(args.connectionId), { groupId: String(args.groupId) });
          return { ok: true, ...(redactValue(data)) };
        },
      },
      {
        name: 'kafka_peek',
        title: 'Чтение сообщений из топика Kafka',
        description: 'Прочитать последние сообщения топика/партиции без фиксации офсетов (read-only, до 20 штук).',
        mode: 'read',
        resourceType: 'kafka',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            topic: { type: 'string' },
            partition: { type: 'number' },
            limit: { type: 'number', minimum: 1, maximum: 20 },
            fromBeginning: { type: 'boolean' },
          },
          required: ['connectionId', 'topic'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const kafka = deps.getKafkaApi();
          return { type: 'kafka', id: args.connectionId, meta: findKafkaMeta(kafka, args.connectionId) };
        },
        async handler(args, ctx) {
          const { kafka } = requireKafka(ctx.deps, args.connectionId);
          const limit = clamp(args.limit, 1, 20, 5);
          const data = await kafka.peek(String(args.connectionId), {
            topic: String(args.topic),
            count: limit,
            from: args.fromBeginning ? 'begin' : 'end',
          });
          const rawMsgs = Array.isArray(data && (data.items || data.messages)) ? (data.items || data.messages) : [];
          const messages = rawMsgs.map((m) => ({
            ...redactValue(m),
            value: typeof m.value === 'string' ? sanitizeText(redactText(m.value), 8192) : m.value,
          }));
          return { ok: true, messages };
        },
      },
    ],
  });
}

module.exports = { createKafkaPack };
