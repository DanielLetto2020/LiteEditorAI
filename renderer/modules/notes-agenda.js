// LiteEditor — под-модуль «Календарь» (дата-задачи / напоминания) для окна «Задачи».
// Отдельная сущность рядом с обычными задачами: главная ось — ВРЕМЯ, а не статус.
//   • Быстрая запись «чтобы не забыть» + дата/время + напоминалка.
//   • Свой файл-источник: ~/.LiteEditorAI/agenda/<projId>.json (или __global__ без проекта).
//   • Своя модель, свой рендер (лента с группами по сроку) — статусную модель задач НЕ трогает.
// Модель напоминания:
//   { id, text, at:ISO|null, allDay:bool, remind:null|'at'|'10m'|'1h'|'1d', done:bool, tag?, notifiedAt?, createdAt }
//   Первая строка text = заголовок (всегда виден); остальное = тело.
// Изоляция: всё из ядра — через host (activeProject/sendNoteToTerminal/applyLayoutSwap); UI-хелперы — из ui.js.
// Счётчик «требует внимания» (просрочено + сегодня) считает ЯДРО по app:agendaChanged; тут лишь broadcast.
import { el, icon, iconBtn, makeModal, showConfirm, toast } from '../ui.js';

const lite = window.lite;
const GLOBAL_ID = '__global__';

// офсеты напоминания (за сколько ДО срока уведомить), мс
const REMIND_MS = { at: 0, '10m': 10 * 60000, '1h': 3600000, '1d': 86400000 };
const REMIND_LABEL = { '': 'Без напоминания', at: 'В момент срока', '10m': 'За 10 минут', '1h': 'За час', '1d': 'За день' };
const REMIND_ORDER = ['', 'at', '10m', '1h', '1d'];

// группы ленты (сверху вниз) — порядок и заголовки
const BUCKETS = [
  ['overdue', 'Просрочено'],
  ['today', 'Сегодня'],
  ['tomorrow', 'Завтра'],
  ['week', 'На неделе'],
  ['later', 'Позже'],
  ['nodate', 'Без даты'],
];

const titleOf = (t) => { const s = (t || '').trim(); const i = s.indexOf('\n'); return (i < 0 ? s : s.slice(0, i)).trim(); };
const bodyOf = (t) => { const s = (t || ''); const i = s.indexOf('\n'); return i < 0 ? '' : s.slice(i + 1).trim(); };
const genId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const startOfMonth = (d) => { const x = new Date(d); x.setDate(1); x.setHours(0, 0, 0, 0); return x; };
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// В какую группу попадает напоминание относительно now.
function bucketOf(item, now) {
  if (item.done) return 'done';
  if (!item.at) return 'nodate';
  const at = new Date(item.at);
  if (isNaN(at)) return 'nodate';
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / 86400000);
  if (item.allDay) { if (dayDiff < 0) return 'overdue'; }
  else if (at.getTime() < now.getTime()) return 'overdue';
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff <= 7) return 'week';
  return 'later';
}

