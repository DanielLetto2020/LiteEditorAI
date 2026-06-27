// LiteEditor — модуль «Задачи»: окно с двумя вкладками.
//   • «Проект» — задачи активного проекта (notes/<projId>.json), следует за активным проектом, как Git;
//   • «Общие» — задачи вне проектов (notes/__global__.json).
// Запоминается между перезапусками (settings.*): вкладка (notesTab), вид (notesView: список/канбан),
// сортировка (notesSort: вручную/по важности), markdown-превью тела (notesMd).
// Изолирован по образцу git.js: всё из ядра — через host, UI-хелперы — из ui.js.
// Модель задачи: { id, text, status:'todo'|'doing'|'done', prio:0|1|2, subtasks?:[{id,text,done}] }.
//   Первая строка text = заголовок (всегда виден), остальное = тело (сворачивается).
// Перерисовка: shell (вкладки/тулбар/чипы) строится в renderList(); список/канбан — в renderBody()
//   с сохранением позиции скролла, поэтому частые правки (статус/важность/подзадача) не дёргают панель.
// Счётчик активных задач (бейдж на квикбаре) считает ЯДРО (главное окно) по app:notesChanged → с диска;
// модуль лишь шлёт broadcastChange после каждой записи. Сам модуль счётчик нигде не хранит.
// host: { settings, saveSettings, applyLayoutSwap, sendNoteToTerminal,
//         layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, getProjects }
import { el, icon, iconBtn, makeModal, showConfirm, toast } from '../ui.js';
import { marked } from 'marked';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const GLOBAL_ID = '__global__';                    // отдельный файл для «общих» задач
const STATUS = ['todo', 'doing', 'done'];          // цикл по клику
const STATUS_LABEL = { todo: 'К выполнению', doing: 'В работе', done: 'Выполнено' };
const PRIO_LABEL = ['Обычная', 'Важная', 'Срочная'];
const KANBAN_COLS = [['todo', 'К выполнению'], ['doing', 'В работе'], ['done', 'Готово']];
const KANBAN_GROW = 380;                            // насколько расширить окно при включении канбан-вида

// первая строка = заголовок задачи (всегда виден); остальное = тело (сворачивается)
const titleOf = (t) => { const s = (t || '').trim(); const i = s.indexOf('\n'); return (i < 0 ? s : s.slice(0, i)).trim(); };
const bodyOf = (t) => { const s = (t || ''); const i = s.indexOf('\n'); return i < 0 ? '' : s.slice(i + 1).trim(); };
const genId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// markdown тела задачи (defense-in-depth поверх CSP: вырезаем активные узлы/обработчики; ссылки — наружу)
function mdToSafeHtml(src) {
  const div = el('div', 'nt-md');
  try { div.innerHTML = marked.parse(src || '', { breaks: true }); } catch (_) { div.textContent = src || ''; }
  div.querySelectorAll('script, iframe, frame, object, embed, base, link, meta').forEach((n) => n.remove());
  div.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const nm = a.name.toLowerCase();
      if (nm.startsWith('on')) n.removeAttribute(a.name);
      else if (/^(href|src|xlink:href)$/.test(nm) && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
  });
  div.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a && /^https?:/i.test(a.href)) { e.preventDefault(); lite.openExternal(a.href); } });
  return div;
}

