// Тесты защиты выхода при живых агентах и процессах в терминалах (lib/quit-guard.js).
// Запуск: node test/quit-guard.test.js
'use strict';

const assert = require('assert');
const { classifyBusySession, resolveSessionGroup, summarizeBusyPtys } = require('../lib/quit-guard');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

// 1. Классификация состояний одной сессии
{
  eq(classifyBusySession(null), null, 'null не блокирует выход');
  eq(classifyBusySession(undefined), null, 'undefined не блокирует выход');
  eq(classifyBusySession({ fg: 'shell', agent: null, idle: true }), null, 'пустой шелл на приглашении без потомков — безопасен');

  const c1 = classifyBusySession({ fg: 'waiting', agent: 'claude', idle: false });
  eq(c1 && c1.kind, 'agent', 'агент имеет приоритет');
  eq(c1 && c1.label, 'claude', 'метка — имя агента');

  const c2 = classifyBusySession({ fg: 'running', agent: null, idle: false });
  eq(c2 && c2.kind, 'fg', 'активная команда переднего плана');

  const c3 = classifyBusySession({ fg: 'shell', agent: null, idle: false });
  eq(c3 && c3.kind, 'bg', 'фоновый потомок шелла (Ctrl+Z / &)');
}

// 2. Определение группы сессии по id
{
  const map = new Map([['p123', 'LiteEditor'], ['p456', 'Backend']]);
  eq(resolveSessionGroup('p123::t1.abc', map).title, 'LiteEditor', 'проектная вкладка резолвится в имя проекта');
  eq(resolveSessionGroup('p999::t2.abc', map).title, 'p999', 'неизвестный проект фолбэчится на id');
  eq(resolveSessionGroup('__scratch__::t1', map).title, 'Система · ~', 'системный терминал');
  eq(resolveSessionGroup('__extterm__::t1.abc', map).title, 'Мои модули', 'dev-терминал модуля');
}

// 3. Сводка занятых сессий по проектам
{
  const summary = summarizeBusyPtys({
    projects: [
      { id: 'p1', name: 'LiteEditor' },
      { id: 'p2', name: 'API' },
      { id: 'p3', name: 'IdleProj' },
    ],
    agentsMap: {
      'p1::t1.x': { fg: 'waiting', agent: 'claude', idle: false },
      'p1::t2.x': { fg: 'running', agent: 'claude', idle: false },
      'p1::t3.x': { fg: 'running', agent: null, idle: false },
      'p2::t1.x': { fg: 'waiting', agent: 'codex', idle: false },
      'p3::t1.x': { fg: 'shell', agent: null, idle: true },
      '__scratch__::t1': { fg: 'shell', agent: null, idle: false },
    },
  });

  eq(summary.busyCount, 5, 'учтены 5 занятых сессий (пустой шелл p3 пропущен)');
  eq(summary.agentCount, 3, 'учтены 3 сессии с ИИ-агентами');
  eq(summary.groups.length, 3, 'сгруппировано по 3 источникам');
  eq(summary.groups[0].title, 'LiteEditor', 'первая группа — LiteEditor');
  eq(summary.groups[0].summary, 'claude ×2, выполняется команда', 'агрегация одинаковых агентов и команд внутри проекта');
  eq(summary.groups[1].summary, 'codex', 'вторая группа — codex');
  eq(summary.groups[2].title, 'Система · ~', 'третья группа — скретч');
  eq(summary.groups[2].summary, 'фоновый процесс', 'фоновый процесс в скретче');
  ok(summary.detailLines.some((l) => l.includes('LiteEditor — claude ×2, выполняется команда')), 'строка деталей сформирована');
}

// 4. Пустая сводка, когда все шеллы простаивают
{
  const empty = summarizeBusyPtys({
    projects: [{ id: 'p1', name: 'A' }],
    agentsMap: {
      'p1::t1.x': { fg: 'shell', agent: null, idle: true },
      'p1::t2.x': { fg: 'shell', agent: null, idle: true },
    },
  });
  eq(empty.busyCount, 0, 'нет занятых сессий');
  eq(empty.agentCount, 0, 'нет агентов');
  eq(empty.detailLines.length, 0, 'детали пусты');
}

console.log(`✓ quit-guard: ${passed} проверок пройдено`);
