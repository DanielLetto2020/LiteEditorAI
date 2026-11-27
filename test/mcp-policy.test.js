// Unit-тесты для lib/mcp/policy.js и lib/mcp/pack.js (Zero-Trust, пресет dev_safe, noCloud, HITL).
'use strict';

const assert = require('assert');
const {
  isCloudAgent,
  applyPreset,
  isResourceBound,
  evaluateAccess,
} = require('../lib/mcp/policy');
const { defineMcpPack, validateInput } = require('../lib/mcp/pack');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

const dummyPack = defineMcpPack({
  id: 'db',
  name: 'DB',
  description: 'test',
  tools: [
    { name: 'db_query', description: 'query', mode: 'read', resourceType: 'db', async handler() { return {}; } },
    { name: 'db_write', description: 'write', mode: 'write', resourceType: 'db', async handler() { return {}; } },
  ],
});
const readTool = dummyPack.tools[0];
const writeTool = dummyPack.tools[1];

const ctrPack = defineMcpPack({
  id: 'containers',
  name: 'Containers',
  description: 'test',
  tools: [{ name: 'ctr_list', description: 'list', mode: 'read', resourceType: 'container', async handler() { return {}; } }],
});

check('isCloudAgent differentiates cloud CLI agents vs local Ollama/LMStudio', () => {
  assert.strictEqual(isCloudAgent('claude'), true);
  assert.strictEqual(isCloudAgent('agy'), true);
  assert.strictEqual(isCloudAgent('codex'), true);
  assert.strictEqual(isCloudAgent('unknown'), true);
  assert.strictEqual(isCloudAgent('ollama'), false);
  assert.strictEqual(isCloudAgent('local'), false);
});

check('strict preset denies/asks unbound resources, allows bound non-prod read-only', () => {
  const bindings = { p1: { preset: 'strict', dbIds: ['db1'], serverIds: [], rhIds: [], containerTargets: [] } };
  const okRes = evaluateAccess({
    session: { projectId: 'p1', agentKind: 'claude' },
    pack: dummyPack,
    tool: readTool,
    resource: { type: 'db', id: 'db1', meta: { isProd: false, noCloud: false } },
    config: { enabled: true },
    bindings,
    hasUi: true,
  });
  assert.strictEqual(okRes.decision, 'allow');

  const askUnbound = evaluateAccess({
    session: { projectId: 'p1', agentKind: 'claude' },
    pack: dummyPack,
    tool: readTool,
    resource: { type: 'db', id: 'db2', meta: { isProd: false } },
    config: { enabled: true },
    bindings,
    hasUi: true,
  });
  assert.strictEqual(askUnbound.decision, 'ask');
  assert.strictEqual(askUnbound.askReason, 'unbound_resource');
});

check('dev_safe preset allows all non-prod DBs & local containers RO, while blocking/asking PROD & SSH', () => {
  const b = applyPreset({}, 'dev_safe');
  assert.strictEqual(isResourceBound(b, 'db', 'any_dev', { isProd: false }), true);
  assert.strictEqual(isResourceBound(b, 'db', 'prod_db', { isProd: true }), false);
  assert.strictEqual(isResourceBound(b, 'container', 'local:podman', { isLocal: true }), true);
  assert.strictEqual(isResourceBound(b, 'container', 'rh:s1:docker', { isLocal: false }), false);
  assert.strictEqual(isResourceBound(b, 'server', 'srv1', {}), false);

  // denyDbIds overrides dev_safe
  b.denyDbIds.push('secret_dev');
  assert.strictEqual(isResourceBound(b, 'db', 'secret_dev', { isProd: false }), false);

  // global defaultPreset dev_safe applies to projects without explicit bindings entry
  const rLocalCtr = evaluateAccess({
    session: { projectId: 'newproj', agentKind: 'agy' },
    pack: ctrPack,
    tool: ctrPack.tools[0],
    resource: { type: 'container', id: 'local:podman', meta: { isLocal: true, isProd: false } },
    config: { enabled: true, defaultPreset: 'dev_safe' },
    bindings: {},
    hasUi: true,
  });
  assert.strictEqual(rLocalCtr.decision, 'allow');
});

