// LiteEditor — Git-модуль правого слота (PhpStorm-style панель активного проекта).
// Изолирован: всё из ядра — только через host-колбэки, UI-хелперы — прямым импортом из ui.js,
// бэкенд — через window.lite.git.*. Структура панели: компактная шапка (ветка + ahead/behind) +
// вкладки «Изменения» / «История» / «Ветки». Разрешение конфликтов merge — отдельная модалка (3 окна).
// host: { layout, GUTTER, saveUiState, renderProjects, refitActiveTerminal, activeProject,
//         getActiveId, refreshTree, closeOtherPanels, createCodeEditor, languageFor }
import { el, icon, toast, showConfirm, showPrompt, renderDiffInto, baseName, makeModal } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initGit(host) {
  const { layout, GUTTER, saveUiState, renderProjects, refitActiveTerminal, activeProject, getActiveId, refreshTree, closeOtherPanels, createCodeEditor, languageFor } = host;

  let gitOpen = false;       // Git-модуль справа открыт (показывает активный проект)
  let gitRenderSeq = 0;      // bumped on every render; a stale render (older seq) bails after its awaits
  let activeTab = 'changes'; // 'changes' | 'history' | 'branches'
  let lastPath = null;       // путь проекта прошлого рендера — на смену сбрасываем выбор файлов
  let selectedChangeFile = null; // выделенный файл во вкладке «Изменения»
  const excluded = new Set();// abs-пути файлов, исключённых из коммита (по умолчанию включены все)

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

  function setGitOpen(open, opts = {}) {
    if (open && !activeProject() && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (open === gitOpen) { if (open) renderGitPanel(activeProject()); return; }
    if (open) closeOtherPanels('git'); // Right slot holds one module (chat is separate)
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

  // ============================================================ панель (вкладки)
  // Привязана к активному проекту; ядро зовёт renderPanel при смене проекта (см. doSetActive).
  async function renderGitPanel(p) {
    const body = $('#git-body');
    $('#git-proj').textContent = p ? `⎇ ${p.name}` : 'Git';
    if (!p) { body.innerHTML = ''; return; }
    if (p.path !== lastPath) { excluded.clear(); selectedChangeFile = null; lastPath = p.path; } // новый проект — выбор файлов с нуля
    const reqPath = p.path;
    const seq = ++gitRenderSeq;
    const stale = () => seq !== gitRenderSeq || !gitOpen || activeProject()?.path !== reqPath;
    body.innerHTML = '<div class="git-loading">Загрузка…</div>';
    const info = await lite.git.info(p.path);
    if (stale()) return;
    body.innerHTML = '';

    if (!info.repo) { renderNoRepo(body, p); return; }

    const conf = await lite.git.conflicts(p.path);
    if (stale()) return;
    const conflictSet = new Set((conf.files || []).map((f) => f.abs));

    body.appendChild(renderHeader(p, info));

    // --- вкладки
    const tabsBar = el('div', 'git-tabs');
    const TABS = [['changes', 'Изменения'], ['history', 'История'], ['branches', 'Ветки']];
    for (const [id, label] of TABS) {
      const t = el('button', 'git-tab' + (activeTab === id ? ' active' : ''), label);
      if (id === 'changes' && conflictSet.size) t.appendChild(el('span', 'git-tab-badge', String(conflictSet.size)));
      t.onclick = () => { if (activeTab === id) return; activeTab = id; renderGitPanel(p); };
      tabsBar.appendChild(t);
    }
    body.appendChild(tabsBar);
    const content = el('div', 'git-tabwrap');
    body.appendChild(content);

    if (activeTab === 'changes') await renderChangesTab(content, p, conflictSet, stale);
    else if (activeTab === 'history') await renderHistoryTab(content, p, stale);
    else renderBranchesTab(content, p, info);
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

  // --- компактная шапка: ветка (select) + менеджер веток + ahead/behind
  function renderHeader(p, info) {
    const head = el('div', 'git-head git-head-card');
    const branchRow = el('div', 'git-head-main');
    const branchLabel = el('div', 'git-branch-label');
    branchLabel.appendChild(icon('git', 14));
    branchLabel.appendChild(el('span', null, 'Ветка'));

    // Кастомная выпадашка веток (не нативный <select>): popup растягивается left:0/right:0
    // внутри грид-ячейки и потому НИКОГДА не вылезает за пределы панели/экрана справа —
    // в отличие от нативного option-popup Chromium, который у правого края уезжал за экран.
    const brs = info.branches && info.branches.length ? info.branches : [info.branch];
    const dd = el('div', 'gm-branchdd');
    const ddBtn = el('button', 'gm-branchsel');
    ddBtn.type = 'button';
    ddBtn.title = 'Текущая ветка — нажмите для переключения';
    ddBtn.append(el('span', 'gm-branchsel-txt', info.branch), icon('chevron-down', 14));
    const pop = el('div', 'gm-branchpop hidden');
    dd.append(ddBtn, pop);
    let popOpen = false;
    const onDoc = (e) => { if (!dd.contains(e.target)) closePop(); };
    function closePop() { popOpen = false; pop.classList.add('hidden'); dd.classList.remove('open'); document.removeEventListener('mousedown', onDoc, true); }
    function openPop() {
      pop.innerHTML = '';
      for (const b of brs) {
        const item = el('div', 'gm-branchitem' + (b === info.branch ? ' cur' : ''));
        item.appendChild(icon(b === info.branch ? 'check' : 'git', 13));
        item.appendChild(el('span', 'gm-branchitem-name', b));
        const tc = trackChip((info.branchTrack || {})[b]);
        if (tc) item.appendChild(tc);
        item.onclick = async () => {
          closePop();
          if (b === info.branch) return;
          const r = await lite.git.checkout(p.path, b);
          if (r.ok) toast('Ветка: ' + b); else toast(r.error || 'не удалось переключить', { kind: 'err', ttl: 8000 });
          renderGitPanel(p); renderProjects();
        };
        pop.appendChild(item);
      }
      popOpen = true; pop.classList.remove('hidden'); dd.classList.add('open');
      document.addEventListener('mousedown', onDoc, true);
    }
    ddBtn.onclick = () => (popOpen ? closePop() : openPop());
    branchRow.append(branchLabel, dd);

    const mgr = miniIcon('sliders', 'Управление ветками');
    mgr.onclick = () => { activeTab = 'branches'; renderGitPanel(p); };
    branchRow.appendChild(mgr);
    head.appendChild(branchRow);

    const meta = el('div', 'git-head-meta');
    if (info.upstream) {
      const sync = el('span', 'git-chip' + ((info.ahead || info.behind) ? ' warn' : ' ok'), (info.ahead || info.behind) ? ('↑' + info.ahead + ' ↓' + info.behind) : 'up to date');
      sync.title = 'Относительно upstream';
      meta.appendChild(sync);
    } else meta.appendChild(el('span', 'git-chip muted', info.hasRemote ? 'нет upstream' : 'без remote'));
    if (info.lastCommit) {
      const last = el('span', 'git-chip git-last-chip', info.lastCommit.hash + ' · ' + info.lastCommit.subject);
      last.title = info.lastCommit.when + ' · ' + info.lastCommit.author;
      meta.appendChild(last);
    }
    head.appendChild(meta);
    return head;
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

    const summary = el('div', 'git-summary');
    const changedCard = el('div', 'git-sum-card');
    changedCard.appendChild(el('span', 'git-sum-num', String(keys.length)));
    changedCard.appendChild(el('span', 'git-sum-label', shortCount(keys.length, 'файл', 'файла', 'файлов')));
    summary.appendChild(changedCard);
    const includedCard = el('div', 'git-sum-card');
    const includedNum = el('span', 'git-sum-num');
    const includedLabel = el('span', 'git-sum-label');
    includedCard.append(includedNum, includedLabel);
    summary.appendChild(includedCard);
    if (conflictSet.size) {
      const conflictCard = el('div', 'git-sum-card danger');
      conflictCard.appendChild(el('span', 'git-sum-num', String(conflictSet.size)));
      conflictCard.appendChild(el('span', 'git-sum-label', shortCount(conflictSet.size, 'конфликт', 'конфликта', 'конфликтов')));
      summary.appendChild(conflictCard);
    }
    content.appendChild(summary);

    const workbench = el('div', 'git-workbench');
    const left = el('div', 'git-changes-panel');
    const right = el('div', 'git-preview-panel');
    workbench.append(left, right);
    content.appendChild(workbench);

    const listHead = el('div', 'git-list-head');
    listHead.appendChild(el('div', 'git-sec', 'Изменения'));
    const listActions = el('div', 'git-list-actions');
    const includeAll = gitTool('check', 'Все', 'Включить все файлы в коммит');
    const excludeAll = gitTool('x', 'Снять', 'Исключить все файлы из коммита');
    includeAll.disabled = !committableKeys.length;
    excludeAll.disabled = !committableKeys.length;
    listActions.append(includeAll, excludeAll);
    listHead.appendChild(listActions);
    left.appendChild(listHead);

    const changes = el('div', 'gm-changes git-change-list');
    left.appendChild(changes);

    const previewHead = el('div', 'git-preview-head');
    const previewTitle = el('div', 'git-preview-title', 'Diff');
    const previewMeta = el('div', 'git-preview-meta', 'Выберите файл');
    previewHead.append(previewTitle, previewMeta);
    right.appendChild(previewHead);
    const diffView = el('div', 'git-diff git-diff-preview');
    right.appendChild(diffView);

    const selectedFiles = () => keys.filter((k) => !conflictSet.has(k) && !excluded.has(k));
    let updateSummary = () => {
      const n = selectedFiles().length;
      includedNum.textContent = String(n);
      includedLabel.textContent = 'в коммит из ' + committableKeys.length;
    };
    const updateCommitState = () => {
      updateSummary();
      const n = selectedFiles().length;
      const blockedByConflicts = conflictSet.size > 0;
      if (commit && commitPush) {
        commit.disabled = !n || blockedByConflicts;
        commitPush.disabled = !n || blockedByConflicts;
        const title = blockedByConflicts ? 'Сначала разрешите конфликты' : (!n ? 'Не выбрано ни одного файла' : 'Закоммитить выбранные изменения');
        commit.title = title;
        commitPush.title = blockedByConflicts ? title : 'Закоммитить выбранное и сразу запушить';
      }
    };
    const paintSelection = () => {
      changes.querySelectorAll('.gm-file').forEach((row) => row.classList.toggle('open', row._file === selectedChangeFile));
    };
    let diffSeq = 0;
    const showDiff = async (f) => {
      selectedChangeFile = f;
      paintSelection();
      const label = splitPath(f, p.path);
      previewTitle.textContent = label.name;
      previewMeta.textContent = label.dir || label.rel;
      diffView.innerHTML = '<div class="git-loading">Загрузка диффа…</div>';
      const seq = ++diffSeq;
      const d = await lite.git.fileDiff(p.path, f);
      if (stale() || seq !== diffSeq) return;
      renderDiffInto(diffView, d && d.diff, f);
    };

    if (!keys.length) {
      const clean = el('div', 'git-clean-state');
      clean.appendChild(icon('check', 20));
      clean.appendChild(el('div', 'git-clean-title', 'Рабочее дерево чистое'));
      clean.appendChild(el('div', 'git-clean-note', 'Можно проверить remote или перейти к истории коммитов.'));
      changes.appendChild(clean);
      diffView.innerHTML = '<div class="diff-empty">Нет локальных изменений.</div>';
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
        head.appendChild(el('span', null, group.title));
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
            cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) excluded.delete(f); else excluded.add(f); updateCommitState(); };
            r.appendChild(cb);
          } else r.appendChild(el('span', 'gm-check-spacer'));
          r.appendChild(el('span', 'gm-code g-' + kind, statusChipText(files[f], kind)));
          const nameBox = el('span', 'gm-file-main');
          nameBox.appendChild(el('span', 'gm-fname', label.name));
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
        changes.appendChild(box);
      };
      for (const group of groups) appendGroup(group);
    }

    let commit = null, commitPush = null;
    const msg = el('textarea', 'gm-msg'); msg.placeholder = 'Сообщение коммита…';
    const commitPanel = el('div', 'git-commit-panel');
    const commitTop = el('div', 'git-commit-top');
    const commitCaption = el('div', 'git-sec', 'Commit');
    const commitCount = el('div', 'git-commit-count');
    commitTop.append(commitCaption, commitCount);
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
      if (r.ok) { toast(withPush ? 'Закоммичено и запушено' : 'Закоммичено'); msg.value = ''; selectedChangeFile = null; renderGitPanel(p); renderProjects(); }
      // Коммит лёг, но push не прошёл: список ОБЯЗАН обновиться (файлы уже в коммите), плюс показываем ошибку.
      else if (r.committed) { toast(r.error || 'push не прошёл', { kind: 'err', ttl: 9000 }); msg.value = ''; selectedChangeFile = null; renderGitPanel(p); renderProjects(); }
      else { btn.disabled = false; toast(r.error || 'ошибка коммита', { kind: 'err', ttl: 8000 }); updateCommitState(); }
    };
    commit.onclick = () => doCommit(false);
    commitPush.onclick = () => doCommit(true);
    commitRow.append(commit, commitPush);
    commitPanel.appendChild(commitRow);

    const syncPanel = el('div', 'git-sync-panel');
    const syncTitle = el('div', 'git-sec', 'Sync');
    syncPanel.appendChild(syncTitle);
    const syncRow = el('div', 'git-tools');
    const fetchBtn = gitTool('refresh', 'Fetch', 'git fetch --all --prune');
    const pull = gitTool('download', 'Pull', 'git pull --ff-only');
    const push = gitTool('upload', 'Push', 'git push');
    const stash = gitTool('layers', 'Stash', 'Спрятать все изменения (git stash -u)');
    const stashPop = gitTool('archive', 'Pop', 'Вернуть последний stash (git stash pop)');
    const discAll = gitTool('eraser', 'Discard all', 'Откатить все отслеживаемые правки', 'danger');
    stash.disabled = !keys.length;
    discAll.disabled = !keys.length;
    const runAction = async (btn, fn) => { btn.disabled = true; btn.classList.add('loading'); try { await fn(); } finally { btn.classList.remove('loading'); } };
    fetchBtn.onclick = () => runAction(fetchBtn, async () => { const r = await lite.git.fetch(p.path); toast(r.ok ? 'Fetch готов' : (r.error || 'fetch не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); });
    push.onclick = () => runAction(push, async () => { const r = await lite.git.push(p.path); toast(r.ok ? 'Запушено' : (r.error || 'push не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); });
    pull.onclick = () => runAction(pull, async () => { const r = await lite.git.pull(p.path); toast(r.ok ? 'Pull готов' : (r.error || 'pull не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); });
    stash.onclick = () => runAction(stash, async () => { const r = await lite.git.stash(p.path); toast(r.ok ? 'Изменения спрятаны в stash' : (r.error || 'stash не прошёл'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); });
    stashPop.onclick = () => runAction(stashPop, async () => { const r = await lite.git.stashPop(p.path); toast(r.ok ? 'Stash возвращён' : (r.error || 'нет stash или конфликт'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); renderProjects(); });
    discAll.onclick = () => showConfirm('Откатить все правки?', 'Изменения во всех отслеживаемых файлах будут отменены. Новые (неотслеживаемые) файлы останутся на месте.', 'Откатить всё', async () => {
      const rr = await lite.git.discardAll(p.path);
      if (rr.ok) { selectedChangeFile = null; toast('Правки откачены'); renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
    });
    syncRow.append(fetchBtn, pull, push, el('span', 'git-tsep'), stash, stashPop, el('span', 'git-tsep'), discAll);
    syncPanel.appendChild(syncRow);
    content.appendChild(syncPanel);
    content.appendChild(commitPanel);

    includeAll.onclick = () => { for (const f of committableKeys) excluded.delete(f); changes.querySelectorAll('.gm-check').forEach((cb) => { cb.checked = true; }); updateCommitState(); };
    excludeAll.onclick = () => { for (const f of committableKeys) excluded.add(f); changes.querySelectorAll('.gm-check').forEach((cb) => { cb.checked = false; }); updateCommitState(); };
    const updateCountLabel = () => { commitCount.textContent = selectedFiles().length + ' из ' + committableKeys.length + ' файлов'; };
    const prevUpdate = updateSummary;
    updateSummary = () => { prevUpdate(); updateCountLabel(); };
    updateCommitState();
    if (selectedChangeFile) showDiff(selectedChangeFile);
  }

  // ============================================================ вкладка «История»
  async function renderHistoryTab(content, p, stale) {
    const tools = el('div', 'git-history-tools');
    const searchWrap = el('div', 'git-search-wrap');
    searchWrap.appendChild(icon('search', 14));
    const search = el('input', 'git-search');
    search.type = 'search'; search.placeholder = 'Фильтр по истории';
    searchWrap.appendChild(search);
    tools.appendChild(searchWrap);
    content.appendChild(tools);

    const logBox = el('div', 'git-log');
    logBox.appendChild(el('div', 'git-loading', 'Загрузка истории…'));
    content.appendChild(logBox);
    const lg = await lite.git.log(p.path, 80);
    if (stale()) return;
    logBox.innerHTML = '';
    const commits = (lg && lg.commits) ? lg.commits : [];
    if (!commits.length) { logBox.appendChild(el('div', 'gm-clean', 'Пока нет коммитов.')); return; }
    const rows = [];
    for (const c of commits) {
      const cr = el('div', 'git-commit');
      cr.title = c.subject + '\n' + c.hash + ' · клик — скопировать хеш';
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
      cr.addEventListener('click', () => { lite.copyText(c.hash); toast('Хеш скопирован: ' + c.hash); });
      const hay = (c.hash + ' ' + c.subject + ' ' + c.when + ' ' + c.author + ' ' + (c.refs || '')).toLowerCase();
      rows.push({ el: cr, hay });
      logBox.appendChild(cr);
    }
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const r of rows) r.el.style.display = !q || r.hay.includes(q) ? '' : 'none';
    });
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
          if (r.ok) { toast('Слито: ' + b); renderProjects(); activeTab = 'changes'; renderGitPanel(p); return; }
          const c = await lite.git.conflicts(p.path);
          if (c.files && c.files.length) { toast('Конфликты — разрешите во вкладке «Изменения»', { kind: 'err', ttl: 9000 }); activeTab = 'changes'; renderGitPanel(p); }
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
      if (r.ok) { toast('Слияние прервано'); activeTab = 'changes'; renderGitPanel(p); renderProjects(); }
      else toast(r.error || 'не удалось прервать', { kind: 'err', ttl: 8000 });
    });
    m.querySelector('#mrg-save').onclick = async () => {
      const text = edResult.getValue();
      if (/^(<<<<<<<|=======|>>>>>>>)/m.test(text)) {
        showConfirm('Остались маркеры конфликта', 'В результате ещё есть строки <<<<<<< / ======= / >>>>>>>. Сохранить как есть?', 'Сохранить всё равно', () => doSave(text));
        return;
      }
      doSave(text);
    };
    async function doSave(text) {
      const w = await lite.fs.writeFile(fileAbs, text);
      if (w && w.error) { toast(w.error || 'не удалось записать', { kind: 'err', ttl: 8000 }); return; }
      const a = await lite.git.add(p.path, [fileAbs]);
      close();
      if (a.ok) { toast('Конфликт разрешён: ' + fname); activeTab = 'changes'; renderGitPanel(p); renderProjects(); }
      else toast(a.error || 'записано, но git add не прошёл', { kind: 'err', ttl: 8000 });
    }

    refresh();
    setTimeout(() => { edResult.view.focus(); gotoCurrent(); }, 30);
  }

  return { isOpen: () => gitOpen, setOpen: setGitOpen, toggle: toggleGit, renderPanel: renderGitPanel };
}
