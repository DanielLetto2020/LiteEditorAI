// Чистый модуль форматов для HTTP-клиента: {{var}} интерполяция, cURL, .http и OpenAPI 3 / Swagger 2.
'use strict';

const yaml = require('js-yaml');

const MAX_VAR_VALUE = 16384;

/**
 * Подстановка переменных формата {{name}} без рекурсивного раскрытия.
 * Неизвестные переменные сохраняются как есть.
 * @param {string} str
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function interpolate(str, vars) {
  if (typeof str !== 'string' || !str) return str == null ? '' : String(str);
  if (!vars || typeof vars !== 'object') return str;
  return str.replace(/\{\{([\w.-]+)\}\}/g, (m, k) => {
    if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null) {
      return String(vars[k]).slice(0, MAX_VAR_VALUE);
    }
    return m;
  });
}

function interpolateHeaders(headers, vars) {
  const out = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || h.enabled === false || !h.key) continue;
      out[interpolate(String(h.key).trim(), vars)] = interpolate(String(h.value == null ? '' : h.value), vars);
    }
    return out;
  }
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (!k || v == null) continue;
      out[interpolate(k.trim(), vars)] = interpolate(String(v), vars);
    }
  }
  return out;
}

/**
 * Простая токенизация shell-строки (поддержка '...', "...", \экранирования).
 * @param {string} input
 * @returns {string[]}
 */
function tokenizeShell(input) {
  const tokens = [];
  const s = String(input || '').replace(/\\\r?\n/g, ' ');
  let cur = '';
  let inCur = false;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (q === "'" && ch === "'") { q = ''; continue; }
      if (q === '"' && ch === '"') { q = ''; continue; }
      if (q === '"' && ch === '\\' && i + 1 < s.length && ('"\\$`'.includes(s[i + 1]))) {
        cur += s[++i];
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      inCur = true;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      inCur = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inCur || cur) { tokens.push(cur); cur = ''; inCur = false; }
      continue;
    }
    cur += ch;
    inCur = true;
  }
  if (inCur || cur) tokens.push(cur);
  return tokens;
}

/**
 * Разобрать команду cURL в объект запроса.
 * @param {string} cmd
 */
