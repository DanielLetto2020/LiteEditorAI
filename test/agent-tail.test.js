// Unit-тесты для lib/agent-tail.js: очистка ANSI/OSC/CSI, обработка \r прогресс-баров, обрезка длины.
'use strict';

const assert = require('assert');
const { extractTailLines } = require('../lib/agent-tail');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

check('extractTailLines strips ANSI CSI/OSC and empty lines, keeping last N lines', () => {
  const raw = '\x1b]0;Claude Code\x07\x1b[32mStep 1\x1b[0m\n\n\x1b[33mWarning line\x1b[0m\nFinal question? (y/n)\n   \n';
  assert.deepStrictEqual(extractTailLines(raw, 4), ['Step 1', 'Warning line', 'Final question? (y/n)']);
});

check('extractTailLines resolves carriage-return progress overwrites cleanly', () => {
  const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%\nDone!\n';
  assert.deepStrictEqual(extractTailLines(raw, 4), ['Downloading 100%', 'Done!']);
});

check('extractTailLines respects maxLines and maxLineLen caps', () => {
  const raw = ['L1', 'L2', 'L3', 'L4', 'L5 ' + 'x'.repeat(200)].join('\n');
  const out = extractTailLines(raw, 3, 20);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0], 'L3');
  assert.strictEqual(out[2].length, 20);
  assert(out[2].endsWith('…'));
});

console.log(`agent-tail.test.js: ${passed} checks passed`);
