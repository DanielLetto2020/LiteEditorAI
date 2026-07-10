// LiteEditor renderer — projects, per-project terminal, viewer, file tree,
// custom titlebar, menu, modals. Talks to the backend only via window.lite.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';

// CodeMirror/marked/showMinimap/codeedit — переехали в окно вивера (renderer/modules/files.js).
// В ядре остались только терминал (xterm) + темы/термутилы.
import { THEMES, TERM_THEME, DEFAULT_THEME } from './themes.js';
import { loadFastRenderer, applyUnicode11, copySelection } from './termutil.js';
// initTextProc — «Обработка текста» мигрирована в отдельное окно (renderer/module-entry.js).
import { el, icon, iconBtn, hydrateIcons, toast, makeModal, showConfirm, showPrompt, baseName, ICONS, setErrorSink } from './ui.js';
// initGit — модуль «Git» мигрирован в отдельное окно (renderer/module-entry.js).
// initCtx — модуль «Контекст» мигрирован в отдельное окно (renderer/module-entry.js).
// initContainers — модуль «Контейнеры» мигрирован в отдельное окно (renderer/module-entry.js).
// initDb — модуль «Базы данных» мигрирован в отдельное окно (renderer/module-entry.js).
// initRh — модуль «Удалённые хосты» мигрирован в отдельное окно (renderer/module-entry.js).
// initNotes / initAudit / initSeo / initTools / initIterflow — модули мигрированы в отдельные окна (renderer/module-entry.js).
// initOpenRouter — чат мигрирован в отдельное окно (renderer/module-entry.js).
import { initExtensions } from './modules/extensions.js';
// initFiles — вивер+дерево мигрированы в отдельное окно (renderer/module-entry.js).

const APP_VERSION = 'alpha v1.1.50';
const GUTTER = 5;
// Системный терминал («Система · ~») мигрирован в отдельное окно (renderer/modules/scratch.js):
// его id `__scratch__::tN` маршрутизируются main'ом в окно-владельца, в ядре их больше не обрабатываем.

const lite = window.lite;
const $ = (sel) => document.querySelector(sel);
// el/svgEl/иконки/тосты/модалки/baseName переехали в ui.js (этап «модульный рефакторинг»).

// ---------------------------------------------------------------- global store (~/.LiteEditor)
// Synchronous snapshot loaded once; reads are in-memory, writes go through to disk.
const STORE = lite.store.loadAll();
function persist(key, value, sync = false) { 
  STORE[key] = value; 
  if (sync) {
    try { lite.store.setSync(key, value); } catch (_) { lite.store.set(key, value); }
  } else {
    lite.store.set(key, value); 
  }
}
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
const DEFAULT_SETTINGS = { notifications: true, sound: false, idleMs: 1200, fontSize: 13, workingDir: '', scanDirs: [], theme: 'neumorphism', onboarded: false, shell: '', minimap: true, notesTab: 'project' };
function loadSettings() { return { ...DEFAULT_SETTINGS, ...(STORE.settings || {}) }; }
let settings = loadSettings();
function saveSettings() { persist('settings', settings); }

// ---------------------------------------------------------------- state
let projects = [];
let activeId = null;
const terms = new Map();          // sessionId -> { term, fit, search, container, projId, name, ... }
const tabsByProj = new Map();     // projId -> { sessions: [sessionId...], active: sessionId }
let sessionSeq = 0;
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

const DEFAULT_LAYOUT = { sidebar: 240, viewer: 520, tree: 240, scratch: 420, ctx: 740, docker: 460, db: 560, rh: 520, ext: 420, notes: 480, audit: 460, iterflow: 480, seo: 480, tools: 560, chat: 600, doc: 640 };
let layout = loadLayout();
let lastParent = STORE.lastParent || '';

// TERM_THEME/THEMES/DEFAULT_THEME вынесены в renderer/themes.js (общий реестр редактора и окон модулей).
function termTheme() {
  const t = THEMES[settings.theme] || THEMES[DEFAULT_THEME];
  return { ...TERM_THEME, ...t.term };
}
function applyTheme() {
  const name = THEMES[settings.theme] ? settings.theme : DEFAULT_THEME;
  document.body.dataset.theme = name; // always set; index.html ships data-theme too so there's no flash
  for (const rec of terms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  for (const rec of extTerms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  try { Ext.notifyTheme(name); } catch (_) {} // пользовательские модули: ctx.theme.onChange
  try { lite.app.settingsChanged(settings); } catch (_) {} // окна модулей: применить тему/настройки
}

const activeProject = () => projects.find((p) => p.id === activeId);

// ---------------------------------------------------------------- persistence
function saveProjects() { persist('projects', projects); }
function loadProjectsFromDisk() { return Array.isArray(STORE.projects) ? STORE.projects : []; }
function loadLayout() { return { ...DEFAULT_LAYOUT, ...(STORE.layout || {}) }; }
function saveLayout() { persist('layout', layout); }
function applyLayout() {
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
const ARCHIVE = 'Архив'; // спец-категория: всегда последняя, без перестановки стрелками, свёрнута по дефолту
function loadCategories() { return Array.isArray(STORE.categories) ? STORE.categories : []; }
function saveCategories(c) { persist('categories', c); }
function isCollapsed(key) { return !!(STORE.accordions || {})[key]; }
function setCollapsed(key, v) { persist('accordions', { ...(STORE.accordions || {}), [key]: v }); }
function loadSectionOrder() { return Array.isArray(STORE.sectionOrder) ? STORE.sectionOrder.slice() : null; }
function saveSectionOrder(o) { persist('sectionOrder', o); }

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
    order = stored.filter((k) => keys.includes(k) && k !== ARCHIVE);
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
  const favs = projects.filter((p) => p.favorite);
  return effectiveOrder().map((key) => {
    if (key === FAV_KEY) return favs.length ? { key, label: 'Избранное', list: favs, pinned: true } : null;
    if (key === UNCATEGORIZED) return { key, label: UNCATEGORIZED, pinned: false, list: projects.filter((p) => !p.favorite && !cats.includes(p.category)) };
    if (key === ARCHIVE) { const list = projects.filter((p) => !p.favorite && p.category === ARCHIVE); return list.length ? { key, label: 'Архив', list, pinned: false } : null; }
    return { key, label: key, pinned: false, list: projects.filter((p) => !p.favorite && p.category === key) };
  }).filter(Boolean);
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

function renderProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  const sections = buildSections();
  sections.forEach((s, i) => box.appendChild(renderSection(s, i, sections)));
  // OpenRouter (ключи) и «Обработка текста» (документы) больше НЕ в сайдбаре — их списки живут
  // вкладками внутри своих панелей правого слота (открываются через квикбар/меню «Модули»).
  renderMiniRail();
}
// OpenRouter section — fixed group (no reorder arrows), like a special category.
// Cards here aren't real projects: deletion lives only in the OpenRouter modal.
function renderSection(s, index, sections) {
  const total = sections.length;
  const { label, key, list, pinned } = s;
  const sec = el('div', 'pgroup' + (pinned ? ' pinned' : ''));
  const collapsed = isCollapsed(key);
  const head = el('div', 'pgroup-head');
  const chev = el('span', 'pgroup-chev');
  chev.appendChild(icon(collapsed ? 'chevron-right' : 'chevron-down', 15));
  head.appendChild(chev);
  head.appendChild(el('span', 'pgroup-name', label));
  head.appendChild(el('span', 'pgroup-count', String(list.length)));
  const tools = el('div', 'pgroup-tools');
  const isCustomCat = key !== FAV_KEY && key !== UNCATEGORIZED && key !== ARCHIVE;
  if (isCustomCat) { // видимая кнопка переименования (плюс ПКМ-меню)
    const ren = iconBtn('pgroup-arrow', 'pencil', 'Переименовать категорию');
    ren.addEventListener('click', (e) => { e.stopPropagation(); renameCategory(key); });
    tools.appendChild(ren);
  }
  const nextIsArchive = sections[index + 1] && sections[index + 1].key === ARCHIVE;
  const up = iconBtn('pgroup-arrow', 'chevron-up', 'Выше'); up.disabled = index === 0 || key === ARCHIVE;
  const down = iconBtn('pgroup-arrow', 'chevron-down', 'Ниже'); down.disabled = index === total - 1 || key === ARCHIVE || nextIsArchive;
  up.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, -1); });
  down.addEventListener('click', (e) => { e.stopPropagation(); moveSection(key, +1); });
  tools.appendChild(up); tools.appendChild(down);
  head.appendChild(tools);
  const body = el('div', 'pgroup-body');
  if (collapsed) body.style.display = 'none';
  head.addEventListener('click', () => {
    const now = !isCollapsed(key); setCollapsed(key, now);
    body.style.display = now ? 'none' : 'block';
    chev.replaceChildren(icon(now ? 'chevron-right' : 'chevron-down', 15));
  });
  if (key !== FAV_KEY && key !== UNCATEGORIZED && key !== ARCHIVE) // custom categories can be renamed/deleted (Архив — нет)
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); showCategoryMenu(e.clientX, e.clientY, key); });
  for (const p of list) body.appendChild(makeCard(p));
  sec.appendChild(head); sec.appendChild(body);
  return sec;
}
function makeCard(p) {
  const card = el('div', 'card');
  card.dataset.id = p.id;
  if (p.id === activeId) card.classList.add('active');
  if (missing.has(p.id)) card.classList.add('missing');
  if (p.accent) { card.classList.add('accented'); card.style.setProperty('--card-accent', p.accent); } // весь бордер + усиленная левая полоса

  const head = el('div', 'card-head');
  const ind = el('span', 'pind ' + projAggState(p.id));
  ind.dataset.id = p.id;
  ind.title = 'Спиннер — работает · янтарный — ждёт ответа · точка — готов';
  const title = el('span', 'card-title', p.name);
  title.title = p.path;
  const star = iconBtn('card-star' + (p.favorite ? ' on' : ''), 'star', p.favorite ? 'Убрать из избранного' : 'В избранное', 15);
  star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(p.id); });
  // Вивер/Git/задачи и пр. модули — в квикбаре под терминалом; на карточке только ★ и ⋮ (всегда видимы).
  const kebab = iconBtn('card-kebab', 'dots-v', 'Меню проекта', 18);
  kebab.addEventListener('click', (e) => { e.stopPropagation(); showCardMenu(e.clientX, e.clientY, p); });
  const acts = el('div', 'card-acts');
  acts.append(star, kebab);
  const tail = el('div', 'card-tail');
  tail.append(acts);
  head.append(ind, title, tail);
  card.appendChild(head);

  // путь не дублируем на карточке — он в тултипе имени и в ⋮-меню («Копировать путь»)
  if (missing.has(p.id)) {
    const w = el('div', 'card-missing'); w.appendChild(icon('warning', 13)); w.appendChild(el('span', null, 'папка удалена — закрой проект'));
    card.appendChild(w);
  }

  card.addEventListener('click', () => focusProject(p.id));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e.clientX, e.clientY, p); });
  return card;
}
// Клик по карточке проекта → выбрать его (чат/документ теперь живут отдельной панелью справа).
function focusProject(id) {
  setActive(id);
}

