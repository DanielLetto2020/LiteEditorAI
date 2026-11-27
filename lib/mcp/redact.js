// Санитизация, редактирование секретов и deny-list путей для MCP Hub.
'use strict';

const posixPath = require('path').posix;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BIDI_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const ANSI_OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_CSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\x1B[@-Z\\-_]/g;

const SECRET_KEY_RE = /^(?:pass(?:word|wd)?|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|secret[-_]?key|database[-_]?url|conn(?:ection)?[-_]?(?:str|string|url)?|dsn|auth(?:[-_]?token)?|jwt(?:[-_]?secret)?|encryption[-_]?key|client[-_]?secret|credential|cookie|session[-_]?id|salt|bearer)$/i;
const SENSITIVE_NAME_RE = /(?:pass(?:word|wd)?|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|secret[-_]?key|database[-_]?url|dsn|auth|jwt|credential|cookie|encryption|client[-_]?secret|cert[-_]?key)/i;

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URI_PASS_RE = /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?):\/\/[^:\s/@]+:)([^\s/]+)(@(?=[A-Za-z0-9.[\]-]+(?::\d+)?(?:[/?#\s,;'"`]|$)))/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const KNOWN_TOKEN_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{25,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const KV_SECRET_RE = /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|DATABASE_URL|CONNECTION_STRING|DSN|AUTH_TOKEN|JWT_SECRET|ENCRYPTION_KEY|CLIENT_SECRET)[A-Za-z0-9_]*)\s*([=:])\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;'"`}\]]+))/gi;

/**
 * Обрезать строку по UTF-8 байтам без разрыва многобайтовых символов.
 * @param {string} str
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean, bytes: number }}
 */
function truncateUtf8(str, maxBytes) {
  const s = String(str == null ? '' : str);
  const buf = Buffer.from(s, 'utf8');
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : 0;
  if (!limit || buf.length <= limit) return { text: s, truncated: false, bytes: buf.length };
  let cut = buf.subarray(0, limit).toString('utf8');
  while (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return { text: cut + '\n…[truncated]', truncated: true, bytes: buf.length };
}

/**
 * Очистить текст от ANSI/OSC/управляющих и BiDi-символов, с опциональной обрезкой.
 * @param {unknown} input
 * @param {number} [maxBytes=0]
 * @returns {string}
 */
function sanitizeText(input, maxBytes = 0) {
  let s = String(input == null ? '' : input);
  s = s.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '').replace(ANSI_ESC_RE, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(CONTROL_RE, '').replace(BIDI_RE, '');
  if (maxBytes > 0) return truncateUtf8(s, maxBytes).text;
  return s;
}

/**
 * Замаскировать секреты (токены, пароли в URI, private keys, env secrets).
 * @param {unknown} input
 * @returns {string}
 */
function redactText(input) {
  let s = String(input == null ? '' : input);
  if (!s) return s;
  s = s.replace(PRIVATE_KEY_RE, '[PRIVATE KEY REDACTED]');
  s = s.replace(URI_PASS_RE, '$1[REDACTED]$3');
  s = s.replace(BEARER_RE, '$1 [REDACTED]');
  s = s.replace(KV_SECRET_RE, (m, k, sep, dq, sq, bare) => {
    const val = dq != null ? dq : (sq != null ? sq : bare);
    if (!val || /^\[[^\]]*REDACTED\]$/i.test(val) || /^\[REDACTED/i.test(val)) return m;
    if (dq != null) return `${k}${sep}"[REDACTED]"`;
    if (sq != null) return `${k}${sep}'[REDACTED]'`;
    return `${k}${sep}[REDACTED]`;
  });
  s = s.replace(KNOWN_TOKEN_RE, '[REDACTED]');
  return s;
}

/**
 * Отредактировать список env-переменных Docker/Podman или объект окружения.
 * @param {string[] | Record<string, any> | null | undefined} env
 * @returns {string[] | Record<string, any>}
 */
function redactEnv(env) {
  if (Array.isArray(env)) {
    return env.map((entry) => {
      const s = sanitizeText(entry);
      const eq = s.indexOf('=');
      if (eq <= 0) return redactText(s);
      const k = s.slice(0, eq);
      const v = s.slice(eq + 1);
      if (!v) return s;
      if (SENSITIVE_NAME_RE.test(k)) return `${k}=[REDACTED]`;
      return `${k}=${redactText(v)}`;
    });
  }
  if (env && typeof env === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      if (v == null || v === '') { out[k] = v; continue; }
      if (SENSITIVE_NAME_RE.test(k)) out[k] = '[REDACTED]';
      else out[k] = redactText(sanitizeText(v));
    }
    return out;
  }
  return [];
}

/**
 * Рекурсивно отредактировать объект/массив/строку.
 * @param {any} val
 * @param {{ maxStringBytes?: number, maxDepth?: number }} [opts]
 * @returns {any}
 */
function redactValue(val, opts = {}) {
  const maxStr = opts.maxStringBytes || 64 * 1024;
  const maxDepth = opts.maxDepth || 12;
  const seen = new WeakSet();

  /** @param {any} node @param {number} depth @returns {any} */
  function walk(node, depth) {
    if (node == null || typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'string') return sanitizeText(redactText(node), maxStr);
    if (typeof node !== 'object') return String(node);
    if (seen.has(node)) return '[Circular]';
    if (depth >= maxDepth) return '[MaxDepth]';
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Env' && Array.isArray(v)) {
        out[k] = redactEnv(v);
      } else if ((SECRET_KEY_RE.test(k) || SENSITIVE_NAME_RE.test(k)) && typeof v === 'string' && v.length > 0) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = walk(v, depth + 1);
      }
    }
    return out;
  }

  return walk(val, 0);
}

const SENSITIVE_EXACT_PATHS = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/master.passwd',
  '/etc/security/opasswd',
];

