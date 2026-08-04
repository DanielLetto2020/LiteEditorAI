// LiteEditor — модуль «Jira»: свои задачи из нескольких аккаунтов сразу.
// Три вкладки: «Мои задачи» (агрегат по всем аккаунтам, пресеты JQL + свой JQL, группировка),
// «Аккаунты» (мульти-аккаунт: адрес + режим авторизации + токен, токен хранится зашифрованным
// в main и в рендерер НЕ приходит — только флаг hasToken) и «Структура» (разведка устройства
// конкретной Jira: проекты/статусы/поля/доски + раскладка своих задач, выгрузка отчёта в файл).
//
// Модуль не знает схему чужой Jira: колонки и цвета берутся от statusCategory (одинакова во всех
// инсталляциях), переходы — из ответа сервера, кастомные поля — из /field. Детали — в lib/jira.js.
// Изоляция по образцу rmq.js: ядро — через host; UI-хелперы — из ui.js; бэкенд — window.lite.jira.*.
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const PRESETS = [
  { id: 'open', label: 'Открытые на мне' },
  { id: 'all', label: 'Все мои задачи' },
  { id: 'recent', label: 'Мои за 14 дней' },
  { id: 'reported', label: 'Я автор' },
  { id: 'watched', label: 'Наблюдаю' },
  { id: 'past', label: 'Были на мне' },
  { id: 'custom', label: 'Свой JQL' },
];

// Пресеты, которые по смыслу показывают только незавершённое (JQL их уже фильтрует —
// это клиентская подстраховка на случай кастомных воркфлоу).
const OPEN_PRESETS = new Set(['open', 'recent', 'reported', 'watched']);

// Три категории статусов Jira — единственная классификация, одинаковая в любой инсталляции.
// Тип задачи для показа и фильтров: в инсталляциях с кастомным полем «Тип задачи» («Разработка»,
// «Проверка CR») системный issuetype почти всегда один и тот же и пользы не несёт — берём
// кастомный, а системный оставляем запасным вариантом и подсказкой.
const kindOf = (r) => (r && r.kind) || (r && r.type) || '—';

const CAT_LABEL = { new: 'К выполнению', indeterminate: 'В работе', done: 'Готово' };
const CAT_CLASS = { new: 'jira-cat-new', indeterminate: 'jira-cat-prog', done: 'jira-cat-done' };

