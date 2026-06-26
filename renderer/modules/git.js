// LiteEditor — Git как ВСТРОЕННЫЙ компонент окна вивера (PhpStorm-style), а не отдельное окно.
// Изолирован: всё из ядра — только через host-колбэки, UI-хелперы — прямым импортом из ui.js,
// бэкенд — через window.lite.git.*. Рендерит в контейнеры окна вивера: VCS-полоса (шапка с веткой +
// ahead/behind + fetch/pull/push), секция «Коммит» (изменения + сообщение + commit/stash), секция
// «Ветки/Лог» (под-вкладки История/Ветки). Дифф выбранного файла показывается в ЦЕНТРЕ вивера
// (host.gitDiff). Разрешение конфликтов merge — отдельная модалка (3 окна).
// host: { activeProject, getActiveId, renderProjects, refreshTree, createCodeEditor, languageFor,
//         gitDiff(projPath, file, label) — показать дифф файла в центре вивера }
import { el, icon, toast, showConfirm, showPrompt, baseName, makeModal } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initGit(host) {
  const { renderProjects, activeProject, getActiveId, refreshTree, createCodeEditor, languageFor } = host;

  let containers = null;     // { topbar, commit, branchlog } — задаются вивером через setContainers
  // Какие секции рендерить: коммит (левая колонка) и/или лог (нижняя панель) — могут быть открыты вместе.
  let renderOpts = { commit: true, log: false };
  let gitRenderSeq = 0;      // bumped on every render; a stale render (older seq) bails after its awaits
  let blsub = 'history';     // под-вкладка нижней панели: 'history' | 'branches'
  let selectedCommit = null; // выбранный коммит в логе → дерево его файлов справа
  let lastPath = null;       // путь проекта прошлого рендера — на смену сбрасываем выбор файлов
  let selectedChangeFile = null; // выделенный файл во вкладке «Изменения»
  const excluded = new Set();// abs-пути файлов, исключённых из коммита (по умолчанию включены все)
  const commitDraft = {};    // projPath -> черновик сообщения коммита (переживает re-render панели)

  const STATUS_LABEL = {
    conflict: 'Конфликты',
    modified: 'Изменённые',
    added: 'Новые',
    deleted: 'Удалённые',
    untracked: 'Неотслеживаемые',
  };

  function miniIcon(iconName, title, extra = '') {
    const b = el('button', 'gm-mini' + (extra ? ' ' + extra : ''));
    b.appendChild(icon(iconName, 13));
    if (title) b.title = title;
    return b;
  }

  function displayPath(abs, root) {
    const file = String(abs || '').replace(/\\/g, '/');
    const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (base && file.startsWith(base + '/')) return file.slice(base.length + 1);
    return file;
  }

  function splitPath(abs, root) {
    const rel = displayPath(abs, root);
    const parts = rel.split('/').filter(Boolean);
    const name = parts.pop() || rel;
    return { rel, name, dir: parts.join('/') };
  }

  function statusKind(code, conflicted) {
    if (conflicted) return 'conflict';
    const c = String(code || '?');
    if (c === '?' || c.includes('?')) return 'untracked';
    if (c.includes('D')) return 'deleted';
    if (c.includes('A')) return 'added';
    return 'modified';
  }

  function statusChipText(code, kind) {
    if (kind === 'conflict') return '!';
    if (kind === 'untracked') return '?';
    const c = String(code || 'M').trim();
    return c || 'M';
  }

  function groupChanges(keys, files, conflictSet) {
    const order = ['conflict', 'modified', 'added', 'deleted', 'untracked'];
    const groups = new Map(order.map((id) => [id, []]));
    for (const f of keys) groups.get(statusKind(files[f], conflictSet.has(f))).push(f);
    for (const arr of groups.values()) arr.sort((a, b) => a.localeCompare(b));
    return order.map((id) => ({ id, title: STATUS_LABEL[id], files: groups.get(id) })).filter((g) => g.files.length);
  }

  function shortCount(n, one, few, many) {
    const v = Math.abs(n) % 100;
    const d = v % 10;
    if (v > 10 && v < 20) return n + ' ' + many;
    if (d === 1) return n + ' ' + one;
    if (d >= 2 && d <= 4) return n + ' ' + few;
    return n + ' ' + many;
  }

  // Вивер задаёт контейнеры (VCS-полоса / секция коммита / нижняя панель веток-лога).
  function setContainers(c) { containers = c; }
  // Перейти в секцию «Коммит» (после merge/resolve/abort): показать левую секцию коммита; рендер делает вызвавший.
  function goCommitView() { renderOpts.commit = true; if (host.showCommitPane) host.showCommitPane(); }

  // Compact pill button for the Git toolbar (icon + optional label). Variants: 'primary' | 'ico' | 'danger'.
  function gitTool(iconName, label, title, variant) {
    const b = el('button', 'git-tool' + (variant ? ' ' + variant : ''));
    b.appendChild(icon(iconName, 14));
    if (label) b.appendChild(el('span', null, label));
    if (title) b.title = title;
    return b;
  }

  // Чип состояния ветки vs её upstream (по info.branchTrack[name]). null → синхронна/нет upstream.
  function trackChip(tr) {
    if (!tr) return null;
    if (tr.gone) { const c = el('span', 'gm-btrack gone', 'upstream удалён'); c.title = 'Удалённая ветка ' + (tr.upstream || 'upstream') + ' больше не существует'; return c; }
    if (!tr.ahead && !tr.behind) return null;
    const parts = [];
    if (tr.behind) parts.push('↓' + tr.behind);
    if (tr.ahead) parts.push('↑' + tr.ahead);
    const c = el('span', 'gm-btrack ' + (tr.behind ? 'behind' : 'ahead'), parts.join(' '));
    const t = [];
    if (tr.behind) t.push('отстаёт от ' + (tr.upstream || 'upstream') + ' на ' + tr.behind + ' ' + shortCount(tr.behind, 'коммит', 'коммита', 'коммитов'));
    if (tr.ahead) t.push('впереди на ' + tr.ahead + ' ' + shortCount(tr.ahead, 'коммит', 'коммита', 'коммитов'));
    c.title = t.join(', ') + (tr.behind ? ' — обновите кнопкой ⟳' : '');
    return c;
  }

  // ============================================================ выпадашка веток (PhpStorm-style)
  // Избранные ветки — персист по проекту (host.STORE.gitFav: projPath -> [имена]).
  const branchFav = (host.STORE && host.STORE.gitFav) || {};
  function favList(path) { if (!Array.isArray(branchFav[path])) branchFav[path] = []; return branchFav[path]; }
  function isFav(path, name) { return favList(path).includes(name); }
  function toggleFav(path, name) { const l = favList(path); const i = l.indexOf(name); if (i >= 0) l.splice(i, 1); else l.push(name); if (host.persist) host.persist('gitFav', branchFav); }

  // Дерево веток по '/' (feature/x, release/1.2 → папки).
  function buildBranchTree(names) {
    const root = { dirs: new Map(), leaves: [] };
    for (const full of names) {
      const parts = String(full).split('/');
      const leaf = parts.pop();
      let node = root;
      for (const seg of parts) { if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), leaves: [] }); node = node.dirs.get(seg); }
      node.leaves.push({ full, leaf });
    }
    return root;
  }
  function branchSectionHead(t) { return el('div', 'gm-branch-section', t); }
  function buildBranchPop(pop, p, data, closePop) {
    pop.replaceChildren();
    const search = el('input', 'gm-branch-search'); search.type = 'search'; search.placeholder = 'Фильтр веток…'; search.spellcheck = false;
    pop.appendChild(search);
    const body = el('div', 'gm-branch-body'); pop.appendChild(body);
    const ctx = { p, data, closePop };
    const render = (q) => {
      body.replaceChildren();
      const ql = (q || '').toLowerCase();
      const localNames = data.local.map((b) => b.name);
      const hit = (n) => !ql || n.toLowerCase().includes(ql);
      const favNames = localNames.filter((n) => isFav(p.path, n) && hit(n));
      if (favNames.length) { body.appendChild(branchSectionHead('Избранные')); for (const n of favNames) body.appendChild(branchRow(n, n, 'local', ctx, 0)); }
      const locals = localNames.filter(hit);
      body.appendChild(branchSectionHead('Локальные'));
      if (!locals.length) body.appendChild(el('div', 'gm-branch-none', '—')); else renderBranchTree(buildBranchTree(locals), body, 'local', ctx, 0);
      const remotes = (data.remote || []).filter(hit);
      if (remotes.length) { body.appendChild(branchSectionHead('Удалённые')); renderBranchTree(buildBranchTree(remotes), body, 'remote', ctx, 0); }
    };
    search.addEventListener('input', () => render(search.value.trim()));
    render('');
    setTimeout(() => search.focus(), 0);
  }
  function renderBranchTree(node, container, kind, ctx, depth) {
    for (const [dname, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = el('div', 'gm-branch-folder'); row.style.paddingLeft = (depth * 12 + 8) + 'px';
      const chev = el('span', 'gm-branch-chev'); chev.appendChild(icon('chevron-down', 12));   // SVG-шеврон вместо ▾/▸
      row.append(chev, icon('folder', 13), el('span', 'gm-branch-fname', dname));
      container.appendChild(row);
      const box = el('div'); container.appendChild(box);
      renderBranchTree(child, box, kind, ctx, depth + 1);
      row.onclick = (e) => { e.stopPropagation(); const hidden = box.style.display === 'none'; box.style.display = hidden ? '' : 'none'; chev.replaceChildren(icon(hidden ? 'chevron-down' : 'chevron-right', 12)); };
    }
    for (const { full, leaf } of node.leaves.sort((a, b) => a.leaf.localeCompare(b.leaf))) container.appendChild(branchRow(full, leaf, kind, ctx, depth));
  }
  function branchRow(full, leaf, kind, ctx, depth) {
    const { p, data } = ctx;
    const cur = kind === 'local' && full === data.current;
    const row = el('div', 'gm-branchitem' + (cur ? ' cur' : ''));
    row.style.paddingLeft = (depth * 12 + 8) + 'px';
    row.appendChild(icon(cur ? 'check' : 'git', 13));
    row.appendChild(el('span', 'gm-branchitem-name', leaf));
    if (kind === 'local') {
      const bd = data.local.find((b) => b.name === full);
      const tc = bd ? trackChip({ upstream: bd.upstream, ahead: bd.ahead, behind: bd.behind, gone: bd.gone }) : null;
      if (tc) row.appendChild(tc);
      const star = el('button', 'gm-branch-star' + (isFav(p.path, full) ? ' on' : '')); star.title = 'В избранное';
      star.appendChild(icon('star', 12));
      star.onclick = (e) => { e.stopPropagation(); toggleFav(p.path, full); star.classList.toggle('on'); };
      row.appendChild(star);
    }
    row.onclick = (e) => { e.stopPropagation(); openBranchMenu(full, kind, ctx, row); };
    return row;
  }

  // Контекстное меню действий по ветке (справа от строки, как в PhpStorm).
  let branchMenuEl = null;
  let activeBranchPop = null;   // закрывалка открытой выпадашки веток — чтобы снять её document-listener при пересборке шапки
  function branchMenuDoc(e) { if (branchMenuEl && !branchMenuEl.contains(e.target)) closeBranchMenu(); }
  function closeBranchMenu() { if (branchMenuEl) { branchMenuEl.remove(); branchMenuEl = null; document.removeEventListener('mousedown', branchMenuDoc, true); } }
  function openBranchMenu(full, kind, ctx, rowEl) {
    closeBranchMenu();
    const { p, data, closePop } = ctx;
    const cur = kind === 'local' && full === data.current;
    const m = el('div', 'gm-branchmenu');
    const refresh = () => { renderGitPanel(p); renderProjects(); };
    const run = async (promise, okMsg) => { const r = await promise; if (r && r.ok === false) toast(r.error || 'не удалось', { kind: 'err', ttl: 8000 }); else if (okMsg) toast(okMsg); refresh(); };
    const add = (label, fn, opts = {}) => { if (opts.skip) return; const it = el('div', 'gm-branchmenu-item' + (opts.danger ? ' danger' : ''), label); it.onclick = () => { closeBranchMenu(); closePop(); fn(); }; m.appendChild(it); };
    const sep = () => m.appendChild(el('div', 'gm-branchmenu-sep'));

    if (!cur) {
      if (kind === 'remote') add('Checkout (создать локальную)', () => run(lite.git.checkoutRemote(p.path, full), 'Переключено: ' + full));
      else add('Checkout', () => run(lite.git.checkout(p.path, full), 'Ветка: ' + full));
    }
    add('Новая ветка от «' + full + '»…', () => newBranchFrom(p, full));
    sep();
    add('Показать дифф с рабочим деревом', () => showBranchDiff(p, full));
    add('Сравнить с текущей', () => compareBranch(p, full), { skip: cur });
    if (!cur) {
      sep();
      add('Влить в текущую (merge)', () => mergeBranch(p, full));
      add('Перебазировать текущую на «' + full + '»', () => run(lite.git.rebaseOnto(p.path, full), 'Rebase выполнен'));
      if (kind === 'remote') {
        add('Подтянуть «' + full + '» в текущую (merge)', () => run(lite.git.pullMerge(p.path, full), 'Pull (merge) готов'));
        add('Подтянуть «' + full + '» в текущую (rebase)', () => run(lite.git.pullRebase(p.path, full), 'Pull (rebase) готов'));
      }
    }
    if (kind === 'local') {
      sep();
      add('Обновить из удалёнки', () => run(lite.git.branchUpdate(p.path, full, cur), 'Обновлено: ' + full));
      add('Запушить', () => run(lite.git.branchPush(p.path, full), 'Запушено: ' + full));
      add('Переименовать…', () => renameBranch(p, full));
      add('Удалить', () => deleteBranch(p, full), { danger: true, skip: cur });
    }

    document.body.appendChild(m);
    const r = rowEl.getBoundingClientRect();
    const mw = 250;
    let left = r.right + 2; if (left + mw > window.innerWidth - 6) left = Math.max(6, r.left - mw - 2);
    m.style.left = left + 'px';
    m.style.top = Math.min(r.top, Math.max(6, window.innerHeight - m.offsetHeight - 8)) + 'px';
    branchMenuEl = m;
    setTimeout(() => document.addEventListener('mousedown', branchMenuDoc, true), 0);
  }
  function newBranchFrom(p, base) {
    showPrompt('Новая ветка от «' + base + '»', 'Имя ветки (создастся и перейдём на неё)', '', async (name) => {
      const r = await lite.git.branchCreate(p.path, name, base, true);
      if (r.ok) { toast('Создана и перешёл: ' + name); renderProjects(); renderGitPanel(p); } return r;
    });
  }
  function renameBranch(p, name) {
    showPrompt('Переименовать ветку', 'Новое имя для «' + name + '»', name, async (to) => {
      const r = await lite.git.branchRename(p.path, name, to);
      if (r.ok) { toast('Переименована: ' + to); renderProjects(); renderGitPanel(p); } return r;
    });
  }
  function deleteBranch(p, name) {
    showConfirm('Удалить ветку?', 'Ветка «' + name + '» будет удалена локально.', 'Удалить', async () => {
      const r = await lite.git.branchDelete(p.path, name, false);
      if (r.ok) { toast('Удалена: ' + name); renderGitPanel(p); renderProjects(); return; }
      if (/not fully merged|не слита|fully merged/i.test(r.error || '')) {
        showConfirm('Ветка не слита', '«' + name + '» содержит несли́тые коммиты. Удалить принудительно (-D)?', 'Удалить принудительно', async () => {
          const rr = await lite.git.branchDelete(p.path, name, true);
          if (rr.ok) { toast('Удалена: ' + name); renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err', ttl: 8000 });
        });
      } else toast(r.error || 'не удалось', { kind: 'err', ttl: 8000 });
    });
  }
  async function mergeBranch(p, branch) {
    const r = await lite.git.merge(p.path, branch);
    if (r.ok) { toast('Слито: ' + branch); renderProjects(); goCommitView(); renderGitPanel(p); return; }
    const c = await lite.git.conflicts(p.path);
    if (c.files && c.files.length) { toast('Конфликты — разрешите в секции «Коммит»', { kind: 'err', ttl: 9000 }); goCommitView(); renderGitPanel(p); }
    else toast(r.error || 'merge не прошёл', { kind: 'err', ttl: 9000 });
  }
  async function showBranchDiff(p, branch) {
    const r = await lite.git.branchDiffWorktree(p.path, branch);
    if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
    if (host.showRawDiff) host.showRawDiff('Рабочее дерево ↔ ' + branch, (r && r.diff) || '');
    if (!(r && r.diff && r.diff.trim())) toast('Различий нет');
  }
  async function compareBranch(p, branch) {
    const r = await lite.git.branchCompare(p.path, branch);
    if (!r || r.ok === false) { toast((r && r.error) || 'не удалось сравнить', { kind: 'err' }); return; }
    openCompareModal(branch, r);
  }
  function openCompareModal(branch, data) {
    const { m, close } = makeModal(`
      <div class="cmp-head"><span class="cmp-title"></span></div>
      <div class="cmp-grid">
        <div class="cmp-col"><div class="cmp-collabel" id="cmp-la"></div><div class="cmp-list" id="cmp-a"></div></div>
        <div class="cmp-col"><div class="cmp-collabel" id="cmp-lb"></div><div class="cmp-list" id="cmp-b"></div></div>
      </div>
      <div class="modal-actions"><button class="btn" id="cmp-close">Закрыть</button></div>`);
    m.classList.add('modal-compare');
    m.querySelector('.cmp-title').textContent = 'Сравнение «' + branch + '» с текущей';
    m.querySelector('#cmp-la').textContent = 'Есть в «' + branch + '», нет в текущей (' + data.onlyInBranch.length + ')';
    m.querySelector('#cmp-lb').textContent = 'Есть в текущей, нет в «' + branch + '» (' + data.onlyInCurrent.length + ')';
    m.querySelector('#cmp-close').onclick = close;
    const fill = (sel, commits) => {
      const box = m.querySelector(sel);
      if (!commits.length) { box.appendChild(el('div', 'gm-clean', 'Нет коммитов')); return; }
      for (const c of commits) { const row = el('div', 'cmp-commit'); row.appendChild(el('span', 'gm-hash', c.hash)); row.appendChild(el('span', 'cmp-subj', c.subject)); box.appendChild(row); }
    };
    fill('#cmp-a', data.onlyInBranch);
    fill('#cmp-b', data.onlyInCurrent);
  }

  // ============================================================ сборка (VCS-полоса + открытые секции)
  // Привязана к активному проекту; вивер зовёт renderPanel при смене проекта/секции, передавая opts
  // { commit, log } — какие секции открыты. Внутренние refresh'и (renderGitPanel(p) без opts) повторяют
  // последний набор. Коммит (левая колонка) и лог (нижняя панель) могут рендериться одновременно.
  async function renderGitPanel(p, opts) {
    if (!containers) return;
    if (opts) renderOpts = { commit: !!opts.commit, log: !!opts.log };
    const wantCommit = renderOpts.commit, wantLog = renderOpts.log;
    const { topbar, commit, branchlog } = containers;
    if (!p) { topbar.classList.add('hidden'); topbar.replaceChildren(); commit.innerHTML = ''; branchlog.innerHTML = ''; return; }
    if (p.path !== lastPath) { excluded.clear(); selectedChangeFile = null; selectedCommit = null; lastPath = p.path; } // новый проект — выбор с нуля
    const reqPath = p.path;
    const seq = ++gitRenderSeq;
    const stale = () => seq !== gitRenderSeq || activeProject()?.path !== reqPath;
    if (wantCommit) commit.innerHTML = '<div class="git-loading">Загрузка…</div>';
    if (wantLog) branchlog.innerHTML = '<div class="git-loading">Загрузка…</div>';
    const info = await lite.git.info(p.path);
    if (stale()) return;

    if (!info.repo) {
      topbar.classList.add('hidden'); topbar.replaceChildren();
      if (wantLog) branchlog.innerHTML = '';
      if (wantCommit) { commit.innerHTML = ''; renderNoRepo(commit, p); }
      return;
    }

    topbar.classList.remove('hidden');
    topbar.replaceChildren(renderHeader(p, info));

    if (wantCommit) {
      const conf = await lite.git.conflicts(p.path);
      if (stale()) return;
      const conflictSet = new Set((conf.files || []).map((f) => f.abs));
      commit.innerHTML = '';
      await renderChangesTab(commit, p, conflictSet, stale);
    }
    if (wantLog) {
      branchlog.innerHTML = '';
      await renderBranchLog(branchlog, p, info, stale);
    }
  }

  // Нижняя панель «Ветки · История»: под-вкладки [История][Ветки] + двух-зонный layout
  // (слева список коммитов/веток, справа дерево изменённых файлов выбранного коммита).
  async function renderBranchLog(host2, p, info, stale) {
    const tabsBar = el('div', 'git-tabs');
    for (const [id, label] of [['history', 'История'], ['branches', 'Ветки']]) {
      const t = el('button', 'git-tab' + (blsub === id ? ' active' : ''), label);
      t.onclick = () => { if (blsub === id) return; blsub = id; renderGitPanel(p); };
      tabsBar.appendChild(t);
    }
    host2.appendChild(tabsBar);
    // двух-зонный grid: список (слева) | дерево изменённых файлов (справа)
    const split = el('div', 'git-log-split');
    const listSide = el('div', 'git-log-list');
    const filesSide = el('div', 'git-log-files');
    filesSide.appendChild(el('div', 'git-log-files-empty', 'Выберите коммит, чтобы увидеть изменённые файлы'));
    split.append(listSide, filesSide);
    host2.appendChild(split);
    if (blsub === 'history') await renderHistoryTab(listSide, filesSide, p, stale);
    else renderBranchesTab(listSide, p, info);
  }

  function renderNoRepo(body, p) {
    body.appendChild(el('div', 'gm-norepo', 'Это не git-репозиторий.'));
    const row = el('div', 'gm-actions');
    const init = el('button', 'btn primary', '⎇ git init');
    init.onclick = async () => {
      const r = await lite.git.init(p.path);
      if (r.ok) { toast('git init готов'); renderGitPanel(p); renderProjects(); }
      else toast(r.error || 'ошибка init', { kind: 'err', ttl: 7000 });
    };
    row.append(init); body.appendChild(row);
    body.appendChild(el('div', 'gm-or', 'или клонировать репозиторий в эту папку'));
    const cloneRow = el('div', 'gm-actions');
    const url = el('input', 'gm-cloneurl'); url.type = 'text';
    url.placeholder = 'URL репозитория (https://… или git@…)';
    const clone = el('button', 'btn', '⬇ git clone');
    const doClone = async () => {
      const u = url.value.trim();
      if (!u) { toast('Введи URL репозитория', { kind: 'err' }); return; }
      clone.disabled = true; const lbl = clone.textContent; clone.textContent = 'Клонирую…';
      const r = await lite.git.clone(p.path, u);
      clone.disabled = false; clone.textContent = lbl;
      if (r.ok) { toast('Репозиторий склонирован'); renderGitPanel(p); renderProjects(); if (p.id === getActiveId()) refreshTree(); }
      else toast(r.error || 'ошибка clone', { kind: 'err', ttl: 9000 });
    };
    clone.onclick = doClone;
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doClone(); });
    cloneRow.append(url, clone); body.appendChild(cloneRow);
  }

  // --- VCS-полоса сверху: дропдаун веток + ahead/behind + fetch/pull/push (PhpStorm VCS widget)
  function renderHeader(p, info) {
    if (activeBranchPop) activeBranchPop();   // пересобираем шапку → закрыть прежнюю выпадашку и снять её listener (не копить stale)
    const bar = el('div', 'vcs-bar');

    // Кастомная выпадашка веток (PhpStorm-style): дерево Local/Remote + избранные + меню действий справа.
    const dd = el('div', 'gm-branchdd');
    const ddBtn = el('button', 'gm-branchsel');
    ddBtn.type = 'button';
    ddBtn.title = 'Текущая ветка — нажмите для переключения и действий';
    ddBtn.append(icon('git', 14), el('span', 'gm-branchsel-txt', info.branch), icon('chevron-down', 14));
    const pop = el('div', 'gm-branchpop hidden');
    dd.append(ddBtn, pop);
    let popOpen = false;
    const onDoc = (e) => { if (!dd.contains(e.target) && !e.target.closest('.gm-branchmenu')) closePop(); };
    function closePop() { popOpen = false; pop.classList.add('hidden'); dd.classList.remove('open'); closeBranchMenu(); document.removeEventListener('mousedown', onDoc, true); if (activeBranchPop === closePop) activeBranchPop = null; }
    async function openPop() {
      popOpen = true; pop.classList.remove('hidden'); dd.classList.add('open');
      pop.replaceChildren(el('div', 'git-loading', 'Загрузка веток…'));
      document.addEventListener('mousedown', onDoc, true);
      activeBranchPop = closePop;

      const data = await lite.git.branches(p.path);
      if (!popOpen) return;
      if (!data || !data.repo) { pop.replaceChildren(el('div', 'gm-clean', 'Веток нет')); return; }
      buildBranchPop(pop, p, data, closePop);
    }
    ddBtn.onclick = () => (popOpen ? closePop() : openPop());
    bar.appendChild(dd);

    // ahead/behind vs upstream
    if (info.upstream) {
      const sync = el('span', 'git-chip' + ((info.ahead || info.behind) ? ' warn' : ' ok'), (info.ahead || info.behind) ? ('↑' + info.ahead + ' ↓' + info.behind) : 'up to date');
      sync.title = 'Относительно upstream ' + info.upstream;
      bar.appendChild(sync);
    } else bar.appendChild(el('span', 'git-chip muted', info.hasRemote ? 'нет upstream' : 'без remote'));

    bar.appendChild(el('div', 'drag-space-static'));

    // fetch / pull / push прямо в полосе
    const runAction = async (btn, fn) => { btn.disabled = true; btn.classList.add('loading'); try { await fn(); } finally { btn.classList.remove('loading'); } };
    const fetchBtn = gitTool('refresh', null, 'git fetch --all --prune');
    const pull = gitTool('download', null, 'git pull --ff-only');
    const push = gitTool('upload', null, 'git push');
    fetchBtn.onclick = () => runAction(fetchBtn, async () => { const r = await lite.git.fetch(p.path); toast(r.ok ? 'Fetch готов' : (r.error || 'fetch не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); });
    pull.onclick = () => runAction(pull, async () => { const r = await lite.git.pull(p.path); toast(r.ok ? 'Pull готов' : (r.error || 'pull не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); });
    push.onclick = () => runAction(push, async () => { const r = await lite.git.push(p.path); toast(r.ok ? 'Запушено' : (r.error || 'push не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); });
    bar.append(fetchBtn, pull, push);
    return bar;
  }

  // ============================================================ вкладка «Изменения»
  async function renderChangesTab(content, p, conflictSet, stale) {
    const st = await lite.git.status(p.path);
    if (stale()) return;
    const files = (st && st.files) ? st.files : {};
    const keys = Object.keys(files).sort((a, b) => a.localeCompare(b));
    const groups = groupChanges(keys, files, conflictSet);
    const committableKeys = keys.filter((k) => !conflictSet.has(k));
    for (const k of [...excluded]) if (!keys.includes(k)) excluded.delete(k); // прунинг исчезнувших путей — иначе ре-созданный файл молча останется исключённым из коммита
    if (selectedChangeFile && !keys.includes(selectedChangeFile)) selectedChangeFile = null;
    if (!selectedChangeFile && keys.length) selectedChangeFile = keys[0];

    let commit = null, commitPush = null, commitCount = null;

    // ---- тулбар НАД списком (PhpStorm-style, иконки): stash · список stash · вкл/снять все · откат · обновить
    const toolbar = el('div', 'git-commit-toolbar');
    const stashBtn = miniIcon('layers', 'Спрятать все изменения (git stash -u)');
    const stashListBtn = miniIcon('archive', 'Список stash — применить / вернуть / удалить');
    const includeAll = miniIcon('check', 'Включить все файлы в коммит');
    const excludeAll = miniIcon('x', 'Снять все галочки');
    const discAll = miniIcon('eraser', 'Откатить все отслеживаемые правки', 'gm-disc');
    const refreshBtn = miniIcon('refresh', 'Обновить список изменений');
    stashBtn.disabled = !keys.length; discAll.disabled = !keys.length;
    includeAll.disabled = !committableKeys.length; excludeAll.disabled = !committableKeys.length;
    toolbar.append(stashBtn, stashListBtn, el('span', 'gm-tsep'), includeAll, excludeAll, el('span', 'gm-tsep'), discAll, refreshBtn);
    content.appendChild(toolbar);

    const runAction = async (btn, fn) => { btn.disabled = true; btn.classList.add('loading'); try { await fn(); } finally { btn.classList.remove('loading'); } };
    stashBtn.onclick = () => runAction(stashBtn, async () => { const r = await lite.git.stash(p.path); toast(r.ok ? 'Изменения спрятаны в stash' : (r.error || 'stash не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); });
    stashListBtn.onclick = () => openStashList(p);
    refreshBtn.onclick = () => renderGitPanel(p);
    includeAll.onclick = () => { for (const f of committableKeys) excluded.delete(f); renderGitPanel(p); };
    excludeAll.onclick = () => { for (const f of committableKeys) excluded.add(f); renderGitPanel(p); };
    discAll.onclick = () => showConfirm('Откатить все правки?', 'Изменения во всех отслеживаемых файлах будут отменены. Новые (неотслеживаемые) файлы останутся на месте.', 'Откатить всё', async () => {
      const rr = await lite.git.discardAll(p.path);
      if (rr.ok) { selectedChangeFile = null; toast('Правки откачены'); renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
    });

    // ---- список изменений; клик по файлу → дифф в ЦЕНТРЕ вивера (как PhpStorm)
    const changes = el('div', 'gm-changes git-change-list');
    content.appendChild(changes);

    const selectedFiles = () => keys.filter((k) => !conflictSet.has(k) && !excluded.has(k));
    const updateCommitState = () => {
      const n = selectedFiles().length;
      const blockedByConflicts = conflictSet.size > 0;
      if (commit && commitPush) {
        commit.disabled = !n || blockedByConflicts;
        commitPush.disabled = !n || blockedByConflicts;
        const title = blockedByConflicts ? 'Сначала разрешите конфликты' : (!n ? 'Не выбрано ни одного файла' : 'Закоммитить выбранные изменения');
        commit.title = title;
        commitPush.title = blockedByConflicts ? title : 'Закоммитить выбранное и сразу запушить';
      }
      if (commitCount) commitCount.textContent = n + ' из ' + committableKeys.length + ' файлов' + (conflictSet.size ? ' · ' + conflictSet.size + ' конфл.' : '');
    };
    const paintSelection = () => {
      changes.querySelectorAll('.gm-file').forEach((row) => row.classList.toggle('open', row._file === selectedChangeFile));
    };
    const showDiff = async (f) => {
      selectedChangeFile = f;
      paintSelection();
      if (host.gitDiff) host.gitDiff(p.path, f, splitPath(f, p.path));
    };

    if (!keys.length) {
      const clean = el('div', 'git-clean-state');
      clean.appendChild(icon('check', 20));
      clean.appendChild(el('div', 'git-clean-title', 'Рабочее дерево чистое'));
      clean.appendChild(el('div', 'git-clean-note', 'Можно проверить remote или перейти к истории коммитов.'));
      changes.appendChild(clean);
    } else {
      if (conflictSet.size) {
        const warn = el('div', 'git-conflict-note');
        warn.appendChild(icon('warning', 15));
        warn.appendChild(el('span', null, 'Есть неразрешённые конфликты. Коммит станет доступен после Resolve.'));
        changes.appendChild(warn);
      }
      const appendGroup = (group) => {
        const box = el('div', 'gm-group');
        const head = el('div', 'gm-group-head');
        // tri-state чекбокс на группе (как PhpStorm): включить/исключить всю группу разом (кроме конфликтов).
        let groupCb = null;
        const rowCbs = [];
        function syncGroupCb() { if (!groupCb) return; const on = rowCbs.filter((x) => x.cb.checked).length; groupCb.checked = rowCbs.length > 0 && on === rowCbs.length; groupCb.indeterminate = on > 0 && on < rowCbs.length; }
        if (group.id !== 'conflict') {
          groupCb = el('input', 'gm-check gm-group-check'); groupCb.type = 'checkbox';
          groupCb.onclick = (e) => { e.stopPropagation(); const want = groupCb.checked; for (const x of rowCbs) { x.cb.checked = want; if (want) excluded.delete(x.f); else excluded.add(x.f); } groupCb.indeterminate = false; updateCommitState(); };
          head.appendChild(groupCb);
        } else head.appendChild(el('span', 'gm-check-spacer'));
        head.appendChild(el('span', 'gm-group-title', group.title));
        head.appendChild(el('span', 'gm-group-count', String(group.files.length)));
        box.appendChild(head);
        for (const f of group.files) {
          const conflicted = conflictSet.has(f);
          const kind = statusKind(files[f], conflicted);
          const label = splitPath(f, p.path);
          const r = el('div', 'gm-file' + (conflicted ? ' conflict' : ''));
          r._file = f; r.title = label.rel;
          if (!conflicted) {
            const cb = el('input', 'gm-check'); cb.type = 'checkbox'; cb.checked = !excluded.has(f); cb.title = 'Включить в коммит';
            cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) excluded.delete(f); else excluded.add(f); updateCommitState(); syncGroupCb(); };
            r.appendChild(cb); rowCbs.push({ f, cb });
          } else r.appendChild(el('span', 'gm-check-spacer'));
          r.appendChild(el('span', 'gm-code g-' + kind, statusChipText(files[f], kind)));
          const nameBox = el('span', 'gm-file-main');
          nameBox.appendChild(el('span', 'gm-fname g-' + kind, label.name));
          if (label.dir) nameBox.appendChild(el('span', 'gm-fdir', label.dir));
          r.appendChild(nameBox);
          const acts = el('span', 'gm-file-actions');
          if (conflicted) {
            const res = miniIcon('warning', 'Разрешить конфликт', 'gm-resolve');
            res.onclick = (e) => { e.stopPropagation(); openMergeModal(p, f); };
            acts.appendChild(res);
          } else {
            const disc = miniIcon('eraser', 'Откатить изменения файла', 'gm-disc');
            disc.onclick = (e) => { e.stopPropagation(); showConfirm('Откатить файл?', 'Изменения в «' + label.name + '» будут отменены (git checkout --).', 'Откатить', async () => {
              const rr = await lite.git.discardFile(p.path, f);
              if (rr.ok) { renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
            }); };
            acts.appendChild(disc);
          }
          r.appendChild(acts);
          r.addEventListener('click', () => showDiff(f));
          box.appendChild(r);
        }
        syncGroupCb();
        changes.appendChild(box);
      };
      for (const group of groups) appendGroup(group);
      paintSelection();   // подсветить дефолтно-выбранный файл (keys[0]) сразу, не дожидаясь клика
    }

    // ---- панель коммита СНИЗУ: счётчик + сообщение + Commit / Commit & Push (PhpStorm: сообщение под списком)
    const msg = el('textarea', 'gm-msg'); msg.placeholder = 'Сообщение коммита…';
    msg.value = commitDraft[p.path] || '';           // восстановить черновик (re-render не теряет ввод)
    msg.addEventListener('input', () => { commitDraft[p.path] = msg.value; });
    const commitPanel = el('div', 'git-commit-panel');
    const commitTop = el('div', 'git-commit-top');
    commitTop.append(el('div', 'git-sec', 'Сообщение коммита'), (commitCount = el('div', 'git-commit-count')));
    commitPanel.append(commitTop, msg);
    const commitRow = el('div', 'git-tools git-tools-commit');
    commit = gitTool('check', 'Commit', 'Закоммитить выбранные изменения', 'primary');
    commitPush = gitTool('upload', 'Commit & Push', 'Закоммитить выбранное и сразу запушить');
    const doCommit = async (withPush) => {
      const message = msg.value.trim();
      if (!message) { toast('Введи сообщение коммита', { kind: 'err' }); return; }
      const sel = selectedFiles();
      if (conflictSet.size) { toast('Сначала разрешите конфликты', { kind: 'err' }); return; }
      if (!sel.length) { toast('Не выбрано ни одного файла', { kind: 'err' }); return; }
      const allIncluded = sel.length === committableKeys.length;
      const btn = withPush ? commitPush : commit;
      btn.disabled = true; btn.classList.add('loading');
      const r = await lite.git.commit(p.path, message, withPush, allIncluded ? null : sel);
      btn.classList.remove('loading');
      if (r.ok) { toast(withPush ? 'Закоммичено и запушено' : 'Закоммичено'); msg.value = ''; commitDraft[p.path] = ''; selectedChangeFile = null; renderGitPanel(p); renderProjects(); }
      // Коммит лёг, но push не прошёл: список ОБЯЗАН обновиться (файлы уже в коммите), плюс показываем ошибку.
      else if (r.committed) { toast(r.error || 'push не прошёл', { kind: 'err', ttl: 9000 }); msg.value = ''; commitDraft[p.path] = ''; selectedChangeFile = null; renderGitPanel(p); renderProjects(); }
      else { btn.disabled = false; toast(r.error || 'ошибка коммита', { kind: 'err', ttl: 8000 }); updateCommitState(); }
    };
    commit.onclick = () => doCommit(false);
    commitPush.onclick = () => doCommit(true);
    commitRow.append(commit, commitPush);
    commitPanel.appendChild(commitRow);
    content.appendChild(commitPanel);

    updateCommitState();
    // НЕ авто-показываем дифф: это очищает центр вивера (и спросило бы про несохранённый файл) ещё до
    // клика пользователя. Дифф открывается по явному клику на файл в списке (showDiff → host.gitDiff).
  }

  // ============================================================ модалка списка stash (PhpStorm-style)
  // Слева — список спрятанных наборов; клик по набору показывает справа его файлы. Действия: apply/pop/drop.
  async function openStashList(p) {
    const res = await lite.git.stashList(p.path);
    const items = (res && res.items) || [];
    const { m, close } = makeModal(`
      <div class="stash-head"><span class="stash-title">Stash — спрятанные изменения</span></div>
      <div class="stash-grid">
        <div class="stash-list"></div>
        <div class="stash-files"><div class="stash-files-empty">Выберите stash слева, чтобы увидеть его файлы</div></div>
      </div>
      <div class="modal-actions"><button class="btn" id="stash-close">Закрыть</button></div>`);
    m.classList.add('modal-stash');
    m.querySelector('#stash-close').onclick = close;
    const listEl = m.querySelector('.stash-list');
    const filesEl = m.querySelector('.stash-files');
    if (!items.length) { listEl.appendChild(el('div', 'gm-clean', 'Стеша нет.')); return; }

    const showFiles = async (it) => {
      listEl.querySelectorAll('.stash-item').forEach((r) => r.classList.toggle('active', +r.dataset.index === it.index));
      filesEl.replaceChildren(el('div', 'git-loading', 'Загрузка…'));
      const fr = await lite.git.stashShow(p.path, it.index);
      const fileArr = (fr && fr.files) || [];
      filesEl.replaceChildren();
      if (!fileArr.length) { filesEl.appendChild(el('div', 'stash-files-empty', 'Файлов нет.')); return; }
      for (const f of fileArr) {
        const c = String(f.code || 'M');
        const kind = (c === '?' || c.includes('A')) ? 'added' : c.includes('D') ? 'deleted' : c.includes('U') ? 'conflict' : 'modified';
        const row = el('div', 'stash-file');
        row.appendChild(el('span', 'gm-code g-' + kind, c.slice(0, 2) || 'M'));
        row.appendChild(el('span', 'stash-file-name g-' + kind, f.rel));
        filesEl.appendChild(row);
      }
    };
    const stashOp = async (op, it) => {
      const fn = op === 'apply' ? lite.git.stashApply : op === 'pop' ? lite.git.stashPopIndex : lite.git.stashDrop;
      const r = await fn(p.path, it.index);
      if (!r.ok) { toast(r.error || (op + ' не прошёл'), { kind: 'err', ttl: 8000 }); return; }
      toast(op === 'apply' ? 'Stash применён' : op === 'pop' ? 'Stash возвращён' : 'Stash удалён');
      renderGitPanel(p); renderProjects();
      if (op === 'apply') return;                        // список не изменился — оставляем модалку
      const rr = await lite.git.stashList(p.path);       // pop/drop → перечитать; пусто → закрыть
      const left = (rr && rr.items) || [];
      if (!left.length) { close(); return; }
      rebuild(left); filesEl.replaceChildren(el('div', 'stash-files-empty', 'Выберите stash слева'));
    };
    const rebuild = (its) => {
      listEl.replaceChildren();
      for (const it of its) {
        const row = el('div', 'stash-item'); row.dataset.index = it.index;
        const main = el('div', 'stash-item-main');
        main.appendChild(el('span', 'stash-item-msg', it.subject || ('stash@{' + it.index + '}')));
        if (it.when) main.appendChild(el('span', 'stash-item-when', it.when));
        row.appendChild(main);
        const acts = el('div', 'stash-item-acts');
        const apply = miniIcon('download', 'Применить (оставить в списке)');
        const pop = miniIcon('archive', 'Вернуть и убрать из списка (pop)');
        const drop = miniIcon('trash', 'Удалить stash', 'gm-disc');
        apply.onclick = (e) => { e.stopPropagation(); stashOp('apply', it); };
        pop.onclick = (e) => { e.stopPropagation(); stashOp('pop', it); };
        drop.onclick = (e) => { e.stopPropagation(); showConfirm('Удалить stash?', '«' + (it.subject || ('stash@{' + it.index + '}')) + '» будет удалён безвозвратно.', 'Удалить', () => stashOp('drop', it)); };
        acts.append(apply, pop, drop);
        row.append(acts);
        row.addEventListener('click', () => showFiles(it));
        listEl.appendChild(row);
      }
    };
    rebuild(items);
    showFiles(items[0]);
  }

  // ============================================================ вкладка «История» (список коммитов + дерево файлов)
  async function renderHistoryTab(listSide, filesSide, p, stale) {
    const tools = el('div', 'git-history-tools');
    const searchWrap = el('div', 'git-search-wrap');
    searchWrap.appendChild(icon('search', 14));
    const search = el('input', 'git-search');
    search.type = 'search'; search.placeholder = 'Фильтр по истории';
    searchWrap.appendChild(search);
    tools.appendChild(searchWrap);
    listSide.appendChild(tools);

    const logBox = el('div', 'git-log');
    logBox.appendChild(el('div', 'git-loading', 'Загрузка истории…'));
    listSide.appendChild(logBox);
    const lg = await lite.git.log(p.path, 120);
    if (stale()) return;
    logBox.replaceChildren();
    const commits = (lg && lg.commits) ? lg.commits : [];
    if (!commits.length) { logBox.appendChild(el('div', 'gm-clean', 'Пока нет коммитов.')); return; }
    if (selectedCommit && !commits.some((c) => c.hash === selectedCommit)) selectedCommit = null;
    const rows = [];
    const selectCommit = (c, cr) => {
      selectedCommit = c.hash;
      logBox.querySelectorAll('.git-commit').forEach((x) => x.classList.toggle('sel', x === cr));
      renderCommitFilesTree(filesSide, p, c);
    };
    for (const c of commits) {
      const cr = el('div', 'git-commit' + (c.hash === selectedCommit ? ' sel' : ''));
      cr.title = c.subject + '\n' + c.hash;
      const main = el('div', 'git-commit-main');
      main.appendChild(el('span', 'gm-hash', c.hash));
      main.appendChild(el('span', 'git-csubj', c.subject));
      cr.appendChild(main);
      const meta = el('div', 'git-commit-meta');
      meta.appendChild(el('span', null, c.when));
      meta.appendChild(el('span', null, c.author));
      cr.appendChild(meta);
      if (c.refs) {
        const refs = el('div', 'git-ref-list');
        for (const ref of c.refs.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4)) refs.appendChild(el('span', 'git-refs', ref));
        cr.appendChild(refs);
      }
      const copyBtn = miniIcon('copy', 'Скопировать хеш');
      copyBtn.onclick = (e) => { e.stopPropagation(); lite.copyText(c.hash); toast('Хеш скопирован: ' + c.hash); };
      const acts = el('div', 'git-commit-acts'); acts.appendChild(copyBtn); cr.appendChild(acts);
      cr.addEventListener('click', () => selectCommit(c, cr));
      const hay = (c.hash + ' ' + c.subject + ' ' + c.when + ' ' + c.author + ' ' + (c.refs || '')).toLowerCase();
      rows.push({ el: cr, hay });
      logBox.appendChild(cr);
    }
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const r of rows) r.el.style.display = !q || r.hay.includes(q) ? '' : 'none';
    });
    // авто-выбор: ранее выбранный коммит или первый → сразу показать его файлы справа
    const initIdx = selectedCommit ? commits.findIndex((c) => c.hash === selectedCommit) : 0;
    if (initIdx >= 0 && rows[initIdx]) selectCommit(commits[initIdx], rows[initIdx].el);
  }

  // Дерево изменённых файлов выбранного коммита (иконки типов; клик по файлу → дифф файла в центре вивера).
  async function renderCommitFilesTree(filesSide, p, commit) {
    const myCommit = commit.hash;
    filesSide.replaceChildren(el('div', 'git-loading', 'Загрузка файлов…'));
    const r = await lite.git.commitFiles(p.path, commit.hash);
    if (selectedCommit !== myCommit) return;          // выбрали другой коммит за время await
    const files = (r && r.files) || [];
    filesSide.replaceChildren();
    const head = el('div', 'git-log-files-head');
    head.appendChild(el('span', 'gm-hash', commit.hash));
    head.appendChild(el('span', 'git-log-files-subj', commit.subject));
    filesSide.appendChild(head);
    if (!files.length) { filesSide.appendChild(el('div', 'git-log-files-empty', 'Файлов нет.')); return; }
    const treeWrap = el('div', 'git-log-tree');
    filesSide.appendChild(treeWrap);
    renderTreeNode(buildPathTree(files), treeWrap, p, commit, 0);
  }

  // path-tree из плоского списка файлов коммита (группировка по '/' как в PhpStorm).
  function buildPathTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const rel = String(f.rel || '').replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      const name = parts.pop() || rel;
      let node = root;
      for (const seg of parts) { if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] }); node = node.dirs.get(seg); }
      const c = String(f.code || 'M');
      const kind = (c === '?' || c.includes('A')) ? 'added' : c.includes('D') ? 'deleted' : c.includes('U') ? 'conflict' : 'modified';
      node.files.push({ rel, name, code: c, kind });
    }
    return root;
  }
  function renderTreeNode(node, container, p, commit, depth) {
    const pad = depth * 12 + 6;
    for (const [dname, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = el('div', 'git-tree-row dir'); row.style.paddingLeft = pad + 'px';
      if (host.folderIcon) row.appendChild(host.folderIcon());
      row.appendChild(el('span', 'git-tree-name', dname));
      container.appendChild(row);
      const box = el('div'); container.appendChild(box);
      renderTreeNode(child, box, p, commit, depth + 1);
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const row = el('div', 'git-tree-row file'); row.style.paddingLeft = pad + 'px'; row.title = f.rel;
      if (host.fileIcon) row.appendChild(host.fileIcon(f.name));
      row.appendChild(el('span', 'gm-code g-' + f.kind, (f.code || 'M').slice(0, 2)));
      row.appendChild(el('span', 'git-tree-name g-' + f.kind, f.name));
      row.addEventListener('click', () => { if (host.commitDiff) host.commitDiff(p.path, commit.hash, f.rel, { name: f.name }); });
      container.appendChild(row);
    }
  }

  // ============================================================ вкладка «Ветки»
  // JetBrains-style: per branch — checkout · update БЕЗ перехода · new branch · merge в текущую.
  function renderBranchesTab(content, p, info) {
    const head = el('div', 'gm-branch git-branch-toolbar');
    const current = el('div', 'git-current-branch');
    current.appendChild(icon('git', 14));
    current.appendChild(el('span', null, info.branch));
    head.appendChild(current);
    const nb = gitTool('plus', 'Новая ветка', 'Новая ветка от текущей');
    nb.onclick = () => showPrompt('Новая ветка', 'Имя ветки (создастся от текущей и перейдём на неё)', '', async (name) => {
      const r = await lite.git.branchCreate(p.path, name, info.branch, true);
      if (r.ok) { toast('Создана и перешёл: ' + name); renderProjects(); renderGitPanel(p); } return r;
    });
    head.appendChild(nb);
    content.appendChild(head);

    const list = el('div', 'gm-branches');
    const branches = (info.branches || []).slice().sort((a, b) => (a === info.branch ? -1 : b === info.branch ? 1 : a.localeCompare(b)));
    if (!branches.length) list.appendChild(el('div', 'gm-clean', 'Ветки не найдены.'));
    for (const b of branches) {
      const cur = b === info.branch;
      const row = el('div', 'gm-brow' + (cur ? ' current' : ''));
      const name = el('span', 'gm-brname' + (cur ? ' cur' : ''));
      name.appendChild(icon(cur ? 'check' : 'git', 13));
      name.appendChild(el('span', null, b));
      if (cur) name.appendChild(el('span', 'git-branch-badge', 'current'));
      row.appendChild(name);
      const tc = trackChip((info.branchTrack || {})[b]);
      if (tc) row.appendChild(tc);
      const acts = el('div', 'gm-bacts');
      if (!cur) {
        const co = miniIcon('arrow-right', 'Переключиться');
        co.onclick = async () => { const r = await lite.git.checkout(p.path, b); toast(r.ok ? 'Ветка: ' + b : (r.error || 'не вышло'), { kind: r.ok ? undefined : 'err', ttl: 7000 }); renderProjects(); renderGitPanel(p); };
        acts.appendChild(co);
        const mg = miniIcon('git', 'Слить в текущую');
        mg.onclick = () => showConfirm('Слить ветку?', '«' + b + '» будет слита в текущую «' + info.branch + '» (git merge). При конфликтах откроется разрешение.', 'Слить', async () => {
          const r = await lite.git.merge(p.path, b);
          if (r.ok) { toast('Слито: ' + b); renderProjects(); goCommitView(); renderGitPanel(p); return; }
          const c = await lite.git.conflicts(p.path);
          if (c.files && c.files.length) { toast('Конфликты — разрешите во вкладке «Изменения»', { kind: 'err', ttl: 9000 }); goCommitView(); renderGitPanel(p); }
          else toast(r.error || 'merge не прошёл', { kind: 'err', ttl: 9000 });
        });
        acts.appendChild(mg);
      }
      const up = miniIcon('refresh', cur ? 'Обновить текущую ветку (pull --ff-only)' : 'Обновить из удалёнки без переключения');
      up.onclick = async () => { const r = await lite.git.branchUpdate(p.path, b, cur); toast(r.ok ? ('Обновлено: ' + b) : (r.error || 'не fast-forward / нет upstream'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); };
      acts.appendChild(up);
      const newFrom = miniIcon('plus', 'Новая ветка от «' + b + '»');
      newFrom.onclick = () => showPrompt('Новая ветка от «' + b + '»', 'Имя ветки (создастся и перейдём на неё)', '', async (name) => {
        const r = await lite.git.branchCreate(p.path, name, b, true);
        if (r.ok) { toast('Создана и перешёл: ' + name); renderProjects(); renderGitPanel(p); } return r;
      });
      acts.appendChild(newFrom);
      row.appendChild(acts);
      list.appendChild(row);
    }
    content.appendChild(list);
  }

  // ============================================================ парсинг конфликтов
  // Разбор маркеров merge: <<<<<<< ours [||||||| base] ======= theirs >>>>>>>.
  // Возвращает { lines, blocks }, blocks: { start, baseAt, sep, end, ours[], theirs[] } (0-based индексы строк).
  function parseConflicts(text) {
    const lines = text.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('<<<<<<<')) {
        const start = i; const ours = []; const theirs = [];
        let baseAt = -1; let sep = -1; let end = -1;
        i++;
        while (i < lines.length && !lines[i].startsWith('|||||||') && !lines[i].startsWith('=======') && !lines[i].startsWith('>>>>>>>')) { ours.push(lines[i]); i++; }
        if (i < lines.length && lines[i].startsWith('|||||||')) { baseAt = i; i++; while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('>>>>>>>')) { i++; } } // diff3-секция base — пропускаем (UI её не показывает)
        if (i < lines.length && lines[i].startsWith('=======')) { sep = i; i++; while (i < lines.length && !lines[i].startsWith('>>>>>>>')) { theirs.push(lines[i]); i++; } }
        if (i < lines.length && lines[i].startsWith('>>>>>>>')) { end = i; }
        // Настоящий конфликт обязан содержать '======='. Без него (мусорный '<<<<<<<') блок не пушим —
        // иначе buildSide с sep=-1 откатывал бы офсет назад и дублировал строки.
        if (sep >= 0) blocks.push({ start, baseAt, sep, end, ours, theirs });
        i = (end >= 0 ? end : i) + 1;
      } else i++;
    }
    return { lines, blocks };
  }
  // Полный текст одной стороны (plain + выбранная сторона вместо блоков) + строки-метки регионов (1-based).
  function buildSide(parsed, side) {
    const { lines, blocks } = parsed;
    const out = []; const marks = [];
    let bi = 0; let i = 0;
    while (i < lines.length) {
      const b = blocks[bi];
      if (b && i === b.start) {
        const chosen = side === 'ours' ? b.ours : b.theirs;
        const from = out.length + 1;
        for (const l of chosen) out.push(l);
        if (chosen.length) marks.push({ fromLine: from, toLine: out.length, cls: side === 'ours' ? 'cm-conf-ours' : 'cm-conf-theirs' });
        i = (b.end >= 0 ? b.end : b.sep) + 1; bi++;
      } else { out.push(lines[i]); i++; }
    }
    return { text: out.join('\n'), marks };
  }

  // ============================================================ модалка merge (3 окна)
  async function openMergeModal(p, fileAbs) {
    const fname = baseName(fileAbs);
    const read = await lite.fs.readFile(fileAbs);
    if (read.error) { toast(read.error || 'не удалось прочитать файл', { kind: 'err' }); return; }
    const raw = read.content || '';
    const parsed0 = parseConflicts(raw);
    if (!parsed0.blocks.length) { toast('В файле нет маркеров конфликта', { kind: 'err' }); return; }

    const { m, close } = makeModal(`
      <div class="mrg-head">
        <span class="mrg-title"></span>
        <span class="mrg-count"></span>
        <div class="mrg-nav">
          <button class="gm-mini" id="mrg-prev" title="Предыдущий конфликт">↑</button>
          <button class="gm-mini" id="mrg-next" title="Следующий конфликт">↓</button>
        </div>
        <div class="mrg-actions">
          <button class="git-tool" id="mrg-ours" title="Принять нашу версию для текущего конфликта">Принять наше</button>
          <button class="git-tool" id="mrg-theirs" title="Принять их версию для текущего конфликта">Принять их</button>
          <button class="git-tool" id="mrg-both-ot" title="Оставить обе версии: наше, затем их">Обе версии</button>
          <button class="git-tool" id="mrg-both-to" title="Оставить обе версии: их, затем наше">Обе наоборот</button>
        </div>
      </div>
      <div class="mrg-grid">
        <div class="mrg-col"><div class="mrg-collabel">Наше (HEAD)</div><div class="mrg-ed" id="mrg-c-ours"></div></div>
        <div class="mrg-col"><div class="mrg-collabel">Результат</div><div class="mrg-ed" id="mrg-c-result"></div></div>
        <div class="mrg-col"><div class="mrg-collabel">Их</div><div class="mrg-ed" id="mrg-c-theirs"></div></div>
      </div>
      <div class="modal-actions mrg-foot">
        <button class="btn" id="mrg-abort">Прервать слияние</button>
        <button class="btn" id="mrg-cancel">Отмена</button>
        <button class="btn primary" id="mrg-save">Сохранить разрешение</button>
      </div>`,
      () => { [edOurs, edTheirs, edResult].forEach((e) => { try { e && e.destroy(); } catch (_) {} }); }); // снять CodeMirror при закрытии — иначе утечка трёх инстансов на каждое открытие модалки
    m.classList.add('modal-merge');
    m.querySelector('.mrg-title').textContent = fname;
    const lang = languageFor ? languageFor(fileAbs) : [];

    // три редактора (наше/их — read-only справочно; результат — редактируемый, сырой текст с маркерами)
    const oursSide = buildSide(parsed0, 'ours');
    const theirsSide = buildSide(parsed0, 'theirs');
    const edOurs = createCodeEditor(m.querySelector('#mrg-c-ours'), { doc: oursSide.text, readOnly: true, language: lang });
    const edTheirs = createCodeEditor(m.querySelector('#mrg-c-theirs'), { doc: theirsSide.text, readOnly: true, language: lang });
    const edResult = createCodeEditor(m.querySelector('#mrg-c-result'), { doc: raw, language: lang, onChange: () => refresh() });
    edOurs.setMarks(oursSide.marks);
    edTheirs.setMarks(theirsSide.marks);

    let current = 0; // индекс текущего конфликта
    const countEl = m.querySelector('.mrg-count');

    // пересчёт по актуальному тексту результата: подсветка регионов + счётчик + клампинг current
    function scan() { return parseConflicts(edResult.getValue()); }
    function resultMarks(parsed) {
      const marks = [];
      for (const b of parsed.blocks) {
        marks.push({ fromLine: b.start + 1, toLine: b.start + 1, cls: 'cm-conf-marker' });
        const ourEnd = (b.baseAt >= 0 ? b.baseAt : b.sep) - 1;
        if (b.sep > b.start) marks.push({ fromLine: b.start + 2, toLine: ourEnd + 1, cls: 'cm-conf-ours' });
        if (b.baseAt >= 0) marks.push({ fromLine: b.baseAt + 1, toLine: b.sep, cls: 'cm-conf-marker' });
        if (b.sep >= 0) marks.push({ fromLine: b.sep + 1, toLine: b.sep + 1, cls: 'cm-conf-marker' });
        if (b.end > b.sep) marks.push({ fromLine: b.sep + 2, toLine: b.end, cls: 'cm-conf-theirs' });
        if (b.end >= 0) marks.push({ fromLine: b.end + 1, toLine: b.end + 1, cls: 'cm-conf-marker' });
      }
      return marks;
    }
    let blocksCache = parsed0.blocks;
    function refresh() {
      const parsed = scan();
      blocksCache = parsed.blocks;
      edResult.setMarks(resultMarks(parsed));
      const n = parsed.blocks.length;
      if (current >= n) current = Math.max(0, n - 1);
      countEl.textContent = n ? `Конфликт ${Math.min(current + 1, n)} из ${n}` : '✓ конфликтов нет';
      const noConf = n === 0;
      ['mrg-prev', 'mrg-next', 'mrg-ours', 'mrg-theirs', 'mrg-both-ot', 'mrg-both-to'].forEach((id) => { m.querySelector('#' + id).disabled = noConf; });
    }
    function gotoCurrent() {
      const b = blocksCache[current];
      if (b) edResult.scrollToLine(b.start + 1);
    }
    // заменить блок текущего конфликта выбранным текстом (по свежему скану — офсеты всегда актуальны)
    function resolve(kind) {
      const parsed = scan();
      const b = parsed.blocks[current];
      if (!b || b.end < 0) return;
      const doc = edResult.view.state.doc;
      const from = doc.line(b.start + 1).from;
      const to = doc.line(b.end + 1).to;
      let insertLines;
      if (kind === 'ours') insertLines = b.ours;
      else if (kind === 'theirs') insertLines = b.theirs;
      else if (kind === 'both-ot') insertLines = [...b.ours, ...b.theirs];
      else insertLines = [...b.theirs, ...b.ours];
      edResult.view.dispatch({ changes: { from, to, insert: insertLines.join('\n') } });
      refresh();
      setTimeout(gotoCurrent, 0);
    }

    m.querySelector('#mrg-ours').onclick = () => resolve('ours');
    m.querySelector('#mrg-theirs').onclick = () => resolve('theirs');
    m.querySelector('#mrg-both-ot').onclick = () => resolve('both-ot');
    m.querySelector('#mrg-both-to').onclick = () => resolve('both-to');
    m.querySelector('#mrg-prev').onclick = () => { if (current > 0) { current--; gotoCurrent(); refresh(); } };
    m.querySelector('#mrg-next').onclick = () => { if (current < blocksCache.length - 1) { current++; gotoCurrent(); refresh(); } };
    m.querySelector('#mrg-cancel').onclick = close;
    m.querySelector('#mrg-abort').onclick = () => showConfirm('Прервать слияние?', 'git merge --abort откатит начатое слияние во всём репозитории.', 'Прервать', async () => {
      const r = await lite.git.mergeAbort(p.path);
      close();
      if (r.ok) { toast('Слияние прервано'); goCommitView(); renderGitPanel(p); renderProjects(); }
      else toast(r.error || 'не удалось прервать', { kind: 'err', ttl: 8000 });
    });
    m.querySelector('#mrg-save').onclick = async () => {
      const text = edResult.getValue();
      if (/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m.test(text)) {
        showConfirm('Остались маркеры конфликта', 'В результате ещё есть строки <<<<<<< / ||||||| / ======= / >>>>>>>. Сохранить как есть?', 'Сохранить всё равно', () => doSave(text));
        return;
      }
      doSave(text);
    };
    async function doSave(text) {
      const w = await lite.fs.writeFile(fileAbs, text);
      if (w && w.error) { toast(w.error || 'не удалось записать', { kind: 'err', ttl: 8000 }); return; }
      const a = await lite.git.add(p.path, [fileAbs]);
      close();
      if (a.ok) { toast('Конфликт разрешён: ' + fname); goCommitView(); renderGitPanel(p); renderProjects(); }
      else toast(a.error || 'записано, но git add не прошёл', { kind: 'err', ttl: 8000 });
    }

    refresh();
    setTimeout(() => { edResult.view.focus(); gotoCurrent(); }, 30);
  }

  return { setContainers, renderPanel: renderGitPanel };
}
