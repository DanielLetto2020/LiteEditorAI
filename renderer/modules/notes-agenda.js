// LiteEditor — под-модуль «Календарь» (дата-задачи / напоминания) для окна «Задачи».
// Главная ось — ВРЕМЯ, а не статус: быстрая запись, повторения, Snooze, лента + сетка месяца
// с перетаскиванием и отображением задач со сроком из списка задач.
// Данные напоминаний: ~/.LiteEditorAI/agenda/<projId>.json (или __global__).
import { el, icon, iconBtn, makeModal, showConfirm, toast, guardDirtyClose } from '../ui.js';
import { t } from '../i18n.js';
import {
  GLOBAL_ID, REPEAT_ORDER, REPEAT_LABEL, computeNextRepeat, computeSnooze,
  titleOf, bodyOf, startOfDay, dayKey, toLocalDateTimeInput, toLocalDateInput, formatDueShort, tagColorIndex,
} from './notes-model.js';

const lite = window.lite;

const REMIND_LABEL = { '': 'Без напоминания', at: 'В момент срока', '10m': 'За 10 минут', '1h': 'За час', '1d': 'За день' };
const REMIND_ORDER = ['', 'at', '10m', '1h', '1d'];

const BUCKETS = [
  ['overdue', 'Просрочено'],
  ['today', 'Сегодня'],
  ['tomorrow', 'Завтра'],
  ['week', 'На неделе'],
  ['later', 'Позже'],
  ['nodate', 'Без даты'],
];

const genId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function bucketOf(item, now) {
  if (item.done) return 'done';
  if (!item.at) return 'nodate';
  const at = new Date(item.at);
  if (isNaN(at.getTime())) return 'nodate';
  const dayDiff = Math.round((startOfDay(at).getTime() - startOfDay(now).getTime()) / 86400000);
  if (item.allDay) {
    if (dayDiff < 0) return 'overdue';
  } else if (at.getTime() < now.getTime()) {
    return 'overdue';
  }
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff <= 7) return 'week';
  return 'later';
}

function absLabel(item) {
  if (!item.at) return '';
  const at = new Date(item.at);
  if (isNaN(at.getTime())) return '';
  return formatDueShort(item.at, item.allDay, new Date(), t);
}

function relLabel(item, now) {
  if (!item.at) return '';
  const at = new Date(item.at);
  if (isNaN(at.getTime())) return '';
  const ms = at.getTime() - now.getTime();
  const abs = Math.abs(ms);
  let core;
  if (abs < 60000) core = t('меньше минуты');
  else if (abs < 3600000) core = t('{0} мин', Math.round(abs / 60000));
  else if (abs < 86400000) core = t('{0} ч', Math.round(abs / 3600000));
  else core = t('{0} дн', Math.round(abs / 86400000));
  return ms >= 0 ? t('через {0}', core) : t('{0} назад', core);
}

function normalize(r) {
  return {
    id: r.id || genId(),
    text: typeof r.text === 'string' ? r.text : '',
    at: (r.at && !isNaN(new Date(r.at).getTime())) ? new Date(r.at).toISOString() : null,
    allDay: !!r.allDay,
    remind: REMIND_ORDER.includes(r.remind) && r.remind ? r.remind : null,
    repeat: REPEAT_ORDER.includes(r.repeat) && r.repeat ? r.repeat : null,
    done: !!r.done,
    tag: typeof r.tag === 'string' ? r.tag : '',
    notifiedAt: r.notifiedAt || null,
    createdAt: r.createdAt || new Date().toISOString(),
  };
}