// ---------------------------------------------------------------- OpenRouter chat UI
// Вынесен в renderer/modules/openrouter.js (const Or — у блока состояния чата выше).
// ---------------------------------------------------------------- remote pult modal
function showRemote() {
  closeMenus();
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">📱</span> Удалённый пульт</h2>
    <div class="about-desc">
      Управляй терминалом и вкладками ПК с Android-планшета через интернет.
      Укажи <b>хост релея</b> (свой self-hosted сервер), зарегистрируй на нём аккаунт
      здесь, в редакторе, затем в приложении-пульте укажи тот же хост и войди тем же
      логином и паролем. Свой релей можно поднять на VPS — инструкция в папке
      <code>relay/</code> репозитория.
    </div>
    <div class="or-add" id="rmt-body"></div>
    <div class="modal-actions"><button class="btn" id="rmt-close">Закрыть</button></div>`);
  const realClose = () => { clearInterval(timer); close(); };
  m.querySelector('#rmt-close').onclick = realClose;
  const body = m.querySelector('#rmt-body');

  function field(labelText, type) {
    const f = el('div', 'field');
    f.appendChild(el('label', '', labelText));
    const inp = document.createElement('input');
    inp.type = type; inp.autocomplete = 'off'; inp.spellcheck = false;
    f.appendChild(inp);
    return { f, inp };
  }

  let mode = null;      // 'auth' | 'account' — перестраиваем только при СМЕНЕ режима
  let statusEl = null;  // строка статуса в режиме «вошли» — её обновляем по таймеру (без пересборки полей)

  function statusText(st) { return st.connected ? '● На связи' : (st.enabled ? '○ Подключение…' : '○ Выключено'); }

  function buildAuth(st) {
    body.innerHTML = '';
    const hostF = field('Хост релея', 'text');
    hostF.inp.placeholder = 'relay.example.com';
    hostF.inp.value = (st && st.host) || '';
    const login = field('Логин', 'text');
    const pass = field('Пароль', 'password');
    const err = el('div', 'err');
    const actions = el('div', 'modal-actions');
    const reg = el('button', 'btn', 'Зарегистрироваться');
    const inb = el('button', 'btn primary', 'Войти');
    actions.appendChild(reg); actions.appendChild(inb);
    body.appendChild(hostF.f); body.appendChild(login.f); body.appendChild(pass.f); body.appendChild(err); body.appendChild(actions);
    const run = async (fn) => {
      err.textContent = '';
      const h = hostF.inp.value.trim(), l = login.inp.value.trim(), p = pass.inp.value;
      if (!h) { err.textContent = 'Укажите хост релея'; return; }
      if (l.length < 3 || p.length < 4) { err.textContent = 'Логин ≥3, пароль ≥4 символа'; return; }
      reg.disabled = inb.disabled = true;
      let res; try { res = await fn(l, p, h); } catch (_) { res = { ok: false, error: 'Нет связи с релеем' }; }
      reg.disabled = inb.disabled = false;
      if (res.ok) { toast('Пульт: вошли как ' + res.status.login); tick(); }
      else err.textContent = res.error || 'Ошибка';
    };
    inb.onclick = () => run((l, p, h) => lite.remote.login(l, p, h));
    reg.onclick = () => run((l, p, h) => lite.remote.register(l, p, h));
    pass.inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inb.click(); });
    setTimeout(() => (hostF.inp.value ? login.inp : hostF.inp).focus(), 30);
  }

  function buildAccount(st) {
    body.innerHTML = '';
    const who = el('div', 'rmt-info');
    who.appendChild(el('span', '', 'Вошли как: '));
    who.appendChild(el('b', '', st.login));
    statusEl = el('div', '', statusText(st));
    statusEl.style.color = st.connected ? 'var(--green-bright)' : 'var(--warn)';
    statusEl.style.margin = '8px 0';
    const tgl = el('label', '');
    tgl.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin:8px 0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = st.enabled;
    tgl.appendChild(cb); tgl.appendChild(el('span', '', 'Пульт включён'));
    cb.onchange = async () => { await lite.remote.setEnabled(cb.checked); tick(); };
    const hint = el('div', 'about-desc');
    hint.appendChild(el('span', '', 'На планшете в приложении «LiteEditor Пульт» войди логином '));
    hint.appendChild(el('b', '', st.login));
    hint.appendChild(el('span', '', ' и тем же паролем. Открой здесь хотя бы один терминал, чтобы он появился на пульте.'));
    // Безопасность: «выйти на всех устройствах» — на случай потери планшета. Снимает одобрение
    // со всех пультов аккаунта (потребуют повторного одобрения); этот ПК остаётся в системе.
    const sec = el('div', 'about-desc');
    sec.style.marginTop = '6px';
    sec.appendChild(el('span', '', 'Потеряли планшет с пультом? Отключите все устройства — свои переодобрите заново.'));
    const revoke = el('button', 'btn', '⎋ Выйти на всех устройствах');
    revoke.style.cssText = 'margin-top:6px;color:var(--danger);border-color:var(--danger)';
    revoke.onclick = () => showConfirm(
      'Выйти на всех устройствах?',
      'Все одобренные пульты будут отключены и потребуют повторного одобрения на ПК. Используйте при потере устройства. Этот ПК останется в системе.',
      'Выйти везде',
      async () => {
        const r = await lite.remote.revokeAllDevices();
        toast(r && r.ok ? 'Все устройства отключены — переодобрите свои заново' : 'Ошибка: ' + ((r && r.error) || ''));
      },
    );
    const actions = el('div', 'modal-actions');
    const out = el('button', 'btn', 'Выйти');
    out.onclick = async () => { await lite.remote.logout(); tick(); };
    actions.appendChild(out);
    body.appendChild(who); body.appendChild(statusEl); body.appendChild(tgl); body.appendChild(hint);
    body.appendChild(sec); body.appendChild(revoke); body.appendChild(actions);
  }

  async function tick() {
    if (!document.body.contains(body)) { clearInterval(timer); return; }
    let st; try { st = await lite.remote.status(); } catch (_) { return; }
    if (!document.body.contains(body)) return;
    const want = st.loggedIn ? 'account' : 'auth';
    if (want !== mode) {
      mode = want;
      statusEl = null;
      if (want === 'auth') buildAuth(st); else buildAccount(st);
    } else if (mode === 'account' && statusEl) {
      // Тот же режим — НЕ пересобираем (иначе терялся бы фокус/ввод), только статус.
      statusEl.textContent = statusText(st);
      statusEl.style.color = st.connected ? 'var(--green-bright)' : 'var(--warn)';
    }
  }
  const timer = setInterval(tick, 2500);
  tick();
}

// --- Подключённые пульты: бейдж у версии + модалка управления ------------------
// Список живёт в main (remote.js считает устройства по peer/hello); сюда прилетает
// push-событием remote:pults. «Отключить» = device id в блок-листе (стор pultBlocked)
// + адресный kick — устройство не удаляется, доступ возвращается кнопкой.
let pultsState = { list: [], blocked: [] };
function updatePultBadge() {
  const b = $('#pult-badge'); if (!b) return;
  const n = (pultsState.list || []).length;
  const blocked = (pultsState.blocked || []).length;
  b.textContent = '📱 ' + n;
  b.classList.toggle('on', n > 0);
  b.hidden = n === 0 && blocked === 0;
  b.title = n ? ('Подключено пультов: ' + n) : 'Пульты (есть отключённые устройства)';
}
async function refreshPults() {
  try { const st = await lite.remote.pults(); if (st) pultsState = st; } catch (_) {}
  updatePultBadge();
}
function showPults() {
  // offPults/offSys присваиваются ниже; onClose сработает на ЛЮБОМ пути закрытия (кнопка/Esc/фон) → отписка гарантирована
  let offPults = null, offSys = null;
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">📱</span> Пульты</h2>
    <div class="about-desc">Устройства, подключённые к редактору. «Отключить» выключает доступ,
      не удаляя устройство — доступ можно вернуть здесь же. Сисинфо и местоположение пульт
      присылает по запросу (гео — с разрешения на устройстве).</div>
    <div class="or-add" id="plt-body"></div>
    <div class="modal-actions"><button class="btn" id="plt-close">Закрыть</button></div>`,
    () => { try { offPults && offPults(); offSys && offSys(); } catch (_) {} });
  const body = m.querySelector('#plt-body');
  const sysBoxes = {};   // device → <pre> под ответ сисинфо/гео

  function fmtSince(ts) { try { return new Date(ts).toLocaleTimeString(); } catch (_) { return ''; } }
  function render() {
    body.innerHTML = '';
    const blocked = pultsState.blocked || [];
    const online = pultsState.list || [];
    if (!online.length && !blocked.length) { body.appendChild(el('div', 'about-desc', 'Сейчас ни один пульт не подключён.')); return; }
    const row = (device, info, isOnline) => {
      const r = el('div', '');
      r.style.cssText = 'border:1px solid var(--border);border-radius:10px;padding:10px;margin:8px 0';
      const head = el('div', '');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
      const dot = el('span', '', isOnline ? '●' : '○');
      dot.style.color = isOnline ? 'var(--green-bright)' : 'var(--text-mute)';
      const nm = el('b', '', (info && info.name) || 'Пульт');
      const meta = el('span', '', (info && info.ver ? 'v' + info.ver + ' · ' : '')
        + String(device).slice(0, 10) + '…'
        + (isOnline && info && info.since ? ' · на связи с ' + fmtSince(info.since) : ''));
      meta.style.cssText = 'color:var(--text-mute);font-size:11px';
      head.appendChild(dot); head.appendChild(nm); head.appendChild(meta);
      const actions = el('div', '');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center';
      const isBlocked = blocked.includes(device);
      if (isOnline) {
        const ask = (what, label) => {
          let pre = sysBoxes[device];
          if (!pre) {
            pre = document.createElement('pre');
            pre.style.cssText = 'margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-size:11px;'
              + 'max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;color:var(--text-mute)';
            r.appendChild(pre);
            sysBoxes[device] = pre;
          }
          pre.textContent = label + ': запрошено, ждём ответ пульта…';
          lite.remote.pultSysInfo(device, what);
        };
        const si = el('button', 'btn', 'Сисинфо');
        si.onclick = () => ask('info', 'Сисинфо');           // без запроса геолокации — на пульте не всплывёт пермишен
        const ge = el('button', 'btn', 'Гео');
        ge.onclick = () => ask('geo', 'Гео');
        actions.appendChild(si); actions.appendChild(ge);
      }
      const tg = el('button', 'btn' + (isBlocked ? ' primary' : ''), isBlocked ? 'Вернуть доступ' : 'Отключить');
      tg.onclick = async () => {
        try {
          const st = await (isBlocked ? lite.remote.pultUnblock(device) : lite.remote.pultBlock(device));
          if (st) pultsState = st;
        } catch (_) {}
        updatePultBadge(); render();
      };
      actions.appendChild(tg);
      if (isBlocked) {
        const bb = el('span', '', 'доступ отключён');
        bb.style.cssText = 'color:var(--warn);font-size:11px';
        actions.appendChild(bb);
      }
      r.appendChild(head); r.appendChild(actions);
      body.appendChild(r);
    };
    for (const p of online) row(p.device, p, true);
    for (const d of blocked) { if (!online.some((p) => p.device === d)) row(d, null, false); }
  }
  // Живое обновление, пока модалка открыта (подключения/отключения и ответы сисинфо).
  offPults = (lite.remote && lite.remote.onPults)
    ? lite.remote.onPults((st) => { if (st) pultsState = st; updatePultBadge(); render(); }) : null;
  offSys = (lite.remote && lite.remote.onSysInfo)
    ? lite.remote.onSysInfo((msg) => {
      const pre = sysBoxes[msg.device]; if (!pre) return;
      let txt = '';
      const loc = msg.loc;
      if (loc && typeof loc.lat === 'number') {
        txt += 'Гео: ' + loc.lat.toFixed(5) + ', ' + loc.lon.toFixed(5) + ' (±' + Math.round(loc.acc || 0) + ' м)\n'
          + 'https://maps.google.com/?q=' + loc.lat + ',' + loc.lon + '\n\n';
      } else if (loc && loc.error) {
        txt += 'Гео: ' + loc.error + '\n\n';
      }
      pre.textContent = (txt + (msg.info || '')).trim() || 'Пульт прислал пустой ответ.';
    }) : null;
  m.querySelector('#plt-close').onclick = () => close();   // отписка — в onClose модалки (срабатывает и на Esc/фон)
  render();
  refreshPults().then(render).catch(() => {});
}

