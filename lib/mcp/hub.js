// Центральный Zero-Trust MCP Hub (UDS / Named Pipe, токены сессий, HITL, аудит, IPC, агенты).
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createRegistry } = require('./registry');
const { createAuditLog } = require('./audit');
const { validateInput } = require('./pack');
const { normalizeConfig, normalizeBinding, resolveProjectBinding, applyPreset, evaluateAccess } = require('./policy');
const { redactValue, sanitizeText } = require('./redact');

const { createDbPack } = require('./packs/db');
const { createServersPack } = require('./packs/servers');
const { createContainersPack } = require('./packs/containers');
const { createRmqPack } = require('./packs/rmq');
const { createKafkaPack } = require('./packs/kafka');
const { createStoragePack } = require('./packs/storage');
const { createJiraPack } = require('./packs/jira');
const { createTasksPack } = require('./packs/tasks');
const { createProjectsPack } = require('./packs/projects');

const MAX_INFLIGHT = 8;
const MAX_LINE_BYTES = 1024 * 1024;
const APPROVAL_TTL_MS = 60 * 1000;

/** @param {string} a @param {string} b */
function safeTokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** @param {any} clientInfo */
function inferAgentFromClient(clientInfo) {
  const nm = String((clientInfo && clientInfo.name) || '').toLowerCase();
  if (!nm) return null;
  if (nm.includes('claude')) return 'claude';
  if (nm.includes('antigravity') || nm.includes('agy')) return 'agy';
  if (nm.includes('codex') || nm.includes('openai')) return 'codex';
  if (nm.includes('gemini')) return 'gemini';
  if (nm.includes('ollama')) return 'ollama';
  if (nm.includes('lmstudio') || nm.includes('lm-studio')) return 'lmstudio';
  return null;
}

/** @param {string} sockPath */
function probeLiveSocket(sockPath) {
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    let done = false;
    const fin = (alive) => { if (!done) { done = true; try { c.destroy(); } catch (_) {} resolve(alive); } };
    c.once('connect', () => fin(true));
    c.once('error', () => fin(false));
    setTimeout(() => fin(false), 400);
  });
}

/**
 * Создать экземпляр MCP Hub.
 * @param {object} deps
 * @param {string} deps.storeDir
 * @param {() => any} deps.readConfig
 * @param {(v: any) => void} deps.writeConfig
 * @param {() => any} deps.readBindings
 * @param {(v: any) => void} deps.writeBindings
 * @param {() => any} [deps.getDbApi]
 * @param {any} [deps.serversApi]
 * @param {any} [deps.rhApi]
 * @param {() => any} [deps.getContainersApi]
 * @param {() => any} [deps.getRmqApi]
 * @param {() => any} [deps.getKafkaApi]
 * @param {() => any} [deps.getStorageApi]
 * @param {() => any} [deps.getJiraApi]
 * @param {any} [deps.tasksApi]
 * @param {any} [deps.gitHelpers]
 * @param {() => any[]} [deps.getProjects]
 * @param {(ch: string, payload: any) => void} [deps.broadcast]
 * @param {() => boolean} [deps.hasUi]
 * @param {(lvl: string, src: string, msg: string) => void} [deps.log]
 * @param {(cmd: string) => string | null} [deps.whichBin]
 * @param {() => Record<string, string>} [deps.cliEnv]
 * @param {string} [deps.socketPath]
 * @param {string} [deps.sourceBridgePath]
 * @param {boolean} [deps.syncBridge]
 * @param {any[]} [deps.packs]
 */