function parseCurl(cmd) {
  const tokens = tokenizeShell(cmd);
  if (!tokens.length) throw new Error('Пустая строка cURL');
  let i = 0;
  if (/^(curl|curl\.exe)$/i.test(tokens[0])) i = 1;

  let method = '';
  let url = '';
  /** @type {Array<{ key: string, value: string, enabled: boolean }>} */
  const headers = [];
  const dataParts = [];
  let auth = { type: 'none' };
  let insecure = false;

  const takeNext = () => (i + 1 < tokens.length ? tokens[++i] : '');

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') {
      method = takeNext().toUpperCase();
    } else if (t.startsWith('-X') && t.length > 2) {
      method = t.slice(2).toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const hv = takeNext();
      const idx = hv.indexOf(':');
      if (idx > 0) {
        headers.push({ key: hv.slice(0, idx).trim(), value: hv.slice(idx + 1).trim(), enabled: true });
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') {
      dataParts.push(takeNext());
    } else if (t === '-u' || t === '--user') {
      const pair = takeNext();
      const idx = pair.indexOf(':');
      auth = idx >= 0
        ? { type: 'basic', user: pair.slice(0, idx), pass: pair.slice(idx + 1) }
        : { type: 'basic', user: pair, pass: '' };
    } else if (t === '-k' || t === '--insecure') {
      insecure = true;
    } else if (t === '-L' || t === '--location' || t === '-s' || t === '--silent' || t === '-i' || t === '--include' || t === '-v' || t === '--verbose') {
      continue;
    } else if (t === '-A' || t === '--user-agent') {
      headers.push({ key: 'User-Agent', value: takeNext(), enabled: true });
    } else if (t === '-e' || t === '--referer') {
      headers.push({ key: 'Referer', value: takeNext(), enabled: true });
    } else if (t === '-b' || t === '--cookie') {
      headers.push({ key: 'Cookie', value: takeNext(), enabled: true });
    } else if (!t.startsWith('-') && !url) {
      url = t;
    } else if (/^https?:\/\//i.test(t) && !url) {
      url = t;
    }
  }

  if (!url) throw new Error('В команде cURL не найден URL');
  const body = dataParts.join('&');
  if (!method) method = body ? 'POST' : 'GET';

  let bodyMode = 'none';
  if (body) {
    const ct = headers.find((h) => h.key.toLowerCase() === 'content-type');
    if ((ct && /json/i.test(ct.value)) || /^\s*[[{]/.test(body)) bodyMode = 'json';
    else if (ct && /x-www-form-urlencoded/i.test(ct.value)) bodyMode = 'form';
    else bodyMode = 'raw';
  }

  return {
    name: url.replace(/^https?:\/\/[^/]+/, '') || url,
    method,
    url,
    headers,
    auth,
    bodyMode,
    body,
    insecure,
  };
}

function sq(val) {
  return `'${String(val || '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Сгенерировать команду cURL из объекта запроса.
 * @param {any} req
 * @param {Record<string, string>} [vars]
 * @returns {string}
 */
function toCurl(req, vars) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  const url = interpolate((req && req.url) || '', vars);
  const parts = [`curl -X ${method} ${sq(url)}`];
  const hdrs = interpolateHeaders(req && req.headers, vars);
  for (const [k, v] of Object.entries(hdrs)) {
    parts.push(`-H ${sq(`${k}: ${v}`)}`);
  }
  const bodyMode = (req && req.bodyMode) || 'none';
  if (bodyMode === 'graphql') {
    const payload = JSON.stringify({
      query: interpolate((req && req.graphqlQuery) || '', vars),
      variables: (() => {
        try { return JSON.parse(interpolate((req && req.graphqlVars) || '{}', vars)); }
        catch (_) { return {}; }
      })(),
    });
    if (!Object.keys(hdrs).some((k) => k.toLowerCase() === 'content-type')) {
      parts.push(`-H ${sq('Content-Type: application/json')}`);
    }
    parts.push(`--data-raw ${sq(payload)}`);
  } else if (bodyMode !== 'none' && req && req.body) {
    parts.push(`--data-raw ${sq(interpolate(req.body, vars))}`);
  }
  if (req && req.insecure) parts.push('-k');
  return parts.join(' \\\n  ');
}

/**
 * Разобрать файл .http (REST Client) в переменные и массив запросов.
 * @param {string} text
 */
function parseHttpFile(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  /** @type {Record<string, string>} */
  const vars = {};
  const blocks = [];
  let cur = [];

  for (const line of lines) {
    if (/^\s*###/.test(line)) {
      if (cur.length) blocks.push(cur);
      cur = [line.replace(/^\s*###\s*/, '').trim()];
      continue;
    }
    const vm = !cur.length && line.match(/^\s*@([\w.-]+)\s*=\s*(.*)$/);
    if (vm) {
      vars[vm[1]] = vm[2].trim();
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);

  const requests = [];
  for (const blk of blocks) {
    let title = '';
    let idx = 0;
    if (blk.length && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.test(blk[0]) && !/^\s*(?:#|\/\/)/.test(blk[0])) {
      title = blk[0];
      idx = 1;
    }
    while (idx < blk.length && (!blk[idx].trim() || /^\s*(?:#|\/\/|@)/.test(blk[idx]))) {
      const m = blk[idx].match(/^\s*@([\w.-]+)\s*=\s*(.*)$/);
      if (m) vars[m[1]] = m[2].trim();
      idx++;
    }
    if (idx >= blk.length) continue;
    const reqLine = blk[idx].trim();
    const rm = reqLine.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+?)(?:\s+HTTP\/[\d.]+)?$/i);
    if (!rm) continue;

    const method = rm[1].toUpperCase();
    const url = rm[2].trim();
    const headers = [];
    idx++;
    while (idx < blk.length && blk[idx].trim() !== '') {
      const hl = blk[idx];
      if (!/^\s*(?:#|\/\/)/.test(hl)) {
        const ci = hl.indexOf(':');
        if (ci > 0) headers.push({ key: hl.slice(0, ci).trim(), value: hl.slice(ci + 1).trim(), enabled: true });
      }
      idx++;
    }
    while (idx < blk.length && blk[idx].trim() === '') idx++;
    const body = blk.slice(idx).join('\n').trimEnd();
    let bodyMode = 'none';
    if (body) {
      const ct = headers.find((h) => h.key.toLowerCase() === 'content-type');
      if ((ct && /json/i.test(ct.value)) || /^\s*[[{]/.test(body)) bodyMode = 'json';
      else bodyMode = 'raw';
    }
    requests.push({
      name: title || `${method} ${url}`,
      method,
      url,
      headers,
      bodyMode,
      body,
      auth: { type: 'none' },
    });
  }
  return { vars, requests };
}

/**
 * Экспорт массива запросов в .http файл.
 * @param {any[]} requests
 */
function toHttpFile(requests) {
  return (Array.isArray(requests) ? requests : []).map((r) => {
    const lines = [`### ${r.name || `${r.method || 'GET'} ${r.url || ''}`}`];
    lines.push(`${String(r.method || 'GET').toUpperCase()} ${r.url || ''}`);
    for (const h of (Array.isArray(r.headers) ? r.headers : [])) {
      if (h && h.enabled !== false && h.key) lines.push(`${h.key}: ${h.value || ''}`);
    }
    if (r.bodyMode && r.bodyMode !== 'none' && r.body) {
      lines.push('', r.body);
    }
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

function resolveRef(doc, obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return obj;
  if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/')) {
    const parts = obj.$ref.slice(2).split('/');
    let cur = doc;
    for (const p of parts) {
      const key = p.replace(/~1/g, '/').replace(/~0/g, '~');
      cur = cur && typeof cur === 'object' ? cur[key] : null;
    }
    if (cur && typeof cur === 'object') return resolveRef(doc, cur, depth + 1);
  }
  return obj;
}

function exampleFromSchema(doc, schema, depth = 0) {
  if (!schema || depth > 4) return null;
  const s = resolveRef(doc, schema, depth);
  if (!s || typeof s !== 'object') return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.type === 'object' || s.properties) {
    const out = {};
    for (const [k, v] of Object.entries(s.properties || {}).slice(0, 12)) {
      out[k] = exampleFromSchema(doc, v, depth + 1);
    }
    return out;
  }
  if (s.type === 'array') {
    const item = exampleFromSchema(doc, s.items, depth + 1);
    return item != null ? [item] : [];
  }
  if (s.type === 'integer' || s.type === 'number') return 0;
  if (s.type === 'boolean') return false;
  return '';
}

