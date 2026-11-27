// MCP-пак для локальных заметок и задач проекта в LiteEditor (read-only).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { redactValue } = require('../redact');

function resolveTargetProject(args, ctx) {
  const pid = args && args.projectId ? String(args.projectId) : ctx.session.projectId;
  if (pid && ctx.session.projectId && pid !== ctx.session.projectId) {
    const allowed = isResourceBound(ctx.binding, 'project', pid, { id: pid, isSelf: false });
    if (!allowed) {
      throw new Error(`Проект «${pid}» не привязан к текущей сессии для чтения заметок/задач`);
    }
  }
  return pid;
}

function createTasksPack() {
  return defineMcpPack({
    id: 'tasks',
    name: 'Заметки и задачи',
    description: 'Локальные заметки и задачи (agenda) текущего или привязанного проекта LiteEditor (read-only).',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources() {
      return [];
    },
    tools: [
      {
        name: 'tasks_notes_get',
        title: 'Заметки проекта',
        description: 'Прочитать список заметок проекта LiteEditor.',
        mode: 'read',
        resourceType: 'none',
        inputSchema: {
          type: 'object',
          properties: { projectId: { type: 'string' } },
          additionalProperties: false,
        },
        extractResource: () => ({ type: 'none', id: null, discovery: true }),
        async handler(args, ctx) {
          const api = ctx.deps.tasksApi;
          if (!api) throw new Error('Хранилище заметок недоступно');
          const projectId = resolveTargetProject(args, ctx);
          const notes = await Promise.resolve(api.getNotes(projectId));
          const list = Array.isArray(notes) ? notes : [];
          return { ok: true, projectId, notes: redactValue(list.slice(0, 100)), total: list.length, truncated: list.length > 100 };
        },
      },
      {
        name: 'tasks_agenda_get',
        title: 'Список дел проекта',
        description: 'Прочитать локальные задачи/чеклисты (agenda) проекта LiteEditor.',
        mode: 'read',
        resourceType: 'none',
        inputSchema: {
          type: 'object',
          properties: { projectId: { type: 'string' } },
          additionalProperties: false,
        },
        extractResource: () => ({ type: 'none', id: null, discovery: true }),
        async handler(args, ctx) {
          const api = ctx.deps.tasksApi;
          if (!api) throw new Error('Хранилище задач недоступно');
          const projectId = resolveTargetProject(args, ctx);
          const agenda = await Promise.resolve(api.getAgenda(projectId));
          const list = Array.isArray(agenda) ? agenda : [];
          return { ok: true, projectId, items: redactValue(list.slice(0, 200)), total: list.length, truncated: list.length > 200 };
        },
      },
    ],
  });
}

module.exports = { createTasksPack };