function toggleFavorite(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  p.favorite = !p.favorite;
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

// kebab/right-click project menu (two pages: actions ↔ move-to-category)
function showCardMenu(x, y, p) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '210px';
  dd.addEventListener('click', (e) => e.stopPropagation());
  buildCardMenuMain(dd, p);
  placeMenu(dd, x, y);
}
function buildCardMenuMain(dd, p) {
  dd.innerHTML = '';
  dd.appendChild(menuRow('folder', 'Открыть в проводнике', () => { closeMenus(); lite.openInFileManager(p.path); }));
  dd.appendChild(menuRow('copy', 'Копировать путь', () => { closeMenus(); lite.copyText(p.path); toast('Путь скопирован'); }));
  dd.appendChild(menuRow('star', p.favorite ? 'Убрать из избранного' : 'В избранное', () => { closeMenus(); toggleFavorite(p.id); }));
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
    if (order) saveSectionOrder(order.map((k) => (k === old ? name : k)));
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
    <h2>✚ Новая категория</h2>
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
    moveToCategory(id, name);
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
      if (known.has(ent.path) || dismissed.has(ent.path)) continue;
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
  if (sid) lite.pty.write(sid, text); // no trailing newline — review, then press Enter yourself
}

// Compact project switcher for single-terminal mode: indicator + name, click switches.
function renderMiniRail() {
  const rail = $('#mini-rail');
  rail.innerHTML = '';
  for (const p of projects) {
    const btn = el('button', 'rail-btn');
    if (p.id === activeId) btn.classList.add('active');
    btn.title = p.name;
    const ind = el('span', 'pind ' + projAggState(p.id));
    ind.dataset.id = p.id;
    btn.appendChild(ind);
    btn.appendChild(el('span', 'rail-name', p.name));
    btn.addEventListener('click', () => setActive(p.id));
    rail.appendChild(btn);
  }
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
      if (rec) { clearTimeout(rec.idleTimer); try { rec.term.dispose(); } catch (_) {} rec.container.remove(); terms.delete(sid); }
      projState.delete(sid);
    }
    tabsByProj.delete(id);
  }
  const pt = { ...(STORE.projTabs || {}) }; delete pt[id]; persist('projTabs', pt);
  missing.delete(id);
  projects = projects.filter((p) => p.id !== id);
  saveProjects();
  if (activeId === id) {
    activeId = null;
    if (projects.length) setActive(projects[0].id);
    else { renderProjects(); showActiveTerminal(); } // нет проектов → окно вивера отреагирует на app:activeProject=null
  } else {
    renderProjects();
  }
}

// Flag projects whose folder was deleted on disk so the user can close them.
async function checkProjectsExistence() {
  for (const p of projects) {
    if (await lite.fs.exists(p.path)) missing.delete(p.id);
    else missing.add(p.id);
  }
  renderProjects();
}

// ---------------------------------------------------------------- activity indicator
// Three states: busy (output flowing) · waiting (quiet, but wants your input) ·
// quiet (done/idle). The reliable "wants attention" signal is the terminal BELL
// (\x07) — agents/CLIs ring it on purpose; a normal shell/Claude prompt does not,
// so we must NOT treat trailing $, #, ❯ as "waiting" (that's just idle/ready).
// PROMPT_RE is a narrow backup for plain CLIs (git/ssh/sudo) that don't bell.
const PROMPT_RE = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|overwrite\?|password[^\n]{0,24}:|passphrase[^\n]{0,24}:|press\s+(?:enter|return|any key)|continue\?/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const stripAnsi = (str) => str.replace(ANSI_RE, '');
// A real "attention" bell vs the BEL that merely terminates an OSC title sequence
// (ESC ] 0 ; title BEL) — which bash/zsh/Claude emit on every prompt. Strip OSC
// first, then a leftover BEL is a genuine bell.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const hasRealBell = (s) => s.replace(OSC_RE, '').includes('\x07');

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
  // Local echo of the user's own typing is tiny and arrives right after a keystroke —
  // that's not the agent working, so don't spin on it.
  const echoLike = !bell && data && data.length <= 8 && (Date.now() - (rec.lastInputAt || 0)) < 250;
  if (echoLike) return;
  rec.tail = stripAnsi((rec.tail || '') + (data || '')).slice(-400);
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
  const kind = await lite.pty.foregroundState(id); // 'shell' | 'running' | 'waiting' | null
  if (!terms.has(id) || rec.activitySeq !== seq) return; // new output arrived during the await

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
  const worked = rec.sawBell || (Date.now() - (rec.busyStart || 0)) >= 1500; // skip trivial blips
  rec.sawBell = false;
  setProjState(id, waiting ? 'waiting' : 'quiet');
  const pid = rec.projId;
  // notify per project when its turn ended on a non-visible tab (or app unfocused)
  if (worked && (id !== activeSessionId() || !document.hasFocus())) notifyAgent(pid, waiting ? 'waiting' : 'quiet');
}

let lastNotifyAt = 0;
function notifyAgent(id, state) {
  if (!settings.notifications) return;
  const proj = projects.find((p) => p.id === id);
  if (!proj || Date.now() - lastNotifyAt < 1200) return;
  lastNotifyAt = Date.now();
  const title = state === 'waiting' ? `⏳ ${proj.name} — агент ждёт ответа` : `✓ ${proj.name} — агент закончил`;
  try {
    const n = new Notification(title, { body: proj.path, silent: !settings.sound, tag: 'lite-' + id });
    n.onclick = () => { lite.win.show(); setActive(id); };
  } catch (_) {}
}
// Count of agents waiting on input → titlebar badge + tray tooltip.
function updateAttention() {
  const n = [...projState.values()].filter((s) => s === 'waiting').length;
  const badge = $('#attention-badge');
  if (badge) { badge.textContent = String(n); badge.classList.toggle('show', n > 0); }
  lite.tray.update(n);
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
  return ss.includes('busy') ? 'busy' : ss.includes('waiting') ? 'waiting' : 'quiet';
}
function refreshProjIndicator(projId) {
  const st = projAggState(projId);
  document.querySelectorAll(`.pind[data-id="${projId}"]`).forEach((i) => { i.className = 'pind ' + st; });
}
function saveProjTabs() {
  const out = {};
  for (const [pid, t] of tabsByProj) {
    out[pid] = { names: t.sessions.map((s) => (terms.get(s) || {}).name || 'Терминал'), active: t.sessions.indexOf(t.active) };
  }
  persist('projTabs', out, true);
}

// ── Снимки сессий между перезапусками (идея 7) ────────────────────────────────
// Живой PTY перезапуск приложения не переживает (дочерний процесс умирает с родителем), но
// ВЫВОД пережить может: сериализуем scrollback каждой сессии (capped) и при следующем старте
// показываем его как «историю до перезапуска» НАД свежим терминалом — агент/пользователь видит,
// на чём остановились. Это снимок-история, не живой процесс.
const SNAP_TTL_MS = 24 * 60 * 60 * 1000;  // снимки старше суток игнорируем
const SNAP_SCROLLBACK = 800;              // сколько строк хвоста сериализовать
const SNAP_PER_CAP = 80 * 1024;           // потолок на сессию, символов
const SNAP_TOTAL_CAP = 1536 * 1024;       // общий потолок (бережём стор)
// Снимки прошлого запуска, загруженные один раз; восстанавливаются по мере открытия проектов.
const restoreSnaps = (() => {
  const s = STORE.sessionSnaps;
  if (s && s.ts && (Date.now() - s.ts) < SNAP_TTL_MS && s.data) return { ...s.data };
  return {};
})();
function snapshotSessions() {
  try {
    const data = {};
    let total = 0;
    for (const [pid, t] of tabsByProj) {
      t.sessions.forEach((sid, i) => {
        if (total >= SNAP_TOTAL_CAP) return;
        const rec = terms.get(sid);
        if (!rec || !rec.serialize) return;
        let str = '';
        try { str = rec.serialize.serialize({ scrollback: SNAP_SCROLLBACK, excludeAltBuffer: true, excludeModes: true }); } catch (_) { return; }
        if (!str) return;
        if (str.length > SNAP_PER_CAP) str = str.slice(str.length - SNAP_PER_CAP); // храним хвост
        (data[pid] = data[pid] || [])[i] = str;
        total += str.length;
      });
    }
    const payload = { ts: Date.now(), data };
    STORE.sessionSnaps = payload;
    // setSync — чтобы запись прошла даже на beforeunload (async send мог бы не успеть).
    try { lite.store.setSync('sessionSnaps', payload); } catch (_) { try { lite.store.set('sessionSnaps', payload); } catch (_) {} }
  } catch (_) {}
}
// Восстановить историю в только что созданную сессию (индекс i вкладки проекта).
function restoreSessionSnapshot(projId, idx, sid) {
  const arr = restoreSnaps[projId];
  const snap = arr && arr[idx];
  if (!snap) return;
  const rec = terms.get(sid);
  if (!rec) return;
  try {
    rec.term.write(snap);
    rec.term.write('\r\n\x1b[2m' + '─'.repeat(16) + ' снимок до перезапуска редактора ' + '─'.repeat(16) + '\x1b[0m\r\n');
  } catch (_) {}
}
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
  { test: (e) => e.code === 'KeyF' && e.shiftKey,                   run: () => showGlobalSearch() }, // Ctrl+Shift+F — поиск по всем сессиям (идея 9)
  { test: (e) => /^Digit[1-9]$/.test(e.code) && !e.shiftKey,        run: (e) => { const p = projects[+e.code.slice(5) - 1]; if (p) setActive(p.id); } },
];
function runGlobalHotkey(e) {
  if (!e.ctrlKey || e.metaKey) return false;
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
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
  applyUnicode11(term);
  term.open(container);
  loadFastRenderer(term);
  fit.fit();
  lite.pty.create({ id, cwd, cols: term.cols, rows: term.rows });
  term.onData((data) => { if (onInput) onInput(data); lite.pty.write(id, data); });
  term.onResize(({ cols, rows }) => lite.pty.resize(id, cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Match by physical key (e.code), NOT e.key — so Ctrl+C/V etc. work in ANY keyboard
    // layout (in Russian layout Ctrl+V gives e.key='м', which the old e.key check missed).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term); // copied → swallow; else SIGINT
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteInto(id); return false; } // preventDefault — иначе xterm вставит ещё раз нативно (дубль)
    // Ctrl+Enter — перенос строки в вводе (продолжение команды), а не выполнение: \ + CR для bash/zsh, LF для ConPTY/PSReadLine (Win)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') { lite.pty.write(id, lite.platform === 'win32' ? '\n' : '\\\r'); return false; }
    if (onKey && onKey(e) === false) return false;            // клавиши вызывающего (вкладки/поиск проекта)
    if (runGlobalHotkey(e)) { e.stopPropagation(); return false; } // глобальные хоткеи в фокусе терминала (B1)
    return true;
  });
  container.addEventListener('contextmenu', (e) => { e.preventDefault(); showTermMenu(e.clientX, e.clientY, term, id); });
  return { term, fit, search, serialize };
}

