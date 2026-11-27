// Интеграционные unit-тесты для 6 новых MCP-паков: rmq, kafka, storage, jira, tasks, projects.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRmqPack } = require('../lib/mcp/packs/rmq');
const { createKafkaPack } = require('../lib/mcp/packs/kafka');
const { createStoragePack } = require('../lib/mcp/packs/storage');
const { createJiraPack } = require('../lib/mcp/packs/jira');
const { createTasksPack } = require('../lib/mcp/packs/tasks');
const { createProjectsPack } = require('../lib/mcp/packs/projects');
const { normalizeBinding } = require('../lib/mcp/policy');

function toolByName(pack, name) {
  const t = pack.tools.find((x) => x.name === name);
  if (!t) throw new Error(`Missing tool ${name} in ${pack.id}`);
  return t;
}

async function run() {
  let passed = 0;
  const ok = (fn) => fn().then(() => { passed++; });

  await ok(async () => {
    const rmqPack = createRmqPack();
    const rmqApi = {
      list: () => [{ id: 'r1', name: 'RMQ Dev', host: '127.0.0.1', port: 15672, vhost: '/' }],
      findConn: (id) => (id === 'r1' ? { id: 'r1', name: 'RMQ Dev', host: '127.0.0.1', port: 15672, vhost: '/' } : null),
      overview: async () => ({ version: '3.13.0', token: 'secret-tok' }),
      queues: async () => ({ queues: [{ name: 'jobs', messages: 2 }] }),
      peek: async (_id, opts) => {
        assert.strictEqual(opts.count, 20);
        return { messages: [{ payload: 'Bearer super_secret_token_12345', properties: {} }] };
      },
    };
    const ctx = { deps: { getRmqApi: () => rmqApi }, binding: normalizeBinding({ rmqIds: ['r1'] }), session: { projectId: 'p1' } };
    const listRes = await toolByName(rmqPack, 'rmq_list_connections').handler({}, ctx);
    assert.strictEqual(listRes.connections.length, 1);
    const ov = await toolByName(rmqPack, 'rmq_overview').handler({ connectionId: 'r1' }, ctx);
    assert.strictEqual(ov.token, '[REDACTED]');
    const pk = await toolByName(rmqPack, 'rmq_peek').handler({ connectionId: 'r1', queue: 'jobs', count: 99 }, ctx);
    assert(pk.messages[0].payload.includes('[REDACTED]'));
    assert(!rmqPack.tools.some((t) => /publish|purge|delete|kill/.test(t.name)));
  });

  await ok(async () => {
    const kafkaPack = createKafkaPack();
    const kafkaApi = {
      list: () => [{ id: 'k1', name: 'Kafka Dev', brokers: 'localhost:9092' }],
      findConn: (id) => (id === 'k1' ? { id: 'k1', name: 'Kafka Dev', brokers: 'localhost:9092' } : null),
      topics: async () => ({ topics: [{ name: 'events', partitions: 3 }] }),
      peek: async (_id, opts) => {
        assert.strictEqual(opts.count, 20);
        return { items: [{ partition: 0, offset: '1', key: 'k', value: 'API_KEY=sk-proj-1234567890abcdef' }] };
      },
    };
    const ctx = { deps: { getKafkaApi: () => kafkaApi }, binding: normalizeBinding({ kafkaIds: ['k1'] }), session: { projectId: 'p1' } };
    const tRes = await toolByName(kafkaPack, 'kafka_topics').handler({ connectionId: 'k1' }, ctx);
    assert.strictEqual(tRes.topics[0].name, 'events');
    const pkRes = await toolByName(kafkaPack, 'kafka_peek').handler({ connectionId: 'k1', topic: 'events', limit: 500 }, ctx);
    assert(pkRes.messages[0].value.includes('[REDACTED]'));
    assert(!kafkaPack.tools.some((t) => /produce|create|delete|reset|purge/.test(t.name)));
  });

  await ok(async () => {
    const stPack = createStoragePack();
    const stApi = {
      listMeta: () => [{ id: 's1', name: 'MinIO Dev', endpoint: 'http://127.0.0.1:9000', bucket: 'dev' }],
      findConn: (id) => (id === 's1' ? { id: 's1', name: 'MinIO Dev', endpoint: 'http://127.0.0.1:9000', bucket: 'dev' } : null),
      buckets: async () => ({ buckets: ['dev'] }),
      ls: async () => ({ prefixes: ['logs/'], objects: [{ key: 'app.log', size: 10 }] }),
      readText: async () => ({ kind: 'text', size: 22, truncated: false, meta: {}, content: 'JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig123456' }),
    };
    const ctx = { deps: { getStorageApi: () => stApi }, binding: normalizeBinding({ storageIds: ['s1'] }), session: { projectId: 'p1' } };
    await assert.rejects(
      () => toolByName(stPack, 'st_read_text').handler({ connectionId: 's1', bucket: 'dev', key: 'cfg/.env' }, ctx),
      /заблокирован/i
    );
    const txt = await toolByName(stPack, 'st_read_text').handler({ connectionId: 's1', bucket: 'dev', key: 'app.log' }, ctx);
    assert.strictEqual(txt.kind, 'text');
    assert(txt.content.includes('[REDACTED]') || txt.content.startsWith('JWT='));
    assert(!stPack.tools.some((t) => /presign|upload|remove|delete|mkdir|copy|rename/.test(t.name)));
  });

  await ok(async () => {
    const jiraPack = createJiraPack();
    const jiraApi = {
      list: () => [{ id: 'j1', name: 'Corp Jira', host: 'https://jira.example.local', mode: 'pat' }],
      findAccount: (id) => (id === 'j1' ? { id: 'j1', name: 'Corp Jira', host: 'https://jira.example.local' } : null),
      search: async (_id, opts) => {
        assert.strictEqual(opts.limit, 50);
        return { ok: true, issues: [{ key: 'DEV-1', summary: 'Fix bug' }], total: 1 };
      },
      issue: async () => ({ issue: { key: 'DEV-1', description: 'desc' }, transitions: [] }),
    };
    const ctx = { deps: { getJiraApi: () => jiraApi }, binding: normalizeBinding({ jiraIds: ['j1'] }), session: { projectId: 'p1' } };
    const sr = await toolByName(jiraPack, 'jira_search').handler({ accountId: 'j1', limit: 200 }, ctx);
    assert.strictEqual(sr.issues[0].key, 'DEV-1');
    const ir = await toolByName(jiraPack, 'jira_issue').handler({ accountId: 'j1', key: 'DEV-1' }, ctx);
    assert.strictEqual(ir.issue.key, 'DEV-1');
    assert(!jiraPack.tools.some((t) => /transition|comment/.test(t.name)));
  });

  await ok(async () => {
    const tasksPack = createTasksPack();
    const tasksApi = {
      getNotes: async (pid) => (pid === 'p1' ? [{ id: 'n1', title: 'Note', text: 'hello' }] : [{ id: 'n2', text: 'other' }]),
      getAgenda: async () => [{ id: 'a1', text: 'Ship release', done: false }],
    };
    const ctx = { deps: { tasksApi }, binding: normalizeBinding({}), session: { projectId: 'p1' } };
    const nRes = await toolByName(tasksPack, 'tasks_notes_get').handler({}, ctx);
    assert.strictEqual(nRes.notes.length, 1);
    await assert.rejects(
      () => toolByName(tasksPack, 'tasks_notes_get').handler({ projectId: 'p2' }, ctx),
      /не привязан/
    );
  });

  await ok(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-mcp-proj-'));
    try {
      const projDir = path.join(tmp, 'proj');
      const outsideDir = path.join(tmp, 'outside');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, '.gitignore'), 'ignored-dir/\n', 'utf8');
      fs.mkdirSync(path.join(projDir, 'ignored-dir'));
      fs.writeFileSync(path.join(projDir, 'ignored-dir', 'skip.txt'), 'needletest', 'utf8');
      fs.writeFileSync(path.join(projDir, '.env'), 'SECRET=needletest', 'utf8');
      fs.writeFileSync(path.join(projDir, 'app.js'), 'const msg = "needletest Bearer secret123456";\n', 'utf8');
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside', 'utf8');
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(projDir, 'escape-link.txt'));

      const projPack = createProjectsPack();
      const ctx = {
        deps: {
          getProjects: () => [{ id: 'p1', name: 'P1', path: projDir }],
          gitHelpers: null,
        },
        binding: normalizeBinding({ projectIds: [] }),
        session: { projectId: 'p1' },
      };

      const tree = await toolByName(projPack, 'project_tree').handler({ projectId: 'p1', depth: 2 }, ctx);
      const names = tree.entries.map((e) => e.path);
      assert(names.includes('app.js'));
      assert(!names.includes('.env'));
      assert(!names.includes('ignored-dir'));
      assert(!names.includes('escape-link.txt'));

      await assert.rejects(
        () => toolByName(projPack, 'project_read_file').handler({ projectId: 'p1', path: '../outside/secret.txt' }, ctx),
        /Выход за границы/
      );
      await assert.rejects(
        () => toolByName(projPack, 'project_read_file').handler({ projectId: 'p1', path: 'escape-link.txt' }, ctx),
        /Симлинк/
      );
      await assert.rejects(
        () => toolByName(projPack, 'project_read_file').handler({ projectId: 'p1', path: '.env' }, ctx),
        /заблокирован/
      );

      const searchRes = await toolByName(projPack, 'project_search').handler({ projectId: 'p1', query: 'needletest' }, ctx);
      assert.strictEqual(searchRes.matches.length, 1);
      assert.strictEqual(searchRes.matches[0].path, 'app.js');
      assert(searchRes.matches[0].text.includes('[REDACTED]'));
      assert.strictEqual(searchRes.readFailed, 0);

      // extractResource checks isSelf vs cross-project
      const rSelf = toolByName(projPack, 'project_read_file').extractResource({ projectId: 'p1', path: 'app.js' }, ctx.deps, { projectId: 'p1' });
      assert.strictEqual(rSelf.meta.isSelf, true);
      const rOther = toolByName(projPack, 'project_read_file').extractResource({ projectId: 'p1', path: 'app.js' }, ctx.deps, { projectId: 'p2' });
      assert.strictEqual(rOther.meta.isSelf, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(`mcp-packs-ext.test.js: ${passed} checks passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