// Абсолютная подпись даты («8 июл, 15:00» или «8 июл» для allDay).
function absLabel(item) {
  if (!item.at) return '';
  const at = new Date(item.at); if (isNaN(at)) return '';
  const d = at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return item.allDay ? d : `${d}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
// Относительная подпись («через 2 ч», «завтра», «3 дн назад»).
function relLabel(item, now) {
  if (!item.at) return '';
  const at = new Date(item.at); if (isNaN(at)) return '';
  const ms = at.getTime() - now.getTime();
  const abs = Math.abs(ms);
  let core;
  if (abs < 60000) core = 'меньше минуты';
  else if (abs < 3600000) core = `${Math.round(abs / 60000)} мин`;
  else if (abs < 86400000) core = `${Math.round(abs / 3600000)} ч`;
  else core = `${Math.round(abs / 86400000)} дн`;
  return ms >= 0 ? `через ${core}` : `${core} назад`;
}

// Нормализация записи (миграция/защита от кривых данных).
function normalize(r) {
  return {
    id: r.id || genId(),
    text: typeof r.text === 'string' ? r.text : '',
    at: (r.at && !isNaN(new Date(r.at))) ? new Date(r.at).toISOString() : null,
    allDay: !!r.allDay,
    remind: REMIND_ORDER.includes(r.remind) && r.remind ? r.remind : null,
    done: !!r.done,
    tag: typeof r.tag === 'string' ? r.tag : '',
    notifiedAt: r.notifiedAt || null,
    createdAt: r.createdAt || new Date().toISOString(),
  };
}

// host: { activeProject, sendNoteToTerminal, applyLayoutSwap, settings, saveSettings }
export function createAgendaView(host) {
  const { activeProject, sendNoteToTerminal, applyLayoutSwap, settings, saveSettings } = host;

  let container = null;   // #notes-body ← сюда рисуем
  let items = [];         // текущий список
  let loadedId = null;    // id файла, который сейчас в items
  let loadSeq = 0;        // защита от гонки async-загрузки
  let query = '';         // поиск (в сессии)
  let showDone = false;   // показывать выполненные
  let subView = (settings && settings.agendaView === 'month') ? 'month' : 'agenda'; // лента / месяц
  let monthCursor = null; // Date на 1-е число отображаемого месяца (null → текущий)
  let selectedDay = null; // 'YYYY-MM-DD' выбранный день в виде «Месяц»
  let lastLocalSave = 0;  // время своей записи — чтобы не перерисовываться на эхо fs.watch (и не терять фокус)

  // Куда смотрит вкладка: активный проект, иначе — общий список («Личные»).
  function target() {
    const p = activeProject && activeProject();
    return p ? { id: p.id, name: p.name, proj: p, kind: 'project' } : { id: GLOBAL_ID, name: 'Личные', kind: 'global' };
  }

  async function load(id) {
    const seq = ++loadSeq;
    let arr = await lite.store.agendaGet(id);
    if (seq !== loadSeq) return false;
    if (!Array.isArray(arr)) arr = [];
    items = arr.map(normalize);
    loadedId = id;
    return true;
  }
  function save() {
    const id = loadedId || target().id; // на случай записи до завершения первой загрузки
    loadedId = id;
    lastLocalSave = Date.now();
    lite.store.agendaSet(id, items);
    try { lite.app.agendaChanged(id); } catch (_) {}
  }

  const matchesQuery = (r) => !query || (r.text || '').toLowerCase().includes(query.toLowerCase());

  // ---------------- модалка (новое/правка) ----------------
  function openModal(item) {
    const isNew = !item;
    const { m, close } = makeModal(`
      <h2>${isNew ? 'Новое напоминание' : 'Редактировать'}</h2>
      <textarea class="nt-modal-ta ag-modal-ta" placeholder="Что не забыть… Первая строка — заголовок."></textarea>
      <div class="ag-modal-grid">
        <label class="ag-fld"><span>Дата и время</span><input type="datetime-local" data-at></label>
        <label class="ag-fld ag-fld-chk"><input type="checkbox" data-allday><span>Весь день</span></label>
        <label class="ag-fld"><span>Напоминание</span><select data-remind></select></label>
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
    REMIND_ORDER.forEach((k) => { const o = el('option', null, REMIND_LABEL[k]); o.value = k; remindSel.appendChild(o); });

    ta.value = item ? (item.text || '') : '';
    if (item && item.at) atIn.value = toLocalInput(new Date(item.at));
    allDayIn.checked = item ? !!item.allDay : false;
    remindSel.value = item && item.remind ? item.remind : '';
    // «Весь день» → скрыть время у datetime-local нельзя, но переключаем тип на date/datetime
    const syncAllDay = () => { atIn.type = allDayIn.checked ? 'date' : 'datetime-local'; };
    syncAllDay();
    allDayIn.addEventListener('change', () => {
      // сохранить дату при смене типа
      const cur = atIn.value; syncAllDay();
      if (cur && allDayIn.checked) atIn.value = cur.slice(0, 10);
    });

    const commit = () => {
      const text = ta.value.trim();
      if (!text) { close(); return; }
      let at = null, allDay = !!allDayIn.checked;
      if (atIn.value) {
        const d = allDay ? new Date(atIn.value + 'T00:00') : new Date(atIn.value);
        if (!isNaN(d)) at = d.toISOString();
      } else { allDay = false; }
      const remind = remindSel.value || null;
      if (isNew) {
        items.unshift(normalize({ text, at, allDay, remind, done: false }));
      } else {
        item.text = text; item.at = at; item.allDay = allDay; item.remind = remind;
        item.notifiedAt = null; // срок мог измениться → разрешить уведомить заново
      }
      save(); close(); paint();
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
    if (!text) { toast('Введите текст'); return; }
    let at = null;
    if (atVal) { const d = new Date(atVal); if (!isNaN(d)) at = d.toISOString(); }
    items.unshift(normalize({ text, at, allDay: false, remind, done: false }));
    save(); paint();
  }

  // ---------------- карточка напоминания ----------------
  function buildCard(item, now) {
    const bucket = bucketOf(item, now);
    const card = el('div', 'ag-card bk-' + bucket + (item.done ? ' done' : ''));
    card.dataset.id = item.id;

    const doneBtn = el('button', 'ag-check' + (item.done ? ' on' : ''));
    doneBtn.title = item.done ? 'Снять отметку' : 'Отметить выполненным';
    if (item.done) doneBtn.appendChild(icon('check', 12));
    doneBtn.addEventListener('click', () => { item.done = !item.done; if (item.done) item.notifiedAt = new Date().toISOString(); save(); paint(); });

    const dot = el('span', 'ag-dot bk-' + bucket);

    const col = el('div', 'ag-textcol');
    const titleEl = el('div', 'ag-title', titleOf(item.text) || '(без названия)');
    titleEl.addEventListener('dblclick', () => openModal(item));
    col.appendChild(titleEl);
    const bt = bodyOf(item.text);
    if (bt) col.appendChild(el('div', 'ag-body', bt));
    if (item.at || item.remind) {
      const when = el('div', 'ag-when');
      if (item.at) {
        when.appendChild(el('span', 'ag-abs', absLabel(item)));
        when.appendChild(el('span', 'ag-rel', relLabel(item, now)));
      }
      if (item.remind) { const b = el('span', 'ag-remind'); b.append(icon('clock', 11), document.createTextNode(REMIND_LABEL[item.remind])); when.appendChild(b); }
      col.appendChild(when);
    }

    const acts = el('div', 'ag-acts');
    const send = iconBtn('ag-act', 'terminal', 'В терминал проекта', 14);
    send.addEventListener('click', () => {
      const p = (target().kind === 'project') ? target().proj : (activeProject && activeProject());
      if (!p) { toast('Нет активного проекта'); return; }
      sendNoteToTerminal(p, item.text);
    });
    const edit = iconBtn('ag-act', 'pencil', 'Редактировать', 14); edit.addEventListener('click', () => openModal(item));
    const del = iconBtn('ag-act danger', 'trash', 'Удалить', 14);
    del.addEventListener('click', () => showConfirm('Удалить напоминание?', 'Удалить совсем?', 'Удалить', () => { const ix = items.indexOf(item); if (ix >= 0) items.splice(ix, 1); save(); paint(); }));
    acts.append(send, edit, del);

    card.append(doneBtn, dot, col, acts);
    return card;
  }

  // ---------------- рендер ленты ----------------
  function paint() {
    if (!container) return;
    const now = new Date();
    const t = target();
    container.replaceChildren();

    // быстрый ввод
    const bar = el('div', 'ag-quick');
    const qtext = el('input', 'ag-qtext'); qtext.dataset.qtext = '1'; qtext.placeholder = 'Быстрая запись… (Enter — добавить)';
    const qdate = el('input', 'ag-qdate'); qdate.type = 'datetime-local'; qdate.dataset.qdate = '1'; qdate.title = 'Дата и время (необязательно)';
    const qremind = el('select', 'ag-qremind'); qremind.dataset.qremind = '1'; qremind.title = 'Напоминание';
    REMIND_ORDER.forEach((k) => { const o = el('option', null, k === '' ? '🔔 нет' : REMIND_LABEL[k]); o.value = k; qremind.appendChild(o); });
    const qadd = el('button', 'ag-qadd'); qadd.appendChild(icon('plus', 16)); qadd.title = 'Добавить напоминание';
    qtext.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(bar); } });
    qadd.addEventListener('click', () => quickAdd(bar));
    bar.append(qtext, qdate, qremind, qadd);

    // чипы быстрой даты
    const chips = el('div', 'ag-chips');
    const setDate = (d) => { qdate.value = d ? toLocalInput(d) : ''; qtext.focus(); };
    const mk = (label, fn) => { const b = el('button', 'ag-chip', label); b.addEventListener('click', fn); return b; };
    const at9 = (days) => { const d = startOfDay(now); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d; };
    chips.append(
      mk('Сегодня', () => setDate(at9(0))),
      mk('Завтра', () => setDate(at9(1))),
      mk('+ неделя', () => setDate(at9(7))),
      mk('Убрать дату', () => setDate(null)),
    );

    // тулбар: вид (лента/месяц) + поиск + показать выполненные
    const tools = el('div', 'ag-toolbar');
    const viewToggle = el('button', 'ag-tbtn' + (subView === 'month' ? ' on' : ''));
    viewToggle.append(icon('columns', 14), document.createTextNode(subView === 'month' ? 'Месяц' : 'Лента'));
    viewToggle.title = 'Вид: лента / месяц';
    viewToggle.addEventListener('click', () => {
      subView = subView === 'month' ? 'agenda' : 'month';
      if (settings) { settings.agendaView = subView; saveSettings && saveSettings(); }
      selectedDay = null; paint();
    });
    const search = el('input', 'ag-search'); search.placeholder = 'Поиск…'; search.value = query;
    search.addEventListener('input', () => { query = search.value.trim(); repaintList(); });
    const doneToggle = el('button', 'ag-tbtn' + (showDone ? ' on' : ''));
    doneToggle.append(icon('check', 14), document.createTextNode('Выполненные'));
    doneToggle.addEventListener('click', () => { showDone = !showDone; paint(); });
    const agentBtn = el('button', 'ag-tbtn');
    agentBtn.append(icon('terminal', 14), document.createTextNode('Агент'));
    agentBtn.title = 'Дать агенту в терминале доступ к напоминаниям (MCP)';
    agentBtn.addEventListener('click', openAgentModal);
    tools.append(viewToggle, search, doneToggle, agentBtn);

    const listWrap = el('div', 'ag-list' + (subView === 'month' ? ' ag-monthwrap' : '')); listWrap.dataset.list = '1';

    container.append(bar, chips, tools, listWrap);
    if (subView === 'month') renderMonth(listWrap, now); else renderList(listWrap, now);

    // фокусные удобства
    if (t.kind === 'global') qtext.placeholder = 'Личное напоминание… (Enter — добавить)';
  }

  // перерисовать только список (поиск), без сброса полей быстрого ввода
  function repaintList() {
    const list = container && container.querySelector('[data-list]');
    if (!list) return;
    if (subView === 'month') renderMonth(list, new Date()); else renderList(list, new Date());
  }

  function renderList(list, now) {
    list.replaceChildren();
    const rows = items.filter(matchesQuery);
    const groups = new Map(BUCKETS.map(([k]) => [k, []]));
    const doneRows = [];
    for (const r of rows) {
      const bk = bucketOf(r, now);
      if (bk === 'done') { doneRows.push(r); continue; }
      groups.get(bk).push(r);
    }
    // сортировка внутри группы: по времени (пустые — в конец)
    const byTime = (a, b) => {
      const ta = a.at ? new Date(a.at).getTime() : Infinity;
      const tb = b.at ? new Date(b.at).getTime() : Infinity;
      return ta - tb;
    };
    let any = false;
    for (const [key, label] of BUCKETS) {
      const arr = groups.get(key); if (!arr.length) continue;
      any = true;
      arr.sort(byTime);
      const head = el('div', 'ag-grp bk-' + key);
      head.append(el('span', 'ag-grp-dot bk-' + key), el('span', 'ag-grp-lbl', label), el('span', 'ag-grp-cnt', String(arr.length)));
      list.appendChild(head);
      arr.forEach((r) => list.appendChild(buildCard(r, now)));
    }
    if (showDone && doneRows.length) {
      doneRows.sort(byTime);
      const head = el('div', 'ag-grp bk-done');
      head.append(el('span', 'ag-grp-dot bk-done'), el('span', 'ag-grp-lbl', 'Выполненные'), el('span', 'ag-grp-cnt', String(doneRows.length)));
      list.appendChild(head);
      doneRows.forEach((r) => list.appendChild(buildCard(r, now)));
    }
    if (!any && !(showDone && doneRows.length)) {
      list.appendChild(el('div', 'nt-empty', query ? 'Ничего не найдено.' : 'Пока нет напоминаний — добавьте первое сверху.'));
    }
  }

  // ---------------- рендер: вид «Месяц» (сетка) ----------------
  function renderMonth(list, now) {
    list.replaceChildren();
    const cur = monthCursor || startOfMonth(now);

    // индекс напоминаний по дню (только с датой; учитываем поиск)
    const byDay = new Map();
    for (const r of items.filter(matchesQuery)) {
      if (!r.at) continue;
      const d = new Date(r.at); if (isNaN(d)) continue;
      const k = dayKey(d);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }

    // шапка навигации
    const head = el('div', 'ag-mhead');
    const prev = el('button', 'ag-mnav', '‹'); prev.title = 'Предыдущий месяц';
    const next = el('button', 'ag-mnav', '›'); next.title = 'Следующий месяц';
    const lbl = el('div', 'ag-mlabel', `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`);
    const today = el('button', 'ag-mtoday', 'Сегодня');
    prev.addEventListener('click', () => { const c = new Date(cur); c.setMonth(c.getMonth() - 1); monthCursor = startOfMonth(c); selectedDay = null; paint(); });
    next.addEventListener('click', () => { const c = new Date(cur); c.setMonth(c.getMonth() + 1); monthCursor = startOfMonth(c); selectedDay = null; paint(); });
    today.addEventListener('click', () => { monthCursor = null; selectedDay = dayKey(new Date()); paint(); });
    head.append(prev, lbl, next, el('span', 'ag-spacer'), today);
    list.appendChild(head);

    // сетка: заголовки дней недели + 42 ячейки (6 недель), начиная с понедельника ≤ 1-го числа
    const grid = el('div', 'ag-grid');
    WEEKDAYS.forEach((w) => grid.appendChild(el('div', 'ag-wd', w)));
    const lead = (cur.getDay() + 6) % 7; // 0 = Пн
    const start = new Date(cur); start.setDate(cur.getDate() - lead);
    const todayKey = dayKey(new Date());
    for (let i = 0; i < 42; i++) {
      const day = new Date(start); day.setDate(start.getDate() + i);
      const k = dayKey(day);
      const cls = 'ag-day' + (day.getMonth() === cur.getMonth() ? '' : ' out') + (k === todayKey ? ' today' : '') + (k === selectedDay ? ' sel' : '');
      const cell = el('div', cls);
      cell.appendChild(el('div', 'ag-daynum', String(day.getDate())));
      const di = byDay.get(k) || [];
      if (di.length) {
        const dots = el('div', 'ag-daydots');
        di.slice(0, 4).forEach((r) => dots.appendChild(el('span', 'ag-daydot bk-' + bucketOf(r, now))));
        if (di.length > 4) dots.appendChild(el('span', 'ag-daymore', '+' + (di.length - 4)));
        cell.appendChild(dots);
      }
      cell.addEventListener('click', () => { selectedDay = k; paint(); });
      grid.appendChild(cell);
    }
    list.appendChild(grid);

    // панель выбранного дня (список напоминаний того дня)
    if (selectedDay) {
      const di = (byDay.get(selectedDay) || []).slice().sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      const [, mm, dd] = selectedDay.split('-');
      const panel = el('div', 'ag-daypanel');
      panel.appendChild(el('div', 'ag-daypanel-h', `${Number(dd)} ${MONTHS[Number(mm) - 1]}`));
      if (!di.length) panel.appendChild(el('div', 'nt-empty', 'Нет напоминаний на этот день.'));
      else di.forEach((r) => panel.appendChild(buildCard(r, now)));
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
        запись идёт в <code>~/.claude.json</code>, <b>в репозиторий проекта ничего не попадает</b>.
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

    const copy = async (text, okMsg) => { try { await navigator.clipboard.writeText(text); toast(okMsg); } catch (_) { toast('Не удалось скопировать', { kind: 'err' }); } };
    m.querySelector('[data-copycmd]').onclick = () => cmd ? copy(cmd, 'Команда скопирована') : toast('Команда ещё не готова');
    m.querySelector('[data-copyhint]').onclick = () => copy(AGENT_HINT, 'Подсказка скопирована — вставьте агенту');
    m.querySelector('[data-cancel]').onclick = () => close();
    const connectBtn = m.querySelector('[data-connect]');
    if (connectBtn) connectBtn.onclick = async () => {
      if (!p) return;
      connectBtn.disabled = true; connectBtn.textContent = 'Подключаю…';
      let r; try { r = await lite.agenda.mcpConnect({ projId: p.id, projPath: p.path }); } catch (e) { r = { ok: false, error: String(e) }; }
      if (r && r.ok) { toast('Подключено — перезапустите сессию агента'); close(); }
      else {
        connectBtn.disabled = false; connectBtn.textContent = 'Подключить к агенту в терминале';
        toast('Не вышло автоматически: ' + (r && r.error ? r.error : 'ошибка') + '. Скопируйте команду и выполните вручную.', { kind: 'err', ttl: 6000 });
        if (r && r.cmd) { cmd = r.cmd; cmdBox.textContent = cmd; }
      }
    };
  }

  // ---------------- API для notes.js ----------------
  async function render(el) {
    container = el;
    const t = target();
    if (t.id !== loadedId) {
      items = [];            // не мигаем данными прошлого проекта, пока грузим новый источник
      paint();
      const ok = await load(t.id);
      if (ok && container) paint();
    } else {
      paint();               // тот же источник — рисуем из текущего состояния
    }
  }
  function reload() {
    // эхо своей записи через fs.watch (main шлёт agendaChanged всем окнам) — не дёргаем UI и не крадём фокус
    if (Date.now() - lastLocalSave < 1500) return;
    loadedId = null;
    if (container) render(container);
  }

  return { render, reload };
}
