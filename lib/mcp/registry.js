// Реестр модульных MCP-паков LiteEditor.
'use strict';

/**
 * Создать реестр MCP-паков.
 * @param {any[]} [initialPacks]
 */
function createRegistry(initialPacks = []) {
  /** @type {Map<string, any>} */
  const packs = new Map();
  /** @type {Map<string, { pack: any, tool: any }>} */
  const toolIndex = new Map();

  /** @param {any} pack */
  function register(pack) {
    if (!pack || !pack.id) throw new Error('Некорректный MCP-пак');
    if (packs.has(pack.id)) throw new Error(`MCP-пак «${pack.id}» уже зарегистрирован`);
    for (const tool of pack.tools) {
      if (toolIndex.has(tool.name)) {
        throw new Error(`Конфликт имени инструмента MCP «${tool.name}»`);
      }
    }
    packs.set(pack.id, pack);
    for (const tool of pack.tools) {
      toolIndex.set(tool.name, { pack, tool });
    }
  }

  for (const p of initialPacks) register(p);

  /** @param {string} name */
  function getTool(name) {
    return toolIndex.get(String(name || '')) || null;
  }

  /** @param {string} id */
  function getPack(id) {
    return packs.get(String(id || '')) || null;
  }

  /**
   * Список инструментов для `tools/list` с учётом включённых паков и инструментов.
   * @param {any} config
   * @param {string[] | null} [packAllowlist]
   */
  function listTools(config, packAllowlist = null) {
    const cfg = config || { enabled: true, packs: {} };
    if (cfg.enabled === false) return [];
    const out = [];
    for (const pack of packs.values()) {
      if (Array.isArray(packAllowlist) && !packAllowlist.includes(pack.id)) continue;
      const pCfg = cfg.packs && cfg.packs[pack.id];
      const enabled = pCfg ? pCfg.enabled !== false : pack.defaultEnabled !== false;
      if (!enabled) continue;
      const disabled = new Set(Array.isArray(pCfg && pCfg.disabledTools) ? pCfg.disabledTools : []);
      for (const t of pack.tools) {
        if (disabled.has(t.name)) continue;
        out.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            title: t.title || t.name,
            readOnlyHint: t.mode === 'read',
            destructiveHint: t.mode === 'write' || t.mode === 'admin',
            openWorldHint: false,
          },
        });
      }
    }
    return out;
  }

  /**
   * Метаданные всех зарегистрированных паков для MCP Store UI.
   * @param {any} config
   */
  function listPacksMeta(config) {
    const cfg = config || { packs: {} };
    const out = [];
    for (const pack of packs.values()) {
      const pCfg = cfg.packs && cfg.packs[pack.id];
      const enabled = pCfg ? pCfg.enabled !== false : pack.defaultEnabled !== false;
      const disabled = new Set(Array.isArray(pCfg && pCfg.disabledTools) ? pCfg.disabledTools : []);
      out.push({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        version: pack.version,
        enabled,
        scopes: pack.scopes,
        tools: pack.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          mode: t.mode,
          resourceType: t.resourceType,
          enabled: !disabled.has(t.name),
          inputSchema: t.inputSchema,
        })),
      });
    }
    return out;
  }

  /**
   * Собрать актуальные ресурсы по всем пакам для диалогов привязки проекта.
   * @param {any} deps
   */
  async function resolveAllResources(deps) {
    const grouped = { db: [], server: [], rh: [], container: [] };
    for (const pack of packs.values()) {
      try {
        const items = await pack.resolveResources(deps);
        for (const it of items || []) {
          if (grouped[it.type]) grouped[it.type].push(it);
        }
      } catch (_) {}
    }
    return grouped;
  }

  return {
    register,
    getTool,
    getPack,
    listTools,
    listPacksMeta,
    resolveAllResources,
  };
}

module.exports = { createRegistry };
