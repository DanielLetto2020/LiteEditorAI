// LiteEditor — модуль «Помодоро»: пульт техники работы/отдыха + статистика привычки.
// Движок таймера живёт в main (lite.pomodoro.*) — отсчёт переживает закрытие этого окна.
// Здесь: прогресс-кольцо текущей фазы, выбор/CRUD техник, импорт-экспорт техник, дневная цель,
// история (счётчик за сегодня, серия дней, бары за 7 дней), переключатели звука/уведомлений.
// Состояние тика прилетает из main (onTick); журнал завершённых помидоров — pomodoro.history()
// (его пишет main, ключ pomodoroLog), живые обновления — onLogChanged. Конфиг (свои техники,
// выбор, цель, флаги) — STORE.pomodoro, пишет рендерер.
// Изолирован по образцу audit.js: всё из ядра — только через host/window.lite, UI — из ui.js.
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// Стандартные техники (несменяемые). Минуты; cyclesBeforeLong — рабочих интервалов до длинного перерыва.
const BUILTIN = [
  { id: 'classic', name: 'Классическая', work: 25, short: 5, long: 15, cyclesBeforeLong: 4, block: true, allowSkip: true, builtin: true },
  { id: '5217', name: '52 / 17', work: 52, short: 17, long: 17, cyclesBeforeLong: 4, block: true, allowSkip: true, builtin: true },
  { id: 'ultradian', name: 'Ультрадианная 90 / 20', work: 90, short: 20, long: 20, cyclesBeforeLong: 1, block: true, allowSkip: true, builtin: true },
];

const PHASE_LABEL = { idle: 'Не запущено', work: 'Работа', short: 'Короткий перерыв', long: 'Длинный перерыв' };
const WEEKDAY = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function clampNum(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; }
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

// Кольцо прогресса: SVG-окружность + центр (значение + подпись). fraction 0..1.
function ring(fraction, centerVal, centerSub, cls) {
  const R = 52, C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(1, fraction || 0)));
  const wrap = el('div', 'pm-ring' + (cls ? ' ' + cls : ''));
  wrap.innerHTML = `<svg viewBox="0 0 120 120" class="pm-ring-svg" aria-hidden="true">
    <circle class="pm-ring-bg" cx="60" cy="60" r="${R}"/>
    <circle class="pm-ring-fg" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
  </svg>`;
  const center = el('div', 'pm-ring-center');
  center.appendChild(el('div', 'pm-ring-val', centerVal));
  if (centerSub) center.appendChild(el('div', 'pm-ring-sub', centerSub));
  wrap.appendChild(center);
  return wrap;
}