function createMcpHub(deps) {
  const storeDir = deps.storeDir;
  const socketPath = deps.socketPath || (process.platform === 'win32'
    ? `\\\\.\\pipe\\liteeditor-mcp-${process.pid}`
    : path.join(storeDir, 'run', 'mcp.sock'));
  const stableBridgePath = path.join(storeDir, 'mcp', 'lite-mcp-bridge.js');
  const defaultSourceBridge = path.join(__dirname, '..', '..', 'mcp', 'lite-mcp-bridge.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const sourceBridgePath = deps.sourceBridgePath || defaultSourceBridge;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};

  const registry = createRegistry(deps.packs || [
    createDbPack(),
    createServersPack(),
    createContainersPack(),
    createRmqPack(),
    createKafkaPack(),
    createStoragePack(),
    createJiraPack(),
    createTasksPack(),
    createProjectsPack(),
  ]);

  function buildRuntimeDeps() {
    return {
      getDbApi: deps.getDbApi || (() => null),
      serversApi: deps.serversApi || null,
      rhApi: deps.rhApi || null,
      getContainersApi: deps.getContainersApi || (() => null),
      getRmqApi: deps.getRmqApi || (() => null),
      getKafkaApi: deps.getKafkaApi || (() => null),
      getStorageApi: deps.getStorageApi || (() => null),
      getJiraApi: deps.getJiraApi || (() => null),
      tasksApi: deps.tasksApi || null,
      getProjects: deps.getProjects || (() => []),
      gitHelpers: deps.gitHelpers || null,
    };
  }

  const initCfg = normalizeConfig(deps.readConfig());
  const audit = createAuditLog({
    logsDir: deps.storeDir ? path.join(deps.storeDir, 'logs') : null,
    persistToDisk: initCfg.auditToDisk,
  });

  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Set<{ socket: net.Socket, token: string, send: (obj: any) => void }>} */
  const clients = new Set();
  /** @type {Map<string, any>} */
  const pendingApprovals = new Map();

  let server = null;
  let starting = null;
  let inFlight = 0;

  function emitUi(payload) {
    try { broadcast('mcp:event', payload); } catch (_) {}
  }

  function getConfig() {
    const raw = deps.readConfig();
    const norm = normalizeConfig(raw);
    const manualTokens = raw && raw.manualTokens && typeof raw.manualTokens === 'object' ? raw.manualTokens : {};
    return { ...norm, manualTokens };
  }

  function saveConfig(next) {
    const cur = getConfig();
    const norm = normalizeConfig(next);
    const manualTokens = next && next.manualTokens ? next.manualTokens : cur.manualTokens;
    deps.writeConfig({ ...norm, manualTokens });
    audit.setPersist(norm.auditToDisk);
    notifyToolsChanged();
    emitUi({ kind: 'config', config: publicConfig() });
    return publicConfig();
  }

  function publicConfig() {
    const c = getConfig();
    return {
      enabled: c.enabled,
      auditToDisk: c.auditToDisk,
      defaultPreset: c.defaultPreset,
      autoOpenPaneOnAsk: c.autoOpenPaneOnAsk,
      packs: c.packs,
      manualTokenCount: Object.keys(c.manualTokens || {}).length,
    };
  }

  function getBindings() {
    const raw = deps.readBindings();
    return raw && typeof raw === 'object' ? raw : {};
  }

  function saveProjectBinding(projectId, nextBinding) {
    const pid = String(projectId || '__global__');
    const all = { ...getBindings() };
    all[pid] = normalizeBinding(nextBinding);
    deps.writeBindings(all);
    emitUi({ kind: 'binding', projectId: pid, binding: all[pid] });
    notifyToolsChanged();
    return all[pid];
  }

  function applyProjectPreset(projectId, preset) {
    const pid = String(projectId || '__global__');
    const cur = resolveProjectBinding(getBindings(), pid, getConfig().defaultPreset);
    return saveProjectBinding(pid, applyPreset(cur, preset));
  }

  function notifyToolsChanged() {
    const payload = { type: 'notification', method: 'notifications/tools/list_changed', params: {} };
    for (const cl of clients) cl.send(payload);
    emitUi({ kind: 'tools_changed' });
  }

  function syncBridgeScript() {
    if (deps.syncBridge === false || !storeDir) return stableBridgePath;
    try {
      const src = fs.readFileSync(sourceBridgePath, 'utf8');
      fs.mkdirSync(path.dirname(stableBridgePath), { recursive: true, mode: 0o700 });
      let cur = '';
      try { cur = fs.readFileSync(stableBridgePath, 'utf8'); } catch (_) {}
      if (cur !== src) {
        fs.writeFileSync(stableBridgePath, src, { encoding: 'utf8', mode: 0o644 });
      }
    } catch (e) {
      log('warn', 'mcp', `Не удалось синхронизировать мост: ${e && e.message}`);
    }
    return stableBridgePath;
  }

  /** @param {string} rawToken */
  function findSessionByToken(rawToken) {
    for (const [tok, sess] of sessions) {
      if (safeTokenEq(tok, rawToken)) return sess;
    }
    // Проверяем сохранённые manual-токены из config (поддерживает перезапуск редактора)
    const cfg = getConfig();
    for (const [k, rec] of Object.entries(cfg.manualTokens || {})) {
      if (rec && rec.token && safeTokenEq(rec.token, rawToken)) {
        const s = {
          token: rec.token,
          sessionId: 'manual_' + k.replace(/[^a-z0-9_-]/gi, '_'),
          ptyId: '',
          projectId: rec.projectId || '__global__',
          projectName: rec.projectName || '',
          agentKind: rec.agentKind || 'unknown',
          packAllowlist: null,
          issuedAt: rec.issuedAt || Date.now(),
          lastUsedAt: Date.now(),
          connectedClients: 0,
          approvedKeys: new Set(),
          manual: true,
        };
        sessions.set(rec.token, s);
        return s;
      }
    }
    return null;
  }

  function issueSession({ ptyId = '', projectId = '__global__', projectName = '', agentKind = 'unknown', packAllowlist = null, manual = false } = {}) {
    const cfg = getConfig();
    if (cfg.enabled === false && !manual) return null;
    ensureStarted().catch(() => {});
    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = 'mcps_' + crypto.randomBytes(8).toString('hex');
    const rec = {
      token,
      sessionId,
      ptyId: String(ptyId || ''),
      projectId: String(projectId || '__global__'),
      projectName: String(projectName || ''),
      agentKind: String(agentKind || 'unknown'),
      packAllowlist: Array.isArray(packAllowlist) ? packAllowlist.slice() : null,
      issuedAt: Date.now(),
      lastUsedAt: Date.now(),
      connectedClients: 0,
      approvedKeys: new Set(),
      manual: !!manual,
    };
    sessions.set(token, rec);
    const env = {
      LITEEDITOR_MCP_SOCK: socketPath,
      LITEEDITOR_MCP_TOKEN: token,
      LITEEDITOR_MCP_SESSION: sessionId,
      LITEEDITOR_MCP_AGENT: rec.agentKind,
    };
    emitUi({ kind: 'session', stats: snapshotStats() });
    return { sessionId, token, sockPath: socketPath, env };
  }

  function ensureManualToken({ projectId = '__global__', projectName = '', agentKind = 'claude' } = {}) {
    const pid = String(projectId || '__global__');
    const ak = String(agentKind || 'claude');
    const key = `${pid}::${ak}`;
    const cfg = getConfig();
    const existing = cfg.manualTokens && cfg.manualTokens[key];
    if (existing && existing.token) {
      findSessionByToken(existing.token);
      return existing.token;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const nextTokens = { ...(cfg.manualTokens || {}), [key]: { token, projectId: pid, projectName: String(projectName || ''), agentKind: ak, issuedAt: Date.now() } };
    saveConfig({ ...cfg, manualTokens: nextTokens });
    findSessionByToken(token);
    return token;
  }

  function revokeManualTokens(projectId) {
    const cfg = getConfig();
    const next = {};
    for (const [k, v] of Object.entries(cfg.manualTokens || {})) {
      if (projectId && v && v.projectId !== projectId) { next[k] = v; continue; }
      if (v && v.token) revokeToken(v.token);
    }
    saveConfig({ ...cfg, manualTokens: next });
    return { ok: true };
  }

  function revokeToken(token) {
    const sess = sessions.get(token);
    if (!sess) return;
    sessions.delete(token);
    for (const [aid, ap] of pendingApprovals) {
      if (ap.sessionToken === token) {
        clearTimeout(ap.timer);
        pendingApprovals.delete(aid);
        ap.resolve({ decision: 'deny', reason: 'Сессия завершена' });
      }
    }
    for (const cl of [...clients]) {
      if (cl.token === token) {
        try { cl.socket.destroy(); } catch (_) {}
        clients.delete(cl);
      }
    }
    emitUi({ kind: 'session', stats: snapshotStats() });
  }

  function revokeByPty(ptyId) {
    if (!ptyId) return;
    for (const [tok, sess] of [...sessions]) {
      if (sess.ptyId === ptyId) revokeToken(tok);
    }
  }

  /** @param {string} ptyId @param {{ projectId?: string, projectName?: string }} [opts] */
  function updateSessionProject(ptyId, { projectId, projectName } = {}) {
    if (!ptyId) return;
    for (const sess of sessions.values()) {
      if (sess.ptyId === ptyId) {
        if (projectId) sess.projectId = String(projectId);
        if (projectName != null) sess.projectName = String(projectName);
      }
    }
  }

  function lookupProjectName(projectId) {
    if (!deps.getProjects) return '';
    try {
      const p = deps.getProjects().find((x) => x && x.id === projectId);
      return p ? (p.name || p.path || projectId) : '';
    } catch (_) { return ''; }
  }

  function requestApproval(info) {
    const id = 'mcpa_' + crypto.randomBytes(6).toString('hex');
    const ts = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        resolve({ decision: 'deny', reason: 'Истекло время ожидания подтверждения в интерфейсе (60 с)' });
      }, APPROVAL_TTL_MS);
      if (timer.unref) timer.unref();

      const item = {
        id,
        ts,
        expiresAt: ts + APPROVAL_TTL_MS,
        entryId: info.entryId,
        sessionToken: info.session.token,
        sessionId: info.session.sessionId,
        projectId: info.session.projectId,
        projectName: info.session.projectName || lookupProjectName(info.session.projectId),
        agentKind: info.session.agentKind,
        pack: info.pack.id,
        tool: info.tool.name,
        resourceType: info.resource.type || info.tool.resourceType,
        resourceId: info.resource.id || null,
        resourceName: info.resourceName,
        askReason: info.askReason,
        approvalKey: info.approvalKey,
        bindOnAllow: info.askReason === 'unbound_resource',
        argsPreview: info.argsPreview,
        sql: info.sql || null,
        delayMs: info.delayMs || 0,
        resolve,
        timer,
      };
      pendingApprovals.set(id, item);
      emitUi({ kind: 'approval', approval: serializeApproval(item), autoOpen: getConfig().autoOpenPaneOnAsk });
    });
  }

  function serializeApproval(a) {
    return {
      id: a.id,
      ts: a.ts,
      expiresAt: a.expiresAt,
      entryId: a.entryId,
      sessionId: a.sessionId,
      projectId: a.projectId,
      projectName: a.projectName,
      agentKind: a.agentKind,
      pack: a.pack,
      tool: a.tool,
      resourceType: a.resourceType,
      resourceId: a.resourceId,
      resourceName: a.resourceName,
      askReason: a.askReason,
      argsPreview: a.argsPreview,
      sql: a.sql,
      delayMs: a.delayMs,
    };
  }

  function listPendingApprovals() {
    return [...pendingApprovals.values()].map(serializeApproval);
  }

  /**
   * @param {string} approvalId
   * @param {{ decision: 'once' | 'session' | 'bind' | 'deny' }} opts
   */
  function resolveApproval(approvalId, opts = { decision: 'deny' }) {
    const ap = pendingApprovals.get(approvalId);
    if (!ap) return { ok: false, error: 'Запрос подтверждения не найден или уже завершён' };
    clearTimeout(ap.timer);
    pendingApprovals.delete(approvalId);
    const dec = opts.decision || 'deny';
    const sess = sessions.get(ap.sessionToken);
    if (dec === 'session' && sess && ap.approvalKey) {
      sess.approvedKeys.add(ap.approvalKey);
    }
    if (dec === 'bind' && ap.resourceId && ap.resourceType && ap.resourceType !== 'none') {
      const cur = resolveProjectBinding(getBindings(), ap.projectId, getConfig().defaultPreset);
      if (ap.resourceType === 'db' && !cur.dbIds.includes(ap.resourceId)) {
        cur.dbIds.push(ap.resourceId);
        cur.denyDbIds = cur.denyDbIds.filter((x) => x !== ap.resourceId);
      } else if (ap.resourceType === 'server' && !cur.serverIds.includes(ap.resourceId)) {
        cur.serverIds.push(ap.resourceId);
      } else if (ap.resourceType === 'rh' && !cur.rhIds.includes(ap.resourceId)) {
        cur.rhIds.push(ap.resourceId);
      } else if (ap.resourceType === 'container' && !cur.containerTargets.includes(ap.resourceId)) {
        cur.containerTargets.push(ap.resourceId);
        cur.denyContainerTargets = cur.denyContainerTargets.filter((x) => x !== ap.resourceId);
      } else if (ap.resourceType === 'rmq' && !cur.rmqIds.includes(ap.resourceId)) {
        cur.rmqIds.push(ap.resourceId);
      } else if (ap.resourceType === 'kafka' && !cur.kafkaIds.includes(ap.resourceId)) {
        cur.kafkaIds.push(ap.resourceId);
      } else if (ap.resourceType === 'storage' && !cur.storageIds.includes(ap.resourceId)) {
        cur.storageIds.push(ap.resourceId);
      } else if (ap.resourceType === 'jira' && !cur.jiraIds.includes(ap.resourceId)) {
        cur.jiraIds.push(ap.resourceId);
      } else if (ap.resourceType === 'project' && !cur.projectIds.includes(ap.resourceId)) {
        cur.projectIds.push(ap.resourceId);
      }
      saveProjectBinding(ap.projectId, cur);
      if (sess) {
        sess.approvedKeys.add(`prod:${ap.projectId}:${ap.resourceType}:${ap.resourceId}`);
      }
    }
    ap.resolve({ decision: dec === 'deny' ? 'deny' : 'allow', mode: dec });
    emitUi({ kind: 'approval_resolved', id: approvalId, decision: dec });
    return { ok: true };
  }

  function toolResultText(payload, isError = false) {
    const text = typeof payload === 'string'
      ? sanitizeText(payload, 256 * 1024)
      : JSON.stringify(redactValue(payload, { maxStringBytes: 64 * 1024 }), null, 2);
    return {
      content: [{ type: 'text', text: sanitizeText(text, 256 * 1024) }],
      isError: !!isError,
    };
  }

  async function handleToolCall(session, params) {
    const name = params && params.name ? String(params.name) : '';
    const rawArgs = (params && params.arguments) || {};
    const found = registry.getTool(name);
    if (!found) {
      return toolResultText({ ok: false, error: `Инструмент "${name}" не найден` }, true);
    }
    const { pack, tool } = found;

    if (inFlight >= MAX_INFLIGHT) {
      return toolResultText({ ok: false, error: 'Превышен лимит одновременных MCP-вызовов (8). Повторите запрос.' }, true);
    }

    const v = validateInput(tool.inputSchema, rawArgs);
    if (!v.ok) {
      const eRec = audit.createEntry({
        sessionId: session.sessionId,
        ptyId: session.ptyId,
        agentKind: session.agentKind,
        projectId: session.projectId,
        projectName: session.projectName || lookupProjectName(session.projectId),
        pack: pack.id,
        tool: tool.name,
        resourceType: tool.resourceType,
        status: 'error',
        previewArgs: rawArgs,
        error: v.error,
      });
      emitUi({ kind: 'audit', entry: eRec, stats: snapshotStats() });
      return toolResultText({ ok: false, error: v.error }, true);
    }

    const args = v.value || {};
    const runtimeDeps = buildRuntimeDeps();

    const resInfo = tool.extractResource ? tool.extractResource(args, runtimeDeps, session) : { type: tool.resourceType, id: null, discovery: true };
    const resourceName = (resInfo && resInfo.meta && resInfo.meta.name) || (resInfo && resInfo.id) || '';

    // Явно несуществующий ID ресурса отклоняем сразу без HITL-карточки
    const STRICT_ID_TYPES = new Set(['db', 'server', 'rh', 'rmq', 'kafka', 'storage', 'jira', 'project']);
    if (resInfo && !resInfo.discovery && resInfo.id && resInfo.meta === null && STRICT_ID_TYPES.has(resInfo.type)) {
      const errMsg = `Ресурс «${resInfo.id}» (${resInfo.type}) не найден`;
      const eRec = audit.createEntry({
        sessionId: session.sessionId,
        ptyId: session.ptyId,
        agentKind: session.agentKind,
        projectId: session.projectId,
        projectName: session.projectName || lookupProjectName(session.projectId),
        pack: pack.id,
        tool: tool.name,
        resourceType: resInfo.type,
        resourceId: resInfo.id,
        status: 'error',
        previewArgs: args,
        error: errMsg,
      });
      emitUi({ kind: 'audit', entry: eRec, stats: snapshotStats() });
      return toolResultText({ ok: false, error: errMsg }, true);
    }

    const cfg = getConfig();
    const bindings = getBindings();
    const hasUi = typeof deps.hasUi === 'function' ? !!deps.hasUi() : true;
    const pol = evaluateAccess({ session, pack, tool, resource: resInfo, config: cfg, bindings, hasUi });

    const sqlPreview = typeof args.sql === 'string' ? args.sql : null;
    const started = Date.now();
    const rec = audit.createEntry({
      sessionId: session.sessionId,
      ptyId: session.ptyId,
      agentKind: session.agentKind,
      projectId: session.projectId,
      projectName: session.projectName || lookupProjectName(session.projectId),
      pack: pack.id,
      tool: tool.name,
      resourceType: (resInfo && resInfo.type) || tool.resourceType,
      resourceId: (resInfo && resInfo.id) || null,
      resourceName,
      status: pol.decision === 'deny' ? 'denied' : (pol.decision === 'ask' ? 'pending_approval' : 'running'),
      bytesIn: Buffer.byteLength(JSON.stringify(args), 'utf8'),
      previewArgs: args,
      sql: sqlPreview,
      error: pol.decision === 'deny' ? pol.reason : null,
      policyNote: pol.decision === 'ask' ? pol.askReason : null,
    });
    emitUi({ kind: 'audit', entry: rec, stats: snapshotStats() });

    if (pol.decision === 'deny') {
      return toolResultText({ ok: false, error: pol.reason }, true);
    }

    if (pol.decision === 'ask') {
      const answer = await requestApproval({
        entryId: rec.id,
        session,
        pack,
        tool,
        resource: resInfo,
        resourceName,
        askReason: pol.askReason,
        approvalKey: pol.approvalKey,
        argsPreview: rec.previewArgs,
        sql: sqlPreview,
        delayMs: pol.delayMs || 0,
      });
      if (!answer || answer.decision !== 'allow') {
        const reason = (answer && answer.reason) || 'Отклонено пользователем в LiteEditor';
        const updated = audit.updateEntry(rec.id, {
          status: 'denied',
          durationMs: Date.now() - started,
          error: reason,
        });
        emitUi({ kind: 'audit', entry: updated, stats: snapshotStats() });
        return toolResultText({ ok: false, error: reason }, true);
      }
      const running = audit.updateEntry(rec.id, { status: 'running' });
      emitUi({ kind: 'audit', entry: running, stats: snapshotStats() });
    }

    let extraMeta = {};
    inFlight++;
    const timeoutMs = (pol.constraints && pol.constraints.maxTimeoutMs) || 30000;
    try {
      const binding = resolveProjectBinding(getBindings(), session.projectId, getConfig().defaultPreset);
      const execPromise = Promise.resolve().then(() => tool.handler(args, {
        session,
        deps: runtimeDeps,
        binding,
        policy: pol,
        constraints: pol.constraints || {},
        setAuditMeta: (m) => { if (m && typeof m === 'object') extraMeta = { ...extraMeta, ...m }; },
      }));
      let toTimer = null;
      const timeoutPromise = new Promise((_res, rej) => {
        toTimer = setTimeout(() => rej(new Error(`Таймаут выполнения инструмента (${timeoutMs} мс)`)), timeoutMs);
        if (toTimer.unref) toTimer.unref();
      });
      const result = await Promise.race([execPromise, timeoutPromise]).finally(() => { if (toTimer) clearTimeout(toTimer); });
      const resObj = result && typeof result === 'object' ? result : { result };
      const isErr = resObj.ok === false || !!resObj.error;
      const outRes = toolResultText(resObj, isErr);
      const previewOut = outRes.content[0] ? outRes.content[0].text.slice(0, 1500) : '';
      const updated = audit.updateEntry(rec.id, {
        status: isErr ? 'error' : 'ok',
        durationMs: Date.now() - started,
        bytesOut: Buffer.byteLength(outRes.content[0] ? outRes.content[0].text : '', 'utf8'),
        previewOut,
        error: isErr ? (resObj.error || 'Ошибка выполнения') : null,
        ...extraMeta,
      });
      emitUi({ kind: 'audit', entry: updated, stats: snapshotStats() });
      return outRes;
    } catch (e) {
      const msg = String((e && e.message) || e);
      const isTo = /Таймаут выполнения/i.test(msg);
      const updated = audit.updateEntry(rec.id, {
        status: isTo ? 'timeout' : 'error',
        durationMs: Date.now() - started,
        error: msg,
        ...extraMeta,
      });
      emitUi({ kind: 'audit', entry: updated, stats: snapshotStats() });
      return toolResultText({ ok: false, error: msg }, true);
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  function handleClientConnection(socket) {
    let buf = Buffer.alloc(0);
    let authedSession = null;
    const clientRec = {
      socket,
      token: '',
      send: (obj) => {
        if (!socket.destroyed) {
          try { socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
        }
      },
    };

    const authTimer = setTimeout(() => {
      if (!authedSession && !socket.destroyed) {
        clientRec.send({ type: 'auth_err', error: 'Таймаут авторизации' });
        socket.destroy();
      }
    }, 5000);
    if (authTimer.unref) authTimer.unref();

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }

        if (!authedSession) {
          if (msg.type !== 'auth' || !msg.token) {
            clientRec.send({ type: 'auth_err', error: 'Требуется auth' });
            socket.destroy();
            return;
          }
          const found = findSessionByToken(String(msg.token));
          if (!found) {
            clientRec.send({ type: 'auth_err', error: 'Недействительный токен сессии MCP' });
            socket.destroy();
            return;
          }
          clearTimeout(authTimer);
          authedSession = found;
          clientRec.token = found.token;
          if (msg.agentKind && msg.agentKind !== 'unknown' && found.agentKind === 'unknown') {
            found.agentKind = String(msg.agentKind);
          }
          found.connectedClients = (found.connectedClients || 0) + 1;
          found.lastUsedAt = Date.now();
          clients.add(clientRec);
          clientRec.send({ type: 'auth_ok', sessionId: found.sessionId, projectId: found.projectId });
          emitUi({ kind: 'session', stats: snapshotStats() });
          continue;
        }

        if (msg.type === 'client_info' && msg.clientInfo) {
          const guessed = inferAgentFromClient(msg.clientInfo);
          if (guessed && (authedSession.agentKind === 'unknown' || !authedSession.agentKind)) {
            authedSession.agentKind = guessed;
          }
          continue;
        }

        if (msg.type === 'request' && msg.id != null) {
          authedSession.lastUsedAt = Date.now();
          if (msg.method === 'tools/list') {
            const tools = registry.listTools(getConfig(), authedSession.packAllowlist);
            clientRec.send({ type: 'response', id: msg.id, result: { tools } });
          } else if (msg.method === 'tools/call') {
            handleToolCall(authedSession, msg.params)
              .then((res) => clientRec.send({ type: 'response', id: msg.id, result: res }))
              .catch((err) => clientRec.send({ type: 'response', id: msg.id, error: { code: -32000, message: String(err && err.message) } }));
          } else {
            clientRec.send({ type: 'response', id: msg.id, error: { code: -32601, message: 'Метод не поддерживается' } });
          }
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(clientRec);
      if (authedSession) {
        authedSession.connectedClients = Math.max(0, (authedSession.connectedClients || 1) - 1);
        emitUi({ kind: 'session', stats: snapshotStats() });
      }
    });

    socket.on('error', () => {});
  }

  async function ensureStarted() {
    if (server) return { ok: true, socketPath };
    if (starting) return starting;
    starting = (async () => {
      syncBridgeScript();
      if (process.platform !== 'win32') {
        const dir = path.dirname(socketPath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch (_) {}
        if (fs.existsSync(socketPath)) {
          const alive = await probeLiveSocket(socketPath);
          if (!alive) {
            try { fs.unlinkSync(socketPath); } catch (_) {}
          }
        }
      }
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        const srv = net.createServer(handleClientConnection);
        srv.once('error', reject);
        srv.listen(socketPath, () => {
          srv.removeListener('error', reject);
          if (process.platform !== 'win32') {
            try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
          }
          server = srv;
          resolve();
        });
      }));
      log('info', 'mcp', `MCP Hub listening at ${socketPath}`);
      return { ok: true, socketPath };
    })().finally(() => { starting = null; });
    return starting;
  }

  function shutdown() {
    for (const [aid, ap] of pendingApprovals) {
      clearTimeout(ap.timer);
      pendingApprovals.delete(aid);
      ap.resolve({ decision: 'deny', reason: 'Редактор завершает работу' });
    }
    for (const cl of [...clients]) {
      try { cl.socket.destroy(); } catch (_) {}
    }
    clients.clear();
    if (server) {
      try { server.close(); } catch (_) {}
      server = null;
    }
    if (process.platform !== 'win32') {
      try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch (_) {}
    }
  }

  function resolveNodeBin() {
    if (deps.whichBin) {
      const n = deps.whichBin('node');
      if (n) return n;
    }
    return 'node';
  }

  function buildAgentSnippet({ agentKind = 'claude', projectId = '__global__', projectName = '' } = {}) {
    syncBridgeScript();
    const bridge = deps.syncBridge === false ? sourceBridgePath : stableBridgePath;
    const nodeBin = resolveNodeBin();
    const token = ensureManualToken({ projectId, projectName, agentKind });
    const q = (s) => (/\s/.test(String(s)) ? `"${s}"` : String(s));

    if (agentKind === 'agy') {
      return {
        agentKind: 'agy',
        command: `agy mcp add --env LITEEDITOR_MCP_SOCK=${q(socketPath)} --env LITEEDITOR_MCP_TOKEN=${token} --env LITEEDITOR_MCP_AGENT=agy lite-editor -- ${q(nodeBin)} ${q(bridge)}`,
        cliArgs: ['mcp', 'add', '--env', `LITEEDITOR_MCP_SOCK=${socketPath}`, '--env', `LITEEDITOR_MCP_TOKEN=${token}`, '--env', 'LITEEDITOR_MCP_AGENT=agy', 'lite-editor', '--', nodeBin, bridge],
        bin: 'agy',
        jsonConfig: {
          liteEditor: { command: nodeBin, args: [bridge], env: { LITEEDITOR_MCP_SOCK: socketPath, LITEEDITOR_MCP_TOKEN: token, LITEEDITOR_MCP_AGENT: 'agy' } },
        },
      };
    }
    if (agentKind === 'codex') {
      return {
        agentKind: 'codex',
        command: `codex mcp add lite-editor --env LITEEDITOR_MCP_SOCK=${q(socketPath)} --env LITEEDITOR_MCP_TOKEN=${token} --env LITEEDITOR_MCP_AGENT=codex -- ${q(nodeBin)} ${q(bridge)}`,
        cliArgs: ['mcp', 'add', 'lite-editor', '--env', `LITEEDITOR_MCP_SOCK=${socketPath}`, '--env', `LITEEDITOR_MCP_TOKEN=${token}`, '--env', 'LITEEDITOR_MCP_AGENT=codex', '--', nodeBin, bridge],
        bin: 'codex',
      };
    }
    if (agentKind === 'gemini') {
      return {
        agentKind: 'gemini',
        command: `gemini mcp add -s project -e LITEEDITOR_MCP_SOCK=${q(socketPath)} -e LITEEDITOR_MCP_TOKEN=${token} -e LITEEDITOR_MCP_AGENT=gemini lite-editor -- ${q(nodeBin)} ${q(bridge)}`,
        cliArgs: ['mcp', 'add', '-s', 'project', '-e', `LITEEDITOR_MCP_SOCK=${socketPath}`, '-e', `LITEEDITOR_MCP_TOKEN=${token}`, '-e', 'LITEEDITOR_MCP_AGENT=gemini', 'lite-editor', '--', nodeBin, bridge],
        bin: 'gemini',
      };
    }
    return {
      agentKind: 'claude',
      command: `claude mcp add -s local -e LITEEDITOR_MCP_SOCK=${q(socketPath)} -e LITEEDITOR_MCP_TOKEN=${token} -e LITEEDITOR_MCP_AGENT=claude lite-editor -- ${q(nodeBin)} ${q(bridge)}`,
      cliArgs: ['mcp', 'add', '-s', 'local', '-e', `LITEEDITOR_MCP_SOCK=${socketPath}`, '-e', `LITEEDITOR_MCP_TOKEN=${token}`, '-e', 'LITEEDITOR_MCP_AGENT=claude', 'lite-editor', '--', nodeBin, bridge],
      bin: 'claude',
    };
  }

  async function connectAgent({ agentKind = 'claude', projectId = '__global__', projectName = '', projectPath = '' } = {}) {
    await ensureStarted();
    const spec = buildAgentSnippet({ agentKind, projectId, projectName });
    const env = typeof deps.cliEnv === 'function' ? deps.cliEnv() : { ...process.env };
    const cwd = projectPath && fs.existsSync(projectPath) ? projectPath : os.homedir();
    const cmdPath = (deps.whichBin && deps.whichBin(spec.bin)) || spec.bin;
    return await new Promise((resolve) => {
      let done = false, out = '', err = '', timer = null;
      const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ ...r, command: spec.command }); } };
      let cp;
      try { cp = spawn(cmdPath, spec.cliArgs, { cwd, env, windowsHide: true }); }
      catch (e) { return fin({ ok: false, error: String(e.message || e) }); }
      timer = setTimeout(() => { try { cp.kill(); } catch (_) {} fin({ ok: false, error: `Таймаут «${spec.bin} mcp add» (20 с)` }); }, 20000);
      if (cp.stdout) { cp.stdout.setEncoding('utf8'); cp.stdout.on('data', (d) => { out += d; }); }
      if (cp.stderr) { cp.stderr.setEncoding('utf8'); cp.stderr.on('data', (d) => { err += d; }); }
      cp.on('error', (e) => fin({ ok: false, error: e.code === 'ENOENT' ? `CLI «${spec.bin}» не найден в PATH` : String(e.message || e) }));
      cp.on('exit', (code) => fin(code === 0 ? { ok: true, out: out.trim() } : { ok: false, error: (err || out).trim() || `${spec.bin} завершился с кодом ${code}` }));
    });
  }

  function snapshotStats() {
    const aStats = audit.stats();
    return {
      ...aStats,
      listening: !!server,
      socketPath,
      bridgePath: stableBridgePath,
      activeSessions: sessions.size,
      connectedClients: clients.size,
      pendingCount: pendingApprovals.size,
    };
  }

  function listSessions(projectId) {
    const out = [];
    for (const s of sessions.values()) {
      if (projectId && s.projectId !== projectId) continue;
      out.push({
        sessionId: s.sessionId,
        ptyId: s.ptyId,
        projectId: s.projectId,
        projectName: s.projectName || lookupProjectName(s.projectId),
        agentKind: s.agentKind,
        issuedAt: s.issuedAt,
        lastUsedAt: s.lastUsedAt,
        connectedClients: s.connectedClients,
        manual: s.manual,
      });
    }
    return out;
  }

  /** @param {any} ipcMain */
  function registerIpc(ipcMain) {
    ipcMain.handle('mcp:status', async (_e, /** @type {Record<string, any>} */ { projectId } = {}) => ({
      ok: true,
      config: publicConfig(),
      binding: projectId ? resolveProjectBinding(getBindings(), projectId, getConfig().defaultPreset) : null,
      allBindings: getBindings(),
      stats: snapshotStats(),
      sessions: listSessions(projectId),
      pending: listPendingApprovals(),
    }));

    ipcMain.handle('mcp:packs', () => ({
      ok: true,
      packs: registry.listPacksMeta(getConfig()),
    }));

    ipcMain.handle('mcp:setConfig', (_e, /** @type {Record<string, any>} */ { config } = {}) => ({
      ok: true,
      config: saveConfig(config || {}),
    }));

    ipcMain.handle('mcp:resources', async () => {
      const resources = await registry.resolveAllResources(buildRuntimeDeps());
      return { ok: true, resources };
    });

    ipcMain.handle('mcp:getBinding', (_e, /** @type {Record<string, any>} */ { projectId } = {}) => ({
      ok: true,
      binding: resolveProjectBinding(getBindings(), projectId, getConfig().defaultPreset),
    }));

    ipcMain.handle('mcp:setBinding', (_e, /** @type {Record<string, any>} */ { projectId, binding } = {}) => ({
      ok: true,
      binding: saveProjectBinding(projectId, binding),
    }));

    ipcMain.handle('mcp:applyPreset', (_e, /** @type {Record<string, any>} */ { projectId, preset } = {}) => ({
      ok: true,
      binding: applyProjectPreset(projectId, preset),
    }));

    ipcMain.handle('mcp:audit', (_e, filter = {}) => ({
      ok: true,
      entries: audit.query(filter || {}),
      pending: listPendingApprovals(),
      stats: snapshotStats(),
    }));

    ipcMain.handle('mcp:auditClear', () => {
      audit.clear();
      emitUi({ kind: 'audit_cleared', stats: snapshotStats() });
      return { ok: true };
    });

    ipcMain.handle('mcp:approve', (_e, /** @type {Record<string, any>} */ { approvalId, decision } = {}) => resolveApproval(approvalId, { decision }));

    ipcMain.handle('mcp:agentSnippets', (_e, /** @type {Record<string, any>} */ { projectId, projectName, agentKind } = {}) => ({
      ok: true,
      snippet: buildAgentSnippet({ agentKind, projectId, projectName }),
      agents: ['claude', 'agy', 'codex', 'gemini'].map((k) => ({
        kind: k,
        installed: !!(deps.whichBin && deps.whichBin(k)),
      })),
    }));

    ipcMain.handle('mcp:connectAgent', async (_e, args = {}) => connectAgent(args));
    ipcMain.handle('mcp:revokeTokens', (_e, /** @type {Record<string, any>} */ { projectId } = {}) => revokeManualTokens(projectId));
  }

  return {
    ensureStarted,
    shutdown,
    registerIpc,
    syncBridgeScript,
    issueSession,
    revokeToken,
    revokeByPty,
    updateSessionProject,
    resolveApproval,
    listPendingApprovals,
    getConfig: publicConfig,
    saveConfig,
    getBindings,
    saveProjectBinding,
    applyProjectPreset,
    buildAgentSnippet,
    connectAgent,
    snapshotStats,
    listSessions,
    audit,
    registry,
    socketPath,
  };
}

module.exports = { createMcpHub, inferAgentFromClient };
