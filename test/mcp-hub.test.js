// Интеграционные тесты MCP Hub + lite-mcp-bridge по реальному UDS-сокету в /tmp.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createMcpHub } = require('../lib/mcp/hub');
const { defineMcpPack } = require('../lib/mcp/pack');

let passed = 0;

function mkBridgeClient(sockPath, token) {
  const bridgePath = path.join(__dirname, '..', 'mcp', 'lite-mcp-bridge.js');
  const cp = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      LITEEDITOR_MCP_SOCK: sockPath,
      LITEEDITOR_MCP_TOKEN: token,
      LITEEDITOR_MCP_AGENT: 'claude',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let seq = 1;
  let buf = '';
  const pending = new Map();
  const notifications = [];

  cp.stdout.setEncoding('utf8');
  cp.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
        else p.resolve(msg.result);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = seq++;
    const to = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 5000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (e) => { clearTimeout(to); reject(e); },
    });
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });

  const notify = (method, params) => {
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  };

  const close = () => new Promise((resolve) => {
    cp.once('close', resolve);
    try { cp.stdin.end(); } catch (_) { cp.kill(); }
  });

  return { rpc, notify, close, notifications };
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liteeditor-mcp-test-'));
  const sockPath = path.join(tmpDir, 'mcp.sock');
  let cfgStore = { enabled: true, auditToDisk: true, defaultPreset: 'strict', packs: {} };
  let bindStore = { p1: { preset: 'strict', dbIds: ['d1'] } };
  const events = [];

  const testPack = defineMcpPack({
    id: 'db',
    name: 'Test DB',
    description: 'test',
    tools: [
      {
        name: 'db_echo',
        description: 'echo bound resource',
        mode: 'read',
        resourceType: 'db',
        inputSchema: {
          type: 'object',
          required: ['connectionId', 'sql'],
          properties: { connectionId: { type: 'string' }, sql: { type: 'string' } },
          additionalProperties: false,
        },
        extractResource: (args) => ({
          type: 'db',
          id: args.connectionId,
          meta: { name: args.connectionId, isProd: args.connectionId === 'prod1' },
        }),
        async handler(args, ctx) {
          ctx.setAuditMeta({ sql: args.sql });
          return { ok: true, id: args.connectionId, got: args.sql };
        },
      },
    ],
  });

  const hub = createMcpHub({
    storeDir: tmpDir,
    socketPath: sockPath,
    syncBridge: false,
    packs: [testPack],
    readConfig: () => cfgStore,
    writeConfig: (v) => { cfgStore = v; },
    readBindings: () => bindStore,
    writeBindings: (v) => { bindStore = v; },
    getProjects: () => [{ id: 'p1', name: 'Demo' }],
    broadcast: (_ch, ev) => { events.push(ev); },
    hasUi: () => true,
  });

  try {
    await hub.ensureStarted();
    passed++;

    const sess = hub.issueSession({ ptyId: 'p1::t1', projectId: 'p1', projectName: 'Demo' });
    const cl = mkBridgeClient(sockPath, sess.token);

    const init = await cl.rpc('initialize', { clientInfo: { name: 'claude-code' } });
    assert.strictEqual(init.serverInfo.name, 'lite-editor-mcp');
    cl.notify('notifications/initialized');
    passed++;

    const list = await cl.rpc('tools/list');
    assert.strictEqual(list.tools.length, 1);
    assert.strictEqual(list.tools[0].name, 'db_echo');
    passed++;

    // Bound resource succeeds without HITL
    const okCall = await cl.rpc('tools/call', { name: 'db_echo', arguments: { connectionId: 'd1', sql: 'SELECT 1' } });
    assert.strictEqual(okCall.isError, false);
    assert(okCall.content[0].text.includes('"got": "SELECT 1"'));
    passed++;

    // Unbound resource triggers HITL pendingApproval, resolved via hub.resolveApproval(..., 'bind')
    const pendPromise = cl.rpc('tools/call', { name: 'db_echo', arguments: { connectionId: 'd2', sql: 'SELECT 2' } });
    await new Promise((r) => setTimeout(r, 80));
    const pendList = hub.listPendingApprovals();
    assert.strictEqual(pendList.length, 1);
    assert.strictEqual(pendList[0].resourceId, 'd2');
    hub.resolveApproval(pendList[0].id, { decision: 'bind' });
    const boundRes = await pendPromise;
    assert.strictEqual(boundRes.isError, false);
    assert(bindStore.p1.dbIds.includes('d2'));
    passed++;

    // Reject path: prod1 requires HITL -> deny
    const rejPromise = cl.rpc('tools/call', { name: 'db_echo', arguments: { connectionId: 'prod1', sql: 'SELECT 3' } });
    await new Promise((r) => setTimeout(r, 80));
    const p2 = hub.listPendingApprovals();
    assert.strictEqual(p2.length, 1);
    hub.resolveApproval(p2[0].id, { decision: 'deny' });
    const rejRes = await rejPromise;
    assert.strictEqual(rejRes.isError, true);
    passed++;

    // Audit written both to RAM and to 0600 NDJSON file
    const logs = hub.audit.query({ projectId: 'p1' });
    assert.strictEqual(logs.length, 3);
    const auditFiles = fs.readdirSync(path.join(tmpDir, 'logs')).filter((f) => f.startsWith('mcp-audit-'));
    assert.strictEqual(auditFiles.length, 1);
    const st = fs.statSync(path.join(tmpDir, 'logs', auditFiles[0]));
    assert.strictEqual(st.mode & 0o777, 0o600);
    passed++;

    // Bad token fails cleanly
    const bad = mkBridgeClient(sockPath, 'bad-token-000');
    let badErr = null;
    try { await bad.rpc('tools/list'); } catch (e) { badErr = e; }
    assert(badErr && /токен|auth|закрыто/i.test(badErr.message));
    await bad.close();
    passed++;

    // Revoke by PTY terminates active bridge access
    hub.revokeByPty('p1::t1');
    let revErr = null;
    try { await cl.rpc('tools/list'); } catch (e) { revErr = e; }
    assert(revErr);
    await cl.close();
    passed++;

    console.log(`mcp-hub.test.js: ${passed} checks passed`);
  } finally {
    hub.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
