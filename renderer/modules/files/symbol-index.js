// Индекс символов файла и проекта, резолвер путей импортов, диагностика JSON/YAML и форматирование.
// Не зависит от DOM — работает асинхронно мелкими квантами, не блокируя главный поток рендерера,
// и напрямую покрывается модульными тестами (test/viewer-ide.test.js).
import yaml from 'js-yaml';

const INDEXABLE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'php', 'phtml', 'py', 'go', 'rs', 'css', 'scss', 'less',
  'vue', 'svelte', 'rb', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'sql', 'sh',
]);

const RESOLVE_EXTS = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.php', '.py', '.vue', '.svelte', '.css', '.scss', '.less', '.json', '.sql',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.php',
];

const SKIP_KEYWORDS = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'catch', 'finally',
  'return', 'throw', 'new', 'typeof', 'delete', 'void', 'await', 'yield', 'import', 'export',
  'function', 'class', 'super', 'this', 'try', 'with', 'debugger', 'sizeof', 'match',
]);

export const SYMBOL_GLYPHS = {
  class: 'C',
  interface: 'I',
  type: 'T',
  enum: 'E',
  fn: 'ƒ',
  method: 'm',
  const: 'K',
  prop: 'p',
  rule: '{}',
  ns: 'N',
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  h4: 'H4',
};

export function kindGlyph(k) {
  if (k && SYMBOL_GLYPHS[k]) return SYMBOL_GLYPHS[k];
  return /^h\d$/i.test(k) ? String(k).toUpperCase() : '•';
}

export function kindToCompletionType(k) {
  switch (k) {
    case 'class': return 'class';
    case 'interface': return 'interface';
    case 'type': case 'enum': return 'type';
    case 'fn': return 'function';
    case 'method': return 'method';
    case 'const': return 'constant';
    case 'prop': case 'rule': return 'property';
    default: return 'variable';
  }
}

// Проставить ориентировочную конечную строку блока (endLine) по балансу фигурных скобок или отступам,
// чтобы хлебные крошки и Sticky Scroll показывали символ ТОЛЬКО пока курсор реально внутри него.
function attachEndLines(syms, lines, indentBased = false) {
  if (!syms.length) return syms;
  if (indentBased) {
    for (let idx = 0; idx < syms.length; idx++) {
      const s = syms[idx];
      const baseLine = lines[s.line - 1] || '';
      const baseIndent = baseLine.length - baseLine.trimStart().length;
      let end = s.line;
      for (let ln = s.line + 1; ln <= lines.length; ln++) {
        const raw = lines[ln - 1];
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        const ind = raw.length - raw.trimStart().length;
        if (ind <= baseIndent) break;
        end = ln;
      }
      s.endLine = Math.max(s.line, end);
    }
    return syms;
  }

  for (let idx = 0; idx < syms.length; idx++) {
    const s = syms[idx];
    const nextStart = syms[idx + 1] ? syms[idx + 1].line - 1 : lines.length;
    let depth = 0, opened = false, end = s.line;
    const maxScan = Math.min(lines.length, s.line + 1200);
    for (let ln = s.line; ln <= maxScan; ln++) {
      const raw = lines[ln - 1] || '';
      // Быстрый подсчёт { } вне простых кавычек и строчных комментариев //
      let inStr = '';
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === inStr) inStr = '';
          continue;
        }
        if (ch === '/' && raw[i + 1] === '/') break;
        if (ch === '"' || ch === '\'' || ch === '`') { inStr = ch; continue; }
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') {
          depth--;
          if (opened && depth <= 0) { end = ln; ln = maxScan + 1; break; }
        }
      }
      if (!opened && ln > s.line + 2) { end = s.line; break; }
    }
    s.endLine = opened ? Math.max(s.line, end) : Math.min(s.line + 1, nextStart || s.line);
  }
  return syms;
}

