// Zero-Trust движок политик MCP Hub + пресет dev_safe
// («Разрешить все non-prod БД и локальные контейнеры (read-only)»).
'use strict';

const PRESETS = new Set(['strict', 'dev_safe', 'custom']);
const CLOUD_AGENTS = new Set(['claude', 'agy', 'codex', 'gemini', 'openrouter']);
const LOCAL_AGENTS = new Set(['local', 'ollama', 'lmstudio']);

/**
 * Определить, относится ли агент к облачным CLI/провайдерам (для соблюдения noCloud).
 * Неизвестных внешних клиентов трактуем консервативно как cloud.
 * @param {string | undefined | null} agentKind
 * @returns {boolean}
 */
function isCloudAgent(agentKind) {
  const k = String(agentKind || '').trim().toLowerCase();
  if (LOCAL_AGENTS.has(k)) return false;
  if (CLOUD_AGENTS.has(k)) return true;
  return true;
}

/**
 * Нормализовать привязку ресурсов проекта.
 * @param {any} raw
 */
function normalizeBinding(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const preset = PRESETS.has(b.preset) ? b.preset : 'strict';
  const uniq = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))] : [];
  return {
    preset,
    dbIds: uniq(b.dbIds),
    serverIds: uniq(b.serverIds),
    rhIds: uniq(b.rhIds),
    containerTargets: uniq(b.containerTargets),
    rmqIds: uniq(b.rmqIds),
    kafkaIds: uniq(b.kafkaIds),
    storageIds: uniq(b.storageIds),
    jiraIds: uniq(b.jiraIds),
    projectIds: uniq(b.projectIds),
    denyDbIds: uniq(b.denyDbIds),
    denyContainerTargets: uniq(b.denyContainerTargets),
    allowAllNonProdDbs: preset === 'dev_safe' ? true : (preset === 'strict' ? false : !!b.allowAllNonProdDbs),
    allowAllLocalContainers: preset === 'dev_safe' ? true : (preset === 'strict' ? false : !!b.allowAllLocalContainers),
  };
}

/**
 * Получить политику конкретного проекта.
 * @param {Record<string, any> | null | undefined} bindingsStore
 * @param {string | null | undefined} projectId
 * @param {'strict' | 'dev_safe' | 'custom'} [fallbackPreset]
 */
function resolveProjectBinding(bindingsStore, projectId, fallbackPreset = 'strict') {
  const def = PRESETS.has(fallbackPreset) ? fallbackPreset : 'strict';
  if (!bindingsStore || typeof bindingsStore !== 'object' || !projectId || !bindingsStore[projectId]) {
    return normalizeBinding({ preset: def });
  }
  return normalizeBinding(bindingsStore[projectId]);
}

/**
 * Применить пресет к политике проекта, сохраняя явные ручные привязки серверов и БД.
 * @param {any} currentBinding
 * @param {'strict' | 'dev_safe' | 'custom'} preset
 */
function applyPreset(currentBinding, preset) {
  const p = PRESETS.has(preset) ? preset : 'strict';
  const cur = normalizeBinding(currentBinding);
  if (p === 'dev_safe') {
    return {
      ...cur,
      preset: 'dev_safe',
      allowAllNonProdDbs: true,
      allowAllLocalContainers: true,
    };
  }
  if (p === 'strict') {
    return {
      ...cur,
      preset: 'strict',
      allowAllNonProdDbs: false,
      allowAllLocalContainers: false,
    };
  }
  return {
    ...cur,
    preset: 'custom',
  };
}

/**
 * Проверить, разрешён ли ресурс для проекта согласно привязкам и пресету.
 * @param {ReturnType<typeof normalizeBinding>} binding
 * @param {'db' | 'server' | 'rh' | 'container' | 'rmq' | 'kafka' | 'storage' | 'jira' | 'project'} resourceType
 * @param {string} resourceId
 * @param {Record<string, any> | null | undefined} meta
 * @returns {boolean}
 */
function isResourceBound(binding, resourceType, resourceId, meta = {}) {
  const id = String(resourceId || '');
  if (!id) return false;
  if (resourceType === 'db') {
    if (binding.denyDbIds.includes(id)) return false;
    if (binding.dbIds.includes(id)) return true;
    return !!(binding.allowAllNonProdDbs && !(meta && meta.isProd));
  }
  if (resourceType === 'server') {
    return binding.serverIds.includes(id);
  }
  if (resourceType === 'rh') {
    return binding.rhIds.includes(id);
  }
  if (resourceType === 'container') {
    if (binding.denyContainerTargets.includes(id)) return false;
    if (binding.containerTargets.includes(id)) return true;
    const isLocal = meta && meta.isLocal != null ? !!meta.isLocal : id.startsWith('local:');
    return !!(binding.allowAllLocalContainers && isLocal);
  }
  if (resourceType === 'rmq') return binding.rmqIds.includes(id);
  if (resourceType === 'kafka') return binding.kafkaIds.includes(id);
  if (resourceType === 'storage') return binding.storageIds.includes(id);
  if (resourceType === 'jira') return binding.jiraIds.includes(id);
  if (resourceType === 'project') {
    if (meta && meta.isSelf) return true;
    return binding.projectIds.includes(id);
  }
  return false;
}