const SENSITIVE_PREFIXES = [
  '/etc/sudoers.d/',
  '/var/run/secrets/',
  '/run/secrets/',
];

const SENSITIVE_BASENAMES = new Set([
  '.netrc',
  '.pgpass',
  '.my.cnf',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.htpasswd',
  'authorized_keys',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'credentials.json',
]);

const ENV_SAFE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.schema'];

/**
 * Проверить путь на принадлежность к deny-list чувствительных файлов.
 * @param {string} rawPath
 * @returns {{ blocked: boolean, norm: string, reason?: string }}
 */
function isSensitivePath(rawPath) {
  const cleaned = String(rawPath || '').replace(/\0/g, '').trim();
  const norm = posixPath.normalize('/' + cleaned.replace(/^\/+/, ''));
  const low = norm.toLowerCase();
  const base = posixPath.basename(low);

  if (SENSITIVE_EXACT_PATHS.includes(low)) {
    return { blocked: true, norm, reason: 'Доступ к системному файлу учётных данных запрещён' };
  }
  if (SENSITIVE_PREFIXES.some((p) => low.startsWith(p))) {
    return { blocked: true, norm, reason: 'Доступ к каталогу секретов запрещён' };
  }
  if (/^\/proc\/(?:\d+|self|thread-self)\/(?:environ|mem|maps|pagemap|syscall)$/.test(low)) {
    return { blocked: true, norm, reason: 'Доступ к окружению и памяти процесса /proc запрещён' };
  }
  if (/^\/etc\/ssh\/ssh_host_/.test(low) || /\/\.ssh\/id_/.test(low) || /\/\.ssh\/.*key$/.test(low)) {
    return { blocked: true, norm, reason: 'Доступ к приватным SSH-ключам запрещён' };
  }
  if (/\/\.docker\/config\.json$/.test(low) || /\/\.kube\/config$/.test(low) || /\/\.aws\/(?:credentials|config)$/.test(low)) {
    return { blocked: true, norm, reason: 'Доступ к файлу облачных/реестровых токенов запрещён' };
  }
  if (SENSITIVE_BASENAMES.has(base)) {
    return { blocked: true, norm, reason: 'Доступ к файлу учётных данных запрещён' };
  }
  if ((base === '.env' || base.startsWith('.env.')) && !ENV_SAFE_SUFFIXES.some((sfx) => base.endsWith(sfx))) {
    return { blocked: true, norm, reason: 'Доступ к .env файлам запрещён политикой безопасности' };
  }
  if (/\.(?:pem|key|p12|pfx|jks|kdbx|ppk)$/.test(base)) {
    return { blocked: true, norm, reason: 'Доступ к файлам приватных ключей и хранилищ запрещён' };
  }
  return { blocked: false, norm };
}

module.exports = {
  truncateUtf8,
  sanitizeText,
  redactText,
  redactEnv,
  redactValue,
  isSensitivePath,
};
