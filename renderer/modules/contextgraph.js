// LiteEditor — модуль «Контекст»: per-project граф контекста агента (канва в духе n8n).
// Блоки-источники (текст/файл/команда/слот агента) → группы-профили с тумблерами → ноды-выходы
// (Claude → CLAUDE.md, Codex → AGENTS.md). Семантика топологии: блок, воткнутый в выход
// напрямую — постоянный контекст; через группу — переключаемый профиль. Компиляция и бекапы —
// в main (ctx:*), здесь только канва/модалки/оркестрация. Изолирован по канону модулей:
// всё из ядра — через host-колбэки, UI-хелперы — прямые импорты из ui.js, бэкенд — window.lite.ctx.
// host: { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels }
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
const PORT_Y = 30;         // вертикаль портов от верха ноды (центр шапки)
const NODE_TYPES = {
  text:  { label: 'Текст',       icon: 'note',     hint: 'статичный markdown-блок' },
  file:  { label: 'Файл',        icon: 'file',     hint: 'живая ссылка на файл проекта' },
  cmd:   { label: 'Команда',     icon: 'terminal', hint: 'вывод shell-команды при сборке' },
  slot:  { label: 'Слот агента', icon: 'chat',     hint: 'память: файл, куда пишет сам агент' },
  group: { label: 'Группа',      icon: 'layers',   hint: 'профиль: включается/выключается целиком' },
};
const OUT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
const SPLIT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md' }; // исходники для «Распилить»
const CTX_MARKER = '<!-- LiteEditorAI:contextgraph'; // шапка наших скомпилированных файлов (синхронно с main.js)
const GROUP_COLORS = ['green', 'info', 'warn', 'danger'];

const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Markdown → безопасный HTML для превью блока. Контент может прийти из чужого CLAUDE.md («Распилить»),
// а preload даёт мощный мост (lite.ctx.runCmd/agent, fs.*) — поэтому вычищаем активный HTML.
// DOMPurify в проекте нет; парсим в инертный <template> (картинки не грузятся, скрипты не исполняются),
// срезаем опасные узлы/атрибуты и переносим уже очищенные ноды в живой элемент.
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
      const val = a.value.replace(/[\u0000-\u0020\-]/g, '').toLowerCase();
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

