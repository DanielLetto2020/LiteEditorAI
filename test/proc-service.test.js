// Тест фонового сервиса опроса /proc (lib/proc-service.js):
// проверяет работу через worker_threads, расчёт деревьев PTY в samplePtyTrees, кэширование и фолбэк.
const assert = require('assert');
const { spawn } = require('child_process');
const { createProcService } = require('../lib/proc-service');

if (process.platform !== 'linux') { console.log('proc-service: пропущен — только Linux'); process.exit(0); }
if (__dirname.includes('.stryker-tmp') || process.env.STRYKER_MUTATOR_WORKER) {
  console.log('proc-service: пропущен под Stryker');
  process.exit(0);
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const kids = [];
  const cleanup = () => {
    for (const k of kids) {
      if (k.pid) { try { process.kill(-k.pid, 'SIGKILL'); } catch (_) {} }
    }
  };
  process.on('exit', cleanup);

  const svc = createProcService({ cacheTtlMs: 120, useWorker: true });
  const svcLocal = createProcService({ cacheTtlMs: 0, useWorker: false });

  try {
    // 1. Нулевой/несуществующий PID не роняет воркер
    ok((await svc.foregroundKind(0)) === null, 'pid=0 → null');
    ok((await svc.foregroundKind(999999999)) === null, 'несуществующий pid → null');
    ok((await svc.agentState(999999999)) === null, 'agentState несуществующего pid → null');
    assert.deepStrictEqual(await svc.agents([]), {});
    passed++;

    // 2. Дерево из sh + 2 дочерних sleep: samplePtyTrees видит ровно 3 процесса в поддереве
    const g = spawn('sh', ['-c', 'sleep 30 & sleep 31 & wait'], { detached: true, stdio: 'ignore' });
    kids.push(g);
    await wait(220);

    const pid = /** @type {number} */ (g.pid);
    const snap1 = await svc.samplePtyTrees([['proj1::s1', pid]], (sid) => `Метка:${sid}`);
    ok(snap1.note === null, 'на Linux note === null');
    ok(snap1.procs.length === 1, 'одно дерево PTY в снимке');
    ok(snap1.procs[0].label === 'Метка:proj1::s1', 'метка сессии проброшена');
    ok(snap1.procs[0].procs === 3, `в дереве ровно 3 процесса (sh + 2 sleep), получено ${snap1.procs[0].procs}`);
    ok(snap1.procs[0].memBytes > 0 && snap1.totalMem === snap1.procs[0].memBytes, 'RSS памяти посчитан');
    ok(snap1.procs[0].cpu === 0, 'первый снимок без предыдущей базы → cpu=0');

    // Повторный снимок даёт неотрицательный CPU% по дельте jiffies
    await wait(60);
    const snap2 = await svc.samplePtyTrees([['proj1::s1', pid]]);
    ok(snap2.procs.length === 1 && snap2.procs[0].cpu >= 0, 'второй снимок считает дельту CPU без ошибок');

    // Не-Linux платформа отдаёт честное примечание
    const nonLinux = await svc.samplePtyTrees([['proj1::s1', pid]], undefined, 'darwin');
    ok(nonLinux.procs.length === 0 && typeof nonLinux.note === 'string', 'не-Linux → пустой список и пояснение');

    // 3. Совпадение ответов worker_threads и синхронного фолбэка (useWorker: false)
    const [wAgents, lAgents] = await Promise.all([
      svc.agents([['s1', pid], ['dead', 999999999]]),
      svcLocal.agents([['s1', pid], ['dead', 999999999]]),
    ]);
    assert.deepStrictEqual(wAgents, lAgents, 'ответ воркера и локального фолбэка совпадает');
    passed++;

    // 4. Параллельные вызовы попадают в in-flight / TTL-кэш и отдают идентичный ответ
    const [a1, a2, a3] = await Promise.all([
      svc.agentState(process.pid),
      svc.agentState(process.pid),
      svc.agentState(process.pid),
    ]);
    assert.deepStrictEqual(a1, a2);
    assert.deepStrictEqual(a2, a3);
    passed++;

    // 5. После shutdown сервис продолжает безопасно отвечать через фолбэк, не падая
    await svc.shutdown();
    const afterStop = await svc.samplePtyTrees([['proj1::s1', pid]]);
    ok(afterStop.procs.length === 1 && afterStop.procs[0].procs === 3, 'после shutdown работает прозрачный фолбэк');
  } finally {
    await svc.shutdown();
    await svcLocal.shutdown();
    cleanup();
  }

  console.log(`proc-service: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
