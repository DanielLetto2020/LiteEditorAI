// Разбор и отображение терминальных сообщений OSC 7501 (Program Status Protocol).
// Используется в renderer/term-core.js и покрывается тестами test/osc7501.test.js.
// Формат: ESC ] 7501 ; key=value:key=value (BEL | ST) или запрос поддержки ESC ] 7501 ; ? (BEL | ST).

'use strict';

const OSC7501_QUERY_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';
const OSC7501_STATES = new Set(['idle', 'working', 'blocked', 'done', 'error', 'clear']);
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Декодирует строку из Base64 / Base64URL в UTF-8 и очищает управляющие символы.
 * @param {string} raw
 * @returns {string}
 */
function decodeBase64Utf8(raw) {
  if (!raw || typeof raw !== 'string' || !BASE64_RE.test(raw)) return '';
  const norm = raw.replace(/-/g, '+').replace(/_/g, '/');
  if (norm.length % 4 === 1) return '';
  const pad = (4 - (norm.length % 4)) % 4;
  const padded = pad ? norm + '='.repeat(pad) : norm;
  try {
    let out = '';
    if (typeof Buffer !== 'undefined') {
      out = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      const bin = atob(padded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    return out.replace(/[\x00-\x1f\x7f]/g, '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Разбирает содержимое OSC 7501 (часть после `7501;` до терминатора).
 * @param {string} payload
 * @returns {{ type: 'query' } | {
 *   type: 'status',
 *   state: string,
 *   kind: string,
 *   app: string,
 *   id: string,
 *   msg: string,
 *   title: string,
 *   progress: number | null,
 * } | null}
 */
function parseOsc7501(payload) {
  if (typeof payload !== 'string') return null;
  const raw = payload.trim();
  if (!raw) return null;
  if (raw === '?') return { type: 'query' };

  /** @type {Record<string, string>} */
  const fields = Object.create(null);
  for (const part of raw.split(':')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    fields[key] = part.slice(eq + 1);
  }

  const state = String(fields.state || '').trim().toLowerCase();
  if (!state || !OSC7501_STATES.has(state)) return null;

  const kind = String(fields.kind || '').trim().toLowerCase();
  const app = String(fields.app || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  const id = String(fields.id || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const msg = fields.msg ? decodeBase64Utf8(fields.msg).slice(0, 240) : '';
  const title = fields.title ? decodeBase64Utf8(fields.title).slice(0, 120) : '';

  let progress = null;
  if (fields.progress !== undefined) {
    const rawProg = String(fields.progress).trim();
    if (/^\d{1,3}$/.test(rawProg)) {
      const n = Number(rawProg);
      if (n <= 100) progress = n;
    }
  }

  return { type: 'status', state, kind, app, id, msg, title, progress };
}

/**
 * Преобразует разобранный пакет OSC 7501 в действие над индикатором активности сессии.
 * Пакеты подзадач (с непустым `id`) игнорируются, чтобы не перетирать корневой статус сессии.
 * @param {ReturnType<typeof parseOsc7501>} parsed
 * @returns {{ action: 'clear' } | { action: 'set', indicator: 'busy' | 'waiting' | 'quiet', reason: string } | null}
 */
function mapOsc7501ToIndicator(parsed) {
  if (!parsed || parsed.type !== 'status') return null;
  if (parsed.id) return null;

  switch (parsed.state) {
    case 'clear':
      return { action: 'clear' };
    case 'working':
      return { action: 'set', indicator: 'busy', reason: '' };
    case 'blocked': {
      const reason = parsed.kind === 'permission'
        ? 'permission prompt'
        : parsed.kind === 'question'
          ? 'input needed'
          : parsed.kind === 'auth'
            ? 'auth needed'
            : '';
      return { action: 'set', indicator: 'waiting', reason };
    }
    case 'error':
      return { action: 'set', indicator: 'waiting', reason: 'error' };
    case 'idle':
    case 'done':
      return { action: 'set', indicator: 'quiet', reason: '' };
    default:
      return null;
  }
}

module.exports = {
  OSC7501_QUERY_REPLY,
  OSC7501_STATES,
  decodeBase64Utf8,
  parseOsc7501,
  mapOsc7501ToIndicator,
};
