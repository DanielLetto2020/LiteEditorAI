// Лёгкое слежение за состоянием Git проекта (без рекурсивного обхода тысяч рабочих папок).
// Нужно главному окну редактора для живого чипа ветки и счётчика изменений, когда окно/док
// «Проект» и «Обработка текста» закрыты (или когда огромный монорепозиторий упёрся в ELIMIT).
// Держит всего несколько дескрипторов fs.watch: корень проекта, .git (включая git worktree,
// где .git — файл `gitdir: ...`) и дерево .git/refs.

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 180;
const DEFAULT_MAX_REF_DIRS = 64;

const GIT_META_FILES = new Set([
  'HEAD',
  'index',
  'packed-refs',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'AUTO_MERGE',
  'refs',
  'worktrees',
]);

/**
 * Распознать каталоги метаданных Git для классического репозитория и для git worktree / submodule.
 * @param {string} root
 * @returns {{ gitDir: string, commonDir: string } | null}
 */
function resolveGitDirs(root) {
  if (!root) return null;
  const dotGit = path.join(root, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch (_) { return null; }

  let gitDir = null;
  if (st.isDirectory()) {
    gitDir = dotGit;
  } else if (st.isFile()) {
    let raw;
    try { raw = fs.readFileSync(dotGit, 'utf8').slice(0, 1024); } catch (_) { return null; }
    const m = /^gitdir:\s*(.+)$/m.exec(raw);
    if (!m) return null;
    const target = path.resolve(root, m[1].trim());
    try {
      if (fs.statSync(target).isDirectory()) gitDir = target;
    } catch (_) { return null; }
  }
  if (!gitDir) return null;

  let commonDir = gitDir;
  const commonFile = path.join(gitDir, 'commondir');
  try {
    if (fs.statSync(commonFile).isFile()) {
      const rel = fs.readFileSync(commonFile, 'utf8').slice(0, 1024).trim();
      if (rel) {
        const resolved = path.resolve(gitDir, rel);
        if (fs.statSync(resolved).isDirectory()) commonDir = resolved;
      }
    }
  } catch (_) {}

  return { gitDir, commonDir };
}

/**
 * @param {string | null | undefined} name
 * @returns {boolean}
 */
function isGitMetaName(name) {
  if (!name) return true;
  if (name.endsWith('.lock')) return false;
  return GIT_META_FILES.has(name);
}

/**
 * Поставить лёгкое наблюдение за Git-состоянием корня `root`.
 * @param {string} root
 * @param {() => void} onChange
 * @param {{ debounceMs?: number, maxRefDirs?: number, writeTmpSuffix?: string }} [opts]
 * @returns {{ close: () => void, size: () => number, hasGit: () => boolean }}
 */
function watchGitLite(root, onChange, opts = {}) {
  const absRoot = path.resolve(root);
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  const maxRefDirs = opts.maxRefDirs || DEFAULT_MAX_REF_DIRS;
  const tmpSuffix = opts.writeTmpSuffix || '.lite-tmp';

  /** @type {Map<string, fs.FSWatcher>} */
  const watchers = new Map();
  /** @type {Set<string>} */
  const refDirs = new Set();
  let closed = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let gitAttached = false;

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) {
        try { onChange(); } catch (_) {}
      }
    }, debounceMs);
  };

  const dropWatcher = (dir) => {
    const w = watchers.get(dir);
    if (!w) return;
    watchers.delete(dir);
    refDirs.delete(dir);
    try { w.close(); } catch (_) {}
  };

  const dropSubtree = (base) => {
    const prefix = base + path.sep;
    for (const d of [...watchers.keys()]) {
      if (d === base || d.startsWith(prefix)) dropWatcher(d);
    }
  };

  /**
   * @param {string} dir
   * @param {(type: string, name: string | null) => void} handler
   * @param {boolean} [isRef]
   */
  const addDirWatcher = (dir, handler, isRef = false) => {
    if (closed || watchers.has(dir)) return false;
    if (isRef && refDirs.size >= maxRefDirs) return false;
    let w;
    try {
      w = fs.watch(dir, (type, filename) => {
        if (closed || !watchers.has(dir)) return;
        handler(type, filename == null ? null : String(filename));
      });
    } catch (_) {
      return false;
    }
    w.on('error', () => dropWatcher(dir));
    watchers.set(dir, w);
    if (isRef) refDirs.add(dir);
    return true;
  };

  const watchRefsSubtree = (startDir) => {
    if (closed) return;
    const stack = [startDir];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir) continue;
      const onRefEvent = (type, name) => {
        if (name && name.endsWith('.lock')) return;
        if (type === 'rename' && name) {
          const child = path.join(dir, name);
          try {
            if (fs.statSync(child).isDirectory()) watchRefsSubtree(child);
            else dropSubtree(child);
          } catch (_) {
            dropSubtree(child);
          }
        }
        schedule();
      };
      if (!watchers.has(dir) && !addDirWatcher(dir, onRefEvent, true)) continue;
      if (refDirs.size >= maxRefDirs) break;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of entries) {
        if (ent.isDirectory()) stack.push(path.join(dir, ent.name));
      }
    }
  };

  const clearGitWatchers = () => {
    for (const d of [...watchers.keys()]) {
      if (d !== absRoot) dropWatcher(d);
    }
    gitAttached = false;
  };

  const syncGitDirs = () => {
    if (closed) return;
    const dirs = resolveGitDirs(absRoot);
    if (!dirs) {
      clearGitWatchers();
      return;
    }
    gitAttached = true;
    const { gitDir, commonDir } = dirs;
    const refsRoot = path.join(commonDir, 'refs');
    const onMeta = (type, name) => {
      if (!isGitMetaName(name)) return;
      if (type === 'rename' && name === 'refs') watchRefsSubtree(refsRoot);
      schedule();
    };
    addDirWatcher(gitDir, onMeta, false);
    if (commonDir !== gitDir) addDirWatcher(commonDir, onMeta, false);
    try {
      if (fs.statSync(refsRoot).isDirectory()) watchRefsSubtree(refsRoot);
    } catch (_) {}
  };

  addDirWatcher(absRoot, (type, name) => {
    if (name && name.endsWith(tmpSuffix)) return;
    if (name === '.git') {
      syncGitDirs();
      schedule();
      return;
    }
    if (!name || name === '.gitignore' || type === 'rename' || type === 'change') {
      schedule();
    }
  }, false);

  syncGitDirs();

  const close = () => {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    for (const w of watchers.values()) { try { w.close(); } catch (_) {} }
    watchers.clear();
    refDirs.clear();
    gitAttached = false;
  };

  return {
    close,
    size: () => watchers.size,
    hasGit: () => gitAttached,
  };
}

module.exports = {
  resolveGitDirs,
  isGitMetaName,
  watchGitLite,
};
