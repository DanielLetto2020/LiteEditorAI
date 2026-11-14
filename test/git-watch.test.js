// Тесты лёгкого Git-вотчера (lib/git-watch.js):
// - распознавание классического .git и git worktree (файл `gitdir: ...` + `commondir`);
// - отсечение промежуточных *.lock файлов;
// - живое срабатывание на смену HEAD, index, вложенных веток refs/heads/feat/* и git init;
// - малое и константное число открытых вотчеров даже при большом рабочем дереве.
// Запуск: node test/git-watch.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGitDirs, isGitMetaName, watchGitLite } = require('../lib/git-watch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error('не дождался: ' + what);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-gitwatch-'));
const activeWatchers = [];
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  try {
    // --- 1. Фильтрация имён метаданных Git ---
    ok(isGitMetaName('HEAD') === true, 'HEAD отслеживается');
    ok(isGitMetaName('index') === true, 'index отслеживается');
    ok(isGitMetaName('packed-refs') === true, 'packed-refs отслеживается');
    ok(isGitMetaName('index.lock') === false, 'index.lock игнорируется');
    ok(isGitMetaName('HEAD.lock') === false, 'HEAD.lock игнорируется');
    ok(isGitMetaName('COMMIT_EDITMSG') === false, 'побочные файлы в .git игнорируются');

    // --- 2. resolveGitDirs: обычный репозиторий и git worktree ---
    const repoA = path.join(tmpRoot, 'repo-a');
    fs.mkdirSync(path.join(repoA, '.git', 'refs', 'heads'), { recursive: true });
    for (let i = 0; i < 40; i++) {
      fs.mkdirSync(path.join(repoA, 'src', `mod-${i}`, 'nested'), { recursive: true });
    }
    const dirsA = resolveGitDirs(repoA);
    ok(dirsA && dirsA.gitDir === path.join(repoA, '.git'), 'обычный .git распознан');
    ok(dirsA && dirsA.commonDir === path.join(repoA, '.git'), 'commonDir совпадает с .git');

    const wtDir = path.join(repoA, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, 'commondir'), '../..\n');
    const repoWt = path.join(tmpRoot, 'repo-wt');
    fs.mkdirSync(repoWt, { recursive: true });
    fs.writeFileSync(path.join(repoWt, '.git'), `gitdir: ${wtDir}\n`);
    const dirsWt = resolveGitDirs(repoWt);
    ok(dirsWt && dirsWt.gitDir === wtDir, 'gitdir из файла .git (worktree) распознан');
    ok(dirsWt && dirsWt.commonDir === path.join(repoA, '.git'), 'commondir у worktree разрешён к общему .git');

    // --- 3. Живое слежение: малое число дескрипторов при десятках папок исходников ---
    let hits = 0;
    const w = watchGitLite(repoA, () => { hits++; }, { debounceMs: 40 });
    activeWatchers.push(w);
    ok(w.hasGit() === true, 'репозиторий подключён к git-вотчеру');
    ok(w.size() <= 6, `открыто всего ${w.size()} вотчеров вместо десятков каталогов src/*`);

    // lock-файл сам по себе не должен вызывать срабатывание
    fs.writeFileSync(path.join(repoA, '.git', 'index.lock'), 'busy');
    await sleep(100);
    ok(hits === 0, 'создание index.lock не триггерит холостой пересчёт');
    fs.unlinkSync(path.join(repoA, '.git', 'index.lock'));
    await sleep(80);
    ok(hits === 0, 'удаление index.lock не триггерит холостой пересчёт');

    // смена HEAD (git checkout)
    fs.writeFileSync(path.join(repoA, '.git', 'HEAD'), 'ref: refs/heads/feat/core\n');
    await waitFor(() => hits >= 1, 'срабатывание на запись HEAD');

    // создание вложенной ветки refs/heads/feat/core и коммит в неё
    const prevHits = hits;
    fs.mkdirSync(path.join(repoA, '.git', 'refs', 'heads', 'feat'), { recursive: true });
    await waitFor(() => hits > prevHits, 'срабатывание на новую папку веток refs/heads/feat');

    const prevHits2 = hits;
    fs.writeFileSync(path.join(repoA, '.git', 'refs', 'heads', 'feat', 'core'), '1234567890abcdef\n');
    await waitFor(() => hits > prevHits2, 'срабатывание на обновление коммита вложенной ветки');

    // --- 4. Папка без .git, затем git init на лету ---
    const plainDir = path.join(tmpRoot, 'plain');
    fs.mkdirSync(plainDir, { recursive: true });
    let plainHits = 0;
    const wp = watchGitLite(plainDir, () => { plainHits++; }, { debounceMs: 40 });
    activeWatchers.push(wp);
    ok(wp.hasGit() === false, 'папка без .git сначала не помечена как репо');
    fs.mkdirSync(path.join(plainDir, '.git', 'refs', 'heads'), { recursive: true });
    await waitFor(() => wp.hasGit() === true && plainHits >= 1, 'подхват .git после git init');

    const beforeHead = plainHits;
    fs.writeFileSync(path.join(plainDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await waitFor(() => plainHits > beforeHead, 'срабатывание на HEAD в только что инициализированном репо');

    wp.close();
    ok(wp.size() === 0, 'после close() все дескрипторы освобождены');

    console.log(`✓ git-watch: ${passed} проверок пройдено`);
  } finally {
    for (const x of activeWatchers) { try { x.close(); } catch (_) {} }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
