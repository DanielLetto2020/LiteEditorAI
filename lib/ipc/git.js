// Доменный модуль Git: чтение статуса/диффа/лога/графа/blame и мутирующие операции панели Git.

'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Безопасный read-only вызов git с GIT_OPTIONAL_LOCKS=0 и таймаутом 15 с.
 * Возвращает stdout или null при любой ошибке / не-репозитории / таймауте.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string | null>}
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * Корень рабочего дерева в координатах пути проекта (без раскрытия симлинков).
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function gitWorkBase(root) {
  const cdup = await git(root, ['rev-parse', '--show-cdup']);
  return cdup == null ? null : path.resolve(root, cdup.trim());
}

/**
 * @param {object} deps
 * @param {{ handle: (ch: string, fn: (event: any, ...args: any[]) => any) => void, on: (ch: string, fn: (event: any, ...args: any[]) => any) => void }} deps.ipcMain
 * @param {number} deps.maxViewBytes
 * @param {(file: string, kind: string, opts?: any) => Promise<any>} deps.histSnapshotFromDisk
 */
function registerGitIpc({ ipcMain, maxViewBytes, histSnapshotFromDisk }) {
  function parsePorcelainZ(out) {
    const res = [];
    const recs = String(out || '').split('\0');
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      if (/[RC]/.test(xy)) i++;
      res.push({ xy, code: xy.trim(), path: rec.slice(3) });
    }
    return res;
  }

  function parseNameStatusZ(out) {
    const res = [];
    const parts = String(out || '').split('\0');
    for (let i = 0; i < parts.length;) {
      const code = parts[i++].trim();
      if (!code) continue;
      if (code[0] === 'R' || code[0] === 'C') { const from = parts[i++], to = parts[i++]; if (to) res.push({ code, rel: to, from }); }
      else { const p = parts[i++]; if (p) res.push({ code, rel: p }); }
    }
    return res;
  }

  /**
   * @param {string} cwd
   * @param {string[]} args
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<{ ok: boolean, out: string, error: string }>}
   */
  function gitRun(cwd, args, opts = {}) {
    return new Promise((resolve) => {
      execFile('git', args, {
        cwd, timeout: opts.timeout || 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      }, (err, stdout, stderr) => resolve({
        ok: !err,
        out: (stdout || '').trim(),
        error: err ? ((stderr || '').trim() || String(err.message || err)) : '',
      }));
    });
  }

  const OK_HASH = (h) => /^[0-9a-fA-F]{4,40}$/.test(String(h || '').trim());
  const BAD_REF = (s) => !s || String(s).startsWith('-') || /[\s~^:?*[\\]/.test(String(s)) || String(s).includes('..');

  ipcMain.handle('git:status', async (_e, root) => {
    if (!root || !fs.existsSync(root)) return { error: 'no root' };
    const base = await gitWorkBase(root);
    if (base == null) return { repo: false, files: {} };
    const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
    if (out == null) return { repo: true, files: {}, error: 'git status не отработал: слишком много изменённых/новых файлов (нет .gitignore для node_modules/сборки?) или таймаут' };
    /** @type {Record<string, string>} */
    const files = {};
    for (const e of parsePorcelainZ(out)) files[path.join(base, e.path)] = e.code || '?';
    return { repo: true, files };
  });

  ipcMain.handle('git:fileDiff', async (_e, { root, file }) => {
    if (!root) return { error: 'no root' };
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top == null) return { error: 'не git-репозиторий' };
    let out = await git(root, ['diff', 'HEAD', '--', file]);
    if (out != null && out.trim() === '') out = await git(root, ['diff', '--', file]);
    if ((out == null || out.trim() === '') && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const tracked = await git(root, ['ls-files', '--error-unmatch', '--', file]);
      if (tracked == null) {
        try {
          let rel = path.relative(root, file).replace(/\\/g, '/');
          if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) rel = path.basename(file);
          const tooBig = fs.statSync(file).size > maxViewBytes;
          const buf = tooBig ? null : fs.readFileSync(file);
          if (!buf) out = 'diff --git a/' + rel + ' b/' + rel + '\nФайл слишком большой для диффа (новый, не отслеживается)';
          else if (buf.includes(0)) out = 'diff --git a/' + rel + ' b/' + rel + '\nBinary file (новый, не отслеживается)';
          else {
            const lines = buf.toString('utf8').split('\n');
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            out = '--- /dev/null\n+++ b/' + rel + '\n@@ -0,0 +1,' + lines.length + ' @@\n' + lines.map((l) => '+' + l).join('\n');
          }
        } catch (_) {}
      }
    }
    return { diff: out || '' };
  });

  ipcMain.handle('git:filePair', async (_e, { root, file } = {}) => {
    if (!root || !file) return { error: 'no root/file' };
    const base = await gitWorkBase(root);
    if (base == null) return { error: 'не git-репозиторий' };
    const rel = path.relative(base, file).replace(/\\/g, '/');
    const oldText = await git(root, ['show', 'HEAD:' + rel]);
    let newText = null;
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile() && st.size <= maxViewBytes) newText = await fs.promises.readFile(file, 'utf8');
      else if (st.isFile()) return { error: 'файл слишком большой' };
    } catch (_) {}
    if (oldText == null && newText == null) return { error: 'нет содержимого' };
    if ((oldText || '').includes('\0') || (newText || '').includes('\0')) return { error: 'бинарный файл' };
    if ((oldText || '').length > maxViewBytes) return { error: 'файл слишком большой' };
    return { ok: true, oldText: oldText || '', newText: newText || '' };
  });

  ipcMain.handle('git:commitFilePair', async (_e, { root, hash, file } = {}) => {
    const h = String(hash || '').trim();
    if (!/^[0-9a-fA-F]{4,40}$/.test(h)) return { error: 'bad hash' };
    const rel = String(file || '').replace(/\\/g, '/');
    if (!rel) return { error: 'no file' };
    const oldText = await git(root, ['show', h + '^:' + rel]);
    const newText = await git(root, ['show', h + ':' + rel]);
    if (oldText == null && newText == null) return { error: 'нет содержимого' };
    if ((oldText || '').includes('\0') || (newText || '').includes('\0')) return { error: 'бинарный файл' };
    if ((oldText || '').length > maxViewBytes || (newText || '').length > maxViewBytes) return { error: 'файл слишком большой' };
    return { ok: true, oldText: oldText || '', newText: newText || '' };
  });

  ipcMain.handle('git:info', async (_e, root) => {
    if (!root || !fs.existsSync(root)) return { repo: false };
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top == null) return { repo: false };
    const branch = ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim() || 'HEAD';
    let ahead = 0, behind = 0, upstream = false;
    const counts = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (counts != null) { const m = counts.trim().split(/\s+/); behind = +m[0] || 0; ahead = +m[1] || 0; upstream = true; }
    const brOut = await git(root, ['branch', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)']);
    const branches = [];
    /** @type {Record<string, any>} */
    const branchTrack = {};
    if (brOut) for (const line of brOut.split('\n')) {
      if (!line.trim()) continue;
      const [name, up, track] = line.split('\t');
      if (!name) continue;
      branches.push(name);
      let a = 0, bh = 0, gone = false;
      if (track) {
        if (/gone/.test(track)) gone = true;
        const am = track.match(/ahead (\d+)/); if (am) a = +am[1];
        const bm = track.match(/behind (\d+)/); if (bm) bh = +bm[1];
      }
      branchTrack[name] = { upstream: (up || '').trim(), ahead: a, behind: bh, gone };
    }
    const remote = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
    return { repo: true, branch, ahead, behind, upstream, branches, branchTrack, hasRemote: remote.length > 0 };
  });

  ipcMain.handle('git:log', async (_e, { root, limit } = {}) => {
    if (!root || !fs.existsSync(root)) return { error: 'no root' };
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top == null) return { repo: false, commits: [] };
    const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 40));
    const out = await git(root, ['log', `-${n}`, '--pretty=format:%h%x1f%s%x1f%cr%x1f%an%x1f%D']);
    const commits = [];
    if (out) for (const rec of out.split('\n')) {
      if (!rec) continue;
      const [hash, subject, when, author, refs] = rec.split('\x1f');
      commits.push({ hash, subject, when, author, refs: (refs || '').trim() });
    }
    return { repo: true, commits };
  });

  ipcMain.handle('git:graph', async (_e, { root, skip, limit, remotes, tags } = {}) => {
    if (!root || !fs.existsSync(root)) return { ok: false, error: 'no root' };
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top == null) return { repo: false, commits: [] };
    const head = ((await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])) || '').trim();
    const branch = ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim();
    if (!head) return { repo: true, empty: true, commits: [], head: '', branch, more: false };
    const n = Math.max(1, Math.min(1000, parseInt(limit, 10) || 400));
    const s = Math.max(0, parseInt(skip, 10) || 0);
    const args = ['log', '-z', '--topo-order', '--date-order', '--decorate=full', `--skip=${s}`, `-n${n}`,
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D', '--branches', 'HEAD'];
    if (remotes) args.push('--remotes');
    if (tags) args.push('--tags');
    const out = await git(root, args);
    if (out == null) return { ok: false, error: 'git log не выполнился' };
    const commits = [];
    for (const rec of out.split('\0')) {
      if (!rec.trim()) continue;
      const [h, p, an, ae, at, subj, refs] = rec.replace(/^\n+/, '').split('\x1f');
      if (!h) continue;
      commits.push({ h, p: p ? p.split(' ').filter(Boolean) : [], an: an || '', ae: ae || '', at: +at || 0, s: subj || '', refs: (refs || '').trim() });
    }
    return { ok: true, repo: true, commits, head, branch, more: commits.length === n };
  });

  ipcMain.handle('git:refsSig', async (_e, root) => {
    if (!root || !fs.existsSync(root)) return { sig: '' };
    const refs = await git(root, ['for-each-ref', '--format=%(objectname) %(refname)']);
    if (refs == null) return { sig: '' };
    const head = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])) || '';
    const sym = (await git(root, ['symbolic-ref', '-q', 'HEAD'])) || '';
    return { sig: crypto.createHash('sha1').update(refs + '|' + head + '|' + sym).digest('hex') };
  });

  ipcMain.handle('git:commitDetail', async (_e, { root, hash } = {}) => {
    if (!OK_HASH(hash)) return { ok: false, error: 'bad hash' };
    const out = await git(root, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B', String(hash).trim()]);
    if (out == null) return { ok: false, error: 'коммит не найден' };
    const [h, p, an, ae, at, cn, ce, ct, refs, ...body] = out.split('\x1f');
    return { ok: true, h, p: p ? p.split(' ').filter(Boolean) : [], an, ae, at: +at || 0, cn, ce, ct: +ct || 0, refs: (refs || '').trim(), body: body.join('\x1f').trim() };
  });

  ipcMain.handle('git:checkout', async (_e, { root, branch }) =>
    BAD_REF(branch) ? { ok: false, error: 'Недопустимое имя ветки' } : gitRun(root, ['checkout', branch, '--']));
  ipcMain.handle('git:fetch', async (_e, root) => gitRun(root, ['fetch', '--all', '--prune']));
  ipcMain.handle('git:discardFile', async (_e, { root, file }) => {
    await histSnapshotFromDisk(path.isAbsolute(file) ? file : path.join(root, file), 'save', { force: true });
    return gitRun(root, ['checkout', '--', file]);
  });

  ipcMain.handle('git:branchUpdate', async (_e, { root, branch, current }) => {
    if (current) return gitRun(root, ['pull', '--ff-only']);
    if (BAD_REF(branch)) return { ok: false, error: 'Недопустимое имя ветки' };
    const remote = ((await git(root, ['config', `branch.${branch}.remote`])) || '').trim() || 'origin';
    const rb = ((await git(root, ['config', `branch.${branch}.merge`])) || '').trim().replace('refs/heads/', '') || branch;
    return gitRun(root, ['fetch', remote, `${rb}:${branch}`]);
  });

  ipcMain.handle('git:branchCreate', async (_e, { root, name, base, checkout }) => {
    const nm = (name || '').trim();
    if (!nm || nm.startsWith('-') || /[\s~^:?*[\\]/.test(nm) || nm.includes('..')) return { ok: false, error: 'Недопустимое имя ветки' };
    if (base != null && base !== '' && BAD_REF(base)) return { ok: false, error: 'Недопустимая базовая ветка' };
    const from = base ? [base] : [];
    return gitRun(root, checkout ? ['checkout', '-b', nm, ...from] : ['branch', nm, ...from]);
  });

  ipcMain.handle('git:init', async (_e, root) => gitRun(root, ['init']));
  ipcMain.handle('git:clone', async (_e, { root, url }) => {
    const u = (url || '').trim();
    if (!u || u.startsWith('-') || /^(ext|fd)::/i.test(u)) return { ok: false, error: 'Недопустимый URL репозитория' };
    return gitRun(root, ['clone', '--', u, '.'], { timeout: 120000 });
  });

  async function gitPush(root) {
    const first = await gitRun(root, ['push']);
    if (first.ok) return first;
    if (/no upstream branch|--set-upstream|no configured push destination|does not have a branch/i.test(first.error || '')) {
      const remotes = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
      const remote = remotes.includes('origin') ? 'origin' : remotes[0];
      if (remote) return gitRun(root, ['push', '-u', remote, 'HEAD']);
    }
    return first;
  }

  async function gitMidOperation(root) {
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      if ((await git(root, ['rev-parse', '-q', '--verify', ref])) != null) return true;
    }
    return false;
  }

  async function gitStagedRenames(root) {
    const map = new Map();
    const base = await gitWorkBase(root);
    const out = base == null ? null : await git(root, ['diff', '--cached', '--name-status', '-z', '-M']);
    if (out == null) return map;
    for (const e of parseNameStatusZ(out)) if (e.code[0] === 'R' && e.from) map.set(path.resolve(base, e.rel), path.resolve(base, e.from));
    return map;
  }

  ipcMain.handle('git:commit', async (_e, { root, message, push, files, amend }) => {
    const sel = Array.isArray(files) && files.length;
    const msgOnly = amend && Array.isArray(files) && !files.length;
    if (!msgOnly) { const add = await gitRun(root, sel ? ['add', '--', ...files] : ['add', '-A']); if (!add.ok) return add; }
    const midOp = sel && !amend && await gitMidOperation(root);
    let spec = sel ? files : [];
    if (sel && !midOp) {
      const ren = await gitStagedRenames(root);
      const extra = [];
      for (const f of files) { const from = ren.get(path.resolve(root, f)); if (from) extra.push(from); }
      spec = [...files, ...extra];
    }
    const base = amend ? ['commit', '--amend', '-m', message || 'update'] : ['commit', '-m', message || 'update'];
    const c = await gitRun(root, sel && !midOp ? [...base, '--', ...spec] : base); if (!c.ok) return c;
    if (push) { const p = await gitPush(root); if (!p.ok) return { ok: false, committed: true, error: 'Коммит создан, push не прошёл: ' + p.error }; }
    return { ok: true, out: c.out };
  });

  ipcMain.handle('git:lastMessage', async (_e, root) => {
    const out = await git(root, ['log', '-1', '--format=%B']);
    return out == null ? { ok: false, message: '' } : { ok: true, message: out.trim() };
  });

  ipcMain.handle('git:fileLog', async (_e, { root, file, limit } = {}) => {
    if (!root || !file) return { error: 'no root/file' };
    const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
    const out = await git(root, ['log', '--follow', `-${n}`, '--pretty=format:%h%x1f%s%x1f%cr%x1f%an', '--', file]);
    if (out == null) return { error: 'не git-репозиторий или файл не отслеживается' };
    const commits = [];
    for (const rec of out.split('\n')) {
      if (!rec) continue;
      const [hash, subject, when, author] = rec.split('\x1f');
      commits.push({ hash, subject, when, author });
    }
    return { ok: true, commits };
  });

  ipcMain.handle('git:cherryPick', async (_e, { root, hash } = {}) =>
    OK_HASH(hash) ? gitRun(root, ['cherry-pick', String(hash).trim()]) : { ok: false, error: 'bad hash' });
  ipcMain.handle('git:revertCommit', async (_e, { root, hash } = {}) =>
    OK_HASH(hash) ? gitRun(root, ['revert', '--no-edit', String(hash).trim()]) : { ok: false, error: 'bad hash' });
  ipcMain.handle('git:commitMsg', async (_e, { root, hash } = {}) => {
    if (!OK_HASH(hash)) return { error: 'bad hash' };
    const out = await git(root, ['log', '-1', '--format=%B', String(hash).trim()]);
    return out == null ? { error: 'коммит не найден' } : { ok: true, message: out.trim() };
  });

  ipcMain.handle('git:add', async (_e, { root, files }) =>
    gitRun(root, ['add', '--', ...(Array.isArray(files) ? files : [files])]));

  ipcMain.handle('git:conflicts', async (_e, root) => {
    if (!root || !fs.existsSync(root)) return { error: 'no root' };
    const base = await gitWorkBase(root);
    if (base == null) return { repo: false, files: [] };
    const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=no']);
    const files = [];
    for (const e of parsePorcelainZ(out)) {
      if (/U/.test(e.xy) || e.xy === 'DD' || e.xy === 'AA') files.push({ rel: e.path, abs: path.join(base, e.path), code: e.code });
    }
    return { repo: true, files };
  });

  ipcMain.handle('git:merge', async (_e, { root, branch }) =>
    BAD_REF(branch) ? { ok: false, error: 'Недопустимое имя ветки' } : gitRun(root, ['merge', '--no-edit', branch]));

  ipcMain.handle('git:mergeAbort', async (_e, root) => {
    const has = async (ref) => (await git(root, ['rev-parse', '-q', '--verify', ref])) != null;
    if (!(await has('MERGE_HEAD'))) {
      if (await has('CHERRY_PICK_HEAD')) return gitRun(root, ['cherry-pick', '--abort']);
      if (await has('REVERT_HEAD')) return gitRun(root, ['revert', '--abort']);
    }
    return gitRun(root, ['merge', '--abort']);
  });

  ipcMain.handle('git:push', async (_e, root) => gitPush(root));
  ipcMain.handle('git:pull', async (_e, root) => gitRun(root, ['pull', '--ff-only']));
  ipcMain.handle('git:stash', async (_e, root) => gitRun(root, ['stash', 'push', '-u']));

  const DISCARD_HIST_CAP = 60;
  ipcMain.handle('git:discardAll', async (_e, root) => {
    const out = await git(root, ['diff', '--name-only', '-z', '--relative']);
    if (out) {
      for (const rel of out.split('\0').filter(Boolean).slice(0, DISCARD_HIST_CAP))
        await histSnapshotFromDisk(path.join(root, rel), 'save', { force: true });
    }
    return gitRun(root, ['checkout', '--', '.']);
  });

  ipcMain.handle('git:revertHunk', async (_e, { root, patch } = {}) => {
    if (!root || !patch) return { ok: false, error: 'нет патча' };
    return new Promise((resolve) => {
      const child = execFile('git', ['apply', '--reverse', '-'], {
        cwd: root, timeout: 15000, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (err, _stdout, stderr) => resolve({ ok: !err, error: err ? ((stderr || '').trim() || String(err.message || err)) : '' }));
      try { if (child.stdin) { child.stdin.write(patch); child.stdin.end(); } } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  });

  ipcMain.handle('git:blame', async (_e, { root, file } = {}) => {
    if (!root || !file) return { error: 'no root/file' };
    const out = await git(root, ['blame', '--porcelain', '--', file]);
    if (out == null) return { error: 'не git-репозиторий или файл не отслеживается' };
    const lines = [];
    const byHash = new Map();
    /** @type {any} */
    let cur = null;
    for (const ln of out.split('\n')) {
      if (/^[0-9a-f]{40} /.test(ln)) {
        const h = ln.slice(0, 40);
        cur = byHash.get(h);
        if (!cur) { cur = { hash: h.slice(0, 8), uncommitted: /^0{40}$/.test(h) }; byHash.set(h, cur); }
      }
      else if (cur && ln.startsWith('author ')) cur.author = ln.slice(7);
      else if (cur && ln.startsWith('author-time ')) cur.time = parseInt(ln.slice(12), 10) || 0;
      else if (cur && ln.startsWith('summary ')) cur.summary = ln.slice(8);
      else if (cur && ln.startsWith('\t')) { lines.push({ ...cur }); cur = null; }
    }
    return { ok: true, lines };
  });

  const stashRef = (index) => { const i = parseInt(index, 10); return i >= 0 ? `stash@{${i}}` : null; };
  ipcMain.handle('git:stashList', async (_e, root) => {
    const out = await git(root, ['stash', 'list', '--format=%gd%x1f%s%x1f%cr']);
    const items = [];
    if (out) for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [ref, subject, when] = line.split('\x1f');
      const m = /stash@\{(\d+)\}/.exec(ref || '');
      items.push({ index: m ? +m[1] : items.length, ref: ref || '', subject: subject || '', when: when || '' });
    }
    return { ok: true, items };
  });

  ipcMain.handle('git:stashShow', async (_e, { root, index } = {}) => {
    const ref = stashRef(index); if (!ref) return { ok: false, error: 'bad stash index' };
    const out = await git(root, ['stash', 'show', '--include-untracked', '--name-status', '-z', ref]);
    const files = parseNameStatusZ(out).map((e) => ({ code: e.code, rel: e.rel }));
    return { ok: true, files };
  });
  ipcMain.handle('git:stashApply', async (_e, { root, index } = {}) => { const r = stashRef(index); return r ? gitRun(root, ['stash', 'apply', r]) : { ok: false, error: 'bad index' }; });
  ipcMain.handle('git:stashPopIndex', async (_e, { root, index } = {}) => { const r = stashRef(index); return r ? gitRun(root, ['stash', 'pop', r]) : { ok: false, error: 'bad index' }; });
  ipcMain.handle('git:stashDrop', async (_e, { root, index } = {}) => { const r = stashRef(index); return r ? gitRun(root, ['stash', 'drop', r]) : { ok: false, error: 'bad index' }; });

  ipcMain.handle('git:commitFiles', async (_e, { root, hash, firstParent } = {}) => {
    const h = String(hash || '').trim();
    if (!/^[0-9a-fA-F]{4,40}$/.test(h)) return { ok: false, error: 'bad hash' };
    const out = await git(root, ['show', '--no-color', ...(firstParent ? ['-m', '--first-parent'] : []), '--name-status', '-z', '--format=', h]);
    const files = parseNameStatusZ(out).map((e) => ({ code: e.code, rel: e.rel }));
    return { ok: true, files };
  });

  ipcMain.handle('git:commitFileDiff', async (_e, { root, hash, file, firstParent } = {}) => {
    const h = String(hash || '').trim();
    if (!/^[0-9a-fA-F]{4,40}$/.test(h)) return { error: 'bad hash' };
    const out = await git(root, ['show', '--no-color', ...(firstParent ? ['-m', '--first-parent'] : []), '--format=', h, '--', file]);
    return { diff: out || '' };
  });

  ipcMain.handle('git:branches', async (_e, root) => {
    if (!root || !fs.existsSync(root)) return { repo: false };
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (top == null) return { repo: false };
    const current = ((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim();
    const localOut = await git(root, ['for-each-ref', '--format=%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track)', 'refs/heads']);
    const local = [];
    if (localOut) for (const line of localOut.split('\n')) {
      if (!line.trim()) continue;
      const [name, up, track] = line.split('\x1f');
      let ahead = 0, behind = 0, gone = false;
      if (track) { if (/gone/.test(track)) gone = true; const a = track.match(/ahead (\d+)/); if (a) ahead = +a[1]; const b = track.match(/behind (\d+)/); if (b) behind = +b[1]; }
      local.push({ name, upstream: (up || '').trim(), ahead, behind, gone });
    }
    const remoteOut = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
    const remote = [];
    if (remoteOut) for (const line of remoteOut.split('\n')) { const n = line.trim(); if (!n || /\/HEAD$/.test(n)) continue; remote.push(n); }
    return { repo: true, current, local, remote };
  });

  ipcMain.handle('git:branchRename', async (_e, { root, from, to } = {}) => {
    if (BAD_REF(to) || BAD_REF(from)) return { ok: false, error: 'Недопустимое имя ветки' };
    return gitRun(root, ['branch', '-m', from, to]);
  });
  ipcMain.handle('git:branchDelete', async (_e, { root, name, force } = {}) => {
    if (BAD_REF(name)) return { ok: false, error: 'Недопустимое имя ветки' };
    return gitRun(root, ['branch', force ? '-D' : '-d', name]);
  });
  ipcMain.handle('git:branchPush', async (_e, { root, name } = {}) => {
    if (BAD_REF(name)) return { ok: false, error: 'Недопустимое имя ветки' };
    const remotes = ((await git(root, ['remote'])) || '').trim().split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) return { ok: false, error: 'нет remote' };
    return gitRun(root, ['push', '-u', remote, name]);
  });

  ipcMain.handle('git:checkoutRemote', async (_e, { root, remoteBranch } = {}) => {
    const rb = String(remoteBranch || '');
    if (BAD_REF(rb)) return { ok: false, error: 'Недопустимое имя ветки' };
    const local = rb.replace(/^[^/]+\//, '');
    if (BAD_REF(local)) return { ok: false, error: 'Недопустимое имя ветки' };
    const exists = await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + local]);
    if (exists != null) return gitRun(root, ['checkout', local, '--']);
    return gitRun(root, ['checkout', '-b', local, '--track', rb]);
  });

  ipcMain.handle('git:rebaseOnto', async (_e, { root, onto } = {}) => BAD_REF(onto) ? { ok: false, error: 'плохая ветка' } : gitRun(root, ['rebase', onto]));
  ipcMain.handle('git:rebaseAbort', async (_e, root) => gitRun(root, ['rebase', '--abort']));

  function gitPullRef(root, remoteBranch, rebase) {
    const flag = rebase ? '--rebase' : '--no-rebase';
    if (!remoteBranch) return gitRun(root, ['pull', flag]);
    if (BAD_REF(remoteBranch)) return Promise.resolve({ ok: false, error: 'плохая ветка' });
    const i = String(remoteBranch).indexOf('/');
    const remote = i > 0 ? remoteBranch.slice(0, i) : 'origin';
    const branch = i > 0 ? remoteBranch.slice(i + 1) : remoteBranch;
    if (BAD_REF(remote) || BAD_REF(branch)) return Promise.resolve({ ok: false, error: 'плохая ветка' });
    return gitRun(root, ['pull', flag, '--', remote, branch]);
  }
  ipcMain.handle('git:pullMerge', async (_e, { root, remoteBranch } = {}) => gitPullRef(root, remoteBranch, false));
  ipcMain.handle('git:pullRebase', async (_e, { root, remoteBranch } = {}) => gitPullRef(root, remoteBranch, true));

  ipcMain.handle('git:branchCompare', async (_e, { root, branch } = {}) => {
    if (BAD_REF(branch)) return { ok: false, error: 'плохая ветка' };
    const ahead = await git(root, ['log', '--oneline', '--no-color', `HEAD..${branch}`]);
    const behind = await git(root, ['log', '--oneline', '--no-color', `${branch}..HEAD`]);
    if (ahead == null || behind == null) return { ok: false, error: `Не удалось сравнить с «${branch}» (ветка не найдена или ошибка git)` };
    const parse = (s) => (s || '').split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return { hash: l.slice(0, i), subject: l.slice(i + 1) }; });
    return { ok: true, branch, onlyInBranch: parse(ahead), onlyInCurrent: parse(behind) };
  });

  ipcMain.handle('git:branchDiffWorktree', async (_e, { root, branch } = {}) => {
    if (BAD_REF(branch)) return { error: 'плохая ветка' };
    const out = await git(root, ['diff', '--no-color', branch, '--']);
    if (out == null) return { error: `Не удалось получить дифф с «${branch}» (ветка не найдена, дифф слишком большой или ошибка git)` };
    return { diff: out };
  });

  return { git, gitWorkBase };
}

module.exports = { registerGitIpc, git, gitWorkBase };