/**
 * Нормализовать глобальный конфиг MCP Hub.
 * @param {any} raw
 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const rawPacks = c.packs && typeof c.packs === 'object' ? c.packs : {};
  /** @type {Record<string, { enabled: boolean, disabledTools: string[] }>} */
  const packs = {};
  for (const [k, v] of Object.entries(rawPacks)) {
    const pv = v && typeof v === 'object' ? v : {};
    packs[k] = {
      enabled: pv.enabled !== false,
      disabledTools: Array.isArray(pv.disabledTools) ? [...new Set(pv.disabledTools.map(String))] : [],
    };
  }
  return {
    enabled: c.enabled !== false,
    auditToDisk: c.auditToDisk !== false,
    defaultPreset: PRESETS.has(c.defaultPreset) ? c.defaultPreset : 'strict',
    autoOpenPaneOnAsk: c.autoOpenPaneOnAsk !== false,
    packs,
  };
}

/**
 * Оценить решение политики Zero-Trust на вызов инструмента.
 * @param {object} ctx
 * @param {any} ctx.session
 * @param {any} ctx.pack
 * @param {any} ctx.tool
 * @param {{ type?: string, id?: string | null, discovery?: boolean, meta?: Record<string, any> } | null | undefined} ctx.resource
 * @param {any} ctx.config
 * @param {Record<string, any> | null | undefined} ctx.bindings
 * @param {boolean} [ctx.hasUi]
 */
function evaluateAccess(ctx) {
  const cfg = normalizeConfig(ctx.config);
  const session = ctx.session || {};
  const pack = ctx.pack;
  const tool = ctx.tool;
  const res = /** @type {Record<string, any>} */ (ctx.resource || { type: tool.resourceType || 'none', id: null, meta: {} });

  if (!cfg.enabled || session.disabled) {
    return { decision: 'deny', reason: 'MCP Hub отключён политикой безопасности' };
  }
  const pCfg = cfg.packs[pack.id];
  if (pCfg && pCfg.enabled === false) {
    return { decision: 'deny', reason: `Пак «${pack.name}» отключён в настройках` };
  }
  if (!pCfg && pack.defaultEnabled === false) {
    return { decision: 'deny', reason: `Пак «${pack.name}» не активирован` };
  }
  if (pCfg && Array.isArray(pCfg.disabledTools) && pCfg.disabledTools.includes(tool.name)) {
    return { decision: 'deny', reason: `Инструмент «${tool.name}» отключён администратором` };
  }
  if (Array.isArray(session.packAllowlist) && !session.packAllowlist.includes(pack.id)) {
    return { decision: 'deny', reason: `Для этой сессии доступ к паку «${pack.name}» закрыт` };
  }

  const projectId = session.projectId || '__global__';
  const binding = resolveProjectBinding(ctx.bindings, projectId, cfg.defaultPreset);
  const meta = /** @type {Record<string, any>} */ (res.meta || {});
  const cloud = isCloudAgent(session.agentKind);
  const isProd = !!meta.isProd;
  const noCloudBlockRows = !!(cloud && meta.noCloud);

  const constraints = {
    cloud,
    isProd,
    noCloudBlockRows,
    maxLimit: isProd ? 100 : 200,
    maxTimeoutMs: isProd ? 15000 : 30000,
  };

  if (tool.resourceType && tool.resourceType !== 'none' && !res.discovery) {
    const rType = res.type || tool.resourceType;
    const bound = isResourceBound(binding, rType, res.id, meta);
    const apKey = `res:${projectId}:${rType}:${res.id}`;
    const approvedOnce = !!(session.approvedKeys && session.approvedKeys.has(apKey));
    if (!bound && !approvedOnce) {
      if (!ctx.hasUi) {
        return { decision: 'deny', reason: 'Ресурс не привязан к текущему проекту', constraints };
      }
      return {
        decision: 'ask',
        askReason: 'unbound_resource',
        approvalKey: apKey,
        delayMs: isProd ? 400 : 0,
        constraints,
      };
    }
  }

  if (tool.mode !== 'read') {
    if (!ctx.hasUi) return { decision: 'deny', reason: 'Изменяющие операции требуют подтверждения в интерфейсе', constraints };
    return {
      decision: 'ask',
      askReason: 'write_tool',
      approvalKey: `tool:${projectId}:${tool.name}:${res.id || ''}`,
      delayMs: 400,
      constraints,
    };
  }

  if (isProd) {
    const k = `prod:${projectId}:${res.type || tool.resourceType}:${res.id || tool.name}`;
    const approved = session.approvedKeys && session.approvedKeys.has(k);
    if (!approved) {
      if (!ctx.hasUi) return { decision: 'deny', reason: 'Доступ к prod-ресурсу требует ручного подтверждения', constraints };
      return {
        decision: 'ask',
        askReason: 'prod_resource',
        approvalKey: k,
        delayMs: 400,
        constraints,
      };
    }
  }

  return { decision: 'allow', constraints };
}

module.exports = {
  PRESETS,
  CLOUD_AGENTS,
  LOCAL_AGENTS,
  isCloudAgent,
  normalizeBinding,
  resolveProjectBinding,
  applyPreset,
  isResourceBound,
  normalizeConfig,
  evaluateAccess,
};
