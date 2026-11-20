// LiteEditor renderer — projects, per-project terminal, viewer, file tree,
// custom titlebar, menu, modals. Talks to the backend only via window.lite.

import { initI18n, t as tt } from './i18n.js';
import { syncSettings } from './settings-sync.js';
import { applyLook, termThemeFor, lookOf, lookTokens, LOOK_BASE_NAMES, LOOK_STATUS_NAMES, LOOK_TOKEN_NAMES, THEME_NAME } from './themes.js';
import { FRAME_COLORS, frameConf, applyFrame } from './frame.js';
import { activateRenderer, releaseRenderer, dropPtyAck } from './termutil.js';
import { createTermEngine, createRestGuardController, scanTermBuffer, agentNotifyTitle } from './term-core.js';
import {
  HOTKEY_GROUPS, HOTKEY_DEFS,
  eventToCombo, validateHotkeyForAction, getHotkey,
  matchesAction, findConflicts, setHotkeyOverride, formatCombo, formatComboParts,
} from '../lib/hotkeys.js';
// initTextProc — «Обработка текста» мигрирована в отдельное окно (renderer/module-entry.js).
import {
  el, icon, iconBtn, hydrateIcons, toast, makeModal, showConfirm, showPrompt, baseName, ICONS, setErrorSink,
  initMenus, closeMenus, menuFrom, setMenuAnchor, placeMenu, placeMenuAbove, placeMenuBelow, menuRow,
} from './ui.js';
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

const APP_VERSION = 'alpha v1.1.246';
const GUTTER = 8; // зазор между карточками окна — он же разделитель, за который тянется ширина
// Системный терминал («Система · ~») мигрирован в отдельное окно (renderer/modules/scratch.js):
// его id `__scratch__::tN` маршрутизируются main'ом в окно-владельца, в ядре их больше не обрабатываем.

const lite = window.lite;
const $ = (sel) => document.querySelector(sel);
// el/svgEl/иконки/тосты/модалки/baseName переехали в ui.js (этап «модульный рефакторинг»).

// ---------------------------------------------------------------- global store (~/.LiteEditor)
// Synchronous snapshot loaded once; reads are in-memory, writes go through to disk.
const STORE = lite.store.loadAll('__editor__');
// После импорта настроек стор на диске — уже импортированный, а окно ещё держит старое состояние до
// перезагрузки: смена заголовка вкладки (projTabs), раскладки и т. п. за эти сотни миллисекунд
// переписала бы импортированное старым. С этого момента окно в стор не пишет.
let storeFrozen = false;
function persist(key, value) { STORE[key] = value; if (!storeFrozen) lite.store.set(key, value); }
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
const DEFAULT_SETTINGS = { notifications: true, sound: false, idleMs: 1200, fontSize: 13, workingDir: '', scanDirs: [], onboarded: false, shell: '', minimap: true, notesTab: 'project', frameOn: true, frameColor: 'green', framePulse: true, framePeriodS: 6, termTimeline: false, termPrefill: 'claude', dockFiles: false, confirmQuitWithAgents: true, hotkeys: {} };
function loadSettings() { return { ...DEFAULT_SETTINGS, ...(STORE.settings || {}) }; }
let settings = loadSettings();
// Пишем только изменённые поля, чужие изменения (окна модулей, смена языка) вливаются в settings —
// см. renderer/settings-sync.js. base = то, что на диске: первый save запишет и дефолты, как раньше.
const settingsSync = syncSettings(lite, settings, {
  base: STORE.settings,
  onRemote: ({ set, unset }) => {
    if (set && 'fontSize' in set) applyFontSize({ notify: false });
    if (set && 'termTimeline' in set) applyTimeline();
    if ((set && 'hotkeys' in set) || (unset && unset.includes('hotkeys'))) syncHotkeyHints();
  },
});
function saveSettings() { STORE.settings = settings; if (!storeFrozen) settingsSync.save(); }

// ---------------------------------------------------------------- state
let projects = [];
let activeId = null;
const detachedProjIds = new Set();    // проекты, чьи терминалы вынесены в отдельное окно
const detachingProjIds = new Set();   // защита от двойного клика во время выноса
const detachedStatuses = new Map();   // projId -> { aggState, waitingCount, waitingSids, hasAgent, idle }
let agentSig = '';           // что видел список проектов при прошлом опросе: перерисовываем только при смене
let agentFavSig = '';        // подпись набора избранных проектов с агентами (для режима «только с агентом»)
const missing = new Set();   // ids of projects whose folder no longer exists on disk
// Состояние вивера+дерева (expandedDirs/gitFiles/currentFile/dirty/…) живёт в отдельном ОКНЕ —
// renderer/modules/files.js (initFiles) + module-entry.js. Ядро его не держит (см. WINDOW_MODULES).

// Терминалы dev-папок пользовательских модулей: живут ВНУТРИ панели «Модули» (#ext-pane),
// не в области проектов и не среди скретч-вкладок. cwd = папка модуля.
const EXT_TERM_ID = '__extterm__';
const isExtTerm = (id) => typeof id === 'string' && id.startsWith(EXT_TERM_ID);
const extTerms = new Map(); // ptyId -> { term, fit, search, container }
let extTermSeq = 0;

const DEFAULT_LAYOUT = { sidebar: 300, viewer: 520, tree: 240, filesDock: 680, termSplit: 0.5, scratch: 420, ctx: 740, docker: 460, db: 560, rh: 520, ext: 420, notes: 480, audit: 460, iterflow: 480, seo: 480, tools: 560, chat: 600, doc: 640 };
let layout = loadLayout();
let lastParent = STORE.lastParent || '';

// Тема одна — «Графит», палитра настраивается (settings.look → renderer/themes.js, общая с окнами модулей).
// Терминалы окна редактора стоят на полупрозрачном фоне окна — их собственный фон прозрачный.
function termTheme() { return termThemeFor(settings, { glass: true }); }

const termEngine = createTermEngine({
  lite,
  STORE,
  persist,
  getSettings: () => settings,
  saveSettings,
  termTheme,
  getProjects: () => projects,
  getActiveId: () => activeId,
  setActiveProject: (id) => setActive(id),
  isDetached: (pid) => detachedProjIds.has(pid),
  getSplitFrac: () => layout.termSplit,
  setSplitFrac: (frac, save) => {
    layout.termSplit = frac;
    applyLayout();
    if (save) saveLayout();
  },
  extTerms,
  isExtTerm,
  restartExtTerminal: (id) => restartExtTerminal(id),
  refitExtra: () => { try { Ext.refitTerminal(); } catch (_) {} },
  onStatusChange: (pid, sid) => {
    if (pid) refreshProjIndicator(pid);
    updateAttention();
    if (sid === null) syncAgentListAfterScan();
  },
  onTabsChanged: () => saveProjTabs(),
  onTurnEnd: (pid, st, sid, reason, worked) => {
    if (pid === activeId) refreshGitChip(500);
    if ((st === 'waiting' || worked) && (sid !== activeSessionId() || !document.hasFocus())) notifyAgent(pid, st, sid, reason);
  },
  onAfterShowActive: () => syncDetachedHint(),
  onHotkey: (e) => runGlobalHotkey(e),
});

const {
  BOOT_ID,
  tabsByProj, terms, projState, adoptPtys,
  activeSessionId, projSessions, tabMeta,
  buildXterm, createSession, ensureProjectTabs, disposeSession, unloadProjectTerms,
  materializeSession, refreshAgents, scheduleAgentScan,
  showActiveTerminal, refitActiveTerminal, refitActiveTerminalSoon, applyTimeline,
  switchTab, addTab, clearTerminal, restartTerminal,
  toggleTermSplit, openTermSearch,
} = termEngine;

