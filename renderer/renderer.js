// LiteEditor renderer — projects, per-project terminal, viewer, file tree,
// custom titlebar, menu, modals. Talks to the backend only via window.lite.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
// WebGL/Canvas/Unicode11-аддоны здесь не нужны: их подключает termutil.js (loadFastRenderer/applyUnicode11).
import '@xterm/xterm/css/xterm.css';

// CodeMirror/marked/showMinimap/codeedit — переехали в окно вивера (renderer/modules/files.js).
// В ядре остались только терминал (xterm) + темы/термутилы.
import { initI18n, t as tt } from './i18n.js';
import { syncSettings } from './settings-sync.js';
import { applyLook, termThemeFor, lookOf, lookTokens, LOOK_BASE_NAMES, LOOK_STATUS_NAMES, LOOK_TOKEN_NAMES, THEME_NAME } from './themes.js';
import { FRAME_COLORS, frameConf, applyFrame } from './frame.js';
import { prepareRenderer, activateRenderer, releaseRenderer, applyUnicode11, copySelection, ptyResizer } from './termutil.js';
import { attachTimeline } from './termtimeline.js';
// initTextProc — «Обработка текста» мигрирована в отдельное окно (renderer/module-entry.js).
import { el, icon, iconBtn, hydrateIcons, toast, makeModal, showConfirm, showPrompt, baseName, ICONS, setErrorSink } from './ui.js';
// initGit — модуль «Git» мигрирован в отдельное окно (renderer/module-entry.js).
// initCtx — модуль «Контекст» мигрирован в отдельное окно (renderer/module-entry.js).
// initContainers — модуль «Контейнеры» мигрирован в отдельное окно (renderer/module-entry.js).
// initDb — модуль «Базы данных» мигрирован в отдельное окно (renderer/module-entry.js).
// initRh — модуль «Удалённые хосты» мигрирован в отдельное окно (renderer/module-entry.js).
// initNotes / initAudit / initSeo / initTools / initIterflow — модули мигрированы в отдельные окна (renderer/module-entry.js).
// initOpenRouter — чат мигрирован в отдельное окно (renderer/module-entry.js).
import { openGlobalSearch } from './gsearch.js';
import { initExtensions } from './modules/extensions.js';
// initFiles — вивер+дерево мигрированы в отдельное окно (renderer/module-entry.js).

const APP_VERSION = 'alpha v1.1.203';
const GUTTER = 8; // зазор между карточками окна — он же разделитель, за который тянется ширина
// Системный терминал («Система · ~») мигрирован в отдельное окно (renderer/modules/scratch.js):
// его id `__scratch__::tN` маршрутизируются main'ом в окно-владельца, в ядре их больше не обрабатываем.

const lite = window.lite;
const $ = (sel) => document.querySelector(sel);
// el/svgEl/иконки/тосты/модалки/baseName переехали в ui.js (этап «модульный рефакторинг»).

// ---------------------------------------------------------------- global store (~/.LiteEditor)
// Synchronous snapshot loaded once; reads are in-memory, writes go through to disk.
const STORE = lite.store.loadAll();
function persist(key, value) { STORE[key] = value; lite.store.set(key, value); }
// One-time import from the old localStorage layout (builds before ~/.LiteEditor).
(function migrateLocalStorage() {
  if (STORE.projects !== undefined) return;
  let did = false;
  for (const k of ['projects', 'layout', 'recents', 'settings']) {
    try { const raw = localStorage.getItem('lite.' + k); if (raw != null) { persist(k, JSON.parse(raw)); did = true; } } catch (_) {}
  }
  const lp = localStorage.getItem('lite.lastParent'); if (lp) persist('lastParent', lp);
  if (did) console.log('[LiteEditor] state migrated from localStorage → ~/.LiteEditor');
})();
// Stable id derived from the path, so categories/notes/favorites survive a rescan.
function projId(p) { let h = 5381; for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0; return 'p' + h.toString(36); }

// ---------------------------------------------------------------- settings (tiny on purpose)
const DEFAULT_SETTINGS = { notifications: true, sound: false, idleMs: 1200, fontSize: 13, workingDir: '', scanDirs: [], onboarded: false, shell: '', minimap: true, notesTab: 'project', frameOn: true, frameColor: 'green', framePulse: true, framePeriodS: 6, termTimeline: false, termPrefill: 'claude' };
function loadSettings() { return { ...DEFAULT_SETTINGS, ...(STORE.settings || {}) }; }
let settings = loadSettings();
// Пишем только изменённые поля, чужие изменения (окна модулей, смена языка) вливаются в settings —
// см. renderer/settings-sync.js. base = то, что на диске: первый save запишет и дефолты, как раньше.
const settingsSync = syncSettings(lite, settings, { base: STORE.settings });
function saveSettings() { STORE.settings = settings; settingsSync.save(); }

// ---------------------------------------------------------------- state
let projects = [];
// Пути проектов, которые демон синхронизации держит в согласии с сервером: по ним
// в плашке появляется метка «sync». Держим множеством, потому что makeCard —
// синхронный, а ответ главного процесса приходит обещанием.
let syncedPaths = new Set();
// Задан ли сервер синхронизации. Нет — облачко серое и открывает мастер подключения
// (showSyncSetup), а не подключение проекта: до этого редактор ни с каким сервером не соединяется.
let syncAvailable = false;
let activeId = null;
const terms = new Map();          // sessionId -> { term, fit, search, container, projId, name, ... }
const tabsByProj = new Map();     // projId -> { sessions: [sessionId...], active: sessionId }
let sessionSeq = 0;
// Терминалы прежней страницы, пережившие перезагрузку окна (pty:adoptable): projId → [sessionId…] по порядку вкладок.
const adoptPtys = new Map();
// Метка этой загрузки страницы в id сессий. После перезагрузки окна (падение рендерера, импорт
// настроек) нумерация вкладок начинается заново, и без метки новая вкладка получила бы id ещё живого
// шелла старой страницы — возможно, чужого проекта (pty:create отвечает existed и цепляет его).
const BOOT_ID = Date.now().toString(36);
const projState = new Map(); // sessionId -> 'quiet' | 'busy' | 'waiting'
const missing = new Set();   // ids of projects whose folder no longer exists on disk
// Состояние вивера+дерева (expandedDirs/gitFiles/currentFile/dirty/…) живёт в отдельном ОКНЕ —
// renderer/modules/files.js (initFiles) + module-entry.js. Ядро его не держит (см. WINDOW_MODULES).

// OpenRouter (чат) и «Обработка текста» — панели правого слота. Их инициализация и регистрация
// в реестре панелей — ниже, вместе с git/audit/… (нужны layout/GUTTER/closeOtherPanels, объявленные
// после этого места). Сами модули держат своё внутреннее состояние (активный ключ/документ).

// Терминалы dev-папок пользовательских модулей: живут ВНУТРИ панели «Модули» (#ext-pane),
// не в области проектов и не среди скретч-вкладок. cwd = папка модуля.
const EXT_TERM_ID = '__extterm__';
const isExtTerm = (id) => typeof id === 'string' && id.startsWith(EXT_TERM_ID);
const extTerms = new Map(); // ptyId -> { term, fit, search, container }
let extTermSeq = 0;

const DEFAULT_LAYOUT = { sidebar: 300, viewer: 520, tree: 240, scratch: 420, ctx: 740, docker: 460, db: 560, rh: 520, ext: 420, notes: 480, audit: 460, iterflow: 480, seo: 480, tools: 560, chat: 600, doc: 640 };
let layout = loadLayout();
let lastParent = STORE.lastParent || '';

// Тема одна — «Графит», палитра настраивается (settings.look → renderer/themes.js, общая с окнами модулей).
// Терминалы окна редактора стоят на полупрозрачном фоне окна — их собственный фон прозрачный.
function termTheme() { return termThemeFor(settings, { glass: true }); }
function applyTheme() {
  applyLook(settings);
  for (const rec of terms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  for (const rec of extTerms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  try { Ext.notifyTheme(THEME_NAME); } catch (_) {} // пользовательские модули: ctx.theme.onChange
  try { lite.app.settingsChanged(settings); } catch (_) {} // окна модулей: применить тему/настройки
}

const activeProject = () => projects.find((p) => p.id === activeId);

// ---------------------------------------------------------------- persistence
function saveProjects() { persist('projects', projects); }
function loadProjectsFromDisk() { return Array.isArray(STORE.projects) ? STORE.projects : []; }
function loadLayout() { return { ...DEFAULT_LAYOUT, ...(STORE.layout || {}) }; }
function saveLayout() { persist('layout', layout); }
const SIDEBAR_MIN = 240, SIDEBAR_MAX = 480; // уже 240 не влезают кнопки боковой карточки
function applyLayout() {
  layout.sidebar = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, +layout.sidebar || DEFAULT_LAYOUT.sidebar));
  $('#sidebar').style.flexBasis = layout.sidebar + 'px';
  // вивер/дерево живут в своём окне — в редакторе этих панелей больше нет.
  $('#ext-pane').style.flexBasis = layout.ext + 'px';
}
function loadRecents() { return Array.isArray(STORE.recents) ? STORE.recents : []; }
function pushRecent(p) {
  const r = loadRecents().filter((x) => x.path !== p.path);
  r.unshift({ path: p.path, name: p.name });
  persist('recents', r.slice(0, 30));
}
// ---------------------------------------------------------------- projects column
const UNCATEGORIZED = 'Все';
const FAV_KEY = '__fav';
// Фильтр списка проектов (поле над списком). Пустая строка = фильтра нет. Токены ищутся И-условием
// по «имя + путь», поэтому «lite web» находит LiteWebEditor, а «home lite» — его же по пути.
// Пока фильтр активен, секции показываются РАЗВЁРНУТЫМИ: свёрнутая категория прятала бы находки.
let projFilter = '';
function matchesFilter(p) {
  if (!projFilter) return true;
  const hay = ((p.name || '') + ' ' + (p.path || '')).toLowerCase();
  return projFilter.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
}
const ARCHIVE = 'Архив'; // спец-категория: всегда последняя, без перестановки стрелками, свёрнута по дефолту
function loadCategories() { return Array.isArray(STORE.categories) ? STORE.categories : []; }
function saveCategories(c) { persist('categories', c); }
function isCollapsed(key) { return !!(STORE.accordions || {})[key]; }
function setCollapsed(key, v) { persist('accordions', { ...(STORE.accordions || {}), [key]: v }); }
function loadSectionOrder() { return Array.isArray(STORE.sectionOrder) ? STORE.sectionOrder.slice() : null; }
function saveSectionOrder(o) { persist('sectionOrder', o); }
// Ручной порядок карточек в «Избранном» (DnD): массив id. Кто не в списке — в конец
// в исходном порядке projects (стабильная сортировка). Снятие ★ удаляет id из списка,
// поэтому повторное добавление ставит карточку в самый низ группы.
function loadFavOrder() { return Array.isArray(STORE.favOrder) ? STORE.favOrder : []; }
function saveFavOrder(ids) { persist('favOrder', ids); }
function sortFavs(list) {
  const idx = new Map(loadFavOrder().map((id, i) => [id, i]));
  return list.slice().sort((a, b) => (idx.has(a.id) ? idx.get(a.id) : Infinity) - (idx.has(b.id) ? idx.get(b.id) : Infinity));
}

// Section display order. Default = "избранное / <категории> / все"; persisted once
// reordered. effectiveOrder() reconciles the stored order with the keys that exist
// now: drops gone categories, and slots new ones in just before «Все».
function effectiveOrder() {
  const hasArchive = loadCategories().includes(ARCHIVE);
  const cats = loadCategories().filter((c) => c !== ARCHIVE); // Архив раскладывается отдельно — всегда в самый конец
  const keys = [FAV_KEY, ...cats, UNCATEGORIZED];
  const stored = loadSectionOrder();
  let order;
  if (!stored) order = keys.slice();
  else {
    order = [...new Set(stored)].filter((k) => keys.includes(k) && k !== ARCHIVE); // Set — лечит дубли, записанные прежним переименованием
    for (const k of keys) {
      if (order.includes(k)) continue;
      if (k === UNCATEGORIZED) { order.push(k); continue; }
      const at = order.indexOf(UNCATEGORIZED);
      if (at >= 0) order.splice(at, 0, k); else order.push(k);
    }
  }
  if (hasArchive) order.push(ARCHIVE); // всегда последняя, позиция из стора игнорируется
  return order;
}
// Sections that actually render now, in display order (★ Избранное only when non-empty).
function buildSections() {
  const cats = loadCategories();
  const favs = sortFavs(projects.filter((p) => p.favorite));
  const secs = effectiveOrder().map((key) => {
    if (key === FAV_KEY) return favs.length ? { key, label: 'Избранное', list: favs, pinned: true } : null;
    if (key === UNCATEGORIZED) return { key, label: UNCATEGORIZED, pinned: false, list: projects.filter((p) => !p.favorite && !cats.includes(p.category)) };
    if (key === ARCHIVE) { const list = projects.filter((p) => !p.favorite && p.category === ARCHIVE); return list.length ? { key, label: 'Архив', list, pinned: false } : null; }
    return { key, label: key, pinned: false, list: projects.filter((p) => !p.favorite && p.category === key) };
  }).filter(Boolean);
  if (!projFilter) return secs;
  // под фильтром пустая категория — шум: показываем только секции, где что-то нашлось
  return secs.map((s) => ({ ...s, list: s.list.filter(matchesFilter) })).filter((s) => s.list.length);
}
function moveSection(key, dir) {
  if (key === ARCHIVE) return;            // Архив зафиксирован последним
  const visible = buildSections().map((s) => s.key);
  const target = visible[visible.indexOf(key) + dir];
  if (target === undefined || target === ARCHIVE) return; // нельзя уйти ниже Архива
  const order = effectiveOrder();
  const a = order.indexOf(key), b = order.indexOf(target);
  [order[a], order[b]] = [order[b], order[a]];
  saveSectionOrder(order); renderProjects();
}

// Спрашиваем главный процесс, какие из открытых проектов синхронизируются, и
// перерисовываем список ТОЛЬКО если ответ изменился: опрос идёт по таймеру, а
// перерисовка списка на каждый тик гасила бы наведение и открытые меню.
async function refreshSynced() {
  try {
    const paths = projects.map((p) => p.path).filter(Boolean);
    if (!paths.length) { if (syncedPaths.size) { syncedPaths = new Set(); renderProjects(); } return; }
    const res = await window.lite?.sync?.match(paths);
    const next = new Set(res && Array.isArray(res.paths) ? res.paths : []);
    const nowAvailable = Boolean(res && res.available);
    const same = next.size === syncedPaths.size && [...next].every((x) => syncedPaths.has(x)) && nowAvailable === syncAvailable;
    if (!same) { syncedPaths = next; syncAvailable = nowAvailable; renderProjects(); }
  } catch (_) { /* синхронизации на этой машине нет — плашки просто без метки */ }
}

// Подключение проекта к синхронизации. Здесь мы на домашней машине, поэтому
// процедура идёт сразу: главный процесс запускает её и присылает шаги событиями.
// Те же шаги видит веб-версия — процедура у них общая (scripts/server-sync/lite-sync-link.js).
// Ключи шагов и состояний — латиницей: они уходят в className и в словарь
// локализации, а переводить служебное значение незачем (в UI идут заголовки ниже).
const LINK_TITLES = {
  link: 'Связь с сервером',
  project: 'Проект на второй стороне',
  transfer: 'Первая передача файлов',
  done: 'Запись в настройки синхронизации',
};
const LINK_ORDER = ['link', 'project', 'transfer', 'done'];

