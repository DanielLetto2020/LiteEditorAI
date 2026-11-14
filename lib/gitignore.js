// ============================================================================
// lib/gitignore.js — быстрый компилятор и кэш правил .gitignore проекта поверх
// базового набора служебных каталогов DEFAULT_IGNORE_DIRS.
//
// Используется в:
//   • fs:watch (lib/tree-watch.js) — чтобы временные/сборочные каталоги из .gitignore
//     (.stryker-tmp, dist-release, coverage, var/cache, .infection и т.п.) не съедали
//     лимит ядра fs.inotify.max_user_watches;
//   • walkProjectFiles / files:listAll / files:search / gsearch:start / auditWalkFs —
//     чтобы скомпилированные бандлы и артефакты не засоряли Ctrl+P и поиск по коду;
//   • fs:readDir — чтобы сборочные каталоги из .gitignore скрывались в дереве наравне
//     с node_modules, сохраняя видимость корневых конфигов вроде .env.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', 'target', '.cache', '.idea',
  'vendor', '.nuxt', '.output',
]);

/**
 * Нормализует относительный путь к POSIX-виду без ведущих `./` и `/`.
 * @param {string} relPath
 */
function normRel(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/\/+$/, '');
}

/**
 * Переводит один паттерн .gitignore (без ведущего `!` и хвостового `/`) в RegExp.
 * @param {string} pat
 * @param {boolean} anchored
 * @returns {RegExp | null}
 */
function globToRegExp(pat, anchored) {
  let p = pat;
  if (p.startsWith('/')) p = p.slice(1);
  if (!p) return null;

  let re = anchored ? '^' : '(?:^|/)';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) {
      re += p[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 2;
      continue;
    }
    if (ch === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          // leading or middle "**/": ноль или более директорий
          re += '(?:.+/)?';
          i += 3;
          continue;
        }
        if (i + 2 === p.length) {
          // trailing "**": всё внутри
          re += '.*';
          i += 2;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const close = p.indexOf(']', i + 1);
      if (close > i + 1) {
        let cls = p.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close + 1;
        continue;
      }
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  re += '$';
  try { return new RegExp(re); } catch (_) { return null; }
}

/**
 * Разбирает содержимое файла .gitignore в массив правил.
 * @param {string} content
 */
function parseRules(content) {
  /** @type {Array<{ re: RegExp, negated: boolean, dirOnly: boolean }>} */
  const rules = [];
  if (!content || typeof content !== 'string') return rules;

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine) continue;
    // Срезаем неэкранированные хвостовые пробелы
    let line = rawLine.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    if (line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (!line) continue;

    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;

    // По правилам git: если в паттерне (без хвостового '/') есть '/', он привязан к корню
    const anchored = line.includes('/');
    const re = globToRegExp(line, anchored);
    if (re) rules.push({ re, negated, dirOnly });
  }
  return rules;
}

/**
 * Компилирует матчер игнорирования из текста `.gitignore` и базового набора каталогов.
 * @param {string} [content]
 * @param {Set<string>} [baseIgnore]
 */
function compileGitignore(content = '', baseIgnore = DEFAULT_IGNORE_DIRS) {
  const rules = parseRules(content);

  /**
   * Проверяет конкретный узел (файл или каталог), предполагая, что его родительские
   * каталоги уже прошли проверку при обходе дерева сверху вниз.
   * @param {string} relPath
   * @param {boolean} [isDir]
   */
  function ignores(relPath, isDir = false) {
    const rel = normRel(relPath);
    if (!rel) return false;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      // Базовый список служебных каталогов отсекает как сам каталог, так и пути внутри него
      if ((isDir || i < parts.length - 1) && baseIgnore.has(parts[i])) return true;
    }
    if (!rules.length) return false;

    let ignored = false;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negated;
    }
    return ignored;
  }

  /**
   * Полная проверка произвольного относительного пути (включая проверку всех его
   * родительских каталогов — для фильтрации одиночных событий fs.watch).
   * @param {string} relPath
   * @param {boolean} [isDir]
   */
  function ignoresPath(relPath, isDir = false) {
    const rel = normRel(relPath);
    if (!rel) return false;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      if ((isDir || i < parts.length - 1) && baseIgnore.has(parts[i])) return true;
    }
    if (!rules.length) return false;

    // Если любой родительский каталог игнорируется целиком, всё внутри него игнорируется
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? prefix + '/' + parts[i] : parts[i];
      let dirIgnored = false;
      for (let j = 0; j < rules.length; j++) {
        const r = rules[j];
        if (r.re.test(prefix)) dirIgnored = !r.negated;
      }
      if (dirIgnored) return true;
    }
    return ignores(rel, isDir);
  }

  return {
    ignores,
    ignoresPath,
    hasRules: rules.length > 0,
  };
}

/** @type {Map<string, { mtimeMs: number, size: number, matcher: ReturnType<typeof compileGitignore> }>} */
const projectCache = new Map();

/**
 * Возвращает (с кэшированием по mtime/size) матчер `.gitignore` для корня проекта `root`.
 * @param {string} root
 * @param {Set<string>} [baseIgnore]
 */
function forProject(root, baseIgnore = DEFAULT_IGNORE_DIRS) {
  if (!root) return compileGitignore('', baseIgnore);
  const rootNorm = path.resolve(root);
  const giFile = path.join(rootNorm, '.gitignore');
  const key = rootNorm + '::' + (baseIgnore === DEFAULT_IGNORE_DIRS ? 'default' : [...baseIgnore].join(','));

  let st;
  try { st = fs.statSync(giFile); } catch (_) { st = null; }

  const mtimeMs = st ? st.mtimeMs : -1;
  const size = st ? st.size : -1;
  const hit = projectCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.matcher;

  let content = '';
  if (st && st.isFile() && st.size <= 512 * 1024) {
    try { content = fs.readFileSync(giFile, 'utf8'); } catch (_) { content = ''; }
  }
  const matcher = compileGitignore(content, baseIgnore);
  projectCache.set(key, { mtimeMs, size, matcher });
  if (projectCache.size > 200) {
    const oldest = projectCache.keys().next().value;
    if (oldest) projectCache.delete(oldest);
  }
  return matcher;
}

/**
 * Находит ближайший корень с `.gitignore` или `.git` вверх от `dir` (не выше домашней папки
 * или корня ФС), чтобы фильтрация каталогов в `fs:readDir` работала на любой глубине проекта.
 * @param {string} dir
 * @returns {string | null}
 */
function findIgnoreRoot(dir) {
  if (!dir) return null;
  let cur = path.resolve(dir);
  for (let depth = 0; depth < 24; depth++) {
    try {
      if (fs.existsSync(path.join(cur, '.gitignore')) || fs.existsSync(path.join(cur, '.git'))) {
        return cur;
      }
    } catch (_) {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

module.exports = {
  DEFAULT_IGNORE_DIRS,
  compileGitignore,
  forProject,
  findIgnoreRoot,
  normRel,
};
