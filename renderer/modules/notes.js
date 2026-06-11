// LiteEditor — модуль «Задачи/заметки» (TODO-модалка карточки проекта + бейдж количества).
// Изолирован по образцу textproc.js: всё из ядра — через host, UI-хелперы — из ui.js.
// Очередь-движок (queues) живёт в ядре — он сцеплен с PTY/индикатором; модулю отдан её API.
// host: { STORE, settings, saveSettings, renderProjects, applyLayoutSwap,
//         getQueue, queueChanged, queueStart, queueStop, queueAdvance, sendNoteToTerminal }
import { el, icon, iconBtn, makeModal, showConfirm } from '../ui.js';

const lite = window.lite;

// Статусы и важность задачи (TODO-модель поверх старых заметок {id,text}).
export function initNotes(host) {
  const { STORE, settings, saveSettings, renderProjects, applyLayoutSwap, getQueue, queueChanged, queueStart, queueStop, queueAdvance, sendNoteToTerminal } = host;

  let noteCounts = STORE.noteCounts || {}; // project id -> number of notes (card badge)
  const TODO_STATUS = ['todo', 'doing', 'done']; // цикл по клику
  const TODO_STATUS_LABEL = { todo: 'К выполнению', doing: 'В работе', done: 'Выполнено' };
  const TODO_PRIO_LABEL = ['Обычная', 'Важная', 'Срочная'];
  async function showNotes(p) {
    let notes = await lite.store.notesGet(p.id);
    if (!Array.isArray(notes)) notes = [];
    // Миграция без потери данных: старым заметкам {id,text} проставляем дефолты status/prio.
    notes.forEach((n) => { if (!TODO_STATUS.includes(n.status)) n.status = 'todo'; if (typeof n.prio !== 'number') n.prio = 0; });
    const q = getQueue(p.id);
    // Порядок отображения: ручной (как в массиве) либо сортировка по важности/статусу.
    // Операции над задачами идут по note (id), а не по индексу показа — сортировка ничего не ломает.
    const sortedView = () => {
      const mode = settings.notesSort || 'manual';
      if (mode === 'manual') return notes.slice();
      const rank = { todo: 0, doing: 1, done: 2 };
      return notes.map((n, idx) => ({ n, idx })).sort((a, b) =>
        mode === 'prio' ? (b.n.prio - a.n.prio) || (a.idx - b.idx)
          : (rank[a.n.status] - rank[b.n.status]) || (b.n.prio - a.n.prio) || (a.idx - b.idx)
      ).map((x) => x.n);
    };
    // Detach the live-update callback on ANY close (button/Esc/backdrop) so the dismissed
    // modal + its listeners don't linger in memory until the next queue event fires.
    const { m, close } = makeModal(`
      <h2>✅ Задачи — <span class="nm-proj"></span></h2>
      <div class="nm-tabs">
        <button class="nm-tab active" data-tab="notes">Задачи</button>
        <button class="nm-tab" data-tab="queue">▶ Очередь<span class="nm-qbadge" id="nm-qbadge"></span></button>
      </div>
      <div class="nm-pane" id="nm-pane-notes">
        <div class="nm-toolbar">
          <label class="nm-sort">Сортировка
            <select id="nm-sort">
              <option value="manual">Вручную</option>
              <option value="prio">По важности</option>
              <option value="status">По статусу</option>
            </select>
          </label>
          <button class="btn nm-add" id="nm-add">＋ Новая задача</button>
        </div>
        <div class="nm-hint">Слева — статус (клик меняет: ☐ к выполнению → ◐ в работе → ☑ готово) и важность (флажок). Задачи не удаляются при отметке «готово» — просто помечаются. «➤» — в терминал, «→» — в авто-очередь.</div>
        <div class="nm-list" id="nm-list"></div>
      </div>
      <div class="nm-pane" id="nm-pane-queue" hidden></div>
      <div class="modal-actions"><button class="btn primary" id="nm-close">Готово</button></div>`,
      () => { q.onChange = null; });
    m.classList.add('notes-modal');
    m.querySelector('.nm-proj').textContent = p.name;
    const list = m.querySelector('#nm-list');
    const qpane = m.querySelector('#nm-pane-queue');
    const updateTabBadge = () => {
      const b = m.querySelector('#nm-qbadge');
      b.textContent = q.items.length ? String(q.items.length) : '';
      b.classList.toggle('show', q.items.length > 0);
    };
    // Persist notes; keep queued snapshots in sync with edits and drop queued items
    // whose underlying note was deleted (queue references notes by id).
    const save = () => {
      lite.store.notesSet(p.id, notes); noteCounts[p.id] = notes.filter((n) => n.status !== 'done').length;
      // Capture the running queue's cursor BY ID before refiltering, so deleting a note
      // mid-run can't shift q.pos onto the wrong item (which would skip a note or make
      // queueOnSettled finish early). doneIds = items already sent (before the cursor).
      const running = q.running && q.pos >= 0 && q.pos < q.items.length;
      const curId = running ? q.items[q.pos].noteId : null;
      const doneIds = running ? new Set(q.items.slice(0, q.pos).map((it) => it.noteId)) : null;
      q.items = q.items
        .filter((it) => notes.some((n) => n.id === it.noteId))
        .map((it) => ({ noteId: it.noteId, text: (notes.find((n) => n.id === it.noteId) || {}).text || '' }));
      if (running) {
        const ci = q.items.findIndex((it) => it.noteId === curId);
        // current survived → its new index; current was deleted → sit just before the first
        // remaining pending item so the next advance dispatches it instead of skipping it.
        q.pos = ci >= 0 ? ci : q.items.filter((it) => doneIds.has(it.noteId)).length - 1;
      }
      updateTabBadge();
      renderProjects();
    };
    let dragFrom = null;
    let editing = null; // { note, ta } — открытый редактор карточки
    // Снять текст из открытого редактора в заметку (для авто-сохранения по «Готово»).
    const flushEdit = () => { if (editing) { editing.note.text = editing.ta.value; editing = null; save(); } };
    // Переставить карточку: свап с соседом (стрелки ▲/▼). flushEdit — не потерять правку при перерисовке.
    const moveNote = (i, dir) => {
      const j = i + dir;
      if (j < 0 || j >= notes.length) return;
      flushEdit();
      [notes[i], notes[j]] = [notes[j], notes[i]];
      save(); render();
    };

    function editNote(row, note) {
      row.innerHTML = '';
      row.classList.add('editing');
      const ta = el('textarea', 'note-edit'); ta.value = note.text || '';
      editing = { note, ta };
      const acts = el('div', 'note-acts');
      const layout = el('button', 'note-btn', '⇄ Раскладка');
      layout.title = 'Сменить раскладку EN⇄РУ по позиции клавиш (или только выделенное)';
      layout.addEventListener('click', () => applyLayoutSwap(ta));
      const ok = el('button', 'note-btn', '✓ Сохранить');
      ok.addEventListener('click', () => { note.text = ta.value; save(); render(); });
      const cancel = el('button', 'note-btn', 'Отмена');
      cancel.addEventListener('click', render);
      acts.append(layout, ok, cancel);
      row.append(ta, acts);
      ta.focus();
    }
    function render() {
      editing = null; // перерисовка закрывает любой открытый редактор
      list.innerHTML = '';
      const manual = (settings.notesSort || 'manual') === 'manual';
      sortedView().forEach((note) => {
        const realIdx = notes.indexOf(note); // индекс в массиве (для ручного порядка/перетаскивания)
        const row = el('div', 'todo-row st-' + note.status + ' pr-' + note.prio + (note.status === 'done' ? ' done' : ''));
        row.dataset.id = note.id;
        if (manual) { row.draggable = true; row.dataset.i = String(realIdx); }
        // статус: клик циклит ☐ к выполнению → ◐ в работе → ☑ готово
        const chk = el('button', 'todo-check st-' + note.status);
        chk.title = 'Статус: ' + TODO_STATUS_LABEL[note.status] + ' (клик — сменить)';
        if (note.status === 'done') chk.appendChild(icon('check', 13));
        chk.addEventListener('click', () => { flushEdit(); note.status = TODO_STATUS[(TODO_STATUS.indexOf(note.status) + 1) % TODO_STATUS.length]; save(); render(); });
        // важность: клик циклит обычная → важная → срочная
        const flag = el('button', 'todo-flag pr-' + note.prio);
        flag.title = 'Важность: ' + TODO_PRIO_LABEL[note.prio] + ' (клик — сменить)';
        flag.appendChild(icon('flag', 13));
        flag.addEventListener('click', () => { flushEdit(); note.prio = (note.prio + 1) % 3; save(); render(); });
        // текст задачи
        const txt = el('div', 'todo-text', note.text || '(пусто)');
        txt.title = 'Двойной клик — редактировать';
        txt.addEventListener('dblclick', () => editNote(row, note));
        // действия — иконки-кнопки в стиле плашек проекта, всегда видимые
        const acts = el('div', 'todo-acts');
        const qi = q.items.findIndex((it) => it.noteId === note.id);
        const queued = qi >= 0;
        const qBtn = iconBtn('todo-act' + (queued ? ' on' : ''), 'arrow-right', '', 14);
        qBtn.disabled = q.running;
        qBtn.title = q.running ? 'Очередь выполняется — состав менять нельзя' : (queued ? `В авто-очереди · ${qi + 1} (клик — убрать)` : 'Добавить в авто-очередь');
        qBtn.addEventListener('click', () => {
          if (q.running) return;
          flushEdit();
          const idx = q.items.findIndex((it) => it.noteId === note.id);
          if (idx >= 0) q.items.splice(idx, 1); else q.items.push({ noteId: note.id, text: note.text || '' });
          queueChanged(q); updateTabBadge(); render();
        });
        const send = iconBtn('todo-act', 'terminal', 'В терминал (без Enter)', 14);
        send.addEventListener('click', () => { flushEdit(); sendNoteToTerminal(p, note.text); close(); });
        const edit = iconBtn('todo-act', 'pencil', 'Редактировать', 14);
        edit.addEventListener('click', () => editNote(row, note));
        const del = iconBtn('todo-act danger', 'trash', 'Удалить задачу', 14);
        del.addEventListener('click', () => { showConfirm('Удалить задачу?', 'Удалить совсем (а не пометить выполненной)?', 'Удалить', () => { const ix = notes.indexOf(note); if (ix >= 0) notes.splice(ix, 1); save(); render(); }); });
        acts.append(qBtn, send, edit, del);
        if (manual) { // перестановка только в ручном режиме (в сортировках индексы показа не равны порядку)
          const up = iconBtn('todo-act', 'chevron-up', 'Выше', 14); up.disabled = realIdx === 0; up.addEventListener('click', () => moveNote(realIdx, -1));
          const down = iconBtn('todo-act', 'chevron-down', 'Ниже', 14); down.disabled = realIdx === notes.length - 1; down.addEventListener('click', () => moveNote(realIdx, +1));
          acts.append(up, down);
        }
        row.append(chk, flag, txt, acts);
        if (manual) {
          row.addEventListener('dragstart', () => { dragFrom = realIdx; row.classList.add('dragging'); });
          row.addEventListener('dragend', () => row.classList.remove('dragging'));
          row.addEventListener('dragover', (e) => e.preventDefault());
          row.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom == null || dragFrom === realIdx) return; const [moved] = notes.splice(dragFrom, 1); notes.splice(realIdx, 0, moved); dragFrom = null; save(); render(); });
        }
        list.appendChild(row);
      });
      if (!notes.length) list.appendChild(el('div', 'nm-empty', 'Пока пусто — добавь задачу кнопкой «＋ Новая задача».'));
    }
    const sortSel = m.querySelector('#nm-sort');
    sortSel.value = settings.notesSort || 'manual';
    sortSel.addEventListener('change', () => { settings.notesSort = sortSel.value; saveSettings(); render(); });
    m.querySelector('#nm-add').addEventListener('click', () => {
      const note = { id: 'n' + Date.now().toString(36), text: '', status: 'todo', prio: 0 };
      notes.push(note); save(); render();
      const row = list.querySelector(`.todo-row[data-id="${note.id}"]`);
      if (row) editNote(row, note);
    });

    // ---- Queue tab ----
    function swapQueue(i, j) {
      if (j < 0 || j >= q.items.length) return;
      [q.items[i], q.items[j]] = [q.items[j], q.items[i]];
      queueChanged(q); renderQueue();
    }
    function renderQueue() {
      qpane.innerHTML = '';
      const bar = el('div', 'q-bar');
      const status = el('div', 'q-status');
      const next = Math.min(q.pos + 2, q.items.length);
      if (!q.items.length) status.textContent = 'Очередь пуста — добавь карточки кнопкой «＋ в очередь».';
      else if (q.armed) { status.textContent = `▶ Агент ждёт — нажми «Дальше» для заметки ${next} из ${q.items.length}`; status.classList.add('armed'); }
      else if (q.running) { status.textContent = `Выполняется ${Math.min(q.pos + 1, q.items.length)} из ${q.items.length} — ждём, пока агент закончит ход…`; status.classList.add('run'); }
      else status.textContent = `${q.items.length} в очереди — нажми «Старт».`;
      bar.appendChild(status);
      const ctrls = el('div', 'q-ctrls');
      if (!q.running) {
        const start = el('button', 'note-btn primary', '▶ Старт'); start.disabled = !q.items.length;
        start.addEventListener('click', () => { queueStart(p.id); renderQueue(); });
        ctrls.appendChild(start);
      } else {
        const adv = el('button', 'note-btn primary' + (q.armed ? ' armed' : ''), '▶ Дальше');
        adv.title = 'Отправить следующую заметку (Ctrl+Shift+Enter)';
        adv.addEventListener('click', () => { queueAdvance(p.id); renderQueue(); });
        const stop = el('button', 'note-btn danger', '⏹ Стоп');
        stop.addEventListener('click', () => { queueStop(p.id); renderQueue(); });
        ctrls.append(adv, stop);
      }
      const clear = el('button', 'note-btn', '🗑 Очистить'); clear.disabled = !q.items.length;
      clear.addEventListener('click', () => { q.items = []; q.running = false; q.pos = -1; q.awaitingBusy = false; q.armed = false; queueChanged(q); updateTabBadge(); renderQueue(); });
      ctrls.appendChild(clear);
      bar.appendChild(ctrls);
      qpane.appendChild(bar);
      qpane.appendChild(el('div', 'nm-hint', 'Первая карточка уходит сразу при старте (с Enter). Следующая — НЕ автоматически: когда агент закончит ход и индикатор станет янтарным, прилетит уведомление, а тут загорится «▶ Дальше» (или Ctrl+Shift+Enter в активном проекте). Так агент успевает задать вопрос, а ты решаешь, слать ли следующую.'));
      const qlist = el('div', 'nm-list');
      q.items.forEach((it, i) => {
        let cls = 'pending';
        if (q.running) { if (i < q.pos) cls = 'done'; else if (i === q.pos) cls = 'current'; }
        const row = el('div', 'q-card q-' + cls);
        const num = el('span', 'q-num', cls === 'done' ? '✓' : cls === 'current' ? '▶' : String(i + 1));
        const txt = el('div', 'q-text', it.text || '(пусто)');
        const acts = el('div', 'note-acts');
        const up = el('button', 'note-btn nudge', '▲'); up.title = 'Выше'; up.disabled = i === 0 || q.running;
        up.addEventListener('click', () => swapQueue(i, i - 1));
        const down = el('button', 'note-btn nudge', '▼'); down.title = 'Ниже'; down.disabled = i === q.items.length - 1 || q.running;
        down.addEventListener('click', () => swapQueue(i, i + 1));
        const rm = el('button', 'note-btn danger', '✕'); rm.title = 'Убрать из очереди'; rm.disabled = q.running;
        rm.addEventListener('click', () => { q.items.splice(i, 1); queueChanged(q); updateTabBadge(); renderQueue(); });
        acts.append(up, down, rm);
        row.append(num, txt, acts);
        qlist.appendChild(row);
      });
      if (!q.items.length) qlist.appendChild(el('div', 'nm-empty', 'Пусто.'));
      qpane.appendChild(qlist);
    }

    // ---- tabs + live sync ----
    const panes = { notes: m.querySelector('#nm-pane-notes'), queue: qpane };
    const tabs = m.querySelectorAll('.nm-tab');
    function setTab(name) {
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      Object.entries(panes).forEach(([k, pane]) => { pane.hidden = k !== name; });
      if (name === 'queue') renderQueue(); else render();
    }
    tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
    // Background auto-advance keeps the open modal live (and detaches itself once closed).
    q.onChange = () => {
      if (!m.isConnected) { q.onChange = null; return; }
      updateTabBadge();
      if (!qpane.hidden) renderQueue();
    };

    m.querySelector('#nm-close').onclick = () => { flushEdit(); close(); }; // close() nulls q.onChange via onClose
    updateTabBadge();
    render();
  }

  return { show: showNotes, count: (id) => noteCounts[id] || 0 };
}
