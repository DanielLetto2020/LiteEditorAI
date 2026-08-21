#!/usr/bin/env node
// Перед стартом закрываем уже запущенные копии LiteEditorAI.
// При разработке приложение запускают по многу раз подряд, и копии копятся —
// пользователю приходится закрывать их вручную. Здесь они закрываются сами.
//
// Опознаём копию по уникальному признаку запуска: --class=LiteEditorAI.
// Свои же процессы (эту команду, npm, шелл-обёртку) не трогаем: их командная строка
// содержит ту же подстроку, поэтому пропускаем себя и всех своих родителей.
const { execSync } = require('child_process');

const MARK = '--class=LiteEditorAI';

function ancestors() {
  const out = new Set([process.pid]);
  if (process.platform === 'win32') return out;
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    try {
      const ppid = parseInt(execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8' }).trim(), 10);
      if (!ppid || ppid <= 1) break;
      out.add(ppid);
      pid = ppid;
    } catch (_) { break; }
  }
  return out;
}

function main() {
  if (process.platform === 'win32') return; // на Windows разберёмся отдельно, если понадобится
  let lines = [];
  try {
    lines = execSync('ps -axo pid=,command=', { encoding: 'utf8' }).split('\n');
  } catch (_) { return; }

  const skip = ancestors();
  const victims = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    if (!cmd.includes(MARK)) continue;
    if (skip.has(pid)) continue;
    if (!/electron/i.test(cmd)) continue; // только само приложение, не скрипты вокруг него
    victims.push(pid);
  }

  for (const pid of victims) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  }
  if (victims.length) console.log(`[start] закрыто ранее запущенных копий: ${victims.length}`);
}

main();
