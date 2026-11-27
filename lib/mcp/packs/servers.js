// MCP-пак для модулей «Серверы» и «Удалённые хосты» (11 read-only инструментов; без exec и sudo).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { isSensitivePath, redactText, redactValue, sanitizeText } = require('../redact');

function findServerMeta(serversApi, id) {
  if (!serversApi || !id) return null;
  const s = serversApi.get(String(id));
  if (!s) return null;
  const tags = Array.isArray(s.tags) ? s.tags : [];
  const isProd = /prod/i.test(s.group || '') || tags.some((t) => /prod/i.test(String(t)));
  return { id: s.id, name: s.name, rhId: s.rhId, isProd };
}

function findRhMeta(rhApi, id) {
  if (!rhApi || !id) return null;
  const c = rhApi.findConn(String(id));
  if (!c) return null;
  return { id: c.id, name: c.name || c.host || c.id, type: c.type || 'ssh', isProd: /prod/i.test(c.name || '') };
}

function clamp(n, lo, hi, d) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}

function createServersPack() {
  return defineMcpPack({
    id: 'servers',
    name: 'Серверы и SSH',
    description: 'Метрики серверов, systemd-юниты, journalctl, занятость диска, логи compose-проектов и read-only SFTP-чтение.',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const out = [];
      const srvApi = deps.serversApi;
      const rhApi = deps.rhApi;
      if (srvApi) {
        for (const s of srvApi.getAll()) {
          const isProd = /prod/i.test(s.group || '') || (Array.isArray(s.tags) && s.tags.some((t) => /prod/i.test(String(t))));
          out.push({
            type: 'server',
            id: s.id,
            name: s.name || s.id,
            subtitle: s.host ? `${s.host.host}:${s.host.port || 22}` : s.state,
            state: s.state,
            isProd,
          });
        }
      }
      if (rhApi && typeof rhApi.list === 'function') {
        for (const r of rhApi.list()) {
          out.push({
            type: 'rh',
            id: r.id,
            name: r.name || r.host || r.id,
            subtitle: `${r.type || 'ssh'} · ${(r.user ? r.user + '@' : '')}${r.host || ''}`,
            isProd: /prod/i.test(r.name || ''),
          });
        }
      }
      return out;
    },
    tools: [
      {
        name: 'srv_list',
        title: 'Список серверов',
        description: 'Показать серверы, привязанные к текущему проекту, с краткой сводкой состояния.',
        mode: 'read',
        resourceType: 'server',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'server', id: null, discovery: true }),
        async handler(_args, ctx) {
          const srvApi = ctx.deps.serversApi;
          const all = srvApi ? srvApi.getAll() : [];
          const items = [];
          let unboundCount = 0;
          for (const s of all) {
            if (isResourceBound(ctx.binding, 'server', s.id, s)) {
              items.push({
                id: s.id,
                name: s.name,
                group: s.group,
                tags: s.tags,
                state: s.state,
                host: s.host,
                live: s.live ? { cpu: s.live.cpu, memPct: s.live.memPct, load: s.live.load, uptime: s.live.uptime } : null,
                issuesCount: Array.isArray(s.issues) ? s.issues.length : 0,
              });
            } else unboundCount++;
          }
          return { ok: true, servers: items, unboundCount };
        },
      },
      {
        name: 'srv_overview',
        title: 'Сводка по серверу',
        description: 'ОС, CPU/RAM/Load, диски, упавшие сервисы, проблемы, сертификаты и проекты на сервере.',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId'],
          properties: { serverId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          const s = ctx.deps.serversApi && ctx.deps.serversApi.get(args.serverId);
          if (!s) return { ok: false, error: 'Сервер не найден' };
          return redactValue({ ok: true, server: s });
        },
      },
      {
        name: 'srv_metrics_history',
        title: 'История метрик сервера',
        description: 'Поминутные и быстрые метрики CPU, RAM, load и сети.',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId'],
          properties: { serverId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          return ctx.deps.serversApi.history(args.serverId);
        },
      },
      {
        name: 'srv_units',
        title: 'Юниты и таймеры systemd',
        description: 'Список сервисов и таймеров systemd на сервере.',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId'],
          properties: { serverId: { type: 'string', minLength: 1, maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          return ctx.deps.serversApi.units(args.serverId);
        },
      },
      {
        name: 'srv_unit_status',
        title: 'Статус systemd-юнита',
        description: 'Вывод systemctl status для выбранного юнита.',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId', 'unit'],
          properties: {
            serverId: { type: 'string', minLength: 1, maxLength: 80 },
            unit: { type: 'string', minLength: 1, maxLength: 128 },
            user: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          const r = await ctx.deps.serversApi.unitStatus(args.serverId, { unit: args.unit, user: !!args.user });
          return { ok: true, text: sanitizeText(redactText(r && r.text), 32768) };
        },
      },
      {
        name: 'srv_journal',
        title: 'Логи journalctl',
        description: 'Прочитать последние строки systemd journal (опционально фильтр по юниту и приоритету).',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId'],
          properties: {
            serverId: { type: 'string', minLength: 1, maxLength: 80 },
            unit: { type: 'string', maxLength: 128 },
            user: { type: 'boolean' },
            lines: { type: 'integer', minimum: 1, maximum: 500 },
            priority: { type: 'string', enum: ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] },
            since: { type: 'string', maxLength: 40 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          const lines = clamp(args.lines, 1, 500, 200);
          const r = await ctx.deps.serversApi.journal(args.serverId, {
            unit: args.unit,
            user: !!args.user,
            lines,
            priority: args.priority,
            since: args.since,
          });
          return { ok: true, lines, text: sanitizeText(redactText(r && r.text), 65536) };
        },
      },
      {
        name: 'srv_disk_usage',
        title: 'Занятость каталогов (du)',
        description: 'Показать размеры подкаталогов на глубине 1 в указанном пути (без sudo).',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId', 'dir'],
          properties: {
            serverId: { type: 'string', minLength: 1, maxLength: 80 },
            dir: { type: 'string', minLength: 1, maxLength: 512 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          const chk = isSensitivePath(args.dir);
          if (chk.blocked) return { ok: false, error: chk.reason };
          return await ctx.deps.serversApi.du(args.serverId, { dir: args.dir, sudo: false });
        },
      },
      {
        name: 'srv_project_logs',
        title: 'Логи compose-проекта на сервере',
        description: 'Объединённые по времени логи контейнеров compose-проекта на сервере.',
        mode: 'read',
        resourceType: 'server',
        inputSchema: {
          type: 'object',
          required: ['serverId', 'key'],
          properties: {
            serverId: { type: 'string', minLength: 1, maxLength: 80 },
            key: { type: 'string', minLength: 1, maxLength: 255 },
            tail: { type: 'integer', minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'server', id: args.serverId, meta: findServerMeta(deps.serversApi, args.serverId) }),
        async handler(args, ctx) {
          const tail = clamp(args.tail, 1, 500, 150);
          const r = await ctx.deps.serversApi.projectLogs(args.serverId, { key: args.key, tail });
          return { ok: true, tail, text: sanitizeText(redactText(r && r.text), 65536) };
        },
      },
      {
        name: 'rh_scan_services',
        title: 'Порты и сокеты SSH-хоста',
        description: 'Показать привязанные SSH-профили или просканировать слушающие порты и сокеты docker/podman на rhId.',
        mode: 'read',
        resourceType: 'rh',
        inputSchema: {
          type: 'object',
          properties: { rhId: { type: 'string', maxLength: 80 } },
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          if (!args.rhId) return { type: 'rh', id: null, discovery: true };
          return { type: 'rh', id: args.rhId, meta: findRhMeta(deps.rhApi, args.rhId) };
        },
        async handler(args, ctx) {
          const rh = ctx.deps.rhApi;
          if (!args.rhId) {
            const all = rh && typeof rh.list === 'function' ? rh.list() : [];
            const items = [];
            let unboundCount = 0;
            for (const r of all) {
              if (isResourceBound(ctx.binding, 'rh', r.id, r)) {
                items.push({ id: r.id, name: r.name, type: r.type, host: r.host, port: r.port, user: r.user });
              } else unboundCount++;
            }
            return { ok: true, connections: items, unboundCount };
          }
          return await rh.scan(args.rhId);
        },
      },
      {
        name: 'rh_fs_list',
        title: 'Список файлов на SSH/FTP-хосте',
        description: 'Прочитать содержимое каталога на удалённом хосте через SFTP/FTP.',
        mode: 'read',
        resourceType: 'rh',
        inputSchema: {
          type: 'object',
          required: ['rhId'],
          properties: {
            rhId: { type: 'string', minLength: 1, maxLength: 80 },
            path: { type: 'string', maxLength: 512 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'rh', id: args.rhId, meta: findRhMeta(deps.rhApi, args.rhId) }),
        async handler(args, ctx) {
          const p = args.path || '~';
          if (p !== '~') {
            const chk = isSensitivePath(p);
            if (chk.blocked) return { ok: false, error: chk.reason };
          }
          return await ctx.deps.rhApi.listDir(args.rhId, p);
        },
      },
      {
        name: 'rh_fs_read',
        title: 'Чтение файла на SSH/FTP-хосте',
        description: 'Прочитать текстовый файл на удалённом хосте (секреты и .env заблокированы политикой).',
        mode: 'read',
        resourceType: 'rh',
        inputSchema: {
          type: 'object',
          required: ['rhId', 'path'],
          properties: {
            rhId: { type: 'string', minLength: 1, maxLength: 80 },
            path: { type: 'string', minLength: 1, maxLength: 512 },
            maxBytes: { type: 'integer', minimum: 256, maximum: 131072 },
          },
          additionalProperties: false,
        },
        extractResource: (args, deps) => ({ type: 'rh', id: args.rhId, meta: findRhMeta(deps.rhApi, args.rhId) }),
        async handler(args, ctx) {
          const chk = isSensitivePath(args.path);
          if (chk.blocked) return { ok: false, error: chk.reason };
          const r = await ctx.deps.rhApi.readFile(args.rhId, args.path);
          if (r && r.error) return { ok: false, error: r.error };
          if (r && r.binary) return { ok: false, error: 'Бинарный файл — чтение запрещено' };
          const maxB = clamp(args.maxBytes, 256, 131072, 65536);
          const text = sanitizeText(redactText((r && r.content) || ''), maxB);
          return { ok: true, path: args.path, text, encoding: r && r.encoding ? r.encoding : 'utf8' };
        },
      },
    ],
  });
}

module.exports = { createServersPack };
