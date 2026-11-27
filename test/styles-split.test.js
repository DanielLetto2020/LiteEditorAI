// Тест целостности модульного разбиения CSS (renderer/core.css, renderer/styles.css и renderer/styles/*.css).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

let checks = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks++;
}

function parseImports(cssFile) {
  const txt = fs.readFileSync(cssFile, 'utf8');
  return [...txt.matchAll(/@import\s+["']([^"']+)["']\s*;/g)].map((m) => m[1]);
}

const coreImports = parseImports(path.join(RENDERER, 'core.css'));
const fullImports = parseImports(path.join(RENDERER, 'styles.css'));

ok(coreImports.length === 2, 'core.css должен импортировать ровно 2 базовых слоя (base + editor-shell)');
ok(fullImports.length === 5, 'styles.css должен импортировать все 5 тематических слоёв');
ok(coreImports.every((rel, idx) => fullImports[idx] === rel), 'порядок базовых слоёв в core.css и styles.css обязан совпадать');

let coreCombined = '';
for (const rel of fullImports) {
  const file = path.resolve(RENDERER, rel);
  ok(fs.existsSync(file), `отсутствует CSS-слой: ${rel}`);
  const css = fs.readFileSync(file, 'utf8');
  ok(css.length > 500, `CSS-слой подозрительно пуст: ${rel}`);

  // Проверка баланса комментариев /* */ и скобок { }
  const openComments = (css.match(/\/\*/g) || []).length;
  const closeComments = (css.match(/\*\//g) || []).length;
  ok(openComments === closeComments, `незакрытый комментарий в ${rel}`);

  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  const openBraces = (stripped.match(/\{/g) || []).length;
  const closeBraces = (stripped.match(/\}/g) || []).length;
  ok(openBraces > 0 && openBraces === closeBraces, `дисбаланс фигурных скобок в ${rel}: ${openBraces} !== ${closeBraces}`);

  // Проверка валидности локальных url(...) относительно самого CSS-файла
  for (const m of stripped.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const ref = m[1].trim();
    if (/^(data:|https?:|blob:|#)/i.test(ref)) continue;
    const assetPath = path.resolve(path.dirname(file), ref.split('?')[0].split('#')[0]);
    ok(fs.existsSync(assetPath), `битая ссылка url(${ref}) в ${rel} -> ${assetPath}`);
  }

  if (coreImports.includes(rel)) coreCombined += css + '\n';
}

// Ключевые селекторы главного окна обязаны присутствовать в core.css
for (const mustHave of [':root', '#app', '#sidebar', '#terminal-pane', '#bottombar', '#mcp-pane', '#preview-pane', '#files-dock', '#ext-pane', '.modal', '.toast', '.hidden', 'body.win-frame']) {
  ok(coreCombined.includes(mustHave), `в core.css отсутствует ключевой селектор главного окна: ${mustHave}`);
}

// Тяжёлые стили оконных модулей НЕ должны попадать в core.css
for (const modOnly of ['.db-ide', '.srv-proj', '.tp-columns', '.gg-canvas']) {
  ok(!coreCombined.includes(modOnly), `модульный селектор ${modOnly} не должен грузиться в core.css главного окна`);
}

console.log(`✓ styles-split: ${checks} проверок пройдено`);
