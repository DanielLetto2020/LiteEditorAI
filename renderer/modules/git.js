// LiteEditor — Git-модуль правого слота (PhpStorm-style панель активного проекта).
// Изолирован по образцу textproc.js: всё из ядра — только через host-колбэки,
// UI-хелперы — прямым импортом из ui.js, бэкенд — через window.lite.git.*.
// host: { layout, GUTTER, saveUiState, renderProjects, refitActiveTerminal,
//         activeProject, getActiveId, refreshTree, closeOtherPanels }
import { el, icon, toast, showConfirm, showPrompt, renderDiffInto, baseName } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initGit(host) {
  const { layout, GUTTER, saveUiState, renderProjects, refitActiveTerminal, activeProject, getActiveId, refreshTree, closeOtherPanels } = host;

  let gitOpen = false; // Git-модуль справа открыт (показывает активный проект)
  let gitRenderSeq = 0; // bumped on every render; a stale render (older seq) bails after its awaits

  function setGitOpen(open, opts = {}) {
    if (open && !activeProject() && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (open === gitOpen) { if (open) renderGitPanel(activeProject()); return; }
    // Right slot holds one module — opening Git closes the others (chat is separate).
    if (open) closeOtherPanels('git');
    const delta = layout.git + GUTTER;
    gitOpen = open;
    $('#git-pane').classList.toggle('hidden', !open);
    $('#gutter-git').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false on restore — saved width already counts this pane
    saveUiState();
    renderProjects();
    if (open) renderGitPanel(activeProject());
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleGit() { setGitOpen(!gitOpen); }

  function gitCodeClass(code) {
    if (code === '?' || code.includes('A')) return 'g-add';
    if (code.includes('D')) return 'g-del';
    return 'g-mod';
  }
  // Branch manager (JetBrains-style): per branch — checkout · update WITHOUT switching · new branch from it.
  async function showBranches(body, p, back) {
    const info = await lite.git.info(p.path);
    body.innerHTML = '';
    const head = el('div', 'gm-branch');
    head.appendChild(el('span', 'gm-branchname', 'Ветки'));
    head.appendChild(el('span', 'gm-track', 'текущая: ' + info.branch));
    body.appendChild(head);

    const list = el('div', 'gm-branches');
    for (const b of (info.branches || [])) {
      const cur = b === info.branch;
      const row = el('div', 'gm-brow');
      row.appendChild(el('span', 'gm-brname' + (cur ? ' cur' : ''), (cur ? '• ' : '') + b));
      const acts = el('div', 'gm-bacts');
      if (!cur) {
        const co = el('button', 'gm-mini', '⤳'); co.title = 'Переключиться';
        co.onclick = async () => { const r = await lite.git.checkout(p.path, b); toast(r.ok ? 'Ветка: ' + b : (r.error || 'не вышло'), { kind: r.ok ? undefined : 'err', ttl: 7000 }); renderProjects(); showBranches(body, p, back); };
        acts.appendChild(co);
      }
      const up = el('button', 'gm-mini', '↻'); up.title = cur ? 'Обновить (pull --ff-only)' : 'Обновить из удалёнки БЕЗ переключения';
      up.onclick = async () => { const r = await lite.git.branchUpdate(p.path, b, cur); toast(r.ok ? ('Обновлено: ' + b) : (r.error || 'не fast-forward / нет upstream'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); showBranches(body, p, back); };
      acts.appendChild(up);
      const nb = el('button', 'gm-mini', '＋'); nb.title = 'Новая ветка от «' + b + '»';
      nb.onclick = () => showPrompt('Новая ветка от «' + b + '»', 'Имя ветки (создастся и перейдём на неё)', '', async (name) => {
        const r = await lite.git.branchCreate(p.path, name, b, true);
        if (r.ok) { toast('Создана и перешёл: ' + name); renderProjects(); back(); } return r;
      });
      acts.appendChild(nb);
      row.appendChild(acts);
      list.appendChild(row);
    }
    body.appendChild(list);

    const footer = el('div', 'gm-actions');
    const b1 = el('button', 'btn', '‹ Назад к git'); b1.onclick = back;
    footer.appendChild(b1);
    body.appendChild(footer);
  }

  // Compact pill button for the Git toolbar (icon + optional label). Variants: 'primary' | 'ico' | 'danger'.
  function gitTool(iconName, label, title, variant) {
    const b = el('button', 'git-tool' + (variant ? ' ' + variant : ''));
    b.appendChild(icon(iconName, 14));
    if (label) b.appendChild(el('span', null, label));
    if (title) b.title = title;
    return b;
  }
  // PhpStorm-style Git panel for project `p`. Bound to the active project; re-rendered on
  // project switch (see doSetActive). Reuses lite.git.* — no new backend except git:log.
  async function renderGitPanel(p) {
    const body = $('#git-body');
    $('#git-proj').textContent = p ? `⎇ ${p.name}` : 'Git';
    if (!p) { body.innerHTML = ''; return; }
    const reqPath = p.path;
    const seq = ++gitRenderSeq;
    // Bail if a newer render started, Git closed, or the active project changed during an await.
    const stale = () => seq !== gitRenderSeq || !gitOpen || activeProject()?.path !== reqPath;
    body.innerHTML = '<div class="git-loading">Загрузка…</div>';
    const info = await lite.git.info(p.path);
    if (stale()) return;
    body.innerHTML = '';

    if (!info.repo) { // not a git repo → init / clone (same as the old modal)
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
      return;
    }

    // --- Branch row: switch + manager + ahead/behind
    const head = el('div', 'gm-branch');
    const sel = el('select', 'gm-branchsel');
    const brs = info.branches && info.branches.length ? info.branches : [info.branch];
    for (const b of brs) { const o = document.createElement('option'); o.value = b; o.textContent = '⎇ ' + b; if (b === info.branch) o.selected = true; sel.appendChild(o); }
    sel.onchange = async () => {
      const r = await lite.git.checkout(p.path, sel.value);
      if (r.ok) toast('Ветка: ' + sel.value); else toast(r.error || 'не удалось переключить', { kind: 'err', ttl: 8000 });
      renderGitPanel(p); renderProjects();
    };
    head.appendChild(sel);
    const mgr = el('button', 'gm-mini', '⎇'); mgr.title = 'Ветки: переключить · обновить без перехода · новая от ветки';
    mgr.onclick = () => showBranches(body, p, () => renderGitPanel(p));
    head.appendChild(mgr);
    if (info.upstream && (info.ahead || info.behind)) head.appendChild(el('span', 'gm-track', `↑${info.ahead} ↓${info.behind}`));
    body.appendChild(head);

    // --- Changes section (click a file → inline diff)
    const st = await lite.git.status(p.path);
    if (stale()) return;
    const files = (st && st.files) ? st.files : {};
    const keys = Object.keys(files);
    const chHead = el('div', 'git-sec git-sec-row');
    chHead.appendChild(el('span', null, 'Изменения' + (keys.length ? ` · ${keys.length}` : '')));
    if (keys.length) {
      const discAll = gitTool('eraser', null, 'Откатить все правки (git checkout -- .)', 'ico danger');
      discAll.onclick = () => showConfirm('Откатить все правки?', 'Изменения во всех отслеживаемых файлах будут отменены. Новые (неотслеживаемые) файлы останутся на месте.', 'Откатить всё', async () => {
        const rr = await lite.git.discardAll(p.path);
        if (rr.ok) { toast('Правки откачены'); renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
      });
      chHead.appendChild(discAll);
    }
    body.appendChild(chHead);
    const diffView = el('div', 'git-diff'); diffView.style.display = 'none';
    const changes = el('div', 'gm-changes');
    if (!keys.length) changes.appendChild(el('div', 'gm-clean', '✓ Рабочее дерево чистое.'));
    else for (const f of keys) {
      const r = el('div', 'gm-file'); r.title = f;
      r.appendChild(el('span', 'gm-code ' + gitCodeClass(files[f]), files[f]));
      const name = el('span', 'gm-fname', baseName(f)); r.appendChild(name);
      const disc = el('button', 'gm-mini gm-disc', '↩'); disc.title = 'Откатить изменения файла';
      disc.onclick = (e) => { e.stopPropagation(); showConfirm('Откатить файл?', `Изменения в «${baseName(f)}» будут отменены (git checkout --).`, 'Откатить', async () => {
        const rr = await lite.git.discardFile(p.path, f);
        if (rr.ok) { renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
      }); };
      r.appendChild(disc);
      r.addEventListener('click', async () => {
        const wasOpen = r.classList.contains('open');
        changes.querySelectorAll('.gm-file.open').forEach((x) => x.classList.remove('open'));
        if (wasOpen) { diffView.style.display = 'none'; return; }
        r.classList.add('open');
        diffView.style.display = 'block';
        diffView.innerHTML = '<div class="git-loading">Загрузка диффа…</div>';
        const d = await lite.git.fileDiff(p.path, f);
        renderDiffInto(diffView, d && d.diff);
      });
      changes.appendChild(r);
    }
    body.appendChild(changes);
    body.appendChild(diffView);

    // --- Commit box
    const msg = el('textarea', 'gm-msg'); msg.placeholder = 'Сообщение коммита…';
    body.appendChild(msg);
    // commit row: compact primary + push variant
    const commitRow = el('div', 'git-tools');
    const commit = gitTool('check', 'Commit', 'Закоммитить все изменения', 'primary');
    const commitPush = gitTool('upload', 'Commit & Push', 'Закоммитить и сразу запушить');
    commit.disabled = !keys.length; commitPush.disabled = !keys.length;
    const doCommit = async (withPush) => {
      const message = msg.value.trim();
      if (!message) { toast('Введи сообщение коммита', { kind: 'err' }); return; }
      const r = await lite.git.commit(p.path, message, withPush);
      if (r.ok) { toast(withPush ? 'Закоммичено и запушено' : 'Закоммичено'); msg.value = ''; renderGitPanel(p); renderProjects(); }
      else toast(r.error || 'ошибка коммита', { kind: 'err', ttl: 8000 });
    };
    commit.onclick = () => doCommit(false);
    commitPush.onclick = () => doCommit(true);
    commitRow.append(commit, commitPush);
    body.appendChild(commitRow);

    // sync row: fetch / pull / push, then stash group — neat icon pills
    const syncRow = el('div', 'git-tools');
    const fetchBtn = gitTool('refresh', 'Fetch', 'git fetch --all --prune');
    const pull = gitTool('download', 'Pull', 'git pull --ff-only');
    const push = gitTool('upload', 'Push', 'git push');
    const stash = gitTool('layers', 'Stash', 'Спрятать все изменения (git stash -u)');
    const stashPop = gitTool('archive', 'Pop', 'Вернуть последний stash (git stash pop)');
    stash.disabled = !keys.length;
    fetchBtn.onclick = async () => { const r = await lite.git.fetch(p.path); toast(r.ok ? 'Fetch готов' : (r.error || 'fetch не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); };
    push.onclick = async () => { const r = await lite.git.push(p.path); toast(r.ok ? 'Запушено' : (r.error || 'push не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); };
    pull.onclick = async () => { const r = await lite.git.pull(p.path); toast(r.ok ? 'Pull готов' : (r.error || 'pull не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); };
    stash.onclick = async () => { const r = await lite.git.stash(p.path); toast(r.ok ? 'Изменения спрятаны в stash' : (r.error || 'stash не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); };
    stashPop.onclick = async () => { const r = await lite.git.stashPop(p.path); toast(r.ok ? 'Stash возвращён' : (r.error || 'нет stash или конфликт'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); };
    syncRow.append(fetchBtn, pull, push, el('span', 'git-tsep'), stash, stashPop);
    body.appendChild(syncRow);

    // --- Commit history log (git:log)
    body.appendChild(el('div', 'git-sec', 'История'));
    const logBox = el('div', 'git-log');
    logBox.appendChild(el('div', 'git-loading', 'Загрузка истории…'));
    body.appendChild(logBox);
    const lg = await lite.git.log(p.path, 40);
    if (stale()) return;
    logBox.innerHTML = '';
    const commits = (lg && lg.commits) ? lg.commits : [];
    if (!commits.length) logBox.appendChild(el('div', 'gm-clean', 'Пока нет коммитов.'));
    else for (const c of commits) {
      const cr = el('div', 'git-commit'); cr.title = `${c.subject}\n${c.hash} · клик — скопировать хеш`;
      cr.appendChild(el('span', 'gm-hash', c.hash));
      cr.appendChild(el('span', 'git-csubj', c.subject));
      cr.appendChild(el('span', 'gm-meta', `${c.when} · ${c.author}`));
      if (c.refs) cr.appendChild(el('span', 'git-refs', c.refs));
      cr.addEventListener('click', () => { lite.copyText(c.hash); toast('Хеш скопирован: ' + c.hash); });
      logBox.appendChild(cr);
    }
  }

  return { isOpen: () => gitOpen, setOpen: setGitOpen, toggle: toggleGit, renderPanel: renderGitPanel };
}