function createSession(proj, name) {
  const id = proj.id + '::t' + (++sessionSeq);
  const container = el('div', 'term-instance');
  $('#terminals').appendChild(container);
  const { term, fit, search, serialize } = buildXterm(container, id, {
    cwd: proj.path,
    onInput: () => { const r = terms.get(id); if (r) r.lastInputAt = Date.now(); },
    onKey: (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { addTab(); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { const s = activeSessionId(); if (s) closeTab(s); return false; }
      if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleTab(e.key === 'PageDown' ? 1 : -1); return false; }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyF') { openTermSearch(); return false; } // Ctrl+F (без Shift) — поиск в этом терминале; Ctrl+Shift+F уходит в глобальный (реестр)
    },
  });
  term.registerLinkProvider(fileLinkProvider(term, proj.path));
  const rec = { term, fit, search, serialize, container, projId: proj.id, name, idleTimer: null, sawBell: false, tail: '', busyStart: 0, lastInputAt: 0, activitySeq: 0 };
  terms.set(id, rec);
  tabsByProj.get(proj.id).sessions.push(id);
  // «Контекст»: тихая автосборка — новая сессия агента должна найти готовый CLAUDE.md/AGENTS.md,
  // если файла-выхода ещё нет. Логика бэкенд-only (lite.ctx.*), поэтому живёт в ядре, а не в окне ctx
  // (окно ctx, если открыто, освежится по своему watch выходных файлов).
  try { ctxAutoApply(proj); } catch (_) {}
  return id;
}
// Тихая автосборка контекста для проекта (порт из contextgraph.js: только бэкенд-вызовы, без UI).
// Компилирует CLAUDE.md/AGENTS.md, ТОЛЬКО если файла-выхода ещё нет и автосборка не выключена в графе.
const CTX_AGENTS = ['claude', 'codex'];
const CTX_OUT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
async function ctxAutoApply(p) {
  try {
    for (const ag of CTX_AGENTS) {
      const prof = await lite.ctx.profiles(p.id, ag);
      const r0 = await lite.ctx.load(p.id, ag, prof && prof.active);
      const g = r0 && r0.graph;
      if (!g || (g.settings && g.settings.autoApply === false)) continue;
      if (!(g.nodes || []).some((n) => n.type === 'text')) continue;
      const o = (g.nodes || []).find((n) => n.type === 'out' && n.out === ag);
      if (!o || !o.enabled) continue;
      if (await lite.fs.exists(p.path + '/' + CTX_OUT_FILES[ag])) continue;
      await lite.ctx.compile({ projId: p.id, projPath: p.path, agent: ag, profileId: prof && prof.active });
    }
  } catch (_) {}
}
// Ensure a project's sessions exist (restoring saved tab names on first open).
function ensureProjectTabs(proj) {
  if (tabsByProj.has(proj.id)) return;
  tabsByProj.set(proj.id, { sessions: [], active: null });
  const saved = (STORE.projTabs || {})[proj.id];
  const names = saved && Array.isArray(saved.names) && saved.names.length ? saved.names : ['Терминал 1'];
  names.forEach((n, i) => { const sid = createSession(proj, n); restoreSessionSnapshot(proj.id, i, sid); }); // история до перезапуска (идея 7)
  delete restoreSnaps[proj.id]; // снимок потреблён — не восстанавливать повторно при переоткрытии проекта
  const t = tabsByProj.get(proj.id);
  const ai = saved && Number.isInteger(saved.active) ? saved.active : 0;
  t.active = t.sessions[Math.max(0, Math.min(ai, t.sessions.length - 1))] || t.sessions[0];
  saveProjTabs();
}
function renderTabBar() {
  const header = $('#term-header');
  const bar = $('#term-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const t = tabsByProj.get(activeId);
  if (!activeId || !t || !t.sessions.length) { if (header) header.style.display = 'none'; return; }
  if (header) header.style.display = 'flex';
  t.sessions.forEach((sid) => {
    const rec = terms.get(sid); if (!rec) return;
    const tab = el('div', 'tab' + (sid === t.active ? ' active' : ''));
    tab.dataset.sid = sid;
    tab.appendChild(el('span', 'tab-dot pind ' + (projState.get(sid) || 'quiet')));
    tab.appendChild(el('span', 'tab-name', rec.name));
    if (t.sessions.length > 1) {
      const x = iconBtn('tab-close', 'x', 'Закрыть вкладку (Ctrl+Shift+W)', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(sid); });
      tab.appendChild(x);
    }
    tab.addEventListener('click', () => switchTab(sid));
    tab.addEventListener('dblclick', () => renameTab(sid));
    bar.appendChild(tab);
  });
  const add = iconBtn('tab-add', 'plus', 'Новая вкладка (Ctrl+Shift+T)', 15);
  add.addEventListener('click', () => addTab());
  bar.appendChild(add);
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
  const sid = createSession(proj, 'Терминал ' + (t.sessions.length + 1));
  t.active = sid; saveProjTabs(); showActiveTerminal();
}
function closeTab(sid) {
  const t = tabsByProj.get(activeId); if (!t || t.sessions.length <= 1) return; // keep ≥1 tab
  lite.pty.kill(sid);
  const rec = terms.get(sid);
  if (rec) { clearTimeout(rec.idleTimer); try { rec.term.dispose(); } catch (_) {} rec.container.remove(); terms.delete(sid); }
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
  showPrompt('Переименовать вкладку', 'Название', rec.name, (v) => { rec.name = v; saveProjTabs(); renderTabBar(); });
}
async function pasteInto(id) {
  const text = await lite.readClipboard();
  if (text) lite.pty.write(id, text);
  // Reading the clipboard is async (IPC round-trip) and the right-click menu steals
  // focus — without this the terminal looks "frozen" until clicked. Refocus the xterm.
  const rec = terms.get(id);
  if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
}
// Smart Ctrl+C: if there's a non-empty selection, copy it (and clear, so the next
// Ctrl+C can still send SIGINT) and report handled; otherwise return false so the
// keypress falls through to the PTY as the interrupt signal. Mirrors the menu's copy.
function showActiveTerminal() {
  const asid = activeSessionId();
  $('#empty-hint').style.display = activeId ? 'none' : 'flex';
  for (const [sid, rec] of terms) rec.container.style.display = sid === asid ? 'block' : 'none';
  renderTabBar();
  refitActiveTerminal(true);
  reportRemoteActive(asid);
}
// Сообщаем main, какая вкладка активна на десктопе → пульт синхронизирует выделение.
let lastReportedActive;
function reportRemoteActive(sid) {
  if (sid === lastReportedActive) return;
  lastReportedActive = sid;
  try { lite.remote.activeChanged(sid || ''); } catch (_) {}
}
// Пульт выбрал вкладку → переключаем десктоп на неё (если такая сессия есть локально).
function handleRemoteSelect(sid) {
  if (!sid) return;
  const rec = terms.get(sid);
  if (!rec) return; // удалённо открытый/неизвестный терминал — десктоп не следует
  const t = tabsByProj.get(rec.projId);
  if (t) t.active = sid;
  if (rec.projId !== activeId) doSetActive(rec.projId);
  else { saveProjTabs(); showActiveTerminal(); }
}
// Пульт нажал «＋» у проекта → открываем настоящую вкладку на десктопе (= и на пульте).
function handleRemoteOpen(projId) {
  const proj = projects.find((p) => p.id === projId);
  if (!proj) return;
  // Если у проекта ещё НЕТ терминалов — doSetActive сам создаст «Терминал 1» (ensureProjectTabs).
  // Только если терминалы уже были, «＋» с пульта открывает ДОПОЛНИТЕЛЬНУЮ вкладку. Иначе
  // получалось 2 терминала сразу (авто-первый + addTab) и пульт зацикливался на переключении.
  const hadTabs = tabsByProj.has(projId) && (tabsByProj.get(projId).sessions || []).length > 0;
  doSetActive(projId);
  if (hadTabs) addTab();
}
// Пульт прислал «Создать папку» → создаём её на ПК в рабочем каталоге и открываем
// проектом (новая вкладка-терминал прилетит обратно на пульт через состояние).
async function handleRemoteNewFolder(name) {
  name = String(name || '').trim();
  if (!name) return;
  const parent = (settings && settings.workingDir) || lastParent || '';
  if (!parent) { toast('Пульт: задай рабочий каталог в Настройках, чтобы создавать папки'); return; }
  try {
    const res = await lite.fs.mkdir(parent, name);
    if (res && res.error) { toast('Пульт: ' + res.error); return; }
    if (res && res.path) { openByPath(res.path, res.name); toast(`Папка «${res.name}» создана (с пульта)`); }
  } catch (e) { toast('Пульт: не удалось создать папку'); }
}
// Пульт: «В терминал» из модалки «Задачи» — вставить текст в терминал проекта
// (та же логика, что и кнопка «В терминал» в панели задач на ПК).
function handleRemoteNoteToTerminal(projId, text) {
  if (!text) return;
  const proj = projects.find((x) => x.id === projId) || activeProject();
  if (proj) sendNoteToTerminal(proj, text);
}
// Пульт просит одобрить устройство (pairing) → модалка с именем устройства и проверочным
// кодом. Одобрять только своё устройство, у которого код на экране совпадает.
function handleRemotePairRequest(info) {
  info = info || {};
  const device = info.device || '';
  if (!device) return;
  const name = info.name || 'Неизвестное устройство';
  const code = info.code ? `\n\nКод на устройстве: ${info.code}` : '';
  showConfirm(
    `Подключить устройство «${name}»?`,
    `Устройство запрашивает доступ к терминалу через пульт. Одобряйте ТОЛЬКО если это ваше устройство и код ниже совпадает с показанным на нём.${code}`,
    '✓ Одобрить',
    () => { try { lite.remote.pairApprove(device); toast(`Устройство «${name}» одобрено`); } catch (_) {} },
    '✕ Отклонить',
    () => { try { lite.remote.pairDeny(device); toast(`Устройство «${name}» отклонено`); } catch (_) {} },
  );
}
// Пульт закрыл вкладку (×) → закрываем её на десктопе (closeTab работает по активному проекту).
function handleRemoteClose(sid) {
  const rec = terms.get(sid);
  if (!rec) return;
  if (rec.projId !== activeId) doSetActive(rec.projId);
  closeTab(sid);
}
function refitActiveTerminal(focusIt) {
  try { Ext.refitTerminal(); } catch (_) {} // dev-терминал модуля в #ext-pane
  const asid = activeSessionId();
  const rec = asid ? terms.get(asid) : null;
  if (!rec) return;
  requestAnimationFrame(() => {
    try { rec.fit.fit(); lite.pty.resize(asid, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {}
  });
}
function clearTerminal(id) {
  const sid = (id && terms.has(id)) ? id : activeSessionId();
  const rec = terms.get(sid); if (rec) { try { rec.term.clear(); } catch (_) {} rec.term.focus(); }
}
function restartTerminal(id) {
  const sid = (id && terms.has(id)) ? id : activeSessionId();
  const rec = terms.get(sid);
  const proj = rec && projects.find((p) => p.id === rec.projId);
  if (!proj || !rec) return;
  try { rec.term.reset(); } catch (_) {}
  rec.sawBell = false; rec.tail = ''; rec.busyStart = Date.now();
  clearTimeout(rec.idleTimer);
  setProjState(sid, 'busy');
  lite.pty.restart({ id: sid, cwd: proj.path, cols: rec.term.cols, rows: rec.term.rows });
  rec.term.focus();
}


// Терминал dev-папки модуля: PTY+xterm в переданном контейнере (живёт в #ext-pane).
// Возвращает handle для extensions.js; xterm в код модуля не утекает (правило изоляции).
function createExtTerminal(container, cwd) {
  const id = EXT_TERM_ID + '::t' + (++extTermSeq);
  // Без onKey: у dev-терминала модуля нет вкладок, а Ctrl+F открыл бы поиск ЧУЖОГО
  // (активного проектного) терминала — поэтому поиск здесь не перехватываем (как было).
  const { term, fit, search } = buildXterm(container, id, { cwd });
  extTerms.set(id, { term, fit, search, container });
  return {
    id,
    write: (s) => lite.pty.write(id, s),
    focus: () => { try { term.focus(); } catch (_) {} },
    refit: () => requestAnimationFrame(() => { try { fit.fit(); lite.pty.resize(id, term.cols, term.rows); } catch (_) {} }),
    dispose: () => { lite.pty.kill(id); try { term.dispose(); } catch (_) {} extTerms.delete(id); },
  };
}

// ================================================================ RemoteHost module (SSH)
// Вынесен в renderer/modules/remotehost.js (const Rh — у реестра панелей).

// ---------------------------------------------------------------- font size
let watchedRoot = null; // we live-watch only the active project to limit inotify use
function applyFontSize() {
  for (const rec of terms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
  for (const rec of extTerms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} }
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

// ── Глобальный поиск по выводу ВСЕХ открытых сессий (идея 9) ───────────────────
// Когда параллельно работают несколько агентов, важно быстро найти «где это проскочило».
// Сканируем scrollback каждого терминала (read-only, PTY не трогаем), показываем совпадения
// сгруппированно по сессии; клик переключает на сессию и подсвечивает строку.
const GS_PER_SESSION = 60;   // потолок совпадений на одну сессию
const GS_TOTAL = 400;        // общий потолок строк в выдаче
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
function showGlobalSearch() {
  const { m, close } = makeModal(`
    <h2>🔎 Поиск по всем терминалам</h2>
    <input type="text" id="gs-q" placeholder="искать в выводе всех открытых сессий…" spellcheck="false" autocomplete="off">
    <div id="gs-results" class="gs-results"></div>`);
  const input = m.querySelector('#gs-q');
  const box = m.querySelector('#gs-results');
  let timer = null;
  const run = () => {
    const q = input.value.trim();
    box.innerHTML = '';
    if (q.length < 2) { box.appendChild(el('div', 'gs-empty', 'Введите минимум 2 символа')); return; }
    let total = 0;
    for (const [sid, rec] of terms) {
      if (total >= GS_TOTAL) break;
      const hits = scanTermBuffer(rec.term, q);
      if (!hits.length) continue;
      const proj = projects.find((p) => p.id === rec.projId);
      box.appendChild(el('div', 'gs-group', `${proj ? proj.name : '—'} · ${rec.name} — совпадений: ${hits.length}`));
      for (const h of hits) {
        if (total >= GS_TOTAL) break;
        const row = el('div', 'gs-hit');
        row.appendChild(el('span', 'gs-ln', String(h.y)));
        row.appendChild(el('span', 'gs-text', h.text));
        row.onclick = () => {
          jumpToSession(rec.projId, sid);
          requestAnimationFrame(() => { try { rec.term.scrollToLine(Math.max(0, h.y - 2)); rec.search.findNext(q); } catch (_) {} });
          close();
        };
        box.appendChild(row); total++;
      }
    }
    if (!total) box.appendChild(el('div', 'gs-empty', 'Ничего не найдено в открытых сессиях'));
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 160); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  setTimeout(() => input.focus(), 30);
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
  try { lite.errors.setContext(proj.path); } catch (_) {} // тег проекта для новых ошибок в реестре
  // Перевешиваем вотчер ТОЛЬКО при смене корня — иначе повторная активация уже активного
  // проекта (например, тап «+» с пульта зовёт doSetActive безусловно) плодила бы дубль fs.watch
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
const WINDOW_MODULES = new Set(['tools', 'iterflow', 'seo', 'audit', 'company', 'notes', 'db', 'chat', 'doc', 'docker', 'rh', 'ctx', 'scratch', 'files', 'pomodoro']);
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
// «Контекст» (ctx) — граф контекста агента (канва n8n) мигрирован в отдельное окно (проектозависимое:
// следует за активным проектом редактора). autoApply (тихая автосборка) портирована в ядро (ctxAutoApply).
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
  getTheme: () => (THEMES[settings.theme] ? settings.theme : DEFAULT_THEME),
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
  { id: 'rh',      icon: 'globe',    label: 'Удалённые хосты — SSH-сессии' },
  { id: 'notes',   icon: 'note',     label: 'Задачи — заметки проекта' },
  { id: 'audit',   icon: 'grid',     label: 'Аудит — анализ проекта' },
  { id: 'company', icon: 'users',    label: 'ИИ компания — команда агентов над проектом' },
  { id: 'iterflow', icon: 'layers',  label: 'IterFlow — задачи итераций (трекер)' },
  { id: 'seo',     icon: 'globe',    label: 'WEB/SEO аудит — анализ сайта' },
  { id: 'tools',   icon: 'wrench',   label: 'Инструменты — base64, JSON/YAML, хэши, regex…' },
  { id: 'chat',    icon: 'chat',     label: 'OpenRouter — чат по своим API-ключам' },
  { id: 'doc',     icon: 'note',     label: 'Обработка текста — документы + AI-правки' },
  { id: 'pomodoro', icon: 'clock',   label: 'Помодоро — таймер работы/отдыха с блокировкой' },
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
  const n = (activeId && STORE.noteCounts) ? (STORE.noteCounts[activeId] || 0) : 0;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('show', n > 0);
}
// Список задач изменился (модуль/пульт) → пересчитать счётчик этого списка с диска и освежить бейдж.
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
function showPanelSetup() {
  const { m, close } = makeModal(`
    <h2>Настройка панели</h2>
    <div class="qb-hint">Клик по модулю слева выносит его кнопку на панель под терминалом,
      клик справа — убирает. «Разделитель │» можно добавлять сколько угодно и ставить в любое место.
      Стрелки ▲▼ меняют порядок.</div>
    <div class="qb-cols">
      <div class="qb-col"><div class="qb-col-title">Все модули</div><div class="qb-list" id="qb-all"></div></div>
      <div class="qb-col"><div class="qb-col-title">На панели</div><div class="qb-list" id="qb-sel"></div></div>
    </div>
    <div class="modal-actions"><button class="btn primary" id="qb-ok">Готово</button></div>`);
  m.style.width = '560px';
  const allBox = m.querySelector('#qb-all');
  const selBox = m.querySelector('#qb-sel');
  const save = (ids) => { persist('quickbar', ids); renderQuickbar(); };
  const SEP_MOD = { id: QUICK_SEP, label: 'Разделитель' };
  const mkItem = (mod, onClick) => {
    const row = el('div', 'qb-item' + (mod.id === QUICK_SEP ? ' qb-item-sep' : ''));
    const ic = el('span', 'qb-ic');
    if (mod.id === QUICK_SEP) ic.textContent = '│'; else ic.appendChild(icon(mod.icon, 16));
    row.appendChild(ic);
    row.appendChild(el('span', 'qb-name', mod.label));
    row.onclick = onClick;
    return row;
  };
  const render = () => {
    const mods = quickAllModules();
    const byId = new Map(mods.map((x) => [x.id, x]));
    // в выбранном держим и разделители ('|'), и существующие модули (пропавшие — отсеиваем)
    const sel = (Array.isArray(STORE.quickbar) ? STORE.quickbar : []).filter((id) => id === QUICK_SEP || byId.has(id));
    allBox.innerHTML = ''; selBox.innerHTML = '';
    const free = mods.filter((x) => !sel.includes(x.id));
    for (const mod of free) allBox.appendChild(mkItem(mod, () => { save([...sel, mod.id]); render(); }));
    // разделитель всегда доступен — добавляем в конец (потом двигаем стрелками куда нужно)
    allBox.appendChild(mkItem(SEP_MOD, () => { save([...sel, QUICK_SEP]); render(); }));
    if (!sel.length) selBox.appendChild(el('div', 'qb-empty', '— пусто, панель скрыта —'));
    // операции по ИНДЕКСУ (разделителей может быть несколько — удалять/двигать по значению нельзя)
    sel.forEach((id, i) => {
      const mod = id === QUICK_SEP ? SEP_MOD : byId.get(id);
      const row = mkItem(mod, () => { const ids = sel.slice(); ids.splice(i, 1); save(ids); render(); });
      const move = (d) => (e) => {
        e.stopPropagation();
        const j = i + d;
        if (j < 0 || j >= sel.length) return;
        const ids = sel.slice(); [ids[i], ids[j]] = [ids[j], ids[i]];
        save(ids); render();
      };
      const up = el('button', 'qb-mv', '▲'); up.title = 'Левее на панели'; up.onclick = move(-1); up.disabled = i === 0;
      const dn = el('button', 'qb-mv', '▼'); dn.title = 'Правее на панели'; dn.onclick = move(1); dn.disabled = i === sel.length - 1;
      row.appendChild(up); row.appendChild(dn);
      selBox.appendChild(row);
    });
  };
  render();
  m.querySelector('#qb-ok').onclick = close;
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

// ---------------------------------------------------------------- window controls
function initWindowControls() {
  $('#win-min').onclick = () => lite.win.minimize();
  $('#win-max').onclick = () => lite.win.maximizeToggle();
  $('#win-close').onclick = () => lite.win.close(); // fullscreen — по F11 (кнопку убрали, стандартные 3 кнопки)
  lite.win.onMaximizeChange((v) => $('#app').classList.toggle('is-max', !!v));
  lite.win.isMaximized().then((v) => $('#app').classList.toggle('is-max', !!v));
  $('#topbar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, #menubar, .win-tools')) return;
    lite.win.maximizeToggle();
  });
}

// ---------------------------------------------------------------- menu
let openMenuName = null;
function initMenubar() {
  document.querySelectorAll('.menu-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.menu;
      if (openMenuName === name) { closeMenus(); return; }
      openTopMenu(name, btn);
    });
  });
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
}
function closeMenus() {
  $('#menu-layer').innerHTML = '';
  document.querySelectorAll('.menu-item.open').forEach((b) => b.classList.remove('open'));
  openMenuName = null;
}
function placeMenu(dd, x, y) {
  $('#menu-layer').appendChild(dd);
  dd.style.left = x + 'px';
  dd.style.top = y + 'px';
  const r = dd.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) dd.style.left = (window.innerWidth - 8 - r.width) + 'px';
  if (r.bottom > window.innerHeight - 8) dd.style.top = (window.innerHeight - 8 - r.height) + 'px';
}
function openTopMenu(name, btn) {
  closeMenus();
  if (name === 'about') { showAbout(); return; }
  openMenuName = name;
  btn.classList.add('open');
  const dd = el('div', 'menu-dropdown');
  if (name === 'file') buildFileMenu(dd);
  else if (name === 'settings') buildSettingsMenu(dd);
  else if (name === 'modules') buildModulesMenu(dd);
  dd.addEventListener('click', (e) => e.stopPropagation());
  const r = btn.getBoundingClientRect();
  placeMenu(dd, r.left, r.bottom + 4);
}
// `glyph` is an ICONS name (rendered as SVG); a non-icon string falls back to text; falsy → empty slot.
function menuRow(glyph, text, onClick, cls) {
  const row = el('div', 'menu-row' + (cls ? ' ' + cls : ''));
  const ic = el('span', 'menu-ic');
  if (glyph && ICONS[glyph]) ic.appendChild(icon(glyph, 16));
  else if (glyph) ic.textContent = glyph;
  row.appendChild(ic); row.appendChild(el('span', null, text));
  if (onClick) row.addEventListener('click', onClick);
  return row;
}
// Двухстрочный пункт: название (1-я строка) + описание (2-я строка, мельче и приглушённо).
// moduleId — опциональный id модуля; если передан, добавляется чекбокс «автозапуск».
function moduleRow(glyph, title, desc, onClick, moduleId) {
  const row = el('div', 'menu-row menu-row2');
  const ic = el('span', 'menu-ic');
  if (glyph && ICONS[glyph]) ic.appendChild(icon(glyph, 16));
  else if (glyph) ic.textContent = glyph;
  const txt = el('div', 'mr2-text');
  txt.appendChild(el('span', 'mr2-title', title));
  if (desc) txt.appendChild(el('span', 'mr2-desc', desc));
  row.append(ic, txt);
  if (moduleId) {
    const autoMods = Array.isArray(STORE.autoModules) ? STORE.autoModules : [];
    const isOn = autoMods.includes(moduleId);
    const chk = el('span', 'mr2-chk' + (isOn ? ' on' : ''));
    chk.title = 'Запускать при старте';
    chk.appendChild(icon(isOn ? 'check-square' : 'square', 15));
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      let cur = Array.isArray(STORE.autoModules) ? [...STORE.autoModules] : [];
      const idx = cur.indexOf(moduleId);
      if (idx >= 0) { cur.splice(idx, 1); chk.classList.remove('on'); }
      else { cur.push(moduleId); chk.classList.add('on'); }
      persist('autoModules', cur);
      chk.innerHTML = '';
      chk.appendChild(icon(cur.includes(moduleId) ? 'check-square' : 'square', 15));
    });
    row.appendChild(chk);
  }
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
function buildFileMenu(dd) {
  dd.appendChild(menuRow('folder', 'Открыть папку', () => { closeMenus(); openProjectDialog(); }));
  dd.appendChild(menuRow('plus', 'Создать папку…', () => { closeMenus(); showCreateFolder(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('download', 'Экспорт настроек…', exportSettings));
  dd.appendChild(menuRow('upload', 'Импорт настроек…', importSettings));
  dd.appendChild(menuRow('clipboard', 'Логи…', () => { closeMenus(); showLogs(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(el('div', 'menu-label', 'Ранее открытые'));
  const recents = loadRecents();
  const list = el('div', 'recents');
  if (!recents.length) {
    list.appendChild(el('div', 'menu-row disabled', '— пусто —'));
  } else {
    for (const r of recents) {
      const row = el('div', 'recent-row');
      row.title = r.path;
      row.appendChild(el('div', 'recent-name', r.name));
      row.appendChild(el('div', 'recent-path', r.path));
      row.addEventListener('click', () => { closeMenus(); openByPath(r.path, r.name); });
      list.appendChild(row);
    }
  }
  dd.appendChild(list);
  if (recents.length) {
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(menuRow('trash', 'Очистить список', () => { persist('recents', []); closeMenus(); }));
  }
}
function buildSettingsMenu(dd) {
  dd.appendChild(menuRow('sliders', 'Настройки…', () => { closeMenus(); showSettings(); }));
  dd.appendChild(menuRow('grid', 'Палитра команд (Ctrl+K)', () => { closeMenus(); showPalette(); }));
  dd.appendChild(menuRow('search', 'Поиск в терминале (Ctrl+F)', () => { closeMenus(); openTermSearch(); }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('globe', 'Пульт (Android)', () => { closeMenus(); showRemote(); }));
}
// «Модули» — функциональные панели справа от терминала (терминалы и OpenRouter-чат — НЕ модули).
// Группировка: «Встроенные» и «Мои модули» — flyout-подменю (раскрываются вправо по наведению),
// «Настройка панели» — отдельный пункт. Так верхнее меню остаётся коротким и растёт вглубь.
function buildModulesMenu(dd) {
  let openSub = null, openParent = null, closeT = null;
  const closeSub = () => {
    if (openSub) { openSub.remove(); openSub = null; }
    if (openParent) { openParent.classList.remove('sub-open'); openParent = null; }
  };
  const schedClose = () => { clearTimeout(closeT); closeT = setTimeout(closeSub, 240); };
  // Пункт-флайаут: двухстрочный заголовок + стрелка; подменю строится `build(sub)` по наведению.
  const flyout = (glyph, title, desc, build) => {
    const row = moduleRow(glyph, title, desc, null);
    row.classList.add('menu-flyout');
    const arr = el('span', 'menu-arrow'); arr.appendChild(icon('chevron-right', 15)); row.appendChild(arr);
    const open = () => {
      clearTimeout(closeT);
      if (openParent === row) return;
      closeSub();
      const sub = el('div', 'menu-dropdown menu-sub');
      build(sub);
      sub.addEventListener('click', (e) => e.stopPropagation());
      sub.addEventListener('mouseenter', () => clearTimeout(closeT));
      sub.addEventListener('mouseleave', schedClose);
      $('#menu-layer').appendChild(sub);
      const rr = row.getBoundingClientRect();
      sub.style.top = rr.top + 'px';
      sub.style.left = (rr.right - 4) + 'px';
      const sr = sub.getBoundingClientRect();
      if (sr.right > window.innerWidth - 8) sub.style.left = Math.max(8, rr.left - sr.width + 4) + 'px'; // не влезло вправо → влево
      if (sr.bottom > window.innerHeight - 8) sub.style.top = Math.max(8, window.innerHeight - 8 - sr.height) + 'px';
      openSub = sub; openParent = row; row.classList.add('sub-open');
    };
    row.addEventListener('mouseenter', open);
    row.addEventListener('mouseleave', schedClose);
    dd.appendChild(row);
  };

  flyout('grid', 'Встроенные', 'панели редактора', (sub) => {
    sub.appendChild(moduleRow('eye', 'Проект', 'вивер кода, дерево, Git', () => { closeMenus(); openModule('files'); }, 'files'));
    sub.appendChild(moduleRow('graph', 'Контекст', 'граф контекста агента', () => { closeMenus(); openModule('ctx'); }, 'ctx'));
    sub.appendChild(moduleRow('box', 'Контейнеры', 'Docker / Podman', () => { closeMenus(); openModule('docker'); }, 'docker'));
    sub.appendChild(moduleRow('database', 'Базы данных', 'Postgres · MySQL · SQLite', () => { closeMenus(); openModule('db'); }, 'db'));
    sub.appendChild(moduleRow('globe', 'Удалённые хосты', 'SSH-сессии к серверам', () => { closeMenus(); openModule('rh'); }, 'rh'));
    sub.appendChild(moduleRow('note', 'Задачи', 'заметки проекта и общие', () => { closeMenus(); openModule('notes'); }, 'notes'));
    sub.appendChild(moduleRow('grid', 'Аудит', 'типы файлов, крупные файлы, медиа', () => { closeMenus(); openModule('audit'); }, 'audit'));
    sub.appendChild(moduleRow('users', 'ИИ компания', 'директор + сабагенты над проектом', () => { closeMenus(); openModule('company'); }, 'company'));
    sub.appendChild(moduleRow('layers', 'IterFlow', 'задачи итераций из трекера', () => { closeMenus(); openModule('iterflow'); }, 'iterflow'));
    sub.appendChild(moduleRow('globe', 'WEB/SEO аудит', 'сайт: безопасность, SEO, сеть', () => { closeMenus(); openModule('seo'); }, 'seo'));
    sub.appendChild(moduleRow('wrench', 'Инструменты', 'base64, JSON/YAML, хэши, JWT, regex, diff', () => { closeMenus(); openModule('tools'); }, 'tools'));
    sub.appendChild(moduleRow('chat', 'OpenRouter', 'чат по своим API-ключам', () => { closeMenus(); openModule('chat'); }, 'chat'));
    sub.appendChild(moduleRow('note', 'Обработка текста', 'документы + AI-правки фрагментов', () => { closeMenus(); openModule('doc'); }, 'doc'));
    sub.appendChild(moduleRow('clock', 'Помодоро', 'таймер работы/отдыха с блокировкой', () => { closeMenus(); openModule('pomodoro'); }, 'pomodoro'));
    sub.appendChild(el('div', 'menu-sep'));
    sub.appendChild(moduleRow('terminal', 'Системный терминал', 'вне проектов', () => { closeMenus(); openModule('scratch'); }));
  });
  flyout('layers', 'Мои модули', 'пользовательские плагины', (sub) => Ext.buildMenuSection(sub, { bare: true }));
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(moduleRow('sliders', 'Настройка панели', 'быстрый доступ под терминалом', () => { closeMenus(); showPanelSetup(); }));
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
    <h2>💬 Заготовленные промпты</h2>
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
function showTermMenu(x, y, term, projId) {
  closeMenus();
  const dd = el('div', 'menu-dropdown');
  dd.style.minWidth = '160px';
  const hasSel = term.hasSelection && term.hasSelection();
  dd.appendChild(menuRow('copy', 'Копировать', hasSel ? () => {
    closeMenus();
    lite.copyText(term.getSelection());
    if (term.clearSelection) term.clearSelection();
  } : null, hasSel ? '' : 'disabled'));
  dd.appendChild(menuRow('clipboard', 'Вставить', () => { closeMenus(); pasteInto(projId); }));
  dd.appendChild(el('div', 'menu-sep'));
  addPromptsItem(dd, projId);
  dd.appendChild(el('div', 'menu-sep'));
  dd.appendChild(menuRow('eraser', 'Очистить', () => { closeMenus(); clearTerminal(projId); }));
  dd.appendChild(menuRow('refresh', 'Перезапустить', () => { closeMenus(); restartTerminal(projId); }));
  dd.addEventListener('click', (e) => e.stopPropagation());
  placeMenu(dd, x, y);
}

// ---------------------------------------------------------------- modals
// makeModal/showConfirm/showPrompt живут в ui.js; здесь остались только предметные модалки.
function showAbout() {
  closeMenus();
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">▍</span>LiteEditorAI</h2>
    <div class="about-desc">
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
    <div class="about-ver">${APP_VERSION} <span id="ab-upd-status" class="about-upd"></span></div>
    <div class="about-meta">Максим&nbsp;Кузьминский · <a href="#" id="ab-src">исходники на GitHub</a></div>
    <div class="modal-actions">
      <button class="btn" id="ab-check">Проверить обновление</button>
      <button class="btn primary" id="ab-ok">Ок</button>
    </div>`);
  m.querySelector('#ab-ok').onclick = close;
  m.querySelector('#ab-src').onclick = (e) => { e.preventDefault(); lite.openExternal('https://github.com/DanielLetto2020/LiteEditorAI'); };
  const st = m.querySelector('#ab-upd-status');
  const setSt = (txt, cls) => { if (st) { st.textContent = txt; st.className = 'about-upd' + (cls ? ' ' + cls : ''); } };
  // Reflect a known result immediately; otherwise prompt to check.
  if (updateInfo) setSt('— доступна ' + updateInfo.tag, 'has');
  m.querySelector('#ab-check').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; setSt('— проверяю…');
    const r = await checkForUpdate({ manual: true });
    btn.disabled = false;
    if (r && r.error) setSt('— не удалось проверить', 'err');
    else if (verNewer(r.tag, APP_VERSION)) {
      // Build with DOM methods (tag comes from the API) — no innerHTML.
      setSt('— доступна ', 'has');
      const dl = el('a', null, (r.tag || 'новая версия') + ' (скачать)');
      dl.href = '#';
      dl.onclick = (ev) => { ev.preventDefault(); lite.openExternal(r.url || 'https://github.com/DanielLetto2020/LiteEditorAI/releases/latest'); };
      st.appendChild(dl);
    } else setSt('— у вас последняя версия', 'ok');
  };
}
function showCreateFolder() {
  const { m, close } = makeModal(`
    <h2>✚ Создать папку</h2>
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
    <h2>🗒 Логи приложения</h2>
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
function showSettings() {
  const { m, close } = makeModal(`
    <h2>🎚 Настройки</h2>
    <label class="set-row"><span>Уведомления о завершении агента</span><input type="checkbox" id="st-notif"></label>
    <label class="set-row"><span>Звук уведомлений</span><input type="checkbox" id="st-sound"></label>
    <label class="set-row"><span>Тишина до «готов», мс</span><input type="number" id="st-idle" min="300" max="6000" step="100"></label>
    <label class="set-row"><span>Размер шрифта</span><input type="number" id="st-font" min="9" max="24"></label>
    <label class="set-row"><span>Тема</span><select id="st-theme"></select></label>
    <div class="set-row col"><span>Оболочка терминала — применяется к новым терминалам (старые — ⟳)</span>
      <div class="path-pick">
        <select id="st-shell"></select>
        <input type="text" id="st-shell-path" placeholder="путь к исполняемому файлу" spellcheck="false" style="display:none">
      </div></div>
    <div class="set-row col"><span>Рабочая папка — куда создаются новые проекты</span>
      <div class="path-pick">
        <input type="text" id="st-wd" readonly placeholder="не задана">
        <button class="btn" id="st-wd-pick">Выбрать</button>
        <button class="btn" id="st-wd-clear" title="Очистить">✕</button>
      </div></div>
    <div class="set-row col"><span>Папки для скана — их подпапки добавляются как проекты при запуске</span>
      <div id="st-scan" class="scan-list"></div>
      <button class="btn" id="st-scan-add">＋ Добавить папку</button></div>
    <div class="set-row col"><span>Доступ с пульта — папки, которые можно смотреть/скачивать с планшета (только чтение). «Стор» доступен всегда.</span>
      <div id="st-shares" class="scan-list"></div>
      <button class="btn" id="st-share-add">＋ Открыть папку пульту</button></div>
    <div class="modal-actions"><button class="btn primary" id="st-ok">Готово</button></div>`);
  const notif = m.querySelector('#st-notif'); notif.checked = settings.notifications;
  const sound = m.querySelector('#st-sound'); sound.checked = settings.sound;
  const idle = m.querySelector('#st-idle'); idle.value = settings.idleMs;
  const font = m.querySelector('#st-font'); font.value = settings.fontSize;
  const themeSel = m.querySelector('#st-theme');
  for (const [key, t] of Object.entries(THEMES)) { const o = document.createElement('option'); o.value = key; o.textContent = t.label; themeSel.appendChild(o); }
  themeSel.value = THEMES[settings.theme] ? settings.theme : DEFAULT_THEME;
  themeSel.addEventListener('change', () => { settings.theme = themeSel.value; saveSettings(); applyTheme(); }); // live preview
  // Выбор оболочки терминала — платформо-зависимо (Windows: PowerShell/cmd/свой; Linux: bash/свой).
  const shellSel = m.querySelector('#st-shell');
  const shellPath = m.querySelector('#st-shell-path');
  const isWin = (lite.platform === 'win32');
  const shellOpts = isWin
    ? [['', 'PowerShell (по умолчанию)'], ['cmd', 'cmd'], ['__custom__', 'Свой путь…']]
    : [['', 'bash (по умолчанию)'], ['__custom__', 'Свой путь…']];
  for (const [v, t] of shellOpts) { const o = document.createElement('option'); o.value = v; o.textContent = t; shellSel.appendChild(o); }
  const shellPresets = isWin ? ['', 'cmd'] : [''];
  const curShell = settings.shell || '';
  const shellCustom = curShell && !shellPresets.includes(curShell);
  shellSel.value = shellCustom ? '__custom__' : curShell;
  shellPath.style.display = shellCustom ? '' : 'none';
  shellPath.value = shellCustom ? curShell : '';
  shellSel.addEventListener('change', () => { shellPath.style.display = shellSel.value === '__custom__' ? '' : 'none'; });
  const wd = m.querySelector('#st-wd'); wd.value = settings.workingDir || '';
  let scan = [...(settings.scanDirs || [])];
  const scanBox = m.querySelector('#st-scan');
  const renderScan = () => {
    scanBox.innerHTML = '';
    if (!scan.length) { scanBox.appendChild(el('div', 'scan-empty', '— пусто —')); return; }
    scan.forEach((d, i) => {
      const r = el('div', 'scan-item');
      const path = el('span', 'scan-path', d); path.title = d;
      const x = el('button', 'scan-del', '✕');
      x.onclick = () => { scan.splice(i, 1); renderScan(); };
      r.append(path, x); scanBox.appendChild(r);
    });
  };
  renderScan();
  // Доступ с пульта (shares) — список папок {path,name}; «Стор» неявно всегда доступен.
  let shares = [...(STORE.shares || [])];
  const sharesBox = m.querySelector('#st-shares');
  const renderShares = () => {
    sharesBox.innerHTML = '';
    if (!shares.length) { sharesBox.appendChild(el('div', 'scan-empty', '— только «Стор» —')); return; }
    shares.forEach((s, i) => {
      const r = el('div', 'scan-item');
      const path = el('span', 'scan-path', s.path); path.title = s.path;
      const x = el('button', 'scan-del', '✕');
      x.onclick = () => { shares.splice(i, 1); renderShares(); };
      r.append(path, x); sharesBox.appendChild(r);
    });
  };
  renderShares();
  m.querySelector('#st-share-add').onclick = async () => {
    const d = await lite.pickDir();
    if (d && !shares.some((s) => s.path === d)) { shares.push({ path: d, name: d.split('/').filter(Boolean).pop() || d }); renderShares(); }
  };
  m.querySelector('#st-wd-pick').onclick = async () => { const d = await lite.pickDir(); if (d) wd.value = d; };
  m.querySelector('#st-wd-clear').onclick = () => { wd.value = ''; };
  m.querySelector('#st-scan-add').onclick = async () => { const d = await lite.pickDir(); if (d && !scan.includes(d)) { scan.push(d); renderScan(); } };
  m.querySelector('#st-ok').onclick = () => {
    settings.notifications = notif.checked;
    settings.sound = sound.checked;
    settings.idleMs = Math.max(300, Math.min(6000, parseInt(idle.value, 10) || 1200));
    settings.fontSize = Math.max(9, Math.min(24, parseInt(font.value, 10) || 13));
    settings.workingDir = wd.value || '';
    settings.scanDirs = scan;
    settings.shell = shellSel.value === '__custom__' ? shellPath.value.trim() : shellSel.value;
    persist('shares', shares);   // доступ с пульта (main читает свежим при каждом запросе)
    saveSettings(); applyFontSize(); close();
    scanProjects(); // pick up newly-added scan dirs right away
  };
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
  acts.push({ label: 'Задачи — заметки проекта', run: () => openModule('notes') });
  acts.push({ label: 'ИИ компания — команда агентов над проектом', run: () => openModule('company') });
  acts.push({ label: 'Помодоро — таймер работы/отдыха', run: () => openModule('pomodoro') });
  acts.push({ label: 'Режим «один терминал»', run: toggleSingle });
  acts.push({ label: 'Поиск в терминале', hint: 'Ctrl+F', run: openTermSearch });
  acts.push({ label: 'Поиск по всем терминалам', hint: 'Ctrl+Shift+F', run: showGlobalSearch });
  acts.push({ label: 'Очистить терминал', run: () => clearTerminal() });
  acts.push({ label: 'Перезапустить терминал', run: () => restartTerminal() });
  acts.push({ label: 'Настройки…', run: showSettings });
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
      row.addEventListener('click', () => { close(); a.run(); });
      list.appendChild(row);
    });
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((a) => (a.label + ' ' + (a.hint || '')).toLowerCase().includes(q)) : all;
    sel = 0; render();
  };
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const a = shown[sel]; if (a) { close(); a.run(); } }
  });
  render();
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- onboarding (first run)
function showOnboarding() {
  const { m, close } = makeModal(`
    <h2><span style="color:var(--green-bright)">▍</span>Добро пожаловать в LiteEditor</h2>
    <div class="about-desc">
      Терминал-ориентированное окружение для работы с агентами: у каждого проекта свой живой терминал,
      а вивер кода и дерево файлов прячутся одной кнопкой.<br><br>
      С чего начать:
      <ul style="margin:6px 0 0; padding-left:18px; line-height:1.7">
        <li><b>Открыть папку</b> — проект слева, справа поднимется его терминал.</li>
        <li>В <b>Настройках</b> задай рабочую папку и папки для авто-скана проектов.</li>
        <li><b>Ctrl+K</b> — палитра команд · <b>Ctrl+\\</b> — режим одного терминала.</li>
      </ul>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ob-settings">Настройки</button>
      <button class="btn primary" id="ob-open">Открыть папку</button>
      <button class="btn" id="ob-skip">Позже</button>
    </div>`);
  const done = () => { settings.onboarded = true; saveSettings(); close(); };
  m.querySelector('#ob-settings').onclick = () => { done(); showSettings(); };
  m.querySelector('#ob-open').onclick = () => { done(); openProjectDialog(); };
  m.querySelector('#ob-skip').onclick = done;
}

// ---------------------------------------------------------------- single-terminal toggle
function toggleSingle() {
  $('#app').classList.toggle('single');
  refitActiveTerminal();
}

// ---------------------------------------------------------------- update check
// Pull a version triple out of «alpha v1.0.97» or a tag «v1.0.97-alpha».
function parseVer(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
function verNewer(a, b) { // is version a strictly newer than b?
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}
let updateInfo = null; // {tag,url,notes,name} when a newer release exists
// Ask main to fetch the latest GitHub release and compare with APP_VERSION.
// Silent on failure / when up to date (so a startup auto-check never nags);
// `manual` = user pressed «Проверить обновление» → toast the result either way.
async function checkForUpdate({ manual = false } = {}) {
  let r;
  try { r = await lite.update.check(); } catch (_) { r = { error: 'нет связи' }; }
  if (!r || r.error) {
    if (manual) toast('Не удалось проверить обновление: ' + ((r && r.error) || 'нет связи'), { kind: 'err' });
    return r || { error: 'нет связи' };
  }
  if (verNewer(r.tag, APP_VERSION)) {
    updateInfo = r;
    const b = $('#update-badge');
    if (b) {
      b.hidden = false;
      b.textContent = '↑ ' + (r.tag || 'обновление');
      b.title = 'Доступна ' + (r.tag || 'новая версия') + ' — открыть страницу загрузки';
      b.onclick = () => lite.openExternal(r.url || 'https://github.com/DanielLetto2020/LiteEditorAI/releases/latest');
    }
    if (manual) toast('Доступна новая версия ' + r.tag, { ttl: 5000 });
  } else {
    updateInfo = null;
    const b = $('#update-badge'); if (b) b.hidden = true;
    if (manual) toast('У вас последняя версия');
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
      mini.innerHTML = '';
      mini.classList.toggle('break', s.phase === 'short' || s.phase === 'long');
      mini.append(icon('clock', 13), el('span', null, fmtRest(s.remaining) + (s.paused ? ' ⏸' : '') + ' · ' + (POMO_PHASE_SHORT[s.phase] || '')));
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
  { const av = $('#app-ver'); if (av) av.textContent = APP_VERSION; } // version label in the titlebar
  // вивер живёт в отдельном окне (module.html#files) — в редакторе его DOM/редактор больше нет.
  applyLayout();
  applyTheme();
  initGutters();
  initWindowControls();
  initMenubar();

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

  // Auto-check for a newer release shortly after startup (non-blocking, silent on
  // failure). The badge next to the version lights up if one is available.
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 3000);

  lite.pty.onData(({ id, data }) => {
    if (isExtTerm(id)) { const r = extTerms.get(id); if (r) r.term.write(data); return; }
    const rec = terms.get(id); // scratch-сессии маршрутизируются в своё окно (не приходят сюда)
    if (!rec) return;
    rec.term.write(data);
    markActivity(id, data);
  });
  lite.pty.onExit(({ id }) => {
    if (isExtTerm(id)) { const r = extTerms.get(id); if (r) r.term.write('\r\n\x1b[90m[шелл завершён]\x1b[0m\r\n'); return; }
    const rec = terms.get(id);
    if (rec) rec.term.write('\r\n\x1b[90m[процесс завершён — закрой и переоткрой проект]\x1b[0m\r\n');
    setProjState(id, 'quiet');
  });
  // RemoteHost — SSH-сессии (отдельный канал, не PTY): пишем вывод в соответствующий xterm.
  // Пульт выбрал вкладку → синхронизируем активную на десктопе.
  try { if (lite.remote && lite.remote.onSelect) lite.remote.onSelect((sid) => { try { handleRemoteSelect(sid); } catch (_) {} }); } catch (_) {}
  // Пульт открыл терминал проекта → создаём вкладку на десктопе.
  try { if (lite.remote && lite.remote.onOpenProject) lite.remote.onOpenProject((projId) => { try { handleRemoteOpen(projId); } catch (_) {} }); } catch (_) {}
  // Пульт закрыл вкладку → закрываем на десктопе.
  try { if (lite.remote && lite.remote.onCloseTab) lite.remote.onCloseTab((sid) => { try { handleRemoteClose(sid); } catch (_) {} }); } catch (_) {}
  // Пульт: «Создать папку» → создаём на десктопе.
  try { if (lite.remote && lite.remote.onNewFolder) lite.remote.onNewFolder((name) => { try { handleRemoteNewFolder(name); } catch (_) {} }); } catch (_) {}
  try { if (lite.remote && lite.remote.onNoteToTerminal) lite.remote.onNoteToTerminal((projId, text) => { try { handleRemoteNoteToTerminal(projId, text); } catch (_) {} }); } catch (_) {}
  try { if (lite.remote && lite.remote.onNotesChanged) lite.remote.onNotesChanged((id) => { try { lite.app.notesChanged(id); refreshNotesCount(id); } catch (_) {} }); } catch (_) {}
  // Окно «Задачи» изменило список → пересчитать счётчик и освежить бейдж активных задач на квикбаре.
  try { if (lite.app && lite.app.onNotesChanged) lite.app.onNotesChanged((id) => { try { refreshNotesCount(id); } catch (_) {} }); } catch (_) {}
  // Пульт просит одобрить устройство (pairing) → модалка одобрения.
  try { if (lite.remote && lite.remote.onPairRequest) lite.remote.onPairRequest((info) => { try { handleRemotePairRequest(info); } catch (_) {} }); } catch (_) {}
  // Бейдж «подключённые пульты» у версии: живёт на push-событиях из main + стартовый снимок.
  try {
    if (lite.remote && lite.remote.onPults) lite.remote.onPults((st) => { try { pultsState = st || pultsState; updatePultBadge(); } catch (_) {} });
    const pb = $('#pult-badge'); if (pb) pb.onclick = () => { try { showPults(); } catch (_) {} };
    if (lite.remote && lite.remote.pults) setTimeout(() => { refreshPults().catch(() => {}); }, 1500);
  } catch (_) {}


  // Live disk changes (fs:changed) теперь потребляет окно вивера (module-entry подписан на lite.fs.onChange).
  // Редактор остаётся источником слежения (lite.fs.watch активного проекта в doSetActive), main рассылает
  // событие и редактору, и окну вивера. В самом редакторе вивера/дерева больше нет — подписку убрали.

  $('#btn-single').addEventListener('click', toggleSingle);
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
  { const mini = $('#pomo-mini'); if (mini) mini.onclick = () => openModule('pomodoro'); }
  lite.pomodoro.getState().then((s) => updatePomoUI(s)).catch(() => {});          // стартовый снимок (таймер мог идти до открытия редактора)
  $('#term-clear').addEventListener('click', () => clearTerminal());
  $('#term-restart').addEventListener('click', () => restartTerminal());
  $('#attention-badge').addEventListener('click', () => {
    const e = [...projState.entries()].find(([, s]) => s === 'waiting');
    const rec = e && terms.get(e[0]);
    if (rec) { setActive(rec.projId); switchTab(e[0]); }
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

  // drag a folder onto the window to open it as a project
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = f.path || lite.pathForFile(f);
    if (p) openByPath(p, baseName(p));
  });

  let rezTimer;
  new ResizeObserver(() => { clearTimeout(rezTimer); rezTimer = setTimeout(() => refitActiveTerminal(), 80); }).observe($('#terminal-pane'));
  // scratch/rh ресайз теперь в окнах модулей — обрабатывается module-entry.js.

  // Снимок вывода сессий — на закрытие/перезагрузку и периодически (краш-страховка), чтобы при
  // следующем старте показать историю до перезапуска над свежими терминалами (идея 7).
  window.addEventListener('beforeunload', snapshotSessions);
  setInterval(snapshotSessions, 30000);

  applyFontSize();
  projects = loadProjectsFromDisk();
  renderProjects();
  if (projects.length) setActive(projects[0].id);
  else showActiveTerminal();

  // Набор открытых окон модулей (включая вивер) восстанавливает main (moduleWins.__open) при старте —
  // правому слоту редактора восстанавливать больше нечего (там остались только «Мои модули» по запросу).

  // Автозапуск отмеченных модулей (галочки в меню «Модули → Встроенные»)
  const autoMods = Array.isArray(STORE.autoModules) ? STORE.autoModules : [];
  if (autoMods.length) {
    setTimeout(() => { autoMods.forEach(id => openModule(id)); }, 600);
  }

  scanProjects();          // add subfolders of settings.scanDirs (non-blocking)
  checkProjectsExistence();
  window.addEventListener('focus', checkProjectsExistence); // re-check when returning to the app

  if (!settings.onboarded) setTimeout(showOnboarding, 200); // first-run welcome
}

function cycleProject(dir) {
  if (projects.length < 2) return;
  const i = projects.findIndex((p) => p.id === activeId);
  const next = projects[(i + dir + projects.length) % projects.length];
  if (next) setActive(next.id);
}

init();
