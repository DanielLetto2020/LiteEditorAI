// Многослойное умное автодополнение (Smart Autocomplete) для редактора «Проект»:
//   1) относительные пути файлов проекта внутри import / require / from / include / src / href / url();
//   2) умные сниппеты с таб-стопами (snippetCompletion) по расширению файла;
//   3) символы текущего файла и фонового индекса проекта (с сигнатурами и именем файла-источника);
//   4) ключевые слова для языков без встроенного AST-комплита (PHP, Go, Rust, Shell);
//   5) идентификаторы из текущего и всех открытых буферов (без дублей).
// Подключается через EditorState.languageData.of(...), НЕ затирая встроенные грамматические
// автодополнения CodeMirror 6 (HTML-теги, CSS-свойства, SQL, JS/Python/JSON).
import { snippetCompletion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { extractFileSymbols, kindToCompletionType } from './symbol-index.js';

const COMPLETE_DOC_MAX = 500000;
const WORD_RE = /[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]{2,}/g;

const SNIPPETS_BY_GROUP = {
  js: [
    snippetCompletion('function ${1:name}(${2:params}) {\n\t${0}\n}', { label: 'fn', detail: 'function declaration', type: 'keyword', boost: 12 }),
    snippetCompletion('async function ${1:name}(${2:params}) {\n\t${0}\n}', { label: 'afn', detail: 'async function', type: 'keyword', boost: 12 }),
    snippetCompletion('(${1:params}) => {\n\t${0}\n}', { label: 'arf', detail: 'arrow function', type: 'keyword', boost: 10 }),
    snippetCompletion('console.log(${1:value});${0}', { label: 'log', detail: 'console.log(…)', type: 'function', boost: 14 }),
    snippetCompletion("import { ${2:name} } from '${1:./module.js}';${0}", { label: 'imp', detail: 'ES module import', type: 'keyword', boost: 12 }),
    snippetCompletion('export function ${1:name}(${2:params}) {\n\t${0}\n}', { label: 'expf', detail: 'export function', type: 'keyword', boost: 11 }),
    snippetCompletion('try {\n\t${1}\n} catch (${2:err}) {\n\t${0}\n}', { label: 'tryc', detail: 'try / catch', type: 'keyword', boost: 11 }),
    snippetCompletion('for (const ${1:item} of ${2:items}) {\n\t${0}\n}', { label: 'foro', detail: 'for … of', type: 'keyword', boost: 10 }),
  ],
  ts: [
    snippetCompletion('export interface ${1:Name} {\n\t${2:id}: ${3:string};\n\t${0}\n}', { label: 'intf', detail: 'export interface', type: 'interface', boost: 13 }),
    snippetCompletion('export type ${1:Name} = ${0};', { label: 'typea', detail: 'export type alias', type: 'type', boost: 12 }),
  ],
  php: [
    snippetCompletion('<?php\n\ndeclare(strict_types=1);\n\nnamespace ${1:App};\n\n${0}', { label: 'php', detail: 'PHP strict file header', type: 'keyword', boost: 15 }),
    snippetCompletion('public function ${1:name}(${2}): ${3:void}\n{\n\t${0}\n}', { label: 'pubf', detail: 'public method', type: 'method', boost: 14 }),
    snippetCompletion('private function ${1:name}(${2}): ${3:void}\n{\n\t${0}\n}', { label: 'prif', detail: 'private method', type: 'method', boost: 13 }),
    snippetCompletion('protected function ${1:name}(${2}): ${3:void}\n{\n\t${0}\n}', { label: 'prof', detail: 'protected method', type: 'method', boost: 13 }),
    snippetCompletion('public function __construct(${1})\n{\n\t${0}\n}', { label: '__construct', detail: 'constructor', type: 'method', boost: 13 }),
    snippetCompletion('foreach (${1:$items} as ${2:$key} => ${3:$item}) {\n\t${0}\n}', { label: 'fore', detail: 'foreach ($items as …)', type: 'keyword', boost: 12 }),
    snippetCompletion('final class ${1:ClassName}\n{\n\t${0}\n}', { label: 'cls', detail: 'final class', type: 'class', boost: 12 }),
  ],
  py: [
    snippetCompletion('def ${1:name}(${2:args}) -> ${3:None}:\n    ${0:pass}', { label: 'def', detail: 'function definition', type: 'function', boost: 13 }),
    snippetCompletion('async def ${1:name}(${2:args}) -> ${3:None}:\n    ${0:pass}', { label: 'adef', detail: 'async def', type: 'function', boost: 13 }),
    snippetCompletion('class ${1:ClassName}:\n    def __init__(self${2:, args}) -> None:\n        ${0:pass}', { label: 'cls', detail: 'class definition', type: 'class', boost: 12 }),
    snippetCompletion('if __name__ == "__main__":\n    ${0:main()}', { label: 'ifmain', detail: '__main__ guard', type: 'keyword', boost: 12 }),
  ],
  go: [
    snippetCompletion('if err != nil {\n\treturn ${0:err}\n}', { label: 'iferr', detail: 'if err != nil', type: 'keyword', boost: 15 }),
    snippetCompletion('func ${1:Name}(${2:ctx context.Context}) ${3:error} {\n\t${0}\n}', { label: 'fn', detail: 'func declaration', type: 'function', boost: 13 }),
    snippetCompletion('type ${1:Name} struct {\n\t${0}\n}', { label: 'tys', detail: 'type struct', type: 'class', boost: 13 }),
  ],
  rs: [
    snippetCompletion('pub fn ${1:name}(${2:args}) -> ${3:Result<(), Box<dyn std::error::Error>>} {\n    ${0}\n}', { label: 'pfn', detail: 'pub fn', type: 'function', boost: 13 }),
    snippetCompletion('#[derive(Debug, Clone${1})]\npub struct ${2:Name} {\n    ${0}\n}', { label: 'pstruct', detail: 'pub struct', type: 'class', boost: 13 }),
  ],
  html: [
    snippetCompletion('<!doctype html>\n<html lang="${1:ru}">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${2:Document}</title>\n</head>\n<body>\n  ${0}\n</body>\n</html>', { label: 'html5', detail: 'HTML5 boilerplate', type: 'keyword', boost: 15 }),
    snippetCompletion('<link rel="stylesheet" href="${1:styles.css}">${0}', { label: 'link:css', detail: '<link stylesheet>', type: 'keyword', boost: 12 }),
    snippetCompletion('<script type="module" src="${1:app.js}"></script>${0}', { label: 'script:src', detail: '<script module>', type: 'keyword', boost: 12 }),
  ],
  css: [
    snippetCompletion('display: flex;\nalign-items: ${1:center};\njustify-content: ${2:space-between};\ngap: ${3:8px};${0}', { label: 'flex', detail: 'flexbox container', type: 'property', boost: 13 }),
    snippetCompletion('display: grid;\ngrid-template-columns: ${1:repeat(auto-fill, minmax(240px, 1fr))};\ngap: ${2:12px};${0}', { label: 'grid', detail: 'CSS grid container', type: 'property', boost: 13 }),
    snippetCompletion('@media (max-width: ${1:768px}) {\n  ${0}\n}', { label: 'media', detail: '@media query', type: 'keyword', boost: 12 }),
  ],
  sql: [
    snippetCompletion('SELECT ${1:*}\nFROM ${2:table_name}\nWHERE ${3:1 = 1}\nLIMIT ${0:100};', { label: 'sel', detail: 'SELECT … FROM … WHERE', type: 'keyword', boost: 14 }),
    snippetCompletion('INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${0:values});', { label: 'ins', detail: 'INSERT INTO …', type: 'keyword', boost: 13 }),
    snippetCompletion('UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${0:id = 1};', { label: 'upd', detail: 'UPDATE … SET …', type: 'keyword', boost: 13 }),
  ],
};

const EXTRA_KEYWORDS = {
  php: [
    'namespace', 'use', 'class', 'interface', 'trait', 'enum', 'extends', 'implements',
    'public', 'protected', 'private', 'static', 'readonly', 'final', 'abstract', 'function',
    'return', 'match', 'yield', 'fn', 'null', 'true', 'false', 'self', 'parent',
    'array_map', 'array_filter', 'array_merge', 'in_array', 'implode', 'explode',
    'json_encode', 'json_decode', 'isset', 'empty', 'sprintf', 'str_contains', 'str_starts_with',
  ].map((w) => ({ label: w, type: w.includes('_') ? 'function' : 'keyword', boost: 4 })),
  go: [
    'package', 'import', 'func', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer',
    'select', 'range', 'return', 'var', 'const', 'fallthrough', 'context', 'fmt', 'errors',
  ].map((w) => ({ label: w, type: 'keyword', boost: 4 })),
  rs: [
    'fn', 'pub', 'mod', 'use', 'struct', 'enum', 'trait', 'impl', 'where', 'let', 'mut',
    'match', 'async', 'await', 'move', 'crate', 'super', 'Self', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err', 'Vec', 'String',
  ].map((w) => ({ label: w, type: /^[A-Z]/.test(w) ? 'type' : 'keyword', boost: 4 })),
  sh: [
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'case', 'esac', 'while',
    'function', 'local', 'export', 'readonly', 'return', 'exit', 'set', 'echo', 'printf',
  ].map((w) => ({ label: w, type: 'keyword', boost: 4 })),
};

function snippetsForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (['ts', 'tsx', 'mts', 'cts'].includes(e)) return [...SNIPPETS_BY_GROUP.js, ...SNIPPETS_BY_GROUP.ts];
  if (['js', 'jsx', 'mjs', 'cjs'].includes(e)) return SNIPPETS_BY_GROUP.js;
  if (['php', 'phtml'].includes(e)) return SNIPPETS_BY_GROUP.php;
  if (['py', 'pyw'].includes(e)) return SNIPPETS_BY_GROUP.py;
  if (e === 'go') return SNIPPETS_BY_GROUP.go;
  if (e === 'rs') return SNIPPETS_BY_GROUP.rs;
  if (['html', 'htm', 'vue', 'svelte'].includes(e)) return SNIPPETS_BY_GROUP.html;
  if (['css', 'scss', 'sass', 'less'].includes(e)) return SNIPPETS_BY_GROUP.css;
  if (e === 'sql') return SNIPPETS_BY_GROUP.sql;
  return [];
}

function keywordsForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (['php', 'phtml'].includes(e)) return EXTRA_KEYWORDS.php;
  if (e === 'go') return EXTRA_KEYWORDS.go;
  if (e === 'rs') return EXTRA_KEYWORDS.rs;
  if (['sh', 'bash', 'zsh'].includes(e)) return EXTRA_KEYWORDS.sh;
  return [];
}

function normSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

// Автодополнение относительных путей внутри кавычек import / require / include / src / href / url()
export function completeRelativePaths(linePrefix, projRoot, currentFile, allRelFiles) {
  if (!projRoot || !currentFile || !allRelFiles || !allRelFiles.length) return null;
  const m = /(?:from\s+|import\s+|require\s*\(\s*|include(?:_once)?\s*\(?\s*|require_once\s*\(?\s*|(?:src|href)\s*=\s*|url\s*\(\s*)(['"`])([^'"`]*)$/.exec(linePrefix);
  if (!m) return null;
  const rawTyped = m[2];
  if (/^(https?:|data:|mailto:)/i.test(rawTyped)) return null;

  const rootNorm = normSlash(projRoot).replace(/\/+$/, '');
  const curNorm = normSlash(currentFile);
  const curRel = curNorm.startsWith(rootNorm + '/') ? curNorm.slice(rootNorm.length + 1) : '';
  const curDir = curRel.includes('/') ? curRel.slice(0, curRel.lastIndexOf('/')) : '';

  // Какую папку проекта просматриваем
  const slashIdx = rawTyped.lastIndexOf('/');
  const dirPrefix = slashIdx >= 0 ? rawTyped.slice(0, slashIdx + 1) : '';
  let targetDir;
  if (dirPrefix.startsWith('./') || dirPrefix.startsWith('../')) {
    const parts = (curDir ? curDir + '/' + dirPrefix : dirPrefix).split('/');
    const stack = [];
    for (const seg of parts) {
      if (!seg || seg === '.') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    targetDir = stack.join('/');
  } else if (dirPrefix.startsWith('/')) {
    targetDir = dirPrefix.replace(/^\/+|\/+$/g, '');
  } else if (dirPrefix) {
    targetDir = (curDir ? curDir + '/' : '') + dirPrefix.replace(/\/+$/, '');
  } else {
    targetDir = curDir;
  }

  const prefixWithSlash = targetDir ? targetDir + '/' : '';
  const seenDirs = new Set();
  const options = [];
  for (const rel of allRelFiles) {
    if (rel === curRel) continue;
    if (targetDir ? !rel.startsWith(prefixWithSlash) : false) continue;
    const rest = targetDir ? rel.slice(prefixWithSlash.length) : rel;
    if (!rest) continue;
    const subSlash = rest.indexOf('/');
    if (subSlash >= 0) {
      const folder = rest.slice(0, subSlash);
      if (!seenDirs.has(folder)) {
        seenDirs.add(folder);
        const ins = (dirPrefix || './') + folder + '/';
        options.push({ label: folder + '/', apply: slashIdx >= 0 ? folder + '/' : ins, type: 'keyword', detail: 'папка', boost: 10 });
      }
    } else {
      const ins = slashIdx >= 0 ? rest : ('./' + rest);
      options.push({ label: rest, apply: ins, type: 'text', detail: targetDir || '.', boost: 8 });
    }
    if (options.length >= 150) break;
  }
  if (!options.length) return null;
  const replaceFromOffset = slashIdx >= 0 ? (linePrefix.length - (rawTyped.length - slashIdx - 1)) : (linePrefix.length - rawTyped.length);
  return { replaceFromInLine: replaceFromOffset, options };
}

// Кэш слов на иммутабельный инстанс Text документа CodeMirror
const docWordCache = new WeakMap();
function extractWordsFromState(state) {
  if (!state || !state.doc || state.doc.length > COMPLETE_DOC_MAX) return [];
  let cached = docWordCache.get(state.doc);
  if (cached) return cached;
  const seen = new Set();
  const text = state.doc.toString();
  WORD_RE.lastIndex = 0;
  let m, guard = 0;
  while ((m = WORD_RE.exec(text)) && guard++ < 40000) seen.add(m[0]);
  cached = [...seen];
  docWordCache.set(state.doc, cached);
  return cached;
}

function extractWordsFromString(text) {
  if (!text || text.length > COMPLETE_DOC_MAX) return [];
  const seen = new Set();
  WORD_RE.lastIndex = 0;
  let m, guard = 0;
  while ((m = WORD_RE.exec(text)) && guard++ < 40000) seen.add(m[0]);
  return [...seen];
}

// Создать расширение умного автодополнения, привязанное к контексту редактора «Проект».
export function createSmartCompletionExtension({
  getCurrentFile, getProjectRoot, getAllRelFiles, getExt, symbolIndex, getOpenStates, getOpenDocsText,
}) {
  let lastLocalDoc = null;
  let lastLocalFile = null;
  let lastLocalSyms = [];

  function source(context) {
    const file = getCurrentFile ? getCurrentFile() : null;
    const projRoot = getProjectRoot ? getProjectRoot() : null;
    const line = context.state.doc.lineAt(context.pos);
    const linePrefix = line.text.slice(0, context.pos - line.from);

    // 1. Автоподсказка путей импортов внутри кавычек
    const cachedRel = getAllRelFiles ? getAllRelFiles() : [];
    const allFiles = (cachedRel && cachedRel.length) ? cachedRel : (symbolIndex ? symbolIndex.getFiles() : []);
    const pathHit = completeRelativePaths(linePrefix, projRoot, file, allFiles);
    if (pathHit) {
      return {
        from: line.from + pathHit.replaceFromInLine,
        options: pathHit.options,
        validFor: /^[^'"`\s]*$/,
      };
    }

    // 2. Идентификаторы, CSS-переменные (--var), PHP-переменные ($var)
    const ext = getExt
      ? getExt()
      : (file && file.lastIndexOf('.') > 0 ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : '');
    const wordMatch = context.matchBefore(/(?:--|\$)?[\wА-Яа-яЁё$]{1,}/);
    if (!wordMatch && !context.explicit) return null;
    // Не всплывать автоматически на 1 символе обычного текста (кроме $, -- или явного Ctrl+Space)
    if (wordMatch && !context.explicit && wordMatch.to - wordMatch.from < 2 && !wordMatch.text.startsWith('$') && !wordMatch.text.startsWith('--')) {
      return null;
    }

    const from = wordMatch ? wordMatch.from : context.pos;
    const curWord = wordMatch ? wordMatch.text : '';
    const seen = new Set();
    if (curWord) seen.add(curWord);
    const options = [];
    const addOpt = (opt) => {
      if (!opt || !opt.label || seen.has(opt.label)) return;
      seen.add(opt.label);
      options.push(opt);
    };

    // Слой A: сниппеты языка
    for (const sn of snippetsForExt(ext)) addOpt(sn);

    // Слой B: символы текущего файла
    if (context.state.doc.length <= COMPLETE_DOC_MAX) {
      if (lastLocalDoc !== context.state.doc || lastLocalFile !== file) {
        lastLocalDoc = context.state.doc;
        lastLocalFile = file;
        lastLocalSyms = extractFileSymbols(context.state.doc.toString(), ext);
      }
      for (const s of lastLocalSyms) {
        addOpt({
          label: s.name,
          type: kindToCompletionType(s.kind),
          detail: s.detail || 'этот файл',
          boost: 10,
        });
      }
    }

    // Слой C: символы всего проекта из фонового индекса
    if (symbolIndex && projRoot && file) {
      const rootNorm = normSlash(projRoot).replace(/\/+$/, '');
      const curNorm = normSlash(file);
      const curRel = curNorm.startsWith(rootNorm + '/') ? curNorm.slice(rootNorm.length + 1) : '';
      for (const ps of symbolIndex.getCompletionSymbols(curRel)) addOpt(ps);
    }

    // Слой D: ключевые слова (PHP / Go / Rust / Shell)
    for (const kw of keywordsForExt(ext)) addOpt(kw);

    // Слой E: слова текущего документа + других открытых вкладок (BufferPool)
    for (const w of extractWordsFromState(context.state)) {
      addOpt({ label: w, type: 'text', boost: -2 });
    }
    if (getOpenStates) {
      for (const st of getOpenStates()) {
        if (!st || st === context.state) continue;
        for (const w of extractWordsFromState(st)) {
          addOpt({ label: w, type: 'text', detail: 'открыт', boost: -4 });
        }
      }
    } else if (getOpenDocsText) {
      for (const txt of getOpenDocsText()) {
        for (const w of extractWordsFromString(txt)) {
          addOpt({ label: w, type: 'text', detail: 'открыт', boost: -4 });
        }
      }
    }

    return {
      from,
      options,
      validFor: /^(?:--|\$)?[\wА-Яа-яЁё$-]*$/,
    };
  }

  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}
