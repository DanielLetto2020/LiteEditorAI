// LiteEditor — модуль «ИИ компания»: агент-директор + сабагенты над активным проектом.
// Концепция (вариант А): один процесс-ДИРЕКТОР (claude -p, stream-json) в корне проекта сам
// нанимает и зовёт сабагентов Claude (родная оркестровка — надёжнее самоделки). Видно живой
// лог директора, статусы сотрудников, доску-чеклист с прогрессом, историю прогонов и обзор
// изменений. Штат материализуется в .claude/agents/*.md; директор может нанять новых (подхват
// с диска). Память компании — .lite/company/notes.md. Шина — .lite/company/board.md.
// Изоляция по образцу audit.js/notes.js: ядро — только через host; UI — из ui.js; бэкенд — lite.*.
// host: { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, openInViewer }
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const PERMS = [
  ['acceptEdits', 'правки без подтверждения'],
  ['bypassPermissions', 'полная автономия'],
  ['plan', 'только план (ничего не менять)'],
];

// Каталог готовых ролей — «нанять из библиотеки» в один клик (помимо ручного создания).
const ROLE_PRESETS = [
  { name: 'architect', description: 'Проектирует структуру и архитектуру решения до написания кода.', model: '', tools: '', prompt: 'Ты — архитектор ИИ-компании. Спроектируй структуру решения: модули, файлы, интерфейсы, поток данных. Выдай чёткий план реализации для кодера. Сам код не пиши.' },
  { name: 'tester', description: 'Пишет автотесты и проверяет, что код работает.', model: '', tools: '', prompt: 'Ты — тестировщик ИИ-компании. Напиши автотесты на ключевую функциональность, запусти их и сообщи о падениях с конкретикой.' },
  { name: 'documenter', description: 'Пишет документацию и README.', model: '', tools: '', prompt: 'Ты — технический писатель ИИ-компании. Напиши понятную документацию/README: назначение, установка, запуск, примеры использования.' },
  { name: 'security', description: 'Ищет уязвимости и небезопасные места.', model: '', tools: '', prompt: 'Ты — безопасник ИИ-компании. Проверь изменения на уязвимости, утечки секретов и небезопасные паттерны. Дай список рисков с приоритетом.' },
  { name: 'refactorer', description: 'Улучшает структуру кода без смены поведения.', model: '', tools: '', prompt: 'Ты — рефакторер ИИ-компании. Улучши читаемость и структуру кода, не меняя поведение. Объясни, что и зачем изменил.' },
  { name: 'devops', description: 'Сборка, запуск, CI, контейнеры.', model: '', tools: '', prompt: 'Ты — девопс ИИ-компании. Настрой сборку/запуск/CI/контейнеризацию по необходимости. Дай команды запуска.' },
];

// Шаблоны целей — понижают порог входа («не знаю, что писать»).
const GOAL_TEMPLATES = [
  { label: 'Починить баг', text: 'Найди и исправь баг: <опиши симптом>. Воспроизведи проблему, поручи кодеру фикс, ревьюеру — проверку, тестировщику — тест на регрессию. Веди доску задач.' },
  { label: 'Добавить фичу', text: 'Реализуй новую функцию: <опиши>. Архитектор проектирует, кодер реализует, ревьюер проверяет, тестировщик пишет тесты. Веди доску и обнови README.' },
  { label: 'Написать тесты', text: 'Покрой проект автотестами на ключевую логику. Тестировщик пишет тесты и прогоняет их, ревьюер проверяет покрытие. Веди доску.' },
  { label: 'Рефакторинг', text: 'Отрефактори <файл/модуль> без изменения поведения. Рефакторер улучшает структуру, ревьюер проверяет, тестировщик подтверждает, что ничего не сломалось.' },
  { label: 'Аудит безопасности', text: 'Проведи аудит безопасности проекта. Безопасник ищет уязвимости и секреты, кодер чинит найденное, ревьюер проверяет фиксы. Итог — на доску.' },
];

