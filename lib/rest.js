// Бэкенд модуля «HTTP-клиент»: шифрование секретов через safeStorage, выполнение запросов, импорт/экспорт.
'use strict';

const fs = require('fs');
const { executeRequest, probeLocalEndpoints } = require('./rest-http');
const { interpolate, interpolateHeaders, parseCurl, toCurl, parseHttpFile, toHttpFile, parseOpenApiSpec } = require('./rest-formats');

let _safe = null;
function setSafe(s) { _safe = s; }

function enc(text) {
  if (!text) return '';
  try { if (_safe && _safe.isEncryptionAvailable()) return 'v1:' + _safe.encryptString(String(text)).toString('base64'); } catch (_) {}
  return 'b64:' + Buffer.from(String(text), 'utf8').toString('base64');
}

function dec(blob) {
  if (!blob) return '';
  try {
    if (String(blob).startsWith('v1:')) return _safe.decryptString(Buffer.from(String(blob).slice(3), 'base64'));
    if (String(blob).startsWith('b64:')) return Buffer.from(String(blob).slice(4), 'base64').toString('utf8');
  } catch (_) {}
  return '';
}

function sanitizeData(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    collections: Array.isArray(d.collections) ? d.collections : [],
    environments: Array.isArray(d.environments) ? d.environments : [],
    history: Array.isArray(d.history) ? d.history : [],
  };
}

function projectAuthForUi(auth) {
  if (!auth || typeof auth !== 'object') return { type: 'none' };
  const out = { type: auth.type || 'none' };
  if (auth.user) out.user = auth.user;
  if (auth.apiKeyName) out.apiKeyName = auth.apiKeyName;
  if (auth.apiKeyIn) out.apiKeyIn = auth.apiKeyIn;
  out.hasSecret = !!(auth.tokenEnc || auth.passEnc || auth.apiKeyEnc);
  return out;
}

function projectForUi(data) {
  return {
    collections: data.collections.map((c) => ({
      ...c,
      items: (Array.isArray(c.items) ? c.items : []).map((it) => ({
        ...it,
        auth: projectAuthForUi(it.auth),
      })),
    })),
    environments: data.environments.map((e) => ({
      id: e.id,
      name: e.name,
      projectId: e.projectId || '__global__',
      vars: (Array.isArray(e.vars) ? e.vars : []).map((v) => ({
        key: v.key || '',
        secret: !!v.secret,
        value: v.secret ? '' : (v.value || ''),
        hasSecret: !!(v.secret && v.valueEnc),
      })),
    })),
    history: data.history,
  };
}

function encodeAuth(nextAuth, prevAuth) {
  const a = nextAuth && typeof nextAuth === 'object' ? nextAuth : { type: 'none' };
  const prev = prevAuth && typeof prevAuth === 'object' ? prevAuth : {};
  const out = { type: a.type || 'none' };
  if (a.type === 'bearer') {
    out.tokenEnc = a.token != null && a.token !== '' ? enc(a.token) : (a.token === '' ? '' : (prev.tokenEnc || ''));
  } else if (a.type === 'basic') {
    out.user = String(a.user || '');
    out.passEnc = a.pass != null && a.pass !== '' ? enc(a.pass) : (a.pass === '' ? '' : (prev.passEnc || ''));
  } else if (a.type === 'apikey') {
    out.apiKeyName = String(a.apiKeyName || 'X-API-Key');
    out.apiKeyIn = a.apiKeyIn === 'query' ? 'query' : 'header';
    out.apiKeyEnc = a.apiKeyValue != null && a.apiKeyValue !== '' ? enc(a.apiKeyValue) : (a.apiKeyValue === '' ? '' : (prev.apiKeyEnc || ''));
  }
  return out;
}