// host: { activeProject, sendNoteToTerminal, applyLayoutSwap, settings, saveSettings, getDueTasks, toggleDueTask, openDueTask }
export function createAgendaView(host) {
  const { activeProject, sendNoteToTerminal, applyLayoutSwap, settings, saveSettings, getDueTasks, toggleDueTask, openDueTask } = host;

  let container = null;
  let items = [];
  let dueTasks = [];
  let loadedId = null;
  let dueLoadedId = null;
  let loadSeq = 0;
  let query = '';
  let showDone = false;
  let srcFilter = 'all'; // 'all' | 'reminders' | 'tasks'
  let subView = (settings && settings.agendaView === 'month') ? 'month' : 'agenda';
  let monthCursor = null;
  let selectedDay = null;
  let dragAgendaId = null;
  let lastSavedJson = null;

  function target() {
    const p = activeProject && activeProject();
    return p ? { id: p.id, name: p.name, proj: p, kind: 'project' } : { id: GLOBAL_ID, name: 'Личные', kind: 'global' };
  }

  let blockedId = null;
  const readErr = (v) => (v && !Array.isArray(v) && typeof v === 'object' && v.error ? String(v.error) : null);
  const blockedToast = (err) => toast(t('Не прочитать напоминания: {0} — список не изменится, пока файл не прочитается', err || '?'), { kind: 'err', ttl: 9000 });

  async function refreshDueTasks(id) {
    if (!getDueTasks) { dueTasks = []; dueLoadedId = id; return; }
    try {
      const list = await getDueTasks(id);
      if (target().id === id) {
        dueTasks = Array.isArray(list) ? list : [];
        dueLoadedId = id;
      }
    } catch (_) {
      dueTasks = [];
    }
  }

  async function load(id) {
    const seq = ++loadSeq;
    const [arr] = await Promise.all([
      lite.store.agendaGet(id),
      refreshDueTasks(id),
    ]);
    if (seq !== loadSeq) return false;
    const err = readErr(arr);
    if (err) { items = []; loadedId = null; blockedId = id; blockedToast(err); return true; }
    blockedId = null;
    items = (Array.isArray(arr) ? arr : []).filter((r) => r && typeof r === 'object').map(normalize);
    loadedId = id;
    return true;
  }

  function save() {
    const id = loadedId || target().id;
    if (id === blockedId) { blockedToast(); return false; }
    loadedId = id;
    lastSavedJson = JSON.stringify(items);
    lite.store.agendaSet(id, items);
    try { lite.app.agendaChanged(id); } catch (_) {}
    return true;
  }

  const matchesQuery = (r) => !query || (r.text || '').toLowerCase().includes(query.toLowerCase());

  // ---------------- модалка (новое/правка) ----------------
  function openModal(item, prefillDayKey) {
    const isNew = !item;
    const listId = loadedId;
    const { overlay, m, close } = makeModal(`
      <h2>${isNew ? 'Новое напоминание' : 'Редактировать'}</h2>
      <textarea class="nt-modal-ta ag-modal-ta" placeholder="Что не забыть… Первая строка — заголовок."></textarea>
      <div class="ag-modal-grid">
        <label class="ag-fld"><span>Дата и время</span><input type="datetime-local" data-at></label>
        <label class="ag-fld ag-fld-chk"><input type="checkbox" data-allday><span>Весь день</span></label>
        <label class="ag-fld"><span>Напоминание</span><select data-remind></select></label>
        <label class="ag-fld"><span>Повторение</span><select data-repeat></select></label>
      </div>
      <div class="nt-modal-hint">Ctrl+Enter — сохранить · Esc — отмена · дату можно оставить пустой</div>
      <div class="modal-actions">
        <button class="btn nt-modal-swap" data-swap>⇄ Раскладка</button>
        <button class="btn" data-cancel>Отмена</button>
        <button class="btn primary" data-ok>${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>`);
    m.classList.add('nt-modal', 'ag-modal');
    const ta = m.querySelector('.ag-modal-ta');
    const atIn = m.querySelector('[data-at]');
    const allDayIn = m.querySelector('[data-allday]');
    const remindSel = m.querySelector('[data-remind]');
    const repeatSel = m.querySelector('[data-repeat]');

    REMIND_ORDER.forEach((k) => { const o = el('option', null, REMIND_LABEL[k]); o.value = k; remindSel.appendChild(o); });
    REPEAT_ORDER.forEach((k) => { const o = el('option', null, REPEAT_LABEL[k]); o.value = k; repeatSel.appendChild(o); });

    ta.value = item ? (item.text || '') : '';
    allDayIn.checked = item ? !!item.allDay : false;
    const syncAllDay = () => { atIn.type = allDayIn.checked ? 'date' : 'datetime-local'; };
    syncAllDay();
    if (item && item.at) {
      const d = new Date(item.at);
      atIn.value = allDayIn.checked ? toLocalDateInput(d) : toLocalDateTimeInput(d);
    } else if (isNew && prefillDayKey) {
      atIn.value = prefillDayKey + 'T09:00';
    }
    remindSel.value = item && item.remind ? item.remind : '';
    repeatSel.value = item && item.repeat ? item.repeat : '';

    allDayIn.addEventListener('change', () => {
      const cur = atIn.value;
      syncAllDay();
      if (cur && allDayIn.checked) atIn.value = cur.slice(0, 10);
      else if (cur && !allDayIn.checked && cur.length === 10) atIn.value = cur + 'T09:00';
    });

    const snap = () => JSON.stringify([ta.value, atIn.value, allDayIn.checked, remindSel.value, repeatSel.value]);
    const initial = snap();
    guardDirtyClose(overlay, m, () => snap() !== initial, () => showConfirm('Закрыть без сохранения?', 'Набранное напоминание пропадёт.', 'Закрыть', close));

    let committing = false;
    const commit = async () => {
      if (committing) return;
      const text = ta.value.trim();
      if (!text) { close(); return; }
      let at = null;
      let allDay = !!allDayIn.checked;
      if (atIn.value) {
        const d = allDay ? new Date(atIn.value + 'T00:00') : new Date(atIn.value);
        if (!isNaN(d.getTime())) at = d.toISOString();
      } else {
        allDay = false;
      }
      const remind = remindSel.value || null;
      const repeat = repeatSel.value || null;
      const apply = (arr) => {
        if (isNew) { arr.unshift(normalize({ text, at, allDay, remind, repeat, done: false })); return; }
        let cur = arr.find((r) => r.id === item.id);
        if (!cur) { cur = normalize(item); arr.unshift(cur); }
        cur.text = text;
        cur.at = at;
        cur.allDay = allDay;
        cur.remind = remind;
        cur.repeat = repeat;
        cur.notifiedAt = null;
      };
      if (!listId && target().id === blockedId) { blockedToast(); return; }
      if (!listId || loadedId === listId) { apply(items); save(); }
      else {
        committing = true;
        try {
          let arr = await lite.store.agendaGet(listId);
          if (readErr(arr)) { blockedToast(readErr(arr)); return; }
          arr = Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object').map(normalize) : [];
          apply(arr);
          await lite.store.agendaSet(listId, arr);
          try { lite.app.agendaChanged(listId); } catch (_) {}
        } finally { committing = false; }
      }
      close();
      paint();
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

  // ---------------- быстрый ввод ----------------
  function quickAdd(bar) {
    const text = bar.querySelector('[data-qtext]').value.trim();
    const atVal = bar.querySelector('[data-qdate]').value;
    const remind = bar.querySelector('[data-qremind]').value || null;
    const repeat = bar.querySelector('[data-qrepeat]').value || null;
    if (!text) { toast('Введите текст'); return; }
    if ((loadedId || target().id) === blockedId) { blockedToast(); return; }
    let at = null;
    if (atVal) { const d = new Date(atVal); if (!isNaN(d.getTime())) at = d.toISOString(); }
    items.unshift(normalize({ text, at, allDay: false, remind, repeat, done: false }));
    bar.querySelector('[data-qtext]').value = '';
    bar.querySelector('[data-qdate]').value = '';
    bar.querySelector('[data-qremind]').value = '';
    bar.querySelector('[data-qrepeat]').value = '';
    save();
    paint();
  }

  function toggleReminderDone(item) {
    const wasDone = !!item.done;
    item.done = !wasDone;
    if (item.done) item.notifiedAt = new Date().toISOString();
    let nextAt = null;
    if (!wasDone && item.repeat && item.at) {
      nextAt = computeNextRepeat(item.at, item.repeat, item.allDay, new Date());
      if (nextAt) {
        items.unshift(normalize({
          text: item.text,
          at: nextAt,
          allDay: item.allDay,
          remind: item.remind,
          repeat: item.repeat,
          done: false,
          tag: item.tag,
        }));
      }
    }
    save();
    paint();
    if (nextAt) toast(t('Повтор перенесён на {0}', formatDueShort(nextAt, item.allDay, new Date(), t)));
  }

  function snoozeReminder(item, kind) {
    const res = computeSnooze(kind, new Date());
    if (!res) return;
    item.at = res.at;
    item.allDay = res.allDay;
    item.notifiedAt = null;
    save();
    paint();
    toast(t('Отложено: {0}', formatDueShort(item.at, item.allDay, new Date(), t)));
  }

  // ---------------- карточка напоминания ----------------
  function buildReminderCard(item, now, { draggable = false } = {}) {
    const bucket = bucketOf(item, now);
    const card = el('div', 'ag-card bk-' + bucket + (item.done ? ' done' : ''));
    card.dataset.id = item.id;
    if (draggable) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        dragAgendaId = item.id;
        card.classList.add('nt-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); } catch (_) {}
      });
      card.addEventListener('dragend', () => {
        dragAgendaId = null;
        card.classList.remove('nt-dragging');
        container && container.querySelectorAll('.ag-day-over').forEach((c) => c.classList.remove('ag-day-over'));
      });
    }

    const doneBtn = el('button', 'ag-check' + (item.done ? ' on' : ''));
    doneBtn.title = item.done ? 'Снять отметку' : 'Отметить выполненным';
    if (item.done) doneBtn.appendChild(icon('check', 12));
    doneBtn.addEventListener('click', () => toggleReminderDone(item));

    const col = el('div', 'ag-textcol');
    const titleEl = el('div', 'ag-title', titleOf(item.text) || t('(без названия)'));
    titleEl.setAttribute('data-no-i18n', '');
    titleEl.addEventListener('dblclick', () => openModal(item));
    col.appendChild(titleEl);

    const bt = bodyOf(item.text);
    if (bt) {
      const bEl = el('div', 'ag-body', bt);
      bEl.setAttribute('data-no-i18n', '');
      col.appendChild(bEl);
    }

    if (item.at || item.remind || item.repeat) {
      const when = el('div', 'ag-when');
      if (item.at) {
        when.appendChild(el('span', 'ag-abs', absLabel(item)));
        when.appendChild(el('span', 'ag-rel', relLabel(item, now)));
      }
      if (item.remind) {
        const b = el('span', 'ag-remind');
        b.append(icon('clock', 11), el('span', null, REMIND_LABEL[item.remind]));
        when.appendChild(b);
      }
      if (item.repeat) {
        const rp = el('span', 'ag-repeat');
        rp.append(icon('refresh', 11), el('span', null, REPEAT_LABEL[item.repeat]));
        when.appendChild(rp);
      }
      col.appendChild(when);
    }

    if (!item.done && (bucket === 'overdue' || bucket === 'today')) {
      const snooze = el('div', 'ag-snooze');
      const mkSn = (label, kind) => {
        const b = el('button', 'ag-sn-btn', label);
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); snoozeReminder(item, kind); });
        return b;
      };
      snooze.append(mkSn('+15м', '15m'), mkSn('+1ч', '1h'), mkSn('Завтра', 'tomorrow'));
      col.appendChild(snooze);
    }

    const acts = el('div', 'ag-acts');
    const send = iconBtn('ag-act', 'terminal', 'В терминал проекта', 14);
    send.addEventListener('click', () => {
      const p = (target().kind === 'project') ? target().proj : (activeProject && activeProject());
      if (!p) { toast('Нет активного проекта'); return; }
      sendNoteToTerminal(p, item.text);
    });
    const edit = iconBtn('ag-act', 'pencil', 'Редактировать', 14);
    edit.addEventListener('click', () => openModal(item));
    const del = iconBtn('ag-act danger', 'trash', 'Удалить', 14);
    del.addEventListener('click', () => showConfirm('Удалить напоминание?', 'Удалить совсем?', 'Удалить', () => {
      const ix = items.indexOf(item);
      if (ix >= 0) items.splice(ix, 1);
      save();
      paint();
    }));
    acts.append(send, edit, del);

    card.append(doneBtn, col, acts);
    return card;
  }

  // ---------------- карточка задачи со сроком ----------------
  function buildDueTaskCard(task, targetId, now) {
    const done = task.status === 'done';
    const fakeItem = { at: task.dueAt, allDay: task.allDay, done };
    const bucket = bucketOf(fakeItem, now);
    const card = el('div', 'ag-card ag-card-task bk-' + bucket + (done ? ' done' : ''));
    card.dataset.taskId = task.id;

    const doneBtn = el('button', 'nt-stbtn st-' + task.status);
    doneBtn.title = done ? 'Вернуть в работу' : 'Отметить выполненной';
    if (done) doneBtn.appendChild(icon('check', 12));
    doneBtn.addEventListener('click', async () => {
      if (!toggleDueTask) return;
      await toggleDueTask(targetId, task.id);
      await refreshDueTasks(targetId);
      paint();
    });

    const col = el('div', 'ag-textcol');
    const titleRow = el('div', 'ag-task-head');
    titleRow.appendChild(el('span', 'ag-task-badge', 'Задача'));
    const titleEl = el('div', 'ag-title', titleOf(task.text) || t('(пусто)'));
    titleEl.setAttribute('data-no-i18n', '');
    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('click', () => openDueTask && openDueTask(targetId, task.id));
    titleRow.appendChild(titleEl);
    col.appendChild(titleRow);

    const when = el('div', 'ag-when');
    when.appendChild(el('span', 'ag-abs', formatDueShort(task.dueAt, task.allDay, now, t)));
    when.appendChild(el('span', 'ag-rel', relLabel(fakeItem, now)));
    if (Array.isArray(task.tags)) {
      for (const tg of task.tags.slice(0, 3)) {
        const chip = el('span', `nt-tag nt-tag-c${tagColorIndex(tg)}`, '#' + tg);
        chip.setAttribute('data-no-i18n', '');
        when.appendChild(chip);
      }
    }
    col.appendChild(when);

    const acts = el('div', 'ag-acts');
    const openBtn = iconBtn('ag-act', 'arrow-right', 'Открыть в задачах', 14);
    openBtn.addEventListener('click', () => openDueTask && openDueTask(targetId, task.id));
    const send = iconBtn('ag-act', 'terminal', 'В терминал проекта', 14);
    send.addEventListener('click', () => {
      const p = (target().kind === 'project') ? target().proj : (activeProject && activeProject());
      if (!p) { toast('Нет активного проекта'); return; }
      sendNoteToTerminal(p, task.text);
    });
    acts.append(openBtn, send);

    card.append(doneBtn, col, acts);
    return card;
  }

  // ---------------- рендер шапки + тела ----------------
  function paint() {
    if (!container) return;
    const now = new Date();
    const tgt = target();

    const prevQ = container.querySelector('[data-qtext]');
    const prevD = container.querySelector('[data-qdate]');
    const prevR = container.querySelector('[data-qremind]');
    const prevRp = container.querySelector('[data-qrepeat]');
    const keep = prevQ ? {
      text: prevQ.value,
      date: prevD ? prevD.value : '',
      remind: prevR ? prevR.value : '',
      repeat: prevRp ? prevRp.value : '',
      focus: document.activeElement === prevQ,
    } : null;

    container.replaceChildren();

    // быстрый ввод
    const bar = el('div', 'ag-quick');
    const qtext = el('input', 'ag-qtext');
    qtext.dataset.qtext = '1';
    qtext.placeholder = tgt.kind === 'global'
      ? 'Личное напоминание… (Enter — добавить)'
      : 'Быстрая запись… (Enter — добавить)';

    const qdate = el('input', 'ag-qdate');
    qdate.type = 'datetime-local';
    qdate.dataset.qdate = '1';
    qdate.title = 'Дата и время (необязательно)';

    const qremind = el('select', 'ag-qremind');
    qremind.dataset.qremind = '1';
    qremind.title = 'Напоминание';
    REMIND_ORDER.forEach((k) => {
      const o = el('option', null, k === '' ? 'Без уведомления' : REMIND_LABEL[k]);
      o.value = k;
      qremind.appendChild(o);
    });

    const qrepeat = el('select', 'ag-qrepeat');
    qrepeat.dataset.qrepeat = '1';
    qrepeat.title = 'Повторение';
    REPEAT_ORDER.forEach((k) => {
      const o = el('option', null, k === '' ? 'Разово' : REPEAT_LABEL[k]);
      o.value = k;
      qrepeat.appendChild(o);
    });

    const qadd = el('button', 'ag-qadd');
    qadd.appendChild(icon('plus', 16));
    qadd.title = 'Добавить напоминание';
    qtext.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(bar); } });
    qadd.addEventListener('click', () => quickAdd(bar));
    bar.append(qtext, qdate, qremind, qrepeat, qadd);
    if (keep) {
      qtext.value = keep.text;
      qdate.value = keep.date;
      qremind.value = keep.remind;
      qrepeat.value = keep.repeat;
    }

    // чипы быстрой даты
    const chips = el('div', 'ag-chips');
    const setDate = (d) => { qdate.value = d ? toLocalDateTimeInput(d) : ''; qtext.focus(); };
    const mk = (label, fn) => { const b = el('button', 'nt-chip', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const at9 = (days) => { const d = startOfDay(now); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d; };
    chips.append(
      mk('Сегодня', () => setDate(at9(0))),
      mk('Завтра', () => setDate(at9(1))),
      mk('+ неделя', () => setDate(at9(7))),
      mk('Убрать дату', () => setDate(null)),
    );

    // тулбар: вид (Лента|Месяц) + источник (Всё|Напоминания|Задачи) + поиск + выполненные + агент
    const tools = el('div', 'ag-toolbar');

    const viewSeg = el('div', 'nt-seg sm');
    const mkViewBtn = (mode, label) => {
      const b = el('button', 'nt-seg-btn' + (subView === mode ? ' on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (subView === mode) return;
        subView = mode;
        if (settings) { settings.agendaView = subView; saveSettings && saveSettings(); }
        selectedDay = null;
        paint();
      });
      return b;
    };
    viewSeg.append(mkViewBtn('agenda', 'Лента'), mkViewBtn('month', 'Месяц'));

    const srcSeg = el('div', 'nt-seg sm');
    const mkSrcBtn = (mode, label) => {
      const b = el('button', 'nt-seg-btn' + (srcFilter === mode ? ' on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { srcFilter = mode; paint(); });
      return b;
    };
    srcSeg.append(mkSrcBtn('all', 'Всё'), mkSrcBtn('reminders', 'Напоминания'), mkSrcBtn('tasks', 'Задачи'));

    const search = el('input', 'ag-search');
    search.placeholder = 'Поиск…';
    search.value = query;
    search.addEventListener('input', () => { query = search.value.trim(); repaintList(); });

    const doneToggle = el('button', 'ag-tbtn' + (showDone ? ' on' : ''));
    doneToggle.append(icon('check', 14), el('span', null, 'Готово'));
    doneToggle.title = 'Показывать выполненные';
    doneToggle.addEventListener('click', () => { showDone = !showDone; paint(); });

    const agentBtn = el('button', 'ag-tbtn');
    agentBtn.append(icon('terminal', 14), el('span', null, 'Агент'));
    agentBtn.title = 'Дать агенту в терминале доступ к напоминаниям (MCP)';
    agentBtn.addEventListener('click', openAgentModal);

    tools.append(viewSeg, srcSeg, search, doneToggle, agentBtn);

    const listWrap = el('div', 'ag-list' + (subView === 'month' ? ' ag-monthwrap' : ''));
    listWrap.dataset.list = '1';

    container.append(bar, chips, tools, listWrap);
    if (subView === 'month') renderMonth(listWrap, now);
    else renderList(listWrap, now);

    if (keep && keep.focus) { try { qtext.focus(); } catch (_) {} }
  }

  function repaintList() {
    const list = container && container.querySelector('[data-list]');
    if (!list) return;
    if (subView === 'month') renderMonth(list, new Date());
    else renderList(list, new Date());
  }

  function combinedEntries() {
    const tgt = target();
    const out = [];
    if (srcFilter !== 'tasks') {
      for (const r of items) {
        if (!matchesQuery(r)) continue;
        out.push({ kind: 'reminder', item: r, at: r.at, allDay: r.allDay, done: r.done });
      }
    }
    if (srcFilter !== 'reminders') {
      for (const tk of dueTasks) {
        if (!tk || tk.archived || !tk.dueAt) continue;
        if (!matchesQuery(tk)) continue;
        out.push({ kind: 'task', item: tk, targetId: tgt.id, at: tk.dueAt, allDay: tk.allDay, done: tk.status === 'done' });
      }
    }
    return out;
  }

  function renderList(list, now) {
    list.replaceChildren();
    const rows = combinedEntries();
    const groups = new Map(BUCKETS.map(([k]) => [k, []]));
    const doneRows = [];
    for (const entry of rows) {
      const bk = bucketOf(entry, now);
      if (bk === 'done') { doneRows.push(entry); continue; }
      groups.get(bk).push(entry);
    }
    const byTime = (a, b) => {
      const ta = a.at ? new Date(a.at).getTime() : Infinity;
      const tb = b.at ? new Date(b.at).getTime() : Infinity;
      return ta - tb;
    };
    const renderEntry = (entry) => (
      entry.kind === 'task'
        ? buildDueTaskCard(entry.item, entry.targetId, now)
        : buildReminderCard(entry.item, now)
    );
    let any = false;
    for (const [key, label] of BUCKETS) {
      const arr = groups.get(key);
      if (!arr.length) continue;
      any = true;
      arr.sort(byTime);
      const head = el('div', 'ag-grp bk-' + key);
      head.append(el('span', 'ag-grp-dot bk-' + key), el('span', 'ag-grp-lbl', label), el('span', 'ag-grp-cnt', String(arr.length)));
      list.appendChild(head);
      arr.forEach((e) => list.appendChild(renderEntry(e)));
    }
    if (showDone && doneRows.length) {
      doneRows.sort(byTime);
      const head = el('div', 'ag-grp bk-done');
      head.append(el('span', 'ag-grp-dot bk-done'), el('span', 'ag-grp-lbl', 'Выполненные'), el('span', 'ag-grp-cnt', String(doneRows.length)));
      list.appendChild(head);
      doneRows.forEach((e) => list.appendChild(renderEntry(e)));
    }
    if (!any && !(showDone && doneRows.length)) {
      list.appendChild(el('div', 'nt-empty', query ? 'Ничего не найдено.' : 'Пока нет напоминаний — добавьте первое сверху.'));
    }
  }

  function moveReminderToDay(remId, targetDayKey) {
    const r = items.find((x) => x.id === remId);
    if (!r) return;
    const [yy, mm, dd] = targetDayKey.split('-').map(Number);
    const prev = r.at ? new Date(r.at) : null;
    const hh = prev && !r.allDay ? prev.getHours() : 9;
    const min = prev && !r.allDay ? prev.getMinutes() : 0;
    const nextDate = r.allDay
      ? new Date(yy, mm - 1, dd, 0, 0, 0, 0)
      : new Date(yy, mm - 1, dd, hh, min, 0, 0);
    r.at = nextDate.toISOString();
    r.notifiedAt = null;
    save();
    selectedDay = targetDayKey;
    paint();
    toast(t('Перенесено на {0}', formatDueShort(r.at, r.allDay, new Date(), t)));
  }

  // ---------------- рендер: вид «Месяц» (сетка + DnD + превью) ----------------
  function renderMonth(list, now) {
    list.replaceChildren();
    const cur = monthCursor || new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const tgt = target();

    const byDay = new Map();
    for (const entry of combinedEntries()) {
      if (!showDone && entry.done) continue;
      if (!entry.at) continue;
      const d = new Date(entry.at);
      if (isNaN(d.getTime())) continue;
      const k = dayKey(d);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(entry);
    }

    const head = el('div', 'ag-mhead');
    const prev = el('button', 'ag-mnav', '‹'); prev.title = 'Предыдущий месяц';
    const next = el('button', 'ag-mnav', '›'); next.title = 'Следующий месяц';
    const lbl = el('div', 'ag-mlabel', `${t(MONTHS[cur.getMonth()])} ${cur.getFullYear()}`);
    const today = el('button', 'ag-mtoday', 'Сегодня');
    prev.addEventListener('click', () => { monthCursor = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); selectedDay = null; paint(); });
    next.addEventListener('click', () => { monthCursor = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); selectedDay = null; paint(); });
    today.addEventListener('click', () => { monthCursor = null; selectedDay = dayKey(new Date()); paint(); });
    head.append(prev, lbl, next, el('span', 'ag-spacer'), today);
    list.appendChild(head);

    const grid = el('div', 'ag-grid');
    WEEKDAYS.forEach((w) => grid.appendChild(el('div', 'ag-wd', w)));
    const lead = (cur.getDay() + 6) % 7;
    const start = new Date(cur);
    start.setDate(cur.getDate() - lead);
    const todayKey = dayKey(new Date());

    for (let i = 0; i < 42; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const k = dayKey(day);
      const cls = 'ag-day' + (day.getMonth() === cur.getMonth() ? '' : ' out') + (k === todayKey ? ' today' : '') + (k === selectedDay ? ' sel' : '');
      const cell = el('div', cls);
      cell.appendChild(el('div', 'ag-daynum', String(day.getDate())));

      const di = byDay.get(k) || [];
      if (di.length) {
        const pills = el('div', 'ag-daypills');
        di.slice(0, 2).forEach((e) => {
          const bk = bucketOf(e, now);
          const p = el('div', 'ag-daypill bk-' + bk + (e.kind === 'task' ? ' is-task' : ''), titleOf(e.item.text) || t('(без названия)'));
          p.setAttribute('data-no-i18n', '');
          pills.appendChild(p);
        });
        if (di.length > 2) pills.appendChild(el('div', 'ag-daymore', '+' + (di.length - 2)));
        cell.appendChild(pills);

        const dots = el('div', 'ag-daydots');
        di.slice(0, 4).forEach((e) => dots.appendChild(el('span', 'ag-daydot bk-' + bucketOf(e, now))));
        if (di.length > 4) dots.appendChild(el('span', 'ag-daymore', '+' + (di.length - 4)));
        cell.appendChild(dots);
      }

      cell.addEventListener('dragover', (e) => {
        if (!dragAgendaId) return;
        e.preventDefault();
        cell.classList.add('ag-day-over');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('ag-day-over'));
      cell.addEventListener('drop', (e) => {
        if (!dragAgendaId) return;
        e.preventDefault();
        cell.classList.remove('ag-day-over');
        const id = dragAgendaId;
        dragAgendaId = null;
        moveReminderToDay(id, k);
      });
      cell.addEventListener('click', () => { selectedDay = k; paint(); });
      grid.appendChild(cell);
    }
    list.appendChild(grid);

    if (selectedDay) {
      const di = (byDay.get(selectedDay) || []).slice().sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      const [, mm, dd] = selectedDay.split('-');
      const panel = el('div', 'ag-daypanel');
      const pHead = el('div', 'ag-daypanel-h');
      pHead.appendChild(el('span', null, `${Number(dd)} ${t(MONTHS[Number(mm) - 1])}`));
      const addForDay = el('button', 'ag-dayadd');
      addForDay.type = 'button';
      addForDay.append(icon('plus', 13), el('span', null, 'На этот день'));
      addForDay.addEventListener('click', () => openModal(null, selectedDay));
      pHead.appendChild(addForDay);
      panel.appendChild(pHead);
      if (!di.length) panel.appendChild(el('div', 'nt-empty', 'Нет напоминаний на этот день.'));
      else di.forEach((e) => panel.appendChild(e.kind === 'task' ? buildDueTaskCard(e.item, tgt.id, now) : buildReminderCard(e.item, now, { draggable: true })));
      list.appendChild(panel);
    }
  }

  // ---------------- MCP: доступ агенту из терминала ----------------
  const AGENT_HINT = 'Для этого проекта подключён MCP-сервер «lite-tasks». Используй его инструменты: '
    + '`add_reminder` (поставить напоминание с датой/сроком), `list_reminders` (посмотреть ближайшие сроки), '
    + '`complete_reminder` (отметить выполненным). Создавай напоминание, когда я прошу «напомнить», «не забыть» '
    + 'или «через N дней проверить». Даты передавай в ISO или «YYYY-MM-DD».';

  function openAgentModal() {
    const p = activeProject && activeProject();
    const { m, close } = makeModal(`
      <h2>Доступ агенту из терминала</h2>
      <div class="nt-modal-hint">Встроенный MCP-сервер даёт агенту в терминале проекта инструменты
        создавать и читать эти напоминания. Регистрируется в Claude Code в scope <b>local</b> —
        запись идёт в <code>~/.claude.json</code>, <b>в репозиторий проекта ничего не попадает</b>
        (при необходимости команду ниже можно подключить и в Codex / Gemini / agy).
        После подключения перезапустите сессию агента, чтобы он увидел инструменты <code>lite-tasks</code>.</div>
      <div class="ag-agent-cmd" data-cmd>…</div>
      <div class="nt-exp">
        <button class="btn primary" data-connect ${p ? '' : 'disabled'}>Подключить к агенту в терминале</button>
        <button class="btn" data-copycmd>Скопировать команду</button>
        <button class="btn" data-copyhint>Скопировать подсказку агенту</button>
      </div>
      ${p ? '' : '<div class="nt-modal-hint">Откройте проект слева — MCP привязывается к его каталогу.</div>'}
      <div class="modal-actions"><button class="btn" data-cancel>Закрыть</button></div>`);
    m.classList.add('nt-modal');
    const cmdBox = m.querySelector('[data-cmd]');
    let cmd = '';
    lite.agenda.mcpCommand({ projId: p && p.id }).then((r) => { cmd = (r && r.cmd) || ''; cmdBox.textContent = cmd; }).catch(() => { cmdBox.textContent = '(не удалось получить команду)'; });

    const copy = (text, okMsg) => { try { lite.copyText(text); toast(okMsg); } catch (_) { toast('Не удалось скопировать', { kind: 'err' }); } };
    m.querySelector('[data-copycmd]').onclick = () => cmd ? copy(cmd, 'Команда скопирована') : toast('Команда ещё не готова');
    m.querySelector('[data-copyhint]').onclick = () => copy(AGENT_HINT, 'Подсказка скопирована — вставьте агенту');
    m.querySelector('[data-cancel]').onclick = () => close();
    const connectBtn = m.querySelector('[data-connect]');
    if (connectBtn) connectBtn.onclick = async () => {
      if (!p) return;
      connectBtn.disabled = true; connectBtn.textContent = t('Подключаю…');
      let r; try { r = await lite.agenda.mcpConnect({ projId: p.id, projPath: p.path }); } catch (e) { r = { ok: false, error: String(e) }; }
      if (r && r.ok) { toast('Подключено — перезапустите сессию агента'); close(); }
      else {
        connectBtn.disabled = false; connectBtn.textContent = t('Подключить к агенту в терминале');
        toast(t('Не вышло автоматически: {0}. Скопируйте команду и выполните вручную.', (r && r.error) || t('ошибка')), { kind: 'err', ttl: 6000 });
        if (r && r.cmd) { cmd = r.cmd; cmdBox.textContent = cmd; }
      }
    };
  }

  // ---------------- API для notes.js ----------------
  async function render(hostEl) {
    container = hostEl;
    const tgt = target();
    if (tgt.id !== loadedId || tgt.id !== dueLoadedId) {
      if (tgt.id !== loadedId) items = [];
      paint();
      const ok = await load(tgt.id);
      if (ok && container) paint();
    } else {
      paint();
    }
  }

  async function reload() {
    const id = loadedId;
    if (id && lastSavedJson != null) {
      let arr;
      try { arr = await lite.store.agendaGet(id); } catch (_) { arr = null; }
      if (Array.isArray(arr) && JSON.stringify(arr.map(normalize)) === lastSavedJson) {
        await refreshDueTasks(id);
        if (container) paint();
        return;
      }
    }
    loadedId = null;
    dueLoadedId = null;
    if (container) render(container);
  }

  return {
    render,
    reload,
    refreshDue: async () => {
      const tgt = target();
      await refreshDueTasks(tgt.id);
      if (container) paint();
    },
  };
}
