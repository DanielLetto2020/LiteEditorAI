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
  const excluded = new Set();// abs-пути файлов, исключённых из коммита (по умолчанию включены все)

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

  function gitCodeClass(code) {
    if (code === '?' || code.includes('A')) return 'g-add';
    if (code.includes('D')) return 'g-del';
    return 'g-mod';
  }
  // Compact pill button for the Git toolbar (icon + optional label). Variants: 'primary' | 'ico' | 'danger'.
  function gitTool(iconName, label, title, variant) {
    const b = el('button', 'git-tool' + (variant ? ' ' + variant : ''));
    b.appendChild(icon(iconName, 14));
    if (label) b.appendChild(el('span', null, label));
    if (title) b.title = title;
    return b;
  }

  // ============================================================ панель (вкладки)
  // Привязана к активному проекту; ядро зовёт renderPanel при смене проекта (см. doSetActive).
  async function renderGitPanel(p) {
    const body = $('#git-body');
    $('#git-proj').textContent = p ? `⎇ ${p.name}` : 'Git';
    if (!p) { body.innerHTML = ''; return; }
    if (p.path !== lastPath) { excluded.clear(); lastPath = p.path; } // новый проект — выбор файлов с нуля
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
    const head = el('div', 'git-head');
    const sel = el('select', 'gm-branchsel');
    const brs = info.branches && info.branches.length ? info.branches : [info.branch];
    for (const b of brs) { const o = document.createElement('option'); o.value = b; o.textContent = '⎇ ' + b; if (b === info.branch) o.selected = true; sel.appendChild(o); }
    sel.onchange = async () => {
      const r = await lite.git.checkout(p.path, sel.value);
      if (r.ok) toast('Ветка: ' + sel.value); else toast(r.error || 'не удалось переключить', { kind: 'err', ttl: 8000 });
      renderGitPanel(p); renderProjects();
    };
    head.appendChild(sel);
    const mgr = el('button', 'gm-mini', '⎇'); mgr.title = 'Управление ветками';
    mgr.onclick = () => { activeTab = 'branches'; renderGitPanel(p); };
    head.appendChild(mgr);
    if (info.upstream && (info.ahead || info.behind)) head.appendChild(el('span', 'gm-track', `↑${info.ahead} ↓${info.behind}`));
    return head;
  }

  // ============================================================ вкладка «Изменения»
  async function renderChangesTab(content, p, conflictSet, stale) {
    const st = await lite.git.status(p.path);
    if (stale()) return;
    const files = (st && st.files) ? st.files : {};
    const keys = Object.keys(files);

    // заголовок секции + откатить всё
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
    content.appendChild(chHead);

    const diffView = el('div', 'git-diff'); diffView.style.display = 'none';
    const changes = el('div', 'gm-changes');
    if (!keys.length) changes.appendChild(el('div', 'gm-clean', '✓ Рабочее дерево чистое.'));
    else for (const f of keys) {
      const conflicted = conflictSet.has(f);
      const r = el('div', 'gm-file' + (conflicted ? ' conflict' : '')); r.title = f;
      // чекбокс выбора в коммит (конфликтные — без чекбокса, пока не разрешены)
      if (!conflicted) {
        const cb = el('input', 'gm-check'); cb.type = 'checkbox'; cb.checked = !excluded.has(f);
        cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) excluded.delete(f); else excluded.add(f); };
        r.appendChild(cb);
      }
      r.appendChild(el('span', 'gm-code ' + gitCodeClass(files[f]), conflicted ? '!' : files[f]));
      r.appendChild(el('span', 'gm-fname', baseName(f)));
      if (conflicted) {
        const res = el('button', 'gm-mini gm-resolve', '⚔'); res.title = 'Разрешить конфликт (3 окна)';
        res.onclick = (e) => { e.stopPropagation(); openMergeModal(p, f); };
        r.appendChild(res);
      } else {
        const disc = el('button', 'gm-mini gm-disc', '↩'); disc.title = 'Откатить изменения файла';
        disc.onclick = (e) => { e.stopPropagation(); showConfirm('Откатить файл?', `Изменения в «${baseName(f)}» будут отменены (git checkout --).`, 'Откатить', async () => {
          const rr = await lite.git.discardFile(p.path, f);
          if (rr.ok) { renderGitPanel(p); renderProjects(); } else toast(rr.error || 'не удалось', { kind: 'err' });
        }); };
        r.appendChild(disc);
      }
      r.addEventListener('click', async () => {
        const wasOpen = r.classList.contains('open');
        changes.querySelectorAll('.gm-file.open').forEach((x) => x.classList.remove('open'));
        if (wasOpen) { diffView.style.display = 'none'; return; }
        r.classList.add('open');
        diffView.style.display = 'block';
        diffView.innerHTML = '<div class="git-loading">Загрузка диффа…</div>';
        const d = await lite.git.fileDiff(p.path, f);
        renderDiffInto(diffView, d && d.diff, f);
      });
      changes.appendChild(r);
    }
    content.appendChild(changes);
    content.appendChild(diffView);

    // --- коммит-бокс
    const msg = el('textarea', 'gm-msg'); msg.placeholder = 'Сообщение коммита…';
    content.appendChild(msg);
    const selectedFiles = () => keys.filter((k) => !conflictSet.has(k) && !excluded.has(k));
    const commitRow = el('div', 'git-tools');
    const commit = gitTool('check', 'Commit', 'Закоммитить выбранные изменения', 'primary');
    const commitPush = gitTool('upload', 'Commit & Push', 'Закоммитить выбранное и сразу запушить');
    const hasCommittable = keys.length > 0;
    commit.disabled = !hasCommittable; commitPush.disabled = !hasCommittable;
    const doCommit = async (withPush) => {
      const message = msg.value.trim();
      if (!message) { toast('Введи сообщение коммита', { kind: 'err' }); return; }
      const sel = selectedFiles();
      if (!sel.length) { toast('Не выбрано ни одного файла', { kind: 'err' }); return; }
      // все включены → add -A (ловит и неотслеживаемое целиком), иначе только выбранные
      const allIncluded = sel.length === keys.filter((k) => !conflictSet.has(k)).length && !conflictSet.size;
      const r = await lite.git.commit(p.path, message, withPush, allIncluded ? null : sel);
      if (r.ok) { toast(withPush ? 'Закоммичено и запушено' : 'Закоммичено'); msg.value = ''; renderGitPanel(p); renderProjects(); }
      else toast(r.error || 'ошибка коммита', { kind: 'err', ttl: 8000 });
    };
    commit.onclick = () => doCommit(false);
    commitPush.onclick = () => doCommit(true);
    commitRow.append(commit, commitPush);
    content.appendChild(commitRow);

    // --- синк: fetch / pull / push, затем stash-группа
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
    content.appendChild(syncRow);
  }

  // ============================================================ вкладка «История»
  async function renderHistoryTab(content, p, stale) {
    const logBox = el('div', 'git-log');
    logBox.appendChild(el('div', 'git-loading', 'Загрузка истории…'));
    content.appendChild(logBox);
    const lg = await lite.git.log(p.path, 60);
    if (stale()) return;
    logBox.innerHTML = '';
    const commits = (lg && lg.commits) ? lg.commits : [];
    if (!commits.length) { logBox.appendChild(el('div', 'gm-clean', 'Пока нет коммитов.')); return; }
    for (const c of commits) {
      const cr = el('div', 'git-commit'); cr.title = `${c.subject}\n${c.hash} · клик — скопировать хеш`;
      cr.appendChild(el('span', 'gm-hash', c.hash));
      cr.appendChild(el('span', 'git-csubj', c.subject));
      cr.appendChild(el('span', 'gm-meta', `${c.when} · ${c.author}`));
      if (c.refs) cr.appendChild(el('span', 'git-refs', c.refs));
      cr.addEventListener('click', () => { lite.copyText(c.hash); toast('Хеш скопирован: ' + c.hash); });
      logBox.appendChild(cr);
    }
  }

  // ============================================================ вкладка «Ветки»
  // JetBrains-style: per branch — checkout · update БЕЗ перехода · new branch · merge в текущую.
  function renderBranchesTab(content, p, info) {
    const head = el('div', 'gm-branch');
    head.appendChild(el('span', 'gm-track', 'текущая: ' + info.branch));
    const nb = gitTool('plus', 'Новая ветка', 'Новая ветка от текущей');
    nb.onclick = () => showPrompt('Новая ветка', 'Имя ветки (создастся от текущей и перейдём на неё)', '', async (name) => {
      const r = await lite.git.branchCreate(p.path, name, info.branch, true);
      if (r.ok) { toast('Создана и перешёл: ' + name); renderProjects(); renderGitPanel(p); } return r;
    });
    head.appendChild(nb);
    content.appendChild(head);

    const list = el('div', 'gm-branches');
    for (const b of (info.branches || [])) {
      const cur = b === info.branch;
      const row = el('div', 'gm-brow');
      row.appendChild(el('span', 'gm-brname' + (cur ? ' cur' : ''), (cur ? '• ' : '') + b));
      const acts = el('div', 'gm-bacts');
      if (!cur) {
        const co = el('button', 'gm-mini', '⤳'); co.title = 'Переключиться';
        co.onclick = async () => { const r = await lite.git.checkout(p.path, b); toast(r.ok ? 'Ветка: ' + b : (r.error || 'не вышло'), { kind: r.ok ? undefined : 'err', ttl: 7000 }); renderProjects(); renderGitPanel(p); };
        acts.appendChild(co);
        const mg = el('button', 'gm-mini', '⛙'); mg.title = `Слить «${b}» в текущую (${info.branch})`;
        mg.onclick = () => showConfirm('Слить ветку?', `«${b}» будет слита в текущую «${info.branch}» (git merge). При конфликтах откроется разрешение.`, 'Слить', async () => {
          const r = await lite.git.merge(p.path, b);
          if (r.ok) { toast('Слито: ' + b); renderProjects(); activeTab = 'changes'; renderGitPanel(p); return; }
          const c = await lite.git.conflicts(p.path);
          if (c.files && c.files.length) { toast('Конфликты — разрешите во вкладке «Изменения»', { kind: 'err', ttl: 9000 }); activeTab = 'changes'; renderGitPanel(p); }
          else toast(r.error || 'merge не прошёл', { kind: 'err', ttl: 9000 });
        });
        acts.appendChild(mg);
      }
      const up = el('button', 'gm-mini', '↻'); up.title = cur ? 'Обновить (pull --ff-only)' : 'Обновить из удалёнки БЕЗ переключения';
      up.onclick = async () => { const r = await lite.git.branchUpdate(p.path, b, cur); toast(r.ok ? ('Обновлено: ' + b) : (r.error || 'не fast-forward / нет upstream'), { kind: r.ok ? undefined : 'err', ttl: 8000 }); renderGitPanel(p); };
      acts.appendChild(up);
      const newFrom = el('button', 'gm-mini', '＋'); newFrom.title = 'Новая ветка от «' + b + '»';
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
  // Возвращает { lines, blocks }, blocks: { start, baseAt, sep, end, ours[], theirs[], base[] } (0-based индексы строк).
  function parseConflicts(text) {
    const lines = text.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('<<<<<<<')) {
        const start = i; const ours = []; const theirs = []; const base = [];
        let baseAt = -1; let sep = -1; let end = -1;
        i++;
        while (i < lines.length && !lines[i].startsWith('|||||||') && !lines[i].startsWith('=======') && !lines[i].startsWith('>>>>>>>')) { ours.push(lines[i]); i++; }
        if (i < lines.length && lines[i].startsWith('|||||||')) { baseAt = i; i++; while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('>>>>>>>')) { base.push(lines[i]); i++; } }
        if (i < lines.length && lines[i].startsWith('=======')) { sep = i; i++; while (i < lines.length && !lines[i].startsWith('>>>>>>>')) { theirs.push(lines[i]); i++; } }
        if (i < lines.length && lines[i].startsWith('>>>>>>>')) { end = i; }
        blocks.push({ start, baseAt, sep, end, ours, theirs, base });
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
          <button class="git-tool" id="mrg-ours" title="Текущий конфликт ← наше">Наше</button>
          <button class="git-tool" id="mrg-theirs" title="Текущий конфликт ← их">Их</button>
          <button class="git-tool" id="mrg-both-ot" title="Оба: наше, затем их">Оба ⬍</button>
          <button class="git-tool" id="mrg-both-to" title="Оба: их, затем наше">Оба ⬍↺</button>
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
      </div>`);
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