function defaultData() {
  return {
    goal: '',
    director: { model: '' },     // '' = модель claude по умолчанию
    limitUsd: 0,                 // 0 = без лимита бюджета
    permission: 'acceptEdits',
    memoryOn: true,              // подмешивать память компании (.lite/company/notes.md)
    roles: [
      { name: 'coder', description: 'Пишет и правит код по задаче директора. Зови для реализации.', model: '', tools: '', prompt: 'Ты — инженер ИИ-компании. Аккуратно реализуй поставленную задачу в коде проекта, следуя стилю существующего кода. По завершении кратко отчитайся, что изменил.' },
      { name: 'reviewer', description: 'Проверяет изменения на ошибки и качество. Зови после кодера.', model: '', tools: '', prompt: 'Ты — ревьюер ИИ-компании. Проверь последние изменения на баги, регрессии и качество кода. Дай конкретный список замечаний либо подтверди, что всё хорошо.' },
    ],
    queue: [],                   // очередь целей (выполняются по очереди)
    history: [],                 // [{at, goal, cost, ok}] — прогоны
  };
}
function newReqId() { return 'co' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function hhmm(ts) { const d = new Date(ts || Date.now()); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

export function initCompany(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, openInViewer } = host;

  let companyOpen = false;
  let histOpen = false;                 // раскрыта ли «История прогонов»
  const dataByProj = new Map();         // projId → data (штат/настройки/очередь/история)
  const runByProj = new Map();          // projId → состояние прогона

  function curProj() { return activeProject(); }
  function getRun(id) {
    let r = runByProj.get(id);
    if (!r) { r = { reqId: null, running: false, planMode: false, stoppedByUser: false, lines: [], cost: 0, board: '', disk: [], statuses: {}, pending: {}, startedAt: 0, pollT: null }; runByProj.set(id, r); }
    return r;
  }

  // ---------------- данные ----------------
  async function loadData(projId) {
    if (dataByProj.has(projId)) return dataByProj.get(projId);
    let d = null;
    try { d = await lite.company.getData(projId); } catch (_) {}
    if (!d || !Array.isArray(d.roles)) d = defaultData();
    if (!Array.isArray(d.queue)) d.queue = [];
    if (!Array.isArray(d.history)) d.history = [];
    if (typeof d.memoryOn !== 'boolean') d.memoryOn = true;
    dataByProj.set(projId, d);
    return d;
  }
  async function saveData(projId) {
    const d = dataByProj.get(projId); if (!d) return;
    const r = await lite.company.setData(projId, d);
    if (r && r.ok === false) toast('Не сохранить настройки: ' + (r.error || ''), { kind: 'err' });
  }
  async function refreshDisk(p) { if (!p) return; try { const r = await lite.company.listRoles(p.path); getRun(p.id).disk = (r && r.roles) || []; } catch (_) {} }
  async function refreshBoard(p) { if (!p) return; try { const r = await lite.company.boardGet(p.path); getRun(p.id).board = (r && r.text) || ''; } catch (_) {} }

  // ---------------- запуск директора ----------------
  function run(p, opts = {}) {
    const d = dataByProj.get(p.id); if (!d) return;
    if (!(d.goal || '').trim()) { toast('Сначала задайте цель компании'); return; }
    const st = getRun(p.id);
    if (st.running) { toast('Компания уже работает'); return; }
    st.reqId = newReqId(); st.running = true; st.planMode = !!opts.plan; st.stoppedByUser = false;
    st.lines = []; st.cost = 0; st.statuses = {}; st.pending = {}; st.startedAt = Date.now();
    pushLine(p.id, st.planMode ? 'tool' : 'boss', (st.planMode ? '[План] ' : '') + 'Директор запущен — цель: ' + d.goal.trim());
    lite.company.run({
      reqId: st.reqId, projPath: p.path, goal: d.goal.trim(), roles: d.roles,
      director: d.director, limitUsd: d.limitUsd, memoryOn: d.memoryOn,
      permission: st.planMode ? 'plan' : d.permission,
    });
    startPoll(p);
    if (companyOpen) renderBody();
  }
  function stop(p) {
    const st = getRun(p.id);
    st.stoppedByUser = true;
    if (st.reqId) lite.company.stop(st.reqId);
    st.reqId = null;                  // отвязываем — kill-induced onDone не должен пере-войти в finishRun
    st.running = false; stopPoll(p.id);
    pushLine(p.id, 'tool', 'Остановлено владельцем');
    if (companyOpen) renderControls();
  }
  function startPoll(p) {
    const st = getRun(p.id);
    stopPoll(p.id);
    st.pollT = setInterval(async () => {            // подхватываем нанятых директором + доску по ходу
      await refreshDisk(p); await refreshBoard(p);
      if (companyOpen && curProj() && curProj().id === p.id) { renderTeam(); renderBoard(); }
    }, 3000);
  }
  function stopPoll(projId) { const st = runByProj.get(projId); if (st && st.pollT) { clearInterval(st.pollT); st.pollT = null; } }

  function pushLine(projId, kind, text, sub) {
    const st = getRun(projId);
    st.lines.push({ kind, text, sub, ts: Date.now() });
    if (st.lines.length > 600) st.lines.shift();
    if (companyOpen && curProj() && curProj().id === projId) appendLogLine(st.lines[st.lines.length - 1]);
  }

  // Разбор события stream-json в строки лога + статусы сотрудников.
  function onEvent(projId, ev) {
    if (!ev || typeof ev !== 'object') return;
    const st = getRun(projId);
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) pushLine(projId, 'boss', c.text.trim());
        else if (c.type === 'tool_use') onToolUse(projId, c);
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      // сабагент вернул результат → отметить «готов»
      for (const c of ev.message.content) {
        if (c.type === 'tool_result' && c.tool_use_id && st.pending[c.tool_use_id]) {
          const who = st.pending[c.tool_use_id]; delete st.pending[c.tool_use_id];
          st.statuses[who] = 'done';
          if (companyOpen && curProj() && curProj().id === projId) renderTeam();
        }
      }
    } else if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') st.cost = ev.total_cost_usd;
    }
  }
  function onToolUse(projId, c) {
    const st = getRun(projId);
    const name = c.name || '';
    const inp = c.input || {};
    const fp = typeof inp.file_path === 'string' ? inp.file_path.replace(/\\/g, '/') : ''; // нормализуем пути (Windows backslash)
    if (name === 'Task' || name === 'Agent') {
      const who = inp.subagent_type || inp.agent || 'сотрудник';
      if (c.id) st.pending[c.id] = who;
      st.statuses[who] = 'working';
      if (companyOpen && curProj() && curProj().id === projId) renderTeam();
      pushLine(projId, 'hire', '→ ' + who, (inp.description || inp.prompt || '').toString().slice(0, 160));
    } else if (name === 'Write' && fp.includes('.claude/agents/')) {
      const nm = fp.split('/').pop().replace(/\.md$/, '');
      pushLine(projId, 'hire', 'Нанял нового сотрудника: ' + nm);
    } else if ((name === 'Write' || name === 'Edit') && fp.includes('board.md')) {
      pushLine(projId, 'tool', 'Обновил доску задач');
    } else if (name) {
      pushLine(projId, 'tool', name + (fp ? ' · ' + fp : ''));
    }
  }

  // Завершение прогона: история, авто-переход к следующей цели из очереди.
  function finishRun(projId, error) {
    const st = getRun(projId);
    if (!st.reqId) return;                          // уже завершён (защита от двойного terminal-события)
    const d = dataByProj.get(projId);
    const wasPlan = st.planMode, wasStopped = st.stoppedByUser, runGoal = (d && d.goal) || '';
    st.reqId = null; st.running = false; stopPoll(projId);
    for (const k of Object.keys(st.statuses)) if (st.statuses[k] === 'working') st.statuses[k] = 'done';
    if (d && !wasPlan) {                            // план-прогоны в историю не пишем
      d.history.unshift({ at: st.startedAt || Date.now(), goal: runGoal, cost: st.cost || 0, ok: !error });
      if (d.history.length > 30) d.history.length = 30;
      saveData(projId);
    }
    const p = curProj();
    if (p && p.id === projId) { refreshDisk(p).then(() => renderTeam()); refreshBoard(p).then(() => renderBoard()); renderControls(); renderHistory(); }
    // очередь: следующая цель, только если проект активен и прогон не остановлен вручную (иначе цель не теряем)
    const pp = p && p.id === projId ? p : null;
    if (d && pp && !wasStopped && !wasPlan && d.queue.length) {
      d.goal = d.queue.shift(); saveData(projId);
      renderBody(); setTimeout(() => run(pp), 400);
    }
  }

  // ---------------- рендер ----------------
  function renderBody() {
    const body = $('#company-body');
    if (!body) return;
    const p = curProj();
    const title = $('#company-proj');
    if (title) title.textContent = p ? ('Компания — ' + p.name) : 'ИИ компания';
    body.innerHTML = '';
    if (!p) { body.appendChild(el('div', 'co-empty', 'Откройте проект слева, чтобы собрать над ним ИИ-компанию.')); return; }

    body.appendChild(renderTemplates(p));
    body.appendChild(renderGoal(p));
    body.appendChild(renderQueue(p));
    body.appendChild(el('div', 'co-h', 'Штат'));
    body.appendChild(teamRow(p));
    body.appendChild(el('div', 'co-h', 'Лог директора'));
    body.appendChild(logBox(p));
    body.appendChild(el('div', 'co-h', 'Доска задач'));
    body.appendChild(boardBox(p));
    body.appendChild(footerBar(p));
    body.appendChild(historyBox(p));
  }

  // Шаблоны целей (чипы). Во время прогона не дать перетереть цель (иначе история запишет не то).
  function renderTemplates(p) {
    const row = el('div', 'co-tpls');
    const running = getRun(p.id).running;
    for (const t of GOAL_TEMPLATES) {
      const c = el('button', 'co-tpl', t.label);
      c.title = 'Подставить шаблон цели';
      c.disabled = running;
      c.onclick = () => { if (getRun(p.id).running) return; const d = dataByProj.get(p.id); if (!d) return; d.goal = t.text; saveData(p.id); renderBody(); };
      row.appendChild(c);
    }
    return row;
  }

  function renderGoal(p) {
    const d = dataByProj.get(p.id) || defaultData();
    const st = getRun(p.id);
    const wrap = el('div', 'co-goal'); wrap.id = 'co-goal';
    const ta = el('textarea');
    ta.placeholder = 'Цель компании — что должна сделать команда над этим проектом…';
    ta.value = d.goal || '';
    ta.disabled = st.running;
    ta.oninput = () => { d.goal = ta.value; };
    ta.onblur = () => saveData(p.id);
    wrap.appendChild(ta);

    const row = el('div', 'co-runrow');
    if (st.running) {
      const b = el('button', 'co-run stop'); b.append(icon('stop', 15), el('span', null, st.planMode ? 'Остановить план' : 'Остановить'));
      b.onclick = () => stop(p);
      row.appendChild(b);
    } else {
      const b = el('button', 'co-run'); b.append(icon('play', 15), el('span', null, 'Запустить'));
      b.onclick = () => { saveData(p.id); run(p); };
      row.appendChild(b);
      const pl = el('button', 'co-run ghost'); pl.append(icon('flag', 14), el('span', null, 'План'));
      pl.title = 'Сухой прогон: директор только спланирует и распишет доску, ничего не меняя на диске';
      pl.onclick = () => { saveData(p.id); run(p, { plan: true }); };
      row.appendChild(pl);
      const q = iconBtn('co-iconbtn', 'plus', 'Добавить цель в очередь', 15);
      q.onclick = () => addToQueue(p);
      row.appendChild(q);
    }
    const cost = el('div', 'co-cost', st.cost ? ('≈ $' + st.cost.toFixed(3)) : (d.limitUsd ? ('лимит $' + d.limitUsd) : ''));
    row.appendChild(cost);
    wrap.appendChild(row);
    return wrap;
  }
  function renderControls() {            // перерисовать блок цели/кнопок/стоимости
    const p = curProj(); if (!p || !companyOpen) return;
    const old = $('#co-goal'); if (old) old.replaceWith(renderGoal(p));
  }

  // Очередь целей.
  function addToQueue(p) {
    const d = dataByProj.get(p.id); if (!d) return;
    const g = (d.goal || '').trim();
    if (!g) { toast('Пустая цель'); return; }
    d.queue.push(g); d.goal = ''; saveData(p.id); renderBody();
    toast('Цель добавлена в очередь');
  }
  function renderQueue(p) {
    const d = dataByProj.get(p.id) || defaultData();
    const wrap = el('div', 'co-queue'); wrap.id = 'co-queue';
    if (!d.queue.length) return wrap;
    wrap.appendChild(el('div', 'co-h', 'Очередь целей · ' + d.queue.length));
    d.queue.forEach((g, i) => {
      const row = el('div', 'co-qrow');
      row.appendChild(el('span', 'co-qn', String(i + 1)));
      row.appendChild(el('span', 'co-qtext', g));
      const x = iconBtn('co-fact', 'x', 'Убрать из очереди', 13);
      x.onclick = () => { d.queue.splice(i, 1); saveData(p.id); renderBody(); };
      row.appendChild(x);
      wrap.appendChild(row);
    });
    return wrap;
  }

  // Штат: директор (сессия) + роли-сотрудники + нанятые с диска (пунктиром), со статусами.
  function teamRow(p) { const row = el('div', 'co-team'); row.id = 'co-team'; fillTeam(row, p); return row; }
  function renderTeam() { const row = $('#co-team'); const p = curProj(); if (row && p) { row.innerHTML = ''; fillTeam(row, p); } }
  function fillTeam(row, p) {
    const d = dataByProj.get(p.id) || defaultData();
    const st = getRun(p.id);
    const boss = el('div', 'co-chip boss'); boss.append(el('span', 'co-dot'), el('span', null, 'директор'));
    boss.title = 'Главный агент (claude). Нанимает и координирует сотрудников.';
    row.appendChild(boss);
    const known = new Set();
    for (const r of d.roles) { known.add(r.name); row.appendChild(chip(r.name, r.description, false, st.statuses[r.name])); }
    for (const r of st.disk) { if (!known.has(r.name)) row.appendChild(chip(r.name, r.description, true, st.statuses[r.name])); }
    const add = iconBtn('co-chip', 'sliders', 'Настроить штат', 13);
    add.onclick = openSettings; row.appendChild(add);
  }
  function chip(name, desc, hired, status) {
    const c = el('div', 'co-chip' + (hired ? ' hired' : '') + (status ? ' st-' + status : ''));
    const dot = el('span', 'co-sdot'); c.appendChild(dot);
    c.appendChild(el('span', null, name));
    const stTxt = status === 'working' ? ' — работает' : status === 'done' ? ' — готов' : '';
    c.title = (hired ? '(нанят директором) ' : '') + (desc || '') + stTxt;
    return c;
  }

  function logBox(p) {
    const box = el('div', 'co-log'); box.id = 'co-log';
    const st = getRun(p.id);
    if (!st.lines.length) box.appendChild(el('div', 'co-empty', st.running ? 'Директор думает…' : 'Задайте цель и нажмите «Запустить» — здесь пойдёт живой лог работы команды.'));
    else for (const ln of st.lines) box.appendChild(logLineEl(ln));
    return box;
  }
  function logLineEl(ln) {
    const wrap = el('div', 'co-lwrap');
    const row = el('div', 'co-line ' + (ln.kind || ''));
    row.appendChild(el('span', 'co-time', hhmm(ln.ts)));
    const ic = el('span', 'co-ic');
    ic.appendChild(icon(ln.kind === 'hire' ? 'users' : ln.kind === 'tool' ? 'wrench' : ln.kind === 'err' ? 'warning' : 'chat', 13));
    row.appendChild(ic);
    const t = el('div', 'co-txt'); t.textContent = ln.text;
    row.appendChild(t);
    wrap.appendChild(row);
    if (ln.sub) wrap.appendChild(el('div', 'co-sub', ln.sub));
    return wrap;
  }
  function appendLogLine(ln) {
    const box = $('#co-log'); if (!box) return;
    const empty = box.querySelector('.co-empty'); if (empty) box.innerHTML = '';
    box.appendChild(logLineEl(ln));
    box.scrollTop = box.scrollHeight;
  }

  // Доска: markdown-чеклист → интерактивный список + прогресс-бар.
  function parseBoard(txt) {
    const items = [];
    for (const ln of (txt || '').split('\n')) {
      const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(ln);
      if (m) items.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim() });
    }
    return items;
  }
  function boardBox(p) { const box = el('div', 'co-board'); box.id = 'co-board'; fillBoard(box, p); return box; }
  function renderBoard() { const box = $('#co-board'); const p = curProj(); if (box && p) fillBoard(box, p); }
  function fillBoard(box, p) {
    box.innerHTML = '';
    const txt = getRun(p.id).board || '';
    const items = parseBoard(txt);
    if (items.length) {
      const done = items.filter((x) => x.done).length;
      const head = el('div', 'co-bhead');
      head.appendChild(el('span', 'co-bcount', done + ' / ' + items.length));
      const track = el('div', 'co-bar-track'); const fill = el('div', 'co-bar-fill');
      fill.style.width = Math.round(done / items.length * 100) + '%'; track.appendChild(fill);
      head.appendChild(track);
      box.appendChild(head);
      const list = el('div', 'co-checks');
      for (const it of items) {
        const r = el('div', 'co-check' + (it.done ? ' done' : ''));
        r.append(icon(it.done ? 'check' : 'star', 13), el('span', 'co-check-t', it.text));
        list.appendChild(r);
      }
      box.appendChild(list);
    } else {
      const raw = el('div', 'co-board-raw' + (txt.trim() ? '' : ' empty'));
      raw.textContent = txt.trim() || 'Доска появится, когда директор начнёт распределять задачи.';
      box.appendChild(raw);
    }
  }

  // Низ: обзор изменений + память компании.
  function footerBar(p) {
    const bar = el('div', 'co-footer');
    const diff = el('button', 'co-fbtn'); diff.append(icon('diff', 14), el('span', null, 'Изменения'));
    diff.title = 'Что компания изменила в проекте (git diff)';
    diff.onclick = () => showDiff(p);
    const mem = el('button', 'co-fbtn'); mem.append(icon('note', 14), el('span', null, 'Память'));
    mem.title = 'Память компании: уроки и договорённости (.lite/company/notes.md)';
    mem.onclick = () => showMemory(p);
    bar.append(diff, mem);
    return bar;
  }

  // История прогонов (сворачиваемая).
  function historyBox(p) { const box = el('div', 'co-hist'); box.id = 'co-hist'; fillHistory(box, p); return box; }
  function renderHistory() { const box = $('#co-hist'); const p = curProj(); if (box && p) fillHistory(box, p); }
  function fillHistory(box, p) {
    box.innerHTML = '';
    const d = dataByProj.get(p.id) || defaultData();
    const total = d.history.reduce((s, h) => s + (h.cost || 0), 0);
    const head = el('button', 'co-hist-head');
    head.append(icon(histOpen ? 'chevron-down' : 'chevron-right', 14),
      el('span', null, 'История прогонов · ' + d.history.length),
      el('span', 'co-hist-total', total ? ('всего ≈ $' + total.toFixed(2)) : ''));
    head.onclick = () => { histOpen = !histOpen; renderHistory(); };
    box.appendChild(head);
    if (!histOpen) return;
    if (!d.history.length) { box.appendChild(el('div', 'co-empty', 'Прогонов ещё не было.')); return; }
    const list = el('div', 'co-hist-list');
    for (const h of d.history) {
      const r = el('div', 'co-hrow' + (h.ok ? '' : ' err'));
      r.appendChild(icon(h.ok ? 'check' : 'warning', 13));
      r.appendChild(el('span', 'co-htime', new Date(h.at).toLocaleString('ru-RU').replace(',', '')));
      r.appendChild(el('span', 'co-hgoal', (h.goal || '').slice(0, 80)));
      r.appendChild(el('span', 'co-hcost', h.cost ? ('$' + h.cost.toFixed(3)) : ''));
      r.title = h.goal || '';
      list.appendChild(r);
    }
    box.appendChild(list);
    const clr = el('button', 'co-fbtn'); clr.append(icon('eraser', 13), el('span', null, 'Очистить историю'));
    clr.onclick = () => { showConfirm('Очистить историю', 'Удалить все записи о прогонах?', 'Очистить', () => { d.history = []; saveData(p.id); renderHistory(); }); };
    box.appendChild(clr);
  }

  // ---------------- модалки ----------------
  // Обзор изменений (git diff).
  async function showDiff(p) {
    const r = await lite.company.diff(p.path);
    if (!r || r.ok === false) { toast('Не удалось получить изменения: ' + ((r && r.error) || ''), { kind: 'err' }); return; }
    const { m, close } = makeModal('<h2 class="co-mtitle"></h2><div id="cof"></div>');
    m.classList.add('co-modal');
    m.querySelector('.co-mtitle').textContent = 'Изменения в проекте — ' + p.name;
    const root = m.querySelector('#cof');
    if (!(r.files && r.files.length)) { root.appendChild(el('div', 'co-empty', 'Изменений нет (рабочее дерево чистое).')); }
    else {
      root.appendChild(el('div', 'co-h', 'Файлы (' + r.files.length + ') — клик откроет в вивере'));
      const list = el('div', 'co-difffiles');
      for (const f of r.files) {
        const row = el('button', 'co-diffrow', f);
        row.onclick = () => { const sep = p.path.includes('\\') ? '\\' : '/'; openInViewer && openInViewer(p.path.replace(/[\/]+$/, '') + sep + f.split('/').join(sep)); close(); };
        list.appendChild(row);
      }
      root.appendChild(list);
      if (r.stat && r.stat.trim()) { const pre = el('pre', 'co-diffstat'); pre.textContent = r.stat.trim(); root.appendChild(pre); }
    }
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '12px';
    const ok = el('button', 'btn primary', 'Закрыть'); ok.onclick = close;
    acts.appendChild(ok); root.appendChild(acts);
  }

  // Память компании.
  async function showMemory(p) {
    const r = await lite.company.notesGet(p.path);
    const { m, close } = makeModal('<h2 class="co-mtitle"></h2><div id="cof"></div>');
    m.classList.add('co-modal');
    m.querySelector('.co-mtitle').textContent = 'Память компании — ' + p.name;
    const root = m.querySelector('#cof');
    root.appendChild(el('div', 'co-field-hint', 'Уроки, стек проекта и договорённости. Директор читает это перед работой и дополняет по итогам прогона.'));
    const ta = el('textarea'); ta.style.minHeight = '220px'; ta.value = (r && r.text) || '';
    root.appendChild(ta);
    const acts = el('div', 'gm-actions'); acts.style.marginTop = '12px';
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => { const res = await lite.company.notesSet(p.path, ta.value); if (res && res.ok === false) { toast('Не сохранить: ' + (res.error || ''), { kind: 'err' }); return; } close(); toast('Память сохранена'); };
    acts.append(cancel, save); root.appendChild(acts);
  }

  // Настройки штата.
  function openSettings() {
    const p = curProj(); if (!p) { toast('Сначала откройте проект'); return; }
    const d = dataByProj.get(p.id) || defaultData();
    const { m, close } = makeModal('<h2 class="co-mtitle"></h2><div id="cof"></div>');
    m.classList.add('co-modal');
    m.querySelector('.co-mtitle').textContent = 'Штат и настройки — ' + p.name;
    const root = m.querySelector('#cof');

    const gen = el('div', 'co-field'); gen.append(el('label', null, 'Модель директора (пусто = claude по умолчанию)'));
    const dm = el('input'); dm.placeholder = 'например, opus / sonnet'; dm.value = (d.director && d.director.model) || '';
    gen.appendChild(dm); root.appendChild(gen);

    const lim = el('div', 'co-field'); lim.append(el('label', null, 'Лимит бюджета, $ (0 = без лимита)'));
    const li = el('input'); li.type = 'number'; li.min = '0'; li.step = '0.5'; li.value = String(d.limitUsd || 0);
    lim.appendChild(li); root.appendChild(lim);

    const perm = el('div', 'co-field'); perm.append(el('label', null, 'Права директора на изменения'));
    const ps = el('select');
    for (const [v, lbl] of PERMS) { const o = el('option', null, lbl); o.value = v; if (d.permission === v) o.selected = true; ps.appendChild(o); }
    perm.appendChild(ps); root.appendChild(perm);

    const memWrap = el('label', 'co-check');
    const mem = el('input'); mem.type = 'checkbox'; mem.checked = d.memoryOn !== false;
    memWrap.append(mem, document.createTextNode(' Подмешивать память компании в задачу директора'));
    root.appendChild(memWrap);

    root.appendChild(el('div', 'co-h', 'Сотрудники (роли-сабагенты)'));
    const list = el('div', 'co-roles');
    const draft = d.roles.map((r) => ({ ...r }));
    function redraw() {
      list.innerHTML = '';
      draft.forEach((r, i) => list.appendChild(roleCard(r, () => { draft.splice(i, 1); redraw(); })));
      if (!draft.length) list.appendChild(el('div', 'co-empty', 'Нет сотрудников — директору придётся нанимать всех с нуля.'));
    }
    redraw();
    root.appendChild(list);

    // библиотека пресетов: «нанять» в один клик
    const lib = el('div', 'co-lib'); lib.appendChild(el('div', 'co-field-hint', 'Нанять из библиотеки:'));
    const libRow = el('div', 'co-lib-row');
    for (const pr of ROLE_PRESETS) {
      const b = el('button', 'co-tpl'); b.append(icon('plus', 12), el('span', null, pr.name));
      b.title = pr.description;
      b.onclick = () => { if (draft.some((x) => x.name === pr.name)) { toast('Уже в штате'); return; } draft.push({ ...pr }); redraw(); };
      libRow.appendChild(b);
    }
    lib.appendChild(libRow); root.appendChild(lib);

    const addBtn = el('button', 'co-run ghost'); addBtn.append(icon('plus', 14), el('span', null, 'Пустой сотрудник'));
    addBtn.style.marginTop = '6px';
    addBtn.onclick = () => { draft.push({ name: 'worker' + (draft.length + 1), description: '', model: '', tools: '', prompt: '' }); redraw(); };
    root.appendChild(addBtn);

    const acts = el('div', 'gm-actions'); acts.style.marginTop = '12px';
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => {
      const seen = new Set();
      for (const r of draft) {
        r.name = (r.name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!r.name) { toast('У сотрудника пустое имя', { kind: 'err' }); return; }
        if (seen.has(r.name)) { toast('Повтор имени: ' + r.name, { kind: 'err' }); return; }
        seen.add(r.name);
      }
      d.director = { model: dm.value.trim() };
      d.limitUsd = Math.max(0, parseFloat(li.value) || 0);
      d.permission = ps.value;
      d.memoryOn = mem.checked;
      d.roles = draft;
      dataByProj.set(p.id, d);
      await saveData(p.id);
      close();
      renderBody();
    };
    acts.append(cancel, save); root.appendChild(acts);
  }
  function roleCard(r, onDel) {
    const card = el('div', 'co-role');
    const top = el('div', 'co-role-top');
    const nm = el('input'); nm.value = r.name || ''; nm.placeholder = 'имя (англ., через дефис)'; nm.oninput = () => { r.name = nm.value; };
    top.appendChild(nm);
    const md = el('input'); md.value = r.model || ''; md.placeholder = 'модель (опц.)'; md.style.flex = '0 0 130px'; md.oninput = () => { r.model = md.value; };
    top.appendChild(md);
    const del = iconBtn('icon-btn', 'trash', 'Удалить сотрудника', 14); del.onclick = onDel; top.appendChild(del);
    card.appendChild(top);
    const df = el('div', 'co-field'); df.append(el('label', null, 'Когда звать (description)'));
    const de = el('input'); de.value = r.description || ''; de.placeholder = 'кратко: за что отвечает и когда вызывать'; de.oninput = () => { r.description = de.value; };
    df.appendChild(de); card.appendChild(df);
    const pf = el('div', 'co-field'); pf.append(el('label', null, 'Инструкция роли (системный промпт)'));
    const pe = el('textarea'); pe.value = r.prompt || ''; pe.oninput = () => { r.prompt = pe.value; };
    pf.appendChild(pe); card.appendChild(pf);
    return card;
  }

  // ---------------- панель (контракт setOpen) ----------------
  function setCompanyOpen(open, opts = {}) {
    if (open && !curProj() && !opts.allowEmpty) { toast('Сначала откройте проект'); return; }
    if (open === companyOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('company');
    const delta = layout.company + GUTTER;
    companyOpen = open;
    $('#company-pane').classList.toggle('hidden', !open);
    $('#gutter-company').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleCompany() { setCompanyOpen(!companyOpen); }

  async function renderPanel() {
    if (!companyOpen) return;
    const p = curProj();
    if (p) { await loadData(p.id); await refreshDisk(p); await refreshBoard(p); }
    renderBody();
  }

  // глобальные подписки на поток директора (фильтр по reqId активного прогона проекта)
  lite.company.onEvent(({ reqId, ev }) => {
    for (const [projId, st] of runByProj) if (st.reqId === reqId) { onEvent(projId, ev); break; }
  });
  lite.company.onDone(({ reqId, error }) => {
    for (const [projId, st] of runByProj) if (st.reqId === reqId) {
      if (error) pushLine(projId, 'err', 'Ошибка: ' + error);
      else pushLine(projId, 'boss', 'Готово.');
      finishRun(projId, error);
      break;
    }
  });
  lite.company.onError(({ reqId, error }) => {
    for (const [projId, st] of runByProj) if (st.reqId === reqId) {
      pushLine(projId, 'err', 'Ошибка запуска: ' + error);
      finishRun(projId, error || 'ошибка запуска');
      break;
    }
  });

  return {
    isOpen: () => companyOpen,
    setOpen: setCompanyOpen,
    toggle: toggleCompany,
    renderPanel,
    openSettings,
  };
}