check('noCloud & isProd constraints plus write tool HITL', () => {
  const bindings = { p1: { preset: 'strict', dbIds: ['prod1'] } };
  const prodAsk = evaluateAccess({
    session: { projectId: 'p1', agentKind: 'claude' },
    pack: dummyPack,
    tool: readTool,
    resource: { type: 'db', id: 'prod1', meta: { isProd: true, noCloud: true } },
    config: { enabled: true },
    bindings,
    hasUi: true,
  });
  assert.strictEqual(prodAsk.decision, 'ask');
  assert.strictEqual(prodAsk.askReason, 'prod_resource');
  assert.strictEqual(prodAsk.delayMs, 400);
  assert.strictEqual(prodAsk.constraints.noCloudBlockRows, true);
  assert.strictEqual(prodAsk.constraints.maxLimit, 100);
  assert.strictEqual(prodAsk.constraints.maxTimeoutMs, 15000);

  const localRes = evaluateAccess({
    session: { projectId: 'p1', agentKind: 'ollama', approvedKeys: new Set(['prod:p1:db:prod1']) },
    pack: dummyPack,
    tool: readTool,
    resource: { type: 'db', id: 'prod1', meta: { isProd: true, noCloud: true } },
    config: { enabled: true },
    bindings,
    hasUi: true,
  });
  assert.strictEqual(localRes.decision, 'allow');
  assert.strictEqual(localRes.constraints.noCloudBlockRows, false);

  const wr = evaluateAccess({
    session: { projectId: 'p1', agentKind: 'claude' },
    pack: dummyPack,
    tool: writeTool,
    resource: { type: 'db', id: 'prod1', meta: { isProd: false } },
    config: { enabled: true },
    bindings,
    hasUi: true,
  });
  assert.strictEqual(wr.decision, 'ask');
  assert.strictEqual(wr.askReason, 'write_tool');
});

check('validateInput checks required, enum, integer bounds, additionalProperties', () => {
  const schema = {
    type: 'object',
    required: ['sql'],
    properties: {
      sql: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  };
  assert.strictEqual(validateInput(schema, { sql: 'SELECT 1', limit: 10 }).ok, true);
  assert.strictEqual(validateInput(schema, {}).ok, false);
  assert.strictEqual(validateInput(schema, { sql: 'SELECT 1', limit: 999 }).ok, false);
  assert.strictEqual(validateInput(schema, { sql: 'SELECT 1', extra: 1 }).ok, false);
});

check('extended Zero-Trust bindings (rmq, kafka, storage, jira, project self vs cross-project)', () => {
  const b = applyPreset({ rmqIds: ['r1'], kafkaIds: ['k1'], storageIds: ['s1'], jiraIds: ['j1'], projectIds: ['p2'] }, 'dev_safe');
  assert.strictEqual(isResourceBound(b, 'rmq', 'r1'), true);
  assert.strictEqual(isResourceBound(b, 'rmq', 'r2'), false);
  assert.strictEqual(isResourceBound(b, 'kafka', 'k1'), true);
  assert.strictEqual(isResourceBound(b, 'kafka', 'k2'), false);
  assert.strictEqual(isResourceBound(b, 'storage', 's1'), true);
  assert.strictEqual(isResourceBound(b, 'storage', 's2'), false);
  assert.strictEqual(isResourceBound(b, 'jira', 'j1'), true);
  assert.strictEqual(isResourceBound(b, 'jira', 'j2'), false);
  assert.strictEqual(isResourceBound(b, 'project', 'p1', { isSelf: true }), true);
  assert.strictEqual(isResourceBound(b, 'project', 'p2', { isSelf: false }), true);
  assert.strictEqual(isResourceBound(b, 'project', 'p3', { isSelf: false }), false);
});

console.log(`mcp-policy.test.js: ${passed} checks passed`);