export function initCtx(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels } = host;

  let open = false;
  let proj = null;       // снапшот {id, path, name} проекта на канве
  let graph = null;
  let sel = null;        // {kind:'node', id} | {kind:'edge', from, to}
  let loadSeq = 0;
  let unsaved = false;   // канва изменена, но не «Подтверждена». Автосохранения НЕТ — правки копятся в памяти
  let pendingDelete = []; // снимки удалённых нод со своими файлами — файлы сотрутся только при «Подтвердить»
  let profiles = null;   // {active, list:[{id,name}]} — набор профилей проекта (метаданные, persist сразу)
  let activeProfile = null; // id активного профиля; граф на канве — его
  const slotBadges = new Set(); // nodeId слотов с непросмотренными записями агента
  let splitSrc = { claude: false, codex: false }; // какие исходники реально есть в проекте

  const canvas = $('#ctx-canvas');
  const world = $('#ctx-world');
  const wiresSvg = $('#ctx-wires');
  const nodesBox = $('#ctx-nodes');
  const profilesBar = $('#ctx-profiles');

  // ---------------------------------------------------------------- граф: модель
  function newGraph() {
    return {
      v: 1,
      nodes: [
        { id: 'out-claude', type: 'out', out: 'claude', title: 'Claude', enabled: true, x: 760, y: 80 },
        { id: 'out-codex', type: 'out', out: 'codex', title: 'Codex', enabled: true, x: 760, y: 320 },
      ],
      edges: [],
      view: { x: 0, y: 0, z: 1 },
      settings: { backupDir: '', backupKeep: 10, autoApply: true, splitAgent: 'claude' },
      dirty: false,
    };
  }
  function normalizeGraph(g) {
    if (!g || !Array.isArray(g.nodes)) return newGraph();
    g.edges = Array.isArray(g.edges) ? g.edges : [];
    g.view = g.view && typeof g.view.z === 'number' ? g.view : { x: 0, y: 0, z: 1 };
    g.settings = { backupDir: '', backupKeep: 10, autoApply: true, splitAgent: 'claude', ...(g.settings || {}) };
    for (const key of ['claude', 'codex']) { // выходы обязаны существовать всегда
      if (!g.nodes.some((n) => n.type === 'out' && n.out === key)) {
        g.nodes.push({ id: 'out-' + key, type: 'out', out: key, title: key === 'claude' ? 'Claude' : 'Codex', enabled: true, x: 760, y: key === 'claude' ? 80 : 320 });
      }
    }
    return g;
  }
  const nodeById = (id) => graph && graph.nodes.find((n) => n.id === id);
  // активный профиль не совпадает с собранным в файлах (профиль переключён, но не «Подтверждён»)
  const appliedMismatch = () => !!(profiles && activeProfile && profiles.applied !== activeProfile);

  // Никакого автосохранения: любая правка лишь помечает канву «неподтверждённой».
  // Запись на диск (graph.json + CLAUDE.md/AGENTS.md) — только по «Подтвердить» (applyCompile).
  function markDirty() { if (graph) { unsaved = true; updateStats(); } }

  // ---------------------------------------------------------------- открытие/закрытие панели
  function setOpen(o, opts = {}) {
    const p = activeProject();
    if (o && !p && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (o === open) { if (o && p) loadGraph(p); return; }
    if (o) closeOtherPanels('ctx');
    const delta = layout.ctx + GUTTER;
    open = o;
    $('#ctx-pane').classList.toggle('hidden', !o);
    $('#gutter-ctx').classList.toggle('hidden', !o);
    if (opts.grow !== false) lite.win.growBy(o ? delta : -delta);
    saveUiState();
    if (o && p) loadGraph(p);
    if (!o && proj) lite.ctx.unwatchSlots(proj.id);
    setTimeout(refitActiveTerminal, 150);
  }
  const toggle = () => setOpen(!open);

  async function loadGraph(p) {
    if (proj && proj.id !== p.id) {
      lite.ctx.unwatchSlots(proj.id);
      if (unsaved) toast('Контекст: неподтверждённые правки прошлого проекта отброшены', { ttl: 6000 });
    }
    proj = { id: p.id, path: p.path, name: p.name };
    const seq = ++loadSeq;
    profiles = await lite.ctx.profiles(p.id);
    if (seq !== loadSeq || !open) return;
    activeProfile = profiles && profiles.active;
    const r = await lite.ctx.load(p.id, activeProfile);
    if (seq !== loadSeq || !open) return;
    graph = normalizeGraph(r && r.graph);
    sel = null;
    unsaved = false;
    pendingDelete = [];
    slotBadges.clear();
    lite.ctx.watchSlots(p.id, p.path);
    renderProfiles();
    renderAll();
    refreshLiveChars(seq); // файлы/слоты: подтянуть актуальные размеры после рендера
    detectSplitSources(); // какие кнопки «✂ распилить» показывать
  }
  // Перезагрузить граф активного профиля (после переключения/создания) — без повторного чтения индекса.
  async function loadActiveGraph() {
    if (!proj) return;
    const seq = ++loadSeq;
    const r = await lite.ctx.load(proj.id, activeProfile);
    if (seq !== loadSeq || !open) return;
    graph = normalizeGraph(r && r.graph);
    sel = null;
    unsaved = false;
    pendingDelete = [];
    slotBadges.clear();
    renderProfiles();
    renderAll();
    refreshLiveChars(seq);
    detectSplitSources();
  }
  // ---------------------------------------------------------------- профили (вкладки над канвой)
  function renderProfiles() {
    if (!profilesBar) return;
    profilesBar.innerHTML = '';
    if (!proj || !profiles) return;
    const multi = profiles.list.length > 1;
    for (const pr of profiles.list) {
      const isApplied = pr.id === profiles.applied;
      const tab = el('div', 'ctx-ptab' + (pr.id === activeProfile ? ' on' : '') + (isApplied ? ' applied' : ''));
      tab.title = pr.name + (isApplied ? ' · применён к файлам' : ' · не применён — нажми «Подтвердить»');
      if (isApplied) { const d = el('span', 'ctx-ptab-dot'); d.title = 'Этот профиль собран в CLAUDE.md/AGENTS.md'; tab.appendChild(d); }
      tab.appendChild(el('span', 'ctx-ptab-name', pr.name));
      const ed = el('span', 'ctx-ptab-ic', '✎');
      ed.title = 'Переименовать';
      ed.addEventListener('click', (e) => { e.stopPropagation(); renameProfile(pr); });
      tab.appendChild(ed);
      if (multi) {
        const x = el('span', 'ctx-ptab-ic ctx-ptab-x', '×');
        x.title = 'Удалить профиль';
        x.addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(pr); });
        tab.appendChild(x);
      }
      tab.addEventListener('click', () => switchProfile(pr.id));
      profilesBar.appendChild(tab);
    }
    const add = el('button', 'ctx-padd', '+');
    add.title = 'Новый профиль';
    add.addEventListener('click', createProfile);
    profilesBar.appendChild(add);
  }
  async function switchProfile(id) {
    if (!proj || id === activeProfile) return;
    const go = async () => {
      const r = await lite.ctx.profileSetActive(proj.id, id);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      profiles = r.profiles; activeProfile = id;
      await loadActiveGraph();
    };
    if (unsaved) showConfirm('Переключить профиль?', 'В текущем профиле есть неподтверждённые изменения — они будут отброшены.', 'Переключить', go);
    else go();
  }
  function createProfile() {
    if (!proj) return;
    showPrompt('Новый профиль', 'Название', '', async (name) => {
      const r = await lite.ctx.profileCreate(proj.id, name);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      profiles = r.profiles; activeProfile = r.id;
      await loadActiveGraph(); // новый профиль — пустой граф (выходы создаст normalizeGraph)
      toast('Профиль создан — настрой канву и нажми «Подтвердить»');
    });
  }
  function renameProfile(pr) {
    if (!proj) return;
    showPrompt('Переименовать профиль', 'Название', pr.name, async (name) => {
      const r = await lite.ctx.profileRename(proj.id, pr.id, name);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      profiles = r.profiles; renderProfiles();
    });
  }
  function deleteProfile(pr) {
    if (!proj || !profiles || profiles.list.length <= 1) return;
    showConfirm('Удалить профиль?', `«${pr.name}» и его канва будут удалены. Контекстные файлы (CLAUDE.md/AGENTS.md) не трогаются.`, 'Удалить', async () => {
      const r = await lite.ctx.profileDelete(proj.id, pr.id);
      if (r && r.error) { toast(r.error, { kind: 'err' }); return; }
      profiles = r.profiles;
      if (activeProfile === pr.id) { activeProfile = profiles.active; await loadActiveGraph(); }
      else renderProfiles();
      toast('Профиль удалён');
    });
  }
  // Детект исходников: CLAUDE.md и AGENTS.md — каждый предлагаем распилить, только если он НЕ наш
  // скомпилированный (иначе предлагали бы распилить собственную сборку — оба файла теперь и выход, и
  // потенциальный исходник). Кнопок столько, сколько подходящих файлов есть.
  async function detectSplitSources() {
    if (!proj) { splitSrc = { claude: false, codex: false }; updateSplitUi(); return; }
    const [cRes, aRes] = await Promise.all([
      lite.fs.readFile(proj.path + '/CLAUDE.md'),
      lite.fs.readFile(proj.path + '/AGENTS.md'),
    ]);
    const own = (res) => !!(res && !res.error && res.content && !res.content.startsWith(CTX_MARKER));
    splitSrc = { claude: own(cRes), codex: own(aRes) };
    updateSplitUi();
  }
  function updateSplitUi() {
    const list = Object.keys(SPLIT_FILES).filter((k) => splitSrc[k]);
    const btn = $('#ctx-split');
    btn.hidden = !list.length;
    btn.title = list.length ? ('Распилить на блоки (локальным агентом): ' + list.map((k) => SPLIT_FILES[k]).join(' / ')) : '';
    const box = $('#ctx-empty-splits');
    box.innerHTML = '';
    for (const k of list) {
      const b = el('button', 'btn primary', '✂ Распилить ' + SPLIT_FILES[k]);
      b.onclick = () => runSplit(k);
      box.appendChild(b);
    }
  }
  function splitClick() {
    const list = Object.keys(SPLIT_FILES).filter((k) => splitSrc[k]);
    if (!list.length) return;
    if (list.length === 1) { runSplit(list[0]); return; }
    const { m, close } = makeModal('<h2>✂ Что распилить?</h2><div id="cxc-list" class="ctx-addlist"></div>');
    const box = m.querySelector('#cxc-list');
    for (const k of list) {
      const row = el('div', 'ctx-addrow');
      const tx = el('div', 'ctx-addtx');
      tx.appendChild(el('div', 'ctx-addlabel', SPLIT_FILES[k]));
      tx.appendChild(el('div', 'ctx-addhint', 'блоки лягут на канву и подключатся к выходу ' + (k === 'claude' ? 'Claude' : 'Codex')));
      row.appendChild(tx);
      row.onclick = () => { close(); runSplit(k); };
      box.appendChild(row);
    }
  }
  // Размеры file/slot-нод честные только на момент последней сборки — освежаем при загрузке.
  async function refreshLiveChars(seq) {
    if (!graph || !proj) return;
    let changed = false;
    for (const n of graph.nodes) {
      if (n.type !== 'file' && n.type !== 'slot') continue;
      const r = await lite.ctx.blockRead(proj.id, proj.path, n);
      if (seq !== loadSeq) return;
      if (r && r.chars !== n.chars) { n.chars = r.chars; changed = true; }
    }
    if (changed) renderAll(); // только освежаем счётчики ≈токенов; на диск не пишем (синк при загрузке)
  }
  function onProjectChange(p) { if (open && p) loadGraph(p); }

  // ---------------------------------------------------------------- геометрия/обходы
  function portPos(n, kind) { return { x: kind === 'out' ? n.x + NODE_W : n.x, y: n.y + PORT_Y }; }
  function wireD(a, b) {
    const dx = Math.max(40, Math.min(140, Math.abs(b.x - a.x) / 2));
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  // Ноды, реально участвующие в сборке (включены сами и достижимы от включённого выхода)
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
  // Источники, питающие конкретный выход (зеркало ctxContributors в main — для счётчиков)
  function contributors(outId) {
    const seen = new Set(); const stack = [outId]; const found = [];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of graph.edges) {
        if (e.to !== cur) continue;
        const src = nodeById(e.from);
        if (!src || !src.enabled) continue;
        if (src.type === 'group') stack.push(src.id);
        else if (!found.includes(src)) found.push(src);
      }
    }
    return found;
  }
  function canConnect(fromId, toId) {
    const a = nodeById(fromId), b = nodeById(toId);
    if (!a || !b || a.id === b.id) return false;
    if (a.type === 'out' || !(b.type === 'group' || b.type === 'out')) return false;
    if (graph.edges.some((e) => e.from === fromId && e.to === toId)) return false;
    const stack = [toId]; const seen = new Set(); // цикл групп: от b по направлению рёбер нельзя дойти до a
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

  // ---------------------------------------------------------------- рендер
  function renderAll() {
    if (!open) return;
    $('#ctx-title').textContent = proj ? `Контекст · ${proj.name}` : 'Контекст';
    if (!proj || !graph) { nodesBox.innerHTML = ''; wiresSvg.innerHTML = ''; if (profilesBar) profilesBar.innerHTML = ''; updateStats(); return; }
    world.style.transform = `translate(${graph.view.x}px, ${graph.view.y}px) scale(${graph.view.z})`;
    renderNodes();
    renderWires();
    updateStats();
    $('#ctx-empty').hidden = graph.nodes.some((n) => n.type !== 'out');
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

    if (n.type === 'group' || isOut) { const p = el('div', 'ctx-port in'); p.dataset.id = n.id; p.title = 'Вход'; box.appendChild(p); }
    if (!isOut) { const p = el('div', 'ctx-port out'); p.dataset.id = n.id; p.title = 'Потяни, чтобы соединить'; box.appendChild(p); }

    const head = el('div', 'ctx-nhead');
    const ic = el('span', 'ctx-nicon');
    ic.appendChild(icon(isOut ? 'power' : NODE_TYPES[n.type].icon, 14));
    head.appendChild(ic);
    const title = el('span', 'ctx-ntitle', n.title || NODE_TYPES[n.type]?.label || '');
    if (n.type === 'text' && String(n.ref || '').startsWith('lib:')) { title.textContent = '📚 ' + title.textContent; title.title = 'Библиотечный блок (общий для проектов)'; }
    head.appendChild(title);
    if (n.type === 'slot' && slotBadges.has(n.id)) { const b = el('span', 'ctx-nbadge'); b.title = 'Агент дописал — открой, чтобы посмотреть'; head.appendChild(b); }
    const sw = el('button', 'ctx-switch' + (n.enabled ? ' on' : ''));
    sw.title = n.enabled ? 'Выключить' : 'Включить';
    sw.appendChild(el('span', 'ctx-knob'));
    sw.addEventListener('click', (e) => { e.stopPropagation(); n.enabled = !n.enabled; markDirty(); renderAll(); });
    head.appendChild(sw);
    box.appendChild(head);

    const body = el('div', 'ctx-nbody');
    if (isOut) {
      body.appendChild(el('div', 'ctx-nfile', OUT_FILES[n.out]));
      const c = contributors(n.id);
      const total = c.reduce((s, x) => s + (x.chars || 0), 0);
      body.appendChild(el('div', 'ctx-nmeta', c.length ? `${c.length} блок(а) · ${fmtTok(total)}` : 'ничего не подключено'));
    } else if (n.type === 'group') {
      const inn = graph.edges.filter((e) => e.to === n.id).length;
      body.appendChild(el('div', 'ctx-nmeta', inn ? `${inn} вход(а)` : 'пустая группа'));
    } else {
      const meta = el('div', 'ctx-nmeta', fmtTok(n.chars || 0));
      if (n.type === 'file') meta.textContent = (n.ref || 'путь не задан') + ' · ' + fmtTok(n.chars || 0);
      if (n.type === 'cmd') meta.textContent = '$ ' + (n.cmd ? (n.cmd.length > 22 ? n.cmd.slice(0, 22) + '…' : n.cmd) : '—');
      body.appendChild(meta);
    }
    box.appendChild(body);

    // Двойной клик НЕ вешаем на элемент: первый клик выделяет ноду → renderAll пересоздаёт DOM,
    // и нативный dblclick не срабатывает (второй клик уже по новому элементу). Двойной клик
    // ловим вручную в pointerup по id ноды (см. ниже).
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
      p.dataset.from = e.from; p.dataset.to = e.to; // выбор/удаление провода ловим в pointerup (DOM пересоздаётся)
      wiresSvg.appendChild(p);
    }
  }
  function updateStats() {
    const bar = $('#ctx-stats');
    if (!bar) return;
    bar.innerHTML = '';
    const mismatch = appliedMismatch();
    $('#ctx-stale').hidden = !(unsaved || mismatch);
    { const rb = $('#ctx-reset'); if (rb) rb.hidden = !unsaved; }
    { const ab = $('#ctx-apply'); if (ab) ab.classList.toggle('hot', unsaved || mismatch); }
    if (!graph || !proj) return;
    for (const key of ['claude', 'codex']) {
      const o = graph.nodes.find((n) => n.type === 'out' && n.out === key);
      if (!o) continue;
      const total = o.enabled ? contributors(o.id).reduce((s, x) => s + (x.chars || 0), 0) : 0;
      const chip = el('span', 'ctx-chip' + (o.enabled ? '' : ' off'));
      chip.appendChild(el('b', null, o.title));
      chip.appendChild(el('span', null, o.enabled ? fmtTok(total) : 'выкл'));
      chip.title = OUT_FILES[key];
      bar.appendChild(chip);
    }
    if (unsaved) bar.appendChild(el('span', 'ctx-chip warn', 'есть неподтверждённые изменения — нажми «Подтвердить»'));
    else if (mismatch) bar.appendChild(el('span', 'ctx-chip warn', 'этот профиль не применён к файлам — нажми «Подтвердить»'));
  }

  // ---------------------------------------------------------------- мутации
  function addNode(type, extra = {}) {
    const c = screenCenterWorld();
    const n = {
      id: uid(), type, title: extra.title || NODE_TYPES[type].label, enabled: true,
      x: Math.round(c.x - NODE_W / 2 + (Math.random() * 40 - 20)), y: Math.round(c.y - 40 + (Math.random() * 40 - 20)),
      chars: 0, ...extra,
    };
    if (type === 'cmd' && n.timeout == null) n.timeout = 10000;
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
    // ФАЙЛ блока НЕ удаляем сейчас — удаление обратимо до «Подтвердить». Свои файлы (локальный
    // текст/слот) помечаем к удалению; реально сотрутся в applyCompile после успешной сборки.
    const own = (n.type === 'text' && !String(n.ref || '').startsWith('lib:')) || n.type === 'slot';
    if (own) pendingDelete.push({ ...n });
    markDirty();
    renderAll();
  }
  function deleteSelection() {
    if (!sel || !graph) return;
    if (sel.kind === 'edge') { removeEdge(sel.from, sel.to); return; }
    const n = nodeById(sel.id);
    if (!n) return;
    if (n.type === 'out') { toast('Ноды-выходы удалить нельзя — их можно выключить'); return; }
    // удаление всегда с подтверждением, но обратимое: файл цел до «Подтвердить», вернуть — «Сбросить»
    showConfirm('Удалить блок?', `«${n.title}» убрать с канвы. Файл не удаляется, пока не нажмёшь «Подтвердить» — до этого удаление можно откатить кнопкой «Сбросить».`, 'Удалить', () => removeNode(n));
  }
  async function duplicateSelection() {
    if (!sel || sel.kind !== 'node') return;
    const n = nodeById(sel.id);
    if (!n || n.type === 'out') return;
    const copy = { ...n, id: uid(), x: n.x + 24, y: n.y + 24, title: n.title + ' (копия)' };
    if (n.type === 'text' && !String(n.ref || '').startsWith('lib:')) {
      const r = await lite.ctx.blockRead(proj.id, proj.path, n);
      await lite.ctx.blockWrite(proj.id, proj.path, copy, (r && r.text) || '');
    }
    graph.nodes.push(copy);
    sel = { kind: 'node', id: copy.id };
    markDirty();
    renderAll();
  }

  // ---------------------------------------------------------------- интеракции канвы
  let drag = null; // {kind:'pan'|'node'|'wire', ...}
  let tempWire = null;
  let clickTrack = { id: null, t: 0 };     // ручной детект двойного клика по ноде (id + timeStamp)
  let clickTrackEdge = { key: null, t: 0 }; // то же для проводов (from>to + timeStamp)
  function worldPoint(e) {
    const r = canvas.getBoundingClientRect();
    const v = graph.view;
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !graph) return;
    if (e.target.closest('.ctx-switch') || e.target.closest('button')) return;
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
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const wireEl = e.target.closest('.ctx-wire');
    if (wireEl && wireEl.dataset.from) { // клик по проводу — выбор/удаление (в pointerup)
      drag = { kind: 'edge', from: wireEl.dataset.from, to: wireEl.dataset.to, moved: false };
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
      const n = nodeById(drag.id);
      if (!n) return;
      n.x = Math.round(drag.nx + dx);
      n.y = Math.round(drag.ny + dy);
      drag.el.style.left = n.x + 'px';
      drag.el.style.top = n.y + 'px';
      renderWires();
    } else if (drag.kind === 'wire') {
      const a = portPos(nodeById(drag.from), 'out');
      const m = worldPoint(e);
      tempWire.setAttribute('d', wireD(a, m));
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const hit = t && t.closest && t.closest('.ctx-port.in');
      document.querySelectorAll('.ctx-port.in.hot').forEach((x) => x.classList.remove('hot'));
      if (hit && canConnect(drag.from, hit.dataset.id)) hit.classList.add('hot');
    } else if (drag.kind === 'edge') {
      drag.moved = true; // потянули за провод — это не клик, ничего не делаем на отпускании
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
      if (drag.moved) { markDirty(); renderAll(); } // порядок склейки зависит от y — это содержательное изменение
      else {
        // чистый клик по ноде: второй клик по той же ноде за ≤350 мс — открыть модалку (ручной dblclick)
        const now = e.timeStamp || 0;
        if (clickTrack.id === drag.id && (now - clickTrack.t) < 350) {
          clickTrack = { id: null, t: 0 };
          const n = nodeById(drag.id);
          if (n) openNodeModal(n);
        } else {
          clickTrack = { id: drag.id, t: now };
          sel = { kind: 'node', id: drag.id };
          renderAll();
        }
      }
    } else if (drag.kind === 'edge') {
      if (!drag.moved) {
        const key = drag.from + '>' + drag.to, now = e.timeStamp || 0;
        if (clickTrackEdge.key === key && (now - clickTrackEdge.t) < 350) {
          clickTrackEdge = { key: null, t: 0 };
          removeEdge(drag.from, drag.to); // двойной клик по проводу — удалить
        } else {
          clickTrackEdge = { key, t: now };
          sel = { kind: 'edge', from: drag.from, to: drag.to };
          renderAll();
        }
      }
    } else if (drag.kind === 'pan') {
      if (!drag.moved) { sel = null; renderAll(); } // чистый пан — вид не пишем до «Подтвердить»
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    if (!graph) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const v = graph.view;
    const oldZ = v.z;
    v.z = Math.max(0.35, Math.min(2, v.z * Math.pow(1.0015, -e.deltaY)));
    v.x = mx - (mx - v.x) * (v.z / oldZ);
    v.y = my - (my - v.y) * (v.z / oldZ);
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  }, { passive: false }); // зум — вид не пишем до «Подтвердить»
  document.addEventListener('keydown', (e) => {
    if (!open || !graph) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && (t.closest('.modal-overlay') || t.closest('.cm-editor'))) return;
    if (e.key === 'Delete') { e.preventDefault(); deleteSelection(); }
    else if (e.ctrlKey && e.code === 'KeyD' && sel && sel.kind === 'node') { e.preventDefault(); duplicateSelection(); }
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
  function modalShell(n, innerHtml, onClose) {
    const tp = n.type === 'out' ? { label: n.title, icon: 'power' } : NODE_TYPES[n.type];
    const md = makeModal(`
      <div class="ctx-mhead">
        <span class="ctx-mtype"></span>
        <input type="text" id="cxm-title" class="ctx-mtitle" placeholder="Название блока" autocomplete="off" spellcheck="false">
      </div>
      ${innerHtml}`, onClose);
    md.m.classList.add('ctx-modal');
    const typeEl = md.m.querySelector('.ctx-mtype');
    typeEl.appendChild(icon(tp.icon, 15));
    typeEl.appendChild(el('span', null, tp.label));
    const titleInp = md.m.querySelector('#cxm-title');
    titleInp.value = n.title || '';
    return { ...md, titleInp };
  }
  function openNodeModal(n) {
    if (n.type === 'text') return modalText(n);
    if (n.type === 'file') return modalFile(n);
    if (n.type === 'cmd') return modalCmd(n);
    if (n.type === 'slot') return modalSlot(n);
    if (n.type === 'group') return modalGroup(n);
    if (n.type === 'out') return modalSettings();
  }

  async function modalText(n) {
    const isLib = String(n.ref || '').startsWith('lib:');
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
        <span id="cxm-libinfo" class="ctx-mchars ctx-mfull"></span>
        <div class="drag-space-static"></div>
        <button class="btn" id="cxm-lib" ${isLib ? 'hidden' : ''}>📚 В библиотеку</button>
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Отмена</button>
        <button class="btn primary" id="cxm-save">Сохранить</button>
      </div>`, () => { if (editor) editor.destroy(); });
    const charsEl = md.m.querySelector('#cxm-chars');
    const r = await lite.ctx.blockRead(proj.id, proj.path, n);
    editor = makeMdEditor(md.m.querySelector('#cxm-ed'), (r && r.text) || '', (len) => { charsEl.textContent = fmtTok(len); });
    charsEl.textContent = fmtTok((r && r.chars) || 0);
    // переключатель «Редактировать ↔ Просмотр»: просмотр рендерит текущий markdown редактора в HTML
    const edBox = md.m.querySelector('#cxm-ed');
    const prevBox = md.m.querySelector('#cxm-prev');
    const setMode = (view) => {
      if (view) renderSafeMarkdown(prevBox, editor.state.doc.toString());
      edBox.hidden = view; prevBox.hidden = !view;
      md.m.querySelector('#cxm-mode-view').classList.toggle('on', view);
      md.m.querySelector('#cxm-mode-edit').classList.toggle('on', !view);
      if (!view && editor.requestMeasure) editor.requestMeasure(); // CodeMirror корректно перемерит после показа
    };
    md.m.querySelector('#cxm-mode-edit').onclick = () => setMode(false);
    md.m.querySelector('#cxm-mode-view').onclick = () => setMode(true);
    if (isLib) {
      const u = await lite.ctx.libUsage(String(n.ref).slice(4));
      md.m.querySelector('#cxm-libinfo').textContent = `📚 общий блок · используется в ${u.count || 0} месте(ах) — правка применится везде`;
    }
    const save = async () => {
      const text = editor.state.doc.toString();
      n.title = md.titleInp.value.trim() || 'Текст';
      const w = await lite.ctx.blockWrite(proj.id, proj.path, n, text);
      if (w && w.error) { toast(w.error, { kind: 'err' }); return; }
      n.chars = w.chars || 0;
      if (isLib) lite.ctx.libSave({ id: String(n.ref).slice(4), title: n.title }); // заголовок — и в индекс библиотеки
      markDirty(); renderAll(); md.close();
    };
    md.m.querySelector('#cxm-save').onclick = save;
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
    md.m.querySelector('#cxm-lib').onclick = async () => {
      const text = editor.state.doc.toString();
      const title = md.titleInp.value.trim() || n.title;
      const lr = await lite.ctx.libSave({ title, text });
      if (lr && lr.error) { toast(lr.error, { kind: 'err' }); return; }
      // старый локальный файл НЕ удаляем сразу — иначе «Сбросить» вернул бы ноду к пустому файлу.
      // Снимок (ещё не-библиотечный) в очередь — сотрётся на «Подтвердить».
      pendingDelete.push({ ...n });
      n.ref = 'lib:' + lr.id;
      n.title = title;
      n.chars = text.length;
      markDirty(); renderAll(); md.close();
      toast('Блок перенесён в библиотеку — теперь его можно воткнуть в другие проекты');
    };
  }

  function modalFile(n) {
    const md = modalShell(n, `
      <div class="field"><label>Путь к файлу (относительно корня проекта)</label>
        <input type="text" id="cxm-path" autocomplete="off" spellcheck="false" placeholder="docs/RULES.md"></div>
      <div id="cxm-fstat" class="ctx-mchars"></div>
      <div class="ctx-mfoot">
        <div class="drag-space-static"></div>
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Отмена</button>
        <button class="btn primary" id="cxm-save">Сохранить</button>
      </div>`);
    const pathInp = md.m.querySelector('#cxm-path');
    const stat = md.m.querySelector('#cxm-fstat');
    pathInp.value = n.ref || '';
    let checkTimer = null;
    const check = async () => {
      const ref = pathInp.value.trim();
      if (!ref) { stat.textContent = ''; return; }
      const r = await lite.ctx.blockRead(proj.id, proj.path, { type: 'file', id: n.id, ref });
      stat.textContent = r && r.exists ? `✓ найден · ${fmtTok(r.chars)} (содержимое подтягивается живым при каждой сборке)` : '✗ файл не найден';
      stat.classList.toggle('err', !(r && r.exists));
    };
    pathInp.addEventListener('input', () => { clearTimeout(checkTimer); checkTimer = setTimeout(check, 350); });
    check();
    md.m.querySelector('#cxm-save').onclick = async () => {
      n.ref = pathInp.value.trim();
      n.title = md.titleInp.value.trim() || (n.ref ? n.ref.split('/').pop() : 'Файл');
      const r = await lite.ctx.blockRead(proj.id, proj.path, n);
      n.chars = (r && r.chars) || 0;
      markDirty(); renderAll(); md.close();
    };
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
  }

  function modalCmd(n) {
    const md = modalShell(n, `
      <div class="field"><label>Shell-команда (выполняется в корне проекта при каждой сборке)</label>
        <input type="text" id="cxm-cmd" class="ctx-mono" autocomplete="off" spellcheck="false" placeholder="git log --oneline -5"></div>
      <div class="field"><label>Таймаут</label>
        <select id="cxm-to"><option value="5000">5 сек</option><option value="10000">10 сек</option><option value="30000">30 сек</option><option value="60000">60 сек</option></select></div>
      <button class="btn" id="cxm-run">▶ Выполнить (превью)</button>
      <pre id="cxm-out" class="ctx-cmdout" hidden></pre>
      <div class="ctx-mfoot">
        <span id="cxm-chars" class="ctx-mchars"></span>
        <div class="drag-space-static"></div>
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Отмена</button>
        <button class="btn primary" id="cxm-save">Сохранить</button>
      </div>`);
    const cmdInp = md.m.querySelector('#cxm-cmd');
    const toSel = md.m.querySelector('#cxm-to');
    const out = md.m.querySelector('#cxm-out');
    const charsEl = md.m.querySelector('#cxm-chars');
    cmdInp.value = n.cmd || '';
    toSel.value = String(n.timeout || 10000);
    charsEl.textContent = fmtTok(n.chars || 0);
    md.m.querySelector('#cxm-run').onclick = async (e) => {
      const btn = e.currentTarget;
      if (!cmdInp.value.trim()) return;
      btn.disabled = true;
      const r = await lite.ctx.runCmd(proj.path, cmdInp.value.trim(), parseInt(toSel.value, 10));
      btn.disabled = false;
      out.hidden = false;
      out.textContent = r.error ? ('⚠ ' + r.error + (r.out ? '\n' + r.out : '')) : (r.out || '(пустой вывод)');
      charsEl.textContent = fmtTok(r.chars || 0) + ` · ${r.ms || 0} мс`;
    };
    md.m.querySelector('#cxm-save').onclick = () => {
      n.cmd = cmdInp.value.trim();
      n.timeout = parseInt(toSel.value, 10);
      n.title = md.titleInp.value.trim() || 'Команда';
      markDirty(); renderAll(); md.close();
    };
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
  }

  async function modalSlot(n) {
    let editor = null;
    const md = modalShell(n, `
      <div class="ctx-mchars">Файл <code>.lite/ctx-slot-${n.id}.md</code> — агент дописывает сюда сам (инструкция добавляется в собранный контекст).</div>
      <div id="cxm-new" class="ctx-slotnew" hidden></div>
      <div id="cxm-ed" class="ctx-med"></div>
      <label class="ctx-mcheck"><input type="checkbox" id="cxm-instruct"> добавлять агенту инструкцию «веди память» при сборке</label>
      <div class="ctx-mfoot">
        <span id="cxm-chars" class="ctx-mchars"></span>
        <div class="drag-space-static"></div>
        <button class="btn" id="cxm-seen">Просмотрено</button>
        <button class="btn" id="cxm-clear">Очистить</button>
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Отмена</button>
        <button class="btn primary" id="cxm-save">Сохранить</button>
      </div>`, () => { if (editor) editor.destroy(); });
    const charsEl = md.m.querySelector('#cxm-chars');
    const [r, seenR] = await Promise.all([lite.ctx.blockRead(proj.id, proj.path, n), lite.ctx.seenRead(proj.id, n.id)]);
    const cur = (r && r.text) || '';
    const seen = (seenR && seenR.text) || '';
    editor = makeMdEditor(md.m.querySelector('#cxm-ed'), cur, (len) => { charsEl.textContent = fmtTok(len); });
    charsEl.textContent = fmtTok(cur.length);
    md.m.querySelector('#cxm-instruct').checked = n.instruct !== false;
    if (cur !== seen) { // что нового с прошлого просмотра
      const box = md.m.querySelector('#cxm-new');
      box.hidden = false;
      const tail = cur.startsWith(seen) ? cur.slice(seen.length).trim() : '';
      box.appendChild(el('div', 'ctx-slotnew-t', '🔔 Новое с прошлого просмотра:'));
      box.appendChild(el('pre', null, tail || '(содержимое менялось — смотри полный текст ниже)'));
    }
    const markSeen = async () => { await lite.ctx.slotSeen(proj.id, proj.path, n.id); slotBadges.delete(n.id); renderAll(); };
    md.m.querySelector('#cxm-seen').onclick = async () => { await markSeen(); md.m.querySelector('#cxm-new').hidden = true; toast('Отмечено просмотренным'); };
    md.m.querySelector('#cxm-clear').onclick = () => showConfirm('Очистить слот?', 'Память агента в этом блоке будет стёрта.', 'Очистить', async () => {
      await lite.ctx.blockWrite(proj.id, proj.path, n, '');
      await markSeen();
      n.chars = 0;
      markDirty(); md.close();
    });
    md.m.querySelector('#cxm-save').onclick = async () => {
      const text = editor.state.doc.toString();
      n.title = md.titleInp.value.trim() || 'Слот агента';
      n.instruct = md.m.querySelector('#cxm-instruct').checked;
      const w = await lite.ctx.blockWrite(proj.id, proj.path, n, text);
      n.chars = (w && w.chars) || 0;
      await markSeen();
      markDirty(); renderAll(); md.close();
    };
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
  }

  function modalGroup(n) {
    const md = modalShell(n, `
      <div class="field"><label>Цвет группы</label><div id="cxm-colors" class="ctx-colors"></div></div>
      <div class="ctx-mchars">Группа — профиль контекста: тумблер включает/выключает всю ветку, провода остаются.</div>
      <div class="ctx-mfoot">
        <div class="drag-space-static"></div>
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Отмена</button>
        <button class="btn primary" id="cxm-save">Сохранить</button>
      </div>`);
    const colorsBox = md.m.querySelector('#cxm-colors');
    let picked = n.color || 'green';
    for (const c of GROUP_COLORS) {
      const sw = el('button', 'ctx-color g-' + c + (picked === c ? ' on' : ''));
      sw.onclick = () => { picked = c; colorsBox.querySelectorAll('.ctx-color').forEach((x) => x.classList.remove('on')); sw.classList.add('on'); };
      colorsBox.appendChild(sw);
    }
    md.m.querySelector('#cxm-save').onclick = () => {
      n.title = md.titleInp.value.trim() || 'Группа';
      n.color = picked;
      markDirty(); renderAll(); md.close();
    };
    md.m.querySelector('#cxm-cancel').onclick = md.close;
    md.m.querySelector('#cxm-del').onclick = () => { md.close(); sel = { kind: 'node', id: n.id }; deleteSelection(); };
  }

  // ---------------------------------------------------------------- настройки (бекапы и пр.)
  async function modalSettings() {
    const s = graph.settings;
    const { m, close } = makeModal(`
      <h2>Контекст — настройки</h2>
      <div class="field"><label>Папка бекапов (пусто = context_project_bkp в корне проекта)</label>
        <div class="ctx-row"><input type="text" id="cxs-dir" autocomplete="off" spellcheck="false">
        <button class="btn" id="cxs-pick">…</button><button class="btn" id="cxs-open" title="Открыть папку бекапов">📂</button></div></div>
      <div class="field"><label>Сколько бекапов хранить (на каждый файл)</label>
        <input type="number" id="cxs-keep" min="1" max="100"></div>
      <label class="ctx-mcheck"><input type="checkbox" id="cxs-auto"> при открытии новой вкладки-терминала собрать контекст, если файл-выход отсутствует</label>
      <div class="field"><label>Агент для «Распилить CLAUDE.md»</label>
        <select id="cxs-agent"><option value="claude">claude</option><option value="codex">codex</option></select></div>
      <div class="modal-actions"><button class="btn" id="cxs-cancel">Отмена</button><button class="btn primary" id="cxs-save">Сохранить</button></div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxs-dir').value = s.backupDir || '';
    m.querySelector('#cxs-dir').placeholder = proj ? proj.path + '/context_project_bkp' : 'context_project_bkp';
    m.querySelector('#cxs-keep').value = s.backupKeep || 10;
    m.querySelector('#cxs-auto').checked = s.autoApply !== false;
    m.querySelector('#cxs-agent').value = s.splitAgent || 'claude';
    m.querySelector('#cxs-pick').onclick = async () => { const d = await lite.pickDir(); if (d) m.querySelector('#cxs-dir').value = d; };
    m.querySelector('#cxs-open').onclick = async () => {
      const r = await lite.ctx.backupDir(proj.path, m.querySelector('#cxs-dir').value.trim() || null);
      if (r && r.dir) lite.openInFileManager(r.dir);
    };
    m.querySelector('#cxs-cancel').onclick = close;
    // Настройки сохраняем СРАЗУ, но в изоляции от неподтверждённых правок канвы: читаем граф с диска,
    // подменяем только settings и пишем обратно. Тогда «Сбросить» откатит канву, а папку/глубину
    // бекапов и выбранного агента сохранит. На диск канвы это правки не коммитит.
    const persistSettings = async () => {
      const disk = await lite.ctx.load(proj.id, activeProfile);
      const dg = normalizeGraph(disk && disk.graph);
      dg.settings = { ...dg.settings, ...s };
      await lite.ctx.save(proj.id, dg, activeProfile);
    };
    m.querySelector('#cxs-save').onclick = async () => {
      const oldDir = s.backupDir || '';
      const newDir = m.querySelector('#cxs-dir').value.trim();
      s.backupKeep = Math.max(1, Math.min(100, parseInt(m.querySelector('#cxs-keep').value, 10) || 10));
      s.autoApply = m.querySelector('#cxs-auto').checked;
      s.splitAgent = m.querySelector('#cxs-agent').value;
      if (newDir !== oldDir) {
        // переезд: все *.bak из старой папки (или дефолтной в проекте) — в новую, пустая старая удаляется
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

  // ---------------------------------------------------------------- меню добавления / библиотека
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
      row.onclick = () => { close(); const n = addNode(type); if (type !== 'group') openNodeModal(n); };
      list.appendChild(row);
    }
    const lib = el('div', 'ctx-addrow');
    const li = el('span', 'ctx-nicon'); li.textContent = '📚'; lib.appendChild(li);
    const ltx = el('div', 'ctx-addtx');
    ltx.appendChild(el('div', 'ctx-addlabel', 'Из библиотеки'));
    ltx.appendChild(el('div', 'ctx-addhint', 'общие блоки, расшаренные между проектами'));
    lib.appendChild(ltx);
    lib.onclick = () => { close(); showLibrary(); };
    list.appendChild(lib);
  }
  async function showLibrary() {
    const { m, close } = makeModal('<h2>📚 Библиотека блоков</h2><div id="cxl-list" class="ctx-addlist"></div>');
    m.classList.add('ctx-modal');
    const list = m.querySelector('#cxl-list');
    const r = await lite.ctx.libList();
    const items = (r && r.items) || [];
    if (!items.length) { list.appendChild(el('div', 'ctx-addhint', 'Пусто. Открой текстовый блок и нажми «В библиотеку» — он станет общим.')); return; }
    for (const b of items) {
      const row = el('div', 'ctx-addrow');
      const tx = el('div', 'ctx-addtx');
      tx.appendChild(el('div', 'ctx-addlabel', '📚 ' + b.title));
      tx.appendChild(el('div', 'ctx-addhint', fmtTok(b.chars)));
      row.appendChild(tx);
      const del = el('button', 'btn danger-btn ctx-libdel', '✕');
      del.title = 'Удалить из библиотеки';
      del.onclick = async (e) => {
        e.stopPropagation();
        const u = await lite.ctx.libUsage(b.id);
        showConfirm('Удалить из библиотеки?', `«${b.title}» используется в ${u.count || 0} месте(ах) — там блоки опустеют.`, 'Удалить', async () => {
          await lite.ctx.libDelete(b.id);
          close(); showLibrary();
        });
      };
      row.appendChild(del);
      row.onclick = () => { close(); addNode('text', { title: b.title, ref: 'lib:' + b.id, chars: b.chars }); };
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- Подтвердить (сохранить + собрать)
  // Единственный путь записи на диск: фиксируем граф (graph.json) и пересобираем CLAUDE.md/AGENTS.md
  // (со старым файлом в бекап). После успеха канва считается «подтверждённой» (unsaved=false).
  async function applyCompile(opts = {}) {
    if (!proj || !graph) return;
    const btn = $('#ctx-apply');
    btn.disabled = true;
    await lite.ctx.save(proj.id, graph, activeProfile); // компилятор читает граф с диска — сначала зафиксировать
    const r = await lite.ctx.compile({ projId: proj.id, projPath: proj.path, force: !!opts.force, profileId: activeProfile });
    btn.disabled = false;
    if (!r || r.error) { toast((r && r.error) || 'ошибка сборки', { kind: 'err', ttl: 8000 }); return; }
    if (r.graph) { graph = normalizeGraph(r.graph); renderAll(); }
    if (r.conflicts && r.conflicts.length && !opts.force) {
      showConfirm('Файл создан не LiteEditor', `${r.conflicts.join(' и ')} уже существует и не похож на наш. Забекапить и заменить?`, 'Забекапить и заменить', () => applyCompile({ force: true }));
      return; // unsaved остаётся true — изменения ещё не применены полностью
    }
    unsaved = false;
    if (profiles) { profiles.applied = r.applied || activeProfile; renderProfiles(); } // этот профиль теперь в файлах
    // теперь удаления применены окончательно — стираем файлы удалённых блоков и старые локальные файлы
    // нод, ушедших в библиотеку. Удаляем, только если текущий граф больше НЕ владеет этим файлом
    // (нода удалена ИЛИ перестала быть локальным текстом/слотом — напр. стала библиотечной).
    const ownsFile = (x) => (x.type === 'text' && !String(x.ref || '').startsWith('lib:')) || x.type === 'slot';
    for (const dn of pendingDelete) {
      if (!graph.nodes.some((x) => x.id === dn.id && ownsFile(x))) { try { lite.ctx.blockDelete(proj.id, proj.path, dn); } catch (_) {} }
    }
    pendingDelete = [];
    updateStats();
    const parts = r.results.map((x) => `${x.file} ${fmtTok(x.chars)}${x.wrote ? (x.backup ? ` (бекап: ${x.backup})` : '') : ' — без изменений'}`);
    if (!parts.length) parts.push('нечего собирать — подключи блоки к выходам');
    for (const err of (r.errors || [])) toast(err, { kind: 'err', ttl: 8000 });
    const bdir = (r.results.find((x) => x.bdir) || {}).bdir;
    toast('Контекст: ' + parts.join(' · ') + (bdir ? ` · бекапы в ${bdir}` : ''), { ttl: 8000 });
    detectSplitSources(); // сборка могла перезаписать чужой AGENTS.md нашим — кнопки распила пересчитать
  }
  // Сбросить: вернуть канву к последнему подтверждённому виду (перечитать graph.json с диска).
  // Файлы блоков (тексты/слоты) и контекстные файлы не трогаем — откатывается только граф канвы.
  async function resetGraph() {
    if (!proj || !graph || !unsaved) return;
    showConfirm('Сбросить изменения?', 'Канва вернётся к последнему подтверждённому виду. Неподтверждённые правки (расположение, добавленные/удалённые блоки и провода) будут отброшены.', 'Сбросить', async () => {
      const r = await lite.ctx.load(proj.id, activeProfile);
      graph = normalizeGraph(r && r.graph);
      sel = null;
      unsaved = false;
      pendingDelete = []; // удаления откатываются — файлы блоков мы не трогали, они на месте
      renderAll();
      toast('Изменения сброшены');
    });
  }
  // Хук из createSession (новая вкладка-терминала). Без автосохранения новая модель «Подтвердить»
  // делает автосборку безопасной и узкой: собираем сам подтверждённый граф ТОЛЬКО если файла-выхода
  // ещё нет на диске (свежий клон / файл удалён). Существующий контекст молча не перезаписываем,
  // неподтверждённую активную канву не трогаем — иначе потеряли бы правки пользователя.
  async function autoApply(p) {
    try {
      if (proj && p.id === proj.id && unsaved) return; // активная канва с неподтверждёнными правками — не лезем
      const r0 = await lite.ctx.load(p.id);
      const g = r0 && r0.graph;
      if (!g || (g.settings && g.settings.autoApply === false)) return;
      if (!(g.nodes || []).some((n) => n.type !== 'out')) return;
      let needBuild = false; // есть ли включённый выход, чей файл отсутствует
      for (const key of ['claude', 'codex']) {
        const o = (g.nodes || []).find((n) => n.type === 'out' && n.out === key);
        if (!o || !o.enabled) continue;
        if (!(await lite.fs.exists(p.path + '/' + OUT_FILES[key]))) { needBuild = true; break; }
      }
      if (!needBuild) return;
      const r = await lite.ctx.compile({ projId: p.id, projPath: p.path });
      if (r && r.ok && proj && p.id === proj.id && open && !unsaved) {
        graph = normalizeGraph(r.graph);
        if (profiles && r.applied) { profiles.applied = r.applied; renderProfiles(); } // индикатор «применён» — в синке
        renderAll();
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------- справка для пользователя
  function showHelp() {
    const { m, close } = makeModal(`
      <h2>Как работает «Контекст»</h2>
      <div class="ctx-help">
        <p><b>Зачем это.</b> Агент в терминале (Claude Code, Codex) при старте сессии читает файл контекста —
        <b>CLAUDE.md</b> или <b>AGENTS.md</b> в корне проекта. Этот модуль собирает такой файл из «кубиков»
        на канве: видно, чем кормится агент, сколько это весит в токенах, и можно одним тумблером менять набор
        под задачу — не редактируя файлы руками.</p>
        <p><b>Типы блоков</b> (кнопка «+» в шапке или на пустой канве):</p>
        <ul>
          <li><b>📄 Текст</b> — обычный markdown: правила проекта, договорённости, стиль кода. Пишете сами, редактируется двойным кликом.</li>
          <li><b>🔗 Файл</b> — живая ссылка на файл проекта (например <code>docs/RULES.md</code>): при каждой сборке подтягивается свежее содержимое, копий нет.</li>
          <li><b>⚡ Команда</b> — shell-команда, её вывод вставляется в контекст при каждой сборке. Например <code>git log --oneline -5</code> — агент всегда видит последние коммиты.</li>
          <li><b>💬 Слот агента</b> — «память проекта»: файл, куда агент сам дописывает важные решения по ходу работы (инструкция об этом добавляется в контекст автоматически). Когда агент что-то записал — на блоке загорается жёлтая точка, двойной клик покажет, что нового.</li>
          <li><b>▦ Группа</b> — профиль: соедините в неё несколько блоков и включайте/выключайте всю тему одним тумблером. Например группы «Релиз», «Отладка», «Документация» — включаете ту, над чем работаете.</li>
        </ul>
        <p><b>Провода.</b> Зажмите мышку на правой точке блока и тяните к левой точке группы или выхода.
        Блок, подключённый к выходу <b>напрямую</b> — постоянный контекст (идёт всегда); <b>через группу</b> —
        ситуативный (идёт, пока группа включена). Тумблер выключает блок, не разрывая провод — как в n8n.
        Клик по проводу выделяет его, Del или двойной клик — удаляет.</p>
        <p><b>Выходы.</b> Справа две ноды: <b>Claude</b> → CLAUDE.md, <b>Codex</b> → AGENTS.md.
        Один блок можно провести в оба выхода. На каждом выходе видно, сколько блоков подключено и сколько
        ≈токенов получит агент. Ненужный выход можно выключить тумблером.</p>
        <p><b>✓ Подтвердить / ↺ Сбросить.</b> Автосохранения нет — правки на канве копятся, пока вы их не
        подтвердите. <b>«Подтвердить» (✓)</b> сохраняет канву и пересобирает <code>CLAUDE.md</code> /
        <code>AGENTS.md</code> в корне проекта; старый файл перед перезаписью бекапится в
        <code>context_project_bkp</code> (папку и число копий — в ⚙). Файл, созданный не модулем, без вашего
        согласия не перезаписывается. <b>«Сбросить» (↺)</b> откатывает канву к последнему подтверждённому виду.
        Жёлтая точка у заголовка = есть неподтверждённые изменения; на уже запущенного агента они не подействуют —
        только на новые сессии.</p>
        <p><b>✂ Распилить.</b> Если в проекте есть ваш <b>CLAUDE.md</b> или <b>AGENTS.md</b> (не наша сборка) —
        локальный агент сам разложит его на блоки и группы на канву. Исходный файл не меняется и дополнительно
        бекапится; результат появится на канве — проверьте и нажмите «Подтвердить».</p>
        <p><b>Канва.</b> Колесо — зум · перетаскивание фона — перемещение · двойной клик по блоку —
        редактирование · клик — выделить · Del — удалить · Ctrl+D — дублировать.</p>
        <p><b>📚 Библиотека.</b> В модалке текстового блока есть «В библиотеку» — блок становится общим:
        его можно вставить в канвы других проектов («+» → «Из библиотеки»), правка применится везде.</p>
      </div>
      <div class="modal-actions"><button class="btn primary" id="cxh-ok">Понятно</button></div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxh-ok').onclick = close;
  }

  // ---------------------------------------------------------------- «Распилить» (CLAUDE.md / AGENTS.md)
  function extractJson(text) {
    let s = String(text || '').trim();
    // fence-стрип ТОЛЬКО если ответ начинается с ограждения: внутри строк JSON легально живут
    // ```-блоки из исходного markdown, и жадный regex по всему ответу вырезал бы кусок ИЗНУТРИ
    // JSON (реальный баг первого релиза — распил падал на любом CLAUDE.md с код-блоками)
    if (s.startsWith('```')) {
      const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
      if (fence) s = fence[1].trim();
      else s = s.replace(/^```(?:json)?\s*/, '');
    }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    // модели иногда оставляют висячие запятые — чиним и пробуем ещё раз
    for (const t of [s, s.replace(/,\s*([}\]])/g, '$1')]) {
      try { return JSON.parse(t); } catch (_) {}
    }
    return null;
  }
  async function runSplit(which) {
    if (!proj || !graph) return;
    const srcName = SPLIT_FILES[which] || 'CLAUDE.md';
    const src = await lite.fs.readFile(proj.path + '/' + srcName);
    if (!src || src.error || !src.content) { toast(srcName + ' не найден в корне проекта', { kind: 'err' }); return; }
    // бекап исходника перед распилом — сам файл мы не меняем, но пользователю спокойнее с копией
    const bkp = await lite.ctx.backupFile(proj.id, proj.path, srcName, activeProfile);
    let cancelled = false;
    const md = makeModal(`
      <h2>✂ Распилить ${srcName}</h2>
      <div class="about-desc">Локальный агент читает файл и раскладывает его на блоки и группы прямо на канву.
      <b>${srcName} не меняется</b> — это импорт-копия, плюс уже сделан бекап в папку бекапов. Обычно занимает до минуты.</div>
      <div class="ctx-spin"><span class="ctx-spinner"></span><span id="cxp-st">Агент думает…</span></div>
      <div class="modal-actions"><button class="btn" id="cxp-cancel">Отмена</button></div>`, () => { cancelled = true; });
    md.m.querySelector('#cxp-cancel').onclick = md.close;
    const prompt = [
      `Ты — инструмент разметки. Ниже содержимое ${srcName} проекта. Разбей его на тематические блоки контекста для ИИ-агента.`,
      'ФОРМАТ ОТВЕТА (критично): только JSON-объект. Первый символ ответа — «{», последний — «}».',
      'Никакого текста до или после, никаких пояснений, никаких markdown-ограждений ```.',
      'Схема: {"always":[{"title":"...","content":"..."}],"groups":[{"title":"...","blocks":[{"title":"...","content":"..."}]}]}',
      'Внутри строк JSON переводы строк экранируй как \\n, кавычки как \\".',
      'Правила разбиения: content — дословные фрагменты исходника (markdown), ничего не сочиняй и не пересказывай;',
      '"always" — то, что агенту нужно всегда (общие правила, команды, стиль кода);',
      'каждая группа — ситуативная тема (релиз, отдельная подсистема, деплой и т.п.);',
      'всего 4–12 блоков, названия короткие (1–4 слова).',
      '', `=== ${srcName} ===`, src.content,
    ].join('\n');
    const r = await lite.ctx.agent(graph.settings.splitAgent || 'claude', prompt);
    if (cancelled) return;
    md.close();
    if (!r || r.error) { toast('Агент не справился: ' + ((r && r.error) || '?'), { kind: 'err', ttl: 9000 }); return; }
    const data = extractJson(r.text);
    if (!data || (!Array.isArray(data.always) && !Array.isArray(data.groups))) { showSplitError(which, r.text); return; }
    // блоки подключаются к «своему» выходу (CLAUDE.md → Claude, AGENTS.md → Codex); провода в другой — руками
    const outs = graph.nodes.filter((n) => n.type === 'out' && n.out === which);
    let y = 40;
    const addText = async (b, x) => {
      const n = { id: uid(), type: 'text', title: String(b.title || 'Блок').slice(0, 60), enabled: true, x, y, chars: 0 };
      y += 96;
      const w = await lite.ctx.blockWrite(proj.id, proj.path, n, String(b.content || ''));
      n.chars = (w && w.chars) || 0;
      graph.nodes.push(n);
      return n;
    };
    let made = 0;
    for (const b of (data.always || [])) {
      const n = await addText(b, 40);
      for (const o of outs) graph.edges.push({ from: n.id, to: o.id });
      made++;
    }
    for (const g of (data.groups || [])) {
      const members = [];
      for (const b of (g.blocks || [])) { members.push(await addText(b, 40)); made++; }
      if (!members.length) continue;
      const gn = {
        id: uid(), type: 'group', title: String(g.title || 'Группа').slice(0, 40), enabled: true,
        x: 420, y: Math.round(members.reduce((s, n) => s + n.y, 0) / members.length), color: 'green', chars: 0,
      };
      graph.nodes.push(gn);
      for (const n of members) graph.edges.push({ from: n.id, to: gn.id });
      for (const o of outs) graph.edges.push({ from: gn.id, to: o.id });
    }
    markDirty();
    renderAll();
    const bkpNote = (bkp && bkp.ok) ? ` Бекап исходника: ${bkp.backup} → ${bkp.dir}.` : '';
    toast(`Готово: ${made} блок(ов), ${(data.groups || []).length} групп(ы).${bkpNote} Проверь канву и нажми ▶`, { ttl: 10000 });
  }
  // Агент ответил не-JSON: показываем сырой ответ (для диагностики) и предлагаем повторить —
  // у моделей это плавающее поведение, второй заход обычно срабатывает.
  function showSplitError(which, raw) {
    try { lite.log('error', 'ctx:split non-json', String(raw || '').slice(0, 2000)); } catch (_) {}
    const { m, close } = makeModal(`
      <h2>Агент вернул не-JSON</h2>
      <div class="about-desc">Модель иногда добавляет пояснения вместо чистого JSON — это случайность, а не поломка.
      Обычно помогает «Попробовать ещё раз». Ниже — сырой ответ агента (можно скопировать и показать в issue).</div>
      <pre class="ctx-cmdout" id="cxe-raw"></pre>
      <div class="modal-actions">
        <button class="btn" id="cxe-copy">Копировать ответ</button>
        <button class="btn" id="cxe-close">Закрыть</button>
        <button class="btn primary" id="cxe-retry">Попробовать ещё раз</button>
      </div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxe-raw').textContent = String(raw || '(пустой ответ)').slice(0, 6000);
    m.querySelector('#cxe-copy').onclick = () => { lite.copyText(String(raw || '')); toast('Ответ скопирован'); };
    m.querySelector('#cxe-close').onclick = close;
    m.querySelector('#cxe-retry').onclick = () => { close(); runSplit(which); };
  }

  // ---------------------------------------------------------------- бинды панели
  $('#ctx-close').addEventListener('click', () => {
    if (unsaved) showConfirm('Закрыть «Контекст»?', 'Есть неподтверждённые изменения — они будут потеряны.', 'Закрыть', () => setOpen(false));
    else setOpen(false);
  });
  $('#ctx-help').addEventListener('click', showHelp);
  $('#ctx-empty-help').addEventListener('click', showHelp);
  $('#ctx-add').addEventListener('click', showAddMenu);
  $('#ctx-apply').addEventListener('click', () => applyCompile());
  $('#ctx-reset').addEventListener('click', resetGraph);
  $('#ctx-split').addEventListener('click', splitClick);
  $('#ctx-settings').addEventListener('click', () => { if (graph) modalSettings(); });
  $('#ctx-empty-add').addEventListener('click', showAddMenu);
  lite.ctx.onSlotChanged(({ projId, nodeId }) => {
    if (!proj || projId !== proj.id || !graph) return;
    const n = graph.nodes.find((x) => x.type === 'slot' && x.id === nodeId);
    if (!n) return;
    slotBadges.add(nodeId);
    // агент дописал слот → его содержимое попадёт в сборку только при следующем «Подтвердить»
    lite.ctx.blockRead(proj.id, proj.path, n).then((r) => { if (r && graph) { n.chars = r.chars; unsaved = true; renderAll(); } });
  });

  return { isOpen: () => open, setOpen, toggle, onProjectChange, autoApply, applyCompile };
}