export function initJira(host) {
  const { STORE, persist, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, sendToTerminal } = host;

  let jiraOpen = false;
  let accounts = [], secure = true, loaded = false;
  let ui = (STORE.jiraUi && typeof STORE.jiraUi === 'object') ? STORE.jiraUi : {};
  const saveUi = () => persist('jiraUi', ui);

  let tab = ui.tab || 'tasks';            // 'tasks' | 'accounts' | 'recon'
  let preset = ui.preset || 'open';
  let customJql = ui.customJql || '';
  let group = ui.group || 'status';       // 'status' | 'project' | 'flat'
  let boardFilter = ui.board || '';       // '' = все доски; иначе '<accId>:<boardId>'
  let sprintFilter = ui.sprint || '';     // '' = все; '@active' = текущий спринт; иначе имя спринта
  const boardsByAcc = new Map();          // accId -> { boards, issueBoards } (Agile API, лениво)
  const metaByAcc = new Map();            // accId -> { statuses, types } — справочник инсталляции
  let filterText = '';
  let rows = [];                          // агрегированные задачи всех аккаунтов
  let loadErrors = [];                    // аккаунты, которые не ответили
  let truncated = false;
  let busy = false;
  let renderSeq = 0;
  let report = null;                      // последний отчёт разведки

  // Автообновление и «прочитано/не прочитано». Прочитанность живёт в сторе (ui.seen), поэтому
  // задача, увиденная вчера, не мигает после перезапуска редактора. Непрочитанные держим в Set —
  // это состояние сессии, в стор пишется только факт «видел».
  let autoOn = ui.auto !== false;         // по умолчанию включено
  let autoMin = Number(ui.autoMin) || 5;  // по умолчанию раз в 5 минут
  let autoTimer = null;
  let reload = null;                      // ссылка на load() активного списка (для таймера)
  let unreadEl = null;                    // индикатор «N новых» в топбаре
  let recentEl = null;                    // кнопка «за 8 ч: N» (список свежих задач)
  let repaint = null;                     // ссылка на paint() активного списка
  let dragUid = null;                     // перетаскиваемая строка избранного
  const unread = new Set();
  const uidOf = (r) => r.accId + ':' + r.key;

  // Избранное: порядок задаёт пользователь перетаскиванием, поэтому храним массив uid, а не Set.
  // Снимок задачи нужен, чтобы избранное показывалось даже когда текущий фильтр её не вернул.
  let fav = Array.isArray(ui.fav) ? ui.fav.slice() : [];
  let favData = (ui.favData && typeof ui.favData === 'object') ? { ...ui.favData } : {};
  // Скрытые статусы и типы — это НЕ фильтр выборки, а «не показывать вот эти» поверх всего.
  const hiddenStatuses = new Set(Array.isArray(ui.hideStatuses) ? ui.hideStatuses : []);
  const hiddenTypes = new Set(Array.isArray(ui.hideTypes) ? ui.hideTypes : []);

  const isFav = (uid) => fav.includes(uid);
  const favSnap = (r) => ({
    accId: r.accId, key: r.key, summary: r.summary, status: r.status, statusCat: r.statusCat,
    type: r.type, kind: r.kind, priority: r.priority, url: r.url, projectName: r.projectName, project: r.project,
    updated: r.updated, sprints: r.sprints || [], activeSprints: r.activeSprints || [],
  });
  function toggleFav(r) {
    const uid = uidOf(r);
    if (isFav(uid)) { fav = fav.filter((x) => x !== uid); delete favData[uid]; }
    else { fav.push(uid); favData[uid] = favSnap(r); }
    ui.fav = fav; ui.favData = favData; saveUi();
  }
  // Снимки обновляем на каждой загрузке — иначе в избранном висел бы вчерашний статус.
  function refreshFavSnapshots() {
    if (!fav.length) return;
    let touched = false;
    for (const r of rows) {
      const uid = uidOf(r);
      if (!isFav(uid)) continue;
      favData[uid] = favSnap(r);
      touched = true;
    }
    if (touched) { ui.favData = favData; saveUi(); }
  }
  // Перетаскивание внутри избранного: dragged встаёт ПЕРЕД target.
  function reorderFav(dragUid, targetUid) {
    if (!dragUid || dragUid === targetUid) return;
    const next = fav.filter((x) => x !== dragUid);
    const at = next.indexOf(targetUid);
    next.splice(at < 0 ? next.length : at, 0, dragUid);
    fav = next; ui.fav = fav; saveUi();
  }
  const SEEN_CAP = 2000;                  // словарь прочитанного не растёт бесконечно

  // Выпадашка со чекбоксами «что показывать». В отличие от остальных фильтров она не сужает
  // выборку, а прячет значения: снятая галка = этот статус/тип не показывать нигде.
  function checkFilter(label, values, hiddenSet, onApply) {
    const wrap = el('div', 'jira-dd');
    const btn = el('button', 'jira-dd-btn');
    const pop = el('div', 'jira-dd-pop hidden');
    let offDoc = null;

    const sync = () => {
      const off = values.filter((v) => hiddenSet.has(v.value)).length;
      btn.textContent = label + (off ? ' · скрыто ' + off : '');
      btn.classList.toggle('active', off > 0);
    };
    const build = () => {
      pop.innerHTML = '';
      const acts = el('div', 'jira-dd-acts');
      const all = el('button', 'jira-more', 'Показать все');
      all.onclick = () => { for (const v of values) hiddenSet.delete(v.value); build(); sync(); onApply(); };
      const none = el('button', 'jira-more', 'Скрыть все');
      none.onclick = () => { for (const v of values) hiddenSet.add(v.value); build(); sync(); onApply(); };
      acts.append(all, none);
      pop.appendChild(acts);
      for (const v of values) {
        const row = el('label', 'jira-dd-row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = !hiddenSet.has(v.value);
        cb.onchange = () => { if (cb.checked) hiddenSet.delete(v.value); else hiddenSet.add(v.value); sync(); onApply(); };
        row.append(cb, el('span', 'jira-dd-name', v.value || '—'), el('span', 'jira-dd-count', String(v.count)));
        pop.appendChild(row);
      }
    };
    build(); sync();

    btn.onclick = (e) => {
      e.stopPropagation();
      const opening = pop.classList.contains('hidden');
      pop.classList.toggle('hidden', !opening);
      if (offDoc) { document.removeEventListener('click', offDoc); offDoc = null; }
      if (!opening) return;
      // Слушатель живёт только пока попап открыт — иначе он копился бы на каждой перерисовке.
      offDoc = (ev) => {
        if (wrap.contains(ev.target)) return;
        pop.classList.add('hidden');
        document.removeEventListener('click', offDoc);
        offDoc = null;
      };
      document.addEventListener('click', offDoc);
    };
    wrap.append(btn, pop);
    return wrap;
  }

  function paintUnreadBadge() {
    if (!unreadEl) return;
    unreadEl.textContent = unread.size ? unread.size + ' новых' : '';
    unreadEl.classList.toggle('hidden', !unread.size);
  }

  // «Свежие» — заведённые за последние RECENT_H часов, независимо от того, читал их пользователь
  // или нет: это ответ на вопрос «что нового появилось за смену», а не счётчик непрочитанного.
  const RECENT_H = 8;
  function recentList() {
    const from = Date.now() - RECENT_H * 3600000;
    return rows
      .filter((r) => r.created && new Date(r.created).getTime() >= from)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }
  function paintRecentBadge() {
    if (!recentEl) return;
    const n = recentList().length;
    recentEl.textContent = 'за ' + RECENT_H + ' ч: ' + n;
    recentEl.disabled = !n;
    recentEl.classList.toggle('active', n > 0);
  }
  function showRecentModal() {
    const list = recentList();
    const { m } = makeModal('<h2 class="jira-modal-h"></h2><div id="jira-recent-body"></div>');
    m.classList.add('db-modal', 'jira-recent-modal');
    m.querySelector('.jira-modal-h').textContent = 'Появились за последние ' + RECENT_H + ' ч — ' + list.length;
    const box = m.querySelector('#jira-recent-body');
    if (!list.length) { box.appendChild(el('div', 'docker-empty', 'За этот период новых задач нет.')); return; }
    for (const r of list) box.appendChild(issueRow(r));
  }

  // Пометить задачу прочитанной: снимает подсветку и запоминает это между запусками.
  function markRead(r) {
    const uid = uidOf(r);
    const seen = (ui.seen && typeof ui.seen === 'object') ? ui.seen : {};
    if (seen[uid] && !unread.has(uid)) return;
    unread.delete(uid);
    ui.seen = { ...seen, [uid]: 1 };
    saveUi();
    const node = document.querySelector('.jira-row[data-uid="' + (window.CSS && CSS.escape ? CSS.escape(uid) : uid) + '"]');
    if (node) node.classList.remove('jira-new');
    paintUnreadBadge();
  }

  function markAllRead() {
    const seen = (ui.seen && typeof ui.seen === 'object') ? ui.seen : {};
    const next = { ...seen };
    for (const uid of unread) next[uid] = 1;
    unread.clear();
    ui.seen = next;
    saveUi();
    for (const n of document.querySelectorAll('.jira-row.jira-new')) n.classList.remove('jira-new');
    paintUnreadBadge();
  }

  function startAuto() {
    stopAuto();
    if (!autoOn) return;
    autoTimer = setInterval(() => { if (jiraOpen && reload) reload({ silent: true }); }, autoMin * 60000);
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  // ---------------------------------------------------------------- helpers
  const accName = (id) => (accounts.find((a) => a.id === id) || {}).name || '—';
  // Принадлежность задачи доскам — из карты, собранной Agile API (см. loadBoards).
  const boardIdsOf = (r) => {
    const d = boardsByAcc.get(r.accId);
    return (d && d.issueBoards && d.issueBoards[r.key]) || [];
  };
  const boardNamesOf = (r) => {
    const d = boardsByAcc.get(r.accId);
    if (!d) return [];
    return boardIdsOf(r).map((id) => (d.boards.find((b) => b.id === id) || {}).name).filter(Boolean);
  };

  const enabledIds = () => {
    const off = Array.isArray(ui.hiddenAccs) ? ui.hiddenAccs : [];
    return accounts.filter((a) => !off.includes(a.id)).map((a) => a.id);
  };

  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '—';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days === 0) return 'сегодня';
    if (days === 1) return 'вчера';
    if (days < 30) return days + ' дн. назад';
    return d.toLocaleDateString('ru-RU');
  }

  // ---------------------------------------------------------------- panel open/close (канон)
  function setJiraOpen(open, opts = {}) {
    if (open === jiraOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('jira');
    else stopAuto();   // окно закрыли — фоновый опрос Jira прекращаем
    const delta = layout.jira + GUTTER;
    jiraOpen = open;
    $('#jira-pane').classList.toggle('hidden', !open);
    $('#gutter-jira').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleJira() { setJiraOpen(!jiraOpen); }

  // ---------------------------------------------------------------- router
  async function renderPanel() {
    const seq = ++renderSeq;
    const body = $('#jira-body');
    if (!body) return;

    if (!loaded) {
      body.innerHTML = '<div class="git-loading">Загрузка аккаунтов…</div>';
      const r = await lite.jira.list();
      if (seq !== renderSeq || !jiraOpen) return;
      if (r && r.ok) { accounts = r.accounts || []; secure = r.secure !== false; loaded = true; }
      else { toast('Не удалось прочитать аккаунты Jira: ' + ((r && r.error) || '?'), { kind: 'err' }); accounts = []; loaded = true; }
      if (!accounts.length) tab = 'accounts';
    }

    body.innerHTML = '';
    body.appendChild(buildTabs());
    const wrap = el('div', 'jira-wrap');
    body.appendChild(wrap);
    if (tab === 'accounts') renderAccounts(wrap);
    else if (tab === 'recon') renderRecon(wrap);
    else renderTasks(wrap);
  }

  function buildTabs() {
    const bar = el('div', 'jira-tabs');
    const mk = (id, label) => {
      const b = el('button', 'jira-tab' + (tab === id ? ' active' : ''), label);
      b.onclick = () => { tab = id; ui.tab = id; saveUi(); renderPanel(); };
      return b;
    };
    bar.append(mk('tasks', 'Мои задачи'), mk('accounts', 'Аккаунты'), mk('recon', 'Структура'));
    return bar;
  }

  // ---------------------------------------------------------------- вкладка «Мои задачи»
  function renderTasks(wrap) {
    wrap.innerHTML = '';
    if (!accounts.length) {
      wrap.appendChild(el('div', 'docker-empty', 'Нет ни одного аккаунта Jira. Добавьте его на вкладке «Аккаунты» — нужен адрес Jira и токен доступа.'));
      return;
    }

    const top = el('div', 'db-topbar');
    const sel = el('select', 'jira-sel');
    for (const p of PRESETS) sel.appendChild(new Option(p.label, p.id));
    sel.value = preset;
    // Перерисовка топбара создаёт НОВЫЙ список и новые замыкания load/paint. Поэтому здесь
    // нельзя дёргать текущий load(): он писал бы в уже отсоединённый DOM, а на экране остался бы
    // прежний набор задач. Сбрасываем rows — новый renderTasks сам запустит загрузку.
    sel.onchange = () => { preset = sel.value; ui.preset = preset; saveUi(); rows = []; unread.clear(); renderTasks(wrap); };
    top.appendChild(sel);

    const gsel = el('select', 'jira-sel');
    gsel.append(new Option('По статусам', 'status'), new Option('По проектам', 'project'), new Option('Одним списком', 'flat'));
    gsel.value = group;
    gsel.onchange = () => { group = gsel.value; ui.group = group; saveUi(); paint(); };
    top.appendChild(gsel);

    // Доски: селектор появляется, только если Agile-модуль вообще есть хоть у одного аккаунта.
    const bsel = el('select', 'jira-sel jira-board-sel');
    // Доски в списке — с числом СВОИХ задач впереди и по убыванию: сверху та, где работы больше.
    const fillBoards = () => {
      const cur = bsel.value;
      bsel.innerHTML = '';
      const opts = [];
      for (const [accId, data] of boardsByAcc) {
        const counts = new Map();
        for (const ids of Object.values(data.issueBoards || {})) {
          for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
        }
        for (const b of data.boards || []) {
          const n = counts.get(b.id) || 0;
          if (!n) continue;   // доски без моих задач в списке не нужны
          opts.push({
            value: accId + ':' + b.id,
            name: (accounts.length > 1 ? accName(accId) + ' · ' : '') + b.name,
            n,
          });
        }
      }
      opts.sort((x, y) => y.n - x.n || x.name.localeCompare(y.name, 'ru'));
      bsel.appendChild(new Option('Все доски · ' + rows.length, ''));
      for (const o of opts) bsel.appendChild(new Option(o.n + ' · ' + o.name, o.value));
      bsel.classList.toggle('hidden', !opts.length);
      bsel.value = cur || boardFilter || '';
    };
    bsel.onchange = () => { boardFilter = bsel.value; ui.board = boardFilter; saveUi(); paint(); };
    top.appendChild(bsel);
    fillBoards();

    // Спринты берутся из самих задач (поле спринта инсталляции находится по типу gh-sprint).
    // «Текущий» — это спринт в состоянии active; отдельного вопроса к серверу не требуется.
    const ssel = el('select', 'jira-sel jira-sprint-sel');
    const fillSprints = () => {
      const cur = ssel.value;
      ssel.innerHTML = '';
      const counts = new Map();
      const active = new Set();
      let inActive = 0;
      for (const r of rows) {
        for (const s of r.sprints || []) counts.set(s, (counts.get(s) || 0) + 1);
        if ((r.activeSprints || []).length) { inActive++; for (const s of r.activeSprints) active.add(s); }
      }
      ssel.appendChild(new Option('Все спринты', ''));
      if (active.size) ssel.appendChild(new Option(inActive + ' · Текущий спринт', '@active'));
      const list = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'ru'));
      for (const [name, n] of list) ssel.appendChild(new Option(n + ' · ' + name + (active.has(name) ? ' ●' : ''), name));
      ssel.classList.toggle('hidden', !counts.size);
      ssel.value = cur || sprintFilter || '';
      if (ssel.value !== (cur || sprintFilter || '')) ssel.value = '';  // спринт пропал из выдачи
    };
    ssel.onchange = () => { sprintFilter = ssel.value; ui.sprint = sprintFilter; saveUi(); paint(); };
    top.appendChild(ssel);
    fillSprints();

    const flt = el('input', 'jira-filter');
    flt.placeholder = 'Фильтр по тексту, ключу, статусу…';
    flt.value = filterText;
    flt.oninput = () => { filterText = flt.value; paint(); };
    top.appendChild(flt);

    const go = iconBtn('drow-act', 'refresh', 'Обновить', 16);
    go.onclick = () => load();
    top.appendChild(go);
    wrap.appendChild(top);

    // Строка автообновления: галка + интервал + счётчик новых. Опрос идёт, пока окно открыто.
    const auto = el('div', 'jira-auto-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = autoOn;
    const cbLab = el('label', 'jira-check');
    cbLab.append(cb, el('span', null, 'Обновлять каждые'));
    const msel = el('select', 'jira-sel jira-min-sel');
    for (const n of [1, 5, 15, 30, 60]) msel.appendChild(new Option(n + ' мин', String(n)));
    msel.value = String(autoMin);
    msel.disabled = !autoOn;
    cb.onchange = () => {
      autoOn = cb.checked; ui.auto = autoOn; saveUi();
      msel.disabled = !autoOn;
      startAuto();
    };
    msel.onchange = () => { autoMin = Number(msel.value) || 5; ui.autoMin = autoMin; saveUi(); startAuto(); };
    auto.append(cbLab, msel);

    recentEl = el('button', 'jira-recent');
    recentEl.title = 'Показать задачи, появившиеся за последние ' + RECENT_H + ' часов';
    recentEl.onclick = () => showRecentModal();
    auto.appendChild(recentEl);

    unreadEl = el('span', 'jira-unread hidden');
    const readAll = el('button', 'jira-more', 'Отметить все прочитанными');
    readAll.onclick = () => markAllRead();
    auto.append(el('div', 'jira-head-space'), unreadEl, readAll);
    wrap.appendChild(auto);
    paintUnreadBadge();
    paintRecentBadge();

    // Визуальные фильтры (статусы и типы). Перестраиваются ТОЛЬКО при обновлении данных:
    // если пересобирать их на каждую перерисовку списка, открытый попап закрывался бы от клика
    // по собственному чекбоксу.
    const fbox = el('div', 'jira-filters');
    wrap.appendChild(fbox);
    function fillFilters() {
      fbox.innerHTML = '';
      const sc = new Map(), tc = new Map();
      // Сначала ВЕСЬ справочник инсталляции с нулями: спрятать нужно уметь и тот статус,
      // которого сейчас в выдаче нет (иначе он всплывёт завтра и снова полезет в список).
      // Если инсталляция классифицирует работу кастомным полем («Разработка», «Проверка CR»),
      // подмешивать в фильтр системные типы («Задача», Story) нельзя — это разные множества,
      // и в списке таких значений не будет никогда. Тогда состав берём только из выдачи.
      const usesKind = rows.some((r) => r.kind);
      for (const [, m] of metaByAcc) {
        for (const s of (m.statuses || [])) if (!sc.has(s.name)) sc.set(s.name, 0);
        if (usesKind) continue;
        for (const t of (m.types || [])) if (!tc.has(t)) tc.set(t, 0);
      }
      for (const r of rows) {
        sc.set(r.status || '—', (sc.get(r.status || '—') || 0) + 1);
        tc.set(kindOf(r), (tc.get(kindOf(r)) || 0) + 1);
      }
      // Сначала то, что реально встречается (по убыванию), затем остальное по алфавиту.
      const toArr = (m) => [...m.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ru'))
        .map(([value, count]) => ({ value, count }));
      const apply = () => {
        ui.hideStatuses = [...hiddenStatuses];
        ui.hideTypes = [...hiddenTypes];
        saveUi();
        paint();
      };
      if (sc.size) fbox.appendChild(checkFilter('Статусы', toArr(sc), hiddenStatuses, apply));
      if (tc.size) fbox.appendChild(checkFilter('Типы задач', toArr(tc), hiddenTypes, apply));
    }
    fillFilters();

    if (preset === 'custom') {
      const row = el('div', 'jira-jql-row');
      const inp = el('input', 'jira-jql');
      inp.placeholder = 'assignee = currentUser() AND project = ABC ORDER BY updated DESC';
      inp.value = customJql;
      inp.onkeydown = (e) => { if (e.key === 'Enter') { customJql = inp.value; ui.customJql = customJql; saveUi(); load(); } };
      const run = el('button', 'btn primary', 'Выполнить');
      run.onclick = () => { customJql = inp.value; ui.customJql = customJql; saveUi(); load(); };
      row.append(inp, run);
      wrap.appendChild(row);
    }

    // Чипы аккаунтов: у кого две-три Jira, чаще нужен срез по одной.
    if (accounts.length > 1) {
      const chips = el('div', 'jira-chips');
      for (const a of accounts) {
        const off = (ui.hiddenAccs || []).includes(a.id);
        const c = el('button', 'jira-chip' + (off ? '' : ' on'), a.name);
        c.onclick = () => {
          const list = new Set(ui.hiddenAccs || []);
          if (list.has(a.id)) list.delete(a.id); else list.add(a.id);
          ui.hiddenAccs = [...list]; saveUi();
          rows = []; renderTasks(wrap);   // загрузку запустит новый рендер (см. смену пресета)
        };
        chips.appendChild(c);
      }
      wrap.appendChild(chips);
    }

    const listBox = el('div', 'jira-list');
    wrap.appendChild(listBox);

    function paint() {
      listBox.innerHTML = '';
      if (busy) { listBox.appendChild(el('div', 'git-loading', 'Загружаю задачи…')); return; }
      fillSprints();       // состав спринтов известен только из загруженных задач
      paintRecentBadge();  // счётчик свежих пересчитывается по тем же данным

      for (const e of loadErrors)
        listBox.appendChild(el('div', 'db-warn', '⚠ ' + e.name + ': ' + e.error));

      // Подстраховка к JQL: в пресетах «незавершённого» ничего из категории «Готово» не
      // показываем, даже если инсталляция вернула такую задачу (кастомный воркфлоу).
      const done = OPEN_PRESETS.has(preset) ? rows.filter((r) => r.statusCat !== 'done') : rows;
      // Непрочитанную задачу не прячет ни один фильтр: смысл подсветки в том, чтобы новое
      // нельзя было пропустить — иначе задача «попала под скрытый статус» и осталась незамеченной.
      const isNew = (r) => unread.has(uidOf(r));
      // Статусы и типы прячутся поверх всего остального — это «не показывать вот эти», а не выборка.
      const base = done.filter((r) => isNew(r)
        || (!hiddenStatuses.has(r.status || '—') && !hiddenTypes.has(kindOf(r))));
      const q = filterText.trim().toLowerCase();
      let shown = q
        ? base.filter((r) => (r.key + ' ' + r.summary + ' ' + r.status + ' ' + r.projectName + ' ' + r.type + ' ' + (r.kind || '')).toLowerCase().includes(q))
        : base;
      if (boardFilter) {
        const [accId, bid] = boardFilter.split(':');
        shown = shown.filter((r) => isNew(r) || (r.accId === accId && (boardIdsOf(r) || []).includes(Number(bid))));
      }
      if (sprintFilter === '@active') shown = shown.filter((r) => isNew(r) || (r.activeSprints || []).length);
      else if (sprintFilter) shown = shown.filter((r) => isNew(r) || (r.sprints || []).includes(sprintFilter));

      // Избранное — всегда первым и в обход всех фильтров, с ручным порядком (перетаскивание).
      if (fav.length) {
        const g = el('div', 'jira-group jira-fav-group');
        const h = el('div', 'jira-group-head jira-fav-head');
        const star = icon('star', 14);
        star.classList.add('jira-fav-ic');
        h.append(star, el('span', 'jira-group-name', 'Избранное'), el('span', 'jira-group-count', String(fav.length)));
        g.appendChild(h);
        const bodyBox = el('div', 'jira-group-body');
        for (const uid of fav) {
          const r = rows.find((x) => uidOf(x) === uid) || favData[uid];
          if (!r) continue;
          bodyBox.appendChild(issueRow(r, { fav: true }));
        }
        g.appendChild(bodyBox);
        listBox.appendChild(g);
      }

      if (!shown.length) {
        listBox.appendChild(el('div', 'docker-empty', rows.length
          ? 'Ничего не найдено по фильтру.'
          : 'Задач нет. Нажмите ⟳ — или смените пресет: возможно, всё уже закрыто.'));
        return;
      }

      const head = el('div', 'jira-count', shown.length + ' задач' + (truncated ? ' (показаны не все — выдача обрезана)' : ''));
      listBox.appendChild(head);

      if (group === 'flat') { for (const r of shown) listBox.appendChild(issueRow(r)); return; }

      const key = group === 'project' ? ((r) => r.project + ' · ' + (r.projectName || '')) : ((r) => r.status);
      const groups = new Map();
      for (const r of shown) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

      // Порядок групп по статусам: сначала категория (к выполнению → в работе → готово), внутри —
      // по размеру. Названия статусов у каждой компании свои, поэтому порядок строится от
      // statusCategory; PREFER — только косметическая правка порядка внутри категории.
      const PREFER = ['открыт', 'open', 'to do', 'новая', 'очеред', 'queue', 'backlog'];
      const catRank = { new: 0, indeterminate: 1, done: 2 };
      const rankOf = ([, items]) => {
        const cat = items[0].statusCat;
        const nm = String(items[0].status || '').toLowerCase();
        const pref = PREFER.findIndex((p) => nm.startsWith(p));
        return [catRank[cat] ?? 1, pref < 0 ? 99 : pref, -items.length];
      };
      const sorted = group === 'status'
        ? [...groups.entries()].sort((a, b) => {
          const ra = rankOf(a), rb = rankOf(b);
          return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
        })
        : [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

      const collapsed = (ui.collapsed && typeof ui.collapsed === 'object') ? ui.collapsed : {};
      for (const [name, items] of sorted) {
        const g = el('div', 'jira-group');
        const isOff = collapsed[name] === true;
        const h = el('button', 'jira-group-head' + (isOff ? ' off' : ''));
        h.type = 'button';
        const caret = icon('chevron-down', 14);
        caret.classList.add('jira-caret');
        h.append(caret,
          el('span', 'jira-cat ' + (CAT_CLASS[items[0].statusCat] || '')),
          el('span', 'jira-group-name', name || '—'),
          el('span', 'jira-group-count', String(items.length)));
        const bodyBox = el('div', 'jira-group-body' + (isOff ? ' hidden' : ''));
        for (const r of items) bodyBox.appendChild(issueRow(r));
        h.onclick = () => {
          const next = !bodyBox.classList.contains('hidden');
          bodyBox.classList.toggle('hidden', next);
          h.classList.toggle('off', next);
          ui.collapsed = { ...collapsed, [name]: next };
          saveUi();
        };
        g.append(h, bodyBox);
        listBox.appendChild(g);
      }
    }

    // opts.silent — фоновый прогон по таймеру: список не гасим «загрузкой», иначе автообновление
    // раз в минуту мешало бы читать.
    async function load(opts = {}) {
      if (!opts.silent) { busy = true; paint(); }
      const ids = enabledIds();
      if (!ids.length) { busy = false; rows = []; loadErrors = []; paint(); return; }
      const r = await lite.jira.searchAll(ids, preset, customJql);
      busy = false;
      if (!r || !r.ok) {
        if (!opts.silent) toast('Не удалось получить задачи: ' + ((r && r.error) || '?'), { kind: 'err' });
        paint();
        return;
      }
      rows = []; loadErrors = []; truncated = false;
      for (const res of r.results || []) {
        if (res.ok) { rows.push(...res.issues); if (res.truncated) truncated = true; }
        else loadErrors.push({ name: res.name, error: res.error });
      }
      rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      markNew();
      refreshFavSnapshots();
      if (listBox.isConnected) { fillFilters(); paint(); }
      loadBoards(ids);
      loadMeta(ids);
    }

    // Что считать новым: задачу, которой пользователь ещё не видел. На самом первом запуске
    // (словарь пуст) вся выдача помечается прочитанной — иначе замигал бы весь список сразу.
    function markNew() {
      const seen = (ui.seen && typeof ui.seen === 'object') ? ui.seen : {};
      const firstEver = Object.keys(seen).length === 0;
      const next = { ...seen };
      for (const r of rows) {
        const uid = uidOf(r);
        if (next[uid]) continue;
        if (firstEver) next[uid] = 1;
        else unread.add(uid);
      }
      const keys = Object.keys(next);
      if (keys.length > SEEN_CAP) for (const k of keys.slice(0, keys.length - SEEN_CAP)) delete next[k];
      ui.seen = next;
      saveUi();
      paintUnreadBadge();
    }

    reload = load;     // таймер автообновления дёргает именно этот список
    repaint = paint;   // избранное и звёзды перерисовывают его же

    // Доски подтягиваются отдельно и НЕ блокируют показ задач: Agile API есть не везде, а карта
    // «задача → доски» стоит по запросу на доску. Пришли — дорисовываем лейблы и селектор.
    // Справочник статусов/типов — один раз на аккаунт; фильтры перестраиваются, когда он приедет.
    async function loadMeta(ids) {
      const need = ids.filter((id) => !metaByAcc.has(id));
      if (!need.length) return;
      const got = await Promise.all(need.map(async (id) => {
        const r = await lite.jira.meta(id);
        return [id, (r && r.ok) ? { statuses: r.statuses || [], types: r.types || [] } : { statuses: [], types: [] }];
      }));
      for (const [id, data] of got) metaByAcc.set(id, data);
      if (fbox.isConnected) fillFilters();
    }

    async function loadBoards(ids) {
      const need = ids.filter((id) => !boardsByAcc.has(id));
      if (!need.length) return;
      const got = await Promise.all(need.map(async (id) => {
        const r = await lite.jira.boards(id, true);
        return [id, (r && r.ok) ? { boards: r.boards || [], issueBoards: r.issueBoards || {} } : { boards: [], issueBoards: {} }];
      }));
      for (const [id, data] of got) boardsByAcc.set(id, data);
      if (got.some(([, d]) => d.boards.length)) { fillBoards(); paint(); }
    }

    paint();
    if (!rows.length && !busy) load();
    startAuto();
  }

  function issueRow(r, opts = {}) {
    const uid = uidOf(r);
    const row = el('div', 'jira-row' + (unread.has(uid) ? ' jira-new' : '') + (opts.fav ? ' jira-fav-row' : ''));
    row.dataset.uid = uid;

    // Порядок избранного пользователь задаёт сам: тянем строку и бросаем на соседнюю.
    if (opts.fav) {
      row.draggable = true;
      row.ondragstart = (e) => { dragUid = uid; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
      row.ondragend = () => { dragUid = null; row.classList.remove('dragging'); };
      row.ondragover = (e) => { e.preventDefault(); row.classList.add('drop-here'); };
      row.ondragleave = () => row.classList.remove('drop-here');
      row.ondrop = (e) => {
        e.preventDefault();
        row.classList.remove('drop-here');
        reorderFav(dragUid, uid);
        if (repaint) repaint();
      };
    }
    const cat = el('span', 'jira-cat ' + (CAT_CLASS[r.statusCat] || ''));
    cat.title = CAT_LABEL[r.statusCat] || r.status;
    row.appendChild(cat);

    const main = el('div', 'jira-row-main');
    const line1 = el('div', 'jira-row-line');
    line1.append(el('span', 'jira-key', r.key), el('span', 'jira-summary', r.summary || '—'));
    const line2 = el('div', 'jira-row-meta');
    // В строке ровно четыре признака: статус · тип задачи · приоритет · спринт. Дата обновления
    // ушла в подсказку строки — иначе меты больше, чем самой задачи.
    const kindBadge = el('span', 'jira-type-badge', kindOf(r));
    if (r.kind && r.type && r.kind !== r.type) kindBadge.title = 'системный тип: ' + r.type;
    line2.append(
      el('span', 'jira-badge', r.status || '—'),
      kindBadge,
      el('span', 'jira-dim', r.priority || ''),
    );
    row.title = 'обновлено ' + fmtDate(r.updated);
    for (const s of (r.activeSprints || [])) line2.appendChild(el('span', 'jira-sprint-tag', s));
    if (accounts.length > 1) line2.appendChild(el('span', 'jira-dim jira-acc', accName(r.accId)));
    main.append(line1, line2);
    row.appendChild(main);

    const acts = el('div', 'jira-row-acts');
    const favBtn = iconBtn('drow-act jira-star' + (isFav(uid) ? ' on' : ''), 'star', isFav(uid) ? 'Убрать из избранного' : 'В избранное', 15);
    favBtn.onclick = (e) => { e.stopPropagation(); toggleFav(r); if (repaint) repaint(); };
    acts.appendChild(favBtn);
    const openBtn = iconBtn('drow-act', 'globe', 'Открыть в браузере', 15);
    openBtn.onclick = (e) => { e.stopPropagation(); lite.openExternal(r.url); };
    const agentBtn = iconBtn('drow-act', 'terminal', 'Отдать агенту в терминал', 15);
    agentBtn.onclick = (e) => { e.stopPropagation(); toAgent(r); };
    acts.append(openBtn, agentBtn);
    row.appendChild(acts);

    row.onclick = () => openIssue(r);
    return row;
  }

  // Отдать задачу агенту: это и есть смысл трекера внутри редактора, а не в браузере.
  // Карточку тянем свежую — в списке нет описания.
  async function toAgent(r) {
    const res = await lite.jira.issue(r.accId, r.key);
    const it = (res && res.ok && res.issue) ? res.issue : r;
    // Формат под работу агента: ключ задачи (он же имя ветки) и суть. Статус, приоритет и ссылка
    // агенту не нужны — это шум в промпте. Если тело описания пустое (частый случай у подзадач),
    // сутью выступает заголовок, иначе агент получил бы пустую задачу.
    const body = String(it.description || '').trim() || String(it.summary || '').trim();
    const text = 'номерзадачи/ветка: ' + it.key + '\nописание: ' + body;
    if (typeof sendToTerminal === 'function') { sendToTerminal(text); toast('Задача отправлена в терминал ✓'); }
    else { await navigator.clipboard.writeText(text); toast('Задача скопирована в буфер ✓'); }
  }

  // ---------------------------------------------------------------- карточка задачи
  // Раскладка карточки: слева — содержание задачи (описание, состав, обсуждение), справа —
  // «паспорт» (действия, люди, время, поля). Так глаз не ищет нужное среди всего подряд:
  // читают слева направо сверху вниз, а управляют — из одной колонки.
  async function openIssue(r) {
    markRead(r);   // открыли — значит прочитали: подсветка «новой» задачи снимается
    const { m, close } = makeModal('<div id="jira-card"></div>');
    m.classList.add('db-modal', 'jira-issue-modal');
    const root = m.querySelector('#jira-card');
    root.innerHTML = '<div class="git-loading">Загрузка задачи…</div>';

    const res = await lite.jira.issue(r.accId, r.key);
    if (!res || !res.ok) {
      root.innerHTML = '';
      root.appendChild(el('div', 'db-warn', '⚠ ' + ((res && res.error) || 'не удалось загрузить задачу')));
      return;
    }
    const it = res.issue;
    const transitions = res.transitions || [];
    root.innerHTML = '';

    const pp = it.people || {};
    const tt = it.time || {};
    const who = (u) => (u && u.name) ? u.name : '';
    const whoSub = (u) => (u && u.login && u.login !== u.name) ? u.login : '';

    // ---- шапка: идентификация задачи + основные действия
    const head = el('div', 'jira-card-head');
    const top = el('div', 'jira-head-top');
    const keyBtn = el('button', 'jira-head-key', it.key);
    keyBtn.title = 'Открыть в браузере';
    keyBtn.onclick = () => lite.openExternal(it.url);
    top.append(keyBtn);
    if (it.priority) top.appendChild(el('span', 'jira-head-prio', it.priority));
    top.appendChild(el('div', 'jira-head-space'));
    const favB = iconBtn('drow-act jira-star' + (isFav(uidOf(r)) ? ' on' : ''), 'star', 'В избранное', 15);
    favB.onclick = () => {
      toggleFav(r);
      favB.classList.toggle('on', isFav(uidOf(r)));
      if (repaint) repaint();
    };
    top.appendChild(favB);
    // Копирование всей карточки одним текстом: ключ, суть, описание и поля — то, что обычно
    // переносят в переписку или в свои заметки.
    const copyAllB = iconBtn('drow-act', 'clipboard', 'Скопировать задачу целиком', 15);
    copyAllB.onclick = async () => {
      const parts = [
        it.key + ' — ' + (it.summary || ''),
        it.url,
        'Статус: ' + (it.status || '—') + ' · Тип: ' + (it.type || '—') + ' · Приоритет: ' + (it.priority || '—'),
        pp.assignee && pp.assignee.name ? 'Исполнитель: ' + pp.assignee.name : '',
        '',
        it.description || '',
        (it.custom && it.custom.length) ? '\nПоля:\n' + it.custom.map((f) => f.name + ': ' + f.value).join('\n') : '',
      ].filter((x) => x !== '');
      await navigator.clipboard.writeText(parts.join('\n'));
      toast('Задача скопирована ✓');
    };
    top.appendChild(copyAllB);
    const copyB = iconBtn('drow-act', 'copy', 'Скопировать ссылку', 15);
    copyB.onclick = async () => { await navigator.clipboard.writeText(it.url); toast('Ссылка скопирована ✓'); };
    const extB = iconBtn('drow-act', 'globe', 'Открыть в Jira', 15);
    extB.onclick = () => lite.openExternal(it.url);
    const agentB = el('button', 'btn primary jira-head-agent', 'Отдать агенту');
    agentB.onclick = () => { toAgent(r); close(); };
    top.append(copyB, extB, agentB);
    head.appendChild(top);

    head.appendChild(el('div', 'jira-head-title', it.summary || '—'));

    const sub = el('div', 'jira-head-meta');
    const kindB = el('span', 'jira-type-badge', kindOf(it));
    if (it.kind && it.type && it.kind !== it.type) kindB.title = 'системный тип: ' + it.type;
    sub.append(kindB,
      el('span', 'jira-dim', it.projectName || it.project || ''),
      el('span', 'jira-dim', 'обновлено ' + fmtDate(it.updated)));
    for (const b of boardNamesOf(r)) sub.appendChild(el('span', 'jira-board-tag', b));
    for (const s of (it.activeSprints || [])) sub.appendChild(el('span', 'jira-sprint-tag', s));
    head.appendChild(sub);
    root.appendChild(head);

    // ---- панель управления над табами: статус со всеми переходами и учёт времени.
    // Это то, чем пользуются чаще всего, поэтому оно не прячется внутрь вкладок.
    const ctl = el('div', 'jira-ctl');

    const stBox = el('div', 'jira-ctl-box');
    stBox.appendChild(el('span', 'jira-ctl-l', 'Статус'));
    const stRow = el('div', 'jira-ctl-row');
    stRow.appendChild(el('span', 'jira-status-pill ' + (CAT_CLASS[it.statusCat] || ''), it.status || '—'));
    for (const t of transitions) {
      const b = el('button', 'btn jira-tr-btn', t.name);
      if (t.to) b.title = 'Перевести в статус: ' + t.to;
      b.onclick = async () => {
        // Переход с обязательными полями (resolution и пр.) нельзя выполнить вслепую —
        // уводим в браузер, а не гадаем, чем их заполнить.
        if (t.required && t.required.length) {
          const names = t.required.map((f) => f.name).join(', ');
          showConfirm('Переход требует полей',
            'Переход «' + t.name + '» требует заполнить: ' + names + '. Такие переходы пока выполняются в браузере.',
            'Открыть в Jira', () => lite.openExternal(it.url));
          return;
        }
        b.disabled = true;
        const rr = await lite.jira.transition(r.accId, it.key, t.id);
        if (rr && rr.ok) { toast('Статус изменён: ' + (t.to || t.name) + ' ✓'); close(); refresh(); }
        else { b.disabled = false; toast('Не удалось сменить статус: ' + ((rr && rr.error) || '?'), { kind: 'err' }); }
      };
      stRow.appendChild(b);
    }
    stBox.appendChild(stRow);
    ctl.appendChild(stBox);

    if (tt.original || tt.remaining || tt.spent) {
      const tBox = el('div', 'jira-ctl-box');
      tBox.appendChild(el('span', 'jira-ctl-l', 'Учёт времени'));
      const tRow = el('div', 'jira-ctl-row');
      const chip = (label, value) => {
        const c = el('span', 'jira-time-chip');
        c.append(el('span', 'jira-time-l', label), el('span', 'jira-time-v', value || '—'));
        return c;
      };
      tRow.append(chip('Оценка', tt.original), chip('Осталось', tt.remaining), chip('Затрачено', tt.spent));
      // Полоса «затрачено от оценки» — по секундам, чтобы не разбирать «2d 4h» и не гадать
      // о длине рабочего дня в этой инсталляции.
      if (tt.originalSecs > 0) {
        const pct = Math.min(100, Math.round((tt.spentSecs / tt.originalSecs) * 100));
        const barWrap = el('span', 'jira-time-progress');
        const bar = el('div', 'jira-time-bar');
        const fill = el('div', 'jira-time-fill' + (pct >= 100 ? ' over' : ''));
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        barWrap.append(bar, el('span', 'jira-dim', pct + '%'));
        tRow.appendChild(barWrap);
      }
      tBox.appendChild(tRow);
      ctl.appendChild(tBox);
    }
    root.appendChild(ctl);

    // ---- вкладки: содержание карточки во всю ширину, а не в узкой колонке
    const tabsBar = el('div', 'jira-card-tabs');
    const pane = el('div', 'jira-card-pane');
    root.append(tabsBar, pane);

    const block = (host, title, node, extra) => {
      const b = el('div', 'jira-block');
      const h = el('div', 'jira-block-head');
      h.appendChild(el('span', 'jira-block-title', title));
      if (extra) { h.append(el('div', 'jira-head-space'), extra); }
      b.append(h, node);
      host.appendChild(b);
    };

    function buildDesc(host) {
      if (!it.description) { host.appendChild(el('div', 'jira-dim', 'Описание пустое')); return; }
      // Текст уже очищен от wiki-разметки на бэкенде (см. wikiToText), содержимое {code} сохранено.
      const d = el('div', 'jira-desc');
      d.textContent = it.description;
      const copy = iconBtn('drow-act', 'copy', 'Скопировать описание', 15);
      copy.onclick = async () => {
        await navigator.clipboard.writeText(it.description);
        toast('Описание скопировано ✓');
      };
      block(host, 'Описание', d, copy);
    }

    function buildLinks(host) {
      if (it.parentIssue) {
        const p = el('div', 'jira-sub-row jira-clickable');
        p.append(el('span', 'jira-key', it.parentIssue.key),
          el('span', 'jira-summary', it.parentIssue.summary),
          el('span', 'jira-badge', it.parentIssue.status || ''));
        p.onclick = () => lite.openExternal(it.url.replace(/\/browse\/[^/]+$/, '/browse/' + it.parentIssue.key));
        block(host, 'Головная задача', p);
      }
      if (it.subtasks && it.subtasks.length) {
        const box = el('div', 'jira-sub');
        for (const s of it.subtasks) {
          const b = el('div', 'jira-sub-row jira-clickable');
          b.append(el('span', 'jira-key', s.key), el('span', 'jira-summary', s.summary), el('span', 'jira-badge', s.status));
          b.onclick = () => lite.openExternal(it.url.replace(/\/browse\/[^/]+$/, '/browse/' + s.key));
          box.appendChild(b);
        }
        block(host, 'Подзадачи (' + it.subtasks.length + ')', box);
      }
      if (it.links && it.links.length) {
        const box = el('div', 'jira-sub');
        for (const l of it.links) {
          const b = el('div', 'jira-sub-row jira-clickable');
          b.append(el('span', 'jira-link-type', l.type), el('span', 'jira-key', l.key), el('span', 'jira-summary', l.summary));
          b.onclick = () => lite.openExternal(it.url.replace(/\/browse\/[^/]+$/, '/browse/' + l.key));
          box.appendChild(b);
        }
        block(host, 'Связи (' + it.links.length + ')', box);
      }

      const disc = el('div', 'jira-discussion');
      if (it.comments && it.comments.length) {
        const box = el('div', 'jira-comments');
        for (const c of it.comments) {
          const cb = el('div', 'jira-comment');
          cb.append(el('div', 'jira-comment-who', (c.author || '—') + ' · ' + fmtDate(c.created)),
            el('div', 'jira-comment-body', c.body || ''));
          box.appendChild(cb);
        }
        disc.appendChild(box);
      } else disc.appendChild(el('div', 'jira-dim', 'Комментариев пока нет'));

      const cf = el('div', 'jira-comment-form');
      const ta = el('textarea', 'jira-comment-input');
      ta.placeholder = 'Написать комментарий…';
      const send = el('button', 'btn', 'Отправить');
      send.onclick = async () => {
        const text = ta.value.trim();
        if (!text) { toast('Комментарий пуст', { kind: 'err' }); return; }
        send.disabled = true;
        const rr = await lite.jira.comment(r.accId, it.key, text);
        send.disabled = false;
        if (rr && rr.ok) { ta.value = ''; toast('Комментарий добавлен ✓'); }
        else toast('Не удалось добавить комментарий: ' + ((rr && rr.error) || '?'), { kind: 'err' });
      };
      cf.append(ta, send);
      disc.appendChild(cf);
      block(host, 'Обсуждение' + (it.comments && it.comments.length ? ' (' + it.comments.length + ')' : ''), disc);
    }

    function buildPeople(host) {
      // Люди — одной строкой: это справка, а не список для чтения сверху вниз.
      const people = el('div', 'jira-people-row');
      const personCard = (label, u) => {
        if (!u || !u.name) return;
        const card = el('div', 'jira-person');
        const av = el('span', 'jira-avatar', (u.name.trim()[0] || '?').toUpperCase());
        const txt = el('div', 'jira-person-txt');
        txt.append(el('div', 'jira-person-name', who(u)), el('div', 'jira-person-sub', label + (whoSub(u) ? ' · ' + whoSub(u) : '')));
        card.append(av, txt);
        people.appendChild(card);
      };
      personCard('исполнитель', pp.assignee);
      personCard('автор', pp.reporter);
      if (pp.creator && pp.reporter && pp.creator.login !== pp.reporter.login) personCard('создатель', pp.creator);
      if (people.childElementCount) block(host, 'Люди', people);

      if (!it.custom || !it.custom.length) {
        block(host, 'Поля задачи', el('div', 'jira-dim', 'Дополнительных полей нет'));
        return;
      }

      // Поля инсталляции («Тип задачи», «Ранг задачи», «В группу разработки», Sprint…): две
      // колонки, поиск и — когда полей много — саб-табы по алфавиту. Иначе вкладка превращается
      // в простыню, которую приходится листать до конца.
      const fieldsWrap = el('div', 'jira-fields-wrap');
      const tools = el('div', 'jira-fields-tools');
      const subBar = el('div', 'jira-subtabs');
      const search = el('input', 'jira-filter jira-field-search');
      search.placeholder = 'Поиск по полям…';
      tools.append(subBar, search);
      const grid = el('div', 'jira-fields');
      fieldsWrap.append(tools, grid);

      // Поля приходят отсортированными по имени, поэтому деление на равные куски даёт
      // осмысленные алфавитные диапазоны.
      const PER = 12;
      const parts = [];
      const n = Math.min(4, Math.max(1, Math.ceil(it.custom.length / PER)));
      if (n > 1) {
        const per = Math.ceil(it.custom.length / n);
        for (let i = 0; i < it.custom.length; i += per) parts.push(it.custom.slice(i, i + per));
      } else parts.push(it.custom);

      let part = 0;
      const drawFields = () => {
        const q = search.value.trim().toLowerCase();
        // При поиске саб-табы не мешают: ищем сразу по всем полям.
        const list = q
          ? it.custom.filter((f) => (f.name + ' ' + f.value).toLowerCase().includes(q))
          : parts[part];
        subBar.classList.toggle('hidden', parts.length < 2 || !!q);
        grid.innerHTML = '';
        if (!list.length) { grid.appendChild(el('div', 'jira-dim', 'Ничего не найдено')); return; }
        for (const fl of list) {
          const row = el('div', 'jira-field-row');
          row.append(el('span', 'jira-field-n', fl.name), el('span', 'jira-field-v', fl.value));
          grid.appendChild(row);
        }
      };
      const drawSub = () => {
        subBar.innerHTML = '';
        parts.forEach((p, i) => {
          const from = (p[0].name[0] || '').toUpperCase();
          const to = (p[p.length - 1].name[0] || '').toUpperCase();
          const b = el('button', 'jira-subtab' + (i === part ? ' active' : ''), from + '–' + to);
          b.title = p.length + ' полей';
          b.onclick = () => { part = i; drawSub(); drawFields(); };
          subBar.appendChild(b);
        });
      };
      search.oninput = () => drawFields();
      drawSub();
      drawFields();
      block(host, 'Поля задачи (' + it.custom.length + ')', fieldsWrap);
    }

    const TABS = [
      { id: 'desc', label: 'Описание', build: buildDesc },
      { id: 'links', label: 'Связи и обсуждение', build: buildLinks },
      { id: 'people', label: 'Люди и поля задачи', build: buildPeople },
    ];
    let cardTab = TABS.some((t) => t.id === ui.cardTab) ? ui.cardTab : 'desc';
    const drawTab = () => {
      tabsBar.innerHTML = '';
      pane.innerHTML = '';
      for (const t of TABS) {
        const b = el('button', 'jira-card-tab' + (t.id === cardTab ? ' active' : ''), t.label);
        b.onclick = () => { cardTab = t.id; ui.cardTab = cardTab; saveUi(); drawTab(); };
        tabsBar.appendChild(b);
      }
      (TABS.find((t) => t.id === cardTab) || TABS[0]).build(pane);
    };
    drawTab();
  }

  // ---------------------------------------------------------------- вкладка «Аккаунты»
  function renderAccounts(wrap) {
    wrap.innerHTML = '';
    const top = el('div', 'db-topbar');
    top.appendChild(el('span', 'db-topbar-title', 'Аккаунты Jira'));
    const add = iconBtn('drow-act', 'plus', 'Новый аккаунт', 16);
    add.onclick = () => accModal(null);
    top.appendChild(add);
    wrap.appendChild(top);

    if (!secure)
      wrap.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — токены шифруются слабее.'));

    if (!accounts.length) {
      const empty = el('div', 'jira-help');
      empty.appendChild(el('div', 'jira-help-title', 'Нет аккаунтов. Добавьте первый кнопкой ＋'));
      const ul = el('div', 'jira-help-body');
      ul.innerHTML = [
        '<b>Jira Server / Data Center</b> (в том числе за SSO — Keycloak, ADFS, Okta):',
        'профиль в Jira → <b>Personal Access Tokens</b> → создать токен. Режим — <b>PAT</b>.',
        'Вход по SSO остаётся в браузере: REST API принимает токен напрямую.',
        '',
        '<b>Jira Cloud</b> (адрес вида <i>компания.atlassian.net</i>):',
        'id.atlassian.com → Security → <b>API tokens</b>. Режим — <b>Basic</b>, логин — ваш e-mail.',
        '',
        'Токен хранится зашифрованным средствами ОС и в интерфейс больше не возвращается.',
      ].join('<br>');
      empty.appendChild(ul);
      wrap.appendChild(empty);
      return;
    }

    const list = el('div', 'jira-acc-list');
    for (const a of accounts) {
      const card = el('div', 'jira-acc-card');
      const l = el('div', 'jira-acc-main');
      l.append(el('div', 'jira-acc-name', a.name), el('div', 'jira-dim', a.host));
      const m = el('div', 'jira-row-meta');
      m.append(
        el('span', 'jira-badge', a.mode === 'basic' ? 'Basic (Cloud)' : 'PAT (Server/DC)'),
        el('span', 'jira-dim', a.login || ''),
        el('span', 'jira-dim' + (a.hasToken ? '' : ' jira-warn-text'), a.hasToken ? 'токен сохранён' : 'токен не задан'),
      );
      l.appendChild(m);
      card.appendChild(l);

      const acts = el('div', 'jira-row-acts');
      const edit = iconBtn('drow-act', 'pencil', 'Изменить', 15);
      edit.onclick = () => accModal(a);
      const test = iconBtn('drow-act', 'check', 'Проверить связь', 15);
      test.onclick = async () => {
        const r = await lite.jira.test({ id: a.id });
        if (r && r.ok) toast('Связь есть: ' + r.user + (r.version ? ' · Jira ' + r.version : '') + ' ✓');
        else toast('Проверка не прошла: ' + ((r && r.error) || '?'), { kind: 'err' });
      };
      const del = iconBtn('drow-act', 'trash', 'Удалить', 15);
      del.onclick = () => {
        showConfirm('Удалить аккаунт', 'Аккаунт «' + a.name + '» и его сохранённый токен будут стёрты.', 'Удалить', async () => {
          const r = await lite.jira.delete(a.id);
          if (r && r.ok) { loaded = false; toast('Аккаунт удалён'); renderPanel(); }
          else toast('Не удалось удалить аккаунт: ' + ((r && r.error) || '?'), { kind: 'err' });
        });
      };
      acts.append(edit, test, del);
      card.appendChild(acts);
      list.appendChild(card);
    }
    wrap.appendChild(list);
  }

  function accModal(existing) {
    const { m, close } = makeModal('<h2 class="jira-modal-h"></h2><div id="jira-accf" class="db-form"></div>');
    m.classList.add('db-modal', 'db-conn-modal');
    m.querySelector('.jira-modal-h').textContent = existing ? 'Аккаунт Jira' : 'Новый аккаунт Jira';
    const f = m.querySelector('#jira-accf');

    const field = (label, node, hint) => {
      const w = el('div', 'db-field');
      w.append(el('label', null, label), node);
      if (hint) w.appendChild(el('div', 'jira-hint', hint));
      return w;
    };

    const name = el('input'); name.value = existing ? existing.name : '';
    name.placeholder = 'Работа / Личный / Клиент';
    const hostI = el('input'); hostI.value = existing ? existing.host : '';
    hostI.placeholder = 'https://jira.компания.ru или https://компания.atlassian.net';
    const mode = el('select');
    mode.append(new Option('PAT — Server / Data Center (в т.ч. за SSO)', 'pat'), new Option('Basic — Jira Cloud (e-mail + API-токен)', 'basic'));
    mode.value = existing ? (existing.mode || 'pat') : 'pat';
    const login = el('input'); login.value = existing ? (existing.login || '') : '';
    login.placeholder = 'e-mail аккаунта Atlassian';
    const token = el('input'); token.type = 'password';
    token.placeholder = existing && existing.hasToken ? '•••••••• (сохранён, введите новый чтобы заменить)' : 'вставьте токен';

    const loginBox = field('Логин (e-mail)', login, 'Нужен только для Jira Cloud; для PAT оставьте пустым.');
    const syncMode = () => { loginBox.classList.toggle('hidden', mode.value !== 'basic'); };
    mode.onchange = syncMode;

    f.append(
      field('Название', name),
      field('Адрес Jira', hostI, 'Корень сайта, без /rest и без /browse.'),
      field('Авторизация', mode, 'PAT работает мимо SSO: вход через Keycloak остаётся в браузере, API принимает токен.'),
      loginBox,
      field('Токен', token, 'Хранится зашифрованным средствами ОС; обратно в интерфейс не возвращается.'),
    );

    // Поле «Тип задачи»: во многих инсталляциях работу классифицирует кастомное поле
    // («Разработка», «Проверка CR»), а системный тип у всех задач одинаковый. Имя такого поля
    // угадывается не всегда — здесь его можно указать явно, раз и навсегда.
    const typeSel = el('select');
    typeSel.appendChild(new Option('определять автоматически', ''));
    f.appendChild(field('Поле «Тип задачи»', typeSel,
      'Его значения показываются бейджем в списке и наполняют фильтр «Типы задач».'));
    if (existing && existing.hasToken) {
      lite.jira.fields(existing.id).then((r) => {
        if (!r || !r.ok) { toast('Не удалось получить список полей: ' + ((r && r.error) || '?'), { kind: 'err' }); return; }
        for (const fl of r.fields) typeSel.appendChild(new Option(fl.name + '  ·  ' + fl.id, fl.id));
        if (r.typeFieldId) {
          const auto = [...typeSel.options].find((o) => o.value === r.typeFieldId);
          if (auto) auto.textContent += '  ← определено автоматически';
        }
        typeSel.value = existing.typeField || '';
      }).catch((e) => toast('Не удалось получить список полей: ' + String(e && e.message || e), { kind: 'err' }));
    }
    syncMode();

    const status = el('span', 'db-test-status');
    const row = el('div', 'gm-actions');

    const collect = () => ({
      id: existing ? existing.id : undefined,
      name: name.value.trim(), host: hostI.value.trim(), mode: mode.value,
      login: login.value.trim(), typeField: typeSel.value,
      ...(token.value ? { token: token.value } : {}),
    });

    const testB = el('button', 'btn', 'Проверить');
    testB.onclick = async () => {
      const acc = collect();
      if (!acc.host) { toast('Не задан адрес Jira', { kind: 'err' }); return; }
      if (!acc.token && !(existing && existing.hasToken)) { toast('Не задан токен', { kind: 'err' }); return; }
      status.textContent = 'Проверяю…'; status.className = 'db-test-status';
      const r = await lite.jira.test(acc);
      if (r && r.ok) {
        status.textContent = '✓ ' + r.user + (r.version ? ' · Jira ' + r.version : '') + (r.deployment ? ' · ' + r.deployment : '');
        status.classList.add('ok');
      } else { status.textContent = '✕ ' + ((r && r.error) || 'не удалось'); status.classList.add('err'); }
    };

    const saveB = el('button', 'btn primary', 'Сохранить');
    saveB.onclick = async () => {
      const acc = collect();
      if (!acc.name) { toast('Не задано название', { kind: 'err' }); return; }
      if (!acc.host) { toast('Не задан адрес Jira', { kind: 'err' }); return; }
      const r = await lite.jira.save(acc);
      if (r && r.ok) { loaded = false; close(); toast('Аккаунт сохранён ✓'); renderPanel(); }
      else toast('Не удалось сохранить: ' + ((r && r.error) || '?'), { kind: 'err' });
    };

    const cancel = el('button', 'btn', 'Отмена');
    cancel.onclick = close;
    row.append(testB, saveB, cancel);
    f.append(row, status);   // f уже внутри модалки (#jira-accf) — добавлять её ещё раз не нужно
  }

  // ---------------------------------------------------------------- вкладка «Структура»
  function renderRecon(wrap) {
    wrap.innerHTML = '';
    if (!accounts.length) {
      wrap.appendChild(el('div', 'docker-empty', 'Сначала добавьте аккаунт на вкладке «Аккаунты».'));
      return;
    }

    const top = el('div', 'db-topbar');
    const sel = el('select', 'jira-sel');
    for (const a of accounts) sel.appendChild(new Option(a.name, a.id));
    sel.value = ui.reconAcc && accounts.some((a) => a.id === ui.reconAcc) ? ui.reconAcc : accounts[0].id;
    top.appendChild(sel);

    const withTexts = el('input'); withTexts.type = 'checkbox'; withTexts.id = 'jira-recon-texts';
    const lab = el('label', 'jira-check');
    lab.append(withTexts, el('span', null, 'включить примеры задач (тексты попадут в отчёт)'));
    top.appendChild(lab);

    const run = el('button', 'btn primary', 'Просканировать');
    top.appendChild(run);
    wrap.appendChild(top);

    wrap.appendChild(el('div', 'jira-hint',
      'Сканирование только читает: собирает проекты, статусы, типы, кастомные поля, доски и раскладку ваших задач. Тексты задач в отчёт не попадают, пока галка выше не включена.'));

    const out = el('div', 'jira-recon-out');
    wrap.appendChild(out);

    run.onclick = async () => {
      ui.reconAcc = sel.value; saveUi();
      out.innerHTML = '<div class="git-loading">Читаю структуру Jira… это может занять до минуты</div>';
      const r = await lite.jira.recon(sel.value, withTexts.checked);
      if (!r || !r.ok) {
        out.innerHTML = '';
        out.appendChild(el('div', 'db-warn', '⚠ ' + ((r && r.error) || 'не удалось прочитать структуру')));
        return;
      }
      report = r.report;
      paintReport(out);
    };

    if (report) paintReport(out);
  }

  function paintReport(out) {
    out.innerHTML = '';
    const rep = report;

    const stat = (label, value) => {
      const c = el('div', 'jira-stat');
      c.append(el('div', 'jira-stat-v', String(value)), el('div', 'jira-stat-l', label));
      return c;
    };
    const stats = el('div', 'jira-stats');
    stats.append(
      stat('проектов видно', rep.projects.length),
      stat('моих задач', rep.mine.total ?? rep.mine.scanned),
      stat('в работе', rep.mine.byCategory.indeterminate),
      stat('к выполнению', rep.mine.byCategory.new),
      stat('кастомных полей', rep.fields.custom.length),
      stat('досок', rep.boards === null ? 'нет Agile' : rep.boards.length),
    );
    out.appendChild(stats);

    const srv = el('div', 'jira-hint',
      'Jira ' + ((rep.server && rep.server.version) || '?') + ' · ' + ((rep.server && rep.server.deploymentType) || 'тип не определён') +
      ' · пользователь: ' + rep.me.displayName + ' · пагинация: ' + (rep.searchMode === 'jql' ? 'курсор (Cloud)' : 'startAt (Server/DC)'));
    out.appendChild(srv);

    if (rep.mine.truncated)
      out.appendChild(el('div', 'db-warn', '⚠ Задач больше, чем удалось просмотреть за один проход — счётчики по проектам показывают первые 500.'));

    const sec = (title, node) => { out.appendChild(el('div', 'jira-sec-title', title)); out.appendChild(node); };

    if (rep.mine.byProject.length) {
      const box = el('div', 'jira-sub');
      for (const p of rep.mine.byProject) {
        const row = el('div', 'jira-sub-row');
        row.append(el('span', 'jira-key', p.key), el('span', 'jira-summary', p.name || ''),
          el('span', 'jira-badge', p.open + ' откр. / ' + p.total));
        box.appendChild(row);
      }
      sec('Мои задачи по проектам', box);
    }

    if (rep.mine.byStatus.length) {
      const box = el('div', 'jira-chips');
      for (const s of rep.mine.byStatus) box.appendChild(el('span', 'jira-chip on', s.name + ' · ' + s.count));
      sec('Статусы, которые реально используются', box);
    }

    if (rep.fields.custom.length) {
      const box = el('div', 'jira-sub');
      for (const f of rep.fields.custom.slice(0, 40)) {
        const row = el('div', 'jira-sub-row');
        row.append(el('span', 'jira-key', f.id), el('span', 'jira-summary', f.name), el('span', 'jira-dim', f.type || ''));
        box.appendChild(row);
      }
      sec('Кастомные поля (' + rep.fields.custom.length + ')', box);
    }

    if (rep.boards && rep.boards.length) {
      const box = el('div', 'jira-chips');
      for (const b of rep.boards.slice(0, 40)) box.appendChild(el('span', 'jira-chip on', b.name + ' · ' + b.type));
      sec('Доски', box);
    }

    if (rep.favouriteFilters.length) {
      const box = el('div', 'jira-sub');
      for (const f of rep.favouriteFilters) {
        const row = el('div', 'jira-sub-row');
        row.append(el('span', 'jira-summary', f.name), el('span', 'jira-dim', f.jql || ''));
        box.appendChild(row);
      }
      sec('Ваши избранные фильтры', box);
    }

    const acts = el('div', 'jira-acts');
    const saveB = el('button', 'btn primary', 'Сохранить отчёт в файл');
    saveB.onclick = async () => {
      const r = await lite.jira.reconSave(report);
      if (r && r.ok) toast('Отчёт сохранён: ' + r.file, { ttl: 8000 });
      else toast('Не удалось сохранить отчёт: ' + ((r && r.error) || '?'), { kind: 'err' });
    };
    const copyB = el('button', 'btn', 'Скопировать отчёт');
    copyB.onclick = async () => {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast('Отчёт скопирован в буфер ✓');
    };
    acts.append(saveB, copyB);
    out.appendChild(acts);
  }

  // ---------------------------------------------------------------- refresh (кнопка шапки окна)
  function refresh() {
    if (!jiraOpen) return;
    loaded = false;
    rows = [];
    renderPanel();
  }

  return { isOpen: () => jiraOpen, setOpen: setJiraOpen, toggle: toggleJira, renderPanel, refresh };
}