export function initPomodoro(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  let paneOpen = false;
  let live = { running: false, paused: false, phase: 'idle', remaining: 0, total: 1, cycle: 0, tech: null };
  let logCache = [];
  let unsubTick = null, unsubLog = null;

  // ---------------- конфиг (свои техники + выбор + цель + флаги) ----------------
  const persisted = (host.STORE && host.STORE.pomodoro) || {};
  const state = {
    customs: Array.isArray(persisted.customs) ? persisted.customs : [],
    selectedId: persisted.selectedId || 'classic',
    goal: Number.isFinite(persisted.goal) ? persisted.goal : 8,
    soundOn: persisted.soundOn !== false,
    notifyOn: persisted.notifyOn !== false,
    compact: !!persisted.compact,
  };
  function save() {
    host.persist('pomodoro', {
      customs: state.customs, selectedId: state.selectedId,
      goal: state.goal, soundOn: state.soundOn, notifyOn: state.notifyOn, compact: state.compact,
    });
  }
  function allTechs() { return BUILTIN.concat(state.customs); }
  function findTech(id) { return allTechs().find((t) => t.id === id) || null; }

  // ---------------- движок (через main) ----------------
  async function start(tech) {
    if (!tech) return;
    state.selectedId = tech.id; save();
    const r = await lite.pomodoro.start(tech);
    if (r && r.ok === false) { toast('Не удалось запустить: ' + (r.error || ''), { kind: 'err' }); return; }
  }
  async function refreshLive() { try { live = await lite.pomodoro.getState() || live; } catch (_) {} renderBody(); }
  async function refreshHistory() { try { logCache = await lite.pomodoro.history() || []; } catch (_) { logCache = []; } renderBody(); }

  // ---------------- производные метрики истории ----------------
  function todayCount() {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    return logCache.filter((r) => r.ts >= base.getTime()).length;
  }
  function streakDays() {
    const days = new Set(logCache.map((r) => dayKey(r.ts)));
    let streak = 0;
    const d = new Date();
    if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // сегодня ещё пусто — серия не рвётся в течение дня
    while (days.has(dayKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
    return streak;
  }
  function last7() {
    const out = [];
    const base = new Date(); base.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const day = new Date(base); day.setDate(base.getDate() - i);
      const next = new Date(day); next.setDate(day.getDate() + 1);
      const n = logCache.filter((r) => r.ts >= day.getTime() && r.ts < next.getTime()).length;
      out.push({ label: WEEKDAY[day.getDay()], n, today: i === 0 });
    }
    return out;
  }

  // ---------------- рендер ----------------
  function renderBody() {
    const body = $('#pomodoro-body');
    if (!body) return;
    applyCompactUI();
    body.innerHTML = '';
    const slot = el('div', 'pm-card-slot'); // карта таймера обновляется отдельно (каждую секунду),
    slot.appendChild(renderTimerCard());     // чтобы тик не перерисовывал поля настроек и не сбрасывал фокус
    body.appendChild(slot);
    if (!state.compact) {                     // «минимализм»: только таймер, без статистики/техник/настроек
      body.appendChild(renderStats());
      body.appendChild(renderTechList());
      body.appendChild(renderSettings());
    }
  }
  // Режим «минимализм»: класс на body (компактные стили) + иконка/подсказка кнопки шапки.
  function applyCompactUI() {
    document.body.classList.toggle('pm-compact', state.compact);
    const btn = $('#pomodoro-min');
    if (btn) {
      btn.innerHTML = '';
      btn.appendChild(icon(state.compact ? 'expand' : 'compress', 15));
      btn.title = state.compact ? 'Развернуть — полный вид' : 'Минимализм — компактный вид';
    }
  }
  function toggleCompact() {
    state.compact = !state.compact; save();
    try { lite.win.compact(state.compact, 420, 520); } catch (_) {} // ужать/вернуть само окно
    renderBody();
  }
  // Лёгкое обновление по тику: только карта таймера (кольцо/часы/кнопки), без статистики/настроек.
  function updateTimer() {
    const slot = $('#pomodoro-body .pm-card-slot');
    if (!slot) { renderBody(); return; }
    slot.innerHTML = '';
    slot.appendChild(renderTimerCard());
  }

  function cycleLabel() {
    if (!live.running || !live.tech) return '';
    const before = Math.max(1, live.tech.cyclesBeforeLong || 4);
    const idx = live.phase === 'work' ? (live.cycle % before) + 1 : ((live.cycle - 1 + before) % before) + 1;
    return 'цикл ' + idx + ' / ' + before;
  }

  // Большая карта: кольцо прогресса фазы + обратный отсчёт + управление.
  function renderTimerCard() {
    const card = el('div', 'pm-card pm-phase-' + live.phase);
    const running = live.running;
    const frac = running ? (live.total ? (live.total - live.remaining) / live.total : 0) : 0;
    card.appendChild(ring(frac, running ? fmtClock(live.remaining) : '—', PHASE_LABEL[live.phase] || '', 'pm-ring-phase-' + live.phase));

    const meta = el('div', 'pm-meta');
    if (running && live.tech) {
      meta.appendChild(el('span', 'pm-meta-tech', live.tech.name + (live.paused ? ' · пауза' : '')));
      meta.appendChild(el('span', 'pm-meta-cycle', cycleLabel()));
    } else {
      meta.appendChild(el('span', 'pm-meta-tech', 'Выберите технику и нажмите «Запустить»'));
    }
    card.appendChild(meta);

    const ctl = el('div', 'pm-controls');
    if (!running) {
      const sel = findTech(state.selectedId) || BUILTIN[0];
      const startBtn = el('button', 'pm-btn pm-btn-primary');
      startBtn.append(icon('play', 16), el('span', null, 'Запустить: ' + sel.name));
      startBtn.onclick = () => start(sel);
      ctl.appendChild(startBtn);
    } else {
      if (live.paused) {
        const resume = el('button', 'pm-btn pm-btn-primary');
        resume.append(icon('play', 16), el('span', null, 'Продолжить'));
        resume.onclick = () => lite.pomodoro.resume();
        ctl.appendChild(resume);
      } else {
        const pause = el('button', 'pm-btn');
        pause.append(icon('pause', 16), el('span', null, 'Пауза'));
        pause.onclick = () => lite.pomodoro.pause();
        ctl.appendChild(pause);
      }
      const allowSkip = !live.tech || live.tech.allowSkip !== false;
      if (allowSkip) {
        const skip = el('button', 'pm-btn');
        skip.append(icon('skip', 16), el('span', null, live.phase === 'work' ? 'К перерыву' : 'Пропустить'));
        skip.onclick = () => lite.pomodoro.skip();
        ctl.appendChild(skip);
      }
      const stop = el('button', 'pm-btn pm-btn-danger');
      stop.append(icon('stop', 16), el('span', null, 'Стоп'));
      stop.onclick = () => lite.pomodoro.stop();
      ctl.appendChild(stop);
    }
    card.appendChild(ctl);
    return card;
  }

  // Статистика: дневная цель (кольцо), серия дней, бары за 7 дней.
  function renderStats() {
    const wrap = el('div', 'pm-stats');
    const today = todayCount();
    const goal = Math.max(1, state.goal || 8);

    const top = el('div', 'pm-stats-top');
    const goalRing = ring(today / goal, String(today), 'из ' + goal, 'pm-ring-goal' + (today >= goal ? ' done' : ''));
    top.appendChild(goalRing);
    const facts = el('div', 'pm-facts');
    const f1 = el('div', 'pm-fact');
    f1.appendChild(el('div', 'pm-fact-n', String(streakDays())));
    f1.appendChild(el('div', 'pm-fact-l', 'дней подряд'));
    const f2 = el('div', 'pm-fact');
    f2.appendChild(el('div', 'pm-fact-n', String(logCache.length)));
    f2.appendChild(el('div', 'pm-fact-l', 'всего помидоров'));
    facts.append(f1, f2);
    top.appendChild(facts);
    wrap.appendChild(top);

    // бары за 7 дней
    const days = last7();
    const max = Math.max(1, ...days.map((d) => d.n));
    const bars = el('div', 'pm-bars');
    for (const d of days) {
      const col = el('div', 'pm-bar' + (d.today ? ' today' : ''));
      const track = el('div', 'pm-bar-track');
      const fill = el('div', 'pm-bar-fill');
      fill.style.height = (d.n ? Math.max(8, Math.round(d.n / max * 100)) : 0) + '%';
      track.appendChild(fill);
      col.appendChild(el('div', 'pm-bar-n', d.n ? String(d.n) : ''));
      col.appendChild(track);
      col.appendChild(el('div', 'pm-bar-d', d.label));
      bars.appendChild(col);
    }
    wrap.appendChild(bars);
    return wrap;
  }

  // Список техник: стандартные + свои; запуск, выбор по умолчанию, редактирование/удаление, импорт/экспорт.
  function renderTechList() {
    const wrap = el('div', 'pm-list');
    const head = el('div', 'pm-list-head');
    head.appendChild(el('span', null, 'Техники'));
    const tools = el('div', 'pm-list-tools');
    const imp = iconBtn('pm-iact', 'upload', 'Импорт техник из файла', 15); imp.onclick = importTechs; tools.appendChild(imp);
    const exp = iconBtn('pm-iact', 'download', 'Экспорт своих техник в файл', 15); exp.onclick = exportTechs; tools.appendChild(exp);
    const add = el('button', 'pm-add');
    add.append(icon('plus', 14), el('span', null, 'Своя'));
    add.onclick = () => openForm(null);
    tools.appendChild(add);
    head.appendChild(tools);
    wrap.appendChild(head);

    for (const t of allTechs()) wrap.appendChild(renderTechRow(t));
    return wrap;
  }

  function renderTechRow(t) {
    const isSel = t.id === state.selectedId;
    const row = el('div', 'pm-row' + (isSel ? ' sel' : ''));

    const radio = el('button', 'pm-radio' + (isSel ? ' on' : ''));
    radio.title = 'Сделать техникой по умолчанию';
    radio.onclick = () => { state.selectedId = t.id; save(); renderBody(); };
    row.appendChild(radio);

    const info = el('div', 'pm-row-info');
    info.appendChild(el('div', 'pm-row-name', t.name));
    info.appendChild(el('div', 'pm-row-sub', t.work + ' · ' + t.short + ' · ' + t.long + ' мин · ' + Math.max(1, t.cyclesBeforeLong || 4) + ' цикла до длинного'));
    const tags = el('div', 'pm-row-tags');
    if (t.block) { const b = el('span', 'pm-tag'); b.append(icon('clock', 12), el('span', null, 'блокирует ввод')); tags.appendChild(b); }
    if (t.allowSkip !== false) tags.appendChild(el('span', 'pm-tag pm-tag-soft', 'можно пропустить'));
    info.appendChild(tags);
    row.appendChild(info);

    const acts = el('div', 'pm-row-acts');
    const play = iconBtn('pm-iact', 'play', 'Запустить эту технику', 16);
    play.onclick = () => start(t);
    acts.appendChild(play);
    if (!t.builtin) {
      const edit = iconBtn('pm-iact', 'pencil', 'Редактировать', 15);
      edit.onclick = () => openForm(t);
      acts.appendChild(edit);
      const del = iconBtn('pm-iact pm-iact-danger', 'trash', 'Удалить', 15);
      del.onclick = () => removeTech(t);
      acts.appendChild(del);
    }
    row.appendChild(acts);
    return row;
  }

  function removeTech(t) {
    showConfirm('Удалить технику?', '«' + t.name + '» будет удалена.', 'Удалить', () => {
      state.customs = state.customs.filter((x) => x.id !== t.id);
      if (state.selectedId === t.id) state.selectedId = 'classic';
      save(); renderBody();
    });
  }

  // Настройки: дневная цель + звук + уведомления.
  function renderSettings() {
    const wrap = el('div', 'pm-settings');
    wrap.appendChild(el('div', 'pm-list-head', 'Настройки'));

    const goalRow = el('label', 'pm-set-row');
    goalRow.appendChild(el('span', null, 'Цель в день, помидоров'));
    const goalInp = el('input'); goalInp.type = 'number'; goalInp.min = '1'; goalInp.max = '50'; goalInp.value = String(state.goal);
    goalInp.className = 'pm-goal-input';
    goalInp.onchange = () => { state.goal = clampNum(goalInp.value, 1, 50, 8); save(); renderBody(); };
    goalRow.appendChild(goalInp);
    wrap.appendChild(goalRow);

    wrap.appendChild(toggleRow('Звук на смене фазы', state.soundOn, (v) => { state.soundOn = v; save(); }));
    wrap.appendChild(toggleRow('Системные уведомления', state.notifyOn, (v) => { state.notifyOn = v; save(); }));
    return wrap;
  }
  function toggleRow(label, on, onChange) {
    const row = el('label', 'pm-set-row');
    row.appendChild(el('span', null, label));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!on; cb.className = 'pm-toggle';
    cb.onchange = () => onChange(cb.checked);
    row.appendChild(cb);
    return row;
  }

  // ---------------- импорт/экспорт техник ----------------
  async function exportTechs() {
    if (!state.customs.length) { toast('Нет своих техник для экспорта'); return; }
    const r = await lite.pomodoro.exportTechs(JSON.stringify(state.customs, null, 2), 'pomodoro-techniques');
    if (!r || r.canceled) return;
    if (r.ok === false) { toast('Ошибка экспорта: ' + (r.error || ''), { kind: 'err' }); return; }
    toast('Техники сохранены');
  }
  async function importTechs() {
    const r = await lite.pomodoro.importTechs();
    if (!r || r.canceled) return;
    if (r.ok === false) { toast('Ошибка импорта: ' + (r.error || ''), { kind: 'err' }); return; }
    let arr;
    try { arr = JSON.parse(r.content); } catch (_) { toast('Файл не похож на JSON', { kind: 'err' }); return; }
    if (!Array.isArray(arr)) { toast('Ожидался список техник', { kind: 'err' }); return; }
    let added = 0;
    for (const t of arr) {
      if (!t || typeof t !== 'object') continue;
      state.customs.push({
        id: 'c' + Date.now() + '_' + added,
        name: String(t.name || 'Импорт').slice(0, 40),
        work: clampNum(t.work, 1, 240, 25), short: clampNum(t.short, 1, 120, 5), long: clampNum(t.long, 1, 240, 15),
        cyclesBeforeLong: clampNum(t.cyclesBeforeLong, 1, 12, 4),
        block: t.block !== false, allowSkip: t.allowSkip !== false,
      });
      added++;
    }
    if (!added) { toast('В файле нет валидных техник', { kind: 'err' }); return; }
    save(); renderBody();
    toast('Импортировано техник: ' + added);
  }

  // ---------------- форма своей техники (создание/редактирование) ----------------
  function openForm(existing) {
    const t = existing || { name: '', work: 25, short: 5, long: 15, cyclesBeforeLong: 4, block: true, allowSkip: true };
    const html = `
      <h3 class="modal-h">${existing ? 'Редактировать технику' : 'Своя техника'}</h3>
      <div class="pm-form">
        <label class="pm-f"><span>Название</span><input id="pmf-name" type="text" maxlength="40" placeholder="Моя техника"></label>
        <div class="pm-f-grid">
          <label class="pm-f"><span>Работа, мин</span><input id="pmf-work" type="number" min="1" max="240"></label>
          <label class="pm-f"><span>Короткий, мин</span><input id="pmf-short" type="number" min="1" max="120"></label>
          <label class="pm-f"><span>Длинный, мин</span><input id="pmf-long" type="number" min="1" max="240"></label>
          <label class="pm-f"><span>Циклов до длинного</span><input id="pmf-cycles" type="number" min="1" max="12"></label>
        </div>
        <label class="pm-check"><input id="pmf-block" type="checkbox"><span>Блокировать работу — на перерыве над терминалами появляется оверлей (ввод заблокирован, агенты работают)</span></label>
        <label class="pm-check"><input id="pmf-skip" type="checkbox"><span>Разрешить кнопку «Пропустить» во время перерыва</span></label>
      </div>
      <div class="modal-actions">
        <button class="btn" id="pmf-cancel">Отмена</button>
        <button class="btn btn-primary" id="pmf-save">${existing ? 'Сохранить' : 'Создать'}</button>
      </div>`;
    const { m, close } = makeModal(html);
    m.querySelector('#pmf-name').value = t.name;
    m.querySelector('#pmf-work').value = t.work;
    m.querySelector('#pmf-short').value = t.short;
    m.querySelector('#pmf-long').value = t.long;
    m.querySelector('#pmf-cycles').value = Math.max(1, t.cyclesBeforeLong || 4);
    m.querySelector('#pmf-block').checked = t.block !== false;
    m.querySelector('#pmf-skip').checked = t.allowSkip !== false;
    m.querySelector('#pmf-name').focus();
    m.querySelector('#pmf-cancel').onclick = close;
    m.querySelector('#pmf-save').onclick = () => {
      const name = m.querySelector('#pmf-name').value.trim() || 'Моя техника';
      const tech = {
        id: existing ? existing.id : 'c' + Date.now(),
        name, work: clampNum(m.querySelector('#pmf-work').value, 1, 240, 25),
        short: clampNum(m.querySelector('#pmf-short').value, 1, 120, 5),
        long: clampNum(m.querySelector('#pmf-long').value, 1, 240, 15),
        cyclesBeforeLong: clampNum(m.querySelector('#pmf-cycles').value, 1, 12, 4),
        block: m.querySelector('#pmf-block').checked, allowSkip: m.querySelector('#pmf-skip').checked,
      };
      if (existing) state.customs = state.customs.map((x) => x.id === existing.id ? tech : x);
      else state.customs.push(tech);
      save(); close(); renderBody();
    };
  }

  // ---------------- панель (в окне модуля — на всю ширину) ----------------
  function setOpen(open, opts = {}) {
    if (open === paneOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('pomodoro');
    const delta = (layout.pomodoro || 480) + GUTTER;
    paneOpen = open;
    $('#pomodoro-pane').classList.toggle('hidden', !open);
    $('#gutter-pomodoro').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    setTimeout(refitActiveTerminal, 150);
  }

  function renderPanel() {
    if (!paneOpen) return;
    renderBody();
    if (!unsubTick) {
      unsubTick = lite.pomodoro.onTick((s) => { live = s || live; updateTimer(); });
      unsubLog = lite.pomodoro.onLogChanged(() => refreshHistory());
      refreshLive();
      refreshHistory();
    }
  }

  return {
    isOpen: () => paneOpen,
    setOpen,
    toggle: () => setOpen(!paneOpen),
    toggleCompact,
    renderPanel,
  };
}
