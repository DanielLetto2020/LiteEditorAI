// Тест отчёта Claude Code для индикатора активности (lib/agentstate.js): файл присутствия
// <каталог>/sessions/<pid>.json читается только для живого процесса с тем же временем старта,
// каталог берётся из CLAUDE_CONFIG_DIR процесса, а agentState на настоящем терминале находит
// Claude в группе переднего плана. Только Linux. Запуск: node test/agentstate.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const as = require('../lib/agentstate');
const pt = require('../lib/proctree');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'linux') { console.log('agentstate: пропущен — только Linux'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-agentstate-'));
const kids = [];
const cleanup = () => {
  for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch (_) {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
};
process.on('exit', cleanup);

// Файл присутствия, как его пишет Claude Code 2.1.281 (лишние поля — для правдоподобия).
function writePresence(dir, pid, extra) {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const st = pt.readProcStat(pid);
  const o = { pid, sessionId: 'x', cwd: '/', procStart: st.start, version: '2.1.281', kind: 'interactive', status: 'idle', ...extra };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  fs.writeFileSync(path.join(dir, 'sessions', pid + '.json'), JSON.stringify(o));
}

(async () => {
  try {
    // --- каталог из CLAUDE_CONFIG_DIR процесса ---
    const cfg = path.join(tmp, 'cfg');
    const a = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
    kids.push(a);
    await wait(100);
    eq(as.configDirOf(a.pid), cfg, 'CLAUDE_CONFIG_DIR прочитан из окружения процесса');
    eq(as.claudePresence(a.pid, tmp), null, 'файла нет — не Claude');
    writePresence(cfg, a.pid, { status: 'busy' });
    eq(as.claudePresence(a.pid, tmp), { status: 'busy', waitingFor: '' }, 'busy');
    writePresence(cfg, a.pid, { status: 'waiting', waitingFor: 'permission prompt' });
    eq(as.claudePresence(a.pid, tmp), { status: 'waiting', waitingFor: 'permission prompt' }, 'waiting с причиной');
    writePresence(cfg, a.pid, { status: 'waiting' });
    eq(as.claudePresence(a.pid, tmp), { status: 'waiting', waitingFor: '' }, 'waiting без причины — пустая строка');
    writePresence(cfg, a.pid, { status: 'idle', waitingFor: 'stale' });
    eq(as.claudePresence(a.pid, tmp), { status: 'idle', waitingFor: '' }, 'причина — только у waiting');
    writePresence(cfg, a.pid, { status: undefined });
    eq(as.claudePresence(a.pid, tmp), null, 'нет статуса (старая версия Claude) — null');
    writePresence(cfg, a.pid, { status: 'thinking' });
    eq(as.claudePresence(a.pid, tmp), null, 'незнакомый статус — null');
    writePresence(cfg, a.pid, { procStart: '1' });
    eq(as.claudePresence(a.pid, tmp), null, 'другое время старта — файл от прежнего процесса с тем же pid');
    writePresence(cfg, a.pid, { procStart: undefined });
    eq(as.claudePresence(a.pid, tmp), { status: 'idle', waitingFor: '' }, 'без procStart — верим pid');
    writePresence(cfg, a.pid, { pid: a.pid + 1 });
    eq(as.claudePresence(a.pid, tmp), null, 'pid в файле не тот');
    fs.writeFileSync(path.join(cfg, 'sessions', a.pid + '.json'), '{"pid":');
    eq(as.claudePresence(a.pid, tmp), null, 'битый JSON (файл дописывается) — null, без исключения');

    // --- без CLAUDE_CONFIG_DIR — <home>/.claude ---
    const envNoCfg = { ...process.env }; delete envNoCfg.CLAUDE_CONFIG_DIR;
    const b = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', env: envNoCfg });
    kids.push(b);
    await wait(100);
    eq(as.configDirOf(b.pid), '', 'переменной нет — пусто');
    writePresence(path.join(tmp, '.claude'), b.pid, { status: 'waiting', waitingFor: 'input needed' });
    eq(as.claudePresence(b.pid, tmp), { status: 'waiting', waitingFor: 'input needed' }, 'каталог по умолчанию — <home>/.claude');
    eq(as.configDirOf(999999999), '', 'несуществующий процесс — пусто, без исключения');
    eq(as.claudePresence(999999999, tmp), null, 'несуществующий процесс — null');
    eq(as.agentState(process.pid, 'darwin'), null, 'не Linux — null (индикатор идёт по заголовку и экрану)');

    // --- настоящий терминал: Claude-подобный процесс на переднем плане интерактивного bash ---
    // Под Stryker тест с терминалом только удлинял бы прогон (как в proctree.test.js).
    if (__dirname.includes('.stryker-tmp') || process.env.STRYKER_MUTATOR_WORKER) return;
    if (spawnSync('sh', ['-c', 'command -v script']).status !== 0) { console.log('agentstate: script не найден — проверка терминала пропущена'); return; }
    const term = path.join(tmp, 'term');
    const s = spawn('script', ['-qfc', 'bash --norc --noprofile -i', '/dev/null'], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, CLAUDE_CONFIG_DIR: term },
    });
    kids.push(s);
    await wait(300);
    const bash = pt.descendants(s.pid).find((p) => { const st = pt.readProcStat(p); return st && st.comm === 'bash'; });
    eq(as.agentState(bash), { fg: 'shell', claude: null }, 'голый шелл — Claude нет');
    s.stdin.write('sleep 30\n');
    await wait(400);
    const g = pt.foregroundGroup(bash);
    eq(g.kind, 'waiting', 'sleep на переднем плане → waiting');
    eq(as.agentState(bash), { fg: 'waiting', claude: null }, 'программа без файла присутствия — не Claude');
    writePresence(term, g.pids[0], { status: 'waiting', waitingFor: 'input needed' });
    eq(as.agentState(bash), { fg: 'waiting', claude: { status: 'waiting', waitingFor: 'input needed' } }, 'Claude на переднем плане найден по группе');
  } finally {
    cleanup();
  }
  console.log(`agentstate: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
