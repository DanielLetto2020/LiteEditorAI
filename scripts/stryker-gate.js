#!/usr/bin/env node
// Обёртка над Stryker для гейта `mutation` из .claude/gauntlet.json.
//
// Зачем: храповик std-gauntlet вытаскивает результат из вывода прогона регуляркой
// вида «mutation score <число>». Stryker печатает только таблицу clear-text
// («All files | 75.41 | …»), храповик её не распознаёт и молча пропускает проверку —
// гейт выглядит пройденным, хотя планку никто не держит. Скрипт запускает Stryker,
// читает JSON-отчёт и допечатывает одну строку в понятном храповику виде.
//
// Аргументы пробрасываются в Stryker как есть (gauntlet.sh добавляет --since,
// когда в конфиге включён mutation.changedOnly).
//
// MUTATION_MIN=75 — жёсткий минимум, при котором скрипт сам возвращает ненулевой код.
// Нужен в CI: состояние храповика лежит в .claude/ и в репозиторий не едет, поэтому
// на чистой машине планку держать нечему.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'reports', 'mutation', 'mutation.json');

const run = spawnSync('npx', ['--no-install', 'stryker', 'run', ...process.argv.slice(2)], {
  cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
});

// Мутант считается «проверенным», если тесты его убили (Killed) или он завесил прогон
// (Timeout). Знаменатель — только те статусы, на которые тесты могли повлиять:
// CompileError и Ignored в счёт не идут, иначе метрика зависит от настроек, а не от тестов.
const KILLED = new Set(['Killed', 'Timeout']);
const COUNTED = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage']);

let score = null;
try {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  let killed = 0, total = 0;
  for (const file of Object.values(report.files || {})) {
    for (const m of file.mutants || []) {
      if (!COUNTED.has(m.status)) continue;
      total++;
      if (KILLED.has(m.status)) killed++;
    }
  }
  if (total > 0) score = (killed / total) * 100;
} catch (e) {
  console.error(`Отчёт ${path.relative(ROOT, REPORT)} не прочитан: ${e.message}`);
}

if (score === null) {
  console.error('Mutation score посчитать не удалось — храповик пропустит проверку.');
  process.exit(run.status === 0 ? 1 : (run.status || 1));
}

console.log(`Mutation score: ${score.toFixed(2)}%`);

const min = Number(process.env.MUTATION_MIN);
if (Number.isFinite(min) && score < min) {
  console.error(`Ниже минимума: ${score.toFixed(2)}% < ${min}% — тесты проверяют код хуже, чем раньше.`);
  process.exit(1);
}

process.exit(run.status || 0);
