// LiteEditor — модуль «IterFlow»: рабочее место исполнителя поверх таск-трекера
// IterFlow (отдельный продукт, см. его ITER.md §14). Панель правого слота. Сеть —
// в main (lite.iterflow.* → /api/editor/*), здесь только UI. Два экрана:
//   • Логин   — email+пароль (device-токен живёт в main); ссылка на регистрацию.
//   • Рабочая — 3 выпадашки сверху (контекст → заказчик → проект) + вкладки
//               Итерация / Канбан / Туду / Чат.
//     - Итерация: вертикальный таймлайн (даты слева) + задачи; CRUD итераций/задач и
//                 переходы стадий (submit/approve/accept/reject) — действия в карточке.
//     - Канбан:   задачи активной итерации, смена статуса (только в стадии active).
//     - Туду:     заметки проекта (project_notes) — создание/правка/удаление (правит автор).
//     - Чат:      общий канал проекта (read-only).
// Запись (CRUD + жизненный цикл) идёт через ВЕБ-cookie на те же /api/* маршруты, что и
// веб-клиент IterFlow — в editor-группе write-ручек нет (только kanban-status). Все гейты
// (стадия/роль/автор/frozen) проверяет сервер; UI лишь прячет заведомо запрещённое.
// Изолирован по образцу audit.js: ядро — через host, UI — из ui.js, бэкенд — только
// через window.lite. host: { layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels }
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// Веб-лицо IterFlow (ссылка «зарегистрироваться» → форма запроса доступа, invite-only).
const IF_WEB = 'https://iter-flow.ru';

// Стадии итерации → метка + класс бейджа (ITER.md §7.1).
const STAGE = {
  draft: ['Черновик', 'if-st-draft'],
  scope_review: ['На подтверждении', 'if-st-review'],
  active: ['В работе', 'if-st-active'],
  final_review: ['На приёмке', 'if-st-final'],
  closed: ['Закрыто', 'if-st-closed'],
  frozen: ['Заморожено', 'if-st-frozen'],
};
// Колонки канбана задач (enum kanban_status, см. tasks.go::validKanbanStatus).
const KANBAN_COLS = [
  ['iteration', 'Итерация'],
  ['in_progress', 'В работе'],
  ['completed', 'Завершено'],
  ['review', 'Проверка'],
  ['done', 'Готово'],
  ['rework', 'На доработку'],
];
const KANBAN_LABEL = Object.fromEntries(KANBAN_COLS);
const TABS = [['iter', 'Итерация'], ['kanban', 'Канбан'], ['todo', 'Туду'], ['chat', 'Чат']];
// Порядок плашек итераций (как в вебе): в работе → на подтверждении/приёмке →
// черновые → заморожено → завершённые (последние свёрнуты по умолчанию).
const STAGE_ORDER = { active: 0, scope_review: 1, final_review: 2, draft: 3, frozen: 4, closed: 5 };
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// Важность задачи/заметки (NotePriority) — метка + класс подсветки (как в вебе).
const PRIO = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочно' };
const TASK_STATUS = { todo: 'К выполнению', in_progress: 'В работе', done: 'Выполнено', blocked: 'Блок' };
const NOTE_STATUS = { open: 'открыто', done: 'выполнено', archived: 'архив' };
// Опции форм (точные enum'ы бэкенда: validNotePriority / validNoteViewMode /
// validTaskStatus / validNoteStatus — см. notes.go/tasks.go IterFlow).
const PRIO_OPTS = [['low', 'низкий'], ['normal', 'обычный'], ['high', 'высокий'], ['urgent', 'срочно']];
const VIEW_OPTS = [['text', 'текст'], ['md', 'markdown'], ['html', 'HTML']];
const TASK_STATUS_OPTS = [['todo', 'К выполнению'], ['in_progress', 'В работе'], ['done', 'Выполнено'], ['blocked', 'Блок']];
const NOTE_STATUS_OPTS = [['open', 'открыто'], ['done', 'выполнено'], ['archived', 'архив']];

// Заголовок = первая непустая строка content (со стрипом markdown), как в вебе
// (project_note.dart::title / Task.title). У задач есть готовый title с бэка.
function noteTitle(content) {
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim();
    if (line) { const s = line.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s+/, '').trim(); return s || line; }
  }
  return 'Без названия';
}
function itemTitle(it) { const t = (it.title || '').trim(); return t || noteTitle(it.content); }
// Есть ли содержимое помимо заголовка → индикатор «есть детали».
function hasBody(it) {
  return String(it.content || '').split('\n').map((s) => s.trim()).filter(Boolean).length > 1;
}

