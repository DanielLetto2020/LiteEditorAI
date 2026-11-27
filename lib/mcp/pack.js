// Декларативный контракт MCP-пака и валидатор JSON-Schema входных параметров.
'use strict';

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const PACK_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const ALLOWED_MODES = new Set(['read', 'write', 'exec', 'admin']);
const ALLOWED_RESOURCE_TYPES = new Set([
  'db', 'server', 'rh', 'container',
  'rmq', 'kafka', 'storage', 'jira', 'project',
  'none',
]);

/**
 * Проверить значение по облегчённой JSON-Schema.
 * @param {Record<string, any> | null | undefined} schema
 * @param {any} input
 * @param {string} [at='$']
 * @returns {{ ok: boolean, value?: any, error?: string }}
 */
function validateInput(schema, input, at = '$') {
  if (!schema || typeof schema !== 'object') return { ok: true, value: input };

  let val = input;
  if (val === undefined && schema.default !== undefined) val = schema.default;

  if (schema.enum && !schema.enum.includes(val)) {
    return { ok: false, error: `${at}: значение должно быть одним из (${schema.enum.join(', ')})` };
  }

  const t = schema.type;
  if (!t) return { ok: true, value: val };

  if (t === 'string') {
    if (typeof val !== 'string') return { ok: false, error: `${at}: ожидается строка` };
    if (schema.minLength != null && val.length < schema.minLength) return { ok: false, error: `${at}: минимальная длина ${schema.minLength}` };
    if (schema.maxLength != null && val.length > schema.maxLength) return { ok: false, error: `${at}: максимальная длина ${schema.maxLength}` };
    if (schema.pattern) {
      const re = schema.pattern instanceof RegExp ? schema.pattern : new RegExp(schema.pattern);
      if (!re.test(val)) return { ok: false, error: `${at}: строка не соответствует формату` };
    }
    return { ok: true, value: val };
  }

  if (t === 'number' || t === 'integer') {
    if (typeof val !== 'number' || !Number.isFinite(val)) return { ok: false, error: `${at}: ожидается число` };
    if (t === 'integer' && !Number.isInteger(val)) return { ok: false, error: `${at}: ожидается целое число` };
    if (schema.minimum != null && val < schema.minimum) return { ok: false, error: `${at}: значение < ${schema.minimum}` };
    if (schema.maximum != null && val > schema.maximum) return { ok: false, error: `${at}: значение > ${schema.maximum}` };
    return { ok: true, value: val };
  }

  if (t === 'boolean') {
    if (typeof val !== 'boolean') return { ok: false, error: `${at}: ожидается boolean` };
    return { ok: true, value: val };
  }

  if (t === 'array') {
    if (!Array.isArray(val)) return { ok: false, error: `${at}: ожидается массив` };
    if (schema.minItems != null && val.length < schema.minItems) return { ok: false, error: `${at}: минимум ${schema.minItems} элементов` };
    if (schema.maxItems != null && val.length > schema.maxItems) return { ok: false, error: `${at}: максимум ${schema.maxItems} элементов` };
    const out = [];
    for (let i = 0; i < val.length; i++) {
      const r = validateInput(schema.items, val[i], `${at}[${i}]`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }

  if (t === 'object') {
    const src = val == null ? {} : val;
    if (typeof src !== 'object' || Array.isArray(src)) return { ok: false, error: `${at}: ожидается объект` };
    const props = schema.properties || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    for (const k of req) {
      if (src[k] === undefined || src[k] === null || (props[k] && props[k].type === 'string' && src[k] === '')) {
        return { ok: false, error: `${at}: отсутствует обязательное поле «${k}»` };
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(src)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          return { ok: false, error: `${at}: неизвестный параметр «${k}»` };
        }
      }
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (src[k] === undefined) {
        if (propSchema && propSchema.default !== undefined) out[k] = propSchema.default;
        continue;
      }
      const r = validateInput(propSchema, src[k], `${at}.${k}`);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    if (schema.additionalProperties !== false) {
      for (const k of Object.keys(src)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) out[k] = src[k];
      }
    }
    return { ok: true, value: out };
  }

  return { ok: true, value: val };
}

/**
 * Описать и провалидировать MCP-пак.
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {string} [spec.version]
 * @param {boolean} [spec.defaultEnabled]
 * @param {string[]} [spec.scopes]
 * @param {(deps: any) => Promise<any[]>} [spec.resolveResources]
 * @param {Array<{ name: string, title?: string, description: string, mode?: string, resourceType?: string, inputSchema?: Record<string, any>, extractResource?: (args: any, deps?: any, session?: any) => any, handler: (args: any, ctx: any) => Promise<any> }>} spec.tools
 */
function defineMcpPack(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineMcpPack: spec обязателен');
  if (!PACK_ID_RE.test(String(spec.id || ''))) throw new Error(`defineMcpPack: некорректный id "${spec.id}"`);
  if (!spec.name || !spec.description) throw new Error(`defineMcpPack(${spec.id}): name и description обязательны`);
  if (!Array.isArray(spec.tools) || !spec.tools.length) throw new Error(`defineMcpPack(${spec.id}): нужен хотя бы один tool`);

  const seen = new Set();
  const tools = spec.tools.map((t) => {
    if (!t || !TOOL_NAME_RE.test(String(t.name || ''))) {
      throw new Error(`defineMcpPack(${spec.id}): некорректное имя tool "${t && t.name}"`);
    }
    if (seen.has(t.name)) throw new Error(`defineMcpPack(${spec.id}): дубль tool "${t.name}"`);
    seen.add(t.name);
    const mode = t.mode || 'read';
    if (!ALLOWED_MODES.has(mode)) throw new Error(`defineMcpPack(${spec.id}/${t.name}): неизвестный mode "${mode}"`);
    const resourceType = t.resourceType || 'none';
    if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) {
      throw new Error(`defineMcpPack(${spec.id}/${t.name}): неизвестный resourceType "${resourceType}"`);
    }
    if (typeof t.handler !== 'function') throw new Error(`defineMcpPack(${spec.id}/${t.name}): handler обязателен`);
    return Object.freeze({
      name: t.name,
      title: t.title || t.name,
      description: String(t.description || ''),
      mode,
      resourceType,
      inputSchema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
      extractResource: typeof t.extractResource === 'function' ? t.extractResource : null,
      handler: t.handler,
    });
  });

  return Object.freeze({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version || '1.0.0',
    defaultEnabled: spec.defaultEnabled !== false,
    scopes: Array.isArray(spec.scopes) ? spec.scopes.slice() : ['read'],
    resolveResources: typeof spec.resolveResources === 'function' ? spec.resolveResources : async () => [],
    tools: Object.freeze(tools),
  });
}

module.exports = {
  defineMcpPack,
  validateInput,
};