/**
 * Разобрать спецификацию OpenAPI 3.x или Swagger 2.0 (JSON или YAML) в коллекцию запросов.
 * @param {string} rawText
 * @param {string} [baseUrlOverride]
 */
function parseOpenApiSpec(rawText, baseUrlOverride = '') {
  let doc;
  const txt = String(rawText || '').trim();
  if (!txt) throw new Error('Пустая спецификация OpenAPI');
  try {
    doc = txt.startsWith('{') ? JSON.parse(txt) : yaml.load(txt);
  } catch (err) {
    throw new Error(`Не удалось разобрать OpenAPI/Swagger: ${err.message}`, { cause: err });
  }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    throw new Error('Документ не является OpenAPI 3 / Swagger 2 (отсутствует paths)');
  }

  let baseUrl = String(baseUrlOverride || '').replace(/\/+$/, '');
  if (!baseUrl) {
    if (Array.isArray(doc.servers) && doc.servers[0] && doc.servers[0].url) {
      baseUrl = String(doc.servers[0].url).replace(/\/+$/, '');
    } else if (doc.host) {
      const scheme = Array.isArray(doc.schemes) && doc.schemes[0] ? doc.schemes[0] : 'http';
      const bp = doc.basePath ? String(doc.basePath) : '';
      baseUrl = `${scheme}://${doc.host}${bp}`.replace(/\/+$/, '');
    }
  }
  const useVarBase = !baseUrl || baseUrl.startsWith('/');
  const originPrefix = useVarBase ? `{{baseUrl}}${baseUrl.startsWith('/') ? baseUrl : ''}` : baseUrl;

  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const requests = [];

  for (const [p, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const m of HTTP_METHODS) {
      const op = pathItem[m];
      if (!op || typeof op !== 'object') continue;
      const allParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((pr) => resolveRef(doc, pr));
      const qp = [];
      const headers = [];
      for (const pr of allParams) {
        if (!pr || !pr.name) continue;
        if (pr.in === 'query') qp.push(`${encodeURIComponent(pr.name)}=${encodeURIComponent(pr.example != null ? pr.example : '')}`);
        else if (pr.in === 'header') headers.push({ key: pr.name, value: String(pr.example != null ? pr.example : ''), enabled: true });
      }
      const queryStr = qp.length ? `?${qp.join('&')}` : '';
      let bodyMode = 'none';
      let body = '';

      if (op.requestBody) {
        const rb = resolveRef(doc, op.requestBody);
        const content = (rb && rb.content) || {};
        const jsonMedia = content['application/json'] || content['application/*+json'];
        if (jsonMedia) {
          headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
          const ex = jsonMedia.example !== undefined
            ? jsonMedia.example
            : (jsonMedia.schema ? exampleFromSchema(doc, jsonMedia.schema) : {});
          bodyMode = 'json';
          body = JSON.stringify(ex == null ? {} : ex, null, 2);
        }
      } else {
        const bodyParam = allParams.find((pr) => pr && pr.in === 'body' && pr.schema);
        if (bodyParam) {
          headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
          bodyMode = 'json';
          body = JSON.stringify(exampleFromSchema(doc, bodyParam.schema) || {}, null, 2);
        }
      }

      requests.push({
        name: op.summary || op.operationId || `${m.toUpperCase()} ${p}`,
        method: m.toUpperCase(),
        url: `${originPrefix}${p}${queryStr}`,
        headers,
        bodyMode,
        body,
        auth: { type: 'none' },
      });
    }
  }

  return {
    name: (doc.info && doc.info.title) || 'OpenAPI Collection',
    baseUrl: baseUrl && !baseUrl.startsWith('/') ? baseUrl : '',
    requests,
  };
}

module.exports = {
  interpolate,
  interpolateHeaders,
  tokenizeShell,
  parseCurl,
  toCurl,
  parseHttpFile,
  toHttpFile,
  parseOpenApiSpec,
};
