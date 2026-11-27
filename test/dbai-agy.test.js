// Тесты чистого хелпера Antigravity CLI (lib/dbai-agy.js) для AI-DB чата.
// Запуск: node test/dbai-agy.test.js
const assert = require('assert');
const {
  AGY_NO_TOOLS_NOTE,
  sanitizeAgyModel,
  resolveAgyBin,
  buildAgyArgs,
  wrapAgyPrompt,
  parseAgyModelsOutput,
  mapAgyUsage,
  parseAgyStreamLine,
} = require('../lib/dbai-agy');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// --- sanitizeAgyModel ---------------------------------------------------------------
eq(sanitizeAgyModel('gemini-4-neon-high'), 'gemini-4-neon-high', 'валидная модель');
eq(sanitizeAgyModel('  claude-opus-5-5-medium  '), 'claude-opus-5-5-medium', 'trim пробелов');
eq(sanitizeAgyModel('--dangerously-skip-permissions'), '', 'отброс флага как модели');
eq(sanitizeAgyModel('gemini 4; rm -rf /'), '', 'отброс пробелов и спецсимволов');
eq(sanitizeAgyModel(''), '', 'пустая строка');

// --- buildAgyArgs -------------------------------------------------------------------
eq(
  buildAgyArgs(),
  ['--output-format', 'stream-json', '--input-format', 'text', '--disable-slash-commands'],
  'базовые флаги без --model и без --print'
);
eq(
  buildAgyArgs({ model: 'gemini-4-hydrogen-high', effort: 'High' }),
  ['--output-format', 'stream-json', '--input-format', 'text', '--disable-slash-commands', '--model', 'gemini-4-hydrogen-high', '--effort', 'high'],
  'модель + effort в нижнем регистре'
);
const unsafeArgs = buildAgyArgs({ model: '--mode accept-edits', effort: 'bogus' });
ok(!unsafeArgs.some((a) => a.startsWith('--print')), 'нет --print в argv (защита от E2BIG и ps)');
ok(!unsafeArgs.includes('--mode') && !unsafeArgs.includes('--effort'), 'невалидные model/effort не попадают в argv');

// --- wrapAgyPrompt ------------------------------------------------------------------
ok(wrapAgyPrompt('SELECT 1').startsWith(AGY_NO_TOOLS_NOTE), 'запрет на вызов инструментов добавляется перед промптом');
ok(wrapAgyPrompt('SELECT 1').endsWith('SELECT 1'), 'исходный промпт сохранён');
eq(wrapAgyPrompt(''), AGY_NO_TOOLS_NOTE, 'пустой промпт даёт только инструкцию');

// --- parseAgyModelsOutput -----------------------------------------------------------
const rawModels = [
  '\r\x1b[2K⠋ Fetching available models...\r⠙ Fetching available models...',
  'gemini-4-neon-high             Gemini 4 Neon (High)',
  'gemini-pro-orchestrator-neon   Orchestrator (Neon)',
  'claude-opus-5-5-medium         Claude Opus 5.5 (Medium)',
  'gemini-4-neon-high             Gemini 4 Neon (High)', // дубликат
  'not a valid line',
].join('\n');
eq(parseAgyModelsOutput(rawModels), [
  { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)', family: 'Gemini 4 Neon', effort: 'High' },
  { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', family: 'Orchestrator (Neon)', effort: '' },
  { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)', family: 'Claude Opus 5.5', effort: 'Medium' },
], 'парсинг списка моделей с ANSI/спиннерами и дедупликацией');
eq(parseAgyModelsOutput('Fetching available models...\n'), [], 'пустой вывод без моделей');

// --- mapAgyUsage --------------------------------------------------------------------
eq(mapAgyUsage(null), null, 'null usage');
eq(mapAgyUsage({ input_tokens: 0, output_tokens: 0 }), null, 'нулевой usage игнорируется');
eq(
  mapAgyUsage({ input_tokens: 15701, output_tokens: 129, thinking_tokens: 126, cache_read_tokens: 0, total_tokens: 15830 }),
  { prompt_tokens: 15701, completion_tokens: 129, cost: 0 },
  'thinking_tokens не дублируются поверх output_tokens, cost = 0'
);

// --- parseAgyStreamLine -------------------------------------------------------------
eq(
  parseAgyStreamLine('{"event":"init","conversation_id":"abc","init":{"model":"gemini-4-neon-high"}}'),
  { kind: 'init', model: 'gemini-4-neon-high' },
  'init событие'
);
eq(
  parseAgyStreamLine('{"event":"step_update","step_update":{"step_type":"user_input","state":"DONE"}}'),
  null,
  'user_input пропускается'
);
eq(
  parseAgyStreamLine('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"SELECT 1"}}'),
  { kind: 'delta', text: 'SELECT 1' },
  'text_delta из agent_response'
);
eq(
  parseAgyStreamLine('{"event":"result","result":{"status":"SUCCESS","response":"SELECT 1\\n","usage":{"input_tokens":10,"output_tokens":5}}}'),
  { kind: 'result', status: 'SUCCESS', text: 'SELECT 1\n', error: '', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } },
  'успешный result с usage'
);
eq(
  parseAgyStreamLine('{"event":"result","result":{"status":"ERROR","error":"Unauthorized"}}'),
  { kind: 'result', status: 'ERROR', text: '', error: 'Unauthorized', usage: null },
  'result с ошибкой'
);
eq(parseAgyStreamLine('{"event":"error","error":"boom"}'), { kind: 'error', error: 'boom' }, 'event error');
eq(parseAgyStreamLine('not-json'), null, 'невалидный JSON');

// --- resolveAgyBin ------------------------------------------------------------------
eq(
  resolveAgyBin({
    env: { AGY_BIN: '/custom/agy', PATH: '/usr/bin' },
    platform: 'linux',
    homedir: '/home/u',
    exists: (p) => p === '/custom/agy' || p === '/usr/bin/agy',
  }),
  '/custom/agy',
  'AGY_BIN имеет приоритет'
);
eq(
  resolveAgyBin({
    env: { PATH: '/usr/local/bin:/usr/bin' },
    platform: 'linux',
    homedir: '/home/u',
    exists: (p) => p === '/usr/bin/agy',
  }),
  '/usr/bin/agy',
  'поиск в PATH'
);
eq(
  resolveAgyBin({
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    homedir: '/home/u',
    exists: (p) => p === '/home/u/.local/bin/agy',
  }),
  '/home/u/.local/bin/agy',
  'фолбэк ~/.local/bin/agy'
);
eq(
  resolveAgyBin({
    env: { PATH: '' },
    platform: 'linux',
    homedir: '/home/u',
    exists: () => false,
  }),
  'agy',
  'итоговый фолбэк имени бинарника'
);

console.log(`dbai-agy: ${passed} passed`);
