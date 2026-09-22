// Тест дерева процессов для индикатора активности (lib/proctree.js): обход только потомков шелла
// даёт тот же ответ, что и прежний полный обход /proc, и foregroundKind на настоящем терминале
// отличает «программа спит и ждёт» от «программа считает». Только Linux; терминал берём у
// утилиты script (util-linux), node-pty тут не нужен. Запуск: node test/proctree.test.js
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const pt = require('../lib/proctree');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'linux') { console.log('proctree: пропущен — только Linux'); process.exit(0); }
// Под Stryker (мутационное тестирование, npm run mutation) весь набор тестов гоняется на каждого
// мутанта, а lib/proctree.js не мутируется: тест с настоящим терминалом (~3 с) там только удлинял бы CI.
// Песочницу узнаём по пути: переменные окружения Stryker в начальный прогон не попадают.
if (__dirname.includes('.stryker-tmp') || process.env.STRYKER_MUTATOR_WORKER) { console.log('proctree: пропущен под Stryker'); process.exit(0); }

// Процесс по ppid, найденный полным обходом — независимая проверка обхода через children.
function kidsByScan(pid) { return pt.allPids().filter((p) => { const st = pt.readProcStat(p); return st && st.ppid === pid; }); }

(async () => {
  const kids = [];
  const cleanup = () => { for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch (_) {} } };
  process.on('exit', cleanup);
  try {
    // --- группа из шелла и двух sleep: потомки через children = потомки по полному обходу ---
    const g = spawn('sh', ['-c', 'sleep 30 & sleep 31 & wait'], { detached: true, stdio: 'ignore' });
    kids.push(g);
    await wait(200);
    const desc = pt.descendants(g.pid);
    ok(Array.isArray(desc), 'children доступен в этом ядре');
    const byScan = kidsByScan(g.pid);
    ok(desc.length === 2 && byScan.every((p) => desc.includes(p)), 'обход через children совпал с полным: ' + desc + ' / ' + byScan);
    const a = pt.groupState(g.pid, [g.pid, ...desc]);
    const b = pt.groupState(g.pid, pt.allPids());
    ok(a.alive && !a.running && b.alive === a.alive && b.running === a.running, 'состояние группы то же, что при полном обходе');
    ok(pt.descendants(999999999).length === 0, 'несуществующий процесс — пустой список, без исключения');

    // --- настоящий терминал: интерактивный bash под script, команда на переднем плане ---
    if (spawnSync('sh', ['-c', 'command -v script']).status !== 0) { console.log('proctree: script не найден — проверка терминала пропущена'); return; }
    async function kindFor(cmd) {
      const s = spawn('script', ['-qfc', 'bash --norc --noprofile -i', '/dev/null'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      kids.push(s);
      await wait(300);
      s.stdin.write(cmd + '\n');
      await wait(500);
      const bash = pt.descendants(s.pid).find((p) => { const st = pt.readProcStat(p); return st && st.comm === 'bash'; });
      const res = [];
      for (let i = 0; i < 3; i++) { res.push(pt.foregroundKind(bash)); await wait(50); }
      return { bash, res };
    }
    const idle = await kindFor('');
    ok(idle.bash && idle.res.every((k) => k === 'shell'), 'голый шелл → shell: ' + idle.res);
    const sleeping = await kindFor('sleep 30');
    ok(sleeping.res.every((k) => k === 'waiting'), 'sleep на переднем плане → waiting: ' + sleeping.res);
    const busy = await kindFor('yes > /dev/null');
    ok(busy.res.includes('running'), 'yes на переднем плане → running: ' + busy.res);
    ok(pt.foregroundKind(busy.bash, 'darwin') === null, 'не Linux → null (текстовый фолбэк)');
  } finally {
    cleanup();
  }
  console.log(`proctree: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
