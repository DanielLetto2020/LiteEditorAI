#!/usr/bin/env node
// LiteEditor — MCP-сервер «lite-tasks»: даёт агенту в терминале проекта инструменты создавать/читать
// напоминания Календаря. Общается по stdio (newline-delimited JSON-RPC 2.0), без внешних зависимостей.
// Данные — те же файлы, что и у окна «Задачи»: ~/.LiteEditorAI/agenda/<projId>.json (или __global__).
// projId берётся из --project <id>; иначе резолвится по cwd (projects.json); иначе __global__.
// ВАЖНО: в stdout идёт ТОЛЬКО протокол; любые логи — в stderr.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_DIR = path.join(os.homedir(), '.LiteEditorAI');
const AGENDA_DIR = path.join(STORE_DIR, 'agenda');
const SERVER = { name: 'lite-tasks', version: '1.0.0' };
const REMIND = ['at', '10m', '1h', '1d'];

// ---- к какому проекту привязан сервер ----
function resolveTargetId() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--project');
  if (pi >= 0 && argv[pi + 1]) return String(argv[pi + 1]);
  if (argv.includes('--global')) return '__global__';
  // фолбэк: сопоставить cwd с проектом LiteEditor
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'projects.json'), 'utf8'));
    const cwd = process.cwd();
    const hit = Array.isArray(projects) && projects.find((p) => p && p.path === cwd);
    if (hit && hit.id) return String(hit.id);
  } catch (_) {}
  return '__global__';
}
const TARGET_ID = resolveTargetId();
const agendaFile = () => path.join(AGENDA_DIR, String(TARGET_ID).replace(/[^\w.-]/g, '_') + '.json');

// ---- чтение/запись (атомарно: tmp + rename) ----
function readItems() {
  try { const a = JSON.parse(fs.readFileSync(agendaFile(), 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeItems(items) {
  fs.mkdirSync(AGENDA_DIR, { recursive: true });
  const f = agendaFile();
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(items));
  fs.renameSync(tmp, f);
}
const genId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function parseAt(s) {
  if (!s) return { at: null, allDay: false };
  const hasTime = /\d{1,2}:\d{2}/.test(String(s));
  const d = new Date(s);
  if (isNaN(d)) return { at: null, allDay: false };
  return { at: d.toISOString(), allDay: !hasTime };
}
function fmtItem(r) {
  const parts = [];
  const title = String(r.text || '').split('\n')[0].trim() || '(без названия)';
  parts.push(r.done ? `[✓] ${title}` : `[ ] ${title}`);
  if (r.at) {
    const d = new Date(r.at);
    if (!isNaN(d)) parts.push(r.allDay ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' '));
  }
  if (r.remind) parts.push('напомнить: ' + r.remind);
  parts.push('id=' + r.id);
  return parts.join(' · ');
}

// ---- инструменты ----
const TOOLS = [
  {
    name: 'list_reminders',
    description: 'Список напоминаний (дата-задач) текущего проекта LiteEditor. Показывает заголовок, срок, статус и id. '
      + 'Используй, чтобы узнать ближайшие сроки/дедлайны, прежде чем планировать работу.',
    inputSchema: {
      type: 'object',
      properties: {
        when: { type: 'string', enum: ['all', 'overdue', 'today', 'upcoming', 'open'], description: 'Фильтр: all — все, overdue — просроченные, today — сегодня, upcoming — будущие, open — невыполненные (по умолчанию open).' },
      },
    },
  },
  {
    name: 'add_reminder',
    description: 'Создать напоминание (дата-задачу) в Календаре LiteEditor. Ставь его, когда пользователь просит '
      + '«напомнить», «не забыть», «через N дней проверить», указать дедлайн. Пользователь увидит его в окне «Задачи» '
      + 'и получит нативное уведомление в срок (если задано remind).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст напоминания. Первая строка — заголовок.' },
        at: { type: 'string', description: 'Срок: ISO 8601 или "YYYY-MM-DD" (весь день) или "YYYY-MM-DD HH:mm". Необязателен.' },
        remind: { type: 'string', enum: REMIND, description: 'За сколько до срока уведомить: at (в момент), 10m, 1h, 1d. Необязателен.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'complete_reminder',
    description: 'Отметить напоминание выполненным по его id (id можно узнать через list_reminders).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id напоминания.' } },
      required: ['id'],
    },
  },
];

function toolListReminders(args) {
  const when = (args && args.when) || 'open';
  const now = Date.now();
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const eod = sod.getTime() + 86400000;
  let items = readItems();
  const has = (r) => r && r.at && !isNaN(new Date(r.at));
  if (when === 'open') items = items.filter((r) => !r.done);
  else if (when === 'overdue') items = items.filter((r) => !r.done && has(r) && new Date(r.at).getTime() < now);
  else if (when === 'today') items = items.filter((r) => !r.done && has(r) && new Date(r.at).getTime() < eod && new Date(r.at).getTime() >= sod.getTime());
  else if (when === 'upcoming') items = items.filter((r) => !r.done && has(r) && new Date(r.at).getTime() >= now);
  items.sort((a, b) => (a.at ? new Date(a.at).getTime() : Infinity) - (b.at ? new Date(b.at).getTime() : Infinity));
  if (!items.length) return { content: [{ type: 'text', text: 'Напоминаний нет (фильтр: ' + when + ').' }] };
  return { content: [{ type: 'text', text: `Напоминаний: ${items.length} (${when})\n` + items.map(fmtItem).join('\n') }] };
}
function toolAddReminder(args) {
  const text = args && typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return { content: [{ type: 'text', text: 'Ошибка: не задан text.' }], isError: true };
  const { at, allDay } = parseAt(args.at);
  const remind = REMIND.includes(args && args.remind) ? args.remind : null;
  const item = { id: genId(), text, at, allDay, remind, done: false, tag: '', notifiedAt: null, createdAt: new Date().toISOString() };
  const items = readItems();
  items.unshift(item);
  writeItems(items);
  return { content: [{ type: 'text', text: 'Создано напоминание: ' + fmtItem(item) }] };
}
function toolCompleteReminder(args) {
  const id = args && args.id;
  if (!id) return { content: [{ type: 'text', text: 'Ошибка: не задан id.' }], isError: true };
  const items = readItems();
  const r = items.find((x) => x && x.id === id);
  if (!r) return { content: [{ type: 'text', text: 'Напоминание с id=' + id + ' не найдено.' }], isError: true };
  r.done = true; r.notifiedAt = r.notifiedAt || new Date().toISOString();
  writeItems(items);
  return { content: [{ type: 'text', text: 'Отмечено выполненным: ' + fmtItem(r) }] };
}
function callTool(name, args) {
  if (name === 'list_reminders') return toolListReminders(args);
  if (name === 'add_reminder') return toolAddReminder(args);
  if (name === 'complete_reminder') return toolCompleteReminder(args);
  return { content: [{ type: 'text', text: 'Неизвестный инструмент: ' + name }], isError: true };
}

// ---- транспорт JSON-RPC по stdio ----
function send(obj) { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) {} }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  const isReq = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER,
        });
      case 'notifications/initialized':
      case 'initialized':
        return; // уведомление — без ответа
      case 'ping':
        return isReq && reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const r = callTool(params && params.name, (params && params.arguments) || {});
        return reply(id, r);
      }
      default:
        if (isReq) replyErr(id, -32601, 'Method not found: ' + method);
    }
  } catch (e) {
    if (isReq) replyErr(id, -32603, 'Internal error: ' + (e && e.message ? e.message : String(e)));
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[lite-tasks mcp] target=${TARGET_ID} file=${agendaFile()}\n`);
