// LiteEditor — модуль «Задачи»: панель правого слота с двумя вкладками.
//   • «Проект» — задачи активного проекта (notes/<projId>.json), следует за активным проектом, как Git;
//   • «Общие» — задачи вне проектов (notes/__global__.json).
// Последняя выбранная вкладка запоминается в settings.notesTab (переживает перезапуск).
// Изолирован по образцу git.js: всё из ядра — через host, UI-хелперы — из ui.js.
// Модель задачи: { id, text, status:'todo'|'doing'|'done', prio:0|1|2 }.
// host: { STORE, settings, saveSettings, applyLayoutSwap, sendNoteToTerminal,
//         layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels }
import { el, icon, iconBtn, makeModal, showConfirm, toast } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const GLOBAL_ID = '__global__';                    // отдельный файл для «общих» задач
const STATUS = ['todo', 'doing', 'done'];          // цикл по клику
const STATUS_LABEL = { todo: 'К выполнению', doing: 'В работе', done: 'Выполнено' };
const PRIO_LABEL = ['Обычная', 'Важная', 'Срочная'];

export function initNotes(host) {
  const { STORE, settings, saveSettings, applyLayoutSwap, sendNoteToTerminal,
    layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, getProjects } = host;

  let noteCounts = STORE.noteCounts || {};
  let notesOpen = false;
  let tab = (settings.notesTab === 'global') ? 'global' : 'project'; // последняя вкладка
  let filter = 'active';     // 'active' | 'all' | 'done'
  let notes = [];            // загруженный список текущей вкладки
  let loadedId = null;       // id списка, который сейчас в `notes`
  let loadSeq = 0;           // защита от гонки async-загрузки

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
    // Миграция без потери данных: старым заметкам {id,text} проставляем дефолты status/prio.
    arr.forEach((n) => { if (!STATUS.includes(n.status)) n.status = 'todo'; if (typeof n.prio !== 'number') n.prio = 0; });
    notes = arr; loadedId = id;
    return true;
  }
  function save() {
    if (!loadedId) return;
    lite.store.notesSet(loadedId, notes);
    if (loadedId !== GLOBAL_ID) noteCounts[loadedId] = notes.filter((n) => n.status !== 'done').length;
  }
  function counts() {
    const done = notes.filter((n) => n.status === 'done').length;
    return { all: notes.length, done, active: notes.length - done };
  }
  // Видимый срез (фильтр; порядок — ручной = порядок массива). Операции идут по note, не по индексу.
  function visible() {
    if (filter === 'active') return notes.filter((n) => n.status !== 'done');
    if (filter === 'done') return notes.filter((n) => n.status === 'done');
    return notes.slice();
  }
  // Переставить задачу относительно соседа в ВИДИМОМ порядке (свап в массиве).
  function move(note, dir) {
    const vis = visible();
    const sib = vis[vis.indexOf(note) + dir];
    if (!sib) return;
    const a = notes.indexOf(note), b = notes.indexOf(sib);
    if (a < 0 || b < 0) return;
    [notes[a], notes[b]] = [notes[b], notes[a]];
    save(); renderList();
  }

  // ---------------- модалка задачи (новая / правка) ----------------
  function openTaskModal(note) {
    const isNew = !note;
    const { m, close } = makeModal(`
      <h2>${isNew ? 'Новая задача' : 'Редактировать задачу'}</h2>
      <textarea class="nt-modal-ta" placeholder="Описание задачи…"></textarea>
      <div class="nt-modal-hint">Ctrl+Enter — сохранить · Esc — отмена</div>
      <div class="modal-actions">
        <button class="btn nt-modal-swap" data-swap>⇄ Раскладка</button>
        <button class="btn" data-cancel>Отмена</button>
        <button class="btn primary" data-ok>${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>`);
    m.classList.add('nt-modal');
    const ta = m.querySelector('.nt-modal-ta');
    ta.value = note ? (note.text || '') : '';
    const commit = () => {
      const text = ta.value.trim();
      if (!text) { close(); return; }
      if (isNew) { notes.unshift({ id: 'n' + Date.now().toString(36), text, status: 'todo', prio: 0 }); if (filter === 'done') filter = 'active'; }
      else note.text = text;
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

  // ---------------- рендер ----------------
  // Полная перерисовка тела панели: вкладки + кнопка добавления + фильтры + список.
  // (Нет фокус-чувствительных полей в шапке — добавление/правка идут через модалку.)
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
      <div class="nt-chips">
        <button class="nt-chip${filter === 'active' ? ' active' : ''}" data-f="active">Активные <span class="nt-cnt">${c.active || ''}</span></button>
        <button class="nt-chip${filter === 'all' ? ' active' : ''}" data-f="all">Все <span class="nt-cnt">${c.all || ''}</span></button>
        <button class="nt-chip${filter === 'done' ? ' active' : ''}" data-f="done">Готово <span class="nt-cnt">${c.done || ''}</span></button>
      </div>
      <div class="nt-list" data-list></div>`;

    // Однотипные иконки вкладок из общего набора (folder / globe) — без эмодзи-разнобоя.
    const tabIcon = { project: 'folder', global: 'globe' };
    body.querySelectorAll('.nt-tab').forEach((t) => {
      t.prepend(icon(tabIcon[t.dataset.tab], 15));
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    body.querySelectorAll('.nt-chip').forEach((ch) => ch.addEventListener('click', () => { filter = ch.dataset.f; renderList(); }));
    const addBtn = body.querySelector('[data-add]');
    if (addBtn) addBtn.addEventListener('click', () => openTaskModal(null));

    const list = body.querySelector('[data-list]');
    if (!target) { list.appendChild(el('div', 'nt-empty', 'Откройте проект слева, чтобы вести его задачи. Либо переключитесь на вкладку «Общие».')); return; }
    const rows = visible();
    rows.forEach((note) => list.appendChild(noteCard(note, target, rows)));
    if (!rows.length) {
      const msg = filter === 'done' ? 'Выполненных задач пока нет.'
        : filter === 'active' ? 'Активных задач нет — добавьте новую кнопкой выше.'
          : 'Пусто — добавьте первую задачу.';
      list.appendChild(el('div', 'nt-empty', msg));
    }
  }

  // Карточка: строка 1 — статус + текст; строка 2 — важность + ↑↓ + правка + удалить;
  // строка 3 — «В терминал» / «В терминал и удалить».
  function noteCard(note, target, vis) {
    const card = el('div', 'nt-card st-' + note.status + ' pr-' + note.prio + (note.status === 'done' ? ' done' : ''));

    const top = el('div', 'nt-top');
    const st = el('button', 'nt-status st-' + note.status);
    st.title = 'Статус: ' + STATUS_LABEL[note.status] + ' (клик — сменить)';
    if (note.status === 'done') st.appendChild(icon('check', 13));
    st.addEventListener('click', () => { note.status = STATUS[(STATUS.indexOf(note.status) + 1) % 3]; save(); renderList(); });
    const txt = el('div', 'nt-text', note.text || '(пусто)');
    txt.title = 'Двойной клик — редактировать';
    txt.addEventListener('dblclick', () => openTaskModal(note));
    top.append(st, txt);

    const meta = el('div', 'nt-meta');
    const flag = el('button', 'nt-flag pr-' + note.prio);
    flag.appendChild(icon('flag', 13));
    if (note.prio > 0) flag.appendChild(el('span', 'nt-flag-lbl', PRIO_LABEL[note.prio]));
    flag.title = 'Важность: ' + PRIO_LABEL[note.prio] + ' (клик — сменить)';
    flag.addEventListener('click', () => { note.prio = (note.prio + 1) % 3; save(); renderList(); });
    const vi = vis.indexOf(note);
    const up = iconBtn('nt-act', 'chevron-up', 'Выше', 14); up.disabled = vi <= 0; up.addEventListener('click', () => move(note, -1));
    const down = iconBtn('nt-act', 'chevron-down', 'Ниже', 14); down.disabled = vi >= vis.length - 1; down.addEventListener('click', () => move(note, 1));
    const edit = iconBtn('nt-act', 'pencil', 'Редактировать', 14); edit.addEventListener('click', () => openTaskModal(note));
    const del = iconBtn('nt-act danger', 'trash', 'Удалить задачу', 14);
    del.addEventListener('click', () => showConfirm('Удалить задачу?', 'Удалить совсем (а не пометить выполненной)?', 'Удалить', () => {
      const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1); save(); renderList();
    }));
    meta.append(flag, el('span', 'nt-spacer'), up, down, edit, del);

    const acts = el('div', 'nt-acts');
    const send = el('button', 'nt-sendbtn');
    send.append(icon('terminal', 14), el('span', null, 'В терминал'));
    send.title = 'Вставить текст в терминал проекта (без Enter — проверь и отправь сам)';
    send.addEventListener('click', () => sendToTerminal(note, target, false));
    const sendDel = el('button', 'nt-sendbtn');
    sendDel.append(icon('terminal', 14), el('span', null, 'В терминал и удалить'));
    sendDel.title = 'Вставить в терминал и удалить задачу из списка';
    sendDel.addEventListener('click', () => sendToTerminal(note, target, true));
    // Перенос между списками: из проекта → в общие, из общих → в активный проект.
    const toGlobal = target.kind === 'project';
    const moveBtn = el('button', 'nt-sendbtn nt-move');
    moveBtn.append(icon(toGlobal ? 'globe' : 'folder', 14), el('span', null, toGlobal ? 'В общие' : 'В проект'));
    moveBtn.title = toGlobal ? 'Перенести задачу в общие заметки' : 'Перенести задачу в активный проект';
    moveBtn.addEventListener('click', () => moveToOtherList(note, target));
    acts.append(send, sendDel, moveBtn);

    card.append(top, meta, acts);
    return card;
  }

  // Перенести задачу в другой список (cut): проект↔общие. Пишем в файл назначения, убираем из текущего.
  async function moveToOtherList(note, target) {
    let destId, destName;
    if (target.kind === 'project') { destId = GLOBAL_ID; destName = 'Общие'; }
    else { const p = activeProject(); if (!p) { toast('Нет активного проекта — некуда перенести'); return; } destId = p.id; destName = p.name; }
    let dest = await lite.store.notesGet(destId);
    if (!Array.isArray(dest)) dest = [];
    dest.unshift({ id: note.id, text: note.text, status: note.status, prio: note.prio });
    await lite.store.notesSet(destId, dest);
    if (destId !== GLOBAL_ID) noteCounts[destId] = dest.filter((n) => n.status !== 'done').length;
    const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1); // убрать из исходного списка
    save(); renderList();
    toast('Перенесено в «' + destName + '»');
  }

  function sendToTerminal(note, target, alsoDelete) {
    const proj = termProject(target);
    if (!proj) { toast('Нет активного проекта — некуда отправить'); return; }
    if (!note.text) { toast('Задача пустая'); return; }
    sendNoteToTerminal(proj, note.text);
    if (alsoDelete) { const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1); save(); renderList(); }
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
      const nid = (n.id && !seen.has(n.id)) ? n.id : ('n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      if (seen.has(nid)) continue; // такая задача уже есть → пропускаем (без дублей)
      seen.add(nid);
      cur.push({ id: nid, text: n.text, status: STATUS.includes(n.status) ? n.status : 'todo', prio: typeof n.prio === 'number' ? n.prio : 0 });
      added++;
    }
    if (added) { await lite.store.notesSet(id, cur); if (id !== GLOBAL_ID) noteCounts[id] = cur.filter((x) => x.status !== 'done').length; }
    return added;
  }

  // Режим «Заменить»: затереть список данными из файла (нормализуем входные задачи).
  function normalizeNotes(incoming) {
    return (Array.isArray(incoming) ? incoming : [])
      .filter((n) => n && typeof n.text === 'string')
      .map((n) => ({ id: n.id || ('n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), text: n.text, status: STATUS.includes(n.status) ? n.status : 'todo', prio: typeof n.prio === 'number' ? n.prio : 0 }));
  }
  async function replaceInto(id, incoming) {
    const arr = normalizeNotes(incoming);
    await lite.store.notesSet(id, arr);
    if (id !== GLOBAL_ID) noteCounts[id] = arr.filter((x) => x.status !== 'done').length;
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

  // ---------------- панель правого слота ----------------
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