export function initIterflow(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let open = false;
  let booted = false;
  let busy = false;
  let user = null;
  let contexts = [];
  let counterparties = [];
  let projects = [];
  let iterations = [];
  let activeCtx = null, activeCp = null, activeProj = null;
  let tab = 'iter';
  const collapsed = new Set();           // iterId свёрнутых карточек (вкладка «Итерация»)
  const tasksByIter = new Map();         // iterId → tasks[] | { error } | 'loading'
  let notes = null;                      // null=не загружено | [] | { error } — вкладка «Туду» (веб-cookie)
  let messages = null;                   // null=не загружено | {items} | { error } — вкладка «Чат» (веб-cookie)
  let kanbanIterId = null;               // выбранная итерация для вкладки «Канбан» (свой селектор, как в mobile web)
  let prevVis = { cp: false, proj: false, content: false }; // что было видно — чтобы fade играл только при ПОЯВЛЕНИИ уровня

  // ---------------- данные ----------------
  function contextsFrom(bundle) {
    const out = [];
    for (const p of (bundle.profiles || [])) if (p.kind === 'contractor') out.push({ key: 'solo:' + p.id, kind: 'solo', label: 'Соло' });
    for (const t of (bundle.teams || [])) if (t.kind === 'contractor') out.push({ key: 'team:' + t.id, kind: 'team', label: t.name || 'Команда' });
    return out;
  }
  function onUnauth() { user = null; contexts = []; renderBody(); toast('Сессия IterFlow истекла — войдите снова', { kind: 'err' }); }
  function failToast(label, r) {
    if (r && r.unauth) { onUnauth(); return; }
    toast(label + ': ' + ((r && r.error) || 'ошибка'), { kind: 'err' });
  }
  async function run(fn) {
    busy = true; renderBody();
    try { await fn(); } finally { busy = false; renderBody(); }
  }

  async function boot() {
    booted = true;
    busy = true; renderBody();
    const r = await lite.iterflow.session();
    if (r && r.ok && r.data && r.data.authed) {
      user = r.data.user; contexts = contextsFrom(r.data);
      if (contexts.length === 1) await selectCtx(contexts[0].key); // единственный контекст — предвыбираем
    }
    busy = false; renderBody();
  }

  async function doLogin(email, pass) {
    const r = await lite.iterflow.login(email, pass);
    if (!r || !r.ok) { toast('Вход не удался: ' + ((r && r.error) || 'неверный логин'), { kind: 'err' }); return; }
    user = r.data.user; contexts = contextsFrom(r.data);
    if (contexts.length === 1) await selectCtx(contexts[0].key);
  }

  async function doLogout() {
    await lite.iterflow.logout();
    user = null; contexts = []; counterparties = []; projects = []; iterations = [];
    activeCtx = activeCp = activeProj = null; tasksByIter.clear(); collapsed.clear(); notes = null; messages = null;
  }

  // Прогрессивное раскрытие: выбор уровня загружает СЛЕДУЮЩИЙ список, но НЕ выбирает
  // в нём ничего — пользователь выбирает сам, тогда появляется уровень ниже.
  async function selectCtx(key) {
    activeCtx = key; counterparties = []; activeCp = null; projects = []; activeProj = null; iterations = []; tasksByIter.clear(); notes = null; messages = null; kanbanIterId = null;
    if (!key) return;
    const r = await lite.iterflow.counterparties(key);
    if (!r || !r.ok) return failToast('Заказчики', r);
    counterparties = r.data || [];
  }

  async function selectCp(cpId) {
    activeCp = cpId; projects = []; activeProj = null; iterations = []; tasksByIter.clear(); notes = null; messages = null; kanbanIterId = null;
    if (!cpId) return;
    const r = await lite.iterflow.counterpartyProjects(cpId);
    if (!r || !r.ok) return failToast('Проекты', r);
    projects = r.data || [];
  }

  async function selectProj(projId) {
    activeProj = projId; iterations = []; tasksByIter.clear(); collapsed.clear(); notes = null; messages = null; kanbanIterId = null;
    if (!projId) return;
    const r = await lite.iterflow.projectIterations(projId);
    if (!r || !r.ok) return failToast('Итерации', r);
    iterations = (r.data || []).slice().sort((a, b) => {
      const d = (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9);
      return d !== 0 ? d : (b.number || 0) - (a.number || 0);
    });
    // По умолчанию сворачиваем завершённые/замороженные — актуальные остаются раскрытыми.
    for (const it of iterations) if (it.stage === 'closed' || it.stage === 'frozen') collapsed.add(it.id);
    await Promise.all(iterations.map((it) => loadTasks(it.id)));
  }

  async function loadTasks(iterId) {
    tasksByIter.set(iterId, 'loading');
    const r = await lite.iterflow.iterationTasks(iterId);
    tasksByIter.set(iterId, (r && r.ok) ? (r.data || []) : { error: (r && r.error) || 'ошибка' });
  }

  async function loadNotes() {
    const r = await lite.iterflow.projectNotes(activeProj);
    notes = (r && r.ok) ? (r.data || []) : { error: (r && r.error) || 'ошибка', web: !!(r && r.web401) };
  }
  async function loadMessages() {
    const r = await lite.iterflow.projectMessages(activeProj);
    messages = (r && r.ok) ? (r.data || { items: [] }) : { error: (r && r.error) || 'ошибка', web: !!(r && r.web401) };
  }

  async function changeKanban(task, status) {
    const r = await lite.iterflow.setTaskKanban(task.id, status);
    if (!r || !r.ok) return failToast('Смена статуса', r);
    task.kanbanStatus = (r.data && r.data.kanbanStatus) || status;
  }

  function activeIteration() { return iterations.find((it) => it.stage === 'active') || null; }

  // ---------------- запись: CRUD + жизненный цикл (веб-cookie) ----------------
  // Все гейты (стадия/роль/автор/frozen) проверяет сервер; клиент лишь прячет
  // заведомо запрещённые действия и показывает ошибку, если сервер всё же отказал.
  function curCp() { return counterparties.find((c) => c.id === activeCp) || null; }
  function curProj() { return projects.find((p) => p.id === activeProj) || null; }
  // В личном/командном пространстве исполнитель сам себе заказчик → ему доступны
  // клиентские переходы (согласовать/принять). В партнёрском проекте их делает заказчик.
  function isSelfSpace() { const c = curCp(); return !!(c && (c.isPersonalSpace || c.isTeamSpace)); }
  function projFrozen() { const p = curProj(); return !!(p && p.frozen); }
  function iterOf(id) { return iterations.find((i) => i.id === id) || null; }
  const myId = () => (user && user.id) || null;
  const canEditNote = (n) => !!(myId() && n.createdByUserId === myId()); // править/удалять заметку может только её автор

  // Перезагрузка итераций после структурных изменений (сохраняем свёрнутость карточек).
  async function reloadIterations() {
    if (!activeProj) return;
    const keep = new Set(collapsed);
    const r = await lite.iterflow.projectIterations(activeProj);
    if (!r || !r.ok) return failToast('Итерации', r);
    iterations = (r.data || []).slice().sort((a, b) => {
      const d = (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9);
      return d !== 0 ? d : (b.number || 0) - (a.number || 0);
    });
    collapsed.clear();
    for (const it of iterations) if (keep.has(it.id) || it.stage === 'closed' || it.stage === 'frozen') collapsed.add(it.id);
    await Promise.all(iterations.map((it) => loadTasks(it.id)));
  }

  // Обёртка write-вызова: тост успеха/ошибки (web401 покажет своё сообщение). → data|null.
  async function write(label, fn, okMsg) {
    const r = await fn();
    if (!r || !r.ok) { failToast(label, r); return null; }
    if (okMsg) toast(okMsg);
    return r.data != null ? r.data : true;
  }

  // Модалка-форма для создания/правки. fields: [{key,label,type,value,options?,placeholder?,rows?}].
  function formModal(title, fields, submitLabel, onSubmit) {
    const { m, close } = makeModal('<div class="if-modal"></div>');
    const host = m.querySelector('.if-modal');
    const head = el('div', 'if-modal-head');
    head.appendChild(el('div', 'if-modal-title', title));
    const x = iconBtn('icon-btn', 'x', 'Закрыть', 16); x.onclick = close; head.appendChild(x);
    host.appendChild(head);
    const inputs = {};
    const form = el('div', 'if-form');
    for (const f of fields) {
      const row = el('div', 'if-form-row');
      row.appendChild(el('label', 'if-form-lbl', f.label));
      let inp;
      if (f.type === 'textarea') { inp = el('textarea', 'if-form-area'); inp.rows = f.rows || 5; inp.value = f.value || ''; if (f.placeholder) inp.placeholder = f.placeholder; }
      else if (f.type === 'select') { inp = el('select', 'if-form-sel'); for (const [v, l] of (f.options || [])) { const o = el('option', null, l); o.value = v; if (v === (f.value || '')) o.selected = true; inp.appendChild(o); } }
      else { inp = el('input', 'if-form-inp'); inp.type = f.type || 'text'; inp.value = f.value || ''; if (f.placeholder) inp.placeholder = f.placeholder; }
      inputs[f.key] = inp;
      row.appendChild(inp);
      form.appendChild(row);
    }
    host.appendChild(form);
    const foot = el('div', 'if-form-foot');
    const cancel = el('button', 'if-btn', 'Отмена'); cancel.onclick = close;
    const ok = el('button', 'if-btn if-btn-primary', submitLabel || 'Сохранить');
    ok.onclick = () => { const v = {}; for (const k in inputs) v[k] = inputs[k].value; onSubmit(v, close); };
    foot.append(cancel, ok);
    host.appendChild(foot);
    const first = fields[0] && inputs[fields[0].key]; if (first) setTimeout(() => first.focus(), 30);
    return { inputs, close };
  }

  // --- итерации ---
  function addIteration() {
    formModal('Новая итерация', [
      { key: 'title', label: 'Название', type: 'text', placeholder: 'Напр. Спринт 1' },
      { key: 'startsAt', label: 'Начало (ГГГГ-ММ-ДД)', type: 'text', placeholder: 'необязательно' },
      { key: 'endsAt', label: 'Конец (ГГГГ-ММ-ДД)', type: 'text', placeholder: 'необязательно' },
    ], 'Создать', (v, close) => {
      if (!v.title.trim()) { toast('Введите название', { kind: 'err' }); return; }
      const body = { title: v.title.trim(), startsAt: v.startsAt.trim() || null, endsAt: v.endsAt.trim() || null };
      close();
      run(async () => { if (await write('Создание итерации', () => lite.iterflow.createIteration(activeProj, body), 'Итерация создана')) await reloadIterations(); });
    });
  }
  function renameIteration(it) {
    formModal('Переименовать итерацию', [{ key: 'title', label: 'Название', type: 'text', value: it.title || '' }], 'Сохранить', (v, close) => {
      if (!v.title.trim()) { toast('Введите название', { kind: 'err' }); return; }
      close();
      run(async () => { if (await write('Переименование', () => lite.iterflow.renameIteration(it.id, v.title.trim()), 'Сохранено')) await reloadIterations(); });
    });
  }
  function editDeadline(it) {
    formModal('Дедлайн итерации', [{ key: 'deadline', label: 'Дедлайн (ГГГГ-ММ-ДД, пусто = снять)', type: 'text', value: fmtDate(it.deadline) }], 'Сохранить', (v, close) => {
      close();
      run(async () => { if (await write('Дедлайн', () => lite.iterflow.setIterationDeadline(it.id, v.deadline.trim() || null), 'Сохранено')) await reloadIterations(); });
    });
  }
  function removeIteration(it) {
    showConfirm('Удалить итерацию?', '№' + (it.number || '?') + (it.title ? ' · ' + it.title : '') + '\nЭто действие необратимо.', 'Удалить', () => {
      run(async () => { if (await write('Удаление итерации', () => lite.iterflow.deleteIteration(it.id), 'Итерация удалена')) await reloadIterations(); });
    });
  }
  function stageAction(it, action, label, needReason) {
    const go = (reason) => run(async () => { if (await write(label, () => lite.iterflow.iterationStage(it.id, action, reason != null ? { reason } : undefined), label + ' — готово')) await reloadIterations(); });
    if (needReason) {
      formModal(label, [{ key: 'reason', label: 'Причина', type: 'textarea', rows: 3 }], 'Отправить', (v, close) => {
        if (!v.reason.trim()) { toast('Укажите причину', { kind: 'err' }); return; }
        close(); go(v.reason.trim());
      });
    } else { go(null); }
  }

  // --- задачи ---
  function addTask(it) {
    formModal('Новая задача', [
      { key: 'content', label: 'Содержимое', type: 'textarea', placeholder: 'Первая строка станет заголовком' },
      { key: 'priority', label: 'Важность', type: 'select', options: PRIO_OPTS, value: 'normal' },
      { key: 'viewMode', label: 'Формат', type: 'select', options: VIEW_OPTS, value: 'text' },
    ], 'Создать', (v, close) => {
      if (!v.content.trim()) { toast('Введите содержимое', { kind: 'err' }); return; }
      close();
      run(async () => { if (await write('Создание задачи', () => lite.iterflow.createTask(it.id, { content: v.content, priority: v.priority, viewMode: v.viewMode }), 'Задача создана')) await loadTasks(it.id); });
    });
  }
  function editTask(task) {
    formModal('Редактировать задачу', [
      { key: 'content', label: 'Содержимое', type: 'textarea', value: task.content || '' },
      { key: 'priority', label: 'Важность', type: 'select', options: PRIO_OPTS, value: task.priority || 'normal' },
      { key: 'status', label: 'Статус', type: 'select', options: TASK_STATUS_OPTS, value: task.status || 'todo' },
      { key: 'viewMode', label: 'Формат', type: 'select', options: VIEW_OPTS, value: task.viewMode || 'text' },
    ], 'Сохранить', (v, close) => {
      if (!v.content.trim()) { toast('Содержимое не может быть пустым', { kind: 'err' }); return; }
      close();
      run(async () => { if (await write('Сохранение задачи', () => lite.iterflow.updateTask(task.id, { content: v.content, priority: v.priority, status: v.status, viewMode: v.viewMode }), 'Сохранено')) await loadTasks(task.iterationId); });
    });
  }
  function removeTask(task) {
    showConfirm('Удалить задачу?', itemTitle(task) + '\nНеобратимо.', 'Удалить', () => {
      run(async () => { if (await write('Удаление задачи', () => lite.iterflow.deleteTask(task.id), 'Задача удалена')) await loadTasks(task.iterationId); });
    });
  }
  function toggleDone(task) {
    run(async () => { if (await write('Готовность', () => lite.iterflow.toggleTaskDone(task.id))) await loadTasks(task.iterationId); });
  }

  // --- туду (project_notes) ---
  function addNote() {
    formModal('Новая заметка', [
      { key: 'content', label: 'Текст', type: 'textarea', placeholder: 'Первая строка станет заголовком' },
      { key: 'priority', label: 'Важность', type: 'select', options: PRIO_OPTS, value: 'normal' },
    ], 'Создать', (v, close) => {
      if (!v.content.trim()) { toast('Введите текст', { kind: 'err' }); return; }
      close();
      run(async () => { if (await write('Создание заметки', () => lite.iterflow.createNote(activeProj, { content: v.content, priority: v.priority }), 'Заметка создана')) await loadNotes(); });
    });
  }
  function editNote(note) {
    formModal('Редактировать заметку', [
      { key: 'content', label: 'Текст', type: 'textarea', value: note.content || '' },
      { key: 'priority', label: 'Важность', type: 'select', options: PRIO_OPTS, value: note.priority || 'normal' },
      { key: 'status', label: 'Статус', type: 'select', options: NOTE_STATUS_OPTS, value: note.status || 'open' },
      { key: 'viewMode', label: 'Формат', type: 'select', options: VIEW_OPTS, value: note.viewMode || 'text' },
    ], 'Сохранить', (v, close) => {
      if (!v.content.trim()) { toast('Текст не может быть пустым', { kind: 'err' }); return; }
      close();
      run(async () => { if (await write('Сохранение заметки', () => lite.iterflow.updateNote(note.id, { content: v.content, priority: v.priority, status: v.status, viewMode: v.viewMode }), 'Сохранено')) await loadNotes(); });
    });
  }
  function removeNote(note) {
    showConfirm('Удалить заметку?', itemTitle(note) + '\nНеобратимо.', 'Удалить', () => {
      run(async () => { if (await write('Удаление заметки', () => lite.iterflow.deleteNote(note.id), 'Заметка удалена')) await loadNotes(); });
    });
  }

  // ---------------- рендер ----------------
  function renderBody() {
    const body = $('#iterflow-body');
    if (!body) return;
    body.innerHTML = '';
    if (!user) { body.appendChild(renderLogin()); return; }
    body.appendChild(renderWorkspace());
  }

  function renderLogin() {
    const wrap = el('div', 'if-login');
    wrap.appendChild(el('div', 'if-login-title', 'IterFlow'));
    wrap.appendChild(el('div', 'if-login-sub', 'Вход для исполнителя'));
    const email = el('input', 'if-input'); email.type = 'email'; email.placeholder = 'email'; email.autocomplete = 'username';
    const pass = el('input', 'if-input'); pass.type = 'password'; pass.placeholder = 'пароль'; pass.autocomplete = 'current-password';
    const btn = el('button', 'if-btn if-btn-primary', 'Войти');
    const submit = () => {
      const e = email.value.trim(), p = pass.value;
      if (!e || !p) { toast('Введите email и пароль', { kind: 'err' }); return; }
      run(() => doLogin(e, p));
    };
    btn.onclick = submit;
    pass.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
    wrap.append(email, pass, btn);
    if (busy) wrap.appendChild(el('div', 'if-hint', 'Подключаюсь…'));
    const reg = el('div', 'if-reg');
    reg.appendChild(el('span', null, 'Нет аккаунта? '));
    const link = el('a', 'if-link', 'Зарегистрироваться в IterFlow');
    link.href = '#';
    link.onclick = (ev) => {
      ev.preventDefault();
      if (lite.openExternal) lite.openExternal(IF_WEB);
      else { try { lite.copyText && lite.copyText(IF_WEB); } catch (_) {} toast('Ссылка скопирована: ' + IF_WEB); }
    };
    reg.appendChild(link);
    wrap.appendChild(reg);
    return wrap;
  }

  function renderWorkspace() {
    const root = el('div', 'if-ws');
    const cpVis = !!activeCtx, projVis = !!activeCp, contentVis = !!activeProj;

    const bar = el('div', 'if-selects');
    // 1) профиль — всегда виден.
    bar.appendChild(selectRow('Профиль', contexts.map((c) => ({ value: c.key, label: c.kind === 'solo' ? 'Соло · личное' : ('Команда · ' + c.label) })), activeCtx,
      (v) => run(() => selectCtx(v)), false, 'Выберите профиль'));
    // 2) заказчик — после выбора профиля.
    if (cpVis) {
      const row = selectRow('Заказчик', counterparties.map((c) => ({ value: c.id, label: cpLabel(c) })), activeCp,
        (v) => run(() => selectCp(v)), false, 'Выберите заказчика');
      if (!prevVis.cp) row.classList.add('if-fade');
      bar.appendChild(row);
    }
    // 3) проект — после выбора заказчика.
    if (projVis) {
      const row = selectRow('Проект', projects.map((p) => ({ value: p.id, label: p.title || p.code || p.id })), activeProj,
        (v) => run(() => selectProj(v)), false, 'Выберите проект');
      if (!prevVis.proj) row.classList.add('if-fade');
      bar.appendChild(row);
    }
    root.appendChild(bar);

    if (busy) root.appendChild(el('div', 'if-hint', 'Загрузка…'));

    // 4) контент (вкладки + данные) — после выбора проекта; исчезает при смене заказчика.
    if (contentVis) {
      const wrap = el('div', 'if-contentwrap');
      if (!prevVis.content) wrap.classList.add('if-fade');
      const tabs = el('div', 'if-tabs');
      for (const [id, lbl] of TABS) {
        const b = el('button', 'if-tab' + (tab === id ? ' active' : ''), lbl);
        b.onclick = () => {
          if (tab === id) return;
          tab = id;
          if (id === 'todo' && notes === null && activeProj) run(loadNotes);
          else if (id === 'chat' && messages === null && activeProj) run(loadMessages);
          else renderBody();
        };
        tabs.appendChild(b);
      }
      wrap.appendChild(tabs);
      const content = el('div', 'if-content');
      if (tab === 'iter') renderTimeline(content);
      else if (tab === 'kanban') renderKanban(content);
      else if (tab === 'todo') renderTodo(content);
      else if (tab === 'chat') renderChat(content);
      wrap.appendChild(content);
      root.appendChild(wrap);
    }

    prevVis = { cp: cpVis, proj: projVis, content: contentVis };
    return root;
  }

  function cpLabel(c) {
    if (c.isPersonalSpace) return 'Моё пространство';
    if (c.isTeamSpace) return 'Наше пространство';
    return c.name || c.peerNickname || c.peerName || c.peerEmail || c.id;
  }

  function selectRow(label, options, value, onChange, disabled, placeholder) {
    const row = el('div', 'if-selrow');
    row.appendChild(el('span', 'if-sellbl', label));
    const sel = el('select', 'if-select');
    if (disabled || !options.length) sel.disabled = true;
    const ph = el('option', null, placeholder || '— выберите —');
    ph.value = ''; ph.disabled = true; if (value == null) ph.selected = true;
    sel.appendChild(ph);
    for (const o of options) {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => { if (sel.value) onChange(sel.value); };
    row.appendChild(sel);
    return row;
  }

  // ---- вкладка «Итерация»: вертикальный таймлайн ----
  function renderTimeline(root) {
    const head = el('div', 'if-tab-actions');
    const add = el('button', 'if-btn if-btn-primary', '+ Итерация');
    if (projFrozen()) { add.disabled = true; add.title = 'Проект заморожен'; }
    add.onclick = addIteration;
    head.appendChild(add);
    root.appendChild(head);
    if (!iterations.length && !busy) { root.appendChild(el('div', 'if-empty', 'В проекте пока нет итераций.')); return; }
    const tl = el('div', 'if-tl');
    for (const it of iterations) tl.appendChild(renderTlRow(it));
    root.appendChild(tl);
  }

  // Панель действий итерации (зависит от стадии и роли). frozen → всё дизейблим.
  function renderIterActions(it) {
    const bar = el('div', 'if-iter-actions');
    const btn = (label, title, fn, primary) => {
      const b = el('button', 'if-mini' + (primary ? ' if-mini-primary' : ''), label);
      if (title) b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      bar.appendChild(b);
    };
    btn('дедлайн', 'Изменить дедлайн', () => editDeadline(it));
    if (it.stage === 'draft') {
      btn('+ задача', 'Добавить задачу', () => addTask(it), true);
      btn('переименовать', '', () => renameIteration(it));
      btn('на согласование', 'submit-scope', () => stageAction(it, 'submit-scope', 'На согласование', false));
      btn('удалить', '', () => removeIteration(it));
    } else if (it.stage === 'scope_review' && isSelfSpace()) {
      btn('согласовать', 'approve-scope', () => stageAction(it, 'approve-scope', 'Согласовать', false), true);
      btn('в черновик', 'reject-scope', () => stageAction(it, 'reject-scope', 'Вернуть в черновик', true));
    } else if (it.stage === 'active') {
      btn('сдать итерацию', 'submit-iteration', () => stageAction(it, 'submit-iteration', 'Сдать итерацию', false), true);
    } else if (it.stage === 'final_review' && isSelfSpace()) {
      btn('принять', 'accept-iteration', () => stageAction(it, 'accept-iteration', 'Принять итерацию', false), true);
      btn('в работу', 'reject-iteration', () => stageAction(it, 'reject-iteration', 'Вернуть в работу', true));
    }
    if (projFrozen()) bar.querySelectorAll('button').forEach((b) => { b.disabled = true; b.title = 'Проект заморожен'; });
    return bar;
  }

  function renderTlRow(it) {
    const row = el('div', 'if-tl-row');

    // Левая колонка — дата + линия с точкой.
    const left = el('div', 'if-tl-left');
    const d = tlDate(it.startsAt || it.createdAt);
    const dt = el('div', 'if-tl-date');
    dt.appendChild(el('span', 'if-tl-dm', d.dm));
    if (d.time) dt.appendChild(el('span', 'if-tl-time', d.time));
    dt.appendChild(el('span', 'if-tl-y', d.y));
    left.appendChild(dt);
    const line = el('div', 'if-tl-line');
    line.appendChild(el('span', 'if-tl-dot if-dot-' + (it.stage || 'draft')));
    left.appendChild(line);
    row.appendChild(left);

    // Правая колонка — сворачиваемая карточка итерации.
    const card = el('div', 'if-iter');
    const isCol = collapsed.has(it.id);
    const head = el('button', 'if-iter-head');
    head.appendChild(icon(isCol ? 'chevron-right' : 'chevron-down', 15));
    head.appendChild(el('span', 'if-iter-title', '№' + (it.number || '?') + (it.title ? ' · ' + it.title : '')));
    const st = STAGE[it.stage] || [it.stage || '—', 'if-st-draft'];
    head.appendChild(el('span', 'if-badge ' + st[1], st[0]));
    head.onclick = () => { if (collapsed.has(it.id)) collapsed.delete(it.id); else collapsed.add(it.id); renderBody(); };
    card.appendChild(head);

    if (!isCol) {
      if (it.deadline) card.appendChild(el('div', 'if-iter-meta', 'дедлайн: ' + fmtDate(it.deadline)));
      card.appendChild(renderIterActions(it));
      card.appendChild(renderTaskList(it));
    }
    row.appendChild(card);
    return row;
  }

  function renderTaskList(it) {
    const tasks = tasksByIter.get(it.id);
    const box = el('div', 'if-tasks');
    if (tasks === 'loading' || (tasks === undefined && busy)) box.appendChild(el('div', 'if-empty', 'Загрузка задач…'));
    else if (tasks && tasks.error) box.appendChild(el('div', 'if-empty if-err', 'Ошибка задач: ' + tasks.error));
    else if (!tasks || !tasks.length) box.appendChild(el('div', 'if-empty', 'Нет задач.'));
    else for (const t of tasks) box.appendChild(renderItemRow(t, 'task'));
    return box;
  }

  // Плашка задачи/заметки одной строкой (заголовок) + индикатор деталей +
  // подсветка по важности (левая полоса). Клик → модалка с подробностями.
  function renderItemRow(item, kind) {
    const row = el('div', 'if-item if-pr-' + (item.priority || 'normal'));
    row.appendChild(el('div', 'if-item-title', itemTitle(item)));
    const right = el('div', 'if-item-right');
    if (hasBody(item)) { const di = icon('note', 14); di.classList.add('if-item-detic'); di.title = 'есть содержимое'; right.appendChild(di); }
    if (kind === 'task' && item.kanbanStatus && item.kanbanStatus !== 'iteration') {
      right.appendChild(el('span', 'if-kchip if-kst-' + item.kanbanStatus, KANBAN_LABEL[item.kanbanStatus] || item.kanbanStatus));
    }
    row.appendChild(right);
    row.onclick = () => openItemModal(item, kind);
    return row;
  }

  function openItemModal(item, kind) {
    const { m, close } = makeModal('<div class="if-modal"></div>');
    const host = m.querySelector('.if-modal');
    const head = el('div', 'if-modal-head');
    head.appendChild(el('div', 'if-modal-title', itemTitle(item)));
    const x = iconBtn('icon-btn', 'x', 'Закрыть', 16); x.onclick = close; head.appendChild(x);
    host.appendChild(head);

    const meta = el('div', 'if-modal-meta');
    meta.appendChild(el('span', 'if-prchip if-pr-' + (item.priority || 'normal'), 'важность: ' + (PRIO[item.priority] || 'обычный')));
    if (kind === 'task' && item.kanbanStatus) meta.appendChild(el('span', 'if-badge if-kst-' + item.kanbanStatus, KANBAN_LABEL[item.kanbanStatus] || item.kanbanStatus));
    if (kind === 'task' && item.status) meta.appendChild(el('span', 'if-badge', TASK_STATUS[item.status] || item.status));
    if (kind === 'note' && item.ownerSide) meta.appendChild(el('span', 'if-badge', item.ownerSide === 'contractor' ? 'исполнитель' : 'заказчик'));
    if (item.dueDate) meta.appendChild(el('span', 'if-badge', 'до ' + fmtDate(item.dueDate)));
    host.appendChild(meta);

    host.appendChild(el('div', 'if-modal-content', item.content || '(без содержимого)'));

    // Действия (CRUD/жизненный цикл) — по стадии итерации (для задач) / авторству (для заметок).
    const acts = el('div', 'if-modal-acts');
    const mbtn = (label, fn, primary) => { const b = el('button', 'if-btn' + (primary ? ' if-btn-primary' : ''), label); b.onclick = fn; acts.appendChild(b); };
    if (kind === 'task') {
      const stage = (iterOf(item.iterationId) || {}).stage;
      const frozen = projFrozen();
      if (!frozen && (stage === 'active' || stage === 'scope_review')) mbtn(item.status === 'done' ? 'Снять «выполнено»' : 'Отметить выполненной', () => { close(); toggleDone(item); });
      if (!frozen && stage === 'draft') { mbtn('Редактировать', () => { close(); editTask(item); }, true); mbtn('Удалить', () => { close(); removeTask(item); }); }
    } else if (kind === 'note') {
      // Заметки правит/удаляет только автор; frozen на них не влияет (бэкенд разрешает).
      if (canEditNote(item)) { mbtn('Редактировать', () => { close(); editNote(item); }, true); mbtn('Удалить', () => { close(); removeNote(item); }); }
    }
    if (acts.children.length) host.appendChild(acts);
  }

  // ---- вкладка «Канбан»: плоский список задач выбранной итерации с inline
  //      статус-чипом (как mobile web IterFlow: селектор итерации + плоский
  //      список, тап по чипу → смена статуса через API; без колонок и drag). ----
  function renderKanban(root) {
    if (!iterations.length) { if (!busy) root.appendChild(el('div', 'if-empty', 'В проекте пока нет итераций.')); return; }
    if (!kanbanIterId || !iterations.find((i) => i.id === kanbanIterId)) kanbanIterId = (activeIteration() || iterations[0]).id;

    root.appendChild(selectRow('Итерация', iterations.map((it) => ({
      value: it.id,
      label: '№' + (it.number || '?') + (it.title ? ' · ' + it.title : '') + ' · ' + (STAGE[it.stage] ? STAGE[it.stage][0] : it.stage),
    })), kanbanIterId, (v) => { kanbanIterId = v; renderBody(); }));

    const it = iterations.find((i) => i.id === kanbanIterId);
    const tasks = tasksByIter.get(it.id);
    if (tasks === 'loading') { root.appendChild(el('div', 'if-empty', 'Загрузка…')); return; }
    if (tasks && tasks.error) { root.appendChild(el('div', 'if-empty if-err', 'Ошибка: ' + tasks.error)); return; }
    const list = Array.isArray(tasks) ? tasks : [];
    if (!list.length) { root.appendChild(el('div', 'if-empty', 'В итерации нет задач.')); return; }

    const canMove = it.stage === 'active';
    if (!canMove) root.appendChild(el('div', 'if-kb-hint', 'Смена статуса доступна, когда итерация «в работе».'));
    const box = el('div', 'if-kbflat');
    for (const t of list) box.appendChild(renderKbRow(t, canMove));
    root.appendChild(box);
  }

  // Плоская строка задачи: текст + статус-чип (select, цвет по статусу).
  function renderKbRow(t, canMove) {
    const row = el('div', 'if-kbf');
    row.appendChild(el('div', 'if-kbf-text', t.title || t.content || '(без названия)'));
    const cur = t.kanbanStatus || 'iteration';
    const sel = el('select', 'if-chip-sel if-kst-' + cur);
    if (!canMove) sel.disabled = true;
    for (const [code, lbl] of KANBAN_COLS) {
      const o = el('option', null, lbl); o.value = code;
      if (cur === code) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => run(() => changeKanban(t, sel.value));
    row.appendChild(sel);
    return row;
  }

  // ---- вкладка «Туду»: общие заметки проекта (project_notes, веб-cookie) ----
  function renderTodo(root) {
    const head = el('div', 'if-tab-actions');
    const add = el('button', 'if-btn if-btn-primary', '+ Заметка');
    add.onclick = addNote;
    head.appendChild(add);
    root.appendChild(head);
    if (notes === null) { root.appendChild(el('div', 'if-empty', busy ? 'Загрузка…' : '—')); return; }
    if (notes.error) { root.appendChild(loadErrorBox(notes, 'Туду')); return; }
    if (!notes.length) { root.appendChild(el('div', 'if-empty', 'Общих заметок в проекте нет.')); return; }
    const list = el('div', 'if-todo');
    for (const n of notes) list.appendChild(renderItemRow(n, 'note'));
    root.appendChild(list);
  }

  // ---- вкладка «Чат»: общий канал проекта (project_messages, веб-cookie, read-only) ----
  function renderChat(root) {
    if (messages === null) { root.appendChild(el('div', 'if-empty', busy ? 'Загрузка…' : '—')); return; }
    if (messages.error) { root.appendChild(loadErrorBox(messages, 'Чат')); return; }
    const items = (messages.items || []).slice().reverse(); // ответ DESC → показываем старые сверху
    if (!items.length) { root.appendChild(el('div', 'if-empty', 'В общем чате пока нет сообщений.')); return; }
    const box = el('div', 'if-chat');
    for (const m of items) {
      if (m.kind === 'system') { box.appendChild(el('div', 'if-msg-sys', m.content || m.systemEventType || 'событие')); continue; }
      const row = el('div', 'if-msg');
      const head = el('div', 'if-msg-head');
      head.appendChild(el('span', 'if-msg-name', m.senderName || 'участник'));
      head.appendChild(el('span', 'if-msg-time', fmtTime(m.createdAt)));
      row.appendChild(head);
      row.appendChild(el('div', 'if-msg-text', m.content || ''));
      box.appendChild(row);
    }
    root.appendChild(box);
    box.appendChild(el('div', 'if-chat-note', 'Только чтение · общий канал'));
  }

  function fmtTime(iso) { const s = String(iso || ''); const t = s.slice(11, 16); return s.slice(0, 10) + (t ? ' ' + t : ''); }

  // Ошибка загрузки туду/чата. Если протухла именно веб-сессия (web) — кнопка
  // перелогина: повторный вход заведёт cookie заново (двойной логин).
  function loadErrorBox(obj, label) {
    if (!obj.web) return el('div', 'if-empty if-err', 'Ошибка: ' + obj.error);
    const box = el('div', 'if-stub');
    box.appendChild(el('div', 'if-empty if-err', label + ' требует веб-сессию IterFlow.'));
    box.appendChild(el('div', 'if-hint', obj.error));
    const b = el('button', 'if-btn if-btn-primary', 'Войти заново');
    b.onclick = () => run(doLogout);
    box.appendChild(b);
    return box;
  }

  function fmtDate(iso) { return String(iso || '').slice(0, 10); }
  // Для таймлайна: { dm:'12 июн', y:'2026', time:'14:30' } — как на сайте (рус. месяцы + время, local).
  function tlDate(iso) {
    if (!iso) return { dm: '—', y: '', time: '' };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { dm: '—', y: '', time: '' };
    const two = (n) => String(n).padStart(2, '0');
    return { dm: d.getDate() + ' ' + MON[d.getMonth()], y: String(d.getFullYear()), time: two(d.getHours()) + ':' + two(d.getMinutes()) };
  }

  // ---------------- панель правого слота ----------------
  function setOpen(openNext, opts = {}) {
    if (openNext === open) { if (openNext) renderBody(); return; }
    if (openNext) closeOtherPanels('iterflow');
    const delta = layout.iterflow + GUTTER;
    open = openNext;
    $('#iterflow-pane').classList.toggle('hidden', !open);
    $('#gutter-iterflow').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) { renderBody(); if (!booted) boot(); }
    setTimeout(refitActiveTerminal, 150);
  }

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    renderPanel: () => { if (open) renderBody(); },
    logout: () => run(doLogout),
    refresh: () => { if (activeProj) run(() => selectProj(activeProj)); },
    openSite: () => { if (lite.openExternal) lite.openExternal(IF_WEB); },
  };
}