export function initNotes(host) {
  const { settings, saveSettings, applyLayoutSwap, sendNoteToTerminal,
    layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, getProjects } = host;

  let notesOpen = false;
  let tab = (settings.notesTab === 'global') ? 'global' : 'project'; // последняя вкладка
  let filter = 'active';     // 'active' | 'all' | 'done'
  let view = (settings.notesView === 'kanban') ? 'kanban' : 'list';  // вид списка
  let sortMode = (settings.notesSort === 'prio') ? 'prio' : 'manual';// порядок: ручной / по важности
  let mdPreview = !!settings.notesMd;   // рендерить тело задачи как markdown
  let query = '';            // строка поиска (живёт в сессии)
  let notes = [];            // загруженный список текущей вкладки
  let loadedId = null;       // id списка, который сейчас в `notes`
  let loadSeq = 0;           // защита от гонки async-загрузки
  let kanbanWidened = false; // расширяли ли окно под канбан (чтобы вернуть ширину при возврате к списку)
  let dragId = null;         // id перетаскиваемой карточки (DnD)
  const expanded = new Set(); // id задач, развёрнутых вручную (тело-аккордеон); живёт в памяти сессии
  const cardEls = new Map();  // id -> DOM-карточка (точечное обновление)

  // Куда смотрит активная вкладка: проект (активный) или общий список.
  function currentTarget() {
    if (tab === 'global') return { kind: 'global', id: GLOBAL_ID, name: 'Общие заметки' };
    const p = activeProject();
    return p ? { kind: 'project', id: p.id, name: p.name, proj: p } : null;
  }
  // Терминал, куда уходит «В терминал»: для общих задач — терминал активного проекта.
  function termProject(target) { return target && target.kind === 'project' ? target.proj : activeProject(); }

  // ---------------- данные ----------------
  async function load(id) {
    const seq = ++loadSeq;
    let arr = await lite.store.notesGet(id);
    if (seq !== loadSeq) return false; // более новая загрузка уже идёт
    if (!Array.isArray(arr)) arr = [];
    // Миграция без потери данных: старым заметкам {id,text} проставляем дефолты status/prio (и id, если нет —
    // нужен для аккордеона/точечного обновления, иначе все безыдентификаторные слиплись бы в один тоггл).
    arr.forEach((n) => {
      if (!n.id) n.id = genId();
      if (!STATUS.includes(n.status)) n.status = 'todo';
      if (typeof n.prio !== 'number') n.prio = 0;
      if (!Array.isArray(n.subtasks)) n.subtasks = [];
    });
    notes = arr; loadedId = id;
    return true;
  }
  function broadcastChange(id) { try { lite.app.notesChanged(id); } catch (_) {} } // → бейдж в главном окне + др. окна
  function save() {
    if (!loadedId) return;
    lite.store.notesSet(loadedId, notes);
    broadcastChange(loadedId);
  }
  function counts() {
    const done = notes.filter((n) => n.status === 'done').length;
    return { all: notes.length, done, active: notes.length - done };
  }
  const matchesFilter = (n) => filter === 'active' ? n.status !== 'done' : filter === 'done' ? n.status === 'done' : true;
  const matchesQuery = (n) => {
    if (!query) return true;
    const q = query.toLowerCase();
    if ((n.text || '').toLowerCase().includes(q)) return true;
    return Array.isArray(n.subtasks) && n.subtasks.some((s) => (s.text || '').toLowerCase().includes(q));
  };
  // Видимый срез (фильтр статуса + поиск; порядок — ручной или по важности).
  function visible() {
    let arr = notes.filter((n) => matchesFilter(n) && matchesQuery(n));
    if (sortMode === 'prio') arr = arr.slice().sort((a, b) => b.prio - a.prio); // важные выше (стабильно)
    return arr;
  }
  // Переставить задачу относительно соседа в ВИДИМОМ порядке (свап в массиве; только ручной список).
  function move(note, dir) {
    const vis = visible();
    const sib = vis[vis.indexOf(note) + dir];
    if (!sib) return;
    const a = notes.indexOf(note), b = notes.indexOf(sib);
    if (a < 0 || b < 0) return;
    [notes[a], notes[b]] = [notes[b], notes[a]];
    save(); renderBody();
  }
  // DnD: список — переставить относительно цели; канбан — бросить в колонку (см. attachKanbanDrop).
  function reorder(srcId, dstId, after) {
    const si = notes.findIndex((n) => n.id === srcId); if (si < 0) return;
    const [m] = notes.splice(si, 1);
    const di = notes.findIndex((n) => n.id === dstId);
    if (di < 0) { notes.splice(si, 0, m); return; }
    notes.splice(after ? di + 1 : di, 0, m);
    save(); renderBody();
  }

  // ---------------- модалка задачи (новая / правка + подзадачи) ----------------
  function openTaskModal(note) {
    const isNew = !note;
    const { m, close } = makeModal(`
      <h2>${isNew ? 'Новая задача' : 'Редактировать задачу'}</h2>
      <textarea class="nt-modal-ta" placeholder="Описание задачи… Первая строка — заголовок."></textarea>
      <div class="nt-modal-hint">Первая строка = заголовок · Ctrl+Enter — сохранить · Esc — отмена</div>
      <div class="nt-subs-edit">
        <div class="nt-subs-edit-head">Подзадачи (чеклист)</div>
        <div class="nt-subs-list" data-subs></div>
        <button class="btn nt-subadd" data-subadd>＋ Подзадача</button>
      </div>
      <div class="modal-actions">
        <button class="btn nt-modal-swap" data-swap>⇄ Раскладка</button>
        <button class="btn" data-cancel>Отмена</button>
        <button class="btn primary" data-ok>${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>`);
    m.classList.add('nt-modal');
    const ta = m.querySelector('.nt-modal-ta');
    ta.value = note ? (note.text || '') : '';
    const subsBox = m.querySelector('[data-subs]');
    const subState = (note && Array.isArray(note.subtasks)) ? note.subtasks.map((s) => ({ id: s.id || genId(), text: s.text, done: !!s.done })) : [];
    function renderSubs() {
      subsBox.replaceChildren();
      subState.forEach((s, i) => {
        const row = el('div', 'nt-sub-edit');
        const cb = el('button', 'nt-sub-cb' + (s.done ? ' on' : ''));
        if (s.done) cb.appendChild(icon('check', 11));
        cb.onclick = () => { s.done = !s.done; renderSubs(); };
        const inp = el('input', 'nt-sub-input'); inp.value = s.text || ''; inp.placeholder = 'Подзадача…';
        inp.addEventListener('input', () => { s.text = inp.value; });
        const rm = iconBtn('nt-act danger', 'x', 'Убрать', 13); rm.onclick = () => { subState.splice(i, 1); renderSubs(); };
        row.append(cb, inp, rm); subsBox.appendChild(row);
      });
    }
    renderSubs();
    m.querySelector('[data-subadd]').onclick = () => {
      subState.push({ id: genId(), text: '', done: false }); renderSubs();
      const inps = subsBox.querySelectorAll('.nt-sub-input'); if (inps.length) inps[inps.length - 1].focus();
    };
    const commit = () => {
      const text = ta.value.trim();
      const subs = subState.filter((s) => (s.text || '').trim()).map((s) => ({ id: s.id, text: s.text.trim(), done: !!s.done }));
      if (!text && !subs.length) { close(); return; }
      if (isNew) { notes.unshift({ id: genId(), text, status: 'todo', prio: 0, subtasks: subs }); if (filter === 'done') filter = 'active'; }
      else { note.text = text; note.subtasks = subs; }
      save(); close(); renderList();
    };
    m.querySelector('[data-swap]').onclick = () => applyLayoutSwap(ta);
    m.querySelector('[data-cancel]').onclick = () => close();
    m.querySelector('[data-ok]').onclick = commit;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    setTimeout(() => ta.focus(), 0);
  }

  // ---------------- рендер: shell (вкладки/тулбар/чипы) ----------------
  function renderList() {
    const body = $('#notes-body');
    if (!body) return;
    const target = currentTarget();
    const title = $('#notes-proj');
    if (title) title.textContent = tab === 'global' ? 'Общие заметки' : (target ? ('Задачи — ' + target.name) : 'Задачи проекта');

    const c = target ? counts() : { all: 0, done: 0, active: 0 };
    body.innerHTML = `
      <div class="nt-tabs">
        <button class="nt-tab${tab === 'project' ? ' active' : ''}" data-tab="project"><span>Проект</span></button>
        <button class="nt-tab${tab === 'global' ? ' active' : ''}" data-tab="global"><span>Общие</span></button>
      </div>
      <button class="nt-addbig" data-add ${target ? '' : 'disabled'}>＋ Новая задача</button>
      <div class="nt-toolbar">
        <input class="nt-search" data-search placeholder="Поиск задач…" value="${escAttr(query)}">
        <button class="nt-tbtn${view === 'kanban' ? ' on' : ''}" data-view title="Канбан-вид (колонки по статусу)"></button>
        <button class="nt-tbtn${sortMode === 'prio' ? ' on' : ''}" data-sort title="Сортировать по важности"></button>
        <button class="nt-tbtn${mdPreview ? ' on' : ''}" data-md title="Markdown-превью тела задач">MD</button>
        <button class="nt-tbtn danger" data-cleardone title="Удалить все выполненные">⌫</button>
      </div>
      <div class="nt-chips${view === 'kanban' ? ' hidden' : ''}">
        <button class="nt-chip${filter === 'active' ? ' active' : ''}" data-f="active">Активные <span class="nt-cnt">${c.active || ''}</span></button>
        <button class="nt-chip${filter === 'all' ? ' active' : ''}" data-f="all">Все <span class="nt-cnt">${c.all || ''}</span></button>
        <button class="nt-chip${filter === 'done' ? ' active' : ''}" data-f="done">Готово <span class="nt-cnt">${c.done || ''}</span></button>
      </div>
      <div class="nt-list" data-list></div>`;

    // иконки в кнопки тулбара/вкладок (data-icon тут не используем — порядок «иконка перед текстом»)
    body.querySelector('[data-view]').prepend(icon('columns', 15));
    body.querySelector('[data-sort]').prepend(icon('flag', 14));
    const tabIcon = { project: 'folder', global: 'globe' };
    body.querySelectorAll('.nt-tab').forEach((t) => {
      t.prepend(icon(tabIcon[t.dataset.tab], 15));
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    body.querySelectorAll('.nt-chip').forEach((ch) => ch.addEventListener('click', () => { filter = ch.dataset.f; renderList(); }));
    const addBtn = body.querySelector('[data-add]');
    if (addBtn) addBtn.addEventListener('click', () => openTaskModal(null));
    const search = body.querySelector('[data-search]');
    if (search) search.addEventListener('input', () => { query = search.value.trim(); renderBody(); });
    body.querySelector('[data-view]').addEventListener('click', () => setView(view === 'kanban' ? 'list' : 'kanban'));
    body.querySelector('[data-sort]').addEventListener('click', () => setSort(sortMode === 'prio' ? 'manual' : 'prio'));
    body.querySelector('[data-md]').addEventListener('click', () => { mdPreview = !mdPreview; settings.notesMd = mdPreview; saveSettings(); renderList(); });
    const cd = body.querySelector('[data-cleardone]');
    cd.style.display = c.done > 0 ? '' : 'none';
    cd.addEventListener('click', clearDone);

    if (!target) { body.querySelector('[data-list]').appendChild(el('div', 'nt-empty', 'Откройте проект слева, чтобы вести его задачи. Либо переключитесь на вкладку «Общие».')); return; }
    renderBody();
  }

  // ---------------- рендер: тело (список или канбан), с сохранением скролла ----------------
  function listEl() { return $('[data-list]'); }
  function emptyMsg() {
    if (query) return 'Ничего не найдено по запросу.';
    return filter === 'done' ? 'Выполненных задач пока нет.'
      : filter === 'active' ? 'Активных задач нет — добавьте новую кнопкой выше.'
        : 'Пусто — добавьте первую задачу.';
  }
  function renderBody() {
    const list = listEl(); if (!list) return;
    const sc = list.scrollTop;            // сохранить позицию скролла (точечность ощущается без прыжков)
    cardEls.clear();
    list.replaceChildren();
    list.classList.toggle('nt-kanban', view === 'kanban');
    if (view === 'kanban') renderKanban(list); else renderListView(list);
    list.scrollTop = sc;
    requestAnimationFrame(() => list.querySelectorAll('.nt-card').forEach(clampCard));
  }
  function renderListView(list) {
    const rows = visible();
    if (!rows.length) { list.appendChild(el('div', 'nt-empty', emptyMsg())); return; }
    rows.forEach((note) => list.appendChild(buildCard(note, rows)));
  }
  function renderKanban(list) {
    KANBAN_COLS.forEach(([status, label]) => {
      let items = notes.filter((n) => n.status === status && matchesQuery(n));
      if (sortMode === 'prio') items = items.slice().sort((a, b) => b.prio - a.prio); // как в списке: важные выше

      const colWrap = el('div', 'nt-col');
      const head = el('div', 'nt-col-head');
      head.append(el('span', 'nt-col-title', label), el('span', 'nt-col-cnt', String(items.length)));
      colWrap.appendChild(head);
      const colBody = el('div', 'nt-col-body'); colBody.dataset.col = status;
      attachKanbanDrop(colBody, status);
      items.forEach((note) => colBody.appendChild(buildCard(note, items)));
      if (!items.length) colBody.appendChild(el('div', 'nt-col-empty', '—'));
      colWrap.appendChild(colBody);
      list.appendChild(colWrap);
    });
  }

  // Точечное обновление после правки одной задачи: перестроить ТОЛЬКО её карточку (скролл не прыгает),
  // либо убрать, если она выпала из текущего фильтра/поиска. В канбане — перерисовать тело (колонки коротки).
  function afterMutate(note) {
    save(); updateChips();
    // канбан (карточка может сменить колонку) и сортировка по важности (карточка может сменить позицию)
    // требуют перерисовки тела; в ручном списке достаточно перестроить одну карточку (скролл не прыгает).
    if (view === 'kanban' || sortMode === 'prio') { renderBody(); return; }
    const shown = matchesFilter(note) && matchesQuery(note);
    const old = cardEls.get(note.id);
    if (!shown) { if (old) old.remove(); cardEls.delete(note.id); ensureEmptyState(); return; }
    const fresh = buildCard(note, visible());
    if (old) old.replaceWith(fresh); else listEl() && listEl().appendChild(fresh);
    clampCard(fresh);
  }
  function deleteNote(note) {
    const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1);
    const c = cardEls.get(note.id); if (c) c.remove(); cardEls.delete(note.id);
    save(); updateChips(); if (view === 'kanban') renderBody(); else ensureEmptyState();
  }
  function ensureEmptyState() {
    if (view === 'kanban') return;
    const list = listEl(); if (!list) return;
    if (!list.querySelector('.nt-card') && !list.querySelector('.nt-empty')) list.appendChild(el('div', 'nt-empty', emptyMsg()));
  }
  function updateChips() {
    const c = counts();
    const map = { active: c.active, all: c.all, done: c.done };
    document.querySelectorAll('.nt-chip').forEach((ch) => { const cnt = ch.querySelector('.nt-cnt'); if (cnt) cnt.textContent = map[ch.dataset.f] || ''; });
    const cd = $('[data-cleardone]'); if (cd) cd.style.display = c.done > 0 ? '' : 'none';
  }

  // ---------------- карточка задачи ----------------
  function buildCard(note, vis) {
    const card = el('div', 'nt-card st-' + note.status + ' pr-' + note.prio + (note.status === 'done' ? ' done' : ''));
    card.dataset.id = note.id;
    attachDnD(card, note);

    // строка 1: статус + заголовок + (сворачиваемое) тело
    const top = el('div', 'nt-top');
    const stBtn = el('button', 'nt-status st-' + note.status);
    stBtn.title = 'Статус: ' + STATUS_LABEL[note.status] + ' (клик — сменить)';
    if (note.status === 'done') stBtn.appendChild(icon('check', 13));
    stBtn.addEventListener('click', () => { note.status = STATUS[(STATUS.indexOf(note.status) + 1) % 3]; afterMutate(note); });

    const colEl = el('div', 'nt-textcol');
    const titleEl = el('div', 'nt-title', titleOf(note.text) || '(пусто)');
    titleEl.title = 'Двойной клик — редактировать';
    titleEl.addEventListener('dblclick', () => openTaskModal(note));
    colEl.appendChild(titleEl);

    const bt = bodyOf(note.text);
    if (bt) {
      const isExp = expanded.has(note.id);
      const bodyEl = el('div', 'nt-body' + (isExp ? '' : ' clip'));
      if (mdPreview) bodyEl.appendChild(mdToSafeHtml(bt)); else bodyEl.textContent = bt;
      bodyEl.addEventListener('dblclick', () => openTaskModal(note));
      colEl.appendChild(bodyEl);
      const expBtn = el('button', 'nt-expand');
      const sync = () => { expBtn.textContent = bodyEl.classList.contains('clip') ? 'Развернуть ⌄' : 'Свернуть ⌃'; };
      sync(); expBtn.style.display = 'none';
      expBtn.addEventListener('click', () => { const clip = bodyEl.classList.toggle('clip'); if (clip) expanded.delete(note.id); else expanded.add(note.id); sync(); });
      colEl.appendChild(expBtn);
      card._clipBody = bodyEl; card._clipBtn = expBtn;  // для clampCard
    }
    top.append(stBtn, colEl);
    card.appendChild(top);

    // подзадачи (чеклист с прогрессом)
    if (Array.isArray(note.subtasks) && note.subtasks.length) {
      const sub = el('div', 'nt-subs');
      const doneN = note.subtasks.filter((s) => s.done).length;
      sub.appendChild(el('div', 'nt-subs-head', `Подзадачи ${doneN}/${note.subtasks.length}`));
      note.subtasks.forEach((s) => {
        const row = el('div', 'nt-sub' + (s.done ? ' done' : ''));
        const cb = el('button', 'nt-sub-cb' + (s.done ? ' on' : ''));
        if (s.done) cb.appendChild(icon('check', 11));
        cb.addEventListener('click', () => { s.done = !s.done; afterMutate(note); });
        row.append(cb, el('span', 'nt-sub-txt', s.text));
        sub.appendChild(row);
      });
      card.appendChild(sub);
    }

    // строка 2: важность + ↑↓ (ручной список) + копировать + правка + удалить
    const meta = el('div', 'nt-meta');
    const flag = el('button', 'nt-flag pr-' + note.prio);
    flag.appendChild(icon('flag', 13));
    if (note.prio > 0) flag.appendChild(el('span', 'nt-flag-lbl', PRIO_LABEL[note.prio]));
    flag.title = 'Важность: ' + PRIO_LABEL[note.prio] + ' (клик — повысить, ПКМ — понизить)';
    flag.addEventListener('click', () => { note.prio = (note.prio + 1) % 3; afterMutate(note); });
    flag.addEventListener('contextmenu', (e) => { e.preventDefault(); note.prio = (note.prio + 2) % 3; afterMutate(note); });
    meta.append(flag, el('span', 'nt-spacer'));
    if (view === 'list' && sortMode === 'manual' && !query) {
      const vi = vis.indexOf(note);
      const up = iconBtn('nt-act', 'chevron-up', 'Выше', 14); up.disabled = vi <= 0; up.addEventListener('click', () => move(note, -1));
      const down = iconBtn('nt-act', 'chevron-down', 'Ниже', 14); down.disabled = vi >= vis.length - 1; down.addEventListener('click', () => move(note, 1));
      meta.append(up, down);
    }
    const copy = iconBtn('nt-act', 'note', 'Копировать текст', 14); copy.addEventListener('click', () => copyText(note));
    const edit = iconBtn('nt-act', 'pencil', 'Редактировать', 14); edit.addEventListener('click', () => openTaskModal(note));
    const del = iconBtn('nt-act danger', 'trash', 'Удалить задачу', 14);
    del.addEventListener('click', () => showConfirm('Удалить задачу?', 'Удалить совсем (а не пометить выполненной)?', 'Удалить', () => deleteNote(note)));
    meta.append(copy, edit, del);
    card.appendChild(meta);

    // строка 3: в терминал / +удалить / перенос между списками
    const target = currentTarget();
    const acts = el('div', 'nt-acts');
    const send = el('button', 'nt-sendbtn');
    send.append(icon('terminal', 14), el('span', null, 'В терминал'));
    send.title = 'Вставить текст в терминал проекта (без Enter — проверь и отправь сам)';
    send.addEventListener('click', () => sendToTerminal(note, target, false));
    const sendDel = el('button', 'nt-sendbtn');
    sendDel.append(icon('terminal', 14), el('span', null, '+ удалить'));
    sendDel.title = 'Вставить в терминал и удалить задачу из списка';
    sendDel.addEventListener('click', () => sendToTerminal(note, target, true));
    const toGlobal = target && target.kind === 'project';
    const moveBtn = el('button', 'nt-sendbtn nt-move');
    moveBtn.append(icon(toGlobal ? 'globe' : 'folder', 14), el('span', null, toGlobal ? 'В общие' : 'В проект'));
    moveBtn.title = toGlobal ? 'Перенести задачу в общие заметки' : 'Перенести задачу в активный проект';
    moveBtn.addEventListener('click', () => moveToOtherList(note, target));
    acts.append(send, sendDel, moveBtn);
    card.appendChild(acts);

    cardEls.set(note.id, card);
    return card;
  }
  // Показать «Развернуть» только если тело не влезло (меряем в свёрнутом виде, затем возвращаем).
  function clampCard(card) {
    const body = card._clipBody, btn = card._clipBtn; if (!body || !btn) return;
    const wasClip = body.classList.contains('clip');
    body.classList.add('clip');
    const overflow = body.scrollHeight > body.clientHeight + 2;
    if (!wasClip) body.classList.remove('clip');
    btn.style.display = overflow ? '' : 'none';
  }

  // ---------------- DnD ----------------
  function attachDnD(card, note) {
    const canDrag = view === 'kanban' || (view === 'list' && sortMode === 'manual' && !query);
    if (!canDrag) return;
    card.draggable = true;
    card.addEventListener('dragstart', (e) => { dragId = note.id; card.classList.add('nt-dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', note.id); } catch (_) {} });
    card.addEventListener('dragend', () => { dragId = null; card.classList.remove('nt-dragging'); clearDropMarks(); });
    if (view === 'list') {
      card.addEventListener('dragover', (e) => { if (!dragId || dragId === note.id) return; e.preventDefault(); markDrop(card, e.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2); });
      card.addEventListener('dragleave', () => card.classList.remove('nt-drop-before', 'nt-drop-after'));
      card.addEventListener('drop', (e) => { if (!dragId || dragId === note.id) return; e.preventDefault(); const after = e.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2; const src = dragId; clearDropMarks(); reorder(src, note.id, after); });
    }
  }
  function markDrop(card, after) { clearDropMarks(); card.classList.add(after ? 'nt-drop-after' : 'nt-drop-before'); }
  function clearDropMarks() { document.querySelectorAll('.nt-drop-before, .nt-drop-after').forEach((n) => n.classList.remove('nt-drop-before', 'nt-drop-after')); }
  function attachKanbanDrop(colBody, status) {
    colBody.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); colBody.classList.add('nt-col-over'); });
    colBody.addEventListener('dragleave', (e) => { if (!colBody.contains(e.relatedTarget)) colBody.classList.remove('nt-col-over'); });
    colBody.addEventListener('drop', (e) => {
      if (!dragId) return; e.preventDefault(); colBody.classList.remove('nt-col-over');
      const n = notes.find((x) => x.id === dragId);
      if (n && n.status !== status) { n.status = status; save(); updateChips(); }
      renderBody();
    });
  }

  // ---------------- операции списка ----------------
  function clearDone() {
    const n = notes.filter((x) => x.status === 'done').length;
    if (!n) return;
    showConfirm('Очистить выполненные?', `Удалить ${n} выполненн${n === 1 ? 'ую задачу' : 'ых задач'} из списка? Отменить нельзя.`, 'Удалить', () => {
      notes = notes.filter((x) => x.status !== 'done');
      save(); renderList();
    });
  }
  async function copyText(note) {
    try { await navigator.clipboard.writeText(note.text || ''); toast('Скопировано в буфер'); }
    catch (_) { toast('Не удалось скопировать', { kind: 'err' }); }
  }
  function setView(v) {
    if (v === view) return;
    if (v === 'kanban' && !kanbanWidened) { try { lite.win.resizeBy(KANBAN_GROW); } catch (_) {} kanbanWidened = true; }
    else if (v === 'list' && kanbanWidened) { try { lite.win.resizeBy(-KANBAN_GROW); } catch (_) {} kanbanWidened = false; }
    view = v; settings.notesView = v; saveSettings(); renderList();
  }
  function setSort(s) { if (s === sortMode) return; sortMode = s; settings.notesSort = s; saveSettings(); renderList(); }

  // Перенести задачу в другой список (cut): проект↔общие. Пишем в файл назначения, убираем из текущего.
  async function moveToOtherList(note, target) {
    if (!target) return;
    let destId, destName;
    if (target.kind === 'project') { destId = GLOBAL_ID; destName = 'Общие'; }
    else { const p = activeProject(); if (!p) { toast('Нет активного проекта — некуда перенести'); return; } destId = p.id; destName = p.name; }
    let dest = await lite.store.notesGet(destId);
    if (!Array.isArray(dest)) dest = [];
    dest.unshift({ id: note.id, text: note.text, status: note.status, prio: note.prio, subtasks: note.subtasks || [] });
    await lite.store.notesSet(destId, dest);
    broadcastChange(destId);
    const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1);
    save(); renderList();
    toast('Перенесено в «' + destName + '»');
  }

  function sendToTerminal(note, target, alsoDelete) {
    const proj = termProject(target);
    if (!proj) { toast('Нет активного проекта — некуда отправить'); return; }
    if (!note.text) { toast('Задача пустая'); return; }
    sendNoteToTerminal(proj, note.text);
    if (alsoDelete) deleteNote(note);
  }

  // ---------------- экспорт / импорт (JSON) ----------------
  // Единый формат: { _format, version, exportedAt, global?:[…], projects?:{ <id>:{name,path,notes:[…]} } }.
  function exportMenu() {
    const curName = tab === 'global' ? 'общие' : (activeProject() ? activeProject().name : 'проект');
    const { m, close } = makeModal(`
      <h2>Экспорт заметок</h2>
      <div class="nt-exp">
        <button class="btn" data-scope="current">Этот список — ${curName}</button>
        <button class="btn" data-scope="all">Все заметки — все проекты + общие</button>
      </div>
      <div class="modal-actions"><button class="btn" data-cancel>Отмена</button></div>`);
    m.querySelector('[data-scope="current"]').onclick = () => { close(); doExport('current'); };
    m.querySelector('[data-scope="all"]').onclick = () => { close(); doExport('all'); };
    m.querySelector('[data-cancel]').onclick = () => close();
  }

  async function doExport(scope) {
    const out = { _format: 'lite-notes', version: 1, exportedAt: new Date().toISOString() };
    let nameBase;
    if (scope === 'all') {
      out.projects = {};
      for (const p of (getProjects ? getProjects() : [])) {
        const arr = await lite.store.notesGet(p.id);
        if (Array.isArray(arr) && arr.length) out.projects[p.id] = { name: p.name, path: p.path, notes: arr };
      }
      const g = await lite.store.notesGet(GLOBAL_ID);
      out.global = Array.isArray(g) ? g : [];
      nameBase = 'lite-notes-all';
    } else {
      const target = currentTarget();
      if (!target) { toast('Откройте проект или вкладку «Общие»'); return; }
      if (target.kind === 'global') { out.global = notes.slice(); nameBase = 'lite-notes-global'; }
      else { out.projects = { [target.id]: { name: target.name, path: target.proj.path, notes: notes.slice() } }; nameBase = 'lite-notes-' + target.name; }
    }
    const r = await lite.store.notesExport(JSON.stringify(out, null, 2), nameBase);
    if (!r || r.canceled) return;
    if (r.error) { toast('Ошибка экспорта: ' + r.error, { kind: 'err' }); return; }
    toast('Экспортировано в файл');
  }

  // Мердж без потери: дописываем задачи, которых ещё нет (по id), идемпотентно при повторном импорте.
  async function mergeInto(id, incoming) {
    if (!Array.isArray(incoming)) return 0;
    let cur = await lite.store.notesGet(id);
    if (!Array.isArray(cur)) cur = [];
    const seen = new Set(cur.map((n) => n.id));
    let added = 0;
    for (const n of incoming) {
      if (!n || typeof n.text !== 'string') continue;
      const nid = (n.id && !seen.has(n.id)) ? n.id : genId();
      if (seen.has(nid)) continue; // такая задача уже есть → пропускаем (без дублей)
      seen.add(nid);
      cur.push({ id: nid, text: n.text, status: STATUS.includes(n.status) ? n.status : 'todo', prio: typeof n.prio === 'number' ? n.prio : 0, subtasks: Array.isArray(n.subtasks) ? n.subtasks : [] });
      added++;
    }
    if (added) { await lite.store.notesSet(id, cur); broadcastChange(id); }
    return added;
  }

  // Режим «Заменить»: затереть список данными из файла (нормализуем входные задачи).
  function normalizeNotes(incoming) {
    return (Array.isArray(incoming) ? incoming : [])
      .filter((n) => n && typeof n.text === 'string')
      .map((n) => ({ id: n.id || genId(), text: n.text, status: STATUS.includes(n.status) ? n.status : 'todo', prio: typeof n.prio === 'number' ? n.prio : 0, subtasks: Array.isArray(n.subtasks) ? n.subtasks : [] }));
  }
  async function replaceInto(id, incoming) {
    const arr = normalizeNotes(incoming);
    await lite.store.notesSet(id, arr);
    broadcastChange(id);
    return arr.length;
  }

  async function importNotes() {
    const r = await lite.store.notesImport();
    if (!r || r.canceled) return;
    if (r.error) { toast('Ошибка импорта: ' + r.error, { kind: 'err' }); return; }
    let data; try { data = JSON.parse(r.content); } catch { toast('Файл не является JSON', { kind: 'err' }); return; }
    if (!data || data._format !== 'lite-notes') { toast('Это не файл заметок LiteEditor', { kind: 'err' }); return; }
    chooseImportMode(data);
  }

  // Спросить режим: «Заменить» (по умолчанию, разрушительно) или «Добавить» (мердж без потерь).
  function chooseImportMode(data) {
    const hasGlobal = Array.isArray(data.global);
    const projCount = (data.projects && typeof data.projects === 'object') ? Object.keys(data.projects).length : 0;
    const scope = [hasGlobal ? 'общие' : null, projCount ? ('проектов: ' + projCount) : null].filter(Boolean).join(' · ') || 'нет данных';
    const { m, close } = makeModal(`
      <h2>Импорт заметок</h2>
      <div class="nt-modal-hint">В файле: ${scope}.</div>
      <div class="nt-imp-warn">⚠ <b>Заменить</b> (по умолчанию) — затрёт эти списки данными из файла, текущие задачи в них пропадут.<br><b>Добавить</b> — допишет недостающие, ничего не теряя.</div>
      <div class="nt-exp">
        <button class="btn primary" data-mode="replace">Заменить (по умолчанию)</button>
        <button class="btn" data-mode="merge">Добавить к существующим</button>
      </div>
      <div class="modal-actions"><button class="btn" data-cancel>Отмена</button></div>`);
    m.querySelector('[data-mode="replace"]').onclick = () => { close(); applyImport(data, 'replace'); };
    m.querySelector('[data-mode="merge"]').onclick = () => { close(); applyImport(data, 'merge'); };
    m.querySelector('[data-cancel]').onclick = () => close();
    setTimeout(() => m.querySelector('[data-mode="replace"]').focus(), 0); // фокус на дефолтном режиме
  }

  async function applyImport(data, mode) {
    let lists = 0, total = 0;
    const handle = async (id, arr) => {
      if (!Array.isArray(arr)) return;
      lists++;
      total += await (mode === 'replace' ? replaceInto(id, arr) : mergeInto(id, arr));
    };
    if (Array.isArray(data.global)) await handle(GLOBAL_ID, data.global);
    if (data.projects && typeof data.projects === 'object') {
      for (const [pid, entry] of Object.entries(data.projects)) {
        await handle(pid, entry && Array.isArray(entry.notes) ? entry.notes : (Array.isArray(entry) ? entry : null));
      }
    }
    loadedId = null; await renderPanel(); // перечитать текущий список
    if (mode === 'replace') toast(`Заменено списков: ${lists} (${total} задач(и))`);
    else toast(total ? `Добавлено задач: ${total} в ${lists} список(ов)` : 'Новых задач не найдено — всё уже есть');
  }

  // ---------------- вкладки ----------------
  function switchTab(name) {
    if (name === tab) return;
    tab = name;
    settings.notesTab = name; saveSettings(); // запомнить выбор между перезапусками
    loadedId = null;                           // форсировать перезагрузку под новую вкладку
    renderPanel();
  }

  // ---------------- панель / окно ----------------
  async function renderPanel() {
    if (!notesOpen) return;
    const target = currentTarget();
    if (target && target.id !== loadedId) {
      const ok = await load(target.id);
      if (!ok || !notesOpen) return; // устаревшая загрузка / панель закрыли за время await
    } else if (!target) {
      notes = []; loadedId = null;
    }
    renderList();
  }

  function setNotesOpen(open, opts = {}) {
    // Общие задачи доступны всегда; требовать проект только для вкладки «Проект» при открытии.
    if (open && tab === 'project' && !activeProject() && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (open === notesOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('notes'); // правый слот держит один модуль
    const delta = layout.notes + GUTTER;
    notesOpen = open;
    $('#notes-pane').classList.toggle('hidden', !open);
    $('#gutter-notes').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta); // grow:false на restore — ширина уже учтена
    saveUiState();
    if (open) renderPanel();
    else { loadedId = null; }
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleNotes() { setNotesOpen(!notesOpen); }

  return {
    isOpen: () => notesOpen,
    setOpen: setNotesOpen,
    toggle: toggleNotes,
    exportMenu,
    importNotes,
    // вызывается ядром при смене активного проекта; для вкладки «Общие» список не зависит от проекта
    renderPanel: () => renderPanel(),
    // список изменён извне (пульт записал notes/<id>.json) — перечитать, если открыт именно он
    onExternalChange: (id) => { if (notesOpen && id === loadedId) { loadedId = null; renderPanel(); } },
  };
}