export function extractFileSymbols(text, ext) {
  const src = String(text || '');
  if (!src) return [];
  const e = String(ext || '').toLowerCase();
  const lines = src.split('\n');
  const syms = [];
  const push = (line, name, kind, detail = '', exported = false) => {
    if (!name || SKIP_KEYWORDS.has(name)) return;
    syms.push({ line, endLine: line, name, kind, detail, exported });
  };

  if (e === 'md' || e === 'markdown') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i]);
      if (m) push(i + 1, m[2].trim(), 'h' + m[1].length);
    }
    for (let i = 0; i < syms.length; i++) {
      const lvl = parseInt(syms[i].kind.slice(1), 10) || 6;
      let end = lines.length;
      for (let j = i + 1; j < syms.length; j++) {
        if ((parseInt(syms[j].kind.slice(1), 10) || 6) <= lvl) { end = syms[j].line - 1; break; }
      }
      syms[i].endLine = Math.max(syms[i].line, end);
    }
    return syms;
  }

  if (e === 'py' || e === 'pyw') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let m;
      if ((m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(ln))) {
        push(i + 1, m[2], m[1].length ? 'method' : 'fn', (m[3] || '()').trim(), !m[1].length && !m[2].startsWith('_'));
      } else if ((m = /^(\s*)class\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(ln))) {
        push(i + 1, m[2], 'class', (m[3] || '').trim(), !m[1].length);
      } else if ((m = /^([A-Z][A-Z0-9_]{2,})\s*=/.exec(ln))) {
        push(i + 1, m[1], 'const', '', true);
      }
    }
    return attachEndLines(syms, lines, true);
  }

  if (e === 'php' || e === 'phtml') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let m;
      if ((m = /^\s*namespace\s+([A-Za-z_\\][\w\\]*)/.exec(ln))) push(i + 1, m[1], 'ns', '', true);
      else if ((m = /^\s*(?:final\s+|abstract\s+|readonly\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(ln))) {
        push(i + 1, m[2], m[1] === 'interface' ? 'interface' : m[1] === 'enum' ? 'enum' : 'class', m[1], true);
      } else if ((m = /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(ln))) {
        const isMethod = /^\s*(?:public|protected|private)\b/.test(ln);
        const pub = !/^\s*(?:private|protected)\b/.test(ln);
        push(i + 1, m[1], isMethod ? 'method' : 'fn', (m[2] || '()').trim(), pub);
      } else if ((m = /^\s*(?:public\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/.exec(ln))) {
        push(i + 1, m[1], 'const', '', true);
      }
    }
    return attachEndLines(syms, lines, false);
  }

  if (e === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let m;
      if ((m = /^func\s+\(([^)]+)\)\s*([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(ln))) {
        push(i + 1, m[2], 'method', `(${m[1].trim()}) ${m[3] || '()'}`, /^[A-Z]/.test(m[2]));
      } else if ((m = /^func\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(ln))) {
        push(i + 1, m[1], 'fn', (m[2] || '()').trim(), /^[A-Z]/.test(m[1]));
      } else if ((m = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(ln))) {
        push(i + 1, m[1], m[2] === 'interface' ? 'interface' : 'class', m[2], /^[A-Z]/.test(m[1]));
      } else if ((m = /^type\s+([A-Za-z_]\w*)\b/.exec(ln))) {
        push(i + 1, m[1], 'type', '', /^[A-Z]/.test(m[1]));
      }
    }
    return attachEndLines(syms, lines, false);
  }

  if (e === 'rs') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let m;
      if ((m = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)*fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(\([^)]*\))?/.exec(ln))) {
        push(i + 1, m[2], /^\s{2,}/.test(ln) ? 'method' : 'fn', (m[3] || '()').trim(), !!m[1]);
      } else if ((m = /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/.exec(ln))) {
        const k = m[2] === 'trait' ? 'interface' : m[2] === 'enum' ? 'enum' : m[2] === 'type' ? 'type' : 'class';
        push(i + 1, m[3], k, m[2], !!m[1]);
      } else if ((m = /^\s*(pub\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*:/.exec(ln))) {
        push(i + 1, m[2], 'const', '', !!m[1]);
      }
    }
    return attachEndLines(syms, lines, false);
  }

  if (e === 'css' || e === 'scss' || e === 'sass' || e === 'less') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let m;
      if ((m = /^\s*(--[A-Za-z0-9_-]+)\s*:/.exec(ln))) {
        push(i + 1, m[1], 'const', 'CSS var', true);
      } else if (!/^\s*@(media|keyframes|supports|import|font-face|layer)\b/.test(ln) && (m = /^([.#&:[a-zA-Z][^{};/]*?)\s*\{/.exec(ln))) {
        push(i + 1, m[1].trim().slice(0, 64), 'rule', '', /\.[\w-]+/.test(m[1]));
      }
    }
    return attachEndLines(syms, lines, false);
  }

  if (e === 'json' || e === 'jsonc') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s{0,4})"([^"\\]+)"\s*:/.exec(lines[i]);
      if (m) push(i + 1, m[2], 'prop');
    }
    return syms;
  }

  if (e === 'yml' || e === 'yaml') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s{0,4})([A-Za-z0-9_.-]+)\s*:/.exec(lines[i]);
      if (m && !lines[i].trimStart().startsWith('#')) push(i + 1, m[2], 'prop');
    }
    return attachEndLines(syms, lines, true);
  }

  if (e === 'sql') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)/i.exec(lines[i]);
      if (m) push(i + 1, m[2].replace(/["`[\]]/g, ''), m[1].toUpperCase().includes('FUNC') || m[1].toUpperCase().includes('PROC') ? 'fn' : 'class', m[1].toUpperCase(), true);
    }
    return syms;
  }

  if (e === 'sh' || e === 'bash' || e === 'zsh') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/.exec(lines[i])
        || /^\s*function\s+([A-Za-z_][\w-]*)\s*\{?/.exec(lines[i]);
      if (m) push(i + 1, m[1], 'fn', '()');
    }
    return attachEndLines(syms, lines, false);
  }

  // JS / TS / JSX / TSX / Vue / C-подобные языки (Java, C#, Kotlin, C/C++)
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || /^\s*(\/\/|\/\*|\*)/.test(ln)) continue;
    let m;
    const isExp = /^\s*export\b/.test(ln);
    if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(\([^)]*\))?/.exec(ln))) {
      push(i + 1, m[1], 'fn', (m[2] || '()').trim(), isExp);
    } else if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|final\s+|public\s+)*(class|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(ln))) {
      push(i + 1, m[2], m[1] === 'interface' ? 'interface' : m[1] === 'enum' ? 'enum' : 'class', m[1], isExp);
    } else if ((m = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/.exec(ln))) {
      push(i + 1, m[1], 'type', 'type', isExp);
    } else if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(ln))) {
      const sig = m[2].startsWith('(') ? m[2].trim() : `(${m[2]})`;
      push(i + 1, m[1], 'fn', sig, isExp);
    } else if ((m = /^\s*(?:export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(ln))) {
      push(i + 1, m[1], 'const', '', true);
    } else if ((m = /^\s*const\s+([A-Z][A-Z0-9_]{2,})\s*=/.exec(ln))) {
      push(i + 1, m[1], 'const', '', false);
    } else if ((m = /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(\([^;={]*\))\s*(?::\s*[^{;]+)?\{/.exec(ln))) {
      push(i + 1, m[1], 'method', m[2].trim(), false);
    }
  }
  return attachEndLines(syms, lines, false);
}

// Найти самый глубокий охватывающий символ для заданной строки (1-based).
export function enclosingSymbolAtLine(syms, lineNumber) {
  let best = null;
  for (const s of syms) {
    if (s.line <= lineNumber && (s.endLine == null || lineNumber <= s.endLine)) {
      if (!best || s.line >= best.line) best = s;
    }
  }
  return best;
}

// Слово-идентификатор под курсором (offset 0-based в строке/документе).
export function wordAtOffset(text, offset) {
  const str = String(text || '');
  if (!str || offset < 0 || offset > str.length) return null;
  const isWord = (ch) => /[\w$А-Яа-яЁё-]/.test(ch);
  let s = offset, e = offset;
  while (s > 0 && isWord(str[s - 1])) s--;
  while (e < str.length && isWord(str[e])) e++;
  if (s === e) return null;
  const word = str.slice(s, e);
  // отсекаем дефис справа/слева для обычных идентификаторов, кроме CSS-переменных (--foo-bar)
  if (!word.startsWith('--') && word.includes('-')) {
    let s2 = offset, e2 = offset;
    const isId = (ch) => /[\w$А-Яа-яЁё]/.test(ch);
    while (s2 > 0 && isId(str[s2 - 1])) s2--;
    while (e2 < str.length && isId(str[e2])) e2++;
    if (s2 < e2) return { word: str.slice(s2, e2), from: s2, to: e2 };
    return null;
  }
  return { word, from: s, to: e };
}

// Найти все точные вхождения идентификатора в тексте файла (для Rename Symbol in File / подсветки).
export function findIdentifierRanges(text, ident) {
  if (!ident || !/^[\w$А-Яа-яЁё-]+$/.test(ident)) return [];
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w$А-Яа-яЁё])${escaped}(?![\\w$А-Яа-яЁё])`, 'g');
  const ranges = [];
  let m;
  while ((m = re.exec(text)) && ranges.length < 2000) {
    ranges.push({ from: m.index, to: m.index + ident.length });
  }
  return ranges;
}

// Извлечь путь модуля/файла из строки импорта (под курсором в кавычках или в import/require/include).
export function extractImportSpecAtLine(lineText, colOffset = -1) {
  const ln = String(lineText || '');
  // 1) Если передан colOffset — проверяем строковый литерал прямо под курсором
  const strRe = /(['"`])([^'"`\n]{1,240})\1/g;
  let m;
  const candidates = [];
  while ((m = strRe.exec(ln))) {
    const start = m.index + 1;
    const end = start + m[2].length;
    candidates.push({ spec: m[2], from: start, to: end, fullLine: ln });
  }
  if (!candidates.length) return null;
  const isImportLine = /\b(import|export|from|require|include|include_once|require_once|src|href|url)\b/.test(ln)
    || /@import\b/.test(ln);
  if (colOffset >= 0) {
    const under = candidates.find((c) => colOffset >= c.from - 1 && colOffset <= c.to + 1);
    if (under && (isImportLine || under.spec.startsWith('./') || under.spec.startsWith('../') || under.spec.startsWith('@/'))) {
      return under.spec;
    }
  }
  if (isImportLine) return candidates[candidates.length - 1].spec;
  return null;
}

function normSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

function normalizeRelSegments(rel) {
  const out = [];
  for (const seg of normSlash(rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

// Разрешить путь импорта относительно открытого файла по списку файлов проекта (rel-пути через '/').
export function resolveImportTarget(projRoot, fromAbsFile, spec, allRelFiles) {
  if (!projRoot || !fromAbsFile || !spec) return null;
  const cleanSpec = String(spec).split(/[?#]/)[0].trim();
  if (!cleanSpec || /^(https?:|data:|mailto:|node:)/i.test(cleanSpec)) return null;

  const rootNorm = normSlash(projRoot).replace(/\/+$/, '');
  const fromNorm = normSlash(fromAbsFile);
  const fromRel = fromNorm.startsWith(rootNorm + '/') ? fromNorm.slice(rootNorm.length + 1) : '';
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';

  const fileSet = allRelFiles instanceof Set ? allRelFiles : new Set((allRelFiles || []).map(normSlash));
  const bases = [];
  if (cleanSpec.startsWith('./') || cleanSpec.startsWith('../')) {
    bases.push(normalizeRelSegments((fromDir ? fromDir + '/' : '') + cleanSpec));
  } else if (cleanSpec.startsWith('@/') || cleanSpec.startsWith('~/')) {
    const tail = cleanSpec.slice(2);
    bases.push(normalizeRelSegments('src/' + tail), normalizeRelSegments('renderer/' + tail), normalizeRelSegments(tail));
  } else if (cleanSpec.startsWith('/')) {
    bases.push(normalizeRelSegments(cleanSpec.slice(1)));
  } else {
    // относительный без './' (HTML/CSS/PHP) или корень проекта
    if (fromDir) bases.push(normalizeRelSegments(fromDir + '/' + cleanSpec));
    bases.push(normalizeRelSegments(cleanSpec), normalizeRelSegments('src/' + cleanSpec));
  }

  const sep = String(projRoot).includes('\\') ? '\\' : '/';
  for (const base of bases) {
    if (!base) continue;
    for (const ext of RESOLVE_EXTS) {
      const cand = base + ext;
      if (fileSet.has(cand)) {
        return rootNorm.replace(/\//g, sep) + sep + cand.replace(/\//g, sep);
      }
    }
  }
  return null;
}

// Фоновый неблокирующий индексер символов проекта.
export function createProjectSymbolIndex({ readFile, listAll, maxFiles = 600, maxFileBytes = 220000 } = {}) {
  let rootPath = null;
  let buildToken = 0;
  const byFile = new Map(); // relPath -> Symbol[]
  let allRelFiles = [];
  let allRelSet = new Set();

  function extOfRel(rel) {
    const i = rel.lastIndexOf('.');
    return i > 0 ? rel.slice(i + 1).toLowerCase() : '';
  }

  function shouldIndex(rel) {
    if (!rel) return false;
    if (/(^|\/)(node_modules|vendor|dist|dist-release|build|\.git|\.next|coverage)\//.test(rel)) return false;
    if (/\.min\.(js|css)$/i.test(rel)) return false;
    return INDEXABLE_EXTS.has(extOfRel(rel));
  }

  async function indexSingleRel(root, rel) {
    if (!shouldIndex(rel)) { byFile.delete(rel); return; }
    const sep = String(root).includes('\\') ? '\\' : '/';
    const abs = String(root).replace(/[/\\]+$/, '') + sep + rel.replace(/\//g, sep);
    let res;
    try { res = await readFile(abs); } catch (_) { return; }
    if (!res || res.error || typeof res.content !== 'string' || res.content.length > maxFileBytes || res.content.includes('\0')) return;
    const ext = extOfRel(rel);
    const syms = extractFileSymbols(res.content, ext);
    if (syms.length) byFile.set(rel, syms);
    else byFile.delete(rel);
  }

  async function rebuild(projRoot, preloadedFiles = null) {
    const token = ++buildToken;
    rootPath = projRoot;
    byFile.clear();
    allRelFiles = [];
    allRelSet = new Set();
    if (!projRoot || !listAll || !readFile) return;

    let files = preloadedFiles;
    if (!files) {
      const r = await listAll(projRoot);
      if (token !== buildToken || !r) return;
      if (Array.isArray(r)) files = r.map(normSlash);
      else if (!r.error) files = (r.files || []).map(normSlash);
      else return;
    }
    allRelFiles = files;
    allRelSet = new Set(files);

    const targets = files.filter(shouldIndex).slice(0, maxFiles);
    let sliceStart = performance.now();
    for (let i = 0; i < targets.length; i++) {
      if (token !== buildToken) return;
      await indexSingleRel(projRoot, targets[i]);
      if (performance.now() - sliceStart > 10) {
        await new Promise((r) => setTimeout(r, 0));
        sliceStart = performance.now();
      }
    }
  }

  async function onFilesChanged(projRoot, changedFiles) {
    if (!projRoot || projRoot !== rootPath) return;
    const rootNorm = normSlash(projRoot).replace(/\/+$/, '');
    for (const item of (changedFiles || [])) {
      const n = normSlash(item);
      const rel = n.startsWith(rootNorm + '/') ? n.slice(rootNorm.length + 1) : n.replace(/^\/+/, '');
      if (!rel) continue;
      allRelSet.add(rel);
      if (!allRelFiles.includes(rel)) allRelFiles.push(rel);
      await indexSingleRel(projRoot, rel);
    }
  }

  function updateFromOpenBuffer(projRoot, absFile, text) {
    if (!projRoot || projRoot !== rootPath || !absFile) return;
    const rootNorm = normSlash(projRoot).replace(/\/+$/, '');
    const n = normSlash(absFile);
    if (!n.startsWith(rootNorm + '/')) return;
    const rel = n.slice(rootNorm.length + 1);
    if (!shouldIndex(rel)) return;
    const syms = extractFileSymbols(text, extOfRel(rel));
    if (syms.length) byFile.set(rel, syms);
    else byFile.delete(rel);
  }

  function findDefinitions(name) {
    if (!name) return [];
    const hits = [];
    for (const [rel, syms] of byFile) {
      for (const s of syms) {
        if (s.name === name) hits.push({ rel, ...s });
      }
    }
    // Экспортируемые и верхнеуровневые символы — первыми
    hits.sort((a, b) => (Number(!!b.exported) - Number(!!a.exported)) || a.rel.localeCompare(b.rel));
    return hits;
  }

  function searchSymbols(query, limit = 150) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const [rel, syms] of byFile) {
      for (const s of syms) {
        if (!q || s.name.toLowerCase().includes(q)) {
          out.push({ rel, ...s });
          if (!q && out.length >= limit) return out;
        }
      }
    }
    if (q) {
      out.sort((a, b) => {
        const aExact = a.name.toLowerCase() === q ? 0 : a.name.toLowerCase().startsWith(q) ? 1 : 2;
        const bExact = b.name.toLowerCase() === q ? 0 : b.name.toLowerCase().startsWith(q) ? 1 : 2;
        return aExact - bExact || Number(!a.exported) - Number(!b.exported) || a.name.length - b.name.length;
      });
    }
    return out.slice(0, limit);
  }

  function getCompletionSymbols(excludeRel = '') {
    const seen = new Map();
    for (const [rel, syms] of byFile) {
      if (rel === excludeRel) continue;
      const base = rel.split('/').pop() || rel;
      for (const s of syms) {
        if (!s.exported && s.kind !== 'class' && s.kind !== 'fn' && s.kind !== 'interface' && s.kind !== 'const') continue;
        if (s.name.length < 2) continue;
        if (!seen.has(s.name)) {
          seen.set(s.name, {
            label: s.name,
            type: kindToCompletionType(s.kind),
            detail: (s.detail ? s.detail + ' · ' : '') + base,
            boost: s.exported ? 8 : 3,
          });
        }
      }
    }
    return [...seen.values()];
  }

  return {
    rebuild,
    startIndex: rebuild,
    invalidate: () => (rootPath ? rebuild(rootPath) : Promise.resolve()),
    onFilesChanged,
    updateFromOpenBuffer,
    findDefinitions,
    searchSymbols,
    getCompletionSymbols,
    getFiles: () => allRelFiles,
    getFileSet: () => allRelSet,
    getRoot: () => rootPath,
  };
}

// Быстрый локатор точного смещения синтаксической ошибки JSON (фолбэк, когда V8 в конце строки опускает "at position N").
function findJsonErrorOffset(src) {
  let i = 0;
  const len = src.length;
  const skipWs = () => { while (i < len && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++; };
  const parseStr = () => {
    i++; // '"'
    while (i < len) {
      const ch = src[i];
      if (ch === '"') { i++; return true; }
      if (ch === '\\') { i += 2; continue; }
      if (src.charCodeAt(i) < 0x20) return false;
      i++;
    }
    return false;
  };
  const parseVal = () => {
    skipWs();
    if (i >= len) return false;
    const ch = src[i];
    if (ch === '"') return parseStr();
    if (ch === '{') {
      i++; skipWs();
      if (i < len && src[i] === '}') { i++; return true; }
      while (i < len) {
        skipWs();
        if (src[i] !== '"') return false;
        if (!parseStr()) return false;
        skipWs();
        if (src[i] !== ':') return false;
        i++;
        if (!parseVal()) return false;
        skipWs();
        if (src[i] === '}') { i++; return true; }
        if (src[i] !== ',') return false;
        i++;
      }
      return false;
    }
    if (ch === '[') {
      i++; skipWs();
      if (i < len && src[i] === ']') { i++; return true; }
      while (i < len) {
        if (!parseVal()) return false;
        skipWs();
        if (src[i] === ']') { i++; return true; }
        if (src[i] !== ',') return false;
        i++;
      }
      return false;
    }
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return true; }
    if (src.startsWith('null', i)) { i += 4; return true; }
    const mNum = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (mNum) { i += mNum[0].length; return true; }
    return false;
  };
  if (!parseVal()) return Math.min(i, Math.max(0, len - 1));
  skipWs();
  return i < len ? i : Math.max(0, len - 1);
}

// Точная диагностика синтаксиса для JSON и YAML (без внешних процессов, за <1 мс).
export function validateDocumentSyntax(text, ext) {
  const e = String(ext || '').toLowerCase();
  const src = String(text || '');
  if (!src.trim() || src.length > 500000) return [];

  if (e === 'json') {
    try {
      JSON.parse(src);
      return [];
    } catch (err) {
      const msg = String((err && err.message) || 'Синтаксическая ошибка JSON');
      const mLineCol = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
      if (mLineCol) {
        return [{
          line: Math.max(1, parseInt(mLineCol[1], 10)),
          col: Math.max(1, parseInt(mLineCol[2], 10)),
          severity: 'error',
          message: msg,
        }];
      }
      const mPos = msg.match(/position\s+(\d+)/i);
      const pos = mPos ? parseInt(mPos[1], 10) : findJsonErrorOffset(src);
      if (pos >= 0 && pos <= src.length) {
        let line = 1, lastNl = -1;
        for (let i = 0; i < pos; i++) if (src[i] === '\n') { line++; lastNl = i; }
        return [{ line, col: pos - lastNl, severity: 'error', message: msg }];
      }
      return [{ line: 1, col: 1, severity: 'error', message: msg }];
    }
  }

  if (e === 'yml' || e === 'yaml') {
    try {
      yaml.loadAll(src);
      return [];
    } catch (err) {
      const mark = err && err.mark;
      const line = mark && typeof mark.line === 'number' ? mark.line + 1 : 1;
      const col = mark && typeof mark.column === 'number' ? mark.column + 1 : 1;
      const reason = (err && err.reason) ? String(err.reason) : String((err && err.message) || 'Ошибка YAML').split('\n')[0];
      return [{ line, col, severity: 'error', message: reason }];
    }
  }

  return [];
}

// Форматирование документа: pretty-print JSON + нормализация висячих пробелов и финального \n.
export function formatCodeText(text, ext, indentSpec = { useTabs: false, size: 2 }, trimTrailing = true) {
  const e = String(ext || '').toLowerCase();
  let out = String(text || '').replace(/\r\n?/g, '\n');
  const sz = Math.max(1, (indentSpec && (indentSpec.tabSize || indentSpec.size)) || 2);
  const indentStr = indentSpec && indentSpec.useTabs ? '\t' : ' '.repeat(sz);

  if (e === 'json') {
    const parsed = JSON.parse(out); // при ошибке пробросит исключение — вызывающий покажет тост
    return JSON.stringify(parsed, null, indentStr) + '\n';
  }

  if (trimTrailing) {
    const keepMdBreaks = e === 'md' || e === 'markdown';
    out = out.split('\n').map((ln) => {
      if (keepMdBreaks && /[^ \t] {2}$/.test(ln)) {
        return ln;
      }
      return ln.replace(/[ \t]+$/, '');
    }).join('\n');
  }
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  return out;
}
