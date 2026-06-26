// LiteEditor — модуль «Контекст»: per-project, PER-AGENT граф контекста агента (канва в духе n8n).
// У каждого агента (Claude → CLAUDE.md, Codex → AGENTS.md) свой набор профилей (рецептов-канв,
// ОДИН выход), своя история «точек восстановления» (версий файла) и свой applied-профиль —
// агенты независимы. Блоки на канве: «Текст» (статичный markdown) и «Группа» (профиль-тумблер).
// Блок в выход напрямую = постоянный контекст; через группу = переключаемый. Источник истины —
// модуль: файл CLAUDE.md/AGENTS.md это лишь «рендер» применённого профиля. Распил берёт контент из
// ТОЧКИ (версии), а не из живого файла → оригинал можно пилить сколько угодно. Компиляция/бекапы/
// точки — в main (ctx:*). Изолирован по канону: всё из ядра — через host-колбэки, UI — из ui.js,
// бэкенд — window.lite.ctx. host: { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels }
import { el, icon, toast, makeModal, showConfirm, showPrompt } from '../ui.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { marked } from 'marked';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const NODE_W = 200;        // ширина ноды (синхронизирована с .ctx-node в styles.css)
const NODE_TYPES = {
  text:  { label: 'Текст',  icon: 'note',   hint: 'статичный markdown-блок' },
  group: { label: 'Группа', icon: 'layers', hint: 'профиль: включается/выключается целиком' },
};
const AGENTS = ['claude', 'codex'];
const AGENT_META = { claude: { label: 'Claude', file: 'CLAUDE.md' }, codex: { label: 'Codex', file: 'AGENTS.md' } };
const OUT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
const GROUP_COLORS = ['green', 'info', 'warn', 'danger'];

const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Markdown → безопасный HTML для превью блока (контент мог прийти из чужого CLAUDE.md). DOMPurify
// нет; парсим в инертный <template>, срезаем активные узлы/атрибуты, переносим очищенные ноды.
function renderSafeMarkdown(target, src) {
  let html;
  try { html = marked.parse(String(src || ''), { gfm: true, breaks: true }); }
  catch (_) { target.textContent = String(src || ''); return; }
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script,style,iframe,object,embed,form,link,meta,base').forEach((e) => e.remove());
  tpl.content.querySelectorAll('*').forEach((e) => {
    for (const a of [...e.attributes]) {
      const name = a.name.toLowerCase();
      const val = a.value.replace(/[\s-]/g, '').toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'style') e.removeAttribute(a.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^(javascript|data|vbscript):/.test(val)) e.removeAttribute(a.name);
    }
  });
  target.replaceChildren(...tpl.content.childNodes);
}
const fmtTok = (chars) => {
  const t = Math.round((chars || 0) / 4);
  return '≈' + (t >= 1000 ? (t / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : t) + ' тк';
};
function fmtTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}