function registerRestIpc({ ipcMain, safeStorage, dialog, getData, setData, getProjectPorts }) {
  setSafe(safeStorage);
  const readAll = () => sanitizeData(getData());
  const writeAll = (next) => { setData(next); return next; };

  /** @type {Map<string, AbortController>} */
  const inflight = new Map();

  function resolveEnvVars(data, envId) {
    const vars = {};
    if (!envId) return vars;
    const env = data.environments.find((e) => e.id === envId);
    if (!env || !Array.isArray(env.vars)) return vars;
    for (const v of env.vars) {
      if (!v || !v.key) continue;
      vars[v.key] = v.secret ? dec(v.valueEnc) : String(v.value || '');
    }
    return vars;
  }

  function findStoredItemAuth(data, colId, itemId) {
    if (!colId || !itemId) return null;
    const col = data.collections.find((c) => c.id === colId);
    const it = col && Array.isArray(col.items) ? col.items.find((x) => x.id === itemId) : null;
    return it && it.auth ? it.auth : null;
  }

  ipcMain.handle('rest:load', () => ({ ok: true, data: projectForUi(readAll()) }));

  ipcMain.handle('rest:saveCollection', (_e, /** @type {any} */ { collection } = {}) => {
    if (!collection || typeof collection !== 'object') return { ok: false, error: 'Нет коллекции' };
    const data = readAll();
    const id = collection.id || ('rc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const prevCol = data.collections.find((c) => c.id === id);
    const prevById = new Map((prevCol && Array.isArray(prevCol.items) ? prevCol.items : []).map((it) => [it.id, it]));
    const rec = {
      id,
      name: String(collection.name || 'Новая коллекция').slice(0, 120),
      projectId: String(collection.projectId || '__global__'),
      items: (Array.isArray(collection.items) ? collection.items : []).map((it) => {
        const iid = it.id || ('ri' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        const prevItem = prevById.get(iid);
        return {
          ...it,
          id: iid,
          auth: encodeAuth(it.auth, prevItem && prevItem.auth),
        };
      }),
    };
    const idx = data.collections.findIndex((c) => c.id === id);
    if (idx >= 0) data.collections[idx] = rec; else data.collections.push(rec);
    writeAll(data);
    return { ok: true, id, data: projectForUi(data) };
  });

  ipcMain.handle('rest:deleteCollection', (_e, /** @type {any} */ { id } = {}) => {
    const data = readAll();
    data.collections = data.collections.filter((c) => c.id !== id);
    writeAll(data);
    return { ok: true, data: projectForUi(data) };
  });

  ipcMain.handle('rest:saveEnv', (_e, /** @type {any} */ { env } = {}) => {
    if (!env || typeof env !== 'object') return { ok: false, error: 'Нет окружения' };
    const data = readAll();
    const id = env.id || ('re' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const prevEnv = data.environments.find((e) => e.id === id);
    const prevMap = new Map((prevEnv && Array.isArray(prevEnv.vars) ? prevEnv.vars : []).map((v) => [v.key, v]));
    const rec = {
      id,
      name: String(env.name || 'Окружение').slice(0, 80),
      projectId: String(env.projectId || '__global__'),
      vars: (Array.isArray(env.vars) ? env.vars : [])
        .filter((v) => v && v.key)
        .map((v) => {
          const prevV = prevMap.get(v.key);
          if (v.secret) {
            const valEnc = v.value !== undefined && v.value !== '' ? enc(v.value) : (v.value === '' && !v.keepSecret ? '' : (prevV && prevV.valueEnc) || '');
            return { key: String(v.key).trim(), secret: true, valueEnc: valEnc };
          }
          return { key: String(v.key).trim(), secret: false, value: String(v.value || '') };
        }),
    };
    const idx = data.environments.findIndex((e) => e.id === id);
    if (idx >= 0) data.environments[idx] = rec; else data.environments.push(rec);
    writeAll(data);
    return { ok: true, id, data: projectForUi(data) };
  });

  ipcMain.handle('rest:deleteEnv', (_e, /** @type {any} */ { id } = {}) => {
    const data = readAll();
    data.environments = data.environments.filter((e) => e.id !== id);
    writeAll(data);
    return { ok: true, data: projectForUi(data) };
  });

  ipcMain.handle('rest:send', async (_e, /** @type {any} */ { reqId, request, envId, colId, itemId } = {}) => {
    if (!request || !request.url) return { ok: false, error: 'Укажите URL запроса' };
    const data = readAll();
    const vars = resolveEnvVars(data, envId);
    const storedAuth = findStoredItemAuth(data, colId, itemId);

    const method = String(request.method || 'GET').toUpperCase();
    let finalUrl = interpolate(String(request.url || '').trim(), vars);
    if (!/^https?:\/\//i.test(finalUrl)) finalUrl = 'http://' + finalUrl;

    // Params
    if (Array.isArray(request.params) && request.params.length) {
      try {
        const u = new URL(finalUrl);
        for (const p of request.params) {
          if (!p || p.enabled === false || !p.key) continue;
          u.searchParams.append(interpolate(String(p.key), vars), interpolate(String(p.value || ''), vars));
        }
        finalUrl = u.toString();
      } catch (_) {}
    }

    const headers = interpolateHeaders(request.headers, vars);

    // Auth
    const auth = request.auth && typeof request.auth === 'object' ? request.auth : { type: 'none' };
    if (auth.type === 'bearer') {
      const tok = auth.token != null && auth.token !== '' ? auth.token : dec(storedAuth && storedAuth.tokenEnc);
      if (tok) headers.Authorization = `Bearer ${interpolate(tok, vars)}`;
    } else if (auth.type === 'basic') {
      const usr = interpolate(String(auth.user || (storedAuth && storedAuth.user) || ''), vars);
      const pw = auth.pass != null && auth.pass !== '' ? auth.pass : dec(storedAuth && storedAuth.passEnc);
      headers.Authorization = 'Basic ' + Buffer.from(`${usr}:${interpolate(pw, vars)}`, 'utf8').toString('base64');
    } else if (auth.type === 'apikey') {
      const name = String(auth.apiKeyName || (storedAuth && storedAuth.apiKeyName) || 'X-API-Key');
      const val = auth.apiKeyValue != null && auth.apiKeyValue !== '' ? auth.apiKeyValue : dec(storedAuth && storedAuth.apiKeyEnc);
      const inWhere = auth.apiKeyIn || (storedAuth && storedAuth.apiKeyIn) || 'header';
      if (val) {
        const resolved = interpolate(val, vars);
        if (inWhere === 'query') {
          try { const u = new URL(finalUrl); u.searchParams.set(name, resolved); finalUrl = u.toString(); } catch (_) {}
        } else {
          headers[name] = resolved;
        }
      }
    }

    // Body
    let body = null;
    const bm = request.bodyMode || 'none';
    if (bm === 'graphql') {
      let variables = {};
      try { variables = JSON.parse(interpolate(String(request.graphqlVars || '{}'), vars) || '{}'); } catch (_) {}
      body = JSON.stringify({ query: interpolate(String(request.graphqlQuery || ''), vars), variables });
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    } else if (bm !== 'none' && request.body != null) {
      body = interpolate(String(request.body), vars);
      if (bm === 'json' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      } else if (bm === 'form' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    const ctrl = new AbortController();
    if (reqId) inflight.set(String(reqId), ctrl);
    try {
      const res = await executeRequest({
        method,
        url: finalUrl,
        headers,
        body,
        timeoutMs: request.timeoutMs,
        followRedirects: request.followRedirects !== false,
        rejectUnauthorized: request.rejectUnauthorized !== false,
      }, { signal: ctrl.signal });

      data.history.unshift({
        id: 'rh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        ts: Date.now(),
        method,
        url: finalUrl.split('?')[0] + (finalUrl.includes('?') ? '?…' : ''),
        status: res.status,
        totalMs: res.timing.totalMs,
        bytes: res.bytes,
      });
      if (data.history.length > 50) data.history.length = 50;
      writeAll(data);

      return { ok: true, response: res, history: data.history };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (reqId) inflight.delete(String(reqId));
    }
  });

  ipcMain.handle('rest:abort', (_e, /** @type {any} */ { reqId } = {}) => {
    const c = inflight.get(String(reqId || ''));
    if (c) { try { c.abort(); } catch (_) {} inflight.delete(String(reqId)); }
    return { ok: true };
  });

  ipcMain.handle('rest:clearHistory', () => {
    const data = readAll();
    data.history = [];
    writeAll(data);
    return { ok: true };
  });

  ipcMain.handle('rest:importText', (_e, /** @type {any} */ { text, format = 'auto', baseUrl } = {}) => {
    try {
      const raw = String(text || '').trim();
      if (!raw) return { ok: false, error: 'Пустой текст для импорта' };
      let fmt = format;
      if (fmt === 'auto') {
        if (/^curl(?:\.exe)?\s+/i.test(raw)) fmt = 'curl';
        else if (/^\s*###|\b(GET|POST|PUT|PATCH|DELETE)\s+https?:\/\//m.test(raw)) fmt = 'http';
        else fmt = 'openapi';
      }
      if (fmt === 'curl') return { ok: true, kind: 'requests', requests: [parseCurl(raw)] };
      if (fmt === 'http') return { ok: true, kind: 'requests', ...parseHttpFile(raw) };
      if (fmt === 'openapi') return { ok: true, kind: 'collection', ...parseOpenApiSpec(raw, baseUrl) };
      return { ok: false, error: `Неизвестный формат: ${fmt}` };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('rest:importFile', async (e) => {
    try {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, {
        title: 'Импорт коллекции (.http, OpenAPI JSON/YAML)',
        filters: [{ name: 'API Specs & HTTP', extensions: ['json', 'yaml', 'yml', 'http', 'rest', 'txt'] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true };
      const p = r.filePaths[0];
      const st = fs.statSync(p);
      if (st.size > 4 * 1024 * 1024) return { ok: false, error: 'Файл больше 4 МБ' };
      return { ok: true, filePath: p, content: fs.readFileSync(p, 'utf8') };
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2) };
    }
  });

  ipcMain.handle('rest:exportText', (_e, /** @type {any} */ { format = 'curl', request, requests, vars } = {}) => {
    if (format === 'http') return { ok: true, text: toHttpFile(requests || (request ? [request] : [])) };
    return { ok: true, text: toCurl(request || {}, vars || {}) };
  });

  ipcMain.handle('rest:discoverLocal', async (_e, /** @type {any} */ { projectId } = {}) => {
    try {
      const ports = typeof getProjectPorts === 'function' ? await getProjectPorts(projectId) : [];
      const endpoints = await probeLocalEndpoints(ports);
      return { ok: true, endpoints };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), endpoints: [] };
    }
  });

  return {
    abortAll: () => {
      for (const c of inflight.values()) { try { c.abort(); } catch (_) {} }
      inflight.clear();
    },
  };
}

module.exports = { registerRestIpc };
