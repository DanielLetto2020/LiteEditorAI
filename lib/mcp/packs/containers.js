// MCP-пак для модуля «Контейнеры» (8 read-only инструментов; без exec-шелла и write-действий).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');

/** @param {any} args */
function containerResource(args, deps) {
  const rhId = args && args.rhId ? String(args.rhId) : '';
  const engine = args && args.engine ? String(args.engine) : 'docker';
  const id = rhId ? `rh:${rhId}:${engine}` : `local:${engine}`;
  let name = id;
  let isProd = false;
  if (rhId && deps && deps.rhApi) {
    const conn = deps.rhApi.findConn(rhId);
    if (conn) {
      name = `${engine} @ ${conn.name || conn.host}`;
      isProd = /prod/i.test(conn.name || '');
    }
  } else {
    name = `Локальный ${engine}`;
  }
  return {
    type: 'container',
    id,
    meta: { name, engine, rhId: rhId || null, isLocal: !rhId, isProd },
  };
}

function createContainersPack() {
  return defineMcpPack({
    id: 'containers',
    name: 'Контейнеры (Docker/Podman)',
    description: 'Инспекция локальных и удалённых контейнеров, логи, статистика, тома/образы и безопасное чтение файлов.',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const api = deps.getContainersApi();
      const det = api ? await api.detect() : { docker: {}, podman: {} };
      const out = [
        {
          type: 'container',
          id: 'local:docker',
          name: 'Локальный Docker',
          subtitle: det.docker && det.docker.cli ? det.docker.cli : 'не установлен',
          isLocal: true,
          isProd: false,
        },
        {
          type: 'container',
          id: 'local:podman',
          name: 'Локальный Podman',
          subtitle: det.podman && det.podman.cli ? det.podman.cli : 'не установлен',
          isLocal: true,
          isProd: false,
        },
      ];
      if (deps.rhApi && typeof deps.rhApi.list === 'function') {
        for (const r of deps.rhApi.list()) {
          if (r.type === 'ftp') continue;
          const isProd = /prod/i.test(r.name || '');
          out.push({
            type: 'container',
            id: `rh:${r.id}:docker`,
            name: `Docker @ ${r.name || r.host}`,
            subtitle: r.host,
            isLocal: false,
            isProd,
          });
          out.push({
            type: 'container',
            id: `rh:${r.id}:podman`,
            name: `Podman @ ${r.name || r.host}`,
            subtitle: r.host,
            isLocal: false,
            isProd,
          });
        }
      }
      return out;
    },
    tools: [
      {
        name: 'ctr_detect',
        title: 'Доступные движки контейнеров',
        description: 'Показать установленные локальные движки Docker/Podman и разрешённые цели контейнеров.',
        mode: 'read',
        resourceType: 'container',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'container', id: null, discovery: true }),
        async handler(_args, ctx) {
          const api = ctx.deps.getContainersApi();
          const detected = api ? await api.detect() : { docker: {}, podman: {} };
          const allTargets = [
            { id: 'local:docker', name: 'Локальный Docker', engine: 'docker', rhId: null, isLocal: true },
            { id: 'local:podman', name: 'Локальный Podman', engine: 'podman', rhId: null, isLocal: true },
          ];
          if (ctx.deps.rhApi && typeof ctx.deps.rhApi.list === 'function') {
            for (const r of ctx.deps.rhApi.list()) {
              if (r.type === 'ftp') continue;
              allTargets.push({ id: `rh:${r.id}:docker`, name: `Docker @ ${r.name || r.host}`, engine: 'docker', rhId: r.id, isLocal: false });
              allTargets.push({ id: `rh:${r.id}:podman`, name: `Podman @ ${r.name || r.host}`, engine: 'podman', rhId: r.id, isLocal: false });
            }
          }
          const allowedTargets = allTargets.filter((t) => isResourceBound(ctx.binding, 'container', t.id, t));
          return { ok: true, detected, allowedTargets, preset: ctx.binding.preset };
        },
      },
      {
        name: 'ctr_list',
        title: 'Список контейнеров',
        description: 'Получить список контейнеров (и подов Podman) для локального движка или удалённого SSH-хоста.',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
            light: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.list({ rhId: args.rhId, engine: args.engine }, { light: args.light !== false });
        },
      },
      {
        name: 'ctr_inspect',
        title: 'Инспекция контейнера',
        description: 'Метаданные контейнера (порты, монтирования, образ, сеть, Env с редактированием секретов).',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine', 'containerId'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
            containerId: { type: 'string', minLength: 1, maxLength: 255 },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.inspectSafe({ rhId: args.rhId, engine: args.engine }, args.containerId);
        },
      },
      {
        name: 'ctr_logs',
        title: 'Логи контейнера',
        description: 'Прочитать последние строки логов контейнера (--tail, без слежения).',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine', 'containerId'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
            containerId: { type: 'string', minLength: 1, maxLength: 255 },
            tail: { type: 'integer', minimum: 1, maximum: 2000 },
            since: { type: 'string', maxLength: 40 },
            timestamps: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.logsOnce({ rhId: args.rhId, engine: args.engine }, args.containerId, {
            tail: args.tail || 200,
            since: args.since,
            timestamps: args.timestamps !== false,
          });
        },
      },
      {
        name: 'ctr_stats',
        title: 'Статистика CPU/RAM контейнеров',
        description: 'Текущий снимок потребления CPU, памяти и сети контейнеров (--no-stream).',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
            containerId: { type: 'string', maxLength: 255 },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.statsOnce({ rhId: args.rhId, engine: args.engine }, args.containerId || null);
        },
      },
      {
        name: 'ctr_resources',
        title: 'Образы, тома, поды и df',
        description: 'Список образов, томов, подов и сводка использования диска движком контейнеров.',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.resources({ rhId: args.rhId, engine: args.engine });
        },
      },
      {
        name: 'ctr_fs_list',
        title: 'Файлы в контейнере',
        description: 'Список файлов в каталоге запущенного контейнера.',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine', 'containerId'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
            containerId: { type: 'string', minLength: 1, maxLength: 255 },
            path: { type: 'string', maxLength: 512 },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.fsList({ rhId: args.rhId, engine: args.engine }, args.containerId, args.path || '/');
        },
      },
      {
        name: 'ctr_fs_read',
        title: 'Чтение файла в контейнере',
        description: 'Прочитать текстовый файл внутри запущенного контейнера (чувствительные пути и секреты заблокированы).',
        mode: 'read',
        resourceType: 'container',
        inputSchema: {
          type: 'object',
          required: ['engine', 'containerId', 'path'],
          properties: {
            engine: { type: 'string', enum: ['docker', 'podman'] },
            rhId: { type: 'string', maxLength: 80 },
            containerId: { type: 'string', minLength: 1, maxLength: 255 },
            path: { type: 'string', minLength: 1, maxLength: 512 },
            maxBytes: { type: 'integer', minimum: 256, maximum: 262144 },
          },
          additionalProperties: false,
        },
        extractResource: containerResource,
        async handler(args, ctx) {
          const api = ctx.deps.getContainersApi();
          return await api.fsRead({ rhId: args.rhId, engine: args.engine }, args.containerId, args.path, { maxBytes: args.maxBytes });
        },
      },
    ],
  });
}

module.exports = { createContainersPack };