export function initCtx(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels } = host;

  let open = false;
  let proj = null;       // снапшот {id, path, name} проекта на канве
  let agent = 'claude';  // текущий агент (Claude/Codex) — у каждого свои профили/точки/applied
  let graph = null;
  let sel = null;        // {kind:'node', id} | {kind:'edge', from, to}
  let multiSel = new Set(); // id текст-блоков для ручной группировки (Ctrl/Shift+клик)
  let loadSeq = 0;
  let unsaved = false;   // канва изменена, но не «Подтверждена». Автосохранения НЕТ
  let pendingDelete = []; // снимки удалённых текст-блоков — файлы сотрутся только при «Подтвердить»
  let profiles = null;   // {active, applied, list:[{id,name}]} текущего агента
  let activeProfile = null;
  let points = [];       // точки восстановления текущего агента [{id,name,ts,locked,chars}]
  let ctxMenuEl = null;  // открытое мини-меню действий профиля (по «⋯»)
  let externalChange = false; // файл агента изменён вне модуля (агент дописал/правил CLAUDE.md/AGENTS.md)
  let watchedProj = null;     // projId, за выходными файлами которого сейчас следим

  const canvas = $('#ctx-canvas');
  const world = $('#ctx-world');
  const wiresSvg = $('#ctx-wires');
  const nodesBox = $('#ctx-nodes');
  const agentsBar = $('#ctx-agents');
  const profilesBar = $('#ctx-profiles');
  const wireDel = $('#ctx-wire-del');
  const marquee = $('#ctx-marquee');
  let wireDelHideTimer = null;
  // онбординг-плашка снизу: показывается на пустой канве, закрывается один раз (persist в localStorage)
  const onboardDismissed = () => { try { return localStorage.getItem('lite.ctx.onboard') === '1'; } catch (_) { return false; } };
  function dismissOnboard() { try { localStorage.setItem('lite.ctx.onboard', '1'); } catch (_) {} const ob = $('#ctx-onboard'); if (ob) ob.hidden = true; }

  // Заголовок текст-блока = первый markdown-заголовок из контента (заголовки в ```-коде игнорируем).
  // Нет заголовка → первая непустая строка (укороченная) либо «Текст».
  function titleFromContent(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let fence = null;
    for (const ln of lines) {
      const f = ln.match(/^\s*(```+|~~~+)/);
      if (f) { const mk = f[1][0]; if (!fence) fence = mk; else if (fence === mk) fence = null; continue; }
      if (fence) continue;
      const h = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) return h[2].trim().slice(0, 60);
    }
    const first = (lines.find((l) => l.trim()) || '').trim().replace(/^[#>\-*\s]+/, '').slice(0, 40);
    return first || 'Текст';
  }

  // ---------------------------------------------------------------- граф: модель (ОДИН выход на агента)
  function newGraph(ag) {
    return {
      v: 1,
      nodes: [{ id: 'out-' + ag, type: 'out', out: ag, title: AGENT_META[ag].label, enabled: true, x: 600, y: 120 }],
      edges: [],
      view: { x: 0, y: 0, z: 1 },
      settings: { backupDir: '', backupKeep: 10, autoApply: true },
      dirty: false,
    };
  }
  // Стартовый граф профиля: выход + ОДИН текстовый блок (base — черновой скаффолд), привязанный к
  // выходу. content = полный файл агента (если есть) или пусто. Пока блок base — он «не распилен»:
  // показываем ✂ и онбординг; распил или правка снимают base. Дефолтной группы больше нет
  // (профили разделены по вкладкам агентов — группа перед единственным выходом не нужна).
  async function buildSeededGraph(content) {
    const g = newGraph(agent);
    const out = g.nodes.find((n) => n.type === 'out');
    const id = uid();
    await lite.ctx.blockWrite(proj.id, proj.path, { type: 'text', id }, content || '');
    g.nodes.push({ id, type: 'text', base: true, title: titleFromContent(content || ''), enabled: true, x: 140, y: 120, chars: (content || '').length, splittable: splitTree(content || '').length >= 2 });
    g.edges.push({ from: id, to: out.id });
    return g;
  }
  function normalizeGraph(g, ag) {
    if (!g || !Array.isArray(g.nodes)) return newGraph(ag);
    g.edges = Array.isArray(g.edges) ? g.edges : [];
    g.view = g.view && typeof g.view.z === 'number' ? g.view : { x: 0, y: 0, z: 1 };
    g.settings = { backupDir: '', backupKeep: 10, autoApply: true, ...(g.settings || {}) };
    // выход именно этого агента обязан существовать; чужие выходы (если затесались) — убрать
    if (!g.nodes.some((n) => n.type === 'out' && n.out === ag)) {
      g.nodes.push({ id: 'out-' + ag, type: 'out', out: ag, title: AGENT_META[ag].label, enabled: true, x: 600, y: 120 });
    }
    g.nodes = g.nodes.filter((n) => n.type !== 'out' || n.out === ag);
    for (const n of g.nodes) if (n.type === 'out') n.enabled = true; // выход всегда включён (выключать нельзя)
    return g;
  }
  const nodeById = (id) => graph && graph.nodes.find((n) => n.id === id);
  // mismatch — только когда какой-то профиль УЖЕ собран в файл, но активен другой (на свежем проекте
  // applied=null → не шумим «не применён» на пустом холсте)
  const appliedMismatch = () => !!(profiles && activeProfile && profiles.applied && profiles.applied !== activeProfile);
  function markDirty() { if (graph) { unsaved = true; updateStats(); } }

  // ---------------------------------------------------------------- открытие/закрытие панели
  function setOpen(o, opts = {}) {
    const p = activeProject();
    if (o && !p && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (o === open) { if (o && p) loadGraph(p); return; }
    if (o) closeOtherPanels('ctx');
    const delta = layout.ctx + GUTTER;
    open = o;
    if (!o) stopWatch();
    $('#ctx-pane').classList.toggle('hidden', !o);
    $('#gutter-ctx').classList.toggle('hidden', !o);
    if (opts.grow !== false) lite.win.growBy(o ? delta : -delta);
    saveUiState();
    if (o && p) loadGraph(p);
    setTimeout(refitActiveTerminal, 150);
  }
  const toggle = () => setOpen(!open);

  async function loadGraph(p) {
    if (proj && proj.id !== p.id && unsaved) toast('Контекст: неподтверждённые правки прошлого проекта отброшены', { ttl: 6000 });
    proj = { id: p.id, path: p.path, name: p.name };
    agent = 'claude';
    startWatch();
    const seq = ++loadSeq;
    await loadAgentData(seq);
  }
  // ---------------------------------------------------------------- слежение за выходным файлом агента
  function startWatch() {
    if (!proj) return;
    if (watchedProj && watchedProj !== proj.id) { lite.ctx.unwatchOutputs(watchedProj); watchedProj = null; }
    if (watchedProj !== proj.id) { lite.ctx.watchOutputs(proj.id, proj.path); watchedProj = proj.id; }
  }
  function stopWatch() {
    if (watchedProj) { lite.ctx.unwatchOutputs(watchedProj); watchedProj = null; }
    externalChange = false;
    renderExternBadge();
  }
  function renderExternBadge() { const b = $('#ctx-extern'); if (b) b.hidden = !externalChange; }
  // Проверить, отличается ли файл агента от сборки применённого профиля (внешняя правка агентом)
  async function checkExternal() {
    if (!proj || !open) { externalChange = false; renderExternBadge(); return; }
    const seq = loadSeq;
    const r = await lite.ctx.assembleText(proj.id, proj.path, agent, profiles && profiles.applied);
    if (seq !== loadSeq || !open) return;
    externalChange = !!(r && r.external);
    renderExternBadge();
  }
  // Загрузка данных текущего агента: профили + снимок #0 + активный граф + точки
  async function loadAgentData(seq) {
    if (!proj) return;
    profiles = await lite.ctx.profiles(proj.id, agent);
    if (seq !== loadSeq || !open) return;
    activeProfile = profiles && profiles.active;
    await lite.ctx.snapshotOriginal(proj.id, proj.path, agent); // снимок #0 «Оригинал» — один раз
    const pr = await lite.ctx.points(proj.id, agent);
    if (seq !== loadSeq || !open) return;
    points = (pr && pr.list) || [];
    const r = await lite.ctx.load(proj.id, agent, activeProfile);
    if (seq !== loadSeq || !open) return;
    if (r && r.graph) graph = normalizeGraph(r.graph, agent);
    else { // первый заход: стартовый блок с ПОЛНЫМ файлом (из «Оригинала») или пустой
      const orig = points.find((p) => p.locked);
      let content = '';
      if (orig) { const o = await lite.ctx.pointRead(proj.id, agent, orig.id); if (seq !== loadSeq || !open) return; content = (o && o.text) || ''; }
      graph = normalizeGraph(await buildSeededGraph(content), agent);
      await lite.ctx.save(proj.id, agent, graph, activeProfile); // зафиксировать (стабильный id блока)
    }
    sel = null; multiSel.clear(); unsaved = false; pendingDelete = [];
    renderAgents(); renderProfiles(); renderAll();
    maybeFitInitial(); setTimeout(maybeFitInitial, 130); // центрируем (повтор — после того как раскладка устаканится)
    refreshLiveChars(seq);
    checkExternal();
  }
  // Перезагрузка графа активного профиля (после переключения/создания) + точки
  async function loadActiveGraph() {
    if (!proj) return;
    const seq = ++loadSeq;
    const r = await lite.ctx.load(proj.id, agent, activeProfile);
    if (seq !== loadSeq || !open) return;
    if (r && r.graph) graph = normalizeGraph(r.graph, agent);
    else { graph = normalizeGraph(await buildSeededGraph(''), agent); await lite.ctx.save(proj.id, agent, graph, activeProfile); } // новый профиль — пустой блок
    sel = null; multiSel.clear(); unsaved = false; pendingDelete = [];
    const pr = await lite.ctx.points(proj.id, agent);
    points = (pr && pr.list) || [];
    renderProfiles(); renderAll();
    maybeFitInitial(); setTimeout(maybeFitInitial, 130);
    refreshLiveChars(seq);
    checkExternal();
  }
  async function refreshPoints() {
    if (!proj) return;
    const seq = loadSeq;
    const r = await lite.ctx.points(proj.id, agent);
    if (seq !== loadSeq) return;
    points = (r && r.list) || [];
  }
  // Размеры текст-блоков честны на момент сохранения — освежаем при загрузке (внешние правки файла блока)
  async function refreshLiveChars(seq) {
    if (!graph || !proj) return;
    let changed = false;
    for (const n of graph.nodes) {
      if (n.type !== 'text') continue;
      const r = await lite.ctx.blockRead(proj.id, proj.path, n);
      if (seq !== loadSeq) return;
      if (r) {
        const sp = splitTree(r.text || '').length >= 2;
        const tt = titleFromContent(r.text || '');
        if (r.chars !== n.chars || sp !== n.splittable || tt !== n.title) { n.chars = r.chars; n.splittable = sp; n.title = tt; changed = true; }
      }
    }
    if (changed) renderAll();
  }
  function onProjectChange(p) { if (open && p) loadGraph(p); }

  // ---------------------------------------------------------------- переключатель агента
  function renderAgents() {
    if (!agentsBar) return;
    agentsBar.innerHTML = '';
    if (!proj) return;
    for (const ag of AGENTS) {
      const b = el('button', 'ctx-agent' + (ag === agent ? ' on' : ''), AGENT_META[ag].label);
      b.title = AGENT_META[ag].file + ' — у этого агента свои профили и версии';
      b.addEventListener('click', () => switchAgent(ag));
      agentsBar.appendChild(b);
    }
  }
  function switchAgent(ag) {
    if (!proj || ag === agent || !AGENTS.includes(ag)) return;
    const go = () => { agent = ag; const seq = ++loadSeq; loadAgentData(seq); };
    if (unsaved) showConfirm('Сменить агента?', 'В текущем профиле есть неподтверждённые изменения — они будут отброшены.', 'Сменить', go);
    else go();
  }

  // ---------------------------------------------------------------- профили (вкладки над канвой)
  function renderProfiles() {
    if (!profilesBar) return;
    closeProfileMenu();
    profilesBar.innerHTML = '';
    if (!proj || !profiles) return;
    for (const pr of profiles.list) {
      const isApplied = pr.id === profiles.applied; // собран в файл = активный профиль
      const tab = el('div', 'ctx-ptab' + (pr.id === activeProfile ? ' on' : '') + (isApplied ? ' applied' : ''));
      tab.title = pr.name + (isApplied ? ' · активный (собран в ' + OUT_FILES[agent] + ')' : '');
      tab.addEventListener('click', () => switchProfile(pr.id));
      // одна строка: имя · галочка-индикатор активного (применённого) профиля · «⋯» (меню действий)
      tab.appendChild(el('span', 'ctx-ptab-name', pr.name));
      if (isApplied) { const c = el('span', 'ctx-ptab-check'); c.appendChild(icon('check', 13)); c.title = 'Активный профиль — собран в ' + OUT_FILES[agent]; tab.appendChild(c); }
      const menuBtn = el('button', 'ctx-ptab-menu');
      menuBtn.appendChild(icon('dots-v', 15)); menuBtn.title = 'Действия профиля';
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openProfileMenu(menuBtn, pr); });
      tab.appendChild(menuBtn);
      profilesBar.appendChild(tab);
    }
    const add = el('button', 'ctx-padd', '+');
    add.title = 'Новый профиль';
    add.addEventListener('click', createProfile);
    profilesBar.appendChild(add);
  }
  // Мини-меню действий профиля (слова, не иконки) — по «⋯». Крепится к body (не обрезается баром).
  function closeProfileMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
    document.removeEventListener('mousedown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuEsc, true);
  }
  function onMenuOutside(e) { if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeProfileMenu(); }
  function onMenuEsc(e) { if (e.key === 'Escape') closeProfileMenu(); }
  function openProfileMenu(anchor, pr) {
    closeProfileMenu();
    const menu = el('div', 'ctx-menu');
    const item = (label, cls, fn) => {
      const it = el('button', 'ctx-menu-it' + (cls ? ' ' + cls : ''), label);
      it.addEventListener('click', (e) => { e.stopPropagation(); closeProfileMenu(); fn(); });
      menu.appendChild(it);
    };
    item('Переименовать', '', () => renameProfile(pr));
    item('Дублировать', '', () => duplicateProfile(pr));
    item('Сохранить полный файл…', '', () => exportProfile(pr));
    // «Удалить» — только если профилей >1 и это НЕ применённый (✓) профиль (его удалять нельзя)
    if (profiles && profiles.list.length > 1 && pr.id !== profiles.applied) item('Удалить', 'danger', () => deleteProfile(pr));
    document.body.appendChild(menu);
    ctxMenuEl = menu;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
    setTimeout(() => { document.addEventListener('mousedown', onMenuOutside, true); document.addEventListener('keydown', onMenuEsc, true); }, 0);
  }
  async function switchProfile(id) {
    if (!proj || id === activeProfile) return;
    const go = async () => {
      const r = await lite.ctx.profileSetActive(proj.id, agent, id);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      profiles = r.profiles; activeProfile = id;
      await loadActiveGraph();
    };
    if (unsaved) showConfirm('Переключить профиль?', 'В текущем профиле есть неподтверждённые изменения — они будут отброшены.', 'Переключить', go);
    else go();
  }
  // Создание профиля: Пустой / Копия активного / Распилить версию
  function createProfile() {
    if (!proj) return;
    const { m, close } = makeModal('<h2>Новый профиль</h2><div id="cxnp" class="ctx-addlist"></div>');
    const box = m.querySelector('#cxnp');
    const row = (label, hint, fn) => {
      const r = el('div', 'ctx-addrow');
      const tx = el('div', 'ctx-addtx');
      tx.appendChild(el('div', 'ctx-addlabel', label));
      tx.appendChild(el('div', 'ctx-addhint', hint));
      r.appendChild(tx);
      r.onclick = fn;
      box.appendChild(r);
    };
    const createEmpty = (name, cb) => showPrompt('Новый профиль', 'Название', name || '', async (nm) => {
      const r = await lite.ctx.profileCreate(proj.id, agent, nm);
      if (r && r.error) return { error: r.error };
      profiles = r.profiles; activeProfile = r.id;
      await loadActiveGraph();
      if (cb) cb(); else toast('Профиль создан');
    });
    row('Пустой', 'чистый профиль с пустым текстовым блоком', () => { close(); createEmpty(''); });
    row('Копия активного', 'дубликат текущего профиля со всеми блоками', () => {
      close();
      const cur = profiles && profiles.list.find((p) => p.id === activeProfile);
      showPrompt('Копия профиля', 'Название', (cur ? cur.name + ' копия' : ''), async (nm) => {
        const r = await lite.ctx.profileCreate(proj.id, agent, nm, activeProfile);
        if (r && r.error) return { error: r.error };
        profiles = r.profiles; activeProfile = r.id;
        await loadActiveGraph();
        toast('Профиль скопирован');
      });
    });
    row('Распилить версию…', 'новый профиль из точки восстановления (разбить по заголовкам)', () => {
      close();
      pickPointThen((ptId) => createEmpty('', () => runSplit(ptId)));
    });
  }
  function renameProfile(pr) {
    if (!proj) return;
    showPrompt('Переименовать профиль', 'Название', pr.name, async (name) => {
      const r = await lite.ctx.profileRename(proj.id, agent, pr.id, name);
      if (r && r.error) return { error: r.error };
      profiles = r.profiles; renderProfiles();
    });
  }
  // Дублировать профиль (клон со всеми блоками) → стать активной вкладкой и можно сразу менять
  function duplicateProfile(pr) {
    if (!proj) return;
    showPrompt('Дублировать профиль', 'Название копии', pr.name + ' копия', async (nm) => {
      const r = await lite.ctx.profileCreate(proj.id, agent, nm, pr.id);
      if (r && r.error) return { error: r.error };
      profiles = r.profiles; activeProfile = r.id;
      await loadActiveGraph();
      toast('Профиль скопирован — это теперь активная вкладка');
    });
  }
  // Сохранить собранный файл профиля на ПК (save-диалог). Для активного профиля сперва синхронизируем
  // граф на диске с канвой, чтобы экспорт отражал текущее состояние (а не последнее «Подтвердить»).
  async function exportProfile(pr) {
    if (!proj) return;
    if (pr.id === activeProfile && graph) await lite.ctx.save(proj.id, agent, graph, activeProfile);
    const r = await lite.ctx.exportFile(proj.id, proj.path, agent, pr.id);
    if (!r || r.canceled) return;
    if (r.error) { toast(r.error, { kind: 'err', ttl: 7000 }); return; }
    toast(`Сохранено: ${r.file} · ${fmtTok(r.chars)}`, { ttl: 8000 });
  }
  // Информационная модалка (одна кнопка «Понятно») — для запретов вроде «активный профиль удалять нельзя»
  function infoModal(title, body) {
    const { m, close } = makeModal('<h2 class="cm-title"></h2><div class="about-desc cm-text"></div><div class="modal-actions"><button class="btn primary" id="cmi-ok">Понятно</button></div>');
    m.querySelector('.cm-title').textContent = title;
    m.querySelector('.cm-text').textContent = body;
    m.querySelector('#cmi-ok').onclick = close;
  }
  function deleteProfile(pr) {
    if (!proj || !profiles) return;
    if (profiles.list.length <= 1) { infoModal('Нельзя удалить', 'Это единственный профиль агента — удалять можно только когда профилей несколько.'); return; }
    if (pr.id === profiles.applied) { // применённый (✓) профиль защищён — он собран в файл агента
      infoModal('Это активный профиль', `«${pr.name}» собран в ${OUT_FILES[agent]} (активный профиль ✓). Примените другой профиль, тогда этот можно будет удалить.`);
      return;
    }
    showConfirm('Удалить профиль?', `«${pr.name}» и его канва будут удалены. Файл ${OUT_FILES[agent]} и версии не трогаются.`, 'Удалить', async () => {
      const r = await lite.ctx.profileDelete(proj.id, agent, pr.id);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      profiles = r.profiles;
      if (activeProfile === pr.id) { activeProfile = profiles.active; await loadActiveGraph(); }
      else renderProfiles();
      toast('Профиль удалён');
    });
  }

  // ---------------------------------------------------------------- точки восстановления (версии файла)
  function showPoints() {
    if (!proj) { toast('Сначала открой проект'); return; }
    const { m, close } = makeModal(`<h2>🕘 Версии · ${OUT_FILES[agent]}</h2>
      <div class="about-desc">Точки восстановления файла контекста. «Восстановить» — вернуть версию на канву одним блоком; «Распилить» — разложить её на блоки по заголовкам. «Оригинал» (🔒) не удаляется. Источник истины — модуль; файл это лишь рендер применённого профиля.</div>
      <div id="cxv-list" class="ctx-vlist"></div>`);
    m.classList.add('ctx-modal', 'ctx-modal-wide');
    const list = m.querySelector('#cxv-list');
    const render = () => {
      list.innerHTML = '';
      if (!points.length) { list.appendChild(el('div', 'ctx-addhint', 'Версий пока нет. «Оригинал» появляется при первом открытии проекта с CLAUDE.md/AGENTS.md, остальные — при «Подтвердить».')); return; }
      for (const pt of points.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
        const card = el('div', 'ctx-vrow');
        const head = el('div', 'ctx-vhead');
        head.appendChild(el('div', 'ctx-vname', (pt.locked ? '🔒 ' : '') + pt.name));
        head.appendChild(el('div', 'ctx-vmeta', fmtTs(pt.ts) + ' · ' + fmtTok(pt.chars || 0)));
        card.appendChild(head);
        const acts = el('div', 'ctx-vacts');
        const restore = el('button', 'btn ctx-vbtn');
        restore.appendChild(icon('refresh', 13));
        restore.appendChild(el('span', null, 'Восстановить'));
        restore.title = 'Вернуть эту версию на канву одним текстовым блоком (как в начале)';
        restore.onclick = () => {
          close();
          showConfirm('Восстановить версию?', `Канва заменится одним текстовым блоком с содержимым «${pt.name}». Текущие неподтверждённые блоки будут отброшены. Файл ${OUT_FILES[agent]} перезапишется только после «Подтвердить».`, 'Восстановить', () => restorePoint(pt.id, pt.name));
        };
        acts.appendChild(restore);
        const split = el('button', 'btn primary ctx-vbtn');
        split.appendChild(icon('scissors', 13));
        split.appendChild(el('span', null, 'Распилить'));
        split.onclick = () => { close(); runSplit(pt.id); };
        acts.appendChild(split);
        if (!pt.locked) {
          const mkorig = el('button', 'btn ctx-vbtn ctx-vorig');
          mkorig.appendChild(icon('flag', 13));
          mkorig.title = 'Сделать оригиналом (заменить базовую версию 🔒)';
          mkorig.onclick = () => {
            showConfirm('Сделать оригиналом?', `«${pt.name}» станет новым «Оригиналом» (🔒, не удаляется). Прежний оригинал станет обычной версией — его можно будет удалить.`, 'Сделать оригиналом', async () => {
              const rr = await lite.ctx.pointSetOriginal(proj.id, agent, pt.id);
              if (rr && rr.error) { toast(rr.error, { kind: 'err' }); return; }
              points = rr.list || [];
              render();
              toast('Оригинал обновлён');
            });
          };
          acts.appendChild(mkorig);
          const del = el('button', 'btn danger-btn ctx-vbtn');
          del.appendChild(icon('trash', 13));
          del.title = 'Удалить версию';
          del.onclick = async () => {
            const dr = await lite.ctx.pointDelete(proj.id, agent, pt.id);
            if (dr && dr.error) { toast(dr.error, { kind: 'err' }); return; }
            points = dr.list || [];
            render();
          };
          acts.appendChild(del);
        }
        card.appendChild(acts);
        list.appendChild(card);
      }
    };
    render();
  }
  // Выбор версии-источника → cb(pointId)
  function pickPointThen(cb) {
    if (!points.length) { toast('Нет версий для распила (нужен «Оригинал» или сборка)', { kind: 'err' }); return; }
    if (points.length === 1) { cb(points[0].id); return; }
    const { m, close } = makeModal('<h2>✂ Распилить версию</h2><div id="cxpp" class="ctx-addlist"></div>');
    m.classList.add('ctx-modal');
    const box = m.querySelector('#cxpp');
    for (const pt of points.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
      const r = el('div', 'ctx-addrow');
      const tx = el('div', 'ctx-addtx');
      tx.appendChild(el('div', 'ctx-addlabel', (pt.locked ? '🔒 ' : '') + pt.name));
      tx.appendChild(el('div', 'ctx-addhint', fmtTs(pt.ts) + ' · ' + fmtTok(pt.chars || 0)));
      r.appendChild(tx);
      r.onclick = () => { close(); cb(pt.id); };
      box.appendChild(r);
    }
  }
  // Восстановить версию на канву: заменить весь граф ОДНИМ текст-блоком (как стартовый монолит),
  // привязанным к выходу. Файл не трогаем — запись только по «Подтвердить» (модель без автосейва).
  async function restorePoint(ptId, ptName) {
    if (!proj || !graph) return;
    const pr = await lite.ctx.pointRead(proj.id, agent, ptId);
    if (!pr || !pr.exists) { toast('Версия пуста — нечего восстанавливать', { kind: 'err' }); return; }
    const out = graph.nodes.find((n) => n.type === 'out' && n.out === agent) || { id: 'out-' + agent };
    for (const n of graph.nodes.filter((x) => x.type === 'text')) pendingDelete.push({ ...n }); // файлы сотрутся при «Подтвердить»
    graph.nodes = graph.nodes.filter((n) => n.type === 'out'); // группы убираем, выход оставляем
    graph.edges = [];
    const id = uid();
    await lite.ctx.blockWrite(proj.id, proj.path, { type: 'text', id }, pr.text);
    graph.nodes.push({ id, type: 'text', base: true, title: titleFromContent(pr.text || ''), enabled: true, x: 140, y: 120, chars: (pr.text || '').length, splittable: splitTree(pr.text || '').length >= 2 });
    graph.edges.push({ from: id, to: out.id });
    sel = null;
    markDirty();
    renderAll();
    fitView();
    toast(`Версия «${ptName}» восстановлена на канву — нажми ✓ Подтвердить, чтобы записать в ${OUT_FILES[agent]}`, { ttl: 9000 });
  }

  // ---------------------------------------------------------------- геометрия/обходы (плоско, слева-направо)
  // Высоту ноды берём из DOM (точные концы проводов по вертикальному центру).
  function nodeHeight(id) { const e = nodesBox.querySelector(`.ctx-node[data-id="${CSS.escape(id)}"]`); return e ? e.offsetHeight : NODE_H; }
  // Горизонтальная ориентация: выход справа, вход слева; порт по вертикальному центру ноды.
  function portPos(n, kind) { const cy = n.y + nodeHeight(n.id) / 2; return { x: kind === 'out' ? n.x + NODE_W : n.x, y: cy }; }
  function wireD(a, b) {
    const dx = Math.max(40, Math.min(140, Math.abs(b.x - a.x) / 2));
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  // Множество «включённых» нод: достижимые от включённого выхода через включённые источники (любой тип)
  function effectiveSet() {
    const set = new Set();
    if (!graph) return set;
    for (const o of graph.nodes.filter((n) => n.type === 'out' && n.enabled)) {
      const stack = [o.id];
      while (stack.length) {
        const cur = stack.pop();
        if (set.has(cur)) continue;
        set.add(cur);
        for (const e of graph.edges) {
          if (e.to !== cur) continue;
          const src = nodeById(e.from);
          if (src && src.enabled) stack.push(src.id);
        }
      }
    }
    return set;
  }
  // Текст-контрибьюторы выхода (множество): рекурсия через группы И через текст-родителей
  function contributors(outId) {
    const seen = new Set(); const found = [];
    (function visit(id) {
      for (const e of graph.edges) {
        if (e.to !== id) continue;
        const src = nodeById(e.from);
        if (!src || !src.enabled || seen.has(src.id)) continue;
        seen.add(src.id);
        if (src.type === 'group') visit(src.id);     // группа прозрачна
        else { found.push(src); visit(src.id); }       // текст: сам + его дети
      }
    })(outId);
    return found;
  }
  function canConnect(fromId, toId) {
    const a = nodeById(fromId), b = nodeById(toId);
    if (!a || !b || a.id === b.id) return false;
    if (a.type === 'out' || !(b.type === 'group' || b.type === 'out')) return false; // приёмник — только группа/выход (плоско)
    if (graph.edges.some((e) => e.from === fromId && e.to === toId)) return false;
    const stack = [toId]; const seen = new Set(); // защита от цикла: от b нельзя дойти до a
    while (stack.length) {
      const cur = stack.pop();
      if (cur === fromId) return false;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of graph.edges) if (e.from === cur) stack.push(e.to);
    }
    return true;
  }
  function screenCenterWorld() {
    const r = canvas.getBoundingClientRect();
    const v = graph.view;
    return { x: (r.width / 2 - v.x) / v.z, y: (r.height / 2 - v.y) / v.z };
  }
  // Уместить все ноды в видимую область канвы (центрируя). NODE_H — оценка высоты ноды.
  const NODE_H = 80;
  function fitView() {
    if (!graph || !canvas) return;
    const ns = graph.nodes;
    if (!ns.length) return;
    const r = canvas.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + NODE_H); }
    const pad = 48;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    let z = Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh, 1.4);
    z = Math.max(0.35, Math.min(2, z));
    graph.view.z = z;
    graph.view.x = (r.width - bw * z) / 2 - minX * z;
    graph.view.y = (r.height - bh * z) / 2 - minY * z;
    world.style.transform = `translate(${graph.view.x}px, ${graph.view.y}px) scale(${z})`;
  }
  // На старте (вид не трогали — дефолт {0,0,1}) центрируем блоки в экране
  function maybeFitInitial() {
    const v = graph && graph.view;
    if (v && v.x === 0 && v.y === 0 && v.z === 1) fitView();
  }

  // ---------------------------------------------------------------- рендер
  function renderAll() {
    if (!open) return;
    $('#ctx-title').textContent = proj ? `Контекст · ${proj.name}` : 'Контекст';
    if (!proj || !graph) { nodesBox.innerHTML = ''; wiresSvg.innerHTML = ''; if (profilesBar) profilesBar.innerHTML = ''; if (agentsBar) agentsBar.innerHTML = ''; updateStats(); return; }
    world.style.transform = `translate(${graph.view.x}px, ${graph.view.y}px) scale(${graph.view.z})`;
    renderNodes();
    renderWires();
    updateStats();
    const scaffold = graph.nodes.some((n) => n.base); // черновой стартовый блок = «не распилено»
    const ob = $('#ctx-onboard'); if (ob) ob.hidden = !scaffold || onboardDismissed(); // подсказка про ✂ на блоке
  }
  function renderNodes() {
    nodesBox.innerHTML = '';
    const eff = effectiveSet();
    for (const n of graph.nodes) nodesBox.appendChild(buildNode(n, eff));
  }
  function buildNode(n, eff) {
    const isOut = n.type === 'out';
    const box = el('div', 'ctx-node t-' + n.type + (n.type === 'group' && n.color ? ' g-' + n.color : ''));
    box.dataset.id = n.id;
    box.style.left = n.x + 'px';
    box.style.top = n.y + 'px';
    if (!n.enabled || !eff.has(n.id)) box.classList.add('off');
    if (sel && sel.kind === 'node' && sel.id === n.id) box.classList.add('sel');
    if (multiSel.has(n.id)) box.classList.add('multisel');

    if (n.type === 'group' || isOut) { const p = el('div', 'ctx-port in'); p.dataset.id = n.id; p.title = 'Вход'; box.appendChild(p); }
    if (!isOut) { const p = el('div', 'ctx-port out'); p.dataset.id = n.id; p.title = 'Потяни вправо, чтобы соединить с группой/выходом'; box.appendChild(p); }

    const head = el('div', 'ctx-nhead');
    const ic = el('span', 'ctx-nicon');
    ic.appendChild(icon(isOut ? 'power' : NODE_TYPES[n.type].icon, 14));
    head.appendChild(ic);
    head.appendChild(el('span', 'ctx-ntitle', n.title || NODE_TYPES[n.type]?.label || ''));
    if (n.type === 'text' && n.splittable) { // синий ✂ = индикатор «в блоке ≥2 заголовка» + кнопка распила
      const sb = el('button', 'ctx-nsplit');
      sb.appendChild(icon('scissors', 13));
      sb.title = 'В блоке несколько заголовков — распилить на отдельные блоки';
      sb.addEventListener('click', (e) => { e.stopPropagation(); splitBlock(n); });
      head.appendChild(sb);
    }
    if (!isOut) { // выходной блок выключать нельзя — это сам файл агента; тумблер только у блоков/групп
      const sw = el('button', 'ctx-switch' + (n.enabled ? ' on' : ''));
      sw.title = n.enabled ? 'Выключить' : 'Включить';
      sw.appendChild(el('span', 'ctx-knob'));
      sw.addEventListener('click', (e) => { e.stopPropagation(); n.enabled = !n.enabled; markDirty(); renderAll(); });
      head.appendChild(sw);
    }
    box.appendChild(head);

    const body = el('div', 'ctx-nbody');
    if (isOut) {
      body.appendChild(el('div', 'ctx-nfile', OUT_FILES[n.out]));
      const c = contributors(n.id);
      const total = c.reduce((s, x) => s + (x.chars || 0), 0);
      body.appendChild(el('div', 'ctx-nmeta', c.length ? `${c.length} блок(а) · ${fmtTok(total)}` : 'ничего не подключено'));
    } else if (n.type === 'group') {
      const inn = graph.edges.filter((e) => e.to === n.id).length;
      const kind = n.head ? 'группа-текст · ' : 'обёртка · ';
      body.appendChild(el('div', 'ctx-nmeta', kind + (inn ? `${inn} вход(а)` : 'пусто')));
    } else {
      body.appendChild(el('div', 'ctx-nmeta', fmtTok(n.chars || 0)));
    }
    box.appendChild(body);
    // Двойной клик ловим вручную в pointerup (см. ниже) — первый клик пересоздаёт DOM.
    return box;
  }
  function renderWires() {
    wiresSvg.innerHTML = '';
    if (!graph) return;
    const eff = effectiveSet();
    for (const e of graph.edges) {
      const a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b) continue;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', wireD(portPos(a, 'out'), portPos(b, 'in')));
      let cls = 'ctx-wire';
      if (!(eff.has(a.id) && eff.has(b.id))) cls += ' off';
      if (sel && sel.kind === 'edge' && sel.from === e.from && sel.to === e.to) cls += ' sel';
      p.setAttribute('class', cls);
      p.dataset.from = e.from; p.dataset.to = e.to;
      p.addEventListener('mouseenter', () => showWireDel(p, e.from, e.to)); // n8n-стиль: «×» при наведении
      p.addEventListener('mouseleave', scheduleHideWireDel);
      wiresSvg.appendChild(p);
    }
  }
  // Кнопка удаления провода: середина линии (мировые координаты пути → экранные через view).
  function worldToScreen(wx, wy) { const v = graph.view; return { x: v.x + wx * v.z, y: v.y + wy * v.z }; }
  function showWireDel(pathEl, from, to) {
    if (!graph || drag) return;
    clearTimeout(wireDelHideTimer);
    let mid;
    try { mid = pathEl.getPointAtLength(pathEl.getTotalLength() / 2); } catch (_) { return; }
    const s = worldToScreen(mid.x, mid.y);
    wireDel.style.left = s.x + 'px';
    wireDel.style.top = s.y + 'px';
    wireDel.dataset.from = from; wireDel.dataset.to = to;
    wireDel.hidden = false;
  }
  function scheduleHideWireDel() { clearTimeout(wireDelHideTimer); wireDelHideTimer = setTimeout(() => { wireDel.hidden = true; }, 220); }
  function hideWireDelNow() { clearTimeout(wireDelHideTimer); wireDel.hidden = true; }

  function updateStats() {
    const bar = $('#ctx-stats');
    if (!bar) return;
    bar.innerHTML = '';
    const mismatch = appliedMismatch();
    const showActions = unsaved || mismatch; // есть что подтверждать
    $('#ctx-stale').hidden = !showActions;
    { const row = $('#ctx-tb-actions'); if (row) row.hidden = !showActions; } // вторая строка тулбара
    { const rb = $('#ctx-reset'); if (rb) rb.hidden = !unsaved; }              // сбросить — только при правках
    { const ab = $('#ctx-apply'); if (ab) ab.hidden = !showActions; }          // подтвердить — появляется/исчезает
    { const gb = $('#ctx-group'); if (gb) gb.hidden = multiSel.size < 2; }     // сгруппировать — при ≥2 выделенных
    if (!graph || !proj) return;
    const o = graph.nodes.find((n) => n.type === 'out' && n.out === agent);
    const total = o && o.enabled ? contributors(o.id).reduce((s, x) => s + (x.chars || 0), 0) : 0;
    const chip = el('span', 'ctx-chip' + (o && o.enabled ? '' : ' off'));
    chip.appendChild(el('b', null, AGENT_META[agent].label));
    chip.appendChild(el('span', null, o && o.enabled ? fmtTok(total) : 'выкл'));
    chip.title = OUT_FILES[agent];
    bar.appendChild(chip);
    if (unsaved) bar.appendChild(el('span', 'ctx-chip warn', 'есть неподтверждённые изменения — нажми «Подтвердить»'));
    else if (mismatch) bar.appendChild(el('span', 'ctx-chip warn', 'этот профиль не применён к файлу — нажми «Подтвердить»'));
  }

  // ---------------------------------------------------------------- мутации
  function addNode(type, extra = {}) {
    const c = screenCenterWorld();
    const n = {
      id: uid(), type, title: extra.title || NODE_TYPES[type].label, enabled: true,
      x: Math.round(c.x - NODE_W / 2 + (Math.random() * 40 - 20)), y: Math.round(c.y - 40 + (Math.random() * 40 - 20)),
      chars: 0, ...extra,
    };
    graph.nodes.push(n);
    sel = { kind: 'node', id: n.id };
    markDirty();
    renderAll();
    return n;
  }
  function addEdge(from, to) {
    if (!canConnect(from, to)) return false;
    graph.edges.push({ from, to });
    markDirty();
    renderAll();
    return true;
  }
  function removeEdge(from, to) {
    graph.edges = graph.edges.filter((e) => !(e.from === from && e.to === to));
    if (sel && sel.kind === 'edge' && sel.from === from && sel.to === to) sel = null;
    markDirty();
    renderAll();
  }
  function removeNode(n) {
    graph.nodes = graph.nodes.filter((x) => x.id !== n.id);
    graph.edges = graph.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    if (sel && sel.kind === 'node' && sel.id === n.id) sel = null;
    multiSel.delete(n.id);
    // файл текст-блока НЕ удаляем сейчас — удаление обратимо до «Подтвердить»
    if (n.type === 'text') pendingDelete.push({ ...n });
    markDirty();
    renderAll();
  }
  function deleteSelection() {
    if (!sel || !graph) return;
    if (sel.kind === 'edge') { removeEdge(sel.from, sel.to); return; }
    const n = nodeById(sel.id);
    if (!n) return;
    if (n.type === 'out') { toast('Ноду-выход удалить нельзя — её можно выключить'); return; }
    showConfirm('Удалить блок?', `«${n.title}» убрать с канвы. Файл не удаляется, пока не нажмёшь «Подтвердить» — до этого удаление можно откатить кнопкой «Сбросить».`, 'Удалить', () => removeNode(n));
  }
  async function duplicateSelection() {
    if (!sel || sel.kind !== 'node') return;
    const n = nodeById(sel.id);
    if (!n || n.type === 'out') return;
    const copy = { ...n, base: false, id: uid(), x: n.x + 24, y: n.y + 24, title: n.title + ' (копия)' };
    if (n.type === 'text') {
      const r = await lite.ctx.blockRead(proj.id, proj.path, n);
      await lite.ctx.blockWrite(proj.id, proj.path, copy, (r && r.text) || '');
    }
    graph.nodes.push(copy);
    sel = { kind: 'node', id: copy.id };
    markDirty();
    renderAll();
  }
  // Ручная группировка: выделенные (Ctrl+клик) текст-блоки → в новую группу; провода, шедшие в их
  // приёмники (обычно выход), перецепляются в группу, а группа подключается к тем же приёмникам.
  function groupSelection() {
    if (!graph || multiSel.size < 2) return;
    const ids = [...multiSel].filter((id) => { const n = nodeById(id); return n && n.type === 'text'; });
    if (ids.length < 2) { toast('Выдели хотя бы 2 текст-блока (Ctrl+клик по блокам)'); return; }
    const members = ids.map(nodeById);
    const targets = new Set();
    for (const id of ids) for (const e of graph.edges) if (e.from === id) targets.add(e.to);
    if (!targets.size) { const out = graph.nodes.find((x) => x.type === 'out' && x.out === agent); if (out) targets.add(out.id); }
    const avgX = Math.round(members.reduce((s, n) => s + n.x, 0) / members.length);
    const avgY = Math.round(members.reduce((s, n) => s + n.y, 0) / members.length);
    const gid = uid();
    graph.nodes.push({ id: gid, type: 'group', title: 'Группа', enabled: true, x: avgX + 240, y: avgY, color: 'green', chars: 0 });
    graph.edges = graph.edges.filter((e) => !(ids.includes(e.from) && targets.has(e.to))); // снять прямые провода блок→приёмник
    for (const id of ids) graph.edges.push({ from: id, to: gid });
    for (const t of targets) graph.edges.push({ from: gid, to: t });
    multiSel.clear();
    sel = { kind: 'node', id: gid };
    markDirty();
    renderAll();
    toast(`Сгруппировано блоков: ${ids.length}. Переименуй группу двойным кликом.`, { ttl: 7000 });
  }

  // ---------------------------------------------------------------- интеракции канвы
  let drag = null;
  let tempWire = null;
  let clickTrack = { id: null, t: 0 };
  let clickTrackEdge = { key: null, t: 0 };
  function worldPoint(e) {
    const r = canvas.getBoundingClientRect();
    const v = graph.view;
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !graph) return;
    if (e.target.closest('.ctx-switch') || e.target.closest('button')) return;
    hideWireDelNow();
    const portEl = e.target.closest('.ctx-port');
    const nodeEl = e.target.closest('.ctx-node');
    if (portEl && portEl.classList.contains('out')) {
      drag = { kind: 'wire', from: portEl.dataset.id };
      tempWire = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tempWire.setAttribute('class', 'ctx-wire temp');
      wiresSvg.appendChild(tempWire);
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (nodeEl) {
      const n = nodeById(nodeEl.dataset.id);
      if (!n) return;
      drag = { kind: 'node', id: n.id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y, el: nodeEl, moved: false };
      // тянем выделенный блок → едет вся мультивыборка (Ctrl+клик)
      if (multiSel.has(n.id) && multiSel.size > 1) {
        drag.group = [...multiSel].map((id) => { const m = nodeById(id); return m ? { id, nx: m.x, ny: m.y } : null; }).filter(Boolean);
      }
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const wireEl = e.target.closest('.ctx-wire');
    if (wireEl && wireEl.dataset.from) {
      drag = { kind: 'edge', from: wireEl.dataset.from, to: wireEl.dataset.to, moved: false };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const cr = canvas.getBoundingClientRect();
    if (e.shiftKey) { // Shift+протягивание по пустому = рамка выделения (без Shift — панорама)
      drag = { kind: 'marquee', sx: e.clientX, sy: e.clientY, rl: cr.left, rt: cr.top, moved: false };
      marquee.hidden = false;
      marquee.style.left = (e.clientX - cr.left) + 'px';
      marquee.style.top = (e.clientY - cr.top) + 'px';
      marquee.style.width = '0px'; marquee.style.height = '0px';
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: graph.view.x, vy: graph.view.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !graph) return;
    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      graph.view.x = drag.vx + dx;
      graph.view.y = drag.vy + dy;
      world.style.transform = `translate(${graph.view.x}px, ${graph.view.y}px) scale(${graph.view.z})`;
    } else if (drag.kind === 'node') {
      const z = graph.view.z;
      const dx = (e.clientX - drag.sx) / z, dy = (e.clientY - drag.sy) / z;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.group) { // двигаем всю выделенную группу, обновляя DOM каждой ноды напрямую
        for (const g of drag.group) {
          const m = nodeById(g.id); if (!m) continue;
          m.x = Math.round(g.nx + dx); m.y = Math.round(g.ny + dy);
          const elx = nodesBox.querySelector(`.ctx-node[data-id="${g.id}"]`);
          if (elx) { elx.style.left = m.x + 'px'; elx.style.top = m.y + 'px'; }
        }
        renderWires();
        return;
      }
      const n = nodeById(drag.id);
      if (!n) return;
      n.x = Math.round(drag.nx + dx);
      n.y = Math.round(drag.ny + dy);
      drag.el.style.left = n.x + 'px';
      drag.el.style.top = n.y + 'px';
      renderWires();
    } else if (drag.kind === 'marquee') {
      const x0 = drag.sx - drag.rl, y0 = drag.sy - drag.rt;
      const x1 = e.clientX - drag.rl, y1 = e.clientY - drag.rt;
      const left = Math.min(x0, x1), top = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      marquee.style.left = left + 'px'; marquee.style.top = top + 'px';
      marquee.style.width = w + 'px'; marquee.style.height = h + 'px';
      if (w + h > 3) drag.moved = true;
    } else if (drag.kind === 'wire') {
      const a = portPos(nodeById(drag.from), 'out');
      const m = worldPoint(e);
      tempWire.setAttribute('d', wireD(a, m));
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const hit = t && t.closest && t.closest('.ctx-port.in');
      document.querySelectorAll('.ctx-port.in.hot').forEach((x) => x.classList.remove('hot'));
      if (hit && canConnect(drag.from, hit.dataset.id)) hit.classList.add('hot');
    } else if (drag.kind === 'edge') {
      drag.moved = true;
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag || !graph) { drag = null; return; }
    if (drag.kind === 'wire') {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const hit = t && t.closest && t.closest('.ctx-port.in');
      if (tempWire) { tempWire.remove(); tempWire = null; }
      document.querySelectorAll('.ctx-port.in.hot').forEach((x) => x.classList.remove('hot'));
      if (hit) { if (!addEdge(drag.from, hit.dataset.id)) toast('Так соединить нельзя (дубль или цикл)'); }
    } else if (drag.kind === 'node') {
      if (drag.moved) { markDirty(); renderAll(); }
      else {
        const now = e.timeStamp || 0;
        if (clickTrack.id === drag.id && (now - clickTrack.t) < 350) {
          clickTrack = { id: null, t: 0 };
          const n = nodeById(drag.id);
          if (n) openNodeModal(n);
        } else {
          clickTrack = { id: drag.id, t: now };
          const nd = nodeById(drag.id);
          if ((e.ctrlKey || e.shiftKey || e.metaKey) && nd && nd.type === 'text') {
            // мультивыделение для группировки: подцепляем и текущий одиночный выбор, если это текст-блок
            if (!multiSel.size && sel && sel.kind === 'node') { const s = nodeById(sel.id); if (s && s.type === 'text') multiSel.add(s.id); }
            if (multiSel.has(drag.id)) multiSel.delete(drag.id); else multiSel.add(drag.id);
            sel = null;
            renderAll();
          } else {
            multiSel.clear();
            sel = { kind: 'node', id: drag.id };
            renderAll();
          }
        }
      }
    } else if (drag.kind === 'edge') {
      if (!drag.moved) {
        const key = drag.from + '>' + drag.to, now = e.timeStamp || 0;
        if (clickTrackEdge.key === key && (now - clickTrackEdge.t) < 350) {
          clickTrackEdge = { key: null, t: 0 };
          removeEdge(drag.from, drag.to);
        } else {
          clickTrackEdge = { key, t: now };
          sel = { kind: 'edge', from: drag.from, to: drag.to };
          renderAll();
        }
      }
    } else if (drag.kind === 'marquee') {
      marquee.hidden = true;
      if (drag.moved) { // выбрать текст-блоки, пересечённые рамкой (мировые координаты)
        const v = graph.view;
        const toWorld = (cx, cy) => ({ x: (cx - drag.rl - v.x) / v.z, y: (cy - drag.rt - v.y) / v.z });
        const a = toWorld(drag.sx, drag.sy), b = toWorld(e.clientX, e.clientY);
        const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
        multiSel.clear();
        for (const n of graph.nodes) {
          if (n.type !== 'text') continue;
          if (n.x < maxX && n.x + NODE_W > minX && n.y < maxY && n.y + NODE_H > minY) multiSel.add(n.id);
        }
        sel = null;
        renderAll();
      }
    } else if (drag.kind === 'pan') {
      if (!drag.moved) { sel = null; multiSel.clear(); renderAll(); }
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    if (!graph) return;
    hideWireDelNow();
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const v = graph.view;
    const oldZ = v.z;
    v.z = Math.max(0.35, Math.min(2, v.z * Math.pow(1.0015, -e.deltaY)));
    v.x = mx - (mx - v.x) * (v.z / oldZ);
    v.y = my - (my - v.y) * (v.z / oldZ);
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (!open || !graph) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && (t.closest('.modal-overlay') || t.closest('.cm-editor'))) return;
    if (e.key === 'Delete') { e.preventDefault(); deleteSelection(); }
    else if (e.ctrlKey && e.code === 'KeyD' && sel && sel.kind === 'node') { e.preventDefault(); duplicateSelection(); }
    else if (e.ctrlKey && e.code === 'KeyG' && multiSel.size >= 2) { e.preventDefault(); groupSelection(); }
    else if (e.key === 'Escape' && multiSel.size) { multiSel.clear(); renderAll(); }
  });

  // ---------------------------------------------------------------- модалки нод
  function makeMdEditor(parent, doc, onChange) {
    return new EditorView({
      state: EditorState.create({
        doc: doc || '',
        extensions: [
          lineNumbers(), highlightActiveLine(), drawSelection(), history(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, markdown(),
          EditorView.lineWrapping,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(u.state.doc.length); }),
        ],
      }),
      parent,
    });
  }
  // opts.readonlyTitle — заголовок не редактируется (берётся из контента, у текст-блоков);
  // opts.hideTypeLabel — после иконки не показывать подпись типа («Текст»)
  function modalShell(n, innerHtml, onClose, opts = {}) {
    const tp = n.type === 'out' ? { label: n.title, icon: 'power' } : NODE_TYPES[n.type];
    const titleHtml = opts.readonlyTitle
      ? '<div id="cxm-title-ro" class="ctx-mtitle-ro"></div>'
      : '<input type="text" id="cxm-title" class="ctx-mtitle" placeholder="Название блока" autocomplete="off" spellcheck="false">';
    const md = makeModal(`
      <div class="ctx-mhead">
        <span class="ctx-mtype"></span>
        ${titleHtml}
      </div>
      ${innerHtml}`, onClose);
    md.m.classList.add('ctx-modal');
    const typeEl = md.m.querySelector('.ctx-mtype');
    typeEl.appendChild(icon(tp.icon, 15));
    if (!opts.hideTypeLabel) typeEl.appendChild(el('span', null, tp.label));
    const titleInp = md.m.querySelector('#cxm-title');
    if (titleInp) titleInp.value = n.title || '';
    return { ...md, titleInp, titleRo: md.m.querySelector('#cxm-title-ro') };
  }
  function openNodeModal(n) {
    if (n.type === 'text') return modalText(n);
    if (n.type === 'group') return modalGroup(n);
    if (n.type === 'out') return modalSettings();
  }

  async function modalText(n) {
    let editor = null;
    const md = modalShell(n, `
      <div class="ctx-medbar">
        <div class="ctx-seg">
          <button class="ctx-segbtn on" id="cxm-mode-edit">✎ Редактировать</button>
          <button class="ctx-segbtn" id="cxm-mode-view">👁 Просмотр</button>
        </div>
        <span id="cxm-chars" class="ctx-mchars"></span>
      </div>
      <div id="cxm-ed" class="ctx-med"></div>
      <div id="cxm-prev" class="ctx-mprev" hidden></div>
      <div class="ctx-mfoot">
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Закрыть</button>
        <button class="btn primary" id="cxm-save" hidden>Сохранить</button>
      </div>`, () => { if (editor) editor.destroy(); }, { hideTypeLabel: true, readonlyTitle: true });
    const charsEl = md.m.querySelector('#cxm-chars');
    const saveBtn = md.m.querySelector('#cxm-save');
    const cancelBtn = md.m.querySelector('#cxm-cancel');
    let origText = '';
    // заголовок текст-блока — отражение первого заголовка из контента (не редактируется руками)
    const refreshTitle = () => {
      const t = titleFromContent(editor ? editor.state.doc.toString() : origText);
      md.titleRo.textContent = t;
      md.titleRo.classList.toggle('empty', !t || t === 'Текст');
    };
    const recomputeDirty = () => {
      const dirty = !!editor && editor.state.doc.toString() !== origText;
      saveBtn.hidden = !dirty;
      cancelBtn.textContent = dirty ? 'Отмена' : 'Закрыть';
      return dirty;
    };
    // стрелки-слайды: листаем текстовые блоки в порядке канвы (сверху-вниз, слева-направо)
    const textNodes = graph.nodes.filter((x) => x.type === 'text').sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const navIdx = textNodes.findIndex((x) => x.id === n.id);
    if (textNodes.length > 1 && navIdx >= 0) {
      const nav = el('div', 'ctx-mnav');
      const prev = el('button', 'ctx-mnav-btn', '◀'); prev.title = 'Предыдущий блок';
      const pos = el('span', 'ctx-mnav-pos', `${navIdx + 1}/${textNodes.length}`);
      const next = el('button', 'ctx-mnav-btn', '▶'); next.title = 'Следующий блок';
      prev.disabled = navIdx <= 0;
      next.disabled = navIdx >= textNodes.length - 1;
      prev.onclick = () => navTo(-1);
      next.onclick = () => navTo(1);
      nav.append(prev, pos, next);
      md.m.querySelector('.ctx-mhead').appendChild(nav);
    }
    const navTo = (delta) => {
      const target = textNodes[navIdx + delta];
      if (!target) return;
      const go = () => { md.close(); openNodeModal(target); };
      if (recomputeDirty()) {
        showConfirm('Несохранённые изменения', `В блоке «${n.title}» есть несохранённые правки. Сохранить перед переходом?`,
          'Сохранить и перейти', async () => { if (await save()) openNodeModal(target); },
          'Без сохранения', go);
      } else go();
    };
    const r = await lite.ctx.blockRead(proj.id, proj.path, n);
    origText = (r && r.text) || '';
    editor = makeMdEditor(md.m.querySelector('#cxm-ed'), origText, (len) => { charsEl.textContent = fmtTok(len); recomputeDirty(); refreshTitle(); });
    charsEl.textContent = fmtTok((r && r.chars) || 0);
    refreshTitle();
    const edBox = md.m.querySelector('#cxm-ed');
    const prevBox = md.m.querySelector('#cxm-prev');
    const setMode = (view) => {
      if (view) renderSafeMarkdown(prevBox, editor.state.doc.toString());
      edBox.hidden = view; prevBox.hidden = !view;
      md.m.querySelector('#cxm-mode-view').classList.toggle('on', view);
      md.m.querySelector('#cxm-mode-edit').classList.toggle('on', !view);
      if (!view && editor.requestMeasure) editor.requestMeasure();
    };
    md.m.querySelector('#cxm-mode-edit').onclick = () => setMode(false);
    md.m.querySelector('#cxm-mode-view').onclick = () => setMode(true);
    const save = async () => {
      const text = editor.state.doc.toString();
      n.title = titleFromContent(text); // заголовок блока = первый заголовок из контента
      const w = await lite.ctx.blockWrite(proj.id, proj.path, n, text);
      if (w && w.error) { toast(w.error, { kind: 'err' }); return false; }
      n.chars = w.chars || 0;
      n.splittable = splitTree(text).length >= 2; // появились ≥2 заголовка → на блоке покажется ✂
      if (n.base) n.base = false; // тронули — больше не черновой скаффолд (распил его не снесёт)
      markDirty(); renderAll(); md.close();
      return true;
    };
    md.m.querySelector('#cxm-save').onclick = save;
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
  }

  function modalGroup(n) {
    const md = modalShell(n, `
      <div class="field"><label>Заголовок в файле (необязательно)</label>
        <input type="text" id="cxm-head" class="ctx-mtitle" placeholder="напр. ## Раздел · пусто = обёртка (в файл не пишется)" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label>Цвет группы</label><div id="cxm-colors" class="ctx-colors"></div></div>
      <div class="ctx-mchars">Тумблер для набора блоков. С «заголовком в файле» — это группа-текст: заголовок пишется перед содержимым детей. Пусто — обёртка (имя только на канве).</div>
      <div class="ctx-mfoot">
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Закрыть</button>
        <button class="btn primary" id="cxm-save" hidden>Сохранить</button>
      </div>`);
    const headInp = md.m.querySelector('#cxm-head');
    headInp.value = n.head || '';
    const colorsBox = md.m.querySelector('#cxm-colors');
    const saveBtn = md.m.querySelector('#cxm-save');
    const cancelBtn = md.m.querySelector('#cxm-cancel');
    let picked = n.color || 'green';
    const origTitle = md.titleInp.value, origColor = picked, origHead = headInp.value;
    const recomputeDirty = () => {
      const dirty = picked !== origColor || md.titleInp.value !== origTitle || headInp.value !== origHead;
      saveBtn.hidden = !dirty; cancelBtn.textContent = dirty ? 'Отмена' : 'Закрыть';
    };
    md.titleInp.addEventListener('input', recomputeDirty);
    headInp.addEventListener('input', recomputeDirty);
    for (const c of GROUP_COLORS) {
      const sw = el('button', 'ctx-color g-' + c + (picked === c ? ' on' : ''));
      sw.onclick = () => { picked = c; colorsBox.querySelectorAll('.ctx-color').forEach((x) => x.classList.remove('on')); sw.classList.add('on'); recomputeDirty(); };
      colorsBox.appendChild(sw);
    }
    md.m.querySelector('#cxm-save').onclick = () => {
      n.title = md.titleInp.value.trim() || 'Группа';
      n.color = picked;
      const h = headInp.value.trim();
      if (h) n.head = h; else delete n.head; // есть заголовок → группа-текст; пусто → обёртка
      markDirty(); renderAll(); md.close();
    };
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
  }

  // ---------------------------------------------------------------- настройки (бекапы и пр.)
  async function modalSettings() {
    const s = graph.settings;
    const { m, close } = makeModal(`
      <h2>Контекст — настройки (${AGENT_META[agent].label})</h2>
      <div class="field"><label>Папка бекапов (пусто = context_project_bkp в корне проекта)</label>
        <div class="ctx-row"><input type="text" id="cxs-dir" autocomplete="off" spellcheck="false">
        <button class="btn" id="cxs-pick">…</button><button class="btn" id="cxs-open" title="Открыть папку бекапов">📂</button></div></div>
      <div class="field"><label>Сколько бекапов хранить (на каждый файл)</label>
        <input type="number" id="cxs-keep" min="1" max="100"></div>
      <label class="ctx-mcheck"><input type="checkbox" id="cxs-auto"> при открытии новой вкладки-терминала собрать контекст, если файл-выход отсутствует</label>
      <div class="modal-actions"><button class="btn" id="cxs-cancel">Отмена</button><button class="btn primary" id="cxs-save">Сохранить</button></div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxs-dir').value = s.backupDir || '';
    m.querySelector('#cxs-dir').placeholder = proj ? proj.path + '/context_project_bkp' : 'context_project_bkp';
    m.querySelector('#cxs-keep').value = s.backupKeep || 10;
    m.querySelector('#cxs-auto').checked = s.autoApply !== false;
    m.querySelector('#cxs-pick').onclick = async () => { const d = await lite.pickDir(); if (d) m.querySelector('#cxs-dir').value = d; };
    m.querySelector('#cxs-open').onclick = async () => {
      const r = await lite.ctx.backupDir(proj.path, m.querySelector('#cxs-dir').value.trim() || null);
      if (r && r.dir) lite.openInFileManager(r.dir);
    };
    m.querySelector('#cxs-cancel').onclick = close;
    // Настройки сохраняем СРАЗУ, в изоляции от неподтверждённых правок: читаем граф с диска, меняем
    // только settings, пишем обратно — тогда «Сбросить» откатит канву, но папку/глубину сохранит.
    const persistSettings = async () => {
      const disk = await lite.ctx.load(proj.id, agent, activeProfile);
      const dg = normalizeGraph(disk && disk.graph, agent);
      dg.settings = { ...dg.settings, ...s };
      await lite.ctx.save(proj.id, agent, dg, activeProfile);
    };
    m.querySelector('#cxs-save').onclick = async () => {
      const oldDir = s.backupDir || '';
      const newDir = m.querySelector('#cxs-dir').value.trim();
      s.backupKeep = Math.max(1, Math.min(100, parseInt(m.querySelector('#cxs-keep').value, 10) || 10));
      s.autoApply = m.querySelector('#cxs-auto').checked;
      if (newDir !== oldDir) {
        const mv = await lite.ctx.backupMove(proj.path, oldDir, newDir);
        if (mv && mv.error) { toast('Бекапы не перенесены: ' + mv.error, { kind: 'err', ttl: 8000 }); return; }
        s.backupDir = newDir;
        await persistSettings();
        close();
        toast(mv && mv.moved ? `Настройки сохранены · перенесено бекапов: ${mv.moved} → ${mv.dir}` : 'Настройки сохранены', { ttl: 7000 });
        return;
      }
      s.backupDir = newDir;
      await persistSettings();
      close();
      toast('Настройки сохранены');
    };
  }

  // ---------------------------------------------------------------- меню добавления (текст/группа)
  function showAddMenu() {
    if (!proj || !graph) { toast('Сначала открой проект'); return; }
    const { m, close } = makeModal('<h2>Новый блок</h2><div id="cxa-list" class="ctx-addlist"></div>');
    const list = m.querySelector('#cxa-list');
    for (const [type, t] of Object.entries(NODE_TYPES)) {
      const row = el('div', 'ctx-addrow');
      const ic = el('span', 'ctx-nicon'); ic.appendChild(icon(t.icon, 16)); row.appendChild(ic);
      const tx = el('div', 'ctx-addtx');
      tx.appendChild(el('div', 'ctx-addlabel', t.label));
      tx.appendChild(el('div', 'ctx-addhint', t.hint));
      row.appendChild(tx);
      row.onclick = () => { close(); const n = addNode(type); if (type === 'text') openNodeModal(n); };
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- Подтвердить (сохранить + собрать) текущего агента
  async function applyCompile(opts = {}) {
    if (!proj || !graph) return;
    const btn = $('#ctx-apply');
    btn.disabled = true;
    await lite.ctx.save(proj.id, agent, graph, activeProfile); // компилятор читает граф с диска
    const r = await lite.ctx.compile({ projId: proj.id, projPath: proj.path, agent, profileId: activeProfile, force: !!opts.force });
    btn.disabled = false;
    if (!r || r.error) { toast((r && r.error) || 'ошибка сборки', { kind: 'err', ttl: 8000 }); return; }
    if (r.graph) { graph = normalizeGraph(r.graph, agent); renderAll(); }
    if (r.conflicts && r.conflicts.length && !opts.force) {
      showConfirm('Файл создан не LiteEditor', `${r.conflicts.join(' и ')} уже существует и не похож на наш. Забекапить и заменить?`, 'Забекапить и заменить', () => applyCompile({ force: true }));
      return;
    }
    if (r.diverged && r.diverged.length && !opts.force) {
      showConfirm('Файл изменён вне модуля', `${r.diverged.join(' и ')} правился снаружи (вероятно, агентом). Перезаписать сборкой (старое — в бекап и в «Версии») или открыть реконсиляцию, чтобы втянуть правки на канву?`,
        'Перезаписать', () => applyCompile({ force: true }),
        'Реконсиляция', () => openReconcile());
      return;
    }
    unsaved = false;
    externalChange = false; renderExternBadge(); // файл теперь = сборке
    if (profiles) { profiles.applied = r.applied || activeProfile; renderProfiles(); }
    // удаления применены — стираем файлы текст-блоков, которыми граф больше не владеет
    for (const dn of pendingDelete) {
      if (!graph.nodes.some((x) => x.id === dn.id && x.type === 'text')) { try { lite.ctx.blockDelete(proj.id, proj.path, dn); } catch (_) {} }
    }
    pendingDelete = [];
    await refreshPoints(); // появилась новая версия
    updateStats();
    const parts = (r.results || []).map((x) => `${x.file} ${fmtTok(x.chars)}${x.wrote ? (x.backup ? ` (бекап: ${x.backup})` : '') : ' — без изменений'}`);
    if (!parts.length) parts.push('нечего собирать — подключи блоки к выходу');
    for (const err of (r.errors || [])) toast(err, { kind: 'err', ttl: 8000 });
    const bdir = ((r.results || []).find((x) => x.bdir) || {}).bdir;
    toast('Контекст: ' + parts.join(' · ') + (bdir ? ` · бекапы в ${bdir}` : ''), { ttl: 8000 });
  }
  // Сбросить: вернуть канву к последнему подтверждённому виду (перечитать граф с диска)
  async function resetGraph() {
    if (!proj || !graph || !unsaved) return;
    showConfirm('Сбросить изменения?', 'Канва вернётся к последнему подтверждённому виду. Неподтверждённые правки (расположение, добавленные/удалённые блоки и провода) будут отброшены.', 'Сбросить', async () => {
      const r = await lite.ctx.load(proj.id, agent, activeProfile);
      graph = normalizeGraph(r && r.graph, agent);
      sel = null; multiSel.clear(); unsaved = false; pendingDelete = [];
      renderAll();
      checkExternal(); // файл мог разойтись с модулем (внешняя правка) — перепроверяем бейдж
      toast('Изменения сброшены');
    });
  }
  // Реконсиляция: файл агента изменён снаружи → сопоставить секции файла (по заголовкам) с блоками канвы
  // и втянуть выбранное (изменён/новый/нет-в-файле). Источник истины остаётся в модуле; запись — «Подтвердить».
  async function openReconcile() {
    if (!proj || !graph) return;
    const r = await lite.ctx.assembleText(proj.id, proj.path, agent, profiles && profiles.applied);
    if (!r || !r.fileExists) { externalChange = false; renderExternBadge(); toast('Файл агента не найден'); return; }
    // ВАЖНО: убрать наши служебные маркеры (заголовок + комментарии блоков) перед разбором,
    // иначе они прилипают к секциям и всё выглядит «изменённым». Сравниваем чистый контент.
    const norm = (t) => String(t || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => !/^<!--\s*(LiteEditorAI:contextgraph|── блок:)/.test(l)).join('\n').trim();
    const fileSections = splitTree(norm(r.fileText));
    const textBlocks = graph.nodes.filter((n) => n.type === 'text');
    const contents = {};
    for (const b of textBlocks) { const rr = await lite.ctx.blockRead(proj.id, proj.path, b); contents[b.id] = norm((rr && rr.text) || ''); }
    const out = graph.nodes.find((n) => n.type === 'out' && n.out === agent);
    const contribIds = new Set(contributors(out ? out.id : '').map((n) => n.id));
    const byTitle = new Map();
    for (const b of textBlocks) if (!byTitle.has(b.title)) byTitle.set(b.title, b);
    const used = new Set();
    const changes = []; // {kind:'changed'|'new'|'removed', section?, block?}
    for (const s of fileSections) {
      const b = byTitle.get(s.title);
      if (b && !used.has(b.id)) { used.add(b.id); if (contents[b.id] !== norm(s.content)) changes.push({ kind: 'changed', section: s, block: b }); }
      else changes.push({ kind: 'new', section: s });
    }
    for (const b of textBlocks) if (!used.has(b.id) && contribIds.has(b.id)) changes.push({ kind: 'removed', block: b });
    if (!changes.length) {
      externalChange = false; renderExternBadge();
      infoModal('Внешние правки', `Файл ${OUT_FILES[agent]} отличается только форматированием (пустые строки/маркеры) — содержимое блоков совпадает. Нажмите «Подтвердить», чтобы пересобрать файл из модуля.`);
      return;
    }
    const { m, close } = makeModal(`<h2>Внешние правки · ${OUT_FILES[agent]}</h2>
      <div class="about-desc">Файл изменён вне модуля (вероятно, агентом). <b>Конфликт</b> — блок правился и тут, и в файле: выбери «Оставить моё / Взять из файла / Соединить». <b>Новый/нет в файле</b> — галочкой. Текущий файл сохранён в «🕘 Версии». После — «✓ Подтвердить».</div>
      <div id="cxr-list" class="ctx-vlist"></div>
      <div class="modal-actions"><button class="btn" id="cxr-cancel">Закрыть</button><button class="btn primary" id="cxr-apply">Применить выбранное</button></div>`);
    m.classList.add('ctx-modal', 'ctx-modal-wide');
    const list = m.querySelector('#cxr-list');
    const META = { changed: { tag: 'конфликт', cls: 'warn' }, new: { tag: 'новый', cls: 'ok' }, removed: { tag: 'нет в файле', cls: 'danger' } };
    for (const ch of changes) {
      const meta = META[ch.kind];
      const title = ch.kind === 'removed' ? ch.block.title : ch.section.title;
      const row = el('div', 'ctx-vrow');
      const head = el('div', 'ctx-vhead');
      head.appendChild(el('span', 'ctx-rc-tag ' + meta.cls, meta.tag));
      head.appendChild(el('span', 'ctx-vname', title || 'Без заголовка'));
      row.appendChild(head);
      if (ch.kind === 'changed') {
        // конфликт: блок изменён и в файле, и на канве → выбор моё / из файла / соединить (по умолч. моё)
        ch._mode = 'mine';
        const seg = el('div', 'ctx-rc-seg'); const btns = {};
        for (const [val, label] of [['mine', 'Оставить моё'], ['file', 'Взять из файла'], ['merge', 'Соединить']]) {
          const b = el('button', 'ctx-rc-opt' + (val === 'mine' ? ' on' : ''), label);
          b.onclick = () => { ch._mode = val; Object.keys(btns).forEach((k) => btns[k].classList.toggle('on', k === val)); };
          btns[val] = b; seg.appendChild(b);
        }
        row.appendChild(seg);
        const det = el('div', 'ctx-rc-det'); det.hidden = true;
        const vbox = (label, text) => { const w = el('div', 'ctx-rc-ver'); w.appendChild(el('div', 'ctx-rc-vlab', label)); const pre = el('pre', 'ctx-rc-pre'); pre.textContent = text || '(пусто)'; w.appendChild(pre); return w; };
        det.appendChild(vbox('Моё (на канве)', contents[ch.block.id]));
        det.appendChild(vbox('Из файла', norm(ch.section.content)));
        const tog = el('button', 'ctx-rc-show', '▸ показать обе версии');
        tog.onclick = () => { det.hidden = !det.hidden; tog.textContent = (det.hidden ? '▸' : '▾') + ' показать обе версии'; };
        row.appendChild(tog); row.appendChild(det);
      } else {
        const lab = el('label', 'ctx-rc-lab');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = ch.kind === 'new'; // новый — по умолч. втянуть; нет-в-файле — нет
        ch._cb = cb;
        lab.appendChild(cb);
        lab.appendChild(el('span', 'ctx-vmeta', ch.kind === 'new' ? 'создать блок и подключить к выходу' : 'удалить блок с канвы (его нет в файле)'));
        row.appendChild(lab);
      }
      list.appendChild(row);
    }
    m.querySelector('#cxr-cancel').onclick = close; // отмена НЕ гасит бейдж — расхождение осталось
    m.querySelector('#cxr-apply').onclick = async () => {
      try { await lite.ctx.snapshotOutput(proj.id, proj.path, agent, 'Внешняя правка ' + fmtTs(Date.now())); await refreshPoints(); } catch (_) {}
      let maxY = Math.max(60, ...graph.nodes.map((n) => n.y));
      for (const ch of changes) {
        if (ch.kind === 'changed') {
          if (ch._mode === 'mine') continue; // оставить как на канве
          const content = ch._mode === 'file'
            ? ch.section.content
            : (contents[ch.block.id] || '') + '\n\n<!-- ↑ моё · ↓ из файла -->\n\n' + ch.section.content; // соединить
          const w = await lite.ctx.blockWrite(proj.id, proj.path, ch.block, content);
          ch.block.chars = (w && w.chars) || 0;
          ch.block.title = titleFromContent(content);
          ch.block.splittable = splitTree(content).length >= 2;
          ch.block.base = false;
        } else if (ch.kind === 'new') {
          if (!ch._cb.checked) continue;
          maxY += 96;
          const nn = { id: uid(), type: 'text', title: titleFromContent(ch.section.content), enabled: true, x: 140, y: maxY, chars: 0, splittable: splitTree(ch.section.content).length >= 2 };
          const w = await lite.ctx.blockWrite(proj.id, proj.path, nn, ch.section.content);
          nn.chars = (w && w.chars) || 0;
          graph.nodes.push(nn);
          if (out) graph.edges.push({ from: nn.id, to: out.id });
        } else if (ch.kind === 'removed') {
          if (!ch._cb.checked) continue;
          graph.nodes = graph.nodes.filter((x) => x.id !== ch.block.id);
          graph.edges = graph.edges.filter((e) => e.from !== ch.block.id && e.to !== ch.block.id);
          pendingDelete.push({ ...ch.block });
        }
      }
      externalChange = false; renderExternBadge();
      sel = null; markDirty(); renderAll(); fitView(); close();
      toast('Правки втянуты на канву — нажми ✓ Подтвердить, чтобы записать в файл', { ttl: 9000 });
    };
  }
  // Автосборка при новой вкладке-терминале: по обоим агентам, только если файл-выход отсутствует.
  async function autoApply(p) {
    try {
      if (proj && p.id === proj.id && unsaved) return;
      for (const ag of AGENTS) {
        const prof = await lite.ctx.profiles(p.id, ag);
        const r0 = await lite.ctx.load(p.id, ag, prof && prof.active);
        const g = r0 && r0.graph;
        if (!g || (g.settings && g.settings.autoApply === false)) continue;
        if (!(g.nodes || []).some((n) => n.type === 'text')) continue;
        const o = (g.nodes || []).find((n) => n.type === 'out' && n.out === ag);
        if (!o || !o.enabled) continue;
        if (await lite.fs.exists(p.path + '/' + OUT_FILES[ag])) continue;
        const r = await lite.ctx.compile({ projId: p.id, projPath: p.path, agent: ag, profileId: prof && prof.active });
        if (r && r.ok && proj && p.id === proj.id && open && !unsaved && ag === agent) {
          graph = normalizeGraph(r.graph, agent);
          if (profiles && r.applied) { profiles.applied = r.applied; renderProfiles(); }
          renderAll();
        }
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------- распил по заголовкам (плоско)
  // Разбор контента ПЛОСКО по заголовкам: ЛЮБОЙ заголовок (#…######) → отдельный блок (контент до
  // следующего заголовка любого уровня). Преамбула (до первого заголовка) — отдельный блок. → [{title,content}]
  function splitTree(src) {
    const text = String(src || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    let fence = null; const heads = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const f = ln.match(/^\s*(```+|~~~+)/);
      if (f) { const mk = f[1][0]; if (!fence) fence = mk; else if (fence === mk) fence = null; continue; }
      if (fence) continue;
      const h = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) heads.push({ i, title: h[2].trim() });
    }
    const blocks = [];
    const firstI = heads.length ? heads[0].i : lines.length;
    const pre = lines.slice(0, firstI).join('\n').trim();
    if (pre) blocks.push({ title: titleFromContent(pre), content: pre });
    for (let k = 0; k < heads.length; k++) {
      const to = k + 1 < heads.length ? heads[k + 1].i : lines.length;
      const content = lines.slice(heads[k].i, to).join('\n').trim();
      if (content) blocks.push({ title: heads[k].title.slice(0, 60) || 'Блок', content });
    }
    return blocks;
  }
  // Рекурсивный разбор в дерево: header-only заголовок (без текста) с под-заголовками → ГРУППА-ТЕКСТ
  // (head = строка заголовка, дети — под-секции, рекурсивно); иначе обычный текст-блок. Преамбула — текст.
  function splitToTree(src) {
    const text = String(src || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    let fence = null; const heads = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const f = ln.match(/^\s*(```+|~~~+)/);
      if (f) { const mk = f[1][0]; if (!fence) fence = mk; else if (fence === mk) fence = null; continue; }
      if (fence) continue;
      const h = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) heads.push({ i, level: h[1].length, title: h[2].trim() });
    }
    const result = [];
    const firstI = heads.length ? heads[0].i : lines.length;
    const pre = lines.slice(0, firstI).join('\n').trim();
    if (pre) result.push({ kind: 'text', title: titleFromContent(pre), content: pre });
    const build = (lo, hi) => {
      const nodes = []; let k = lo;
      while (k < hi) {
        const h = heads[k];
        const nextI = (k + 1 < heads.length) ? heads[k + 1].i : lines.length;
        const body = lines.slice(h.i + 1, nextI).join('\n').trim();
        let c = k + 1;
        while (c < hi && heads[c].level > h.level) c++;
        if (!body && c > k + 1) { // нет текста + есть под-заголовки → группа-текст (рекурсивно)
          nodes.push({ kind: 'group', head: lines.slice(h.i, heads[k + 1].i).join('\n').trim(), title: h.title.slice(0, 60) || 'Группа', children: build(k + 1, c) });
          k = c;
        } else {
          const content = lines.slice(h.i, nextI).join('\n').trim();
          if (content) nodes.push({ kind: 'text', title: h.title.slice(0, 60) || 'Блок', content });
          k = k + 1;
        }
      }
      return nodes;
    };
    result.push(...build(0, heads.length));
    return result;
  }
  const countTree = (nodes) => nodes.reduce((c, n) => c + 1 + (n.kind === 'group' ? countTree(n.children) : 0), 0);
  // Создать ноды/группы из дерева (рекурсивно), привязать к parentId. y = порядок документа (для раскладки).
  let _treeOrd = 0;
  async function createTree(nodes, parentId) {
    for (const node of nodes) {
      if (node.kind === 'group') {
        const gid = uid();
        graph.nodes.push({ id: gid, type: 'group', title: node.title, head: node.head, enabled: true, x: 0, y: _treeOrd++, color: 'info', chars: (node.head || '').length });
        graph.edges.push({ from: gid, to: parentId });
        await createTree(node.children, gid);
      } else {
        const nn = { id: uid(), type: 'text', title: node.title || 'Блок', enabled: true, x: 0, y: _treeOrd++, chars: 0, splittable: splitTree(node.content).length >= 2 };
        const w = await lite.ctx.blockWrite(proj.id, proj.path, nn, node.content);
        nn.chars = (w && w.chars) || 0;
        graph.nodes.push(nn);
        graph.edges.push({ from: nn.id, to: parentId });
      }
    }
  }
  // Горизонтальная слоёная раскладка: выход справа, глубина вложенности — левее, порядок (pre-order) — вниз.
  function layoutGraph() {
    const out = graph.nodes.find((n) => n.type === 'out' && n.out === agent);
    if (!out) return;
    const order = (arr) => arr.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const childrenOf = (id) => order(graph.edges.filter((e) => e.to === id).map((e) => nodeById(e.from)).filter(Boolean));
    const COLW = 300, ROWH = 104; let row = 0; const seen = new Set();
    const place = (node, depth) => {
      if (seen.has(node.id)) return; seen.add(node.id);
      node._depth = depth; node._row = row++;
      childrenOf(node.id).forEach((c) => place(c, depth + 1));
    };
    childrenOf(out.id).forEach((r) => place(r, 0));
    let maxD = 0; for (const n of graph.nodes) if (n._depth != null) maxD = Math.max(maxD, n._depth);
    const X0 = 80;
    for (const n of graph.nodes) if (n._depth != null) { n.x = X0 + (maxD - n._depth) * COLW; n.y = 60 + n._row * ROWH; delete n._depth; delete n._row; }
    out.x = X0 + (maxD + 1) * COLW; out.y = Math.round(60 + (Math.max(1, row) * ROWH) / 2 - 40);
  }
  async function runSplit(pointId) {
    if (!proj || !graph) return;
    const pr = await lite.ctx.pointRead(proj.id, agent, pointId);
    if (!pr || !pr.exists || !pr.text || !pr.text.trim()) { toast('Пустая версия — нечего пилить', { kind: 'err' }); return; }
    const tree = splitToTree(pr.text);
    if (!tree.length) { toast('Не удалось разбить версию', { kind: 'err' }); return; }
    const out = graph.nodes.find((n) => n.type === 'out' && n.out === agent);
    for (const b of graph.nodes.filter((n) => n.base)) { // убрать черновой стартовый монолит
      if (b.type === 'text') pendingDelete.push({ ...b });
      graph.nodes = graph.nodes.filter((n) => n.id !== b.id);
      graph.edges = graph.edges.filter((e) => e.from !== b.id && e.to !== b.id);
    }
    _treeOrd = 0;
    await createTree(tree, out && out.id);
    layoutGraph();
    sel = null; markDirty(); renderAll(); fitView();
    toast(`Разбито: ${countTree(tree)} блок(ов)/групп. Проверь и нажми ✓ Подтвердить`, { ttl: 8000 });
  }
  // Распил ОДНОГО блока: его контент → поддерево; корни цепляются к бывшему приёмнику блока; блок убирается.
  async function splitBlock(n) {
    if (!proj || !graph || n.type !== 'text') return;
    const r = await lite.ctx.blockRead(proj.id, proj.path, n);
    const tree = splitToTree((r && r.text) || '');
    if (countTree(tree) < 2) { toast('В блоке нет заголовков для распила (нужно ≥2 секции)', { kind: 'err' }); return; }
    let parentTo = graph.edges.filter((e) => e.from === n.id).map((e) => e.to)[0];
    if (!parentTo) { const out = graph.nodes.find((x) => x.type === 'out' && x.out === agent); parentTo = out && out.id; }
    pendingDelete.push({ ...n });
    graph.nodes = graph.nodes.filter((x) => x.id !== n.id);
    graph.edges = graph.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    _treeOrd = 0;
    await createTree(tree, parentTo);
    layoutGraph();
    sel = null; markDirty(); renderAll(); fitView();
    toast(`Блок разбит: ${countTree(tree)} блок(ов)/групп`, { ttl: 7000 });
  }
  // Кнопка онбординга «Распилить файл» — пилит стартовый (черновой) текст-блок
  function splitScaffold() {
    const n = graph && graph.nodes.find((x) => x.base && x.type === 'text');
    dismissOnboard();
    if (!n) { toast('Нет стартового блока для распила'); return; }
    if (!n.splittable) { toast('В файле нет заголовков для распила (нужно ≥2 секции)', { kind: 'err' }); return; }
    splitBlock(n);
  }

  // ---------------------------------------------------------------- справка
  function showHelp() {
    const { m, close } = makeModal(`
      <h2>Как работает «Контекст»</h2>
      <div class="ctx-help">
        <p><b>Зачем это.</b> Агент в терминале (Claude Code, Codex) при старте читает файл контекста —
        <b>CLAUDE.md</b> или <b>AGENTS.md</b> в корне проекта. Модуль собирает такой файл из «кубиков» на канве:
        видно, чем кормится агент, сколько это весит в токенах, и можно тумблером менять набор под задачу.</p>
        <p><b>Агенты независимы.</b> Сверху переключатель <b>Claude / Codex</b> — у каждого свои профили, версии
        и свой собранный файл. Можно держать Claude под код, а Codex под вёрстку и применять их раздельно.</p>
        <p><b>Профиль</b> — это рецепт контекста (канва). Их может быть несколько (вкладки над канвой); активный
        (собранный в файл) помечен галочкой <b>✓</b>. Остальные профили хранятся <b>в модуле</b> и не теряются.
        <b>Файл — это рендер применённого профиля, а не источник.</b> Действия профиля — по «⋯» на вкладке
        (переименовать / дублировать / удалить). Новый профиль: «+» → Пустой / Копия активного / Распилить версию.</p>
        <p><b>Блоки по заголовкам.</b> Каждый заголовок (<code>#</code>/<code>##</code>/<code>###</code>…) — это
        отдельный блок; блоки выстраиваются <b>вертикальным списком</b> в порядке документа и подключаются к выходу.
        Сборка склеивает их в файл в том же порядке — без потери текста. Тумблер блока включает/выключает его в файле.</p>
        <p><b>Старт и распил.</b> Профиль открывается одним <b>текстовым блоком</b> = весь файл агента (или пустой).
        Наведи на блок и нажми <b>✂</b> — он разобьётся на блоки <b>по заголовкам</b>. ✂ есть на <b>каждом</b> блоке
        с ≥2 секциями: дописал разделы — можно распилить и его.</p>
        <p><b>Блоки</b> (кнопка «+»): <b>Текст</b> — markdown (правка двойным кликом) и <b>Группа</b> — тумблер для
        набора блоков (включать/выключать тему целиком).</p>
        <p><b>Провода.</b> Тяни от <b>правой</b> точки блока (выход) к <b>левой</b> точке группы/выхода (вход).
        Напрямую в выход = постоянный контекст, через группу = ситуативный. Наведение на провод → «×» удаляет его.</p>
        <p><b>Группировка.</b> Выдели несколько блоков <b>Ctrl+клик</b> → <b>⧉ Сгруппировать</b> (или Ctrl+G): обернёт
        их в группу-тумблер.</p>
        <p><b>🕘 Версии (точки восстановления).</b> История файла как «git для одного файла»: <b>Оригинал</b> (🔒,
        снимок при первом открытии) и каждая сборка. Любую версию можно <b>Восстановить</b> на канву одним
        блоком или <b>✂ Распилить</b> — разложить её на блоки <b>по заголовкам</b> (детерминированно, без потери
        текста). Версии (кроме «Оригинала») удаляются. Так можно пилить и экспериментировать сколько угодно —
        оригинал всегда сохранён.</p>
        <p><b>✓ Подтвердить / ↺ Сбросить.</b> Автосохранения нет — правки копятся, пока не подтвердишь.
        «Подтвердить» сохраняет канву и пересобирает файл текущего агента (старый — в бекап, плюс новая версия).
        Чужой файл без согласия не перезаписывается. «Сбросить» откатывает канву к последнему подтверждённому виду.</p>
        <p><b>Горячие клавиши и жесты.</b></p>
        <table class="ctx-keys">
          <tr><td>Колесо мыши</td><td>зум канвы</td></tr>
          <tr><td>Перетаскивание фона</td><td>панорама (двигать канву)</td></tr>
          <tr><td><kbd>Shift</kbd> + протягивание</td><td>рамка выделения блоков</td></tr>
          <tr><td>Клик по блоку</td><td>выделить</td></tr>
          <tr><td><kbd>Ctrl</kbd>/<kbd>Shift</kbd> + клик по блоку</td><td>мультивыбор (добавить/убрать)</td></tr>
          <tr><td>Двойной клик по блоку</td><td>редактировать</td></tr>
          <tr><td>Тянуть выделенный блок</td><td>двигать всю выделенную группу</td></tr>
          <tr><td>Тянуть от правой точки блока</td><td>соединить с группой/выходом</td></tr>
          <tr><td>Наведение на провод → «×»</td><td>удалить соединение</td></tr>
          <tr><td>Наведение на блок → «✂»</td><td>распилить блок по заголовкам</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>G</kbd></td><td>сгруппировать выделенные (≥2)</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>дублировать выделенный блок</td></tr>
          <tr><td><kbd>Del</kbd></td><td>удалить выделенный блок/провод</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>сбросить мультивыбор</td></tr>
        </table>
      </div>
      <div class="modal-actions"><button class="btn primary" id="cxh-ok">Понятно</button></div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxh-ok').onclick = close;
  }

  // ---------------------------------------------------------------- бинды панели
  wireDel.addEventListener('mouseenter', () => clearTimeout(wireDelHideTimer));
  wireDel.addEventListener('mouseleave', scheduleHideWireDel);
  wireDel.addEventListener('click', () => {
    const f = wireDel.dataset.from, t = wireDel.dataset.to;
    hideWireDelNow();
    if (f && t) removeEdge(f, t);
  });
  $('#ctx-help').addEventListener('click', showHelp);
  $('#ctx-add').addEventListener('click', showAddMenu);
  $('#ctx-fit').addEventListener('click', fitView);
  $('#ctx-group').addEventListener('click', groupSelection);
  $('#ctx-apply').addEventListener('click', () => applyCompile());
  $('#ctx-reset').addEventListener('click', resetGraph);
  $('#ctx-points').addEventListener('click', showPoints);
  $('#ctx-settings').addEventListener('click', () => { if (graph) modalSettings(); });
  $('#ctx-ob-split').addEventListener('click', splitScaffold);
  $('#ctx-ob-help').addEventListener('click', showHelp);
  $('#ctx-ob-close').addEventListener('click', dismissOnboard);
  $('#ctx-extern').addEventListener('click', openReconcile);
  // агент дописал/правил выходной файл вне модуля → перепроверяем расхождение для текущего агента
  lite.ctx.onOutputChanged(({ projId, agent: ag } = {}) => { if (open && proj && projId === proj.id && ag === agent) checkExternal(); });

  // dirty-guard на закрытие окна: пока есть неподтверждённые правки канвы — спросить перед закрытием.
  function confirmClose(proceed) {
    if (unsaved) showConfirm('Закрыть «Контекст»?', 'Есть неподтверждённые изменения — они будут потеряны.', 'Закрыть', proceed);
    else proceed();
  }

  return { isOpen: () => open, setOpen, toggle, onProjectChange, autoApply, applyCompile, confirmClose };
}