// Русское согласование числа: 1 файл · 2 файла · 5 файлов.
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b > 1 && b < 5 ? few : many;
}
function humanSize(bytes) {
  if (!bytes) return '0 МБ';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb.toFixed(mb < 10 ? 1 : 0)} МБ`;
}

// Окно синхронизации ПК ↔ сервер: одно на оба состояния.
//  · проект не синхронизируется — осмотр обеих сторон до согласия → «Подключить» → шаги процедуры
//    (scripts/server-sync/lite-sync-link.js, события sync:linkStep) → при расхождении вопрос, чью версию взять;
//  · уже синхронизируется — состояние сторон и расхождений (тот же осмотр), без кнопок, которых нет в процедуре.
// Всё собирается узлами, а не строкой HTML: имя проекта = имя ПАПКИ, и `<`/`&` в нём ломали бы разметку.
// Сервер ещё не задан: мастер подключения. Проверяет эту машину (ssh, rsync) и сервер (вход по
// ключу, программы на нём, часы), записывает адрес и передаёт дальше — в обычное подключение
// проекта. До «Сохранить» редактор ни с каким сервером не соединяется, кроме проверки по кнопке.
function showSyncSetup(p) {
  const { m, close } = makeModal(`
    <div class="sy-head"><span class="sy-ic"></span><div class="sy-t"><b>Синхронизация с сервером</b><span></span></div><button class="icon-btn" id="sy-x" title="Закрыть" aria-label="Закрыть"></button></div>
    <div class="sy-body">
      <div class="sy-lead">Синхронизация держит папку проекта одинаковой на этом компьютере и на вашем сервере: агент на сервере продолжает там, где остановился агент на ПК, и наоборот. Заменённые файлы не пропадают, а уезжают в корзину.</div>
      <div class="sy-h sy-need">Что для неё нужно</div>
      <ul class="sy-list">
        <li data-ic="server"><div><b>Свой сервер с доступом по SSH-ключу.</b> <span>По паролю синхронизация не работает.</span></div></li>
        <li data-ic="folder"><div><b>Один и тот же путь к проекту</b> <span>на компьютере и на сервере — папку на сервере редактор создаст сам.</span></div></li>
        <li data-ic="refresh"><div><b>rsync на обеих машинах.</b> <span>Остальное — обычные программы Linux и macOS.</span></div></li>
      </ul>
      <div class="sy-h">Адрес сервера</div>
      <input type="text" id="sy-srv" class="sy-srv" placeholder="user@example.com" autocomplete="off" spellcheck="false">
      <div class="sy-hint">Как в команде ssh: пользователь@сервер или имя хоста из ~/.ssh/config (так задаётся нестандартный порт).</div>
      <div class="sy-res"></div>
    </div>
    <div class="modal-actions"><button class="btn" id="sy-cancel">Отмена</button><span class="grow"></span><button class="btn" id="sy-check">Проверить</button><button class="btn primary" id="sy-save" disabled>Сохранить и продолжить</button></div>`);
  m.classList.add('sync-modal');
  m.querySelector('.sy-ic').appendChild(icon('cloud', 21));
  m.querySelector('.sy-t span').textContent = p.path;
  m.querySelector('#sy-x').appendChild(icon('x', 16));
  m.querySelector('#sy-x').onclick = close;
  m.querySelector('#sy-cancel').onclick = close;
  m.querySelectorAll('.sy-list li').forEach((li) => li.prepend(icon(li.dataset.ic, 15)));
  const inp = m.querySelector('#sy-srv'), res = m.querySelector('.sy-res');
  const bCheck = m.querySelector('#sy-check'), bSave = m.querySelector('#sy-save');
  const note = (kind, glyph, ...parts) => {
    const n = el('div', 'sy-note ' + kind);
    const t = el('div');
    parts.filter(Boolean).forEach((x) => t.appendChild(typeof x === 'string' ? el('div', null, x) : x));
    n.append(icon(glyph, 15), t);
    return n;
  };
  const cmd = (text) => {
    const c = el('div', 'sy-cmd');
    c.setAttribute('data-no-i18n', '');
    const b = iconBtn('', 'copy', 'Копировать', 13);
    b.onclick = () => { lite.copyText(text); toast('Скопировано'); };
    c.append(el('code', null, text), b);
    return c;
  };
  const detail = (text) => { if (!text) return null; const d = el('div', 'sy-detail', text); d.setAttribute('data-no-i18n', ''); return d; };
  // тот же вид, что у шагов подключения проекта (.lk-steps)
  const checklist = (items) => {
    const ol = el('ol', 'lk-steps');
    for (const [state, title, what] of items) {
      const li = el('li', state);
      const mark = el('span', 'mark');
      if (state === 'run') mark.appendChild(el('span', 'sy-spin'));
      else if (state === 'ok') mark.appendChild(icon('check', 13));
      else if (state === 'bad') mark.appendChild(icon('x', 12));
      else mark.textContent = '·';
      const sc = el('div', 'sc');
      sc.appendChild(el('div', 'title', title));
      if (what) sc.appendChild(el('div', 'what', what));
      li.append(mark, sc);
      ol.appendChild(li);
    }
    return ol;
  };
  const installTools = lite.platform === 'darwin' ? 'brew install rsync' : 'sudo apt install openssh-client rsync';
  let checked = '';   // адрес, прошедший проверку: «Сохранить» — только для него
  inp.addEventListener('input', () => { bSave.disabled = inp.value.trim() !== checked || !checked; });
  // Enter во время идущей проверки не запускает вторую (второй ssh-процесс, ответы вперемешку)
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!bSave.disabled) bSave.click(); else if (!bCheck.disabled) check(); } });

  const check = async () => {
    const server = inp.value.trim();
    if (!server) { inp.focus(); return; }
    checked = ''; bSave.disabled = true; bCheck.disabled = true;
    m.classList.add('sy-checked');   // вводная прочитана — место под результат, без прокрутки окна
    res.replaceChildren(checklist([['run', 'Проверяю сервер…', server]]));
    let r;
    try { r = await lite.sync.checkServer(server); } catch (e) { r = { ok: false, reason: 'ssh', detail: String(e.message || e) }; }
    bCheck.disabled = false;
    if (!m.isConnected || inp.value.trim() !== server) return;
    const at = { 'local-tools': 0, address: 1, resolve: 1, unreachable: 1, auth: 1, hostkey: 1, ssh: 1, 'remote-tools': 2, clock: 3 }[r.reason];
    const failAt = r.ok ? 99 : (at === undefined ? 1 : at);
    const st = (i) => (i < failAt ? 'ok' : i === failAt ? 'bad' : 'wait');
    res.replaceChildren(checklist([
      [st(0), 'Этот компьютер', failAt === 0 ? 'нет ssh или rsync' : 'ssh и rsync на месте'],
      [st(1), 'Вход по ключу', server],
      [st(2), 'Программы на сервере', failAt === 2 ? tt('не хватает: {0}', (r.missing || []).join(', ')) : 'rsync, find, md5sum, du'],
      [st(3), 'Часы', failAt >= 3 ? tt('расходятся на {0} с', r.drift || 0) : ''],
    ]));
    const host = server.split('@').pop();
    if (r.ok) {
      checked = server; bSave.disabled = false;
      res.appendChild(note('good', 'check', 'Сервер подходит. Нажмите «Сохранить и продолжить» — дальше редактор покажет, что есть на обеих сторонах, и подключит проект.'));
      return;
    }
    const why = {
      'local-tools': ['На этом компьютере нет ssh или rsync — без них синхронизации не будет. Установите их:', cmd(installTools)],
      address: ['Адрес не подходит: нужен вид пользователь@сервер или имя хоста из ~/.ssh/config.'],
      resolve: ['Такой сервер не найден — проверьте адрес.', detail(r.detail)],
      unreachable: ['Сервер не отвечает по SSH: он выключен, закрыт порт или нет сети.', detail(r.detail)],
      auth: ['Сервер не пускает по ключу. Добавьте на него свой ключ — один раз, из терминала:', cmd('ssh-copy-id ' + server), 'Если ключа ещё нет, сначала создайте его:', cmd('ssh-keygen -t ed25519')],
      hostkey: ['Ключ сервера не совпадает с запомненным. Так бывает после переустановки сервера — но и при подмене. Если сервер переустанавливали, удалите старую запись и проверьте снова:', cmd('ssh-keygen -R ' + host)],
      'remote-tools': [tt('На сервере не хватает программ: {0}. На Debian и Ubuntu их ставит команда:', (r.missing || []).join(', ')), cmd('sudo apt install rsync')],
      clock: [tt('Часы компьютера и сервера расходятся на {0} с. Включите синхронизацию времени (NTP): иначе не понять, где правка свежее.', r.drift || 0)],
    }[r.reason] || ['SSH не соединился.', detail(r.detail)];
    res.appendChild(note('bad', 'warning', ...why));
  };
  bCheck.onclick = check;
  bSave.onclick = async () => {
    const server = inp.value.trim();
    if (!server || server !== checked) return;
    bSave.disabled = true;
    let r;
    try { r = await lite.sync.setServer(server); } catch (e) { r = { ok: false, reason: String(e.message || e) }; }
    if (!r || !r.ok) { bSave.disabled = false; res.appendChild(note('bad', 'warning', r?.reason || 'Не удалось сохранить адрес.')); return; }
    syncAvailable = true;
    close();
    refreshSynced();
    showSyncDialog(p);
  };

  (async () => {
    let info = null;
    try { info = await lite.sync.setupInfo(); } catch (_) {}
    if (!m.isConnected) return;
    if (!info || !info.supported) {
      inp.disabled = true; bCheck.disabled = true;
      res.replaceChildren(note('warn', 'info', lite.platform === 'win32'
        ? 'На Windows синхронизация пока не работает: ей нужен rsync, а в Windows его нет.'
        : 'Утилита синхронизации не найдена в этой сборке редактора.'));
      return;
    }
    if (info.tools && (!info.tools.ssh || !info.tools.rsync)) {
      res.replaceChildren(note('bad', 'warning', 'На этом компьютере нет ssh или rsync — без них синхронизации не будет. Установите их:', cmd(installTools)));
    }
    res.appendChild(note('info', 'info', 'Файлы уходят только на этот сервер и только через ваш ssh. Сверяет их демон синхронизации — он работает, пока открыт редактор.'));
    inp.focus();
  })();
}

function showSyncDialog(p) {
  if (!syncAvailable) { showSyncSetup(p); return; }
  let stopListen = null;
  const { m, close } = makeModal(`
    <div class="sy-head"><span class="sy-ic"></span><div class="sy-t"><b></b><span></span></div><button class="icon-btn" id="sy-x" title="Закрыть" aria-label="Закрыть"></button></div>
    <div class="sy-body"></div>
    <div class="modal-actions"></div>`, () => { if (stopListen) { stopListen(); stopListen = null; } });
  m.classList.add('sync-modal');
  const head = m.querySelector('.sy-ic'), title = m.querySelector('.sy-t b'), body = m.querySelector('.sy-body'), foot = m.querySelector('.modal-actions');
  head.appendChild(icon('cloud', 21));
  m.querySelector('.sy-t span').textContent = p.path;
  { const x = m.querySelector('#sy-x'); x.appendChild(icon('x', 16)); x.onclick = close; }
  const btn = (text, cls, onClick, glyph) => {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''));
    if (glyph) b.appendChild(icon(glyph, 14));
    b.appendChild(el('span', null, text));
    if (onClick) b.onclick = onClick;
    return b;
  };
  const note = (kind, glyph, ...lines) => {
    const n = el('div', 'sy-note ' + kind);
    n.appendChild(icon(glyph, 15));
    const t = el('div');
    lines.forEach((ln, i) => { if (i) t.appendChild(el('br')); t.appendChild(typeof ln === 'string' ? el('span', null, ln) : ln); });
    n.appendChild(t);
    return n;
  };
  const side = (label, glyph, s, emptyHint) => {
    const box = el('div', 'sy-side');
    const h = el('div', 'h'); h.append(icon(glyph, 14), el('span', null, label));
    box.appendChild(h);
    if (s && s.exists) {
      const n = s.files || 0;
      const v = el('div', 'v'); v.append(el('span', null, n.toLocaleString('ru-RU')), document.createTextNode(' '), el('span', null, plural(n, 'файл', 'файла', 'файлов')));
      box.append(v, el('div', 's', humanSize(s.bytes)));
    } else box.append(el('div', 'v none', 'проекта нет'), el('div', 's', emptyHint || ''));
    return box;
  };
  const sides = (info) => {
    const g = el('div', 'sy-sides');
    const mid = el('div', 'sy-mid'); mid.appendChild(icon('swap', 18));
    g.append(side('На ПК', 'laptop', info.local), mid, side('На сервере', 'server', info.remote, 'создам при подключении'));
    return g;
  };
  const skeleton = (text) => { const s = el('div', 'sy-skel'); s.append(el('span', 'sy-spin'), el('span', null, text)); body.replaceChildren(s); };
  const inspect = async () => {
    try { return await lite.sync.inspect(p.path); } catch (e) { return { ok: false, reason: String(e.message || e) }; }
  };
  const setLinkedLook = (on) => {
    head.classList.toggle('on', on);
    title.textContent = on ? 'Синхронизируется с сервером' : 'Подключить к синхронизации';
  };

  // ---- уже синхронизируется: состояние сторон
  const showLinked = async () => {
    setLinkedLook(true);
    skeleton('Сверяю обе стороны…');
    foot.replaceChildren(el('span', 'grow'), btn('Готово', 'primary', close));
    const info = await inspect();
    if (!m.isConnected) return;
    if (!info || !info.ok) {
      body.replaceChildren(note('bad', 'warning', 'Сервер сейчас недоступен — состояние не проверить.', info?.reason || ''));
    } else {
      body.replaceChildren(sides(info));
      if (info.differ) body.appendChild(note('warn', 'warning', `Сейчас различаются файлы: ${info.differ}.`, 'Демон синхронизации сведёт их при следующей сверке.'));
      else body.appendChild(note('good', 'check', 'Расхождений нет.'));
      body.appendChild(note('info', 'info', 'Файлы сверяются сами при изменениях. Заменённое уезжает в корзину, а не пропадает.'));
    }
    foot.replaceChildren(btn('Проверить ещё раз', '', showLinked, 'refresh'), el('span', 'grow'), btn('Готово', 'primary', close));
  };

  // ---- подключение: осмотр до согласия → шаги → (вопрос о расхождении) → готово
  const steps = LINK_ORDER.map((key) => ({ key, state: 'wait', text: '' }));
  let stepsBox = null;
  const drawSteps = () => {
    if (!stepsBox || !stepsBox.isConnected) { stepsBox = el('ol', 'lk-steps'); body.replaceChildren(stepsBox); }
    stepsBox.replaceChildren();
    steps.forEach((s, i) => {
      const li = el('li', s.state);
      const mark = el('span', 'mark');
      if (s.state === 'run') mark.appendChild(el('span', 'sy-spin'));
      else if (s.state === 'ok') mark.appendChild(icon('check', 13));
      else if (s.state === 'bad') mark.appendChild(icon('x', 12));
      else mark.textContent = s.state === 'ask' ? '?' : String(i + 1);
      const sc = el('div', 'sc');
      sc.appendChild(el('div', 'title', LINK_TITLES[s.key] || s.key));
      if (s.text) sc.appendChild(el('div', 'what', s.text));
      li.append(mark, sc);
      stepsBox.appendChild(li);
    });
  };
  const takeStep = (step) => {
    if (!step || !step.key) return;
    const s = steps.find((x) => x.key === step.key);
    if (s) { s.state = step.state || 'run'; s.text = step.text || ''; } else steps.push({ key: step.key, state: step.state || 'run', text: step.text || '' });
    drawSteps();
  };
  // Файлы разошлись — спрашиваем, чью сторону взять: молча затирать нельзя.
  const askPrefer = (result) => {
    const ask = el('div', 'lk-ask');
    const differ = result.report?.differ || 0;
    ask.appendChild(el('div', 'q', `Файлы различаются: ${differ}. Чью версию взять за верную?`));
    const examples = result.report?.differExamples || [];
    if (examples.length) { const f = el('div', 'files'); for (const x of examples.slice(0, 6)) f.appendChild(el('code', null, x)); ask.appendChild(f); }
    const opts = el('div', 'lk-opts');
    for (const [label, hint, glyph, prefer] of [
      ['Версия ПК', 'На сервер уедут файлы с этого компьютера', 'laptop', 'local'],
      ['Версия сервера', 'На ПК придут файлы с сервера', 'server', 'remote'],
    ]) {
      const b = el('button', 'lk-opt');
      const bt = el('b'); bt.append(icon(glyph, 15), el('span', null, label));
      b.append(bt, el('span', null, hint));
      b.onclick = () => { ask.remove(); run(prefer); };
      opts.appendChild(b);
    }
    ask.appendChild(opts);
    body.appendChild(ask);
    foot.replaceChildren(el('span', 'grow'), btn('Отмена', '', close), btn('Нужно ваше решение', 'primary', null));
    foot.lastChild.disabled = true;
  };
  const run = async (prefer = null) => {
    const go = btn('Подключаю…', 'primary', null); go.disabled = true;
    foot.replaceChildren(el('span', 'grow'), go);
    for (const s of steps) if (!prefer || s.key !== 'link') { s.state = 'wait'; s.text = ''; }
    drawSteps();
    stopListen = lite.sync.onLinkStep?.(takeStep) || null;
    let result;
    try { result = await lite.sync.link(p.path, prefer); } catch (e) { result = { ok: false, reason: String(e.message || e) }; }
    if (stopListen) { stopListen(); stopListen = null; }
    if (!m.isConnected) { if (result && result.ok) refreshSynced(); return; }
    if (result.need === 'prefer') { askPrefer(result); return; }
    if (result.ok) {
      setLinkedLook(true);
      body.appendChild(note('good', 'check', 'Готово: проект синхронизируется.'));
      foot.replaceChildren(el('span', 'grow'), btn('Закрыть', 'primary', close));
      refreshSynced();
      return;
    }
    body.appendChild(note('bad', 'warning', result.reason || 'Подключить не удалось.'));
    foot.replaceChildren(el('span', 'grow'), btn('Отмена', '', close), btn('Повторить', 'primary', () => run(prefer)));
  };
  const showConnect = async () => {
    setLinkedLook(false);
    skeleton('Смотрю, что есть на обеих сторонах…');
    const go = btn('Подключить', 'primary', () => run(null)); go.disabled = true;
    foot.replaceChildren(el('span', 'grow'), btn('Отмена', '', close), go);
    const info = await inspect();
    if (!m.isConnected) return;
    if (!info || !info.ok) {
      body.replaceChildren(note('bad', 'warning', 'Подключение сейчас невозможно.', info?.reason || 'не удалось осмотреть проект'));
      return;
    }
    body.replaceChildren(sides(info));
    if (info.differ) body.appendChild(note('warn', 'warning', `Файлы различаются: ${info.differ} — перед передачей спрошу, чью версию взять.`));
    body.appendChild(note('info', 'info', 'Заменённое уедет в корзину, как при обычной сверке.'));
    go.disabled = false;
  };

  if (syncedPaths.has(p.path)) showLinked(); else showConnect();
}

function renderProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  const sections = buildSections();
  sections.forEach((s, i) => box.appendChild(renderSection(s, i, sections)));
  if (projFilter && !sections.length) box.appendChild(el('div', 'proj-empty', 'Ничего не найдено'));
  renderMiniRail();
  renderChips();
}
// Заголовок группы: имя · (✎ ↑ ↓ по наведению) · число · стрелка. Инструменты стоят в раскладке
// всегда и только проявляются, поэтому заголовок не прыгает при наведении.
function renderSection(s, index, sections) {
  const total = sections.length;
  const { label, key, list, pinned } = s;
  const collapsed = projFilter ? false : isCollapsed(key);   // под фильтром секции всегда раскрыты
  const sec = el('div', 'pgroup' + (pinned ? ' pinned' : '') + (collapsed ? ' closed' : '') + (list.length ? '' : ' empty'));
  const head = el('div', 'pgroup-head');
  head.appendChild(el('span', 'pgroup-name', label));
  const tools = el('div', 'pgroup-tools');
  const isCustomCat = key !== FAV_KEY && key !== UNCATEGORIZED && key !== ARCHIVE;
  if (isCustomCat) { // видимая кнопка переименования (плюс ПКМ-меню)
    const ren = iconBtn('pgroup-arrow', 'pencil', 'Переименовать категорию', 12);
    ren.addEventListener('click', (e) => { e.stopPropagation(); renameCategory(key); });
    tools.appendChild(ren);
  }
  if (key !== ARCHIVE) {
    const nextIsArchive = sections[index + 1] && sections[index + 1].key === ARCHIVE;
    const up = iconBtn('pgroup-arrow', 'chevron-up', 'Выше', 12); up.disabled = index === 0;
    const down = iconBtn('pgroup-arrow', 'chevron-down', 'Ниже', 12); down.disabled = index === total - 1 || nextIsArchive;
    up.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, -1); });
    down.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, +1); });
    tools.append(up, down);
  }
  head.appendChild(tools);
  head.appendChild(el('span', 'pgroup-count', String(list.length)));
  const chev = el('span', 'pgroup-chev');
  chev.appendChild(icon('chevron-down', 12));
  head.appendChild(chev);
  const body = el('div', 'pgroup-body');
  if (collapsed) body.style.display = 'none';
  head.addEventListener('click', () => {
    if (projFilter) return;
    const now = !isCollapsed(key); setCollapsed(key, now);
    body.style.display = now ? 'none' : '';
    sec.classList.toggle('closed', now);
  });
  if (isCustomCat) head.addEventListener('contextmenu', (e) => { e.preventDefault(); showCategoryMenu(e.clientX, e.clientY, key); });
  for (const p of list) {
    const c = makeCard(p);
    if (key === FAV_KEY) enableFavDnD(c, body);
    body.appendChild(c);
  }
  sec.appendChild(head); sec.appendChild(body);
  return sec;
}
// DnD-сортировка карточек ТОЛЬКО внутри «Избранного»: перетаскивание живьём двигает карточку
// в теле группы, на dragend порядок из DOM пишется в favOrder. Esc/бросок мимо — откат без записи.
let favDragCard = null; // тянут максимум одну карточку на окно
function enableFavDnD(card, body) {
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    favDragCard = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (_) {}
  });
  card.addEventListener('dragend', (e) => {
    card.classList.remove('dragging');
    if (!favDragCard) return;
    favDragCard = null;
    if (e.dataTransfer.dropEffect !== 'none') // 'none' = отмена (Esc/мимо) — порядок не трогаем
      saveFavOrder([...body.querySelectorAll('.card')].map((c) => c.dataset.id));
    renderProjects();
  });
  card.addEventListener('dragover', (e) => {
    if (!favDragCard || favDragCard === card || card.parentElement !== body) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = card.getBoundingClientRect();
    body.insertBefore(favDragCard, e.clientY < r.top + r.height / 2 ? card : card.nextSibling);
  });
  // preventDefault на теле группы: разрешить drop между карточками/на паддинге (иначе курсор «нельзя»)
  if (!body.dataset.favDnd) {
    body.dataset.favDnd = '1';
    body.addEventListener('dragover', (e) => { if (favDragCard) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
    body.addEventListener('drop', (e) => { if (favDragCard) e.preventDefault(); });
  }
}
// Строка проекта: индикатор · облачко синхронизации · имя · (★ ⋮ — по наведению и у активного).
// Путь — в подсказке имени и в чипе папки под терминалом.
function makeCard(p) {
  const gone = missing.has(p.id);
  const card = el('div', 'card');
  card.dataset.id = p.id;
  if (p.id === activeId) card.classList.add('active');
  if (gone) card.classList.add('missing');
  if (p.accent) { card.classList.add('accented'); card.style.setProperty('--card-accent', p.accent); }
  card.title = gone ? `Папка не найдена: ${p.path}` : p.path;

  if (gone) {
    const w = el('span', 'card-warn'); w.appendChild(icon('warning', 14));
    card.appendChild(w);
  } else {
    const ind = el('span', 'pind ' + projAggState(p.id));
    ind.dataset.id = p.id;
    card.appendChild(ind);
  }
  // Облачко: зелёное — проект синхронизируется; серое — нет (или синхронизации на машине нет вовсе —
  // тогда клик объясняет, что это и что для неё нужно).
  if (!gone) {
    const linked = syncAvailable && syncedPaths.has(p.path);
    const tip = linked ? 'Синхронизируется с сервером' : syncAvailable ? 'Не синхронизируется — нажмите, чтобы подключить' : 'Синхронизация с сервером — что это и как подключить';
    const cl = iconBtn('card-sync' + (linked ? ' on' : ''), 'cloud', tip, 14);
    cl.addEventListener('click', (e) => { e.stopPropagation(); showSyncDialog(p); });
    card.appendChild(cl);
  }
  card.appendChild(el('span', 'card-title', p.name));
  const acts = el('div', 'card-acts');
  if (!gone) {
    const star = iconBtn('card-star' + (p.favorite ? ' on' : ''), 'star', p.favorite ? 'Убрать из избранного' : 'В избранное', 14);
    star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(p.id); });
    acts.appendChild(star);
  }
  const kebab = iconBtn('card-kebab', 'dots-v', 'Меню проекта', 16);
  kebab.addEventListener('click', (e) => { e.stopPropagation(); const r = kebab.getBoundingClientRect(); showCardMenu(r.left, r.bottom + 4, p, card); });
  acts.appendChild(kebab);
  card.appendChild(acts);

  card.addEventListener('click', () => focusProject(p.id));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e.clientX, e.clientY, p, card); });
  return card;
}
// Клик по карточке проекта → выбрать его (чат/документ теперь живут отдельной панелью справа).
function focusProject(id) {
  setActive(id);
}


// ---------------------------------------------------------------- OpenRouter chat UI
// Вынесен в renderer/modules/openrouter.js (const Or — у блока состояния чата выше).

function toggleFavorite(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  p.favorite = !p.favorite;
  if (p.favorite) {
    // материализуем текущий видимый порядок группы и ставим новую карточку в самый низ
    const cur = sortFavs(projects.filter((x) => x.favorite && x.id !== id)).map((x) => x.id);
    saveFavOrder([...cur, id]);
  } else {
    saveFavOrder(loadFavOrder().filter((x) => x !== id)); // снятие ★ сбрасывает ручную позицию
  }
  saveProjects(); renderProjects();
}
function moveToCategory(id, cat) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  p.category = cat;          // null → "Все"; favorite stays independent
  saveProjects(); renderProjects();
}
// «В архив»: создаём спец-категорию Архив (свёрнутой по дефолту), если её ещё нет, и переносим проект.
function archiveProject(id) {
  const cats = loadCategories();
  if (!cats.includes(ARCHIVE)) { saveCategories([...cats, ARCHIVE]); setCollapsed(ARCHIVE, true); }
  moveToCategory(id, ARCHIVE);
}

// kebab/right-click project menu (pages: actions ↔ color ↔ move-to-category)
function showCardMenu(x, y, p, card) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '230px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  if (card) { card.classList.add('menu-open'); menuAnchor = card; }
  buildCardMenuMain(dd, p);
  placeMenu(dd, x, y);
}
function buildCardMenuMain(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('folder', 'Открыть в проводнике', () => { closeMenus(); lite.openInFileManager(p.path); }));
  dd.appendChild(menuRow('copy', 'Копировать путь', () => { closeMenus(); lite.copyText(p.path); toast('Путь скопирован'); }));
  dd.appendChild(menuRow('star', p.favorite ? 'Убрать из избранного' : 'В избранное', () => { closeMenus(); toggleFavorite(p.id); }));
  if (!missing.has(p.id)) {
    const row = menuRow('cloud', 'Синхронизация…', () => { closeMenus(); showSyncDialog(p); });
    row.appendChild(el('span', 'menu-desc', !syncAvailable ? 'не подключена' : syncedPaths.has(p.path) ? 'включена' : 'выключена'));
    dd.appendChild(row);
  }
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('pencil', 'Переименовать проект…', () => { closeMenus(); renameProject(p.id); }));
  dd.appendChild(menuRow('palette', 'Цвет проекта…', () => buildCardMenuColor(dd, p)));
  dd.appendChild(menuRow('arrow-right', 'Переместить в категорию…', () => buildCardMenuMove(dd, p)));
  if (p.category === ARCHIVE)
    dd.appendChild(menuRow('archive', 'Вернуть из архива', () => { closeMenus(); moveToCategory(p.id, null); }));
  else
    dd.appendChild(menuRow('archive', 'В архив', () => { closeMenus(); archiveProject(p.id); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('x', 'Закрыть проект', () => { closeMenus(); closeProject(p.id); }, 'danger'));
}
const ACCENTS = ['#2fbf71', '#3dc8dc', '#7aa2f7', '#a98cf0', '#e06fae', '#e0af68', '#f7768e', '#8aa79a'];
function buildCardMenuColor(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('chevron-left', 'Назад', () => buildCardMenuMain(dd, p), 'muted'));
  dd.appendChild(el('div', 'menu-label', 'Цвет проекта'));
  const sw = el('div', 'accent-swatches');
  for (const c of ACCENTS) {
    const b = el('button', 'accent-sw' + (p.accent === c ? ' on' : ''));
    b.style.background = c;
    b.onclick = () => { closeMenus(); setAccent(p.id, c); };
    sw.appendChild(b);
  }
  dd.appendChild(sw);
  dd.appendChild(menuRow('x', 'Сбросить цвет', () => { closeMenus(); setAccent(p.id, null); }, 'muted'));
}
function setAccent(id, c) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  if (c) p.accent = c; else delete p.accent;
  saveProjects(); renderProjects();
}
function renameProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  showPrompt('Переименовать проект', 'Название (папка на диске не меняется)', p.name, (name) => { p.name = name; saveProjects(); renderProjects(); });
}
// category section header menu
function showCategoryMenu(x, y, name) {
  closeMenus();
  const dd = el('div', 'menu-dropdown'); dd.style.minWidth = '190px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  dd.appendChild(menuRow('pencil', 'Переименовать категорию…', () => { closeMenus(); renameCategory(name); }));
  dd.appendChild(menuRow('trash', 'Удалить категорию', () => { closeMenus(); deleteCategory(name); }, 'danger'));
  placeMenu(dd, x, y);
}
function renameCategory(old) {
  showPrompt('Переименовать категорию', 'Название', old, (name) => {
    if (name === old || name === UNCATEGORIZED || name === ARCHIVE) return;
    saveCategories([...new Set(loadCategories().map((c) => (c === old ? name : c)))]);
    const order = loadSectionOrder();
    // имя уже занятой категории = слияние (список выше схлопнут Set'ом) — порядок схлопываем так же,
    // иначе в нём остались бы две записи одной категории и группа рисовалась бы дважды
    if (order) saveSectionOrder([...new Set(order.map((k) => (k === old ? name : k)))]);
    for (const p of projects) if (p.category === old) p.category = name;
    saveProjects(); renderProjects();
  });
}
function deleteCategory(name) {
  showConfirm('Удалить категорию?', `Проекты из «${name}» переедут в «Все». Папки на диске не трогаются.`, 'Удалить', () => {
    saveCategories(loadCategories().filter((c) => c !== name));
    for (const p of projects) if (p.category === name) p.category = null;
    saveProjects(); renderProjects();
  });
}
function buildCardMenuMove(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('chevron-left', 'Назад', () => buildCardMenuMain(dd, p), 'muted'));
  dd.appendChild(el('div', 'menu-label', 'Переместить в'));
  const cats = loadCategories();
  const opts = [UNCATEGORIZED, ...cats.filter((c) => c !== ARCHIVE)]; // Архив — через отдельный пункт «В архив»
  for (const c of opts) {
    const here = c === UNCATEGORIZED ? !cats.includes(p.category) : p.category === c;
    dd.appendChild(menuRow(here ? 'check' : null, c, () => { closeMenus(); moveToCategory(p.id, c === UNCATEGORIZED ? null : c); }));
  }
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('plus', 'Создать новую…', () => { closeMenus(); showCreateCategory(p.id); }));
}
function showCreateCategory(id) {
  const { m, close } = makeModal(`
    <h2>Новая категория</h2>
    <div class="field"><input type="text" id="nc-name" placeholder="Название категории" autocomplete="off" spellcheck="false"></div>
    <div class="modal-actions"><button class="btn" id="nc-cancel">Отмена</button><button class="btn primary" id="nc-ok">Создать</button></div>`);
  const inp = m.querySelector('#nc-name');
  setTimeout(() => inp.focus(), 30);
  m.querySelector('#nc-cancel').onclick = close;
  const ok = () => {
    const name = inp.value.trim();
    if (!name || name === UNCATEGORIZED || name === ARCHIVE) { close(); return; }
    const cats = loadCategories();
    if (!cats.includes(name)) { cats.push(name); saveCategories(cats); }
    if (id) moveToCategory(id, name); else renderProjects();   // из «Ещё» — просто новая пустая категория
    close();
  };
  m.querySelector('#nc-ok').onclick = ok;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
}

// ---------------------------------------------------------------- scan dirs (#1)
// Add immediate subfolders of each settings.scanDirs as projects (deduped; closed
// ones stay closed via STORE.dismissed). Runs at startup; non-blocking.
async function scanProjects() {
  const dirs = settings.scanDirs || [];
  if (!dirs.length) return;
  const dismissed = new Set(STORE.dismissed || []);
  const known = new Set(projects.map((p) => p.path));
  let added = false;
  for (const dir of dirs) {
    const entries = await lite.fs.readDir(dir);
    if (!Array.isArray(entries)) continue;
    for (const ent of entries) {
      if (!ent.dir || ent.name.startsWith('.')) continue;
      // known снят до await: пока читалась папка, проект мог добавить второй скан (закрытие настроек
      // во время стартового) или ручное открытие — сверяемся и с живым списком, иначе будет дубль с тем же id
      if (known.has(ent.path) || dismissed.has(ent.path) || projects.some((p) => p.path === ent.path)) continue;
      projects.push({ id: projId(ent.path), name: ent.name, path: ent.path });
      known.add(ent.path); added = true;
    }
  }
  if (added) {
    saveProjects();
    renderProjects();
    if (!activeId && projects.length) setActive(projects[0].id);
  }
}

// ---------------------------------------------------------------- keyboard layout swap
// convertLayout/applyLayoutSwap (фиксер раскладки «ghbdtn»→«привет») вынесены в ui.js —
// общий хелпер для редактора и окон модулей (импорт ниже).

// ---------------------------------------------------------------- notes / prompt cards (#4)
// Модуль «Задачи» (notes) мигрирован в отдельное окно (renderer/module-entry.js, проектозависимый).
// Здесь остаётся только sendNoteToTerminal — его зовёт редактор по editorBus (окно→редактор).
function sendNoteToTerminal(p, text) {
  if (!text) return;
  const proj = projects.find((x) => x.id === p.id);
  if (!proj) return;
  ensureProjectTabs(proj);
  setActive(proj.id);
  const sid = (tabsByProj.get(proj.id) || {}).active;
  if (!sid) return;
  // Терминал мог только что подняться (ensureProjectTabs) с отложенным автовводом — без отмены
  // слово из настроек (`claude`) дописалось бы в ту же строку после текста заметки.
  cancelPrefill(sid);
  lite.pty.write(sid, text); // no trailing newline — review, then press Enter yourself
}

// Режим «один терминал»: карточка проектов сжимается в узкий рельс — буквы проектов со статусом,
// снизу «Ещё», оформление и настройки. Порядок — как в списке (избранное, категории, «Все»).
function initials(name) {
  const w = String(name || '?').split(/[\s._-]+/).filter(Boolean);
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase();
}
function renderMiniRail() {
  const rail = $('#mini-rail');
  if (!rail) return;
  rail.innerHTML = '';
  rail.appendChild(el('span', 'rail-mark'));
  const expand = iconBtn('icon-btn', 'panel-left', 'Развернуть проекты (Ctrl+\\)', 17);
  expand.addEventListener('click', toggleSingle);
  rail.append(expand, el('span', 'rail-sep'));
  const list = el('div', 'rail-list');
  const seen = new Set();
  const keepFilter = projFilter; projFilter = '';          // рельс показывает все проекты, а не только найденные фильтром
  const sections = buildSections(); projFilter = keepFilter;
  for (const s of sections) for (const p of s.list) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const st = projAggState(p.id);
    const btn = el('button', 'rail-btn' + (p.id === activeId ? ' active' : '') + (missing.has(p.id) ? ' missing' : ''), initials(p.name));
    btn.title = p.name;
    btn.setAttribute('data-no-i18n', '');
    if (p.accent) btn.style.color = p.accent;
    if (st !== 'idle') {
      const badge = el('span', 'rail-st');
      const ind = el('span', 'pind ' + st); ind.dataset.id = p.id;
      badge.appendChild(ind);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => setActive(p.id));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e.clientX, e.clientY, p); });
    list.appendChild(btn);
  }
  rail.appendChild(list);
  const more = iconBtn('icon-btn', 'dots-h', 'Ещё', 16);
  more.addEventListener('click', (e) => { e.stopPropagation(); showMoreMenu(more); });
  const look = iconBtn('icon-btn', 'palette', 'Оформление: цвета и размеры', 16);
  look.id = 'rail-look';
  look.addEventListener('click', (e) => { e.stopPropagation(); showLookPanel(look); });
  const gear = iconBtn('icon-btn', 'gear', 'Настройки', 16);
  gear.addEventListener('click', () => showSettings());
  rail.append(more, look, gear);
}

async function openProjectDialog() {
  const picked = await lite.openProject();
  if (picked) openByPath(picked.path, picked.name);
}

function openByPath(p, name) {
  const dis = (STORE.dismissed || []); // re-opening clears a prior "closed" mark so scan keeps it
  if (dis.includes(p)) persist('dismissed', dis.filter((x) => x !== p));
  const existing = projects.find((x) => x.path === p);
  if (existing) { setActive(existing.id); pushRecent({ path: p, name: existing.name }); return; }
  const proj = { id: projId(p), name: name || baseName(p), path: p };
  projects.push(proj);
  saveProjects();
  setActive(proj.id);
  pushRecent({ path: p, name: proj.name });
}

function closeProject(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  showConfirm(
    `Закрыть проект «${proj.name}»?`,
    'Терминал этого проекта будет выгружен из редактора. Файлы на диске не изменятся.',
    'Закрыть проект',
    () => doCloseProject(id),
  );
}
function doCloseProject(id) {
  // Closing the project whose unsaved file is open in the viewer would silently drop those
  // edits — run the save/discard prompt first, then re-enter (dirty is false → falls through).
  // Несохранённые правки вивера теперь защищает само окно вивера (guardDirty при смене проекта).
  const closing = projects.find((p) => p.id === id);
  if (closing) { // remember the close so a scan-dir project doesn't reappear next launch
    const dis = new Set(STORE.dismissed || []); dis.add(closing.path); persist('dismissed', [...dis]);
  }
  if (closing && watchedRoot === closing.path) { lite.fs.unwatch(closing.path); watchedRoot = null; }
  const tabs = tabsByProj.get(id);
  if (tabs) {
    for (const sid of tabs.sessions) {
      lite.pty.kill(sid);
      const rec = terms.get(sid);
      if (rec) { clearTimeout(rec.idleTimer); clearTimeout(rec.prefillTimer); stopClaudeProbe(rec); releaseRenderer(rec.term); try { rec.timeline.dispose(); } catch (_) {} try { rec.term.dispose(); } catch (_) {} rec.container.remove(); terms.delete(sid); }
      projState.delete(sid);
    }
    tabsByProj.delete(id);
    // Сессии ушли из projState — пересчитать бейдж «N ждёт ответа» и трей. Без этого закрытый проект
    // с ждущим агентом оставлял бейдж и отметку в трее до следующей смены состояния любой вкладки.
    updateAttention();
  }
  const pt = { ...(STORE.projTabs || {}) }; delete pt[id]; persist('projTabs', pt);
  if (loadFavOrder().includes(id)) saveFavOrder(loadFavOrder().filter((x) => x !== id));
  missing.delete(id);
  projects = projects.filter((p) => p.id !== id);
  saveProjects();
  if (activeId === id) {
    activeId = null;
    if (projects.length) setActive(projects[0].id);
    else {
      renderProjects(); showActiveTerminal();
      // нет проектов → окна модулей (вивер, git, задачи…) получают app:activeProject=null и показывают
      // пустое состояние. Раньше null никто не отправлял, и они продолжали работать с закрытым проектом.
      try { Ext.notifyActiveProject(null); } catch (_) {}
      pushActiveProject(null);
      updateNotesBadge();
    }
  } else {
    renderProjects();
  }
}

// Flag projects whose folder was deleted on disk so the user can close them.
// Один запрос на все пути (раньше — по IPC на проект, подряд) и перерисовка только если набор
// пропавших изменился: проверка идёт на каждый возврат фокуса в окно, а полная перерисовка списка
// гасит наведение и открытые меню (refreshSynced ради этого тоже перерисовывает лишь по изменению).
async function checkProjectsExistence() {
  const list = projects.slice();
  let exists;
  try { exists = await lite.fs.existsMany(list.map((p) => p.path)); } catch (_) { return; }
  if (!Array.isArray(exists)) return;
  let changed = false;
  list.forEach((p, i) => {
    const gone = !exists[i];
    if (gone !== missing.has(p.id)) { changed = true; if (gone) missing.add(p.id); else missing.delete(p.id); }
  });
  if (changed) renderProjects();
}

// ---------------------------------------------------------------- activity indicator
// Three states: busy (output flowing) · waiting (quiet, but wants your input) ·
// quiet (done/idle). The reliable "wants attention" signal is the terminal BELL
// (\x07) — agents/CLIs ring it on purpose; a normal shell/Claude prompt does not,
// so we must NOT treat trailing $, #, ❯ as "waiting" (that's just idle/ready).
// PROMPT_RE is a narrow backup for plain CLIs (git/ssh/sudo) that don't bell.
// Claude Code идёт своим путём (ниже, «Claude Code»): его состояние — из его же отчёта.
const PROMPT_RE = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|overwrite\?|password[^\n]{0,24}:|passphrase[^\n]{0,24}:|press\s+(?:enter|return|any key)|continue\?/i;
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const stripAnsi = (str) => str.replace(ANSI_RE, '');
// A real "attention" bell vs the BEL that merely terminates an OSC title sequence
// (ESC ] 0 ; title BEL) — which bash/zsh/Claude emit on every prompt. Strip OSC
// first, then a leftover BEL is a genuine bell.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Быстрый путь: в подавляющем большинстве кусков BEL нет вовсе — не гоняем replace по всему куску.
const hasRealBell = (s) => s.indexOf('\x07') !== -1 && s.replace(OSC_RE, '').includes('\x07');
// От куска для rec.tail нужен только конец (хвост держим 400 видимых символов, эвристика смотрит
// последнюю строку): чистим ANSI не во всём куске, а в последних TAIL_SRC символах. Склеенный
// вывод приходит пачками до 64 КБ — без этого regex бегал бы по каждой пачке целиком.
const TAIL_SRC = 8192;

function setProjState(sid, state) {
  projState.set(sid, state);
  const rec = terms.get(sid);
  document.querySelectorAll(`.tab[data-sid="${sid}"] .tab-dot`).forEach((d) => { d.className = 'tab-dot pind ' + state; });
  if (rec) refreshProjIndicator(rec.projId); // card/rail show the project aggregate
  updateAttention();
}
function markActivity(id, data) {
  const rec = terms.get(id);
  if (!rec) return;
  const bell = !!(data && hasRealBell(data));
  if (bell) rec.sawBell = true;
  // Claude на переднем плане: его вывод — не признак работы (строка статуса и поле ввода
  // перерисовываются и в простое), а только повод свериться с его отчётом.
  if (rec.claude) { scheduleClaudeProbe(id); return; }
  // Local echo of the user's own typing is tiny and arrives right after a keystroke —
  // that's not the agent working, so don't spin on it.
  const echoLike = !bell && data && data.length <= 8 && (Date.now() - (rec.lastInputAt || 0)) < 250;
  if (echoLike) return;
  const src = data || '';
  rec.tail = stripAnsi((rec.tail || '') + (src.length > TAIL_SRC ? src.slice(-TAIL_SRC) : src)).slice(-400);
  rec.activitySeq = (rec.activitySeq || 0) + 1; // lets a pending settle detect that new output arrived
  if (projState.get(id) !== 'busy') { rec.busyStart = Date.now(); setProjState(id, 'busy'); }
  clearTimeout(rec.idleTimer);
  rec.idleTimer = setTimeout(() => settleProject(id), settings.idleMs);
}
// Output stopped — ask the OS whether the foreground process is waiting on input
// (universal, agent-agnostic) and fall back to text heuristics off Linux.
async function settleProject(id) {
  const rec = terms.get(id);
  if (!rec) return;
  const seq = rec.activitySeq;
  const report = await agentReport(id);
  if (!terms.has(id) || rec.activitySeq !== seq) return; // new output arrived during the await
  if (claudeVerdict(id, report)) return;           // в терминале Claude — решает его отчёт
  const kind = report ? report.fg : null;          // 'shell' | 'running' | 'waiting' | null

  if (kind === 'running') { // a foreground program is computing silently → keep spinner, re-poll
    if (projState.get(id) !== 'busy') setProjState(id, 'busy');
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => settleProject(id), settings.idleMs);
    return;
  }
  let waiting;
  if (kind === 'waiting') waiting = true;          // agent alive & blocked on your input
  else if (kind === 'shell') waiting = false;      // back at a bare shell prompt → idle/done
  else waiting = PROMPT_RE.test((rec.tail || '').split('\n').pop().trim()); // non-Linux fallback
  if (rec.sawBell) waiting = true;                 // explicit bell always means "look at me"
  // skip trivial blips; не busy — сюда пришли после выхода Claude, работы не было
  const worked = rec.sawBell || (projState.get(id) === 'busy' && (Date.now() - (rec.busyStart || 0)) >= 1500);
  rec.sawBell = false;
  setProjState(id, waiting ? 'waiting' : 'quiet');
  // notify per project when its turn ended on a non-visible tab (or app unfocused)
  if (worked && (id !== activeSessionId() || !document.hasFocus())) notifyAgent(rec.projId, waiting ? 'waiting' : 'quiet', id);
}
// { fg, claude } (Linux) | null (нет /proc). Старый preload без agentState — только fg.
async function agentReport(id) {
  try {
    if (lite.pty.agentState) return await lite.pty.agentState(id);
    const fg = await lite.pty.foregroundState(id);
    return fg ? { fg, claude: null } : null;
  } catch (_) { return null; }
}

// ---- Claude Code ----
// По выводу не понять, работает ли Claude: строка статуса с refreshInterval перерисовывается и
// в простое (55–75 байт раз в 1–2 с), каждая буква в поле ввода — ~50 байт перерисовки. По правилу
// «вывод = работа» простаивающий Claude мигал: 1,2 с крутилка, затем жёлтый, и снова (задача #35).
// Что Claude сообщает сам (замер 24.09.2026, v2.1.281):
//  • заголовок терминала: «◐ …»/«◑ …» — идёт ход (кадр сменяется раз в 0,96 с, пока терминал
//    в фокусе; без фокуса замирает, но остаётся «рабочим»), «✳ …» — ход окончен или Claude ждёт
//    ответа, пустой — Claude вышел. «Ждёт вас» от «готов» заголовок не отличает;
//  • отчёт о сессии (lib/agentstate.js, только Linux): busy | idle | waiting + причина — главный источник.
// Итог: крутилка — Claude работает; жёлтый — ждёт вашего решения (разрешение, вопрос, диалог);
// зелёный — ход окончен, Claude готов к следующему сообщению.
const CLAUDE_TITLE_RE = /^([◐◑✳])\s/;
const CLAUDE_PROBE_MS = 150;      // пауза в выводе перед сверкой: отчёт отстаёт от экрана до ~50 мс
const CLAUDE_PROBE_MAX_MS = 1000; // под непрерывным выводом сверяемся не реже раза в секунду
// Отчёта нет (macOS/Windows, Claude по ssh, старая версия) — диалог узнаём по экрану: у запроса
// разрешения, вопроса и меню Claude внизу нумерованный список «❯ 1.» и подвал «… Esc to cancel».
const CLAUDE_PICK_RE = /^\s*❯\s*1\.\s/;
const CLAUDE_FOOT_RE = /\bEsc to cancel\b/;

function claudeDialogOnScreen(term) {
  const b = term.buffer.active;
  let pick = false, foot = false;
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (CLAUDE_PICK_RE.test(text)) pick = true;
    if (CLAUDE_FOOT_RE.test(text)) foot = true;
  }
  return pick && foot;
}
// Заголовок терминала (OSC 0/2) — самый быстрый признак: «◐/◑» ставит крутилку сразу.
function onClaudeTitle(id, raw) {
  const rec = terms.get(id);
  if (!rec) return;
  const m = CLAUDE_TITLE_RE.exec(String(raw || ''));
  if (!m) {   // заголовок больше не от Claude: вышел (при выходе он пустой) или шелл поставил свой
    if (rec.claude && rec.claude.titled) leaveClaude(id);
    return;
  }
  const working = m[1] !== '✳';
  const c = rec.claude || (rec.claude = {});
  const was = c.titled ? c.working : null;
  c.titled = true;
  c.working = working;
  clearTimeout(rec.idleTimer);                // обычная «тишина → проверка» для Claude не нужна
  if (was === working) return;                // очередной кадр ◐/◑ — ничего не изменилось
  if (working) setAgentState(id, 'busy');     // ход начался — крутилка сразу, отчёт догонит
  scheduleClaudeProbe(id, working ? CLAUDE_PROBE_MS : 60);
}
function scheduleClaudeProbe(id, delay = CLAUDE_PROBE_MS) {
  const rec = terms.get(id);
  if (!rec) return;
  clearTimeout(rec.probeTimer);
  rec.probeTimer = setTimeout(() => probeClaude(id), delay);
  if (!rec.probeDeadline) rec.probeDeadline = setTimeout(() => probeClaude(id), CLAUDE_PROBE_MAX_MS);
}
function stopClaudeProbe(rec) {
  clearTimeout(rec.probeTimer); clearTimeout(rec.probeDeadline);
  rec.probeTimer = rec.probeDeadline = null;
}
async function probeClaude(id) {
  const rec = terms.get(id);
  if (!rec) return;
  stopClaudeProbe(rec);
  const seq = rec.probeSeq = (rec.probeSeq || 0) + 1;
  const report = await agentReport(id);
  if (!terms.has(id) || rec.probeSeq !== seq || !rec.claude) return; // пока ждали, ушла новая сверка
  if (!claudeVerdict(id, report)) settleProject(id);                 // Claude больше нет — обычная логика
}
// Состояние по Claude. false — Claude в терминале нет, решает обычная логика.
function claudeVerdict(id, report) {
  const rec = terms.get(id);
  const rep = report && report.claude;
  if (rep) {
    const c = rec.claude || (rec.claude = {});   // Claude без заголовка (он отключён) узнаём по отчёту
    clearTimeout(rec.idleTimer);
    const st = rep.status === 'busy' ? 'busy' : rep.status === 'waiting' ? 'waiting' : 'quiet';
    // Заголовок и отчёт расходятся — файл отстаёт от экрана на десятки мс, переспросим. Расхождение
    // бывает и по делу («busy» при «✳», пока работают фоновые агенты Claude) — после трёх сверок верим отчёту.
    if (c.titled && (st === 'busy') !== c.working && (rec.claudeRetry || 0) < 3) {
      rec.claudeRetry = (rec.claudeRetry || 0) + 1;
      scheduleClaudeProbe(id, 300);
      return true;
    }
    rec.claudeRetry = 0;
    setAgentState(id, st, rep.waitingFor);
    return true;
  }
  if (!rec.claude) return false;
  // Отчёта нет, но заголовок от Claude и на переднем плане не голый шелл — по заголовку и экрану.
  if (rec.claude.titled && !(report && report.fg === 'shell')) {
    setAgentState(id, rec.claude.working ? 'busy' : claudeDialogOnScreen(rec.term) ? 'waiting' : 'quiet');
    return true;
  }
  rec.claude = null;   // Claude вышел: на переднем плане шелл или другая программа
  stopClaudeProbe(rec);
  return false;
}
function leaveClaude(id) {
  const rec = terms.get(id);
  if (!rec) return;
  rec.claude = null;
  rec.claudeRetry = 0;
  stopClaudeProbe(rec);
  clearTimeout(rec.idleTimer);
  rec.idleTimer = setTimeout(() => settleProject(id), settings.idleMs);
}
// Смена состояния Claude. Уведомление, если вкладка не на виду: «ждёт вас» — всегда,
// «закончил» — если ход был не пустяковый (≥ 1,5 с).
function setAgentState(id, st, reason) {
  const rec = terms.get(id);
  if (!rec) return;
  const prev = projState.get(id);
  if (st === prev) return;
  const worked = prev === 'busy' && Date.now() - (rec.busyStart || 0) >= 1500;
  if (st === 'busy') rec.busyStart = Date.now();
  rec.sawBell = false;
  setProjState(id, st);
  if (st === 'busy') return;
  if ((st === 'waiting' || worked) && (id !== activeSessionId() || !document.hasFocus())) notifyAgent(rec.projId, st, id, reason);
}

let lastNotifyAt = 0;
// reason — причина ожидания из отчёта Claude ('permission prompt', 'input needed', …).
function notifyAgent(id, state, sid, reason) {
  if (!settings.notifications) return;
  const proj = projects.find((p) => p.id === id);
  if (!proj || Date.now() - lastNotifyAt < 1200) return;
  lastNotifyAt = Date.now();
  const title = state !== 'waiting' ? tt('✓ {0} — агент закончил', proj.name)
    : reason === 'permission prompt' ? tt('⏳ {0} — Claude просит разрешения', proj.name)
    : reason === 'input needed' ? tt('⏳ {0} — Claude задал вопрос', proj.name)
    : tt('⏳ {0} — агент ждёт ответа', proj.name);
  try {
    const n = new Notification(title, { body: proj.path, silent: !settings.sound, tag: 'lite-' + id });
    n.onclick = () => { lite.win.show(); setActive(id); if (sid && terms.has(sid)) switchTab(sid); };
  } catch (_) {}
}
// Count of agents waiting on input → titlebar badge + tray tooltip.
let trayAttentionSent = -1;   // что последним ушло в трей: шлём только при смене числа
function updateAttention() {
  const n = [...projState.values()].filter((s) => s === 'waiting').length;
  const badge = $('#attention-badge');
  if (badge) {
    badge.replaceChildren(icon('bell', 13), el('span', null, String(n)), el('span', null, n === 1 ? 'ждёт ответа' : 'ждут ответа'));
    badge.classList.toggle('show', n > 0);
  }
  if (n !== trayAttentionSent) { trayAttentionSent = n; lite.tray.update(n); }
}

// ---------------------------------------------------------------- terminals
// Matches a path with an extension, optionally :line — e.g. src/app.js:42.
const FILELINK_RE = /(?:[a-zA-Z]:)?(?:\.{0,2}[\\/])?[\w.\-\\/]+\.[A-Za-z][\w]*(?::\d+)?/g;
function fileLinkProvider(term, projPath) {
  return {
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { cb(undefined); return; }
      const text = line.translateToString(true);
      const links = [];
      let m; FILELINK_RE.lastIndex = 0;
      while ((m = FILELINK_RE.exec(text))) {
        const raw = m[0];
        if (!/[\\/]/.test(raw) && !/^\w+\.\w+(:\d+)?$/.test(raw)) continue;
        const startX = m.index + 1;
        links.push({
          range: { start: { x: startX, y }, end: { x: startX + raw.length - 1, y } },
          text: raw,
          activate: () => openFromTerminal(projPath, raw),
        });
      }
      cb(links.length ? links : undefined);
    },
  };
}
async function openFromTerminal(projPath, raw) {
  const mm = raw.match(/^(.*?)(?::(\d+))?$/);
  let p = mm[1]; const line = mm[2] ? parseInt(mm[2], 10) : 0;
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) p = projPath.replace(/[\\/]$/, '') + '/' + p.replace(/^\.[\\/]/, '');
  if (!(await lite.fs.exists(p))) return;
  lite.editorBus.openInViewer(p, line); // main откроет окно вивера (если надо) и покажет файл
}

// True only for a real GPU — software WebGL (SwiftShader/llvmpipe) is slower than
// Canvas and stalls, so route those to the Canvas renderer instead.
// isHardwareWebgl/loadFastRenderer/applyUnicode11/copySelection вынесены в renderer/termutil.js
// (общие xterm-хелперы редактора и окон модулей; импорт у блока импортов).

// ---- terminal sessions (tabs) ----
// Each project owns ≥1 SESSION (tab) = its own PTY + xterm. `terms` is keyed by sessionId;
// `tabsByProj` keeps per-project order + active session. Tab NAMES persist across restarts
// (projTabs store); PTYs don't, so tabs are recreated empty on next launch.
function activeSessionId() { const t = tabsByProj.get(activeId); return t ? t.active : null; }
function projSessions(projId) { const t = tabsByProj.get(projId); return t ? t.sessions : []; }
function projAggState(projId) {
  const ss = projSessions(projId).map((s) => projState.get(s));
  if (!ss.length) return 'idle';   // терминал проекта ещё не поднимали в этом запуске
  // «ждёт вас» важнее «работает»: вторая вкладка с крутилкой не должна прятать вопрос первой
  return ss.includes('waiting') ? 'waiting' : ss.includes('busy') ? 'busy' : 'quiet';
}
function refreshProjIndicator(projId) {
  const st = projAggState(projId);
  document.querySelectorAll(`.pind[data-id="${projId}"]`).forEach((i) => { i.className = 'pind ' + st; });
}
function saveProjTabs() {
  const out = {};
  for (const [pid, t] of tabsByProj) {
    out[pid] = { names: t.sessions.map((s) => (terms.get(s) || {}).name || 'Терминал'), custom: t.sessions.map((s) => !!(terms.get(s) || {}).customName), active: t.sessions.indexOf(t.active) };
  }
  persist('projTabs', out);
}

// ── Снимки сессий между перезапусками — УБРАНО ────────────────────────────────
// Раньше (идея 7) scrollback каждой сессии сериализовался и при старте подгружался НАД свежим
// терминалом как «история до перезапуска». От этого отказались: подгрузка прошлой истории мешает.
// Чистим разово стор от ранее накопленных снимков (могли весить до ~1.5 МБ).
try { if (STORE.sessionSnaps) { STORE.sessionSnaps = null; lite.store.set('sessionSnaps', null); } } catch (_) {}
// ── Реестр глобальных горячих клавиш ядра (идея 5) ────────────────────────────
// Единый источник правды. Матч по физическим клавишам (e.code) → работает в любой
// раскладке. Эти комбо перехватываются И на уровне document, И внутри терминала: фабрика
// xterm зовёт runGlobalHotkey и, если перехвачено, глушит байт + stopPropagation (иначе
// document-хендлер сработал бы вторично, а xterm отправил бы код в PTY — баг B1, из-за
// которого Ctrl+\ слал SIGQUIT активному агенту, Ctrl+K — kill-line readline и т.п.).
const HOTKEYS = [
  { test: (e) => e.code === 'Backslash',                            run: () => toggleSingle() },
  { test: (e) => e.code === 'KeyK',                                 run: () => showPalette() },
  { test: (e) => e.code === 'Equal' || e.code === 'NumpadAdd',      run: () => bumpFont(1) },
  { test: (e) => e.code === 'Minus' || e.code === 'NumpadSubtract', run: () => bumpFont(-1) },
  { test: (e) => e.code === 'Tab',                                  run: (e) => cycleProject(e.shiftKey ? -1 : 1) },
  { test: (e) => e.code === 'KeyF' && e.shiftKey,                   run: () => showGlobalSearch() }, // Ctrl+Shift+F — «Найти во всех проектах» (файлы + терминалы)
  { test: (e) => /^Digit[1-9]$/.test(e.code) && !e.shiftKey,        run: (e) => { const p = projects[+e.code.slice(5) - 1]; if (p) setActive(p.id); } },
];
// Поле ввода, где Ctrl-комбо должны доставаться самому полю (модалки, палитра, формы), — но НЕ
// скрытая textarea xterm'а: она и есть ввод терминала, там перехват обязателен (это фикс B1,
// иначе Ctrl+\ уходит SIGQUIT'ом агенту, а Ctrl+K режет строку в readline).
function isTextEntry(t) {
  if (!t || (t.closest && t.closest('.xterm'))) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}
function runGlobalHotkey(e) {
  if (!e.ctrlKey || e.metaKey) return false;
  if (isTextEntry(e.target)) return false;
  for (const h of HOTKEYS) { if (h.test(e)) { e.preventDefault(); h.run(e); return true; } }
  return false;
}

// ── Единая фабрика терминалов (идея 4) ────────────────────────────────────────
// Общая сборка xterm для сессий проектов и dev-терминалов модулей: Terminal + аддоны +
// рендерер + PTY + базовый обработчик клавиш. Вызывающий передаёт id/cwd, хук ввода и
// набор «своих» клавиш (onKey) поверх базовых. Это убрало ~90% дубля между
// createSession и createExtTerminal, который раньше норовил разъехаться.
function buildXterm(container, id, { cwd, onInput, onKey } = {}) {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 5000,
    allowTransparency: true, // фон терминала прозрачный — виден полупрозрачный фон окна (задаётся только при создании)
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
  applyUnicode11(term);
  term.open(container);
  prepareRenderer(term);   // WebGL — при показе (activateRenderer), держится у последних показанных
  // Шкала времени слева — подключается ДО первого fit(): она забирает ширину у области вывода,
  // и cols должны считаться уже с её учётом, иначе первый же resize уедет на несколько колонок.
  // Размер PTY — через ptyResizer (termutil.js): серия ресайзов при перетаскивании разделителя
  // уходит программе одним SIGWINCH, а не десятками перерисовок в секунду.
  const syncPty = ptyResizer(id, term);
  const timeline = attachTimeline(term, container, {
    enabled: settings.termTimeline === true,
    fontSize: settings.fontSize,
    onGeometry: () => requestAnimationFrame(() => { try { fit.fit(); syncPty(); } catch (_) {} }),
  });
  fit.fit();
  lite.pty.create({ id, cwd, cols: term.cols, rows: term.rows });
  term.onData((data) => { timeline.markInput(data); if (onInput) onInput(data); lite.pty.write(id, data); });
  term.onResize(syncPty);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Match by physical key (e.code), NOT e.key — so Ctrl+C/V etc. work in ANY keyboard
    // layout (in Russian layout Ctrl+V gives e.key='м', which the old e.key check missed).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term); // copied → swallow; else SIGINT
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteInto(id); return false; } // preventDefault — иначе xterm вставит ещё раз нативно (дубль)
    // Ctrl+Enter — перенос строки в вводе (продолжение команды), а не выполнение: \ + CR для bash/zsh, LF для ConPTY/PSReadLine (Win)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') { cancelPrefill(id); lite.pty.write(id, lite.platform === 'win32' ? '\n' : '\\\r'); return false; }
    if (onKey && onKey(e) === false) return false;            // клавиши вызывающего (вкладки/поиск проекта)
    if (runGlobalHotkey(e)) { e.stopPropagation(); return false; } // глобальные хоткеи в фокусе терминала (B1)
    return true;
  });
  container.addEventListener('contextmenu', (e) => { e.preventDefault(); showTermMenu(e.clientX, e.clientY, term, id); });
  return { term, fit, search, timeline, syncPty };
}
// Вкл/выкл шкалы времени во ВСЕХ живых терминалах (настройка применяется на лету, без перезапуска).
function applyTimeline() {
  const on = settings.termTimeline === true;
  { const tl = $('#term-timeline'); if (tl) { tl.classList.toggle('on', on); tl.title = on ? 'Скрыть шкалу времени' : 'Шкала времени слева'; } }
  for (const rec of terms.values()) { try { rec.timeline.setEnabled(on); } catch (_) {} }
  for (const rec of extTerms.values()) { try { rec.timeline.setEnabled(on); } catch (_) {} }
  refitActiveTerminal();
}

// ── Автоввод в новом терминале ────────────────────────────────────────────────
// Настройка «Автоввод» (по умолчанию `claude`): в свежую сессию проекта пишем слово БЕЗ перевода
// строки — команда стоит в строке ввода, человеку остаётся нажать Enter. Пустая настройка =
// обычный пустой терминал, как раньше. Пишем не сразу: пока шелл поднимается, readline глотает
// символы, а .bashrc успевает насыпать вывода — поэтому ждём первого вывода PTY и паузы в нём.
const PREFILL_QUIET_MS = 150;    // тишина в выводе, после которой считаем, что промпт отрисован
const PREFILL_MAX_WAIT = 1500;   // шелл не сказал ни байта — пишем всё равно
function armPrefill(id, text) {
  const rec = terms.get(id); if (!rec || !text) return;
  rec.prefill = text;
  rec.prefillTimer = setTimeout(() => firePrefill(id), PREFILL_MAX_WAIT);
}
function nudgePrefill(id) {   // пришёл вывод от шелла — отодвинуть запись до паузы
  const rec = terms.get(id); if (!rec || !rec.prefill) return;
  clearTimeout(rec.prefillTimer);
  rec.prefillTimer = setTimeout(() => firePrefill(id), PREFILL_QUIET_MS);
}
function cancelPrefill(id) {  // человек начал печатать сам — не лезть ему в строку
  const rec = terms.get(id); if (!rec || !rec.prefill) return;
  clearTimeout(rec.prefillTimer); rec.prefill = '';
}
function firePrefill(id) {
  const rec = terms.get(id); if (!rec || !rec.prefill) return;
  const text = rec.prefill; rec.prefill = '';
  rec.lastInputAt = Date.now(); // это ввод, пусть и наш: эхо не должно считаться работой агента
  lite.pty.write(id, text);     // без \r — Enter жмёт человек
}
// adoptId — живой терминал прежней страницы (пережил перезагрузку окна): вкладка садится на него.
function createSession(proj, name, custom, adoptId) {
  const id = adoptId || (proj.id + '::t' + (++sessionSeq) + '.' + BOOT_ID);
  const container = el('div', 'term-instance');
  $('#terminals').appendChild(container);
  const { term, fit, search, timeline, syncPty } = buildXterm(container, id, {
    cwd: proj.path,
    onInput: () => { cancelPrefill(id); const r = terms.get(id); if (r) r.lastInputAt = Date.now(); },
    onKey: (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { addTab(); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { const s = activeSessionId(); if (s) closeTab(s); return false; }
      if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleTab(e.key === 'PageDown' ? 1 : -1); return false; }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyF') { openTermSearch(); return false; } // Ctrl+F (без Shift) — поиск в этом терминале; Ctrl+Shift+F уходит в глобальный (реестр)
    },
  });
  term.registerLinkProvider(fileLinkProvider(term, proj.path));
  const rec = { term, fit, search, timeline, syncPty, container, projId: proj.id, name, customName: !!custom, idleTimer: null, sawBell: false, tail: '', busyStart: 0, lastInputAt: 0, activitySeq: 0, prefill: '', prefillTimer: null, redraw: !!adoptId,
    claude: null, probeTimer: null, probeDeadline: null, probeSeq: 0, claudeRetry: 0 }; // claude — см. «Claude Code» у индикатора
  terms.set(id, rec);
  if (adoptId) {
    // прокрутка прежней страницы пропала вместе с ней; программу в терминале попросим перерисоваться при показе
    term.write('\x1b[90m' + tt('[терминал подхвачен после перезагрузки окна — прежний вывод не сохранился]') + '\x1b[0m\r\n');
  } else {
    armPrefill(id, (settings.termPrefill || '').trim()); // автоввод слова из настроек (по умолчанию `claude`)
  }
  // Имя вкладки из заголовка терминала (OSC ]0;…): Claude/агент в промпте пишет туда
  // текущую задачу, шелл — user@host:cwd. Подхватываем как имя вкладки, пока пользователь
  // не переименовал вкладку руками (rec.customName). Один и тот же заголовок (bash каждый
  // промпт шлёт одно и то же) отсекаем сравнением — без дёрганья tab-бара.
  // Он же — признак работы Claude Code для индикатора (onClaudeTitle).
  term.onTitleChange((t) => { onClaudeTitle(id, t); adoptTermTitle(id, t); });
  tabsByProj.get(proj.id).sessions.push(id);
  return id;
}
// Ensure a project's sessions exist (restoring saved tab names on first open).
function ensureProjectTabs(proj) {
  if (tabsByProj.has(proj.id)) return;
  tabsByProj.set(proj.id, { sessions: [], active: null });
  const saved = (STORE.projTabs || {})[proj.id];
  const names = saved && Array.isArray(saved.names) && saved.names.length ? saved.names : ['Терминал 1'];
  const custom = saved && Array.isArray(saved.custom) ? saved.custom : []; // какие имена задал пользователь руками — их заголовок терминала не перебивает
  const adopted = adoptPtys.get(proj.id);
  if (adopted && adopted.length) {
    // окно перезагрузилось, а терминалы проекта живы: вкладки садятся на них в прежнем порядке
    adoptPtys.delete(proj.id);
    adopted.forEach((id, i) => createSession(proj, names[i] || tt('Терминал {0}', i + 1), custom[i], id));
  } else {
    names.forEach((n, i) => createSession(proj, n, custom[i])); // только имена вкладок; история до перезапуска НЕ восстанавливается
  }
  const t = tabsByProj.get(proj.id);
  const ai = saved && Number.isInteger(saved.active) ? saved.active : 0;
  t.active = t.sessions[Math.max(0, Math.min(ai, t.sessions.length - 1))] || t.sessions[0];
  saveProjTabs();
}
function renderTabBar() {
  const bar = $('#term-tabs');
  if (!bar) return;
  // вкладки пересоздаются: у снятой из DOM mouseleave уже не сработает, и тултип (например, после ✕
  // по вкладке под курсором или Ctrl+Tab) висел бы над панелью до следующего наведения
  hideTabTip();
  bar.innerHTML = '';
  const t = tabsByProj.get(activeId);
  // шапка видна всегда (в ней кнопки окна и за неё тянут окно); без проекта нет только вкладок и «+»
  $('#term-tab-add').classList.toggle('hidden', !activeId || !t);
  if (!activeId || !t || !t.sessions.length) { updateTabScroll(); return; }
  t.sessions.forEach((sid) => {
    const rec = terms.get(sid); if (!rec) return;
    const tab = el('div', 'tab' + (sid === t.active ? ' active' : '') + (rec.autoTitled ? ' wide' : ''));
    tab.dataset.sid = sid;
    tab.appendChild(el('span', 'tab-dot pind ' + (projState.get(sid) || 'quiet')));
    const nameSpan = el('span', 'tab-name', rec.name);
    tab.appendChild(nameSpan);
    // Кастомный тултип с полным именем — только когда имя визуально обрезано многоточием.
    tab.addEventListener('mouseenter', () => { if (nameSpan.scrollWidth > nameSpan.clientWidth + 1) showTabTip(tab, rec.name); });
    tab.addEventListener('mouseleave', hideTabTip);
    if (t.sessions.length > 1) {
      const x = iconBtn('tab-close', 'x', 'Закрыть вкладку (Ctrl+Shift+W)', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(sid); });
      tab.appendChild(x);
    }
    tab.addEventListener('click', () => { hideTabTip(); switchTab(sid); });
    tab.addEventListener('dblclick', () => renameTab(sid));
    bar.appendChild(tab);
  });
  ensureActiveTabVisible();
  updateTabScroll();
}
// ── Кастомный тултип вкладок + прокрутка панели вкладок стрелками ──────────────
let tabTipEl = null;
function showTabTip(anchor, text) {
  if (!tabTipEl) { tabTipEl = el('div'); tabTipEl.id = 'tab-tip'; document.body.appendChild(tabTipEl); }
  tabTipEl.textContent = text;
  tabTipEl.classList.add('show');                       // показать, чтобы измерить размеры
  const r = anchor.getBoundingClientRect();
  const tw = tabTipEl.offsetWidth, iw = window.innerWidth;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(6, Math.min(left, iw - tw - 6));      // не вылезать за края экрана
  tabTipEl.style.left = left + 'px';
  tabTipEl.style.top = (r.bottom + 6) + 'px';           // под вкладкой (вкладки вверху панели)
}
function hideTabTip() { if (tabTipEl) tabTipEl.classList.remove('show'); }
function scrollTabs(dir) {
  const bar = $('#term-tabs'); if (!bar) return;
  hideTabTip();
  bar.scrollBy({ left: dir * Math.max(140, bar.clientWidth * 0.7), behavior: 'smooth' });
}
// Показ/дизейбл стрелок по факту переполнения панели вкладок.
function updateTabScroll() {
  const bar = $('#term-tabs'), prev = $('#term-tabs-prev'), next = $('#term-tabs-next');
  if (!bar || !prev || !next) return;
  const overflow = bar.scrollWidth > bar.clientWidth + 1;
  prev.classList.toggle('show', overflow);
  next.classList.toggle('show', overflow);
  if (overflow) {
    const max = bar.scrollWidth - bar.clientWidth;
    prev.disabled = bar.scrollLeft <= 1;
    next.disabled = bar.scrollLeft >= max - 1;
  }
}
// Подкрутить панель так, чтобы активная вкладка была видна целиком (без прокрутки страницы).
// По rect'ам (а не offsetLeft) — устойчиво к отсутствию positioned-родителя у #term-tabs.
function ensureActiveTabVisible() {
  const bar = $('#term-tabs'); if (!bar) return;
  const a = bar.querySelector('.tab.active'); if (!a) return;
  const br = bar.getBoundingClientRect(), ar = a.getBoundingClientRect();
  if (ar.left < br.left) bar.scrollLeft -= (br.left - ar.left) + 8;
  else if (ar.right > br.right) bar.scrollLeft += (ar.right - br.right) + 8;
}
function switchTab(sid) {
  const t = tabsByProj.get(activeId);
  if (!t || !terms.has(sid)) return;
  t.active = sid; saveProjTabs(); showActiveTerminal();
}
function addTab() {
  const proj = activeProject(); if (!proj) return;
  ensureProjectTabs(proj);
  const t = tabsByProj.get(proj.id);
  const sid = createSession(proj, tt('Терминал {0}', t.sessions.length + 1));
  t.active = sid; saveProjTabs(); showActiveTerminal();
}
function closeTab(sid) {
  const t = tabsByProj.get(activeId); if (!t || t.sessions.length <= 1) return; // keep ≥1 tab
  lite.pty.kill(sid);
  const rec = terms.get(sid);
  if (rec) { clearTimeout(rec.idleTimer); clearTimeout(rec.prefillTimer); stopClaudeProbe(rec); releaseRenderer(rec.term); try { rec.timeline.dispose(); } catch (_) {} try { rec.term.dispose(); } catch (_) {} rec.container.remove(); terms.delete(sid); }
  projState.delete(sid);
  const i = t.sessions.indexOf(sid);
  t.sessions.splice(i, 1);
  if (t.active === sid) t.active = t.sessions[Math.max(0, i - 1)];
  saveProjTabs(); showActiveTerminal();
  refreshProjIndicator(activeId); updateAttention();
}
function cycleTab(dir) {
  const t = tabsByProj.get(activeId); if (!t || t.sessions.length < 2) return;
  let i = t.sessions.indexOf(t.active) + dir;
  if (i < 0) i = t.sessions.length - 1; if (i >= t.sessions.length) i = 0;
  switchTab(t.sessions[i]);
}
function renameTab(sid) {
  const rec = terms.get(sid); if (!rec) return;
  // Ручное имя «прибивает» вкладку: заголовок терминала больше её не перебивает (customName)
  // и вкладка возвращается к обычной ширине (autoTitled=false — не «переименована агентом»).
  showPrompt('Переименовать вкладку', 'Название', rec.name, (v) => { rec.name = v; rec.customName = true; rec.autoTitled = false; saveProjTabs(); renderTabBar(); });
}
// Дефолтный заголовок, который шлёт САМ шелл (bash/zsh): "user@host: ~/path", голый путь,
// "C:\path". Это НЕ имя задачи агента — вкладка должна остаться "Терминал N", пока Claude/
// Codex не напишет осмысленный заголовок. Такие заголовки в имя вкладки НЕ подхватываем.
function looksLikeShellTitle(s) {
  if (/^\S+@\S+/.test(s)) return true;             // user@host[: …] — дефолт bash/zsh
  if (/^[~/]\S*$/.test(s)) return true;            // ~/path или /abs/path целиком (без пробелов)
  if (/^[A-Za-z]:[\\/]\S*$/.test(s)) return true;  // C:\path (Windows)
  return false;
}
// Подхват заголовка терминала (OSC ]0;…) в имя вкладки. Чистим управляющие символы,
// схлопываем пробелы, держим щадящий предел (визуально имя режет CSS-многоточие, полное —
// в тултипе). Не трогаем вручную названные вкладки; ИГНОРИРУЕМ шелловый заголовок (путь/хост),
// чтобы вкладка изначально была "Терминал N" и сменилась только на имя задачи от агента;
// не перерисовываем бар, если имя то же (заголовок сыплется на каждый промпт).
// autoTitled=true → вкладка «переименована агентом» (шире вдвое, класс .wide в renderTabBar).
function adoptTermTitle(id, raw) {
  const rec = terms.get(id); if (!rec || rec.customName) return;
  let name = String(raw || '').replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/\s+/g, ' ');
  // значок состояния Claude (◐/◑ меняются раз в секунду, пока идёт ход) — в индикаторе, не в имени
  name = name.replace(CLAUDE_TITLE_RE, '');
  if (!name || looksLikeShellTitle(name)) return;
  if (name.length > 200) name = name.slice(0, 200);
  if (name === rec.name && rec.autoTitled) return;
  rec.name = name;
  rec.autoTitled = true;
  updateTabName(id);
}
// Точечное обновление одной вкладки вместо пересборки всей панели: агенты пишут заголовок часто,
// а renderTabBar пересоздаёт все вкладки и дважды заставляет браузер пересчитать раскладку. Вкладка
// фонового проекта на экране не видна — её имя подхватит следующий renderTabBar при переключении.
function updateTabName(sid) {
  const rec = terms.get(sid);
  const t = tabsByProj.get(activeId);
  if (!rec || !t || !t.sessions.includes(sid)) return;
  const tab = [...document.querySelectorAll('#term-tabs .tab')].find((x) => x.dataset.sid === sid);
  if (!tab) { renderTabBar(); return; }
  tab.classList.toggle('wide', !!rec.autoTitled);
  const span = tab.querySelector('.tab-name');
  if (span && span.textContent !== rec.name) span.textContent = rec.name;
  scheduleTabScroll();
}
// Стрелки прокрутки панели вкладок зависят от ширины вкладок — пересчитываем раз в кадр, не на каждое имя.
let tabScrollRaf = 0;
function scheduleTabScroll() {
  if (tabScrollRaf) return;
  tabScrollRaf = requestAnimationFrame(() => { tabScrollRaf = 0; updateTabScroll(); });
}
async function pasteInto(id) {
  const text = await lite.readClipboard();
  if (text) { cancelPrefill(id); lite.pty.write(id, text); }
  // Reading the clipboard is async (IPC round-trip) and the right-click menu steals
  // focus — without this the terminal looks "frozen" until clicked. Refocus the xterm.
  const rec = isExtTerm(id) ? extTerms.get(id) : terms.get(id); // dev-терминал модуля живёт в extTerms
  if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
}
// Smart Ctrl+C: if there's a non-empty selection, copy it (and clear, so the next
// Ctrl+C can still send SIGINT) and report handled; otherwise return false so the
// keypress falls through to the PTY as the interrupt signal. Mirrors the menu's copy.
function showActiveTerminal() {
  const asid = activeSessionId();
  $('#empty-hint').style.display = activeId ? 'none' : 'flex';
  for (const [sid, rec] of terms) rec.container.style.display = sid === asid ? 'block' : 'none';
  const shown = asid && terms.get(asid);
  if (shown) activateRenderer(shown.term);
  renderTabBar();
  refitActiveTerminal(true);
}
function refitActiveTerminal(focusIt) {
  try { Ext.refitTerminal(); } catch (_) {} // dev-терминал модуля в #ext-pane
  const asid = activeSessionId();
  const rec = asid ? terms.get(asid) : null;
  if (!rec) return;
  requestAnimationFrame(() => {
    try { rec.fit.fit(); rec.syncPty(); if (focusIt) rec.term.focus(); } catch (_) {}
    if (rec.redraw) {
      // подхваченный терминал: размер мог не измениться, и программа не узнает, что экран пуст, —
      // качнём ширину на колонку, это SIGWINCH, и агент (Claude Code и т. п.) перерисуется
      rec.redraw = false;
      const { cols, rows } = rec.term;
      if (cols > 2) { lite.pty.resize(asid, cols - 1, rows); setTimeout(() => lite.pty.resize(asid, cols, rows), 120); }
    }
  });
}
// ⚠ id из контекстного меню терминала может быть и dev-терминалом модуля (`__extterm__::tN`) —
// его НЕТ в `terms`. Раньше обе функции молча падали на activeSessionId(), и «Перезапустить» в
// терминале папки модуля перезапускал PTY активного проекта, убивая работающего там агента.
function clearTerminal(id) {
  if (isExtTerm(id)) { const r = extTerms.get(id); if (r) { try { r.term.clear(); } catch (_) {} try { r.timeline.reset(); } catch (_) {} r.term.focus(); } return; }
  const sid = (id && terms.has(id)) ? id : activeSessionId();
  const rec = terms.get(sid); if (rec) { try { rec.term.clear(); } catch (_) {} try { rec.timeline.reset(); } catch (_) {} rec.term.focus(); }
}
function restartTerminal(id) {
  if (isExtTerm(id)) { restartExtTerminal(id); return; }
  const sid = (id && terms.has(id)) ? id : activeSessionId();
  const rec = terms.get(sid);
  const proj = rec && projects.find((p) => p.id === rec.projId);
  if (!proj || !rec) return;
  try { rec.term.reset(); } catch (_) {}
  try { rec.timeline.reset(); } catch (_) {}
  rec.sawBell = false; rec.tail = ''; rec.busyStart = Date.now();
  clearTimeout(rec.idleTimer);
  rec.claude = null; stopClaudeProbe(rec);
  setProjState(sid, 'busy');
  lite.pty.restart({ id: sid, cwd: proj.path, cols: rec.term.cols, rows: rec.term.rows });
  rec.term.focus();
}
// Перезапуск dev-терминала модуля — в его СОБСТВЕННОЙ папке (cwd запоминаем при создании).
function restartExtTerminal(id) {
  const r = extTerms.get(id);
  if (!r) return;
  try { r.term.reset(); } catch (_) {}
  try { r.timeline.reset(); } catch (_) {}
  lite.pty.restart({ id, cwd: r.cwd, cols: r.term.cols, rows: r.term.rows });
  r.term.focus();
}


// Терминал dev-папки модуля: PTY+xterm в переданном контейнере (живёт в #ext-pane).
// Возвращает handle для extensions.js; xterm в код модуля не утекает (правило изоляции).
function createExtTerminal(container, cwd) {
  const id = EXT_TERM_ID + '::t' + (++extTermSeq) + '.' + BOOT_ID;
  // Без onKey: у dev-терминала модуля нет вкладок, а Ctrl+F открыл бы поиск ЧУЖОГО
  // (активного проектного) терминала — поэтому поиск здесь не перехватываем (как было).
  const { term, fit, search, timeline, syncPty } = buildXterm(container, id, { cwd });
  extTerms.set(id, { term, fit, search, timeline, container, cwd }); // cwd — для «Перезапустить» из контекст-меню
  activateRenderer(term);   // dev-терминал модуля виден сразу, в панели «Мои модули»
  return {
    id,
    write: (s) => lite.pty.write(id, s),
    focus: () => { try { term.focus(); } catch (_) {} },
    refit: () => requestAnimationFrame(() => { try { fit.fit(); syncPty(); } catch (_) {} }),
    dispose: () => { lite.pty.kill(id); releaseRenderer(term); try { timeline.dispose(); } catch (_) {} try { term.dispose(); } catch (_) {} extTerms.delete(id); },
  };
}

// ================================================================ RemoteHost module (SSH)
// Вынесен в renderer/modules/remotehost.js (const Rh — у реестра панелей).

// ---------------------------------------------------------------- font size
let watchedRoot = null; // we live-watch only the active project to limit inotify use
function applyFontSize() {
  for (const rec of terms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.timeline.setFontSize(settings.fontSize); } catch (_) {} try { rec.fit.fit(); } catch (_) {} }
  for (const rec of extTerms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.timeline.setFontSize(settings.fontSize); } catch (_) {} try { rec.fit.fit(); } catch (_) {} }
  document.documentElement.style.setProperty('--editor-fs', settings.fontSize + 'px');
  refitActiveTerminal();
  try { lite.app.settingsChanged(settings); } catch (_) {} // окно «Система · ~» подхватит размер шрифта
}
function bumpFont(delta) {
  settings.fontSize = Math.max(9, Math.min(24, settings.fontSize + delta));
  saveSettings(); applyFontSize();
}

// ---------------------------------------------------------------- terminal search
function openTermSearch() {
  const rec = terms.get(activeSessionId());
  if (!rec) return;
  const box = $('#term-search');
  box.classList.add('show');
  const input = $('#term-search-input');
  input.focus(); input.select();
}
function closeTermSearch() {
  $('#term-search').classList.remove('show');
  const rec = terms.get(activeSessionId());
  if (rec) { try { rec.search.clearDecorations(); } catch (_) {} rec.term.focus(); }
}
function runTermSearch(dir) {
  const rec = terms.get(activeSessionId());
  const q = $('#term-search-input').value;
  if (!rec || !q) return;
  // Метки overview-ruler берём из токенов активной темы, а не хардкодим (контракт тем):
  // --warn для совпадений, --add для активного — так они согласованы с любой темой.
  const css = getComputedStyle(document.documentElement);
  const opts = { decorations: {
    matchOverviewRuler: (css.getPropertyValue('--warn') || '#e0af68').trim() || '#e0af68',
    activeMatchColorOverviewRuler: (css.getPropertyValue('--add') || '#3ddc84').trim() || '#3ddc84',
  } };
  if (dir < 0) rec.search.findPrevious(q, opts); else rec.search.findNext(q, opts);
}

// ── Сканер буферов открытых сессий (режим «В терминалах» глобального поиска, идея 9) ──
// Когда параллельно работают несколько агентов, важно быстро найти «где это проскочило».
// Читаем scrollback каждого терминала (read-only, PTY не трогаем); выдачу рисует gsearch.js.
const GS_PER_SESSION = 60;   // потолок совпадений на одну сессию
function scanTermBuffer(term, q) {
  const out = [];
  try {
    const buf = term.buffer.active;
    const ql = q.toLowerCase();
    for (let y = 0; y < buf.length && out.length < GS_PER_SESSION; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.toLowerCase().includes(ql)) out.push({ y, text: text.trim().slice(0, 200) });
    }
  } catch (_) {}
  return out;
}
function jumpToSession(projId, sid) {
  setActive(projId);
  const t = tabsByProj.get(projId);
  if (t && t.sessions.includes(sid)) { t.active = sid; saveProjTabs(); }
  showActiveTerminal();
}
// Окно «Найти во всех проектах» (renderer/gsearch.js): содержимое и имена файлов через стриминговый
// бэкенд gsearch:*, плюс прежний поиск по буферам открытых терминалов — теперь один из его режимов.
function showGlobalSearch(initial = {}) {
  openGlobalSearch({
    lite,
    projects: () => projects,
    activeId: () => activeId,
    setActive,
    openInViewer: (p, line) => lite.editorBus.openInViewer(p, line),
    terms: () => terms,
    jumpToSession,
    scanTermBuffer,
    categories: () => loadCategories().filter((c) => c !== ARCHIVE),
    STORE,
    persist,
  }, initial);
}

// guardDirty (защита несохранённых правок вивера при переключении) переехал в files.js → Files.guardDirty.

function setActive(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  if (id === activeId) return;
  doSetActive(id); // окно вивера само защитит несохранённые правки при смене активного проекта
}
function doSetActive(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  activeId = id;
  try { sessionStorage.setItem('lite.activeProject', id); } catch (_) {} // переживает перезагрузку окна (не перезапуск)
  try { lite.errors.setContext(proj.path); } catch (_) {} // тег проекта для новых ошибок в реестре
  // Перевешиваем вотчер ТОЛЬКО при смене корня — иначе повторная активация уже активного
  // проекта (повторный вызов doSetActive на тот же проект) плодила бы дубль fs.watch
  // и дублирующиеся fs:changed (B6).
  if (watchedRoot !== proj.path) {
    if (watchedRoot) lite.fs.unwatch(watchedRoot);
    lite.fs.watch(proj.path); watchedRoot = proj.path;
  }
  ensureProjectTabs(proj);
  renderProjects();
  showActiveTerminal();
  applyFontSize();
  // вивер живёт в своём окне и следует за проектом через app:activeProject (pushActiveProject ниже)
  try { Ext.notifyActiveProject(activeId); } catch (_) {} // пользовательские модули: ctx.projects.onChange
  pushActiveProject(proj); // окна модулей (git/ctx/notes/audit): следовать за активным проектом редактора
  updateNotesBadge();      // бейдж задач — под новый активный проект
  refreshGitChip(0);       // чип ветки под терминалом — под новый активный проект
}
// Сообщить окнам модулей о текущем активном проекте (кэшируется в main, рассылается окнам).
function pushActiveProject(proj) {
  try {
    const p = proj || projects.find((x) => x.id === activeId);
    lite.app.setActiveProject(p ? { id: p.id, path: p.path, name: p.name, accent: p.accent || '' } : null);
  } catch (_) {}
}

// ---------------------------------------------------------------- viewer + tree → ОТДЕЛЬНОЕ ОКНО (files)
// Вивер (CodeMirror) и дерево файлов — модуль renderer/modules/files.js, теперь в собственном окне
// (проектозависимое: следует за активным проектом редактора через app:activeProject). Ядро его НЕ
// держит: открыть — openModule('files'); открыть файл — lite.editorBus.openInViewer(path,line) (main
// маршрутизирует в окно вивера, открывая его при необходимости).

// ================================================================ right module slot
// One module open at a time in the right slot. NOT modules: terminals (project + scratch ~)
// and the OpenRouter chat (it replaces the terminal, its cards live in the project column).
// Реестр панелей: каждая setXxxOpen знает только себя, взаимоисключение — closeOtherPanels.
// Порядок закрытия фиксирован (он же — порядок старых inline-цепочек во всех setXxxOpen).
const panels = new Map(); // id -> { isOpen(), setOpen(open, opts) }
// Правый слот редактора теперь держит только «Мои модули» (ext); всё остальное — отдельные окна.
const PANEL_ORDER = [];
// Модули, мигрированные в отдельные окна (открываются через lite.module.open, не как панель правого слота).
const WINDOW_MODULES = new Set(['tools', 'iterflow', 'seo', 'audit', 'company', 'notes', 'db', 'rmq', 'kafka', 'chat', 'doc', 'docker', 'rh', 'ctx', 'scratch', 'files', 'pomodoro', 'monitor', 'keepass', 'sitemon', 'storage', 'jira', 'voice']);
function registerPanel(id, api) { panels.set(id, api); }
function closeOtherPanels(selfId) {
  for (const id of PANEL_ORDER) {
    if (id === selfId) continue;
    const p = panels.get(id);
    if (p && p.isOpen()) p.setOpen(false);
  }
}
// Вивер+дерево (files) мигрированы в отдельное окно (проектозависимое: следует за активным проектом).
// В реестре панелей больше нет; открытие — openModule('files'). См. WINDOW_MODULES / module-entry.js.
// Git мигрирован в отдельное окно (проектозависимое: следует за активным проектом редактора).
// См. WINDOW_MODULES / module-entry.js.
// «Контекст» (ctx) — канва файла CLAUDE.md мигрирована в отдельное окно (проектозависимое: следует
// за активным проектом редактора). Тихой автосборки больше нет: канва пишет файл сама, собирать нечего.
// Контейнеры (docker), «Базы данных» (db), «Удалённые хосты» (rh) мигрированы в отдельные окна
// (самостоятельные). Стримы (containers:*/rh:*) маршрутизируются по окну-владельцу. См. module-entry.js.
// scratch (системный терминал) мигрирован в отдельное окно — в реестре панелей больше нет.
// Задачи (notes) мигрированы в отдельное окно (проектозависимое: следует за активным проектом редактора).
// Аудит (audit) мигрирован в отдельное окно (проектозависимое: следует за активным проектом редактора
// через app:activeProject). IterFlow и WEB/SEO аудит — тоже отдельные окна. См. module-entry.js.
// Инструменты — devtools-комбайн (renderer/modules/tools.js); системная панель, чистый фронт без бэкенда.
// «Инструменты» (tools) — мигрирован в отдельное окно: openModule('tools') открывает BrowserWindow
// (см. WINDOW_MODULES / lite.module.open). В правом слоте больше не регистрируется.
// OpenRouter (чат) и «Обработка текста» мигрированы в отдельные окна (самостоятельные). Их стримы
// (openrouter:chunk/done/error, tp:done/error) уже маршрутизируются по окну-отправителю через
// safeSend(e.sender,…) в main.js → уходят именно в своё окно. См. WINDOW_MODULES / module-entry.js.
// Пользовательские модули (extensions): загрузчик + общая панель правого слота.
// renderer/modules/extensions.js; публичный API ctx v1 — спека в module-kit/GUIDE.md.
const Ext = initExtensions({
  STORE, persist, layout, GUTTER, refitActiveTerminal, closeOtherPanels,
  getProjects: () => projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
  getActiveId: () => activeId,
  getTheme: () => THEME_NAME,
  closeMenus: () => closeMenus(),
  menuRow: (glyph, text, onClick, cls) => menuRow(glyph, text, onClick, cls),
  moduleRow: (glyph, title, desc, onClick) => moduleRow(glyph, title, desc, onClick),
  spawnFolderTerminal: (container, cwd) => createExtTerminal(container, cwd),
  modsChanged: () => renderQuickbar(), // состав пользовательских модулей изменился → перерисовать квикбар
});
registerPanel('ext', { isOpen: Ext.isOpen, setOpen: Ext.setOpen });
PANEL_ORDER.push('ext');
// Entry point used by the «Модули» menu / quickbar. Мигрированные модули открываются окном.
function openModule(id) {
  if (id === 'git') { lite.editorBus.focusGit(); return; } // Git встроен в окно вивера → открыть его на секции «Коммит»
  if (WINDOW_MODULES.has(id)) { lite.module.open(id); return; }
  const p = panels.get(id);
  if (p) p.setOpen(true);
}

// ---------------------------------------------------------------- quickbar (панель быстрого доступа)
// Полоса кнопок-иконок ПОД терминалом (#quickbar в #terminal-pane): клик открывает модуль.
// Состав и порядок — STORE.quickbar (массив id; пользовательские модули — 'ext:<id>').
// Настройка — «Модули → Настройка панели…». Пустой список → полоса скрыта целиком.
// Спец-элемент '|' — вертикальный разделитель (можно ставить сколько угодно, в любое место).
const QUICK_SEP = '|';
const QUICK_BUILTIN = [
  { id: 'files',   icon: 'eye',      label: 'Проект — вивер, дерево, Git' },
  { id: 'ctx',     icon: 'graph',    label: 'Контекст — граф контекста агента' },
  { id: 'docker',  icon: 'box',      label: 'Контейнеры — Docker / Podman' },
  { id: 'db',      icon: 'database', label: 'Базы данных — Postgres / MySQL / SQLite' },
  { id: 'rmq',     icon: 'rabbit',   label: 'RabbitMQ — очереди, сообщения, подключения' },
  { id: 'kafka',   icon: 'kafka',    label: 'Kafka — топики, группы, live-tail' },
  { id: 'storage', icon: 'cloud',    label: 'Внешние хранилища — S3, бакеты, объекты' },
  { id: 'rh',      icon: 'globe',    label: 'Удалённые хосты — SSH-сессии' },
  { id: 'notes',   icon: 'note',     label: 'Задачи — заметки проекта' },
  { id: 'audit',   icon: 'grid',     label: 'Аудит — анализ проекта' },
  { id: 'company', icon: 'users',    label: 'ИИ компания — команда агентов над проектом' },
  { id: 'iterflow', icon: 'layers',  label: 'IterFlow — задачи итераций (трекер)' },
  { id: 'jira',    icon: 'jira',     label: 'Jira — свои задачи из нескольких аккаунтов' },
  { id: 'seo',     icon: 'globe',    label: 'WEB/SEO аудит — анализ сайта' },
  { id: 'tools',   icon: 'wrench',   label: 'Инструменты — base64, JSON/YAML, хэши, regex…' },
  { id: 'chat',    icon: 'chat',     label: 'OpenRouter — чат по своим API-ключам' },
  { id: 'doc',     icon: 'note',     label: 'Обработка текста — документы + AI-правки' },
  { id: 'pomodoro', icon: 'clock',   label: 'Помодоро — таймер работы/отдыха с блокировкой' },
  { id: 'voice',   icon: 'volume',   label: 'Озвучка — читать скопированный текст голосом' },
  { id: 'scratch', icon: 'terminal', label: 'Системный терминал (вне проектов)' },
];
function quickAllModules() {
  const all = QUICK_BUILTIN.map((m) => ({ ...m, open: () => openModule(m.id) }));
  for (const m of Ext.list()) if (m.ok)
    all.push({ id: 'ext:' + m.id, icon: 'layers', label: m.name, open: () => Ext.quickOpen(m.id) });
  return all;
}
function renderQuickbar() {
  const bar = $('#quickbar');
  if (!bar) return;
  const all = new Map(quickAllModules().map((m) => [m.id, m]));
  bar.innerHTML = '';
  let shown = 0;
  for (const id of (Array.isArray(STORE.quickbar) ? STORE.quickbar : [])) {
    if (id === QUICK_SEP) { bar.appendChild(el('span', 'qb-sep')); continue; } // вертикальный разделитель
    const m = all.get(id);
    if (!m) continue; // модуль пропал (удалён пользовательский) — кнопку не рисуем, выбор в сторе не трогаем
    const b = el('button', 'icon-btn qb-btn');
    b.title = m.label;
    b.dataset.mod = id;
    b.appendChild(icon(m.icon, 16));
    if (id === 'notes') b.appendChild(el('span', 'qb-badge')); // бейдж активных задач активного проекта
    if (id === 'pomodoro') b.appendChild(el('span', 'qb-badge qb-badge-pomo')); // бейдж остатка времени помодоро
    b.onclick = m.open;
    bar.appendChild(b);
    shown++;
  }
  const wasHidden = bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !shown); // только разделители (без кнопок) панель не показывают
  if (wasHidden !== !shown) setTimeout(refitActiveTerminal, 60); // высота терминала изменилась
  updateNotesBadge();
  updatePomoUI(pomoLast); // перерисовали квикбар — восстановить бейдж остатка помодоро
  markOpenModules();      // восстановить подсветку открытых окон-модулей (идея 3)
}
// Подсветка кнопок квикбара тех модулей, чьи окна сейчас открыты (main шлёт module:openSet).
// Раньше событие рассылалось, но его никто не слушал (мёртвый мост onOpenSet) — теперь видно,
// что открыто, не переключаясь по окнам.
let openModuleIds = new Set();
function markOpenModules() {
  document.querySelectorAll('#quickbar .qb-btn').forEach((b) => {
    b.classList.toggle('open', openModuleIds.has(b.dataset.mod));
  });
}
// Бейдж активных (не выполненных) задач АКТИВНОГО проекта на кнопке «Задачи» квикбара. Источник —
// STORE.noteCounts (стартовый снимок в main.js + живые апдейты через refreshNotesCount по app:notesChanged).
function updateNotesBadge() {
  const b = document.querySelector('#quickbar .qb-btn[data-mod="notes"] .qb-badge');
  if (!b) return;
  const tasks = (activeId && STORE.noteCounts) ? (STORE.noteCounts[activeId] || 0) : 0;
  // напоминания «требует внимания» (просрочено+сегодня) считаем и для проекта, и для «Личных» (__global__)
  const agP = (activeId && STORE.agendaCounts) ? (STORE.agendaCounts[activeId] || 0) : 0;
  const agG = STORE.agendaCounts ? (STORE.agendaCounts['__global__'] || 0) : 0;
  const n = tasks + agP + agG;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('show', n > 0);
}
// Список задач изменился (окно «Задачи») → пересчитать счётчик этого списка с диска и освежить бейдж.
async function refreshNotesCount(id) {
  if (!id) return;
  try {
    const arr = await lite.store.notesGet(id);
    const n = Array.isArray(arr) ? arr.filter((x) => x && x.status !== 'done').length : 0;
    if (!STORE.noteCounts) STORE.noteCounts = {};
    STORE.noteCounts[id] = n;
    if (id === activeId) updateNotesBadge();
  } catch (_) {}
}
// Напоминания изменились (Календарь / MCP-сервер) → пересчитать «требует внимания» этого источника, освежить бейдж.
async function refreshAgendaCount(id) {
  if (!id) return;
  try {
    const arr = await lite.store.agendaGet(id);
    const eod = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() + 86400000; })();
    const n = Array.isArray(arr) ? arr.filter((r) => r && !r.done && r.at && !isNaN(new Date(r.at)) && new Date(r.at).getTime() < eod).length : 0;
    if (!STORE.agendaCounts) STORE.agendaCounts = {};
    STORE.agendaCounts[id] = n;
    if (id === activeId || id === '__global__') updateNotesBadge();
  } catch (_) {}
}
// Настройка быстрой панели: «На панели» (порядок стрелками, убрать, разделители) и «Добавить».
// Операции по ИНДЕКСУ: разделителей может быть несколько — двигать/удалять по значению нельзя.
function showPanelSetup() {
  closeMenus();
  const { m, close } = makeModal(`
    <div class="mhead"><div><div class="mt">Быстрая панель</div><div class="ms">Иконки модулей под терминалом: состав, порядок, разделители</div></div><span class="grow"></span><button class="icon-btn" id="qb-x" title="Закрыть" aria-label="Закрыть"></button></div>
    <div class="qb-list" id="qb-list"></div>
    <div class="modal-actions"><button class="btn" id="qb-sep"></button><span class="grow"></span><button class="btn primary" id="qb-ok">Готово</button></div>`);
  m.classList.add('qb-modal');
  m.querySelector('#qb-x').appendChild(icon('x', 16));
  m.querySelector('#qb-x').onclick = close;
  m.querySelector('#qb-ok').onclick = close;
  { const s = m.querySelector('#qb-sep'); s.append(icon('plus', 14), el('span', null, 'Разделитель')); }
  const box = m.querySelector('#qb-list');
  const save = (ids) => { persist('quickbar', ids); renderQuickbar(); };
  const gt = (glyph, title, fn, disabled) => { const b = iconBtn('gt', glyph, title, 13); b.disabled = !!disabled; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  // подписи — из каталога встроенных модулей (название и описание раздельно); свои модули — по имени
  const names = (mod) => { const b = BUILTIN_MODS.find((x) => x.id === mod.id); return b ? [b.title, b.desc] : [mod.label, 'мой модуль']; };
  const render = () => {
    const mods = quickAllModules();
    const byId = new Map(mods.map((x) => [x.id, x]));
    // Показываем только известные модули, а правим ПОЛНЫЙ список из стора через их позиции (at):
    // id модуля, которого сейчас нет (свой модуль сломан или ещё не догрузился после скана), в списке
    // не виден, но и не должен выпадать из стора от перестановки соседей — как в renderQuickbar.
    const stored = Array.isArray(STORE.quickbar) ? STORE.quickbar : [];
    const at = [];
    stored.forEach((id, j) => { if (id === QUICK_SEP || byId.has(id)) at.push(j); });
    const sel = at.map((j) => stored[j]);
    box.replaceChildren();
    const h1 = el('div', 'qb-sec'); h1.append(el('b', null, 'На панели'), el('span', null, String(sel.filter((x) => x !== QUICK_SEP).length)));
    box.appendChild(h1);
    if (!sel.length) box.appendChild(el('div', 'pinfo', 'Пусто — панель скрыта. Добавьте модули ниже.'));
    sel.forEach((id, i) => {
      const row = el('div', 'qrow');
      if (id === QUICK_SEP) row.append(el('span', 'qsep-l'), el('span', 'qt dim2', 'разделитель'));
      else { const mod = byId.get(id); const ri = el('span', 'ri'); ri.appendChild(icon(mod.icon, 16)); row.append(ri, el('span', 'qt', names(mod)[0])); }
      const move = (d) => { const ids = stored.slice(), a = at[i], b = at[i + d]; [ids[a], ids[b]] = [ids[b], ids[a]]; save(ids); render(); };
      row.append(
        gt('chevron-up', 'Левее на панели', () => move(-1), i === 0),
        gt('chevron-down', 'Правее на панели', () => move(1), i === sel.length - 1),
        gt('x', 'Убрать с панели', () => { const ids = stored.slice(); ids.splice(at[i], 1); save(ids); render(); }),
      );
      box.appendChild(row);
    });
    const free = mods.filter((x) => !sel.includes(x.id));
    if (free.length) box.appendChild(el('div', 'qb-sec', 'Добавить'));
    for (const mod of free) {
      const row = el('div', 'qrow add');
      const ri = el('span', 'ri'); ri.appendChild(icon(mod.icon, 16));
      const [name, desc] = names(mod);
      row.append(ri, el('span', 'qt', name), el('span', 'qd', desc));
      const plus = el('span', 'gt'); plus.appendChild(icon('plus', 13));
      row.appendChild(plus);
      row.onclick = () => { save([...stored, mod.id]); render(); };
      box.appendChild(row);
    }
  };
  m.querySelector('#qb-sep').onclick = () => { const ids = (Array.isArray(STORE.quickbar) ? STORE.quickbar : []).slice(); ids.push(QUICK_SEP); save(ids); render(); };
  render();
}
renderQuickbar(); // стартовая отрисовка (пользовательские модули доедут через modsChanged после скана)

// ---------------------------------------------------------------- Git module (right pane)
// Вынесен в renderer/modules/git.js (const Git выше, у реестра панелей).

// ================================================================ Containers module (docker/podman)
// Вынесен в renderer/modules/containers.js (const Containers — у реестра панелей).

// ================================================================ Database module (Postgres/MySQL/SQLite)
// Вынесен в renderer/modules/db.js (const Db — у реестра панелей).

// ---------------------------------------------------------------- file tree → модуль files.js
// Дерево файлов (renderTree/buildDir/dnd/контекст-меню/файловые операции) вынесено в
// renderer/modules/files.js (initFiles) вместе с вивером. Ядро его не трогает напрямую.

// ---------------------------------------------------------------- gutters (resize)
function initGutters() {
  document.querySelectorAll('.gutter').forEach((g) => {
    const target = g.dataset.resize;
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = layout[target];
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let w = target === 'sidebar' ? startW + dx : startW - dx;
        layout[target] = Math.max(150, Math.min(1000, w));
        applyLayout();
        refitActiveTerminal();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        saveLayout();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---------------------------------------------------------------- оболочка: боковая карточка и нижняя полоса
// Кнопки, которые живут в index.html постоянно (не перерисовываются): навигация и подвал боковой
// карточки, чипы активного проекта, «+» быстрой панели, плашка кнопок терминала, пустой экран.
let matrixCtl = null;   // заставка «матрица»: собирается в init(), запускается и из «Ещё»/настроек
function startMatrix() { if (matrixCtl) matrixCtl.start(); }
function initShell() {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e.currentTarget); };
  $('#nav-modules').addEventListener('click', () => showModulesCatalog());
  $('#nav-more').addEventListener('click', stop((b) => showMoreMenu(b)));
  $('#app-ver').addEventListener('click', () => showAbout());
  $('#btn-github').addEventListener('click', openRepo);
  $('#btn-look').addEventListener('click', stop((b) => showLookPanel(b)));
  $('#btn-settings').addEventListener('click', () => showSettings());
  $('#chip-folder').addEventListener('click', stop((b) => showFolderMenu(b)));
  $('#chip-branch').addEventListener('click', stop((b) => showBranchMenu(b)));
  $('#chip-sync').addEventListener('click', () => { const p = activeProject(); if (p) showSyncDialog(p); });
  $('#qb-more').addEventListener('click', () => showModulesCatalog());
  const tl = $('#term-timeline');
  const markTl = () => { const on = settings.termTimeline === true; tl.classList.toggle('on', on); tl.title = on ? 'Скрыть шкалу времени' : 'Шкала времени слева'; };
  markTl();
  tl.addEventListener('click', () => { settings.termTimeline = settings.termTimeline !== true; saveSettings(); applyTimeline(); markTl(); });
  $('#term-find').addEventListener('click', () => openTermSearch());
  $('#empty-open').addEventListener('click', () => openProjectDialog());
}

// ---------------------------------------------------------------- window controls
function initWindowControls() {
  $('#win-min').onclick = () => lite.win.minimize();
  $('#win-max').onclick = () => lite.win.maximizeToggle();
  $('#win-close').onclick = () => lite.win.close(); // fullscreen — по F11 (кнопку убрали, стандартные 3 кнопки)
  lite.win.onMaximizeChange((v) => $('#app').classList.toggle('is-max', !!v));
  lite.win.isMaximized().then((v) => $('#app').classList.toggle('is-max', !!v));
  // двойной клик по пустому месту шапки или бренда — развернуть/свернуть окно, как по заголовку
  for (const sel of ['#term-header', '.side-brand']) {
    $(sel).addEventListener('dblclick', (e) => {
      if (e.target.closest('button, .tab, .win-tools')) return;
      lite.win.maximizeToggle();
    });
  }
}

// ---------------------------------------------------------------- menu
// Меню верхней строки больше нет: «Ещё» (выезжает вбок от боковой карточки), «Модули» (каталог плитками),
// шестерёнка (настройки) и палитра (оформление) — в боковой карточке. Все выпадашки живут в #menu-layer.
let menuAnchor = null;   // кнопка/строка, от которой открыто меню: подсвечена, повторный клик закрывает
function initMenus() {
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  window.addEventListener('resize', closeMenus);
}
function closeMenus() {
  $('#menu-layer').innerHTML = '';
  if (menuAnchor) { menuAnchor.classList.remove('on', 'menu-open'); menuAnchor = null; }
}
// Открыть меню от кнопки. Второй клик по той же кнопке — закрыть (вернёт false).
function menuFrom(anchor) {
  if (menuAnchor === anchor && $('#menu-layer').firstChild) { closeMenus(); return false; }
  closeMenus();
  menuAnchor = anchor;
  anchor.classList.add('on');
  return true;
}
function placeMenu(dd, x, y) {
  $('#menu-layer').appendChild(dd);
  dd.style.left = x + 'px';
  dd.style.top = y + 'px';
  const r = dd.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) dd.style.left = Math.max(8, window.innerWidth - 8 - r.width) + 'px';
  if (r.bottom > window.innerHeight - 8) dd.style.top = Math.max(8, window.innerHeight - 8 - r.height) + 'px';
}
// Меню над кнопкой нижней полосы: открывается вверх, левым краем по кнопке.
function placeMenuAbove(dd, anchor, alignRight) {
  $('#menu-layer').appendChild(dd);
  const r = anchor.getBoundingClientRect(), w = dd.offsetWidth, h = dd.offsetHeight;
  const x = alignRight ? r.right - w : r.left;
  dd.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  dd.style.top = Math.max(8, r.top - h - 6) + 'px';
}
// Меню под кнопкой шапки (помодоро, бейдж): правым краем по кнопке.
function placeMenuBelow(dd, anchor) {
  $('#menu-layer').appendChild(dd);
  const r = anchor.getBoundingClientRect(), w = dd.offsetWidth;
  dd.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  dd.style.top = (r.bottom + 6) + 'px';
}
// `glyph` is an ICONS name (rendered as SVG); a non-icon string falls back to text; falsy → empty slot.
// opts: kbd — сочетание справа, desc — приглушённая подпись справа, badge — плашка, ext — стрелка «наружу».
function menuRow(glyph, text, onClick, cls, opts = {}) {
  const row = el('div', 'menu-row' + (cls ? ' ' + cls : ''));
  const ic = el('span', 'menu-ic');
  if (glyph && ICONS[glyph]) ic.appendChild(icon(glyph, 16));
  else if (glyph) ic.textContent = glyph;
  row.appendChild(ic); row.appendChild(el('span', null, text));
  if (opts.kbd) row.appendChild(el('span', 'menu-kbd', opts.kbd));
  if (opts.desc) { const d = el('span', 'menu-desc', opts.desc); d.title = opts.desc; row.appendChild(d); }
  if (opts.badge) row.appendChild(el('span', 'menu-badge', opts.badge));
  if (opts.ext) { const e = el('span', 'menu-ext'); e.appendChild(icon('external-link', 13)); row.appendChild(e); }
  if (opts.title) row.title = opts.title;
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
// Двухстрочный пункт: название (1-я строка) + описание (2-я строка, мельче и приглушённо).
function moduleRow(glyph, title, desc, onClick) {
  const row = el('div', 'menu-row menu-row2');
  const ic = el('span', 'menu-ic');
  if (glyph && ICONS[glyph]) ic.appendChild(icon(glyph, 16));
  else if (glyph) ic.textContent = glyph;
  const txt = el('div', 'mr2-text');
  txt.appendChild(el('span', 'mr2-title', title));
  if (desc) txt.appendChild(el('span', 'mr2-desc', desc));
  row.append(ic, txt);
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
// Back up the whole editor state to one JSON file, then offer to open its folder.
async function exportSettings() {
  closeMenus();
  const r = await lite.settings.export();
  if (!r || r.canceled) return;
  if (r.error) { toast('Ошибка экспорта: ' + r.error); return; }
  toast('Настройки экспортированы', { actionLabel: 'Открыть папку', action: () => lite.openInFileManager(r.dir), ttl: 8000 });
}
// Restore from a backup. Overwrites the current state, so confirm first; reload to apply.
async function importSettings() {
  closeMenus();
  showConfirm(
    'Импорт настроек',
    'Импорт перезапишет текущие настройки, проекты, категории и заметки данными из файла. Открытые терминалы не затрагиваются. Продолжить?',
    'Импортировать',
    async () => {
      const r = await lite.settings.import();
      if (!r || r.canceled) return;
      if (r.error) { toast('Ошибка импорта: ' + r.error); return; }
      if (r.partial) {
        const parts = [];
        if (r.failedKeys && r.failedKeys.length) parts.push(`настройки: ${r.failedKeys.join(', ')}`);
        if (r.failedNotes) parts.push(`заметок: ${r.failedNotes}`);
        toast('Импорт частичный — не записано: ' + parts.join('; ') + '. Перезагружаю…', { ttl: 9000 });
      } else {
        toast('Настройки импортированы — перезагружаю…');
      }
      setTimeout(() => location.reload(), r.partial ? 1500 : 700);
    });
}
const REPO_URL = 'https://github.com/DanielLetto2020/LiteEditorAI';
function openRepo() { lite.openExternal(REPO_URL); }

// «Ещё» — всё меню редактора, которого нет в боковой карточке: выезжает вбок от карточки, три колонки
// (Файл · Ранее открытые · Мои модули | Вид и инструменты · Справка | все встроенные модули).
function showMoreMenu(anchor) {
  if (!menuFrom(anchor)) return;
  const dd = el('div', 'menu-dropdown more-fly');
  dd.addEventListener('click', (e) => e.stopPropagation());
  const grid = el('div', 'fly-grid');
  const c0 = el('div', 'fly-sec'), c1 = el('div', 'fly-sec'), c2 = el('div', 'fly-sec mods');
  grid.append(c0, c1, c2);
  dd.appendChild(grid);
  const T = (col, text) => col.appendChild(el('div', 'fly-t', text));
  const go = (fn) => () => { closeMenus(); fn(); };

  T(c0, 'Файл');
  c0.appendChild(menuRow('folder', 'Открыть папку…', go(openProjectDialog)));
  c0.appendChild(menuRow('folder-plus', 'Создать папку…', go(showCreateFolder)));
  c0.appendChild(menuRow('plus', 'Новая категория…', go(() => showCreateCategory(null))));
  c0.appendChild(menuRow('download', 'Экспорт настроек…', exportSettings));
  c0.appendChild(menuRow('upload', 'Импорт настроек…', importSettings));
  c0.appendChild(menuRow('clipboard', 'Логи…', go(showLogs)));
  T(c0, 'Ранее открытые');
  const recents = loadRecents();
  if (!recents.length) c0.appendChild(menuRow(null, '— пусто —', null, 'disabled'));
  else {
    const list = el('div', 'recents');
    for (const r of recents.slice(0, 8)) {
      const row = menuRow(null, r.name, go(() => openByPath(r.path, r.name)), 'recent', { desc: shortPath(r.path) });
      row.title = r.path;
      list.appendChild(row);
    }
    c0.appendChild(list);
    c0.appendChild(menuRow('trash', 'Очистить список', () => { persist('recents', []); closeMenus(); }, 'muted'));
  }
  T(c0, 'Мои модули');
  Ext.buildMenuSection(c0, { bare: true, compact: true });

  T(c1, 'Вид и инструменты');
  c1.appendChild(menuRow('panel-left', 'Один терминал', go(toggleSingle), '', { kbd: 'Ctrl+\\' }));
  c1.appendChild(menuRow('cmd', 'Палитра команд', go(showPalette), '', { kbd: 'Ctrl+K' }));
  c1.appendChild(menuRow('search', 'Поиск в терминале', go(openTermSearch), '', { kbd: 'Ctrl+F' }));
  c1.appendChild(menuRow('search', 'Найти во всех проектах', go(() => showGlobalSearch())));
  c1.appendChild(menuRow('sliders', 'Быстрая панель…', go(showPanelSetup)));
  c1.appendChild(menuRow('palette', 'Оформление…', () => { closeMenus(); showLookPanel($('#app').classList.contains('single') ? $('#rail-look') : $('#btn-look')); }));
  c1.appendChild(menuRow('sparkles', 'Заставка «матрица»', go(() => startMatrix())));
  T(c1, 'Справка');
  if (updateInfo && updateInfo.newer) c1.appendChild(menuRow('download', `Обновить до ${updateInfo.tag || 'новой версии'}`, go(updateNow), '', { badge: 'новая' }));
  else c1.appendChild(menuRow('refresh', 'Проверить обновления', go(() => checkForUpdate({ manual: true }))));
  c1.appendChild(menuRow('github', 'Репозиторий на GitHub', go(openRepo), '', { ext: true }));
  c1.appendChild(menuRow('info', 'О программе', go(showAbout)));
  c1.appendChild(menuRow('play', 'Приветствие', go(showOnboarding)));
  c1.appendChild(el('div', 'menu-sep'));
  c1.appendChild(menuRow('gear', 'Настройки…', go(() => showSettings())));

  // все встроенные модули — двумя столбиками, чтобы меню не вырастало во весь экран
  const mg = el('div', 'fly-mgrid');
  c2.appendChild(mg);
  const modRow = (mod) => {
    const open = openModuleIds.has(mod.id);
    const row = menuRow(mod.icon, mod.title, go(() => openModule(mod.id)), open ? 'mopen' : '');
    row.title = mod.desc;
    mg.appendChild(row);
  };
  mg.appendChild(el('div', 'fly-t span', 'Модули · для проекта'));
  BUILTIN_MODS.filter((x) => x.project).forEach(modRow);
  mg.appendChild(el('div', 'fly-t span', 'Модули · самостоятельные'));
  BUILTIN_MODS.filter((x) => !x.project).forEach(modRow);
  const all = menuRow('grid', 'Все модули плитками…', go(() => showModulesCatalog()));
  all.classList.add('span');
  mg.appendChild(all);

  // выезжает вбок от боковой карточки (или от рельса в режиме «один терминал»), верхом по кнопке
  $('#menu-layer').appendChild(dd);
  const side = $('#sidebar').getBoundingClientRect(), ar = anchor.getBoundingClientRect();
  const w = dd.offsetWidth, h = dd.offsetHeight;
  dd.style.left = Math.max(8, Math.min(side.right + 8, window.innerWidth - w - 8)) + 'px';
  dd.style.top = Math.max(8, Math.min(ar.top - 8, window.innerHeight - h - 8)) + 'px';
}

// Каталог встроенных модулей для модалки «Встроенные»: project:true — окно следует за активным
// проектом редактора (см. MODULES в module-entry.js), остальные — самостоятельные.
const BUILTIN_MODS = [
  { id: 'files',    icon: 'eye',      title: 'Проект',             desc: 'вивер кода, дерево, Git', project: true },
  { id: 'ctx',      icon: 'graph',    title: 'Контекст',           desc: 'граф контекста агента', project: true },
  { id: 'notes',    icon: 'note',     title: 'Задачи',             desc: 'заметки проекта и общие', project: true },
  { id: 'audit',    icon: 'grid',     title: 'Аудит',              desc: 'типы файлов, крупные файлы, медиа', project: true },
  { id: 'company',  icon: 'users',    title: 'ИИ компания',        desc: 'директор + сабагенты над проектом', project: true },
  { id: 'doc',      icon: 'note',     title: 'Обработка текста',   desc: 'документы + AI-правки фрагментов', project: true },
  { id: 'docker',   icon: 'box',      title: 'Контейнеры',         desc: 'Docker / Podman' },
  { id: 'db',       icon: 'database', title: 'Базы данных',        desc: 'Postgres · MySQL · SQLite' },
  { id: 'rmq',      icon: 'rabbit',   title: 'RabbitMQ',           desc: 'очереди · сообщения · подключения' },
  { id: 'kafka',    icon: 'kafka',    title: 'Kafka',              desc: 'топики · группы · live-tail' },
  { id: 'storage',  icon: 'cloud',    title: 'Внешние хранилища',  desc: 'S3 · бакеты · публичные ссылки', project: true },
  { id: 'rh',       icon: 'globe',    title: 'Удалённые хосты',    desc: 'SSH-сессии к серверам' },
  { id: 'iterflow', icon: 'layers',   title: 'IterFlow',           desc: 'задачи итераций из трекера' },
  { id: 'jira',     icon: 'jira',     title: 'Jira',               desc: 'свои задачи из нескольких аккаунтов' },
  { id: 'seo',      icon: 'globe',    title: 'WEB/SEO аудит',      desc: 'сайт: безопасность, SEO, сеть' },
  { id: 'tools',    icon: 'wrench',   title: 'Инструменты',        desc: 'base64, JSON/YAML, хэши, JWT, regex, diff' },
  { id: 'chat',     icon: 'chat',     title: 'OpenRouter',         desc: 'чат по своим API-ключам' },
  { id: 'pomodoro', icon: 'clock',    title: 'Помодоро',           desc: 'таймер работы/отдыха с блокировкой' },
  { id: 'voice',    icon: 'volume',   title: 'Озвучка',            desc: 'текст из буфера обмена — живым голосом' },
  { id: 'scratch',  icon: 'terminal', title: 'Системный терминал', desc: 'шелл вне проектов' },
  { id: 'monitor',  icon: 'graph',    title: 'Монитор ресурсов',   desc: 'память/CPU редактора и агентов' },
  { id: 'keepass',  icon: 'key',      title: 'Сейф паролей',       desc: 'KeePass .kdbx: пароли и токены' },
  { id: 'sitemon',  icon: 'globe',    title: 'Мониторинг сайтов',  desc: 'доступность сайтов + уведомления' },
];
// Каталог модулей («Модули» в боковой карточке): плитки с живым поиском и вкладками
// «Все · Для проекта · Самостоятельные · Мои модули». На плитке — «на быструю панель» и «открывать при запуске».
// Стрелки выбирают плитку, Enter открывает. Открытие — тот же openModule, что у квикбара и меню.
function showModulesCatalog(start = 'all') {
  closeMenus();
  const { m, close } = makeModal(`
    <div class="mhead"><div><div class="mt">Модули</div><div class="ms">Каждый встроенный модуль открывается своим окном; свои модули — панелью справа</div></div><span class="grow"></span><button class="icon-btn" id="mc-x" title="Закрыть" aria-label="Закрыть"></button></div>
    <div class="msearch"><span class="mc-sic"></span><input type="text" id="mc-q" placeholder="Поиск модуля…" autocomplete="off" spellcheck="false"></div>
    <div class="mtabs" id="mc-tabs"></div>
    <div class="bim-body" id="mc-body"></div>
    <div class="mhint"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> выбор</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span></div>`);
  m.classList.add('bim-modal');
  m.querySelector('#mc-x').appendChild(icon('x', 16));
  m.querySelector('#mc-x').onclick = close;
  m.querySelector('.mc-sic').appendChild(icon('search', 16));
  const q = m.querySelector('#mc-q'), tabsBox = m.querySelector('#mc-tabs'), body = m.querySelector('#mc-body');
  let tab = start, hl = 0, tiles = [];
  const quick = () => (Array.isArray(STORE.quickbar) ? STORE.quickbar : []);
  const userMods = () => Ext.list().filter((x) => x.ok).map((x) => ({ id: 'ext:' + x.id, extId: x.id, icon: 'layers', title: x.name, desc: 'мой модуль · панель справа', user: true }));
  const TABS = [
    ['all', 'Все', () => BUILTIN_MODS.length + userMods().length],
    ['project', 'Для проекта', () => BUILTIN_MODS.filter((x) => x.project).length],
    ['self', 'Самостоятельные', () => BUILTIN_MODS.filter((x) => !x.project).length],
    ['mine', 'Мои модули', () => userMods().length],
  ];
  const drawTabs = () => {
    tabsBox.replaceChildren();
    for (const [key, label, count] of TABS) {
      const b = el('button', 'mtab' + (tab === key ? ' on' : ''));
      b.append(el('span', null, label), el('span', 'n', String(count())));
      b.onclick = () => { tab = key; hl = 0; drawTabs(); draw(); q.focus(); };
      tabsBox.appendChild(b);
    }
    tabsBox.appendChild(el('span', 'grow'));
    const setup = el('button', 'btn sm');
    setup.append(icon('sliders', 14), el('span', null, 'Быстрая панель…'));
    setup.onclick = () => { close(); showPanelSetup(); };
    tabsBox.appendChild(setup);
  };
  const toggleQuick = (id) => {
    const cur = quick().slice();
    const i = cur.indexOf(id);
    if (i >= 0) cur.splice(i, 1); else cur.push(id);
    persist('quickbar', cur); renderQuickbar();
  };
  const toggleAuto = (id) => {
    const cur = new Set(settings.autoLaunchMods || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    settings.autoLaunchMods = [...cur]; saveSettings();
  };
  const openMod = (mod) => { close(); if (mod.user) Ext.quickOpen(mod.extId); else openModule(mod.id); };
  const tile = (mod) => {
    const t = el('button', 'bim-tile');
    t.type = 'button';
    const chip = el('span', 'bim-chip'); chip.appendChild(icon(mod.icon, 18));
    t.append(chip, el('span', 'bim-title', mod.title), el('span', 'bim-desc', mod.desc));
    if (openModuleIds.has(mod.id)) t.appendChild(el('span', 'bim-tag', 'окно открыто'));
    const btns = el('span', 'bim-btns');
    const pin = iconBtn('bim-x' + (quick().includes(mod.id) ? ' on' : ''), 'pin', quick().includes(mod.id) ? 'Убрать с быстрой панели' : 'На быструю панель', 14);
    pin.onclick = (e) => { e.stopPropagation(); toggleQuick(mod.id); draw(); };
    btns.appendChild(pin);
    if (!mod.user) {
      const auto = (settings.autoLaunchMods || []).includes(mod.id);
      const a = iconBtn('bim-x' + (auto ? ' on' : ''), 'power', auto ? 'Не открывать при запуске' : 'Открывать при запуске редактора', 14);
      a.onclick = (e) => { e.stopPropagation(); toggleAuto(mod.id); draw(); };
      btns.appendChild(a);
    }
    t.appendChild(btns);
    t.title = mod.title + ' — ' + mod.desc;
    t.addEventListener('click', () => openMod(mod));
    return t;
  };
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    // ищем и по исходной строке, и по переводу: в интерфейсе названия уже на выбранном языке
    const hit = (x) => !needle || [x.title, x.desc, tt(x.title), tt(x.desc)].join(' ').toLowerCase().includes(needle);
    const groups = [];
    if (tab === 'all' || tab === 'project') groups.push(['Следуют за проектом', 'окно привязано к активному проекту редактора', BUILTIN_MODS.filter((x) => x.project && hit(x))]);
    if (tab === 'all' || tab === 'self') groups.push(['Самостоятельные', 'не зависят от открытых проектов', BUILTIN_MODS.filter((x) => !x.project && hit(x))]);
    if (tab === 'all' || tab === 'mine') groups.push(['Мои модули', 'пользовательские плагины из папки модулей', userMods().filter(hit)]);
    body.replaceChildren();
    tiles = [];
    for (const [label, hint, mods] of groups) {
      if (!mods.length && !(tab === 'mine' && label === 'Мои модули')) continue;
      const st = el('div', 'bim-sec-title');
      st.append(el('b', null, label), el('span', null, hint));
      const grid = el('div', 'bim-grid');
      for (const mod of mods) { const t = tile(mod); tiles.push({ el: t, mod }); grid.appendChild(t); }
      if (label === 'Мои модули' && !needle) {
        const nw = el('button', 'bim-tile new');
        const chip = el('span', 'bim-chip'); chip.appendChild(icon('plus', 18));
        nw.append(chip, el('span', 'bim-title', 'Создать модуль'), el('span', 'bim-desc', 'мастер с заготовкой и подсказками для агента'));
        nw.onclick = () => { close(); Ext.openWizard(); };
        grid.appendChild(nw);
      }
      body.append(st, grid);
    }
    if (!tiles.length && !(tab === 'mine' && !needle)) body.appendChild(el('div', 'bim-empty', 'Ничего не найдено'));
    hl = Math.max(0, Math.min(hl, tiles.length - 1));
    tiles.forEach((x, i) => x.el.classList.toggle('hl', i === hl));
  };
  const cols = () => { const g = body.querySelector('.bim-grid'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 4; };
  q.addEventListener('input', () => { hl = 0; draw(); });
  q.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() }[e.key];
    if (step) { e.preventDefault(); hl = Math.max(0, Math.min(tiles.length - 1, hl + step)); tiles.forEach((x, i) => x.el.classList.toggle('hl', i === hl)); if (tiles[hl]) tiles[hl].el.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); if (tiles[hl]) openMod(tiles[hl].mod); }
  });
  drawTabs(); draw();
  setTimeout(() => q.focus(), 30);
}

// ---------------------------------------------------------------- оформление (цвета и размеры)
// Тема одна — «Графит»; палитру пользователь настраивает сам. Хранится в settings.look (общая с окнами
// модулей), ширина боковой карточки — в layout.sidebar, шрифт терминала — settings.fontSize.
// Правка применяется сразу; запись и рассылка окнам модулей — с задержкой, чтобы ползунок не гонял IPC.
const LOOK_ACCENTS = ['#3ecf8e', '#5b9cff', '#3dc8dc', '#a98cf0', '#e06fae', '#e0af68', '#d97757'];
let lookSaveT = null;
// Свои таймеры у ширины панели и шрифта: общий с lookSaveT отменял бы чужую отложенную запись
// (сдвинули цвет, а через 200 мс ширину — палитра не сохранялась и не уезжала в окна модулей).
let lookLayoutT = null, lookFontT = null;
function lookLive() {
  applyLook(settings);
  for (const rec of terms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  for (const rec of extTerms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  clearTimeout(lookSaveT);
  lookSaveT = setTimeout(() => { saveSettings(); applyTheme(); }, 250);
}
function editLook(fn) {
  const l = lookOf(settings);
  const cur = { accent: l.accent, r: l.r, row: l.row, alpha: l.alpha, base: { ...l.base }, status: { ...l.status }, over: { ...l.over } };
  fn(cur);
  settings.look = cur;
  lookLive();
}
function showLookPanel(anchor) {
  if (!anchor || !menuFrom(anchor)) return;
  const dd = el('div', 'menu-dropdown look-pop');
  dd.addEventListener('click', (e) => e.stopPropagation());
  dd.addEventListener('mousedown', (e) => e.stopPropagation());
  let advOpen = false;
  const HEX = /^#[0-9a-f]{6}$/i;
  const crow = (grp, key, label, value, auto) => {
    const row = el('div', 'crow'); row.dataset.row = grp + ':' + key;
    const cl = el('span', 'cl', label);
    if (auto) cl.appendChild(el('small', null, 'авто'));
    const sw = el('label', 'csw'); sw.style.background = value;
    const ci = el('input'); ci.type = 'color'; ci.value = value; ci.dataset.grp = grp; ci.dataset.tok = key; ci.setAttribute('aria-label', label);
    sw.appendChild(ci);
    const hx = el('input', 'chex' + (auto ? ' auto' : '')); hx.value = value; hx.maxLength = 7; hx.spellcheck = false; hx.dataset.grp = grp; hx.dataset.hex = key;
    hx.setAttribute('aria-label', label);
    row.append(cl, sw, hx);
    return row;
  };
  const setColor = (grp, key, v) => editLook((l) => {
    if (grp === 'base') l.base[key] = v;
    else if (grp === 'status') l.status[key] = v;
    else if (grp === 'over') l.over[key] = v;
    else l.accent = v;
  });
  // обновить значения на месте, не пересобирая панель (иначе закроется системный выбор цвета)
  const refresh = () => {
    const l = lookOf(settings), tok = lookTokens(l);
    dd.querySelectorAll('.crow').forEach((r) => {
      const [grp, k] = r.dataset.row.split(':');
      const v = grp === 'base' ? l.base[k] : grp === 'status' ? l.status[k] : tok[k];
      const sw = r.querySelector('.csw'), ci = r.querySelector('input[type=color]'), hx = r.querySelector('.chex');
      if (!HEX.test(v)) return;
      sw.style.background = v;
      if (ci.value !== v) ci.value = v;
      if (document.activeElement !== hx) hx.value = v;
    });
    dd.querySelectorAll('.lk-sw').forEach((b) => b.classList.toggle('on', b.dataset.acc === l.accent));
  };
  const RANGES = [
    ['alpha', 'Непрозрачность фона', 60, 100, 1, '%', () => lookOf(settings).alpha, (v) => editLook((l) => { l.alpha = v; })],
    ['r', 'Скругление', 4, 22, 1, 'px', () => lookOf(settings).r, (v) => editLook((l) => { l.r = v; })],
    ['side', 'Ширина панели', 240, 440, 2, 'px', () => layout.sidebar, (v) => { layout.sidebar = v; applyLayout(); refitActiveTerminal(); clearTimeout(lookLayoutT); lookLayoutT = setTimeout(saveLayout, 250); }],
    ['row', 'Строка проекта', 28, 42, 1, 'px', () => lookOf(settings).row, (v) => editLook((l) => { l.row = v; })],
    ['font', 'Шрифт терминала', 9, 24, 1, 'px', () => settings.fontSize, (v) => { settings.fontSize = v; applyFontSize(); clearTimeout(lookFontT); lookFontT = setTimeout(saveSettings, 250); }],
  ];
  const draw = () => {
    const l = lookOf(settings), tok = lookTokens(l);
    dd.replaceChildren();
    const h = el('div', 'look-h');
    h.appendChild(el('b', null, 'Оформление'));
    const reset = el('button', 'lk-link', 'Сбросить');
    reset.onclick = () => {
      delete settings.look; settings.fontSize = DEFAULT_SETTINGS.fontSize; applyFontSize();
      layout.sidebar = DEFAULT_LAYOUT.sidebar; applyLayout(); saveLayout(); refitActiveTerminal();
      lookLive(); draw(); toast('Оформление сброшено к «Графиту»');
    };
    const x = iconBtn('icon-btn', 'x', 'Закрыть', 15); x.onclick = closeMenus;
    h.append(reset, x);
    dd.appendChild(h);
    // акцент
    const s1 = el('div', 'look-s'); s1.appendChild(el('div', 'look-t', 'Акцент'));
    const acc = el('div', 'lk-acc');
    for (const c of LOOK_ACCENTS) {
      const b = el('button', 'lk-sw' + (l.accent === c ? ' on' : '')); b.dataset.acc = c; b.style.background = c; b.title = c;
      b.onclick = () => { setColor('accent', 'accent', c); refresh(); };
      acc.appendChild(b);
    }
    const own = el('label', 'csw'); own.style.background = l.accent; own.title = 'Свой цвет';
    const oi = el('input'); oi.type = 'color'; oi.value = l.accent; oi.dataset.grp = 'accent'; oi.dataset.tok = 'accent';
    own.appendChild(oi); acc.appendChild(own);
    s1.appendChild(acc); dd.appendChild(s1);
    // основные цвета и состояния
    const s2 = el('div', 'look-s'); s2.appendChild(el('div', 'look-t', 'Основные цвета'));
    for (const [k, n] of Object.entries(LOOK_BASE_NAMES)) s2.appendChild(crow('base', k, n, l.base[k]));
    dd.appendChild(s2);
    const s3 = el('div', 'look-s'); s3.appendChild(el('div', 'look-t', 'Состояния'));
    for (const [k, n] of Object.entries(LOOK_STATUS_NAMES)) s3.appendChild(crow('status', k, n, l.status[k]));
    dd.appendChild(s3);
    // форма и размеры
    const s4 = el('div', 'look-s'); s4.appendChild(el('div', 'look-t', 'Форма и размеры'));
    for (const [, n, a, b, step, unit, get, set] of RANGES) {
      const row = el('div', 'lrng');
      const inp = el('input'); inp.type = 'range'; inp.min = a; inp.max = b; inp.step = step; inp.value = get(); inp.setAttribute('aria-label', n);
      const val = el('span', 'val', get() + unit);
      inp.addEventListener('input', () => { const v = +inp.value; set(v); val.textContent = v + unit; });
      row.append(el('span', null, n), inp, val);
      s4.appendChild(row);
    }
    dd.appendChild(s4);
    // все цвета: выведенные токены, любой можно задать руками («авто» — рассчитан из основных)
    const adv = el('details', 'look-s'); adv.open = advOpen;
    const sum = el('summary', 'look-t');
    sum.append(el('span', null, 'Все цвета'), el('span', null, '· ' + Object.keys(LOOK_TOKEN_NAMES).length));
    const chv = el('span', 'chv'); chv.appendChild(icon('chevron-down', 12)); sum.appendChild(chv);
    adv.appendChild(sum);
    adv.addEventListener('toggle', () => { advOpen = adv.open; });
    for (const [k, n] of Object.entries(LOOK_TOKEN_NAMES)) {
      const ownTok = k in l.over;
      const row = crow('over', k, n, HEX.test(tok[k]) ? tok[k] : '#000000', !ownTok);
      const un = iconBtn('cx' + (ownTok ? '' : ' hid'), 'x', 'Вернуть рассчитанный', 12);
      un.onclick = () => { editLook((ll) => { delete ll.over[k]; }); draw(); };
      row.appendChild(un);
      adv.appendChild(row);
    }
    dd.appendChild(adv);
    // обмен темой: JSON в буфер и обратно
    const f = el('div', 'look-f');
    const cp = el('button', 'btn'); cp.append(icon('copy', 14), el('span', null, 'Скопировать тему'));
    cp.onclick = () => {
      const lk = lookOf(settings);
      lite.copyText(JSON.stringify({ liteTheme: 1, ...lk, side: layout.sidebar, font: settings.fontSize }));
      toast('Тема скопирована — её можно передать и вставить');
    };
    const ps = el('button', 'btn'); ps.append(icon('clipboard', 14), el('span', null, 'Вставить'));
    ps.onclick = async () => {
      let raw = '';
      try { raw = await lite.readClipboard(); } catch (_) {}
      let o = null;
      try { o = JSON.parse(String(raw || '').trim()); } catch (_) {}
      if (!o || typeof o !== 'object' || (!o.base && !o.accent)) { toast('В буфере обмена нет темы — сначала скопируйте её', { kind: 'warn' }); return; }
      settings.look = { accent: o.accent, r: o.r, row: o.row, alpha: o.alpha, base: o.base, status: o.status, over: o.over };
      settings.look = lookOf(settings);                                   // проверка значений: мусор отбрасывается
      if (Number.isFinite(+o.side)) { layout.sidebar = +o.side; applyLayout(); saveLayout(); }
      if (Number.isFinite(+o.font)) { settings.fontSize = Math.max(9, Math.min(24, +o.font)); applyFontSize(); }
      lookLive(); draw(); refitActiveTerminal();
      toast('Тема применена');
    };
    f.append(cp, ps);
    dd.appendChild(f);
  };
  dd.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.tok) { setColor(t.dataset.grp, t.dataset.tok, t.value.toLowerCase()); refresh(); markOwn(t); }
    else if (t.dataset.hex) { const v = t.value.trim(); if (HEX.test(v)) { setColor(t.dataset.grp, t.dataset.hex, v.toLowerCase()); refresh(); markOwn(t); } }
  });
  // токен из «Все цвета» задан руками — снять пометку «авто» и показать крестик сброса
  const markOwn = (t) => {
    if (t.dataset.grp !== 'over') return;
    const r = t.closest('.crow'); if (!r) return;
    const sm = r.querySelector('small'); if (sm) sm.remove();
    r.querySelector('.chex').classList.remove('auto');
    const cx = r.querySelector('.cx'); if (cx) cx.classList.remove('hid');
  };
  draw();
  // выезжает вбок от боковой карточки (рельса), низом по кнопке
  $('#menu-layer').appendChild(dd);
  const side = $('#sidebar').getBoundingClientRect(), ar = anchor.getBoundingClientRect();
  dd.style.left = Math.max(8, Math.min(side.right + 8, window.innerWidth - dd.offsetWidth - 8)) + 'px';
  dd.style.top = 'auto';
  dd.style.bottom = Math.max(8, window.innerHeight - ar.bottom - 4) + 'px';
}

// ---------------------------------------------------------------- нижняя полоса: чипы активного проекта
// Папка (меню: «Проект», проводник, путь) · ветка git с числом изменений (поповер со списком) ·
// синхронизация (только где она есть). Git спрашиваем лениво и с задержкой: на смене проекта, на
// изменениях файлов и при возврате в окно.
let gitChip = { projId: null, repo: false, branch: '', ahead: 0, behind: 0, files: [] };
let gitChipT = null, gitChipSeq = 0;
// Домашний каталог в чипе — «~»: путь короче, а полный — в подсказке и в меню чипа.
function shortPath(p) {
  const s = String(p), home = String(lite.homeDir || '').replace(/[\\/]+$/, '');
  if (home && (s === home || s.startsWith(home + '/') || s.startsWith(home + '\\'))) return '~' + s.slice(home.length);
  return s.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}
function renderChips() {
  const p = activeProject();
  const fb = $('#chip-folder'), bb = $('#chip-branch'), sb = $('#chip-sync');
  if (!fb) return;
  fb.classList.toggle('hidden', !p);
  if (!p) { bb.classList.add('hidden'); sb.classList.add('hidden'); return; }
  fb.replaceChildren(icon('folder', 14), el('span', 'ct', shortPath(p.path)));
  fb.title = p.path;
  fb.setAttribute('data-no-i18n', '');
  const g = gitChip.projId === p.id ? gitChip : null;
  bb.classList.toggle('hidden', !(g && g.repo));
  if (g && g.repo) {
    const n = g.files.length;
    bb.replaceChildren(icon('git', 14), el('span', 'ct', g.branch));
    if (n) bb.appendChild(el('span', 'cn', '· ' + n));
    bb.setAttribute('data-no-i18n', '');
    bb.title = n ? `Git: ветка ${g.branch}, изменено файлов: ${n}` : `Git: ветка ${g.branch}, изменений нет`;
  }
  sb.classList.toggle('hidden', !syncAvailable || missing.has(p.id));
  if (syncAvailable) {
    const on = syncedPaths.has(p.path);
    sb.classList.toggle('off', !on);
    sb.replaceChildren(el('span', 'sdot'), el('span', 'ct', on ? 'Синхронизирован' : 'Без синхронизации'));
    sb.title = on ? 'Синхронизируется с сервером — подробности' : 'Не синхронизируется — нажмите, чтобы подключить';
  }
}
function refreshGitChip(delay = 400) {
  clearTimeout(gitChipT);
  gitChipT = setTimeout(async () => {
    const p = activeProject();
    if (!p || missing.has(p.id)) { gitChip = { projId: p ? p.id : null, repo: false, branch: '', files: [] }; renderChips(); return; }
    const seq = ++gitChipSeq;
    let info, st;
    try { [info, st] = await Promise.all([lite.git.info(p.path), lite.git.status(p.path)]); } catch (_) { info = null; }
    if (seq !== gitChipSeq) return;          // пока ждали, проект сменился — ответ устарел
    if (!info || !info.repo) { gitChip = { projId: p.id, repo: false, branch: '', files: [] }; renderChips(); return; }
    const base = p.path.replace(/[\\/]+$/, '');
    const files = Object.entries((st && st.files) || {}).map(([abs, code]) => ({ abs, code, rel: abs.startsWith(base) ? abs.slice(base.length + 1) : abs }));
    gitChip = { projId: p.id, repo: true, branch: info.branch || 'HEAD', ahead: info.ahead || 0, behind: info.behind || 0, files };
    renderChips();
  }, delay);
}
function showFolderMenu(anchor) {
  const p = activeProject();
  if (!p || !menuFrom(anchor)) return;
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '260px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  const info = el('div', 'pinfo'); info.appendChild(el('code', null, p.path));
  dd.appendChild(info);
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('eye', 'Открыть «Проект»', () => { closeMenus(); openModule('files'); }, '', { desc: 'вивер и дерево' }));
  dd.appendChild(menuRow('folder', 'Открыть в проводнике', () => { closeMenus(); lite.openInFileManager(p.path); }));
  dd.appendChild(menuRow('copy', 'Копировать путь', () => { closeMenus(); lite.copyText(p.path); toast('Путь скопирован'); }));
  dd.appendChild(menuRow('terminal', 'Новая вкладка терминала', () => { closeMenus(); addTab(); }, '', { kbd: 'Ctrl⇧T' }));
  placeMenuAbove(dd, anchor);
}
const GIT_KIND = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '??': '?', '?': '?' };
function showBranchMenu(anchor) {
  const p = activeProject();
  if (!p || !menuFrom(anchor)) return;
  const g = gitChip.projId === p.id ? gitChip : null;
  const dd = el('div', 'menu-dropdown branch-pop');
  dd.addEventListener('click', (e) => e.stopPropagation());
  const lbl = el('div', 'menu-label');
  lbl.append(el('span', null, 'Изменения'), document.createTextNode(' · '), el('span', null, g ? g.branch : '…'));
  lbl.lastChild.setAttribute('data-no-i18n', '');
  if (g && (g.ahead || g.behind)) lbl.appendChild(document.createTextNode(`  ↑${g.ahead} ↓${g.behind}`));
  dd.appendChild(lbl);
  const files = g ? g.files : [];
  if (!files.length) dd.appendChild(el('div', 'pinfo', 'Чисто — изменений нет.'));
  else {
    const list = el('div', 'recents');
    for (const f of files.slice(0, 40)) {
      const row = el('div', 'chg');
      const k = GIT_KIND[f.code] || f.code.slice(0, 1) || '?';
      row.append(el('span', 'k' + (k === 'A' || k === '?' ? ' a' : k === 'D' ? ' d' : ''), k), el('span', 'f', f.rel));
      row.title = f.rel;
      row.setAttribute('data-no-i18n', '');
      row.onclick = () => { closeMenus(); if (k !== 'D') lite.editorBus.openInViewer(f.abs, 0); };
      list.appendChild(row);
    }
    dd.appendChild(list);
    if (files.length > 40) dd.appendChild(el('div', 'pinfo', `и ещё ${files.length - 40}`));
  }
  const btns = el('div', 'pbtns');
  const gitBtn = el('button', 'btn'); gitBtn.append(icon('git', 14), el('span', null, 'Открыть Git'));
  gitBtn.onclick = () => { closeMenus(); openModule('git'); };
  const upd = el('button', 'btn'); upd.append(icon('refresh', 14), el('span', null, 'Обновить'));
  upd.onclick = () => { closeMenus(); refreshGitChip(0); };
  btns.append(gitBtn, upd);
  dd.appendChild(btns);
  placeMenuAbove(dd, anchor);
}

// ---------------------------------------------------------------- шапка: бейдж «ждёт ответа» и помодоро
function showPomoMenu(anchor) {
  const s = pomoLast;
  if (!s || !s.running || !menuFrom(anchor)) return;
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '260px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  const brk = s.phase === 'short' || s.phase === 'long';
  const info = el('div', 'pinfo');
  info.append(el('b', null, (brk ? (s.phase === 'long' ? 'Длинный перерыв' : 'Короткий перерыв') : 'Работа') + ' · ' + fmtRest(s.remaining)));
  if (s.tech && s.tech.name) { info.appendChild(el('br')); info.appendChild(el('span', null, s.tech.name)); }
  dd.appendChild(info);
  const canSkip = !(s.tech && s.tech.allowSkip === false);
  dd.appendChild(menuRow(s.paused ? 'play' : 'pause', s.paused ? 'Продолжить' : 'Пауза', () => { closeMenus(); (s.paused ? lite.pomodoro.resume() : lite.pomodoro.pause()).catch(() => {}); }));
  if (!brk) dd.appendChild(menuRow('clock', 'Перерыв сейчас', () => { closeMenus(); lite.pomodoro.skip().catch(() => {}); }));
  else if (canSkip) dd.appendChild(menuRow('skip', 'Пропустить перерыв', () => { closeMenus(); lite.pomodoro.skip().catch(() => {}); }));
  dd.appendChild(menuRow('stop', 'Остановить', () => { closeMenus(); lite.pomodoro.stop().catch(() => {}); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('clock', 'Открыть модуль «Помодоро»', () => { closeMenus(); openModule('pomodoro'); }));
  placeMenuBelow(dd, anchor);
}

// ---------------------------------------------------------------- заготовленные промпты
// Реплики для агента по правому клику в терминале. Делятся на ОБЩИЕ (видны в любом проекте) и
// ПРОЕКТНЫЕ (только в своём проекте) — как задачи в модуле «Задачи». Хранятся в STORE.promptSnippets:
//   { global: [{id,title,body}], byProject: { <projId>: [{id,title,body}] } }.
// Клик по карточке ВСТАВЛЯЕТ текст в PTY без хвостового перевода строки — ничего не запускает.
const DEFAULT_PROMPTS = [
  { id: 'ps_explain', title: 'Объясни код', body: 'Объясни, что делает этот код, по шагам — без изменений.' },
  { id: 'ps_bugs', title: 'Найди баги', body: 'Найди потенциальные баги и уязвимости в коде проекта и предложи исправления.' },
  { id: 'ps_tests', title: 'Напиши тесты', body: 'Напиши модульные тесты для последних изменений.' },
  { id: 'ps_refactor', title: 'Отрефактори', body: 'Предложи рефакторинг: чище и проще, без изменения поведения.' },
];
// Нормализует хранилище к {global, byProject}. Старый формат (плоский массив) мигрирует в global.
function loadPromptStore() {
  let v = STORE.promptSnippets;
  if (Array.isArray(v)) { v = { global: v, byProject: {} }; persist('promptSnippets', v); return v; }
  if (!v || typeof v !== 'object') { v = { global: DEFAULT_PROMPTS.map((p) => ({ ...p })), byProject: {} }; persist('promptSnippets', v); return v; }
  if (!Array.isArray(v.global)) v.global = [];
  if (!v.byProject || typeof v.byProject !== 'object') v.byProject = {};
  return v;
}
function savePromptStore(s) { persist('promptSnippets', s); }
function newPromptId() { return 'ps_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
// Вставка промпта в конкретную сессию (sid). Хвостовые переводы строк срезаем — ничего не запускаем.
function insertPrompt(sid, body) {
  const text = String(body || '').replace(/[\r\n]+$/, '');
  if (text) lite.pty.write(sid, text);
  const rec = terms.get(sid);
  if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
}
// Flyout-панель: проектные промпты (если есть) + общие, каждая группа со своей меткой; в шапке шестерёнка.
function buildPromptPanel(sid, projId, schedClose, keepOpen) {
  const sub = el('div', 'menu-dropdown menu-sub prompt-flyout');
  sub.addEventListener('click', (e) => e.stopPropagation());
  sub.addEventListener('mouseenter', keepOpen);
  sub.addEventListener('mouseleave', schedClose);
  const head = el('div', 'prompt-head');
  head.appendChild(el('span', 'prompt-head-title', 'Промпты'));
  const gear = iconBtn('prompt-gear', 'sliders', 'Управление промптами', 15);
  gear.addEventListener('click', () => { closeMenus(); openPromptsManager(projId); });
  head.appendChild(gear);
  sub.appendChild(head);
  const list = el('div', 'prompt-list');
  const store = loadPromptStore();
  const proj = projId ? (store.byProject[projId] || []) : [];
  const glob = store.global || [];
  const addCards = (arr) => {
    for (const p of arr) {
      const card = el('div', 'prompt-card');
      card.appendChild(el('div', 'prompt-card-title', p.title || '(без названия)'));
      if (p.body) card.appendChild(el('div', 'prompt-card-body', p.body));
      card.addEventListener('click', () => { closeMenus(); insertPrompt(sid, p.body); });
      list.appendChild(card);
    }
  };
  if (!proj.length && !glob.length) {
    list.appendChild(el('div', 'prompt-empty', 'Промптов пока нет'));
  } else if (proj.length) {
    // обе группы маркируем, чтобы было видно, что проектное, а что общее
    list.appendChild(el('div', 'prompt-group', 'Проект'));
    addCards(proj);
    if (glob.length) { list.appendChild(el('div', 'prompt-group', 'Общие')); addCards(glob); }
  } else {
    addCards(glob); // только общие — без лишней метки
  }
  sub.appendChild(list);
  return sub;
}
// Пункт «Промпты ▸» в контекстном меню: подменю раскрывается вправо по наведению (как в меню «Модули»).
function addPromptsItem(dd, sid) {
  const projId = (terms.get(sid) || {}).projId || String(sid).split('::')[0];
  const row = el('div', 'menu-row menu-flyout');
  const ic = el('span', 'menu-ic'); ic.appendChild(icon('chat', 16));
  row.append(ic, el('span', null, 'Промпты'));
  const arr = el('span', 'menu-arrow'); arr.appendChild(icon('chevron-right', 15)); row.appendChild(arr);
  let sub = null, closeT = null;
  const closeSub = () => { if (sub) { sub.remove(); sub = null; } row.classList.remove('sub-open'); };
  const schedClose = () => { clearTimeout(closeT); closeT = setTimeout(closeSub, 240); };
  const keepOpen = () => clearTimeout(closeT);
  row.addEventListener('mouseenter', () => {
    clearTimeout(closeT);
    if (sub) return;
    sub = buildPromptPanel(sid, projId, schedClose, keepOpen);
    $('#menu-layer').appendChild(sub);
    const rr = row.getBoundingClientRect();
    sub.style.top = rr.top + 'px';
    sub.style.left = (rr.right - 4) + 'px';
    const sr = sub.getBoundingClientRect();
    if (sr.right > window.innerWidth - 8) sub.style.left = Math.max(8, rr.left - sr.width + 4) + 'px';
    if (sr.bottom > window.innerHeight - 8) sub.style.top = Math.max(8, window.innerHeight - 8 - sr.height) + 'px';
    row.classList.add('sub-open');
  });
  row.addEventListener('mouseleave', schedClose);
  dd.appendChild(row);
}
// Менеджер промптов: две колонки (Проект | Общие), каждая со своим скроллом; inline-правка названия+тела,
// перемещение ↑/↓ внутри колонки, удаление и переброс между колонками (как перенос задач проект↔общие).
function openPromptsManager(projId) {
  const store = loadPromptStore();
  const projName = (projects.find((p) => p.id === projId) || {}).name || 'Проект';
  const clone = (arr) => (arr || []).map((p) => ({ id: p.id, title: p.title || '', body: p.body || '' }));
  const cols = { proj: clone(store.byProject[projId]), glob: clone(store.global) };
  const listEls = {};
  const syncFromDom = () => {
    for (const key of ['proj', 'glob']) {
      if (!listEls[key]) continue;
      for (const row of listEls[key].children) {
        const it = cols[key].find((x) => x.id === row.dataset.id);
        if (!it) continue;
        it.title = row.querySelector('.pm-title').value;
        it.body = row.querySelector('.pm-body').value;
      }
    }
  };
  const persistNow = () => {
    if (cols.proj.length) store.byProject[projId] = cols.proj; else delete store.byProject[projId];
    store.global = cols.glob;
    savePromptStore(store);
  };
  const commit = () => { syncFromDom(); persistNow(); };
  const { m, close } = makeModal(`
    <h2>Заготовленные промпты</h2>
    <div class="pm-hint">Доступны по правому клику в терминале → «Промпты». Клик по карточке вставляет текст в активный терминал <b>без запуска</b>. Слева — промпты этого проекта, справа — общие для всех проектов.</div>
    <div class="pm-cols">
      <div class="pm-col">
        <div class="pm-col-head" data-head="proj"></div>
        <div class="pm-list" data-list="proj"></div>
        <button class="btn pm-add" data-add="proj">＋ Добавить</button>
      </div>
      <div class="pm-col">
        <div class="pm-col-head">Общие</div>
        <div class="pm-list" data-list="glob"></div>
        <button class="btn pm-add" data-add="glob">＋ Добавить</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="pm-done">Готово</button>
    </div>`, commit);
  m.querySelector('[data-head="proj"]').textContent = 'Проект — ' + projName;
  listEls.proj = m.querySelector('[data-list="proj"]');
  listEls.glob = m.querySelector('[data-list="glob"]');
  const move = (key, i, d) => { syncFromDom(); const a = cols[key], j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; persistNow(); render(); };
  const remove = (key, i) => { syncFromDom(); cols[key].splice(i, 1); persistNow(); render(); };
  const add = (key) => { syncFromDom(); const it = { id: newPromptId(), title: '', body: '' }; cols[key].push(it); persistNow(); render(key, it.id); };
  const transfer = (key, i) => { syncFromDom(); const dest = key === 'proj' ? 'glob' : 'proj'; const [it] = cols[key].splice(i, 1); cols[dest].push(it); persistNow(); render(dest, it.id); };
  const buildRow = (key, it, i) => {
    const row = el('div', 'pm-row'); row.dataset.id = it.id;
    const head = el('div', 'pm-row-head');
    const ti = el('input', 'pm-title'); ti.type = 'text'; ti.value = it.title; ti.placeholder = 'Название';
    ti.addEventListener('change', commit);
    const ctrl = el('div', 'pm-ctrl');
    const up = iconBtn('pm-mini', 'chevron-up', 'Выше', 15); up.disabled = i === 0;
    up.addEventListener('click', () => move(key, i, -1));
    const down = iconBtn('pm-mini', 'chevron-down', 'Ниже', 15); down.disabled = i === cols[key].length - 1;
    down.addEventListener('click', () => move(key, i, 1));
    const toGlob = key === 'proj';
    const mv = iconBtn('pm-mini', toGlob ? 'globe' : 'folder', toGlob ? 'В общие' : 'В проект', 15);
    mv.addEventListener('click', () => transfer(key, i));
    const del = iconBtn('pm-mini del', 'trash', 'Удалить', 15);
    del.addEventListener('click', () => remove(key, i));
    ctrl.append(up, down, mv, del);
    head.append(ti, ctrl);
    const body = el('textarea', 'pm-body'); body.value = it.body; body.placeholder = 'Текст промпта…';
    body.addEventListener('change', commit);
    row.append(head, body);
    return row;
  };
  const render = (focusKey, focusId) => {
    for (const key of ['proj', 'glob']) {
      const listEl = listEls[key]; listEl.innerHTML = '';
      if (!cols[key].length) { listEl.appendChild(el('div', 'pm-empty', key === 'proj' ? 'Нет промптов проекта' : 'Нет общих промптов')); continue; }
      cols[key].forEach((it, i) => listEl.appendChild(buildRow(key, it, i)));
    }
    if (focusId && listEls[focusKey]) {
      const r = listEls[focusKey].querySelector(`.pm-row[data-id="${focusId}"]`);
      if (r) setTimeout(() => r.querySelector('.pm-title').focus(), 20);
    }
  };
  m.querySelectorAll('.pm-add').forEach((b) => { b.onclick = () => add(b.dataset.add); });
  m.querySelector('#pm-done').onclick = close;
  render();
}

// terminal right-click menu
// `sid` — id ИМЕННО того терминала, по которому кликнули: сессия проекта (`p…::tN`) ИЛИ
// dev-терминал модуля (`__extterm__::tN`). Все действия обязаны идти по нему, а не по активной вкладке.
function showTermMenu(x, y, term, sid) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '160px';
  const hasSel = term.hasSelection && term.hasSelection();
  dd.appendChild(menuRow('copy', 'Копировать', hasSel ? () => {
    closeMenus();
    lite.copyText(term.getSelection());
    if (term.clearSelection) term.clearSelection();
  } : null, hasSel ? '' : 'disabled'));
  dd.appendChild(menuRow('clipboard', 'Вставить', () => { closeMenus(); pasteInto(sid); }));
  // «Озвучить» — выделенный кусок вывода уезжает в окно модуля «Озвучка» (main откроет его, если закрыто).
  dd.appendChild(menuRow('volume', 'Озвучить', hasSel ? () => {
    closeMenus();
    lite.tts.openFromEditor(term.getSelection());
  } : null, hasSel ? '' : 'disabled'));
  dd.appendChild(el('div', 'menu-sep'));
  addPromptsItem(dd, sid);
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('eraser', 'Очистить', () => { closeMenus(); clearTerminal(sid); }));
  dd.appendChild(menuRow('refresh', 'Перезапустить', () => { closeMenus(); restartTerminal(sid); }));
  dd.addEventListener('click', (e) => e.stopPropagation());
  placeMenu(dd, x, y);
}

// ---------------------------------------------------------------- modals
// makeModal/showConfirm/showPrompt живут в ui.js; здесь остались только предметные модалки.
function showAbout() {
  closeMenus();
  const { m, close } = makeModal(`
    <div class="about-logo"><span class="about-mark"></span><span>LiteEditor</span></div>
    <div class="about-ver" data-no-i18n>${APP_VERSION}</div> <span id="ab-upd-status" class="about-upd"></span>
    <div class="about-desc" style="margin-top:14px;text-align:left">
      Когда код всё чаще пишет агент, а не ты сам, привычный редактор встаёт с ног на голову:
      в центре уже не файл, а разговор. LiteEditor построен вокруг этого — главный здесь
      твой терминал с агентом, а просмотр кода, дерево и git живут рядом и прячутся одной
      кнопкой, когда не нужны.<br><br>
      Это нарочно лёгкий и тихий инструмент: открыл папку — и сразу за дело, без долгой
      настройки. Он старается не мешать и держаться в стороне, пока ты направляешь работу,
      а не выстукиваешь каждую строку руками.<br><br>
      Маленький проект для себя и тех, кто проводит день в диалоге с ИИ и хочет, чтобы вокруг
      этого диалога было спокойно и удобно.
    </div>
    <div class="about-meta">Максим Кузьминский · Electron · xterm.js · node-pty · CodeMirror</div>
    <div class="modal-actions">
      <button class="btn" id="ab-check">Проверить обновление</button>
      <button class="btn" id="ab-src">GitHub</button>
      <button class="btn primary" id="ab-ok">Ок</button>
    </div>`);
  m.classList.add('about-modal');
  m.querySelector('#ab-ok').onclick = close;
  m.querySelector('#ab-src').prepend(icon('github', 14));
  m.querySelector('#ab-src').onclick = openRepo;
  const st = m.querySelector('#ab-upd-status');
  const setSt = (txt, cls) => { if (st) { st.textContent = txt; st.className = 'about-upd' + (cls ? ' ' + cls : ''); } };
  // Reflect a known result immediately; otherwise prompt to check.
  if (updateInfo) setSt('— доступна ' + updateInfo.tag, 'has');
  m.querySelector('#ab-check').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; setSt('— проверяю…');
    const r = await checkForUpdate({ manual: true });
    btn.disabled = false;
    if (r && r.error) setSt('— не удалось проверить', 'err');
    else if (r.newer) {
      // Build with DOM methods (tag comes from the API) — no innerHTML.
      setSt('— доступна ', 'has');
      const self = r.install && r.install.canSelfUpdate && r.asset;
      const dl = el('a', null, (r.tag || 'новая версия') + (self ? ' (обновить)' : ' (скачать)'));
      dl.href = '#';
      dl.onclick = async (ev) => {
        ev.preventDefault();
        if (!self) return lite.openExternal(r.url || RELEASES_URL);
        // Уже скачано в фоне — сразу к перезапуску; иначе качаем и предлагаем перезапуск по готовности.
        if (updPhase.phase === 'ready') return confirmAndInstall();
        setSt('— загружаю…');
        // фоновая автозагрузка уже идёт — второй запрос main отклонил бы ошибкой «загрузка уже идёт»
        if (updPhase.phase === 'downloading') return;
        const d = await startUpdateDownload({ manual: true });
        if (d && d.ok) { close(); confirmAndInstall(); } else setSt('— не удалось загрузить', 'err');
      };
      st.appendChild(dl);
    } else setSt('— у вас последняя версия', 'ok');
  };
}
function showCreateFolder() {
  const { m, close } = makeModal(`
    <h2>Создать папку</h2>
    <div class="field"><label>Название папки</label>
      <input type="text" id="cf-name" placeholder="my-project" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>Где создать</label>
      <div class="path-pick">
        <input type="text" id="cf-parent" placeholder="выбери расположение…" readonly>
        <button class="btn" id="cf-pick">Выбрать…</button>
      </div></div>
    <div class="err" id="cf-err"></div>
    <div class="modal-actions">
      <button class="btn" id="cf-cancel">Отмена</button>
      <button class="btn primary" id="cf-create">Создать и открыть</button>
    </div>`);
  const nameI = m.querySelector('#cf-name');
  const parentI = m.querySelector('#cf-parent');
  const err = m.querySelector('#cf-err');
  parentI.value = settings.workingDir || lastParent || ''; // working folder wins when set
  setTimeout(() => nameI.focus(), 30);
  m.querySelector('#cf-cancel').onclick = close;
  m.querySelector('#cf-pick').onclick = async () => {
    const d = await lite.pickDir();
    if (d) { parentI.value = d; lastParent = d; persist('lastParent', d); }
  };
  const create = async () => {
    const name = nameI.value.trim();
    const parent = parentI.value.trim();
    err.textContent = '';
    if (!name) { err.textContent = 'Введи название папки'; return; }
    if (!parent) { err.textContent = 'Выбери, где создать'; return; }
    const res = await lite.fs.mkdir(parent, name);
    if (res.error) { err.textContent = res.error; return; }
    close();
    openByPath(res.path, res.name);
  };
  m.querySelector('#cf-create').onclick = create;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
}

// ---------------------------------------------------------------- logs viewer
// In-app reader for ~/.LiteEditorAI/logs/*.log with level highlighting. Read-only.
// Renders lines via textContent (never innerHTML) — log text is untrusted input.
function showLogs() {
  closeMenus();
  let unsub = null;
  const { m } = makeModal(`
    <h2>Логи приложения</h2>
    <div class="logs-tabs">
      <button class="logs-tab active" data-tab="stream">Поток</button>
      <button class="logs-tab" data-tab="errors">Ошибки <span class="logs-tabcount" id="logs-errcount"></span></button>
    </div>
    <div class="logs-wrap" id="logs-stream">
      <div class="logs-side">
        <div class="logs-files" id="logs-files"></div>
        <button class="btn logs-clearold" id="logs-clearold" title="Удалить все логи кроме сегодняшних">🗑 Очистить старые</button>
      </div>
      <div class="logs-main">
        <div class="logs-bar">
          <span class="logs-name" id="logs-curname">—</span>
          <input type="text" class="logs-search" id="logs-search" placeholder="фильтр строк…">
          <label class="logs-chk"><input type="checkbox" id="logs-erronly"> только ошибки</label>
          <button class="icon-btn" id="logs-copy" title="Скопировать файл">⧉</button>
          <button class="icon-btn" id="logs-refresh" title="Обновить">⟳</button>
        </div>
        <div class="logs-view" id="logs-view"></div>
      </div>
    </div>
    <div class="logs-errpane hidden" id="logs-errors">
      <div class="logs-errbar">
        <select class="logs-errfilter" id="logs-errfilter">
          <option value="open">Открытые</option>
          <option value="all">Все</option>
          <option value="resolved">Решённые</option>
          <option value="ignored">Игнор</option>
        </select>
        <span class="drag-space-static"></span>
        <button class="btn" id="logs-err-agent" title="Вставить открытые ошибки в терминал активного проекта">→ Передать агенту</button>
        <button class="btn" id="logs-err-clear" title="Удалить решённые и игнор из реестра">Очистить решённые</button>
        <button class="icon-btn" id="logs-err-refresh" title="Обновить">⟳</button>
      </div>
      <div class="logs-errlist" id="logs-errlist"></div>
    </div>`, () => { if (unsub) unsub(); });
  const filesBox = m.querySelector('#logs-files');
  const view = m.querySelector('#logs-view');
  const curName = m.querySelector('#logs-curname');
  const errOnly = m.querySelector('#logs-erronly');
  const search = m.querySelector('#logs-search');
  let current = null, raw = '';
  const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const levelOf = (line) => /\[(FATAL|ERROR)\]/.test(line) ? 'err' : /\[WARN\]/.test(line) ? 'warn' : /\[INFO\]/.test(line) ? 'info' : null;
  function render() {
    view.innerHTML = '';
    if (!current) { view.appendChild(el('div', 'logs-empty', 'Выбери файл слева')); return; }
    let lines = raw.split('\n');
    if (errOnly.checked) lines = lines.filter((l) => { const k = levelOf(l); return k === 'err' || k === 'warn'; });
    const q = (search.value || '').trim().toLowerCase();
    if (q) lines = lines.filter((l) => l.toLowerCase().includes(q));
    const MAXL = 2500;
    if (lines.length > MAXL) { view.appendChild(el('div', 'logs-note', `…последние ${MAXL} строк из ${lines.length}`)); lines = lines.slice(-MAXL); }
    if (!lines.length) { view.appendChild(el('div', 'logs-empty', errOnly.checked ? 'Ошибок и предупреждений нет 🎉' : 'Файл пуст')); return; }
    const frag = document.createDocumentFragment();
    for (const line of lines) { const k = levelOf(line); frag.appendChild(el('div', 'logs-line' + (k ? ' ll-' + k : ''), line || ' ')); }
    view.appendChild(frag);
  }
  async function load(name) {
    current = name; curName.textContent = name;
    filesBox.querySelectorAll('.logs-file').forEach((r) => r.classList.toggle('active', r.dataset.name === name));
    view.innerHTML = ''; view.appendChild(el('div', 'logs-empty', 'Загрузка…'));
    let res; try { res = await lite.logs.read(name); } catch (e) { res = { error: String(e) }; }
    if (!res || res.error) { view.innerHTML = ''; view.appendChild(el('div', 'logs-empty', 'Ошибка: ' + ((res && res.error) || '—'))); return; }
    raw = (res.truncated ? '…(показан конец файла)\n' : '') + (res.content || '');
    render();
  }
  async function refresh() {
    filesBox.innerHTML = '';
    let res; try { res = await lite.logs.list(); } catch (e) { res = { error: String(e), files: [] }; }
    const files = (res && res.files) || [];
    if (!files.length) { filesBox.appendChild(el('div', 'logs-empty', 'Логов пока нет')); view.innerHTML = ''; return; }
    for (const f of files) {
      const row = el('div', 'logs-file'); row.dataset.name = f.name;
      const info = el('div', 'logs-finfo');
      info.appendChild(el('div', 'logs-fname', f.name));
      info.appendChild(el('div', 'logs-fmeta', fmtSize(f.size)));
      info.addEventListener('click', () => load(f.name));
      const del = el('button', 'logs-fdel'); del.title = 'Удалить файл'; del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirm('Удалить лог?', 'Файл «' + f.name + '» будет удалён безвозвратно.', 'Удалить', async () => {
          const r = await lite.logs.delete(f.name);
          if (r && r.ok) { if (current === f.name) { current = null; raw = ''; view.innerHTML = ''; } refresh(); }
          else toast('Не удалось удалить файл', { kind: 'err' });
        });
      });
      row.append(info, del);
      filesBox.appendChild(row);
    }
    load((current && files.some((f) => f.name === current)) ? current : files[0].name); // newest day first
  }
  errOnly.onchange = render;
  search.addEventListener('input', render);
  m.querySelector('#logs-refresh').onclick = refresh;
  m.querySelector('#logs-copy').onclick = () => { if (raw) { lite.copyText(raw); toast('Лог скопирован в буфер'); } };
  m.querySelector('#logs-clearold').onclick = () => showConfirm('Очистить старые логи?', 'Будут удалены все лог-файлы, кроме сегодняшних. Текущая сессия сохранится.', 'Очистить', async () => {
    const r = await lite.logs.clearOld();
    toast(r && r.ok ? ('Удалено файлов: ' + (r.removed || 0)) : 'Не удалось очистить', r && r.ok ? {} : { kind: 'err' });
    refresh();
  });

  // ── вкладка «Ошибки» (реестр) ──────────────────────────────────────────────────────────
  const streamPane = m.querySelector('#logs-stream');
  const errPane = m.querySelector('#logs-errors');
  const tabs = [...m.querySelectorAll('.logs-tab')];
  const errCount = m.querySelector('#logs-errcount');
  const errList = m.querySelector('#logs-errlist');
  const errFilter = m.querySelector('#logs-errfilter');
  let errEntries = [];
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + 'с' : s < 3600 ? Math.floor(s / 60) + 'м' : s < 86400 ? Math.floor(s / 3600) + 'ч' : Math.floor(s / 86400) + 'д'; };
  function renderErrors() {
    errList.innerHTML = '';
    const f = errFilter.value;
    const items = f === 'all' ? errEntries : errEntries.filter((e) => e.status === f);
    if (!items.length) { errList.appendChild(el('div', 'logs-empty', f === 'open' ? 'Открытых ошибок нет 🎉' : 'Пусто')); return; }
    for (const e of items) {
      const card = el('div', 'logs-err' + (e.status !== 'open' ? ' done' : ''));
      const head = el('div', 'logs-err-head');
      head.appendChild(el('span', 'logs-err-lvl ' + (e.level === 'warn' ? 'warn' : 'err'), (e.level || '').toUpperCase()));
      head.appendChild(el('span', 'logs-err-src', e.source || 'main'));
      head.appendChild(el('span', 'logs-err-count', '×' + (e.count || 1)));
      if (e.project) head.appendChild(el('span', 'logs-err-proj', baseName(e.project)));
      if (e.regressed) head.appendChild(el('span', 'logs-err-regr', 'регрессия'));
      if (e.status === 'resolved') head.appendChild(el('span', 'logs-err-tag ok', '✓ решено'));
      else if (e.status === 'ignored') head.appendChild(el('span', 'logs-err-tag', 'игнор'));
      head.appendChild(el('span', 'logs-err-time', ago(e.lastSeen)));
      card.appendChild(head);
      card.appendChild(el('div', 'logs-err-msg', e.sample || ''));
      if (e.note) card.appendChild(el('div', 'logs-err-note', '📝 ' + e.note + (e.commit ? ' · ' + e.commit : '')));
      const acts = el('div', 'logs-err-acts');
      if (e.status === 'open') {
        const res = el('button', 'logs-err-btn ok', '✓ Решено');
        res.onclick = async () => { const r = await lite.errors.setStatus(e.id, 'resolved', null, null); if (r && r.ok) loadErrors(); };
        const ign = el('button', 'logs-err-btn', 'Игнор');
        ign.onclick = async () => { const r = await lite.errors.setStatus(e.id, 'ignored'); if (r && r.ok) loadErrors(); };
        acts.append(res, ign);
      } else {
        const re = el('button', 'logs-err-btn', '↩ Вернуть в открытые');
        re.onclick = async () => { const r = await lite.errors.setStatus(e.id, 'open'); if (r && r.ok) loadErrors(); };
        acts.append(re);
      }
      card.appendChild(acts);
      errList.appendChild(card);
    }
  }
  async function loadErrors() {
    let res; try { res = await lite.errors.list(); } catch (_) { res = { entries: [], open: 0 }; }
    errEntries = (res && res.entries) || [];
    const open = (res && res.open) || 0;
    errCount.textContent = open ? String(open) : '';
    errCount.classList.toggle('has', open > 0);
    renderErrors();
  }
  function setTab(name) {
    streamPane.classList.toggle('hidden', name !== 'stream');
    errPane.classList.toggle('hidden', name !== 'errors');
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    if (name === 'errors') loadErrors();
  }
  tabs.forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });
  errFilter.onchange = renderErrors;
  m.querySelector('#logs-err-refresh').onclick = loadErrors;
  m.querySelector('#logs-err-clear').onclick = () => showConfirm('Очистить реестр?', 'Решённые и игнорированные записи будут удалены из реестра. Открытые останутся.', 'Очистить', async () => {
    const r = await lite.errors.clearResolved();
    toast(r && r.ok ? ('Удалено записей: ' + (r.removed || 0)) : 'Не удалось', r && r.ok ? {} : { kind: 'err' });
    loadErrors();
  });
  m.querySelector('#logs-err-agent').onclick = () => {
    const p = activeProject();
    if (!p) { toast('Нет активного проекта — открой проект, чтобы передать в его терминал', { kind: 'err', ttl: 7000 }); return; }
    const open = errEntries.filter((e) => e.status === 'open' && (!e.project || e.project === p.path));
    if (!open.length) { toast('Открытых ошибок для этого проекта нет'); return; }
    const lines = open.slice(0, 40).map((e) => `- [${e.level}] ${e.source}: ${e.sample} (×${e.count}, id ${e.id})`).join('\n');
    const text = `В логе редактора есть открытые ошибки (реестр ~/.LiteEditorAI/errors.json). Разберись и почини; что устранил — отметь в errors.json по правилу из CLAUDE.md (для записи по id выставить "status":"resolved" + "note" + "commit"). Открытые сейчас:\n${lines}\n`;
    sendNoteToTerminal(p, text);
    toast('Передано в терминал: ' + open.length);
  };
  try { unsub = lite.errors.onChanged(() => loadErrors()); } catch (_) {}
  loadErrors();   // заполнить счётчик на вкладке сразу
  refresh();
}

// ---------------------------------------------------------------- settings panel (small on purpose)
// Настройки: разделы слева, содержимое справа. Всё применяется сразу (без «Сохранить»): переключатели,
// списки и числа пишутся по изменению. Цвета и размеры — в панели «Оформление» (кнопка-палитра).
const SET_SECTIONS = [
  ['look', 'palette', 'Внешний вид'],
  ['term', 'terminal', 'Терминал'],
  ['notif', 'bell', 'Уведомления'],
  ['upd', 'refresh', 'Обновления'],
  ['proj', 'folder', 'Проекты и папки'],
  ['ss', 'sparkles', 'Заставка'],
];
function showSettings(start = 'look') {
  closeMenus();
  const { m, close } = makeModal(`
    <aside class="snav"><div class="st-title">Настройки</div><div class="snav-list"></div><span class="grow"></span><div class="sver"></div></aside>
    <section class="scontent"><div class="shead"><h3></h3><button class="icon-btn" id="st-x" title="Закрыть" aria-label="Закрыть"></button></div><div class="sbody"></div>
      <div class="sfoot"><button class="btn primary" id="st-ok">Готово</button></div></section>`, () => { scanProjects(); });
  m.classList.add('settings-modal');
  m.querySelector('.sver').textContent = 'LiteEditor ' + APP_VERSION;
  m.querySelector('.sver').setAttribute('data-no-i18n', '');
  m.querySelector('#st-x').appendChild(icon('x', 16));
  m.querySelector('#st-x').onclick = close;
  m.querySelector('#st-ok').onclick = close;
  const nav = m.querySelector('.snav-list'), body = m.querySelector('.sbody'), h3 = m.querySelector('.shead h3');
  let cur = SET_SECTIONS.some((x) => x[0] === start) ? start : 'look';

  // ---- строительные блоки
  const row = (label, desc, ctl, cls) => {
    const r = el('div', 'srow' + (cls ? ' ' + cls : ''));
    const sl = el('div', 'sl'); sl.appendChild(el('b', null, label));
    if (desc) sl.appendChild(typeof desc === 'string' ? el('span', null, desc) : desc);
    r.appendChild(sl);
    if (ctl) r.appendChild(ctl);
    return r;
  };
  const toggle = (on, onChange) => {
    const b = el('button', 'sw-t' + (on ? ' on' : ''));
    b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!on)); b.setAttribute('aria-label', 'Переключить');
    b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); onChange(v); };
    return b;
  };
  const select = (opts, value, onChange) => {
    const s = el('select', 'set-sel');
    for (const [v, t] of opts) { const o = el('option', null, t); o.value = v; s.appendChild(o); }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const number = (value, min, max, step, onChange) => {
    const n = el('input', 'set-num'); n.type = 'number'; n.min = min; n.max = max; n.step = step; n.value = value;
    n.addEventListener('change', () => { const v = Math.max(min, Math.min(max, Number(n.value) || min)); n.value = v; onChange(v); });
    return n;
  };
  const button = (text, glyph, onClick, cls) => {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''));
    if (glyph) b.appendChild(icon(glyph, 14));
    b.appendChild(el('span', null, text));
    b.onclick = onClick;
    return b;
  };
  const save = () => saveSettings();

  const PAGES = {
    look() {
      const lang = select([[settings.lang || 'ru', '…']], settings.lang || 'ru', async (v) => {
        const r = await lite.i18n.set(v);        // main разошлёт словарь во все окна — перевод применится на лету
        if (r && r.error) toast(r.error, { kind: 'err' });
      });
      lite.i18n.list().then(({ current, list }) => {
        lang.replaceChildren();
        for (const l of (list || [])) {
          const o = el('option', null, l.nativeName + (l.nativeName === l.name ? '' : ` · ${l.name}`) + (l.builtin ? '' : ' (свой)'));
          o.value = l.code; lang.appendChild(o);
        }
        lang.value = current || 'ru';
      }).catch(() => {});
      const ld = el('span');
      ld.append(el('span', null, 'Языки — подключаемые файлы locales/<код>.json; свои кладутся в папку пользовательских локалей и перекрывают встроенные.'), el('br'));
      const dirLink = el('button', 'addlink', 'Открыть папку языков');
      dirLink.style.marginTop = '6px';
      dirLink.onclick = async () => { const r = await lite.i18n.openUserDir(); if (r && r.error) toast(r.error, { kind: 'err' }); };
      ld.appendChild(dirLink);
      body.appendChild(row('Язык интерфейса', ld, lang));
      body.appendChild(row('Цвета и размеры', 'Фон, панели, текст, акцент, состояния, скругление, ширина панели, шрифт терминала — всё настраивается.',
        // stopPropagation — как у кнопки-палитры: иначе клик всплывёт до document и closeMenus() сразу закроет панель
        button('Настроить…', 'palette', (e) => { e.stopPropagation(); close(); showLookPanel($('#app').classList.contains('single') ? $('#rail-look') : $('#btn-look')); })));
      body.appendChild(row('Размер шрифта терминала', 'На ходу — Ctrl + «+» / «−».', number(settings.fontSize, 9, 24, 1, (v) => { settings.fontSize = v; save(); applyFontSize(); })));
      // Рамка окна — живой предпросмотр: применяется сразу и уезжает в окна модулей (шина settingsChanged).
      const frameLive = () => { save(); applyFrame(settings); try { lite.app.settingsChanged(settings); } catch (_) {} };
      const fc = frameConf(settings);
      const subs = [];
      const sub = (r) => { r.classList.add('sub'); if (!fc.on) r.classList.add('off'); subs.push(r); return r; };
      body.appendChild(row('Рамка окна', 'Тонкая рамка по краю окна редактора и окон модулей.', toggle(fc.on, (v) => {
        settings.frameOn = v; frameLive(); subs.forEach((r) => r.classList.toggle('off', !v));
      })));
      const sw = el('div', 'frame-swatches');
      const drawSw = () => {
        sw.replaceChildren();
        const sel = frameConf(settings).color;
        for (const [key, c] of Object.entries(FRAME_COLORS)) {
          const b = el('button', 'frame-sw' + (key === sel ? ' on' : ''));
          b.type = 'button'; b.title = c.label;
          b.style.background = `linear-gradient(135deg, ${c.c1}, ${c.c2})`;
          b.onclick = () => { settings.frameColor = key; frameLive(); drawSw(); };
          sw.appendChild(b);
        }
      };
      drawSw();
      body.appendChild(sub(row('Цвет рамки', '', sw)));
      body.appendChild(sub(row('Пульсация', 'Мягкое «дыхание» от тёмного оттенка к чуть ярче и обратно.', toggle(fc.pulse, (v) => { settings.framePulse = v; frameLive(); }))));
      body.appendChild(sub(row('Период пульсации, сек', '', number(fc.periodS, 2, 30, 1, (v) => { settings.framePeriodS = v; frameLive(); }))));
    },
    term() {
      const pre = el('input', 'set-txt mono'); pre.style.width = '220px'; pre.placeholder = 'claude'; pre.spellcheck = false; pre.value = settings.termPrefill || '';
      pre.addEventListener('change', () => { settings.termPrefill = pre.value.trim(); save(); });
      body.appendChild(row('Автоввод в новом терминале', 'Слово или команда само пишется в каждый новый терминал проекта — при открытии проекта и новой вкладке, но без Enter. Пусто — терминал открывается пустым.', pre));
      // Оболочка — платформо-зависимо (Windows: PowerShell/cmd/свой; Linux: bash/свой).
      const isWin = (lite.platform === 'win32');
      const presets = isWin ? ['', 'cmd'] : [''];
      const curShell = settings.shell || '';
      const custom = curShell && !presets.includes(curShell);
      const path = el('input', 'set-txt mono'); path.placeholder = 'путь к исполняемому файлу'; path.spellcheck = false; path.value = custom ? curShell : '';
      const shell = select(isWin ? [['', 'PowerShell (по умолчанию)'], ['cmd', 'cmd'], ['__custom__', 'Свой путь…']] : [['', 'bash (по умолчанию)'], ['__custom__', 'Свой путь…']],
        custom ? '__custom__' : curShell, (v) => {
          pathRow.style.display = v === '__custom__' ? '' : 'none';
          if (v !== '__custom__') { settings.shell = v; save(); } else if (path.value.trim()) { settings.shell = path.value.trim(); save(); }
        });
      path.addEventListener('change', () => { settings.shell = path.value.trim(); save(); });
      body.appendChild(row('Оболочка', 'Применяется к новым терминалам; открытые — после перезапуска (⟳).', shell));
      const pathRow = row('Путь к оболочке', '', path, 'sub');
      pathRow.style.display = custom ? '' : 'none';
      body.appendChild(pathRow);
      body.appendChild(row('Шкала времени слева', 'Узкая полоса вдоль терминала: когда отправлена команда, когда вывод возобновился после паузы, смена минуты. Едет вместе с текстом и не попадает в копирование.',
        toggle(settings.termTimeline === true, (v) => { settings.termTimeline = v; save(); applyTimeline(); })));
    },
    notif() {
      const subs = [];
      body.appendChild(row('Уведомления о завершении агента', 'Системное уведомление, когда агент закончил или ждёт ответа, а вы смотрите в другое место.',
        toggle(settings.notifications, (v) => { settings.notifications = v; save(); subs.forEach((r) => r.classList.toggle('off', !v)); })));
      const snd = row('Звук уведомлений', '', toggle(settings.sound, (v) => { settings.sound = v; save(); }), 'sub' + (settings.notifications ? '' : ' off'));
      subs.push(snd); body.appendChild(snd);
      body.appendChild(row('Тишина до «готов», мс', 'Сколько терминал должен молчать, чтобы агент считался закончившим.',
        number(settings.idleMs, 300, 6000, 100, (v) => { settings.idleMs = v; save(); })));
    },
    upd() {
      body.appendChild(row('Как обновляться', '', select([
        ['auto', 'Скачивать в фоне и предлагать перезапуск'], ['notify', 'Только сообщать о новой версии'], ['off', 'Не проверять'],
      ], updMode(), (v) => { settings.updateMode = v; save(); if (v !== 'off') checkForUpdate().catch(() => {}); })));
      // Подсказка объясняет то, что нужно знать заранее: спросят ли пароль и почему кнопки обновления может не быть.
      const box = el('div', 'sbox', 'Проверяю тип установки…');
      const wrap = el('div', 'srow col'); wrap.appendChild(box); body.appendChild(wrap);
      const UPD_HINTS = {
        portable: 'Портативная установка — обновление скачивается и применяется в один клик, без пароля: редактор закроется и откроется новой версией.',
        mac: 'Приложение обновляется подменой бандла .app и перезапускается само.',
        deb: 'Установлено пакетом .deb в системный каталог, поэтому обновление ставится от имени root — система один раз спросит пароль. Портативная сборка (tar.gz со страницы релизов) обновляется без пароля.',
        dev: 'Запуск из исходников: обновляйтесь через git pull — о новой версии редактор сообщит, кнопки обновления не будет.',
      };
      lite.update.state().then((st) => {
        const inst = (st && st.install) || {};
        let txt = UPD_HINTS[inst.kind] || '';
        if (inst.kind !== 'dev' && inst.kind && !inst.canSelfUpdate) txt = `Обновиться на месте не выйдет: ${inst.reason || 'каталог приложения защищён от записи'}. Кнопка отправит на страницу загрузки.`;
        box.replaceChildren(el('span', null, txt || ''));
        box.appendChild(el('br'));
        box.appendChild(el('span', null, updateInfo && updateInfo.newer ? `Сейчас ${APP_VERSION}, доступна ${updateInfo.tag}.` : `Сейчас ${APP_VERSION}.`));
      }).catch(() => { box.textContent = ''; });
      const newer = updateInfo && updateInfo.newer;
      body.appendChild(row(newer ? 'Доступна новая версия' : 'Проверить прямо сейчас', '', button(newer ? 'Обновить' : 'Проверить', newer ? 'download' : 'refresh', async (e) => {
        const b = e.currentTarget;
        if (newer) { close(); updateNow(); return; }
        b.disabled = true;
        try { await checkForUpdate({ manual: true }); } finally { b.disabled = false; }
        if (cur === 'upd') draw();
      })));
    },
    proj() {
      const wd = el('input', 'set-txt mono'); wd.readOnly = true; wd.placeholder = 'не задана'; wd.value = settings.workingDir || '';
      const pr = el('div', 'pathrow');
      pr.append(wd,
        button('Выбрать', null, async () => { const d = await lite.pickDir(); if (d) { wd.value = d; settings.workingDir = d; save(); } }),
        button('', 'x', () => { wd.value = ''; settings.workingDir = ''; save(); }));
      pr.lastChild.title = 'Очистить';
      const r1 = row('Рабочая папка', 'Куда создаются новые проекты («Создать папку…»).', null, 'col'); r1.appendChild(pr);
      body.appendChild(r1);
      const list = el('div', 'scan');
      const drawScan = () => {
        list.replaceChildren();
        const dirs = settings.scanDirs || [];
        if (!dirs.length) list.appendChild(el('div', 'scan-empty', '— пусто —'));
        dirs.forEach((d, i) => {
          const it = el('div', 'scan-i');
          const sp = el('span', null, d); sp.title = d; sp.setAttribute('data-no-i18n', '');
          const x = iconBtn('icon-btn', 'x', 'Убрать', 14);
          x.onclick = () => { settings.scanDirs = dirs.filter((_, j) => j !== i); save(); drawScan(); };
          it.append(sp, x); list.appendChild(it);
        });
      };
      drawScan();
      const add = el('button', 'addlink'); add.append(icon('plus', 14), el('span', null, 'Добавить папку'));
      add.onclick = async () => { const d = await lite.pickDir(); if (d && !(settings.scanDirs || []).includes(d)) { settings.scanDirs = [...(settings.scanDirs || []), d]; save(); drawScan(); } };
      const r2 = row('Папки для скана', 'Их подпапки добавляются как проекты при запуске (и сразу после закрытия настроек).', null, 'col');
      r2.append(list, add);
      body.appendChild(r2);
    },
    ss() {
      const subs = [];
      body.appendChild(row('Запускать по бездействию', 'Выход — клик, движение мыши или Esc.', toggle(settings.screensaver !== false, (v) => {
        settings.screensaver = v; save(); subs.forEach((r) => r.classList.toggle('off', !v));
      })));
      const mins = row('Порог простоя, мин', '', number(settings.screensaverMins || 5, 1, 180, 1, (v) => { settings.screensaverMins = v; save(); }), 'sub' + (settings.screensaver !== false ? '' : ' off'));
      subs.push(mins); body.appendChild(mins);
      body.appendChild(row('Показать сейчас', 'Та же заставка вручную — кнопка в шапке и пункт в «Ещё».', button('Запустить', 'sparkles', () => { close(); startMatrix(); })));
    },
  };
  const draw = () => {
    nav.replaceChildren();
    for (const [key, glyph, label] of SET_SECTIONS) {
      const b = el('button', key === cur ? 'on' : '');
      b.append(icon(glyph, 16), el('span', null, label));
      b.onclick = () => { cur = key; draw(); };
      nav.appendChild(b);
    }
    h3.textContent = SET_SECTIONS.find((x) => x[0] === cur)[2];
    body.replaceChildren();
    PAGES[cur]();
  };
  draw();
}

// ---------------------------------------------------------------- command palette (Ctrl+K)
function paletteActions() {
  const acts = [];
  for (const p of projects) acts.push({ label: `Проект: ${p.name}`, hint: p.path, run: () => setActive(p.id) });
  acts.push({ label: 'Открыть папку…', run: openProjectDialog });
  acts.push({ label: 'Создать папку…', run: showCreateFolder });
  acts.push({ label: 'Проект — вивер, дерево, Git (открыть окно)', run: () => openModule('files') });
  acts.push({ label: 'Контекст — граф контекста агента', run: () => openModule('ctx') });
  acts.push({ label: 'Контейнеры (Docker / Podman)', run: () => openModule('docker') });
  acts.push({ label: 'Базы данных (Postgres / MySQL / SQLite)', run: () => openModule('db') });
  acts.push({ label: 'Внешние хранилища (S3 — бакеты, объекты)', run: () => openModule('storage') });
  acts.push({ label: 'Задачи — заметки проекта', run: () => openModule('notes') });
  acts.push({ label: 'ИИ компания — команда агентов над проектом', run: () => openModule('company') });
  acts.push({ label: 'Помодоро — таймер работы/отдыха', run: () => openModule('pomodoro') });
  acts.push({ label: 'Озвучка — читать скопированный текст голосом', run: () => openModule('voice') });
  acts.push({ label: 'Jira — свои задачи из нескольких аккаунтов', run: () => openModule('jira') });
  acts.push({ label: 'Режим «один терминал»', run: toggleSingle });
  acts.push({ label: 'Поиск в терминале', hint: 'Ctrl+F', run: openTermSearch });
  acts.push({ label: 'Найти во всех проектах — файлы и терминалы', hint: 'Ctrl+Shift+F', run: () => showGlobalSearch() });
  acts.push({ label: 'Поиск по всем терминалам', run: () => showGlobalSearch({ mode: 'terms' }) });
  acts.push({ label: 'Очистить терминал', run: () => clearTerminal() });
  acts.push({ label: 'Шкала времени слева — вкл/выкл', hint: settings.termTimeline === true ? 'сейчас включена' : 'сейчас выключена', run: () => { settings.termTimeline = settings.termTimeline !== true; saveSettings(); applyTimeline(); } });
  acts.push({ label: 'Перезапустить терминал', run: () => restartTerminal() });
  acts.push({ label: 'Настройки…', run: () => showSettings() });
  acts.push({ label: 'Модули — все модули плитками', run: () => showModulesCatalog() });
  acts.push({ label: 'Быстрая панель — состав и порядок', run: showPanelSetup });
  acts.push({ label: 'Оформление — цвета и размеры', run: () => showLookPanel($('#app').classList.contains('single') ? $('#rail-look') : $('#btn-look')) });
  acts.push({ label: 'Заставка «матрица»', run: () => startMatrix() });
  acts.push({ label: 'Репозиторий на GitHub', run: openRepo });
  // Дифф/превью/поиск по файлу — теперь действия внутри окна вивера (его кнопки/горячие клавиши).
  for (const a of Ext.paletteActions()) acts.push(a); // команды пользовательских модулей (ctx.commands)
  return acts;
}
function showPalette() {
  closeMenus();
  const all = paletteActions();
  const { m, close } = makeModal(`
    <input type="text" id="pal-input" class="pal-input" placeholder="Команда или проект…" autocomplete="off" spellcheck="false">
    <div class="pal-list" id="pal-list"></div>`);
  m.classList.add('palette');
  const input = m.querySelector('#pal-input');
  const list = m.querySelector('#pal-list');
  let sel = 0, shown = all;
  const render = () => {
    list.innerHTML = '';
    shown.forEach((a, i) => {
      const row = el('div', 'pal-row' + (i === sel ? ' sel' : ''));
      row.appendChild(el('span', 'pal-label', a.label));
      if (a.hint) row.appendChild(el('span', 'pal-hint', a.hint));
      // Клик не должен всплыть до document: там closeMenus() тут же закрыл бы выпадашку,
      // которую открыло само действие («Оформление — цвета и размеры»).
      row.addEventListener('click', (e) => { e.stopPropagation(); close(); a.run(); });
      list.appendChild(row);
    });
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((a) => [a.label, tt(a.label), a.hint || ''].join(' ').toLowerCase().includes(q)) : all;
    sel = 0; render();
  };
  input.addEventListener('input', filter);
  // список ограничен по высоте (.pal-list) — выбранная стрелками строка должна оставаться в виду
  const reveal = () => { const r = list.children[sel]; if (r) r.scrollIntoView({ block: 'nearest' }); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); reveal(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); reveal(); }
    else if (e.key === 'Enter') { e.preventDefault(); const a = shown[sel]; if (a) { close(); a.run(); } }
  });
  render();
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- onboarding (first run)
function showOnboarding() {
  closeMenus();
  const { m, close } = makeModal(`
    <div class="ob-brand"><span class="ob-mark"></span><span>Добро пожаловать в LiteEditor</span></div>
    <p>Терминал-ориентированное окружение для работы с агентами: у каждого проекта свой живой терминал, а вивер кода и дерево файлов прячутся одной кнопкой.</p>
    <div class="ob-t">С чего начать</div>
    <div class="ob-step"><span class="ob-n" data-icon="folder"></span><div><b>Откройте папку</b><span>проект появится слева, справа поднимется его терминал</span></div></div>
    <div class="ob-step"><span class="ob-n" data-icon="gear"></span><div><b>Загляните в настройки</b><span>рабочая папка и папки для автоскана проектов</span></div></div>
    <div class="ob-step"><span class="ob-n" data-icon="cmd"></span><div><b><kbd>Ctrl+K</kbd> палитра команд · <kbd>Ctrl+\\</kbd> один терминал</b><span>остальное меню — «Ещё» в боковой панели</span></div></div>
    <div class="modal-actions">
      <button class="btn" id="ob-skip">Позже</button><span class="grow"></span>
      <button class="btn" id="ob-settings">Настройки</button>
      <button class="btn primary" id="ob-open">Открыть папку</button>
    </div>`, () => { if (!settings.onboarded) { settings.onboarded = true; saveSettings(); } });
  m.classList.add('onb-modal');
  hydrateIcons(m);
  m.querySelector('#ob-settings').prepend(icon('gear', 14));
  m.querySelector('#ob-open').prepend(icon('folder', 14));
  m.querySelector('#ob-settings').onclick = () => { close(); showSettings('proj'); };
  m.querySelector('#ob-open').onclick = () => { close(); openProjectDialog(); };
  m.querySelector('#ob-skip').onclick = close;
}

// ---------------------------------------------------------------- single-terminal toggle
function toggleSingle() {
  closeMenus();
  const on = $('#app').classList.toggle('single');
  $('#btn-single').title = on ? 'Развернуть проекты (Ctrl+\\)' : 'Один терминал (Ctrl+\\)';
  refitActiveTerminal();
}

// ---------------------------------------------------------------- обновление приложения
// Плашка в шапке — это одна кнопка, меняющая смысл по фазе:
//   «↑ v1.1.176» → нажали → «↓ 42 %» (идёт загрузка, повторное нажатие отменяет)
//   → «⟳ Перезапустить» → нажали → приложение закрылось и открылось новой версией.
// Сама загрузка и подмена файлов живут в main (lib/updater.js): переживают перезагрузку рендерера.
const RELEASES_URL = 'https://github.com/DanielLetto2020/LiteEditorAI/releases/latest';
let updateInfo = null;                   // {tag,url,notes,newer,install,asset} последней проверки
let updPhase = { phase: 'idle', pct: 0 };
let updBusy = false;                     // нажатие уже обрабатывается — не плодить параллельные загрузки

// Как обновляться: 'auto' — качать сразу, как нашли (по умолчанию, «как в мессенджере»),
// 'notify' — только показать плашку, качать по нажатию, 'off' — не проверять вовсе.
function updMode() { return settings.updateMode || 'auto'; }

// Плашка рисуется ТОЛЬКО из этих двух источников — фазы из main и результата проверки.
// В подвале боковой карточки она живёт только пока идёт загрузка/установка и когда пора перезапускаться;
// «доступна новая версия» — точка у номера версии (клик — «О программе») и пункт «Обновить» в «Ещё».
function renderUpdateBadge() {
  const b = $('#update-badge');
  const ver = $('#app-ver');
  const tag = updPhase.tag || (updateInfo && updateInfo.tag) || '';
  if (ver) {
    ver.replaceChildren(el('span', null, APP_VERSION));
    const avail = !!(updateInfo && updateInfo.newer) && !['downloading', 'installing', 'ready'].includes(updPhase.phase);
    if (avail) ver.appendChild(el('span', 'updot'));
    ver.title = avail ? `Доступна ${tag} — «Ещё» → «Обновить»` : 'О программе';
  }
  if (!b) return;
  const set = (cls, glyph, text, title) => {
    b.hidden = false;
    b.className = 'update-badge' + (cls ? ' ' + cls : '');
    b.replaceChildren(icon(glyph, 13), el('span', null, text));
    b.title = title;
  };
  if (updPhase.phase === 'downloading') {
    const pct = Math.max(0, Math.min(100, updPhase.pct || 0));
    // Прогресс — заливкой самой плашки.
    b.style.setProperty('--upd-pct', pct + '%');
    set('busy', 'download', updPhase.unpacking ? 'распаковка…' : pct + ' %',
      'Загружается ' + (tag || 'обновление') + ' — нажмите, чтобы отменить');
    return;
  }
  b.style.removeProperty('--upd-pct');
  if (updPhase.phase === 'installing') { set('busy', 'refresh', 'обновляю…', 'Идёт установка обновления'); return; }
  if (updPhase.phase === 'ready') {
    set('ready', 'refresh', 'Перезапустить', 'Обновление ' + (tag || '') + ' загружено — нажмите, чтобы перезапуститься на новой версии');
    return;
  }
  b.hidden = true;
}

// Единственный обработчик нажатия на плашку: что делать — решает фаза.
async function onUpdateBadgeClick() {
  if (updBusy) return;
  const inst = (updateInfo && updateInfo.install) || {};
  if (updPhase.phase === 'downloading') { lite.update.cancel(); return; }
  if (updPhase.phase === 'installing') return;
  if (updPhase.phase === 'ready') { confirmAndInstall(); return; }
  if (!inst.canSelfUpdate || !(updateInfo && updateInfo.asset)) {
    lite.openExternal((updateInfo && updateInfo.url) || RELEASES_URL);
    return;
  }
  updBusy = true;
  try { await startUpdateDownload({ manual: true }); } finally { updBusy = false; }
}
// «Обновить» из меню «Ещё» и из настроек. Это не переключатель, как плашка: если загрузка уже идёт
// (фоновая автозагрузка), нажатие не должно её молча отменять — только напомнить, что она идёт
// (в режиме «один терминал» плашки с прогрессом не видно).
function updateNow() {
  if (updPhase.phase === 'downloading') { toast('Обновление уже загружается — ' + Math.max(0, Math.min(100, updPhase.pct || 0)) + ' %'); return; }
  if (updPhase.phase === 'installing') return;
  onUpdateBadgeClick();
}

// Скачать обновление. Тихо при автозагрузке: фоновая закачка не должна сыпать тостами.
async function startUpdateDownload({ manual = false } = {}) {
  let r;
  try { r = await lite.update.download(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && r.ok) {
    if (!manual) toast('Обновление ' + (r.tag || '') + ' загружено — нажмите «Перезапустить» в шапке', { ttl: 7000 });
    return r;
  }
  if (r && r.canceled) return r;
  if (manual) toast('Не удалось загрузить обновление: ' + ((r && r.error) || 'неизвестная ошибка'), { kind: 'err' });
  return r;
}

// Перезапуск с подтверждением. Спрашиваем ВСЕГДА: в терминалах живут агенты и запущенные команды,
// а обновление их закроет — терять чужую работу молча нельзя.
function confirmAndInstall() {
  const inst = (updateInfo && updateInfo.install) || {};
  const extra = inst.needsPassword
    ? ' Система спросит пароль администратора — пакет ставится от root.'
    : '';
  showConfirm(
    'Перезапустить на новой версии?',
    'Редактор закроется и откроется обновлённым. Терминалы и запущенные в них процессы будут завершены — сохраните работу.' + extra,
    'Перезапустить',
    async () => {
      const r = await lite.update.install();
      // Успех обычно не возвращается: процесс уже вышел. Ответ приходит только при неудаче.
      if (r && r.ok === false && !r.canceled) toast('Обновление не установилось: ' + (r.error || ''), { kind: 'err' });
    },
  );
}

// Проверка обновления. Молчит при неудаче и при свежей версии — фоновая проверка не должна
// дёргать пользователя; `manual` = нажали кнопку в «О программе», там результат нужен всегда.
async function checkForUpdate({ manual = false } = {}) {
  if (!manual && updMode() === 'off') return { error: 'проверка выключена' };
  let r;
  try { r = await lite.update.check(); } catch (_) { r = { error: 'нет связи' }; }
  if (!r || r.error) {
    if (manual) toast('Не удалось проверить обновление: ' + ((r && r.error) || 'нет связи'), { kind: 'err' });
    return r || { error: 'нет связи' };
  }
  updateInfo = r.newer ? r : null;
  renderUpdateBadge();
  if (manual) toast(r.newer ? 'Доступна новая версия ' + r.tag : 'У вас последняя версия', { ttl: r.newer ? 5000 : 3000 });
  // Автозагрузка: качаем сразу, чтобы к моменту, когда пользователь захочет обновиться, оставалось
  // только нажать «Перезапустить» (тот самый сценарий «как в мессенджере»).
  if (r.newer && updMode() === 'auto' && r.install && r.install.canSelfUpdate && r.asset
      && updPhase.phase !== 'downloading' && updPhase.phase !== 'ready') {
    startUpdateDownload({ manual: false }).catch(() => {});
  }
  return r;
}

// ---------------------------------------------------------------- init
// ── Помодоро: мини-таймер в титлбаре + бейдж квикбара + звон смены фазы ──────────────
// Тик прилетает из main (lite.pomodoro.onTick) — движок таймера живёт там.
let pomoLast = null;
function fmtRest(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
const POMO_PHASE_SHORT = { work: 'Работа', short: 'Перерыв', long: 'Перерыв' };
function updatePomoUI(s) {
  pomoLast = s;
  const running = !!(s && s.running);
  const mini = $('#pomo-mini');
  if (mini) {
    mini.hidden = !running;
    if (running) {
      const brk = s.phase === 'short' || s.phase === 'long';
      mini.classList.toggle('break', brk);
      mini.replaceChildren(icon(s.paused ? 'pause' : 'clock', 13), el('span', 'pph', POMO_PHASE_SHORT[s.phase] || ''), el('span', 'pt', fmtRest(s.remaining)));
      mini.title = s.paused ? 'Помодоро — на паузе' : 'Помодоро';
    }
  }
  // бейдж квикбара: минуты до конца фазы (тиковый mm:ss не влезает в крошечный бейдж)
  const badge = document.querySelector('#quickbar .qb-btn[data-mod="pomodoro"] .qb-badge-pomo');
  if (badge) {
    if (running) {
      const min = Math.max(0, Math.ceil(s.remaining / 60));
      badge.textContent = min >= 1 ? String(min) : '<1';
      badge.classList.toggle('break', s.phase === 'short' || s.phase === 'long');
      badge.classList.add('show');
    } else { badge.classList.remove('show'); }
  }
}
// Короткий звон при смене фазы (WebAudio — без файлов-ассетов). Восходящий мотив → за работу,
// мягкий нисходящий → отдых.
let pomoAudioCtx = null;
function pomoChime(to) {
  try {
    pomoAudioCtx = pomoAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = pomoAudioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const notes = to === 'work' ? [523.25, 659.25, 783.99] : [659.25, 523.25, 392.0];
    let t = ctx.currentTime;
    for (const f of notes) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.24);
      t += 0.16;
    }
  } catch (_) {}
}

// ── Помодоро: оверлей отдыха над зоной терминалов ───────────────────────────────────
// Полупрозрачный слой поверх #term-body. Блокирует ВВОД человека (перехват кликов
// pointer-events + снятие фокуса с xterm), но PTY НЕ трогаем — агенты продолжают работать,
// вывод виден сквозь оверлей. Состоянием управляет main (editor:restGuard): show/обновление/hide.
// Прогресс-кольцо вокруг часов; затемнение фона усиливается к концу перерыва (доля пройдено).
let restGuardEl = null;
const REST_R = 70, REST_C = 2 * Math.PI * REST_R;
function applyRestGuard(s) {
  const host = $('#term-body');
  if (!host) return;
  if (!s || !s.show) {
    if (restGuardEl) { restGuardEl.remove(); restGuardEl = null; try { showActiveTerminal(); const r = terms.get(activeSessionId()); if (r) r.term.focus(); } catch (_) {} } // вернуть фокус терминалу после перерыва
    return;
  }
  const justAppeared = !restGuardEl;
  if (justAppeared) {
    restGuardEl = el('div', 'rest-overlay');
    restGuardEl.tabIndex = -1;
    const card = el('div', 'rest-card');
    const ringWrap = el('div', 'rest-ring');
    ringWrap.innerHTML = `<svg viewBox="0 0 160 160" class="rest-ring-svg" aria-hidden="true">
      <circle class="rest-ring-bg" cx="80" cy="80" r="${REST_R}"/>
      <circle class="rest-ring-fg" cx="80" cy="80" r="${REST_R}" stroke-dasharray="${REST_C.toFixed(1)}" stroke-dashoffset="0"/>
    </svg>`;
    const center = el('div', 'rest-ring-center');
    center.appendChild(el('div', 'rest-title'));
    center.appendChild(el('div', 'rest-clock'));
    ringWrap.appendChild(center);
    card.appendChild(ringWrap);
    card.appendChild(el('div', 'rest-sub', 'Отойдите от экрана — агенты продолжают работать'));
    const skipBtn = el('button', 'rest-skip');
    skipBtn.append(icon('skip', 16), el('span', null, 'Пропустить'));
    skipBtn.onclick = () => { try { lite.editorBus.pomodoroSkip(); } catch (_) {} };
    card.appendChild(skipBtn);
    restGuardEl.appendChild(card);
    host.appendChild(restGuardEl);
    // снять фокус с терминала, чтобы клавиатура не уходила в xterm под оверлеем
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {}
    try { restGuardEl.focus(); } catch (_) {}
  }
  const done = s.total ? Math.max(0, Math.min(1, (s.total - s.remaining) / s.total)) : 0;
  restGuardEl.querySelector('.rest-title').textContent = s.phase === 'long' ? 'Длинный перерыв' : 'Короткий перерыв';
  restGuardEl.querySelector('.rest-clock').textContent = fmtRest(s.remaining) + (s.paused ? '  ⏸' : '');
  restGuardEl.querySelector('.rest-skip').style.display = s.allowSkip ? '' : 'none';
  // кольцо «осталось»: убывает от полного к нулю
  restGuardEl.querySelector('.rest-ring-fg').style.strokeDashoffset = (REST_C * done).toFixed(1);
  // затемнение усиливается к концу перерыва (#20): 0.45 → 0.82
  restGuardEl.style.setProperty('--rest-dim', (0.45 + 0.37 * done).toFixed(2));
}

function init() {
  hydrateIcons(); // fill the static [data-icon] buttons (titlebar / pane toolbars) with SVG
  renderUpdateBadge(); // номер версии в подвале боковой карточки (+ точка «есть обновление»)
  // вивер живёт в отдельном окне (module.html#files) — в редакторе его DOM/редактор больше нет.
  applyLayout();
  applyTheme();
  applyFrame(settings);
  initGutters();
  initWindowControls();
  initMenus();
  initShell();

  // surface unexpected renderer errors instead of failing silently — toast for
  // the user, and forward to the main-process file log so crashes are diagnosable
  const logErr = (...a) => { try { lite.log('error', ...a); } catch (_) {} };
  // Любой error-тост модуля (toast(..., {kind:'err'})) уезжает в лог редактора — единая обвязка
  // ошибок фронта без правок в самих модулях. См. CLAUDE.md → «Логирование ошибок».
  setErrorSink((m) => logErr('toast', m));
  window.addEventListener('error', (e) => {
    logErr('window.error', (e.error && e.error.stack) || e.message || '', e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '');
    toast('Ошибка: ' + (e.message || (e.error && e.error.message) || 'см. F12'), { kind: 'err', ttl: 8000 });
  });
  window.addEventListener('unhandledrejection', (e) => {
    logErr('unhandledrejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
    toast('Ошибка: ' + ((e.reason && e.reason.message) || e.reason || 'промис'), { kind: 'err', ttl: 8000 });
  });
  try { lite.log('info', `UI ${APP_VERSION} started`); } catch (_) {}

  // Обновления: фаза приходит из main (загрузка живёт там и переживает перезагрузку рендерера),
  // плашка — одна кнопка на все состояния.
  { const b = $('#update-badge'); if (b) b.onclick = onUpdateBadgeClick; }
  lite.update.onState((st) => { updPhase = st || { phase: 'idle' }; renderUpdateBadge(); });
  lite.update.state().then((st) => { if (st) { updPhase = st; renderUpdateBadge(); } }).catch(() => {});
  // Первая проверка — вскоре после старта (молча, если сети нет), дальше раз в 3 часа: редактор
  // держат открытым сутками, и без периодической проверки о новой версии узнают через неделю.
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 3000);
  setInterval(() => { checkForUpdate().catch(() => {}); }, 3 * 60 * 60 * 1000);

  lite.pty.onData(({ id, data }) => {
    if (isExtTerm(id)) { const r = extTerms.get(id); if (r) r.term.write(data); return; }
    const rec = terms.get(id); // scratch-сессии маршрутизируются в своё окно (не приходят сюда)
    if (!rec) return;
    rec.term.write(data);
    if (rec.prefill) nudgePrefill(id); // ждём паузы в выводе — тогда пишем автоввод
    markActivity(id, data);
  });
  lite.pty.onExit(({ id }) => {
    if (isExtTerm(id)) { const r = extTerms.get(id); if (r) r.term.write('\r\n\x1b[90m[шелл завершён]\x1b[0m\r\n'); return; }
    const rec = terms.get(id);
    if (!rec) return;   // сессия прежней загрузки окна (или уже закрытая вкладка) — не наша
    cancelPrefill(id); rec.term.write('\r\n\x1b[90m[процесс завершён — закрой и переоткрой проект]\x1b[0m\r\n');
    clearTimeout(rec.idleTimer); rec.claude = null; stopClaudeProbe(rec);
    setProjState(id, 'quiet');
  });
  // RemoteHost — SSH-сессии (отдельный канал, не PTY): пишем вывод в соответствующий xterm.
  // Окно «Задачи» изменило список → пересчитать счётчик и освежить бейдж активных задач на квикбаре.
  try { if (lite.app && lite.app.onNotesChanged) lite.app.onNotesChanged((id) => { try { refreshNotesCount(id); } catch (_) {} }); } catch (_) {}
  // Окно «Календарь» изменило напоминания → пересчитать «требует внимания» и освежить бейдж.
  try { if (lite.app && lite.app.onAgendaChanged) lite.app.onAgendaChanged((id) => { try { refreshAgendaCount(id); } catch (_) {} }); } catch (_) {}


  // Live disk changes (fs:changed) теперь потребляет окно вивера (module-entry подписан на lite.fs.onChange).
  // Редактор остаётся источником слежения (lite.fs.watch активного проекта в doSetActive), main рассылает
  // событие и редактору, и окну вивера. В самом редакторе вивера/дерева больше нет — подписку убрали.

  $('#btn-single').addEventListener('click', toggleSingle);

  // ── Фильтр списка проектов + вход в глобальный поиск ──────────────────────────────
  {
    const q = $('#proj-filter'), clr = $('#proj-filter-clear');
    const apply = () => {
      projFilter = q.value.trim().toLowerCase();
      clr.classList.toggle('hidden', !projFilter);
      renderProjects();
    };
    q.addEventListener('input', apply);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { q.value = ''; apply(); q.blur(); }
      // Enter — открыть первый найденный проект: фильтр работает и как быстрый переключатель
      if (e.key === 'Enter') { const first = buildSections()[0]; if (first && first.list[0]) setActive(first.list[0].id); }
    });
    clr.addEventListener('click', () => { q.value = ''; apply(); q.focus(); });
    $('#proj-find').addEventListener('click', () => showGlobalSearch({ query: q.value.trim() }));
  }

  // ── Заставка «матрица» (скринсейвер) ───────────────────────────────────────────────
  // Полноэкранный canvas-«дождь» зелёных глифов. Кнопка в шапке (вкл/выкл вручную) +
  // авто-запуск по бездействию во ВСЕХ окнах (координирует main: активность в любом окне
  // сбрасывает таймер, main шлёт screensaver:set). Ручной запуск гасится только кнопкой/Esc,
  // авто — любым действием. Цвет — токен темы (--green).
  const matrix = matrixCtl = (() => {
    const cv = $('#matrix-overlay'); const btn = $('#btn-matrix');
    if (!cv) return { toggle() {}, start() {}, stop() {}, dismissIfAuto() {} };
    const ctx = cv.getContext('2d');
    const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノﾊﾋﾌﾍﾎ0123456789:."=*+-<>¦｜LITEAI';
    const FS = 16;
    const STEP_MS = 75; // шаг анимации по времени (а не каждый кадр RAF ~16мс) → спокойнее в ~4–5 раз
    let raf = null, cols = 0, drops = [], active = false, auto = false, lastStep = 0;
    const green = () => (getComputedStyle(document.body).getPropertyValue('--green') || '').trim() || '#3ad353';
    function resize() { cv.width = window.innerWidth; cv.height = window.innerHeight; cols = Math.ceil(cv.width / FS); drops = new Array(cols).fill(0).map(() => Math.floor(Math.random() * cv.height / FS)); }
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      if (ts - lastStep < STEP_MS) return; // продвигаем дождь только раз в STEP_MS — медленно и плавно
      lastStep = ts;
      ctx.fillStyle = 'rgba(0,0,0,0.07)'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = FS + 'px monospace'; const g = green();
      for (let i = 0; i < cols; i++) {
        const x = i * FS, y = drops[i] * FS;
        ctx.fillStyle = '#d7ffe0'; ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y);   // яркая голова струи
        ctx.fillStyle = g; ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y - FS);       // хвост — зелёный
        if (y > cv.height && Math.random() > 0.975) drops[i] = 0; else drops[i]++;
      }
    }
    function start(isAuto) {
      if (active) { if (!isAuto) auto = false; return; }
      active = true; auto = !!isAuto;
      cv.classList.remove('hidden'); resize();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
      window.addEventListener('resize', resize);
      raf = requestAnimationFrame(frame);
      if (btn) btn.classList.add('on');
    }
    function stop() {
      if (!active) return; active = false; auto = false;
      if (raf) cancelAnimationFrame(raf); raf = null;
      cv.classList.add('hidden'); window.removeEventListener('resize', resize);
      if (btn) btn.classList.remove('on');
    }
    cv.addEventListener('mousedown', stop); // клик по заставке — выйти
    try { lite.screensaver.onSet(({ on }) => { if (on) start(true); else if (auto) stop(); }); } catch (_) {}
    return { toggle: () => (active ? stop() : start(false)), start: () => start(false), stop, dismissIfAuto: () => { if (active && auto) stop(); } };
  })();
  if ($('#btn-matrix')) $('#btn-matrix').addEventListener('click', () => matrix.toggle());
  // Репорт активности в main (троттл) + мгновенный сброс авто-заставки на любое действие.
  let __ssActReport = 0;
  function reportUserActivity() {
    matrix.dismissIfAuto();
    const now = Date.now();
    if (now - __ssActReport > 1500) { __ssActReport = now; try { lite.screensaver.activity(); } catch (_) {} }
  }
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, reportUserActivity, { passive: true });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') matrix.stop(); });
  // scratch (системный терминал) живёт в окне модуля — кнопки привязывает module-entry.js.
  // вивер+дерево (files) живут в окне модуля — их DOM/кнопки строит Files.mount() в module-entry.js.
  // git живёт в окне модуля (module.html) — кнопки привязывает module-entry.js.
  // doc (обработка текста) живёт в окне модуля — кнопки привязывает module-entry.js.
  // tools/iterflow/seo/audit/notes живут в окнах модулей (module.html) — их кнопки привязывает module-entry.js.
  // docker (контейнеры), db, rh (удалённые хосты) живут в окнах модулей — кнопки привязывает module-entry.js.
  // Действия из окон модулей: «послать текст в терминал» обрабатывает редактор (терминалы тут); «открыть
  // файл в вивере»/«обновить дерево» main маршрутизирует в окно вивера (не сюда).
  lite.editorBus.onSendToTerminal((text) => { const p = activeProject(); if (p) sendNoteToTerminal(p, text); });
  lite.editorBus.onSendNoteToTerminal((projId, text) => { const proj = projects.find((x) => x.id === projId) || activeProject(); if (proj) sendNoteToTerminal(proj, text); });
  lite.editorBus.onRefreshProjects(() => { try { renderProjects(); } catch (_) {} }); // git в окне вивера сделал commit/checkout → освежить бейджи
  lite.editorBus.onRestGuard((s) => { try { applyRestGuard(s); } catch (e) { console.error(e); } }); // Помодоро: оверлей отдыха над терминалами
  lite.pomodoro.onTick((s) => { try { updatePomoUI(s); } catch (_) {} });        // мини-таймер в титлбаре + бейдж квикбара
  lite.pomodoro.onChime(({ to }) => { try { pomoChime(to); } catch (_) {} });     // звон смены фазы
  // Набор открытых окон-модулей → подсветка кнопок квикбара (идея 3).
  try { if (lite.module && lite.module.onOpenSet) lite.module.onOpenSet((ids) => { openModuleIds = new Set(ids || []); markOpenModules(); }); } catch (_) {}
  { const mini = $('#pomo-mini'); if (mini) mini.onclick = (e) => { e.stopPropagation(); showPomoMenu(mini); }; }
  lite.pomodoro.getState().then((s) => updatePomoUI(s)).catch(() => {});          // стартовый снимок (таймер мог идти до открытия редактора)
  $('#term-clear').addEventListener('click', () => clearTerminal());
  $('#term-restart').addEventListener('click', () => restartTerminal());
  // Панель вкладок терминалов: статичная «+» (всегда видна) + стрелки-прокрутка при переполнении.
  $('#term-tab-add').addEventListener('click', () => addTab());
  $('#term-tabs-prev').addEventListener('click', () => scrollTabs(-1));
  $('#term-tabs-next').addEventListener('click', () => scrollTabs(1));
  $('#term-tabs').addEventListener('scroll', () => { updateTabScroll(); hideTabTip(); });
  window.addEventListener('resize', updateTabScroll);
  // бейдж «N ждёт ответа»: клик — к следующему ждущему агенту (по кругу, если ждут несколько)
  $('#attention-badge').addEventListener('click', () => {
    const waiting = [...projState.entries()].filter(([, s]) => s === 'waiting').map(([sid]) => sid).filter((sid) => terms.has(sid));
    if (!waiting.length) return;
    const cur = waiting.indexOf(activeSessionId());
    const sid = waiting[(cur + 1) % waiting.length];
    const rec = terms.get(sid);
    setActive(rec.projId); switchTab(sid);
  });

  // terminal search box
  $('#term-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runTermSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
  });
  $('#term-search-next').addEventListener('click', () => runTermSearch(1));
  $('#term-search-prev').addEventListener('click', () => runTermSearch(-1));
  $('#term-search-close').addEventListener('click', closeTermSearch);

  // OpenRouter (чат) живёт в окне модуля — bindControls/bindStream вызывает module-entry.js.

  // Esc-выход из полноэкранного превью и Ctrl+S сохранения файла живут в окне вивера (его keydown).
  // Глобальные хоткеи — через единый реестр HOTKEYS (тот же, что перехватывает фабрика терминалов).
  document.addEventListener('keydown', (e) => { runGlobalHotkey(e); });

  // drag a folder onto the window to open it as a project (рамка-подсказка, пока тащат файлы снаружи)
  let dropZone = null, dropT = null;
  const hideDrop = () => { clearTimeout(dropT); if (dropZone) { dropZone.remove(); dropZone = null; } };
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (favDragCard || !e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
    if (!dropZone) {
      dropZone = el('div', 'dropzone');
      const c = el('div', 'dz-card');
      c.append(icon('folder-plus', 30), el('b', null, 'Отпустите, чтобы открыть папку как проект'), el('span', null, 'появится слева, поднимется его терминал'));
      dropZone.appendChild(c);
      document.body.appendChild(dropZone);
    }
    clearTimeout(dropT); dropT = setTimeout(hideDrop, 180);   // dragleave у окна ненадёжен — гасим по тишине
  });
  document.addEventListener('drop', (e) => {
    hideDrop();
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = f.path || lite.pathForFile(f);
    if (p) openByPath(p, baseName(p));
  });

  let rezTimer;
  new ResizeObserver(() => { clearTimeout(rezTimer); rezTimer = setTimeout(() => refitActiveTerminal(), 80); }).observe($('#terminal-pane'));
  // scratch/rh ресайз теперь в окнах модулей — обрабатывается module-entry.js.


  applyFontSize();
  projects = loadProjectsFromDisk();
  renderProjects();
  // Конфиг синхронизации меняется руками и редко — раз в полминуты достаточно.
  refreshSynced();
  setInterval(refreshSynced, 30000);
  // Окно перезагрузилось (падение, импорт настроек), а терминалы прежней страницы живы — забираем их:
  // агенты продолжают работать. Терминалы закрытых с тех пор проектов гасим.
  lite.pty.adoptable().catch(() => []).then((ids) => {
    for (const id of (Array.isArray(ids) ? ids : [])) {
      const pid = String(id).split('::')[0];
      if (!projects.some((p) => p.id === pid)) { lite.pty.kill(id); continue; }
      if (!adoptPtys.has(pid)) adoptPtys.set(pid, []);
      adoptPtys.get(pid).push(id);
    }
    const tabNo = (id) => { const m = /::t(\d+)\./.exec(id); return m ? +m[1] : 0; };
    for (const list of adoptPtys.values()) list.sort((a, b) => tabNo(a) - tabNo(b));
    let first = projects.length ? projects[0].id : null;
    if (adoptPtys.size) {
      let last = null;
      try { last = sessionStorage.getItem('lite.activeProject'); } catch (_) {}
      if (last && projects.some((p) => p.id === last)) first = last;       // вернуться туда, где были до перезагрузки
    }
    // вкладки всех подхваченных проектов — до выбора активного: showActiveTerminal спрячет лишние,
    // иначе они остались бы видны и просвечивали сквозь прозрачный фон активного
    for (const pid of [...adoptPtys.keys()]) {
      const p = projects.find((x) => x.id === pid);
      if (p) ensureProjectTabs(p);
    }
    if (first) setActive(first);
    else showActiveTerminal();
  });

  // Набор открытых окон модулей (включая вивер) восстанавливает main (moduleWins.__open) при старте —
  // правому слоту редактора восстанавливать больше нечего (там остались только «Мои модули» по запросу).

  scanProjects();          // add subfolders of settings.scanDirs (non-blocking)
  checkProjectsExistence();
  window.addEventListener('focus', checkProjectsExistence); // re-check when returning to the app
  window.addEventListener('focus', () => refreshGitChip(300)); // ветка/изменения могли поменяться снаружи
  lite.fs.onChange(() => refreshGitChip(1200));              // файлы активного проекта меняются — пересчитать чип git

  if (!settings.onboarded) setTimeout(showOnboarding, 200); // first-run welcome
  autoLaunchModules();
}

// Открыть окна модулей, отмеченных галочкой в списке встроенных. С задержкой — стартовать
// одновременно с главным окном незачем, оно должно отрисоваться первым. Повторный openModule
// безопасен: на тип модуля окно одно, уже восстановленное просто получит фокус.
function autoLaunchModules() {
  const ids = (settings.autoLaunchMods || []).filter((id) => WINDOW_MODULES.has(id));
  if (!ids.length) return;
  setTimeout(() => { ids.forEach((id, i) => setTimeout(() => { try { openModule(id); } catch (_) {} }, i * 120)); }, 600);
}

function cycleProject(dir) {
  if (projects.length < 2) return;
  const i = projects.findIndex((p) => p.id === activeId);
  const next = projects[(i + dir + projects.length) % projects.length];
  if (next) setActive(next.id);
}

initI18n();   // словарь приходит синхронно из main → интерфейс сразу на выбранном языке
init();