function applyTheme() {
  applyLook(settings);
  termEngine.applyThemeAll();
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
  layout.filesDock = Math.max(360, Math.min(1400, +layout.filesDock || DEFAULT_LAYOUT.filesDock));
  { const fd = $('#files-dock'); if (fd) fd.style.flexBasis = layout.filesDock + 'px'; }
  layout.termSplit = Math.max(0.2, Math.min(0.8, Number.isFinite(+layout.termSplit) ? +layout.termSplit : 0.5));
  { const tb = $('#term-body'); if (tb) tb.style.setProperty('--split-pct', (layout.termSplit * 100).toFixed(2) + '%'); }
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
// Глаз в заголовке «Избранного»: показывать только проекты, где в терминале агент (см. «агенты в терминалах»).
// Под поиском по списку не действует — найденное показываем всё.
function favAgentsOnly() { return STORE.favAgentsOnly === true; }
function setFavAgentsOnly(on) {
  persist('favAgentsOnly', !!on);
  if (on && isCollapsed(FAV_KEY)) setCollapsed(FAV_KEY, false);   // включили, чтобы увидеть, — свёрнутой группа не поможет
  renderProjects();
  if (on) refreshAgents();
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
// Плоский список проектов в точном визуальном порядке карточек боковой панели (или рельса #mini-rail
// в режиме «один терминал»): учитывает порядок секций, ручную сортировку «Избранного», фильтр
// «только с агентом», текстовый фильтр и пропускает свёрнутые группы (включая «Архив»).
function visibleOrderedProjects() {
  const appEl = $('#app');
  const single = !!(appEl && appEl.classList.contains('single'));
  const keepFilter = projFilter;
  if (single) projFilter = '';
  const secs = buildSections();
  if (single) projFilter = keepFilter;

  const out = [];
  const seen = new Set();
  for (const s of secs) {
    if (single) {
      if (s.key === ARCHIVE && isCollapsed(ARCHIVE)) continue;
      for (const p of s.list) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
      continue;
    }
    const collapsed = projFilter ? false : isCollapsed(s.key);
    if (collapsed) continue;
    const agentsOnly = s.key === FAV_KEY && favAgentsOnly() && !projFilter;
    const list = agentsOnly ? s.list.filter((p) => projHasAgent(p.id)) : s.list;
    for (const p of list) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
  }
  if (!out.length) {
    for (const s of secs) {
      if (s.key === ARCHIVE && isCollapsed(ARCHIVE) && !projFilter) continue;
      for (const p of s.list) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
    }
  }
  return out.length ? out : projects.slice();
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

function renderProjects({ skipRail = false } = {}) {
  const box = $('#projects');
  const frag = document.createDocumentFragment();
  const sections = buildSections();
  sections.forEach((s, i) => frag.appendChild(renderSection(s, i, sections)));
  if (projFilter && !sections.length) frag.appendChild(el('div', 'proj-empty', 'Ничего не найдено'));
  box.replaceChildren(frag);
  agentSig = '';
  agentFavSig = '';
  if (!skipRail) renderMiniRail();
  renderChips();
}
// Точечное обновление кнопки «Закрыть терминалы без агента: N» в шапке секции «Избранное» без пересборки списка.
function syncFavHeaderSweep() {
  const head = document.querySelector('#projects .pgroup.pinned > .pgroup-head');
  if (!head) return;
  const existing = head.querySelector('.pgroup-sweep');
  const idle = idleProjects();
  if (!idle.length) {
    if (existing) existing.remove();
    return;
  }
  const title = `Закрыть терминалы без агента: ${idle.length}`;
  if (existing instanceof HTMLElement) {
    if (existing.title !== title) existing.title = title;
    return;
  }
  const sweep = iconBtn('pgroup-arrow pgroup-sweep', 'power', title, 12);
  sweep.addEventListener('click', (e) => { e.stopPropagation(); closeIdleTerms(); });
  const eye = head.querySelector('.pgroup-eye');
  if (eye) head.insertBefore(sweep, eye);
  else head.appendChild(sweep);
}
// Быстрое переключение активного проекта без сноса #projects и #mini-rail, если карточка уже отрендерена.
function updateActiveProjectDom(prevId, nextId) {
  const box = $('#projects');
  const nextCards = box ? box.querySelectorAll(`.card[data-id="${nextId}"]`) : [];
  if (!nextCards.length) {
    renderProjects();
    return;
  }
  if (prevId && prevId !== nextId) {
    box.querySelectorAll(`.card[data-id="${prevId}"]`).forEach((c) => c.classList.remove('active'));
    document.querySelectorAll(`#mini-rail .rail-btn[data-id="${prevId}"]`).forEach((b) => b.classList.remove('active'));
    refreshProjIndicator(prevId);
  }
  nextCards.forEach((c) => c.classList.add('active'));
  document.querySelectorAll(`#mini-rail .rail-btn[data-id="${nextId}"]`).forEach((b) => b.classList.add('active'));
  refreshProjIndicator(nextId);
  syncFavHeaderSweep();
  renderChips();
}
// Заголовок группы: имя · (✎ ↑ ↓ по наведению) · число · стрелка. Инструменты стоят в раскладке
// всегда и только проявляются, поэтому заголовок не прыгает при наведении.
function renderSection(s, index, sections) {
  const total = sections.length;
  const { label, key, pinned } = s;
  const collapsed = projFilter ? false : isCollapsed(key);   // под фильтром секции всегда раскрыты
  const agentsOnly = key === FAV_KEY && favAgentsOnly() && !projFilter;
  const list = agentsOnly ? s.list.filter((p) => projHasAgent(p.id)) : s.list;
  const sec = el('div', 'pgroup' + (pinned ? ' pinned' : '') + (collapsed ? ' closed' : '') + (list.length ? '' : ' empty') + (agentsOnly ? ' agents-only' : ''));
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
  if (key === FAV_KEY) {
    // Закрыть случайно открытые терминалы (во всех проектах, кроме активного): кнопка видна, только когда есть что закрывать.
    const idle = idleProjects();
    if (idle.length) {
      const sweep = iconBtn('pgroup-arrow pgroup-sweep', 'power', `Закрыть терминалы без агента: ${idle.length}`, 12);
      sweep.addEventListener('click', (e) => { e.stopPropagation(); closeIdleTerms(); });
      head.appendChild(sweep);
    }
    const eye = iconBtn('pgroup-arrow pgroup-eye' + (favAgentsOnly() ? ' on' : ''), 'eye',
      favAgentsOnly() ? 'Показаны только проекты с агентом — показать все' : 'Показать только проекты с агентом (Claude, Codex…)', 13);
    eye.setAttribute('aria-pressed', String(favAgentsOnly()));
    eye.addEventListener('click', (e) => { e.stopPropagation(); setFavAgentsOnly(!favAgentsOnly()); });
    head.appendChild(eye);
  }
  head.appendChild(el('span', 'pgroup-count', agentsOnly ? `${list.length}/${s.list.length}` : String(list.length)));
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
  if (agentsOnly && !list.length) body.appendChild(el('div', 'pgroup-note', 'Агентов сейчас нет'));
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
      saveFavOrder(mergeFavOrder([...body.querySelectorAll('.card')].map((c) => c.dataset.id)));
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
// Новый порядок видимых карточек поверх полного: под глазом «только с агентом» скрытые карточки
// остаются на своих местах, а не съезжают в конец группы.
function mergeFavOrder(visible) {
  const shown = new Set(visible);
  let i = 0;
  return sortFavs(projects.filter((p) => p.favorite)).map((p) => (shown.has(p.id) ? visible[i++] : p.id));
}
// Строка проекта: индикатор · облачко синхронизации · имя · (★ ⋮ — по наведению и у активного).
// Путь — в подсказке имени и в чипе папки под терминалом.
function makeCard(p) {
  const gone = missing.has(p.id);
  const isDet = detachedProjIds.has(p.id);
  const card = el('div', 'card');
  card.dataset.id = p.id;
  if (p.id === activeId) card.classList.add('active');
  if (gone) card.classList.add('missing');
  if (isDet) card.classList.add('detached');
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
  card.appendChild(el('span', 'card-title', p.name));
  const acts = el('div', 'card-acts');
  if (!gone) {
    const detachBtn = iconBtn(
      'card-detach' + (isDet ? ' on' : ''),
      isDet ? 'panels' : 'external-link',
      isDet ? 'Вернуть терминалы в главное окно' : 'Вынести терминалы в отдельное окно',
      13,
    );
    detachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (detachedProjIds.has(p.id)) dockProjectTerminals(p.id);
      else detachProjectTerminals(p);
    });
    acts.appendChild(detachBtn);
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
  if (card) setMenuAnchor(card, 'menu-open');
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
  if (!missing.has(p.id)) {
    if (detachedProjIds.has(p.id)) {
      dd.appendChild(menuRow('external-link', 'Перейти к окну терминалов', () => { closeMenus(); lite.projTerm.focus(p.id); }));
      dd.appendChild(menuRow('panels', 'Вернуть терминалы в главное окно', () => { closeMenus(); dockProjectTerminals(p.id); }));
    } else {
      dd.appendChild(menuRow('external-link', 'Вынести терминалы в окно', () => { closeMenus(); detachProjectTerminals(p); }));
    }
  }
  // терминалы поднимались (в том числе случайным кликом) — закрыть их, оставив проект в списке
  if (tabsByProj.has(p.id) && p.id !== activeId && !detachedProjIds.has(p.id)) {
    const row = menuRow('power', 'Закрыть терминалы', () => { closeMenus(); closeProjectTerms(p); });
    row.appendChild(el('span', 'menu-desc', projHasAgent(p.id) ? 'работает агент' : 'погасит индикатор'));
    dd.appendChild(row);
  }
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
  if (detachedProjIds.has(proj.id)) {
    lite.projTerm.sendText(proj.id, text);
    return;
  }
  termEngine.sendTextToProject(proj, text, { focusProject: true });
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
  const expand = iconBtn('icon-btn', 'panel-left', withHk('Развернуть проекты', 'toggleSingle'), 17);
  expand.id = 'rail-expand';
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
    btn.dataset.id = p.id;
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
  if (detachedProjIds.has(id)) {
    detachedProjIds.delete(id);
    detachedStatuses.delete(id);
    try { lite.projTerm.closeProject(id); } catch (_) {}
    updateAttention();
  }
  const tabs = tabsByProj.get(id);
  if (tabs) {
    for (const sid of tabs.sessions) disposeSession(sid);
    tabsByProj.delete(id);
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
      try { lite.errors.setContext(null); } catch (_) {} // новые ошибки не должны помечаться закрытым проектом
    }
  } else {
    renderProjects();
  }
}

// Flag projects whose folder was deleted on disk so the user can close them.
// Один запрос на все пути (раньше — по IPC на проект, подряд) и перерисовка только если набор
// пропавших изменился: проверка идёт на каждый возврат фокуса в окно, а полная перерисовка списка
// гасит наведение и открытые меню.
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

// ---------------------------------------------------------------- activity indicator & detached windows
let lastNotifyAt = 0;
function notifyAgent(id, state, sid, reason) {
  if (!settings.notifications) return;
  const proj = projects.find((p) => p.id === id);
  if (!proj || Date.now() - lastNotifyAt < 1200) return;
  lastNotifyAt = Date.now();
  const title = agentNotifyTitle(proj.name, state, reason);
  try {
    const n = new Notification(title, { body: proj.path, silent: !settings.sound, tag: 'lite-' + id });
    n.onclick = () => {
      if (detachedProjIds.has(id)) {
        lite.projTerm.focusSession(id, sid);
      } else {
        lite.win.show();
        setActive(id);
        if (sid && terms.has(sid)) switchTab(sid);
      }
    };
  } catch (_) {}
}
let trayAttentionSent = -1;
function updateAttention() {
  let n = [...projState.values()].filter((s) => s === 'waiting').length;
  for (const pid of detachedProjIds) {
    const st = detachedStatuses.get(pid);
    if (st && Number.isFinite(st.waitingCount)) n += st.waitingCount;
  }
  const badge = $('#attention-badge');
  if (badge) {
    badge.replaceChildren(icon('bell', 13), el('span', null, String(n)), el('span', null, n === 1 ? 'ждёт ответа' : 'ждут ответа'));
    badge.classList.toggle('show', n > 0);
  }
  if (n !== trayAttentionSent) { trayAttentionSent = n; lite.tray.update(n); }
}

const detachedSnapshots = new Map(); // projId -> последний снимок вынесенных вкладок
function snapshotToProjTabsRec(snap) {
  if (!snap || !Array.isArray(snap.tabs) || !snap.tabs.length) return null;
  const names = snap.tabs.map((x) => x.name || 'Терминал');
  const custom = snap.tabs.map((x) => !!x.customName);
  const sids = snap.tabs.map((x) => x.sid);
  const act = snap.activeSid ? sids.indexOf(snap.activeSid) : 0;
  const rec = { names, custom, active: act >= 0 ? act : 0 };
  if (Array.isArray(snap.splitPair) && snap.splitPair.length === 2) {
    const i0 = sids.indexOf(snap.splitPair[0]);
    const i1 = sids.indexOf(snap.splitPair[1]);
    if (i0 >= 0 && i1 >= 0 && i0 !== i1) rec.split = [i0, i1];
  }
  return rec;
}
function syncDetachedHint() {
  const hint = $('#detached-hint');
  if (!hint) return;
  const isDet = !!(activeId && detachedProjIds.has(activeId));
  hint.classList.toggle('hidden', !isDet);
  if (isDet) {
    const proj = projects.find((p) => p.id === activeId);
    const title = $('#detached-hint-title');
    if (title) title.textContent = proj ? tt('Терминалы «{0}» вынесены в отдельное окно', proj.name) : tt('Терминалы вынесены в отдельное окно');
  }
}
async function detachProjectTerminals(proj) {
  if (!proj || missing.has(proj.id)) return;
  if (detachedProjIds.has(proj.id)) { lite.projTerm.focus(proj.id); return; }
  if (detachingProjIds.has(proj.id)) return;
  detachingProjIds.add(proj.id);
  try {
    ensureProjectTabs(proj);
    saveProjTabs();
    const snapshot = termEngine.teardownProjectForDetach(proj.id);
    if (!snapshot) return;
    detachedProjIds.add(proj.id);
    detachedSnapshots.set(proj.id, snapshot);
    detachedStatuses.set(proj.id, { projId: proj.id, aggState: 'quiet', waitingCount: 0, waitingSids: [], hasAgent: false, idle: false });
    renderProjects();
    showActiveTerminal();
    updateAttention();
    const res = await lite.projTerm.detach({
      id: proj.id, name: proj.name, path: proj.path, accent: proj.accent || '',
    }, snapshot);
    if (!res || !res.ok) {
      detachedProjIds.delete(proj.id);
      detachedSnapshots.delete(proj.id);
      detachedStatuses.delete(proj.id);
      termEngine.importProjectSnapshot(proj, snapshot, { applySplitFrac: false });
      renderProjects();
      showActiveTerminal();
      updateAttention();
      toast('Не удалось открыть отдельное окно терминалов', { kind: 'err' });
    }
  } finally {
    detachingProjIds.delete(proj.id);
  }
}
function dockProjectTerminals(projId) {
  if (!projId || !detachedProjIds.has(projId)) return;
  lite.projTerm.dock(projId).catch(() => {});
}

// ---- terminal sessions, project indicators & hotkeys ----
function projAggState(projId) {
  if (detachedProjIds.has(projId)) {
    const st = detachedStatuses.get(projId);
    return (st && st.aggState) || 'quiet';
  }
  return termEngine.projAggState(projId);
}
function syncMiniRailIndicator(projId, st = projAggState(projId)) {
  document.querySelectorAll(`#mini-rail .rail-btn[data-id="${projId}"]`).forEach((btn) => {
    const badge = btn.querySelector('.rail-st');
    if (st === 'idle') {
      if (badge) badge.remove();
      return;
    }
    if (badge) {
      const ind = badge.querySelector('.pind');
      if (ind) ind.className = 'pind ' + st;
      return;
    }
    const nextBadge = el('span', 'rail-st');
    const ind = el('span', 'pind ' + st);
    ind.dataset.id = projId;
    nextBadge.appendChild(ind);
    btn.appendChild(nextBadge);
  });
}
function refreshProjIndicator(projId) {
  const st = projAggState(projId);
  document.querySelectorAll(`.pind[data-id="${projId}"]`).forEach((i) => { i.className = 'pind ' + st; });
  syncMiniRailIndicator(projId, st);
}
function projHasAgent(projId) {
  if (detachedProjIds.has(projId)) {
    const st = detachedStatuses.get(projId);
    return !!(st && st.hasAgent);
  }
  return termEngine.projHasAgent(projId);
}
function projIdle(projId) {
  if (detachedProjIds.has(projId)) return false;
  return termEngine.projIdle(projId);
}
function idleProjects() { return projects.filter((p) => projIdle(p.id)); }
function syncAgentListAfterScan() {
  const favOnly = favAgentsOnly() && !projFilter;
  const favSig = favOnly ? projects.filter((p) => p.favorite && projHasAgent(p.id)).map((p) => p.id).join(',') : '';
  const idleSig = idleProjects().map((p) => p.id).join(',');
  const sig = favSig + '|' + idleSig;
  if (sig === agentSig) return;
  if (favOnly && favSig !== agentFavSig) {
    if (favDragCard || $('#menu-layer').firstChild) return;
    renderProjects();
    agentFavSig = favSig;
    agentSig = sig;
    return;
  }
  agentFavSig = favSig;
  agentSig = sig;
  syncFavHeaderSweep();
}
function closeIdleTerms() {
  const list = idleProjects();
  if (!list.length) return;
  showConfirm('Закрыть терминалы без агента?',
    `Проекты: ${list.map((p) => p.name).join(', ')}. В их терминалах ничего не запущено — закроются только шеллы, проекты останутся в списке.`,
    'Закрыть терминалы', async () => {
      await refreshAgents();
      const n = list.filter((p) => projIdle(p.id) && unloadProjectTerms(p.id)).length;
      renderProjects();
      if (n) toast(`Закрыты терминалы проектов: ${n}`);
    });
}
async function closeProjectTerms(p) {
  if (!tabsByProj.has(p.id) || p.id === activeId || detachedProjIds.has(p.id)) return;
  await refreshAgents();
  const go = () => { if (unloadProjectTerms(p.id)) renderProjects(); };
  if (projIdle(p.id)) { go(); return; }
  const agent = projSessions(p.id).map((s) => termEngine.sessionAgent(s)).find(Boolean);
  showConfirm(`Закрыть терминалы проекта «${p.name}»?`,
    agent ? `В терминале работает агент ${agent} — он будет остановлен. Проект останется в списке.`
      : 'В терминале может работать программа — она будет остановлена. Проект останется в списке.',
    'Закрыть терминалы', go);
}
function saveProjTabs() {
  const out = {};
  const prev = STORE.projTabs || {};
  for (const p of projects) {
    if (detachedProjIds.has(p.id) && detachedSnapshots.has(p.id)) {
      const rec = snapshotToProjTabsRec(detachedSnapshots.get(p.id));
      if (rec) out[p.id] = rec;
      continue;
    }
    if (!tabsByProj.has(p.id) && prev[p.id]) out[p.id] = prev[p.id];
  }
  for (const [pid, t] of tabsByProj) {
    const rec = {
      names: t.sessions.map((s) => (tabMeta(s) || {}).name || 'Терминал'),
      custom: t.sessions.map((s) => !!(tabMeta(s) || {}).customName),
      active: t.sessions.indexOf(t.active),
    };
    if (Array.isArray(t.splitPair) && t.splitPair.length === 2) {
      const i0 = t.sessions.indexOf(t.splitPair[0]);
      const i1 = t.sessions.indexOf(t.splitPair[1]);
      if (i0 >= 0 && i1 >= 0 && i0 !== i1) rec.split = [i0, i1];
    }
    out[pid] = rec;
  }
  persist('projTabs', out);
}

try { if (STORE.sessionSnaps) { STORE.sessionSnaps = null; lite.store.set('sessionSnaps', null); } } catch (_) {}

let hotkeyRecording = false;
function hkLabel(id) { return formatCombo(getHotkey(settings, id)); }
function withHk(text, id) {
  const k = hkLabel(id);
  const base = tt(text);
  return k ? `${base} (${k})` : base;
}
function syncHotkeyHints() {
  const singleOn = $('#app')?.classList.contains('single');
  const bs = $('#btn-single');
  if (bs instanceof HTMLElement) bs.title = withHk(singleOn ? 'Развернуть проекты' : 'Один терминал', 'toggleSingle');
  const ta = $('#term-tab-add');
  if (ta instanceof HTMLElement) ta.title = withHk('Новая вкладка', 'newTab');
  const tf = $('#term-find');
  if (tf instanceof HTMLElement) tf.title = withHk('Поиск в терминале', 'termSearch');
  const fd = $('#files-dock-close');
  if (fd instanceof HTMLElement) fd.title = withHk('Скрыть панель', 'openFiles');
  const re = $('#rail-expand');
  if (re instanceof HTMLElement) re.title = withHk('Развернуть проекты', 'toggleSingle');
  termEngine.renderTabBar();
}
function applyHotkeysLive() {
  saveSettings();
  syncHotkeyHints();
  try { lite.app.settingsChanged(settings); } catch (_) {}
}
function isTextEntry(t) {
  if (!t || (t.closest && t.closest('.xterm'))) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}
function runGlobalHotkey(e) {
  if (hotkeyRecording) return false;
  if (isTextEntry(e.target)) return false;
  if (matchesAction(e, settings, 'toggleSingle')) { e.preventDefault(); toggleSingle(); return true; }
  if (matchesAction(e, settings, 'palette')) { e.preventDefault(); showPalette(); return true; }
  if (matchesAction(e, settings, 'globalSearch')) { e.preventDefault(); showGlobalSearch(); return true; }
  if (matchesAction(e, settings, 'openFiles')) { e.preventDefault(); openModule('files'); return true; }
  if (matchesAction(e, settings, 'openSettings')) { e.preventDefault(); if (!document.querySelector('.settings-modal')) showSettings(); return true; }
  if (matchesAction(e, settings, 'fontUp')) { e.preventDefault(); bumpFont(1); return true; }
  if (matchesAction(e, settings, 'fontDown')) { e.preventDefault(); bumpFont(-1); return true; }
  if (matchesAction(e, settings, 'nextProject')) { e.preventDefault(); cycleProject(1); return true; }
  if (matchesAction(e, settings, 'prevProject')) { e.preventDefault(); cycleProject(-1); return true; }
  if (termEngine.handleTermHotkey(e)) { e.preventDefault(); return true; }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    e.preventDefault();
    const p = visibleOrderedProjects()[+e.code.slice(5) - 1];
    if (p) setActive(p.id);
    return true;
  }
  return false;
}

// Перезапуск dev-терминала модуля — в его СОБСТВЕННОЙ папке (cwd запоминаем при создании).
function restartExtTerminal(id) {
  const r = extTerms.get(id);
  if (!r) return;
  try { r.term.reset(); } catch (_) {}
  try { r.timeline.reset(); } catch (_) {}
  dropPtyAck(id);
  lite.pty.restart({ id, cwd: r.cwd, cols: r.term.cols, rows: r.term.rows });
  r.term.focus();
}

// Терминал dev-папки модуля: PTY+xterm в переданном контейнере (живёт в #ext-pane).
function createExtTerminal(container, cwd) {
  const id = EXT_TERM_ID + '::t' + (++extTermSeq) + '.' + BOOT_ID;
  const { term, fit, search, timeline, syncPty } = buildXterm(container, id, { cwd });
  const extRec = { term, fit, search, timeline, syncPty, container, cwd, needsFit: false };
  extTerms.set(id, extRec);
  activateRenderer(term);
  return {
    id,
    write: (s) => lite.pty.write(id, s),
    focus: () => { try { term.focus(); } catch (_) {} },
    refit: () => requestAnimationFrame(() => { try { fit.fit(); syncPty(); extRec.needsFit = false; } catch (_) {} }),
    dispose: () => { lite.pty.kill(id); dropPtyAck(id); releaseRenderer(term); try { timeline.dispose(); } catch (_) {} try { term.dispose(); } catch (_) {} extTerms.delete(id); },
  };
}

let watchedRoot = null; // we live-watch only the active project to limit inotify use
function applyFontSize({ notify = true } = {}) {
  termEngine.applyFontSize();
  if (notify) {
    try { lite.app.settingsChanged(settings); } catch (_) {}
  }
}
function bumpFont(delta) {
  settings.fontSize = Math.max(9, Math.min(24, settings.fontSize + delta));
  saveSettings(); applyFontSize();
}

function jumpToSession(projId, sid) {
  setActive(projId);
  if (detachedProjIds.has(projId)) {
    lite.projTerm.focusSession(projId, sid);
    return;
  }
  const t = tabsByProj.get(projId);
  if (t && t.sessions.includes(sid)) { materializeSession(sid); t.active = sid; saveProjTabs(); }
  showActiveTerminal();
}

// Окно «Найти во всех проектах» (renderer/gsearch.js): содержимое и имена файлов через стриминговый
// бэкенд gsearch:*, плюс прежний поиск по буферам открытых терминалов (локальных и вынесенных).
function showGlobalSearch(initial = {}) {
  openGlobalSearch({
    lite,
    projects: () => projects,
    activeId: () => activeId,
    setActive,
    openInViewer: (p, line) => lite.editorBus.openInViewer(p, line),
    terms: () => terms,
    searchDetachedTerms: (query) => (detachedProjIds.size ? lite.projTerm.searchBuffers({ query }) : Promise.resolve([])),
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
  const prevId = activeId;
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
  updateActiveProjectDom(prevId, id);
  showActiveTerminal();
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
const WINDOW_MODULES = new Set(['tools', 'iterflow', 'seo', 'audit', 'company', 'notes', 'db', 'rmq', 'kafka', 'chat', 'doc', 'docker', 'rh', 'ctx', 'scratch', 'files', 'pomodoro', 'monitor', 'keepass', 'storage', 'jira', 'voice', 'gitgraph', 'servers']);
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

// ---------------------------------------------------------------- встроенный док «Проект» (#files-dock)
let filesDockOpen = false;
let filesDockMounted = false;
function ensureFilesDockFrame() {
  const frame = /** @type {HTMLIFrameElement | null} */ ($('#files-dock-frame'));
  if (!frame) return;
  if (!filesDockMounted) {
    filesDockMounted = true;
    frame.src = 'module.html?embed=1#files';
  }
}
function unmountFilesDock() {
  filesDockOpen = false;
  filesDockMounted = false;
  const dock = $('#files-dock'), gut = $('#gutter-files');
  if (dock) dock.classList.add('hidden');
  if (gut) gut.classList.add('hidden');
  const frame = /** @type {HTMLIFrameElement | null} */ ($('#files-dock-frame'));
  if (frame) frame.src = 'about:blank';
  try { if (lite.editorBus.filesDockState) lite.editorBus.filesDockState(false); } catch (_) {}
  markOpenModules();
  refitActiveTerminal();
}
function setFilesDockOpen(open) {
  const want = !!open;
  if (want === filesDockOpen && (!want || filesDockMounted)) return;
  const alreadyMounted = filesDockMounted;
  if (want) {
    closeOtherPanels('files');
    ensureFilesDockFrame();
  }
  filesDockOpen = want;
  const dock = $('#files-dock'), gut = $('#gutter-files');
  if (dock) dock.classList.toggle('hidden', !want);
  if (gut) gut.classList.toggle('hidden', !want);
  try { if (lite.editorBus.filesDockState) lite.editorBus.filesDockState(want); } catch (_) {}
  if (want && alreadyMounted) { try { lite.editorBus.refreshTree(); } catch (_) {} }
  applyLayout();
  markOpenModules();
  refitActiveTerminal();
}
function toggleFilesDock() { setFilesDockOpen(!filesDockOpen); }
registerPanel('files', { isOpen: () => filesDockOpen, setOpen: setFilesDockOpen });
PANEL_ORDER.push('files');

// Entry point used by the «Модули» menu / quickbar. Мигрированные модули открываются окном (или доком для files).
function openModule(id) {
  if (id === 'git') { lite.editorBus.focusGit(); return; } // Git встроен в вивер → открыть на секции «Коммит»
  if (id === 'files' && settings.dockFiles) { toggleFilesDock(); return; }
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
  { id: 'gitgraph', icon: 'gitgraph', label: 'Граф Git — ветки и коммиты схемой' },
  { id: 'ctx',     icon: 'graph',    label: 'Контекст — граф контекста агента' },
  { id: 'docker',  icon: 'box',      label: 'Контейнеры — Docker / Podman' },
  { id: 'db',      icon: 'database', label: 'Базы данных — Postgres / MySQL / SQLite' },
  { id: 'rmq',     icon: 'rabbit',   label: 'RabbitMQ — очереди, сообщения, подключения' },
  { id: 'kafka',   icon: 'kafka',    label: 'Kafka — топики, группы, live-tail' },
  { id: 'storage', icon: 'cloud',    label: 'Внешние хранилища — S3, бакеты, объекты' },
  { id: 'rh',      icon: 'globe',    label: 'Удалённые хосты — SSH-сессии' },
  { id: 'servers', icon: 'server',   label: 'Серверы — дашборд: ресурсы, проекты, сеть, контейнеры, сайты' },
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
    if (!(b instanceof HTMLElement)) return;
    const id = b.dataset.mod;
    const isOpen = openModuleIds.has(id) || (id === 'files' && filesDockOpen);
    b.classList.toggle('open', isOpen);
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
    const n = Array.isArray(arr) ? arr.filter((r) => r && !r.done && r.at && !Number.isNaN(Date.parse(r.at)) && new Date(r.at).getTime() < eod).length : 0;
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
    if (!(g instanceof HTMLElement)) return;
    const target = g.dataset.resize;
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = layout[target];
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let w = target === 'sidebar' ? startW + dx : startW - dx;
        const maxW = target === 'filesDock' ? Math.max(480, window.innerWidth - 360) : 1000;
        layout[target] = Math.max(150, Math.min(maxW, w));
        applyLayout();
        refitActiveTerminalSoon();   // reflow буфера не на каждый кадр (см. term-core)
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        refitActiveTerminal();
        saveLayout();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---------------------------------------------------------------- оболочка: боковая карточка и нижняя полоса
// Кнопки, которые живут в index.html постоянно (не перерисовываются): навигация и подвал боковой
// карточки, чипы активного проекта, «+» быстрой панели, пустой экран.
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
  $('#qb-more').addEventListener('click', () => showModulesCatalog());
  $('#empty-open').addEventListener('click', () => openProjectDialog());
  const df = $('#detached-focus'), dd = $('#detached-dock');
  if (df) df.addEventListener('click', () => { if (activeId) lite.projTerm.focus(activeId); });
  if (dd) dd.addEventListener('click', () => { if (activeId) dockProjectTerminals(activeId); });
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
// менюшки вынесены в renderer/ui.js; тут оставляем двухстрочную строку каталога модулей.
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
      storeFrozen = true;   // до перезагрузки — ни одной записи старого состояния поверх импорта
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
  c1.appendChild(menuRow('panel-left', 'Один терминал', go(toggleSingle), '', { kbd: hkLabel('toggleSingle') }));
  c1.appendChild(menuRow('cmd', 'Палитра команд', go(showPalette), '', { kbd: hkLabel('palette') }));
  c1.appendChild(menuRow('search', 'Поиск в терминале', go(openTermSearch), '', { kbd: hkLabel('termSearch') }));
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
  { id: 'gitgraph', icon: 'gitgraph', title: 'Граф Git',          desc: 'ветки и коммиты схемой на канве', project: true },
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
  { id: 'servers',  icon: 'server',   title: 'Серверы',            desc: 'дашборд: ресурсы · проекты · сеть · контейнеры · сайты' },
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
  /** @type {Array<[string, string, () => number]>} */
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
  /** @type {Array<[string, string, number, number, number, string, () => number, (v: number) => void]>} */
  const RANGES = [
    ['alpha', 'Непрозрачность фона', 60, 100, 1, '%', () => lookOf(settings).alpha, (v) => editLook((l) => { l.alpha = v; })],
    ['r', 'Скругление', 4, 22, 1, 'px', () => lookOf(settings).r, (v) => editLook((l) => { l.r = v; })],
    ['side', 'Ширина панели', 240, 440, 2, 'px', () => layout.sidebar, (v) => { layout.sidebar = v; applyLayout(); refitActiveTerminalSoon(); clearTimeout(lookLayoutT); lookLayoutT = setTimeout(() => { saveLayout(); refitActiveTerminal(); }, 250); }],
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
      // Проверка значений ДО записи в settings: lookOf отбрасывает мусор, но на значении-массиве
      // (["#aabbcc"] проходит HEX.test) бросает — сырой объект остался бы в settings.look, ушёл бы на диск
      // со следующим saveSettings и ронял бы применение темы (и init) при каждом запуске.
      let look;
      try { look = lookOf({ look: { accent: o.accent, r: o.r, row: o.row, alpha: o.alpha, base: o.base, status: o.status, over: o.over } }); }
      catch (_) { toast('В буфере обмена нет темы — сначала скопируйте её', { kind: 'warn' }); return; }
      settings.look = look;
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
  const fb = $('#chip-folder'), bb = $('#chip-branch');
  if (!fb) return;
  fb.classList.toggle('hidden', !p);
  if (!p) { bb.classList.add('hidden'); return; }
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
}
function refreshGitChip(delay = 400) {
  clearTimeout(gitChipT);
  gitChipT = setTimeout(async () => {
    const p = activeProject();
    if (!p || missing.has(p.id)) { gitChip = { projId: p ? p.id : null, repo: false, branch: '', ahead: 0, behind: 0, files: [] }; renderChips(); return; }
    const seq = ++gitChipSeq;
    let info, st;
    try { [info, st] = await Promise.all([lite.git.info(p.path), lite.git.status(p.path)]); } catch (_) { info = null; }
    if (seq !== gitChipSeq) return;          // пока ждали, проект сменился — ответ устарел
    if (!info || !info.repo) { gitChip = { projId: p.id, repo: false, branch: '', ahead: 0, behind: 0, files: [] }; renderChips(); return; }
    const base = p.path.replace(/[\\/]+$/, '');
    // префикс — с разделителем: иначе у проекта /repo/app файл /repo/app-old/x показывался бы как «old/x»
    const inBase = (abs) => abs.startsWith(base + '/') || abs.startsWith(base + '\\');
    const files = Object.entries((st && st.files) || {}).map(([abs, code]) => ({ abs, code, rel: inBase(abs) ? abs.slice(base.length + 1) : abs }));
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
  dd.appendChild(menuRow('terminal', 'Новая вкладка терминала', () => { closeMenus(); addTab(); }, '', { kbd: hkLabel('newTab') }));
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
  // «Граф веток» — отдельное окно «Граф Git»: история веток и коммитов схемой (только просмотр)
  const graphBtn = el('button', 'btn'); graphBtn.append(icon('gitgraph', 14), el('span', null, 'Граф веток'));
  graphBtn.title = 'Ветки и коммиты схемой — отдельное окно «Граф Git»';
  graphBtn.onclick = () => { closeMenus(); openModule('gitgraph'); };
  const upd = el('button', 'btn'); upd.append(icon('refresh', 14), el('span', null, 'Обновить'));
  upd.onclick = () => { closeMenus(); refreshGitChip(0); };
  btns.append(gitBtn, graphBtn, upd);
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

// Промпты и контекстное меню терминала перенесены в renderer/term-core.js.

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
    // Сэмплы — недоверенный текст (стеки, ответы серверов, имена файлов), а пишется он в PTY как
    // нажатия клавиш: \r отправил бы агенту недочитанный текст, Ctrl+C/ESC — сработали бы как клавиши,
    // переводы строк стека разорвали бы список. Схлопываем управляющие символы — одна строка на ошибку.
    const oneLine = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
    const lines = open.slice(0, 40).map((e) => `- [${oneLine(e.level)}] ${oneLine(e.source)}: ${oneLine(e.sample)} (×${e.count}, id ${oneLine(e.id)})`).join('\n');
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
  ['keys', 'keyboard', 'Горячие клавиши'],
  ['notif', 'bell', 'Уведомления'],
  ['upd', 'refresh', 'Обновления'],
  ['proj', 'folder', 'Проекты и папки'],
  ['ss', 'sparkles', 'Заставка'],
];
function showSettings(start = 'look') {
  closeMenus();
  /** @type {(rerender?: boolean) => void} */
  let stopRecording = () => {};
  const { m, close } = makeModal(`
    <aside class="snav"><div class="st-title">Настройки</div><div class="snav-list"></div><span class="grow"></span><div class="sver"></div></aside>
    <section class="scontent"><div class="shead"><h3></h3><button class="icon-btn" id="st-x" title="Закрыть" aria-label="Закрыть"></button></div><div class="sbody"></div>
      <div class="sfoot"><button class="btn primary" id="st-ok">Готово</button></div></section>`, () => { stopRecording(); scanProjects(); });
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
      body.appendChild(row('Панель «Проект» внутри главного окна', 'Дерево файлов, редактор кода и Git закрепляются справа от терминала вместо отдельного окна (Ctrl+Shift+E).', toggle(!!settings.dockFiles, (v) => {
        settings.dockFiles = v;
        save();
        if (!v) unmountFilesDock();
        try { lite.editorBus.dockFiles(v); } catch (_) {}
      })));
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
      // Оболочка Linux ($SHELL / /bin/bash по умолчанию либо пользовательский путь).
      const curShell = settings.shell || '';
      const custom = Boolean(curShell);
      const path = el('input', 'set-txt mono'); path.placeholder = 'путь к исполняемому файлу'; path.spellcheck = false; path.value = custom ? curShell : '';
      const shell = select([['', 'bash (по умолчанию)'], ['__custom__', 'Свой путь…']],
        custom ? '__custom__' : '', (v) => {
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
      body.appendChild(row('Предупреждать при выходе с активными терминалами', 'Спрашивать подтверждение при закрытии главного окна, если в терминалах работают агенты или выполняются команды.',
        toggle(settings.confirmQuitWithAgents !== false, (v) => { settings.confirmQuitWithAgents = v; save(); })));
    },
    keys() {
      let filterQuery = '';
      /** @type {string | null} */
      let recordingId = null;
      /** @type {HTMLButtonElement | null} */
      let activeRecBtn = null;
      /** @type {{ id: string, kind: 'error' | 'conflict', text: string, combo?: string, conflicts?: any[] } | null} */
      let pendingAlert = null;
      /** @type {((ev: KeyboardEvent) => void) | null} */
      let onRecKeyDown = null;
      /** @type {((ev: KeyboardEvent) => void) | null} */
      let onRecKeyUp = null;

      const detachRecListeners = () => {
        hotkeyRecording = false;
        activeRecBtn = null;
        if (onRecKeyDown) { window.removeEventListener('keydown', onRecKeyDown, true); onRecKeyDown = null; }
        if (onRecKeyUp) { window.removeEventListener('keyup', onRecKeyUp, true); onRecKeyUp = null; }
      };
      stopRecording = (rerender = false) => {
        const wasRecording = recordingId !== null;
        recordingId = null;
        detachRecListeners();
        if (rerender && wasRecording) renderList();
      };

      const renderComboBtn = (btn, combo) => {
        btn.replaceChildren();
        const parts = formatComboParts(combo);
        btn.classList.toggle('empty', parts.length === 0);
        if (!parts.length) {
          btn.textContent = 'Не назначено';
          return;
        }
        parts.forEach((p, idx) => {
          if (idx > 0) btn.appendChild(document.createTextNode('+'));
          btn.appendChild(el('kbd', null, p));
        });
      };

      const renderPreview = (e) => {
        if (!activeRecBtn) return;
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        if (e.metaKey) mods.push('Meta');
        activeRecBtn.textContent = mods.length ? mods.join('+') + '+…' : 'Нажмите клавиши…';
      };

      const commitCombo = (actionId, combo, { replace = false } = {}) => {
        const v = validateHotkeyForAction(actionId, combo);
        if (v.ok === false) {
          pendingAlert = { id: actionId, kind: 'error', text: tt(v.reason) };
          renderList();
          return;
        }
        const conflicts = v.combo ? findConflicts(settings.hotkeys, actionId, v.combo) : [];
        if (conflicts.length && !replace) {
          pendingAlert = {
            id: actionId,
            kind: 'conflict',
            text: tt('«{0}» уже занято: {1}', formatCombo(v.combo), conflicts.map((c) => tt(c.label)).join(', ')),
            combo: v.combo,
            conflicts,
          };
          renderList();
          return;
        }
        let next = settings.hotkeys;
        if (replace && conflicts.length) {
          for (const c of conflicts) next = setHotkeyOverride(next, c.id, '');
        }
        settings.hotkeys = setHotkeyOverride(next, actionId, v.combo);
        pendingAlert = null;
        applyHotkeysLive();
        renderList();
      };

      const startRecording = (actionId) => {
        if (recordingId === actionId) { stopRecording(true); return; }
        stopRecording(false);
        pendingAlert = null;
        recordingId = actionId;
        hotkeyRecording = true;

        onRecKeyDown = (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          const res = eventToCombo(e);
          if (res.status === 'modifier') { renderPreview(e); return; }
          if (res.status === 'cancel') { stopRecording(true); return; }
          stopRecording(false);
          if (res.status === 'invalid') {
            pendingAlert = { id: actionId, kind: 'error', text: tt(res.reason) };
            renderList();
            return;
          }
          commitCombo(actionId, res.combo);
        };
        onRecKeyUp = (e) => {
          if (recordingId !== actionId) return;
          renderPreview(e);
        };
        window.addEventListener('keydown', onRecKeyDown, true);
        window.addEventListener('keyup', onRecKeyUp, true);
        renderList();
      };

      const bar = el('div', 'hk-bar');
      const search = /** @type {HTMLInputElement} */ (el('input', 'set-txt hk-search'));
      search.type = 'search';
      search.placeholder = 'Поиск по действию или клавише…';
      search.spellcheck = false;
      search.addEventListener('focus', () => stopRecording(true));
      search.addEventListener('input', () => {
        filterQuery = search.value.trim().toLowerCase();
        renderList();
      });
      const resetAll = /** @type {HTMLButtonElement} */ (button('Сбросить все', 'refresh', () => {
        stopRecording(false);
        pendingAlert = null;
        settings.hotkeys = {};
        applyHotkeysLive();
        renderList();
      }));
      bar.append(search, resetAll);
      body.appendChild(bar);
      body.appendChild(el('div', 'hk-hint', 'Нажмите на сочетание и введите новые клавиши. Esc — отмена записи. Изменения применяются сразу.'));

      const listEl = el('div', 'hk-list');
      body.appendChild(listEl);

      function renderList() {
        const hasOverrides = HOTKEY_DEFS.some((d) => getHotkey(settings, d.id) !== d.defaultCombo);
        resetAll.disabled = !hasOverrides;
        activeRecBtn = null;
        listEl.replaceChildren();
        let shown = 0;

        for (const grp of HOTKEY_GROUPS) {
          const items = HOTKEY_DEFS.filter((d) => {
            if (d.group !== grp.id) return false;
            if (!filterQuery) return true;
            const curCombo = getHotkey(settings, d.id);
            const hay = `${tt(d.label)} ${tt(d.desc)} ${formatCombo(curCombo)} ${formatCombo(d.defaultCombo)}`.toLowerCase();
            return hay.includes(filterQuery);
          });
          if (!items.length) continue;
          shown += items.length;
          listEl.appendChild(el('div', 'hk-group-title', grp.label));

          for (const def of items) {
            const curCombo = getHotkey(settings, def.id);
            const modified = curCombo !== def.defaultCombo;
            const isRec = recordingId === def.id;

            const rowEl = el('div', 'hk-row' + (modified ? ' modified' : ''));
            const main = el('div', 'hk-row-main');

            const info = el('div', 'hk-info');
            const titleEl = el('b');
            titleEl.append(el('span', 'hk-dot'), el('span', null, def.label));
            info.appendChild(titleEl);
            if (def.desc) info.appendChild(el('span', null, def.desc));

            const ctl = el('div', 'hk-ctl');
            const bindBtn = /** @type {HTMLButtonElement} */ (el('button', 'hk-bind' + (isRec ? ' recording' : '')));
            bindBtn.type = 'button';
            bindBtn.title = isRec ? 'Нажмите новое сочетание или Esc для отмены' : 'Назначить клавиши';
            if (isRec) {
              bindBtn.textContent = 'Нажмите клавиши…';
              activeRecBtn = bindBtn;
            } else {
              renderComboBtn(bindBtn, curCombo);
            }
            bindBtn.addEventListener('click', () => startRecording(def.id));

            const clearBtn = /** @type {HTMLButtonElement} */ (iconBtn('icon-btn hk-act', 'x', 'Отключить сочетание', 13));
            clearBtn.disabled = !curCombo;
            clearBtn.addEventListener('click', () => {
              stopRecording(false);
              commitCombo(def.id, '');
            });

            const resetBtn = /** @type {HTMLButtonElement} */ (iconBtn('icon-btn hk-act', 'refresh', 'Сбросить по умолчанию', 13));
            resetBtn.disabled = !modified;
            resetBtn.addEventListener('click', () => {
              stopRecording(false);
              commitCombo(def.id, def.defaultCombo);
            });

            ctl.append(bindBtn, clearBtn, resetBtn);
            main.append(info, ctl);
            rowEl.appendChild(main);

            if (pendingAlert && pendingAlert.id === def.id) {
              const al = el('div', 'hk-alert');
              al.appendChild(el('span', 'hk-alert-msg', pendingAlert.text));
              if (pendingAlert.kind === 'conflict' && pendingAlert.combo) {
                const repCombo = pendingAlert.combo;
                const repBtn = /** @type {HTMLButtonElement} */ (el('button', 'btn primary', 'Заменить'));
                repBtn.type = 'button';
                repBtn.addEventListener('click', () => commitCombo(def.id, repCombo, { replace: true }));
                const cancelBtn = /** @type {HTMLButtonElement} */ (el('button', 'btn', 'Отмена'));
                cancelBtn.type = 'button';
                cancelBtn.addEventListener('click', () => { pendingAlert = null; renderList(); });
                al.append(repBtn, cancelBtn);
              }
              rowEl.appendChild(al);
            }

            listEl.appendChild(rowEl);
          }
        }

        if (!shown) listEl.appendChild(el('div', 'hk-empty', 'Ничего не найдено'));
      }

      renderList();
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
    stopRecording();
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
  acts.push({ label: 'Проект — вивер, дерево, Git', hint: hkLabel('openFiles'), run: () => openModule('files') });
  acts.push({ label: 'Граф Git — ветки и коммиты схемой', run: () => openModule('gitgraph') });
  acts.push({ label: 'Контекст — граф контекста агента', run: () => openModule('ctx') });
  acts.push({ label: 'Контейнеры (Docker / Podman)', run: () => openModule('docker') });
  acts.push({ label: 'Базы данных (Postgres / MySQL / SQLite)', run: () => openModule('db') });
  acts.push({ label: 'Внешние хранилища (S3 — бакеты, объекты)', run: () => openModule('storage') });
  acts.push({ label: 'Задачи — заметки проекта', run: () => openModule('notes') });
  acts.push({ label: 'ИИ компания — команда агентов над проектом', run: () => openModule('company') });
  acts.push({ label: 'Помодоро — таймер работы/отдыха', run: () => openModule('pomodoro') });
  acts.push({ label: 'Озвучка — читать скопированный текст голосом', run: () => openModule('voice') });
  acts.push({ label: 'Jira — свои задачи из нескольких аккаунтов', run: () => openModule('jira') });
  acts.push({ label: 'Избранное: только проекты с агентом — вкл/выкл', hint: favAgentsOnly() ? 'сейчас включено' : 'сейчас выключено', run: () => setFavAgentsOnly(!favAgentsOnly()) });
  acts.push({ label: 'Закрыть терминалы без агента', run: async () => { await refreshAgents(); if (idleProjects().length) closeIdleTerms(); else toast('Закрывать нечего — простаивающих терминалов нет'); } });
  acts.push({ label: 'Режим «один терминал»', hint: hkLabel('toggleSingle'), run: toggleSingle });
  acts.push({ label: 'Поиск в терминале', hint: hkLabel('termSearch'), run: openTermSearch });
  acts.push({ label: 'Найти во всех проектах — файлы и терминалы', hint: hkLabel('globalSearch'), run: () => showGlobalSearch() });
  acts.push({ label: 'Поиск по всем терминалам', run: () => showGlobalSearch({ mode: 'terms' }) });
  acts.push({ label: 'Очистить терминал', run: () => clearTerminal() });
  acts.push({ label: 'Разделить терминал — вкл/выкл', hint: hkLabel('termSplit'), run: () => toggleTermSplit() });
  acts.push({ label: 'Шкала времени слева — вкл/выкл', hint: settings.termTimeline === true ? 'сейчас включена' : 'сейчас выключена', run: () => { settings.termTimeline = settings.termTimeline !== true; saveSettings(); applyTimeline(); } });
  acts.push({ label: 'Перезапустить терминал', run: () => restartTerminal() });
  acts.push({ label: 'Настройки…', hint: hkLabel('openSettings'), run: () => showSettings() });
  acts.push({ label: 'Настройки: Горячие клавиши…', run: () => showSettings('keys') });
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
  $('#btn-single').title = withHk(on ? 'Развернуть проекты' : 'Один терминал', 'toggleSingle');
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
  if (updPhase.phase === 'downloading') { toast(`Обновление уже загружается — ${Math.max(0, Math.min(100, updPhase.pct || 0))} %`); return; }
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

// ── Помодоро: оверлей отдыха над зоной терминалов (из term-core.js) ───────────────────
const applyRestGuard = createRestGuardController({
  lite,
  onRestored: () => {
    try {
      showActiveTerminal();
      const r = terms.get(activeSessionId());
      if (r) r.term.focus();
    } catch (_) {}
  },
});

function init() {
  hydrateIcons(); // fill the static [data-icon] buttons (titlebar / pane toolbars) with SVG
  // Часть стора не прочиталась (права, нехватка дескрипторов): main эти ключи до перезапуска не пишет,
  // чтобы «пусто» не легло поверх настоящих данных. Человеку — сказать, что правки там не сохранятся.
  if (Array.isArray(STORE.__readFailed) && STORE.__readFailed.length) {
    setTimeout(() => toast(tt('Не прочитались данные редактора ({0}) — изменения в них не сохранятся до перезапуска. Подробности — в «Логах»', STORE.__readFailed.join(', ')), { kind: 'err', ttl: 15000 }), 800);
  }
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

  lite.pty.onData(({ id, data }) => termEngine.handlePtyData(id, data));
  lite.pty.onExit(({ id }) => termEngine.handlePtyExit(id));
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
    const q = $('#proj-filter'), clr = $('#proj-filter-clear'), box = $('#projects');
    let filterRaf = 0;
    let savedScrollTop = 0;
    const applyNow = () => {
      if (filterRaf) { cancelAnimationFrame(filterRaf); filterRaf = 0; }
      const next = q.value.trim().toLowerCase();
      if (!projFilter && next && box) savedScrollTop = box.scrollTop;
      const clearing = !!(projFilter && !next);
      projFilter = next;
      clr.classList.toggle('hidden', !projFilter);
      renderProjects({ skipRail: true });
      if (clearing && box) box.scrollTop = savedScrollTop;
    };
    q.addEventListener('input', () => {
      if (filterRaf) return;
      filterRaf = requestAnimationFrame(applyNow);
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { q.value = ''; applyNow(); q.blur(); }
      // Enter — открыть первый найденный проект: фильтр работает и как быстрый переключатель
      if (e.key === 'Enter') { applyNow(); const first = buildSections()[0]; if (first && first.list[0]) setActive(first.list[0].id); }
    });
    clr.addEventListener('click', () => { q.value = ''; applyNow(); q.focus(); });
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
  if (lite.editorBus.onEnsureFilesDock) {
    lite.editorBus.onEnsureFilesDock((opts) => {
      if (opts && opts.close) unmountFilesDock();
      else if (opts && opts.toggle) toggleFilesDock();
      else setFilesDockOpen(true);
    });
  }
  lite.pomodoro.onTick((s) => { try { updatePomoUI(s); } catch (_) {} });        // мини-таймер в титлбаре + бейдж квикбара
  lite.pomodoro.onChime(({ to }) => { try { pomoChime(to); } catch (_) {} });     // звон смены фазы
  // Набор открытых окон-модулей → подсветка кнопок квикбара (идея 3).
  try { if (lite.module && lite.module.onOpenSet) lite.module.onOpenSet((ids) => { openModuleIds = new Set(ids || []); markOpenModules(); }); } catch (_) {}
  { const mini = $('#pomo-mini'); if (mini) mini.onclick = (e) => { e.stopPropagation(); showPomoMenu(mini); }; }
  lite.pomodoro.getState().then((s) => updatePomoUI(s)).catch(() => {});          // стартовый снимок (таймер мог идти до открытия редактора)
  termEngine.bindUiEvents();
  { const fc = $('#files-dock-close'); if (fc) fc.addEventListener('click', () => setFilesDockOpen(false)); }
  {
    const fp = $('#files-dock-popout');
    if (fp) fp.addEventListener('click', () => {
      settings.dockFiles = false;
      saveSettings();
      unmountFilesDock();
      try { lite.editorBus.dockFiles(false); } catch (_) {}
    });
  }
  {
    const df = $('#detached-focus');
    if (df) df.addEventListener('click', () => { if (activeId) lite.projTerm.focus(activeId); });
    const dd = $('#detached-dock');
    if (dd) dd.addEventListener('click', () => { if (activeId) dockProjectTerminals(activeId); });
  }
  if (lite.projTerm) {
    lite.projTerm.onDetachedSet(({ ids }) => {
      const next = new Set(Array.isArray(ids) ? ids.map(String) : []);
      let changed = next.size !== detachedProjIds.size;
      if (!changed) {
        for (const id of next) { if (!detachedProjIds.has(id)) { changed = true; break; } }
      }
      detachedProjIds.clear();
      for (const id of next) detachedProjIds.add(id);
      for (const id of [...detachedStatuses.keys()]) { if (!next.has(id)) detachedStatuses.delete(id); }
      for (const id of [...detachedSnapshots.keys()]) { if (!next.has(id)) detachedSnapshots.delete(id); }
      if (changed) {
        showActiveTerminal();
        renderProjects();
        updateAttention();
      }
    });
    lite.projTerm.onStatus((st) => {
      if (!st || !st.projId) return;
      const pid = String(st.projId);
      detachedStatuses.set(pid, st);
      if (detachedProjIds.has(pid)) {
        refreshProjIndicator(pid);
        updateAttention();
        syncAgentListAfterScan();
      }
    });
    if (lite.projTerm.onSnapshot) {
      lite.projTerm.onSnapshot(({ projId, snapshot }) => {
        if (!projId || !snapshot) return;
        const pid = String(projId);
        detachedSnapshots.set(pid, snapshot);
        if (detachedProjIds.has(pid)) saveProjTabs();
      });
    }
    lite.projTerm.onReattached(({ projId, snapshot, ackId }) => {
      try {
        const pid = String(projId || '');
        detachedProjIds.delete(pid);
        detachedStatuses.delete(pid);
        detachedSnapshots.delete(pid);
        const proj = projects.find((x) => x.id === pid);
        if (proj && snapshot) {
          termEngine.importProjectSnapshot(proj, snapshot);
          saveProjTabs();
          refreshAgents();
        }
        showActiveTerminal();
        renderProjects();
        updateAttention();
      } finally {
        if (ackId) lite.projTerm.sendReattachAck(ackId);
      }
    });
    lite.projTerm.listDetached().then((res) => {
      const { ids, statuses } = res || { ids: [], statuses: [] };
      if (Array.isArray(ids)) {
        detachedProjIds.clear();
        for (const id of ids) detachedProjIds.add(String(id));
      }
      if (Array.isArray(statuses)) {
        for (const st of statuses) {
          if (st && st.projId) detachedStatuses.set(String(st.projId), st);
        }
      }
      if (detachedProjIds.size) {
        showActiveTerminal();
        renderProjects();
        updateAttention();
      }
    }).catch(() => {});
  }
  // бейдж «N ждёт ответа»: клик — к следующему ждущему агенту (по кругу, если ждут несколько, включая вынесенные окна)
  $('#attention-badge').addEventListener('click', () => {
    const targets = [];
    for (const [sid, s] of projState.entries()) {
      if (s !== 'waiting' || !terms.has(sid)) continue;
      const rec = terms.get(sid);
      targets.push({ detached: false, projId: rec.projId, sid });
    }
    for (const pid of detachedProjIds) {
      const st = detachedStatuses.get(pid);
      const sids = st && Array.isArray(st.waitingSids) ? st.waitingSids : [];
      for (const sid of sids) targets.push({ detached: true, projId: pid, sid });
    }
    if (!targets.length) return;
    const curSid = activeSessionId();
    const cur = targets.findIndex((t) => !t.detached && t.sid === curSid);
    const next = targets[(cur + 1) % targets.length];
    if (next.detached) {
      lite.projTerm.focusSession(next.projId, next.sid);
    } else {
      setActive(next.projId);
      switchTab(next.sid);
    }
  });

  // OpenRouter (чат) живёт в окне модуля — bindControls/bindStream вызывает module-entry.js.

  // Esc-выход из полноэкранного превью и Ctrl+S сохранения файла живут в окне вивера (его keydown).
  // Глобальные хоткеи — через единый реестр HOTKEYS (тот же, что перехватывает фабрика терминалов).
  document.addEventListener('keydown', (e) => { runGlobalHotkey(e); });

  // drag a folder onto the window to open it as a project (рамка-подсказка, пока тащат файлы снаружи)
  let dropZone = null, dropT = null;
  const hideDrop = () => { clearTimeout(dropT); if (dropZone) { dropZone.remove(); dropZone = null; } };
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (favDragCard || termEngine.getTabDragEl() || !e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
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
    // Проект — это папка: брошенный файл превращался в «проект» с путём к файлу, терминал в нём не
    // стартует, а запись остаётся в списке. Папку от файла отличает webkitGetAsEntry (синхронно, только
    // внутри drop); нет entry — ведём себя как раньше.
    let entry = null;
    try { const it = [...(e.dataTransfer.items || [])].find((x) => x.kind === 'file'); entry = it && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; } catch (_) {}
    if (entry && !entry.isDirectory) { toast('Перетащите папку — файл нельзя открыть как проект', { kind: 'warn' }); return; }
    const p = f.path || lite.pathForFile(f);
    if (p) openByPath(p, baseName(p));
  });

  let rezTimer;
  new ResizeObserver(() => { clearTimeout(rezTimer); rezTimer = setTimeout(() => refitActiveTerminal(), 80); }).observe($('#terminal-pane'));
  // scratch/rh ресайз теперь в окнах модулей — обрабатывается module-entry.js.


  applyFontSize({ notify: false });
  projects = loadProjectsFromDisk();
  renderProjects();
  // Какие терминалы заняты агентом и какие можно закрыть: опрос раз в 3 с (≈1,5 мс в main на десяток
  // терминалов), пока окно на виду; список перерисовывается, только если ответ изменился.
  setInterval(() => { if (!document.hidden) refreshAgents(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleAgentScan(100); });
  // Окно перезагрузилось (падение, импорт настроек), а терминалы прежней страницы живы — забираем их:
  // агенты продолжают работать. Терминалы закрытых с тех пор проектов гасим.
  lite.pty.adoptable().catch(() => []).then((ids) => {
    for (const id of (Array.isArray(ids) ? ids : [])) {
      const pid = String(id).split('::')[0];
      if (detachedProjIds.has(pid)) continue;
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
      if (!p) continue;
      const t = tabsByProj.get(pid);
      if (!t) { ensureProjectTabs(p); continue; }
      // Гонка: проект активировали (клик по карточке, Ctrl+1…) раньше ответа adoptable — его вкладки уже
      // созданы свежими, и ensureProjectTabs живые терминалы не заберёт: main погасил бы их через
      // ORPHAN_TTL вместе с работающим агентом. Садим их дополнительными вкладками.
      const ids = adoptPtys.get(pid); adoptPtys.delete(pid);
      for (const id of ids) createSession(p, tt('Терминал {0}', t.sessions.length + 1), false, id);
      saveProjTabs();
    }
    // Проект уже выбран руками (та же гонка) — не перескакивать; showActiveTerminal спрячет лишние вкладки.
    if (first && !activeId) setActive(first);
    else showActiveTerminal();
  });

  // Набор открытых окон модулей (включая вивер) восстанавливает main (moduleWins.__open) при старте —
  // правому слоту редактора восстанавливать больше нечего (там остались только «Мои модули» по запросу).

  scanProjects();          // add subfolders of settings.scanDirs (non-blocking)
  checkProjectsExistence();
  window.addEventListener('focus', checkProjectsExistence); // re-check when returning to the app
  window.addEventListener('focus', () => refreshGitChip(300)); // ветка/изменения могли поменяться снаружи
  lite.fs.onChange(() => refreshGitChip(1200));              // файлы активного проекта меняются — пересчитать чип git

  syncHotkeyHints();
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
  const list = visibleOrderedProjects();
  if (list.length < 2) return;
  const i = list.findIndex((p) => p.id === activeId);
  const next = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[(i + dir + list.length) % list.length];
  if (next) setActive(next.id);
}

initI18n();   // словарь приходит синхронно из main → интерфейс сразу на выбранном языке
init();
