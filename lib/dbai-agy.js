// Вспомогательные чистые функции интеграции Antigravity CLI (`agy`) для AI-DB чата.
// Вынесены из main.js, чтобы поиск бинарника, сборка безопасных аргументов (без --print и утечки
// в ps), парсинг `agy models` и разбор NDJSON `stream-json` покрывались быстрыми node-тестами.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { whichInPath } = require('./shell');

const AGY_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const AGY_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_LABELS = new Set(['Low', 'Medium', 'High', 'XHigh', 'Max']);
const AGY_NO_TOOLS_NOTE =
  'ВАЖНО: не вызывай файловые, браузерные, поисковые, MCP или shell-инструменты — все данные уже переданы в этом сообщении, верни только текстовый ответ.';

function sanitizeAgyModel(raw) {
  const clean = String(raw || '').trim();
  return AGY_MODEL_RE.test(clean) ? clean : '';
}

function resolveAgyBin({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const exe = platform === 'win32' ? 'agy.exe' : 'agy';
  const fromEnv = String((env && env.AGY_BIN) || '').trim();
  if (fromEnv && exists(fromEnv)) return fromEnv;
  const inPath = whichInPath(exe, platform, env || {}, exists);
  if (inPath) return inPath;
  const localBin = (platform === 'win32' ? path.win32 : path.posix).join(homedir, '.local', 'bin', exe);
  if (exists(localBin)) return localBin;
  return exe;
}

function buildAgyArgs({ model = '', effort = '' } = {}) {
  // Читаем промпт только через stdin (--input-format text): схема и строки БД слишком велики
  // для argv (ARG_MAX/E2BIG) и не должны светиться в `ps`.
  const args = ['--output-format', 'stream-json', '--input-format', 'text', '--disable-slash-commands'];
  const cleanModel = sanitizeAgyModel(model);
  if (cleanModel) args.push('--model', cleanModel);
  const cleanEffort = String(effort || '').trim().toLowerCase();
  if (AGY_EFFORTS.has(cleanEffort)) args.push('--effort', cleanEffort);
  return args;
}

function wrapAgyPrompt(prompt) {
  const body = String(prompt || '');
  return body ? `${AGY_NO_TOOLS_NOTE}\n\n${body}` : AGY_NO_TOOLS_NOTE;
}

function parseAgyModelsOutput(raw) {
  const cleaned = String(raw || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '\n');
  const models = [];
  const seen = new Set();
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.includes('Fetching available models')) continue;
    const m = line.match(/^([a-z0-9][a-z0-9._-]+)(?:\t+|\s{2,})(.+)$/i);
    if (!m) continue;
    const id = m[1].trim();
    const label = m[2].trim();
    if (!AGY_MODEL_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const lm = label.match(/^(.*)\s+\(([^)]+)\)$/);
    const effort = lm && EFFORT_LABELS.has(lm[2]) ? lm[2] : '';
    const family = lm && effort ? lm[1].trim() : label;
    models.push({ id, name: label, family, effort });
  }
  return models;
}

function mapAgyUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt_tokens = Number(raw.input_tokens || 0) || 0;
  // В stream-json agy output_tokens уже включает thinking_tokens (input + output === total_tokens).
  const completion_tokens = Number(raw.output_tokens || 0) || 0;
  if (!prompt_tokens && !completion_tokens) return null;
  return { prompt_tokens, completion_tokens, cost: 0 };
}

function parseAgyStreamLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.event === 'init') {
    return { kind: 'init', model: (obj.init && typeof obj.init.model === 'string' && obj.init.model) || '' };
  }
  if (obj.event === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
    const su = obj.step_update;
    if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta) {
      return { kind: 'delta', text: su.text_delta };
    }
    return null;
  }
  if (obj.event === 'result' && obj.result && typeof obj.result === 'object') {
    const r = obj.result;
    return {
      kind: 'result',
      status: String(r.status || ''),
      text: typeof r.response === 'string' ? r.response : '',
      error: String(r.error || ''),
      usage: mapAgyUsage(r.usage),
    };
  }
  if (obj.event === 'error') {
    return { kind: 'error', error: String(obj.error || obj.message || 'Ошибка Antigravity') };
  }
  return null;
}

module.exports = {
  AGY_MODEL_RE,
  AGY_NO_TOOLS_NOTE,
  sanitizeAgyModel,
  resolveAgyBin,
  buildAgyArgs,
  wrapAgyPrompt,
  parseAgyModelsOutput,
  mapAgyUsage,
  parseAgyStreamLine,
};
