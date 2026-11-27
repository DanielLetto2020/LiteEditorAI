// MCP-пак для модуля «Jira» (6 read-only инструментов; без transition и comment).
'use strict';

const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { redactValue } = require('../redact');

function clamp(n, lo, hi, d) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}

function findJiraMeta(jira, id) {
  if (!jira || !id) return null;
  const a = jira.findAccount(String(id));
  if (!a) return null;
  return {
    id: a.id,
    name: a.name || a.host || a.id,
    host: a.host || '',
    isProd: /prod/i.test(a.name || ''),
  };
}

function publicJiraInfo(a) {
  return {
    id: a.id,
    name: a.name || '',
    host: a.host || '',
    mode: a.mode || 'pat',
    user: a.user || '',
  };
}

function requireJira(deps, id) {
  const jira = deps.getJiraApi();
  if (!jira) throw new Error('Модуль «Jira» недоступен');
  const meta = findJiraMeta(jira, id);
  if (!meta) throw new Error(`Аккаунт Jira «${id}» не найден`);
  return { jira, meta };
}

function createJiraPack() {
  return defineMcpPack({
    id: 'jira',
    name: 'Jira',
    description: 'Поиск задач по JQL и пресетам, карточки задач, Agile-доски, справочники и структура инсталляции (read-only).',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      const jira = deps.getJiraApi();
      const list = jira ? jira.list() : [];
      return list.map((a) => ({
        type: 'jira',
        id: a.id,
        name: a.name || a.host || a.id,
        subtitle: a.host || '',
        isProd: /prod/i.test(a.name || ''),
      }));
    },
    tools: [
      {
        name: 'jira_list_accounts',
        title: 'Список аккаунтов Jira',
        description: 'Показать аккаунты Jira, разрешённые для текущего проекта.',
        mode: 'read',
        resourceType: 'jira',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'jira', id: null, discovery: true }),
        async handler(_args, ctx) {
          const jira = ctx.deps.getJiraApi();
          const all = jira ? jira.list() : [];
          const accounts = [];
          let unboundCount = 0;
          for (const a of all) {
            if (isResourceBound(ctx.binding, 'jira', a.id, a)) accounts.push(publicJiraInfo(a));
            else unboundCount++;
          }
          return { ok: true, accounts, unboundCount };
        },
      },
      {
        name: 'jira_search',
        title: 'Поиск задач Jira',
        description: 'Поиск задач по JQL или пресету (my, active, watched, reported, updated). До 50 задач.',
        mode: 'read',
        resourceType: 'jira',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            preset: { type: 'string' },
            jql: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: 50 },
          },
          required: ['accountId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const jira = deps.getJiraApi();
          return { type: 'jira', id: args.accountId, meta: findJiraMeta(jira, args.accountId) };
        },
        async handler(args, ctx) {
          const { jira } = requireJira(ctx.deps, args.accountId);
          const limit = clamp(args.limit, 1, 50, 25);
          const res = await jira.search(String(args.accountId), {
            preset: args.preset ? String(args.preset) : undefined,
            jql: args.jql ? String(args.jql) : undefined,
            limit,
          });
          return redactValue(res);
        },
      },
      {
        name: 'jira_issue',
        title: 'Карточка задачи Jira',
        description: 'Полное содержимое задачи: описание, последние комментарии, подзадачи, связи, затраченное время и кастомные поля.',
        mode: 'read',
        resourceType: 'jira',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            key: { type: 'string' },
          },
          required: ['accountId', 'key'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const jira = deps.getJiraApi();
          return { type: 'jira', id: args.accountId, meta: findJiraMeta(jira, args.accountId) };
        },
        async handler(args, ctx) {
          const { jira } = requireJira(ctx.deps, args.accountId);
          const res = await jira.issue(String(args.accountId), { key: String(args.key) });
          return { ok: true, ...(redactValue(res)) };
        },
      },
      {
        name: 'jira_boards',
        title: 'Agile-доски Jira',
        description: 'Список досок (Scrum/Kanban) и опциональная привязка текущих задач.',
        mode: 'read',
        resourceType: 'jira',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            withIssues: { type: 'boolean' },
          },
          required: ['accountId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const jira = deps.getJiraApi();
          return { type: 'jira', id: args.accountId, meta: findJiraMeta(jira, args.accountId) };
        },
        async handler(args, ctx) {
          const { jira } = requireJira(ctx.deps, args.accountId);
          const res = await jira.boards(String(args.accountId), { withIssues: !!args.withIssues });
          return { ok: true, ...(redactValue(res)) };
        },
      },
      {
        name: 'jira_meta',
        title: 'Справочник статусов и типов Jira',
        description: 'Список доступных статусов и типов задач в инсталляции Jira.',
        mode: 'read',
        resourceType: 'jira',
        inputSchema: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const jira = deps.getJiraApi();
          return { type: 'jira', id: args.accountId, meta: findJiraMeta(jira, args.accountId) };
        },
        async handler(args, ctx) {
          const { jira } = requireJira(ctx.deps, args.accountId);
          const res = await jira.meta(String(args.accountId));
          return { ok: true, ...(redactValue(res)) };
        },
      },
      {
        name: 'jira_recon',
        title: 'Структура инсталляции Jira',
        description: 'Снимок кастомных полей, схем и возможностей сервера Jira (без секретов).',
        mode: 'read',
        resourceType: 'jira',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            withTexts: { type: 'boolean' },
          },
          required: ['accountId'],
          additionalProperties: false,
        },
        extractResource: (args, deps) => {
          const jira = deps.getJiraApi();
          return { type: 'jira', id: args.accountId, meta: findJiraMeta(jira, args.accountId) };
        },
        async handler(args, ctx) {
          const { jira } = requireJira(ctx.deps, args.accountId);
          const report = await jira.recon(String(args.accountId), { withTexts: !!args.withTexts });
          return { ok: true, report: redactValue(report) };
        },
      },
    ],
  });
}

module.exports = { createJiraPack };
