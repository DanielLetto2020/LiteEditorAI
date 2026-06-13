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
const PORT_Y = 30;         // вертикаль портов от верха ноды (центр шапки)
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
  let loadSeq = 0;
  let unsaved = false;   // канва изменена, но не «Подтверждена». Автосохранения НЕТ
  let pendingDelete = []; // снимки удалённых текст-блоков — файлы сотрутся только при «Подтвердить»
  let profiles = null;   // {active, applied, list:[{id,name}]} текущего агента
  let activeProfile = null;
  let points = [];       // точки восстановления текущего агента [{id,name,ts,locked,chars}]

  const canvas = $('#ctx-canvas');
  const world = $('#ctx-world');
  const wiresSvg = $('#ctx-wires');
  const nodesBox = $('#ctx-nodes');
  const agentsBar = $('#ctx-agents');
  const profilesBar = $('#ctx-profiles');
  const wireDel = $('#ctx-wire-del');
  let wireDelHideTimer = null;
  // онбординг-плашка снизу: показывается на пустой канве, закрывается один раз (persist в localStorage)
  const onboardDismissed = () => { try { return localStorage.getItem('lite.ctx.onboard') === '1'; } catch (_) { return false; } };
  function dismissOnboard() { try { localStorage.setItem('lite.ctx.onboard', '1'); } catch (_) {} const ob = $('#ctx-onboard'); if (ob) ob.hidden = true; }

  // ---------------------------------------------------------------- граф: модель (ОДИН выход на агента)
  function newGraph(ag) {
    return {
      v: 1,
      nodes: [{ id: 'out-' + ag, type: 'out', out: ag, title: AGENT_META[ag].label, enabled: true, x: 760, y: 180 }],
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
    g.nodes.push({ id, type: 'text', base: true, title: content ? OUT_FILES[agent] : 'Текст', enabled: true, x: 430, y: 170, chars: (content || '').length });
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
      g.nodes.push({ id: 'out-' + ag, type: 'out', out: ag, title: AGENT_META[ag].label, enabled: true, x: 760, y: 180 });
    }
    g.nodes = g.nodes.filter((n) => n.type !== 'out' || n.out === ag);
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
    const seq = ++loadSeq;
    await loadAgentData(seq);
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
    sel = null; unsaved = false; pendingDelete = [];
    renderAgents(); renderProfiles(); renderAll();
    maybeFitInitial(); setTimeout(maybeFitInitial, 130); // центрируем (повтор — после того как раскладка устаканится)
    refreshLiveChars(seq);
  }
  // Перезагрузка графа активного профиля (после переключения/создания) + точки
  async function loadActiveGraph() {
    if (!proj) return;
    const seq = ++loadSeq;
    const r = await lite.ctx.load(proj.id, agent, activeProfile);
    if (seq !== loadSeq || !open) return;
    if (r && r.graph) graph = normalizeGraph(r.graph, agent);
    else { graph = normalizeGraph(await buildSeededGraph(''), agent); await lite.ctx.save(proj.id, agent, graph, activeProfile); } // новый профиль — пустой блок
    sel = null; unsaved = false; pendingDelete = [];
    const pr = await lite.ctx.points(proj.id, agent);
    points = (pr && pr.list) || [];
    renderProfiles(); renderAll();
    maybeFitInitial(); setTimeout(maybeFitInitial, 130);
    refreshLiveChars(seq);
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
      if (r && r.chars !== n.chars) { n.chars = r.chars; changed = true; }
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
    profilesBar.innerHTML = '';
    if (!proj || !profiles) return;
    const multi = profiles.list.length > 1;
    for (const pr of profiles.list) {
      const isApplied = pr.id === profiles.applied;
      const tab = el('div', 'ctx-ptab' + (pr.id === activeProfile ? ' on' : '') + (isApplied ? ' applied' : ''));
      tab.title = pr.name + (isApplied ? ' · собран в ' + OUT_FILES[agent] : ' · не применён — нажми «Подтвердить»');
      if (isApplied) { const d = el('span', 'ctx-ptab-dot'); d.title = 'Этот профиль собран в ' + OUT_FILES[agent]; tab.appendChild(d); }
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
    row('Распилить версию…', 'новый профиль из точки восстановления (локальным агентом)', () => {
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
  function deleteProfile(pr) {
    if (!proj || !profiles || profiles.list.length <= 1) return;
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
      <div class="about-desc">Точки восстановления файла контекста. От любой можно «Распилить» — разложить её на блоки текущей канвы. «Оригинал» (🔒) не удаляется. Источник истины — модуль; файл это лишь рендер применённого профиля.</div>
      <div id="cxv-list" class="ctx-addlist"></div>`);
    m.classList.add('ctx-modal');
    const list = m.querySelector('#cxv-list');
    const render = () => {
      list.innerHTML = '';
      if (!points.length) { list.appendChild(el('div', 'ctx-addhint', 'Версий пока нет. «Оригинал» появляется при первом открытии проекта с CLAUDE.md/AGENTS.md, остальные — при «Подтвердить».')); return; }
      for (const pt of points.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
        const r = el('div', 'ctx-addrow');
        const tx = el('div', 'ctx-addtx');
        tx.appendChild(el('div', 'ctx-addlabel', (pt.locked ? '🔒 ' : '') + pt.name));
        tx.appendChild(el('div', 'ctx-addhint', fmtTs(pt.ts) + ' · ' + fmtTok(pt.chars || 0)));
        r.appendChild(tx);
        const split = el('button', 'btn primary ctx-vbtn', '✂ Распилить');
        split.onclick = () => { close(); runSplit(pt.id); };
        r.appendChild(split);
        if (!pt.locked) {
          const del = el('button', 'btn danger-btn ctx-libdel', '✕');
          del.title = 'Удалить версию';
          del.onclick = async () => {
            const dr = await lite.ctx.pointDelete(proj.id, agent, pt.id);
            if (dr && dr.error) { toast(dr.error, { kind: 'err' }); return; }
            points = dr.list || [];
            render();
          };
          r.appendChild(del);
        }
        list.appendChild(r);
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

  // ---------------------------------------------------------------- геометрия/обходы (один выход)
  function portPos(n, kind) { return { x: kind === 'out' ? n.x + NODE_W : n.x, y: n.y + PORT_Y }; }
  function wireD(a, b) {
    const dx = Math.max(40, Math.min(140, Math.abs(b.x - a.x) / 2));
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
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
    const stack = [toId]; const seen = new Set(); // цикл групп: от b нельзя дойти до a
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
    const sp = $('#ctx-split'); if (sp) sp.hidden = !(scaffold && points.length); // ✂ — пока не распилено и есть версия
    const ob = $('#ctx-onboard'); if (ob) ob.hidden = !scaffold || onboardDismissed();
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
    head.appendChild(el('span', 'ctx-ntitle', n.title || NODE_TYPES[n.type]?.label || ''));
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
    $('#ctx-stale').hidden = !(unsaved || mismatch);
    { const rb = $('#ctx-reset'); if (rb) rb.hidden = !unsaved; }
    { const ab = $('#ctx-apply'); if (ab) ab.classList.toggle('hot', unsaved || mismatch); }
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
    // файл текст-блока НЕ удаляем сейчас — удаление обратимо до «Подтвердить»
    if (n.type === 'text' && !String(n.ref || '').startsWith('lib:')) pendingDelete.push({ ...n });
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
          sel = { kind: 'node', id: drag.id };
          renderAll();
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
    } else if (drag.kind === 'pan') {
      if (!drag.moved) { sel = null; renderAll(); }
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
      </div>`, () => { if (editor) editor.destroy(); });
    const charsEl = md.m.querySelector('#cxm-chars');
    const saveBtn = md.m.querySelector('#cxm-save');
    const cancelBtn = md.m.querySelector('#cxm-cancel');
    let origText = '';
    const recomputeDirty = () => {
      const dirty = !!editor && (editor.state.doc.toString() !== origText || md.titleInp.value !== origTitle);
      saveBtn.hidden = !dirty;
      cancelBtn.textContent = dirty ? 'Отмена' : 'Закрыть';
      return dirty;
    };
    const origTitle = md.titleInp.value;
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
    editor = makeMdEditor(md.m.querySelector('#cxm-ed'), origText, (len) => { charsEl.textContent = fmtTok(len); recomputeDirty(); });
    charsEl.textContent = fmtTok((r && r.chars) || 0);
    md.titleInp.addEventListener('input', recomputeDirty);
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
      n.title = md.titleInp.value.trim() || 'Текст';
      const w = await lite.ctx.blockWrite(proj.id, proj.path, n, text);
      if (w && w.error) { toast(w.error, { kind: 'err' }); return false; }
      n.chars = w.chars || 0;
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
      <div class="field"><label>Цвет группы</label><div id="cxm-colors" class="ctx-colors"></div></div>
      <div class="ctx-mchars">Группа — профиль контекста: тумблер включает/выключает всю ветку, провода остаются.</div>
      <div class="ctx-mfoot">
        <button class="btn danger-btn" id="cxm-del">Удалить</button>
        <button class="btn" id="cxm-cancel">Закрыть</button>
        <button class="btn primary" id="cxm-save" hidden>Сохранить</button>
      </div>`);
    const colorsBox = md.m.querySelector('#cxm-colors');
    const saveBtn = md.m.querySelector('#cxm-save');
    const cancelBtn = md.m.querySelector('#cxm-cancel');
    let picked = n.color || 'green';
    const origTitle = md.titleInp.value, origColor = picked;
    const recomputeDirty = () => {
      const dirty = picked !== origColor || md.titleInp.value !== origTitle;
      saveBtn.hidden = !dirty; cancelBtn.textContent = dirty ? 'Отмена' : 'Закрыть';
    };
    md.titleInp.addEventListener('input', recomputeDirty);
    for (const c of GROUP_COLORS) {
      const sw = el('button', 'ctx-color g-' + c + (picked === c ? ' on' : ''));
      sw.onclick = () => { picked = c; colorsBox.querySelectorAll('.ctx-color').forEach((x) => x.classList.remove('on')); sw.classList.add('on'); recomputeDirty(); };
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
    unsaved = false;
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
      sel = null; unsaved = false; pendingDelete = [];
      renderAll();
      toast('Изменения сброшены');
    });
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

  // ---------------------------------------------------------------- «Распилить версию» (точку)
  function extractJson(text) {
    let s = String(text || '').trim();
    if (s.startsWith('```')) {
      const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
      if (fence) s = fence[1].trim();
      else s = s.replace(/^```(?:json)?\s*/, '');
    }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    for (const t of [s, s.replace(/,\s*([}\]])/g, '$1')]) {
      try { return JSON.parse(t); } catch (_) {}
    }
    return null;
  }
  async function runSplit(pointId) {
    if (!proj || !graph) return;
    const pr = await lite.ctx.pointRead(proj.id, agent, pointId);
    if (!pr || !pr.exists || !pr.text || !pr.text.trim()) { toast('Пустая версия — нечего пилить', { kind: 'err' }); return; }
    let cancelled = false;
    const md = makeModal(`
      <h2>✂ Распилить — ${OUT_FILES[agent]}</h2>
      <div class="about-desc">Локальный агент (${agent}) читает версию и раскладывает её на блоки и группы прямо на канву. Обычно занимает до минуты.</div>
      <div class="ctx-spin"><span class="ctx-spinner"></span><span id="cxp-st">Агент думает…</span></div>
      <div class="modal-actions"><button class="btn" id="cxp-cancel">Отмена</button></div>`, () => { cancelled = true; });
    md.m.querySelector('#cxp-cancel').onclick = md.close;
    const prompt = [
      `Ты — инструмент разметки. Ниже содержимое файла контекста ${OUT_FILES[agent]} для ИИ-агента. Разбей его на тематические блоки.`,
      'ФОРМАТ ОТВЕТА (критично): только JSON-объект. Первый символ ответа — «{», последний — «}».',
      'Никакого текста до или после, никаких пояснений, никаких markdown-ограждений ```.',
      'Схема: {"always":[{"title":"...","content":"..."}],"groups":[{"title":"...","blocks":[{"title":"...","content":"..."}]}]}',
      'Внутри строк JSON переводы строк экранируй как \\n, кавычки как \\".',
      'Правила: content — дословные фрагменты исходника (markdown), ничего не сочиняй и не пересказывай;',
      '"always" — то, что агенту нужно всегда (общие правила, команды, стиль кода);',
      'каждая группа — ситуативная тема (релиз, подсистема, деплой и т.п.);',
      'всего 4–12 блоков, названия короткие (1–4 слова).',
      '', `=== ${OUT_FILES[agent]} ===`, pr.text,
    ].join('\n');
    const r = await lite.ctx.agent(agent, prompt);
    if (cancelled) return;
    md.close();
    if (!r || r.error) { toast('Агент не справился: ' + ((r && r.error) || '?'), { kind: 'err', ttl: 9000 }); return; }
    const data = extractJson(r.text);
    if (!data || (!Array.isArray(data.always) && !Array.isArray(data.groups))) { showSplitError(pointId, r.text); return; }
    const out = graph.nodes.find((n) => n.type === 'out' && n.out === agent);
    // убрать черновой стартовый блок (монолит) — распил строит свою раскладку; файл блока сотрётся при «Подтвердить»
    for (const b of graph.nodes.filter((n) => n.base)) {
      if (b.type === 'text') pendingDelete.push({ ...b });
      graph.nodes = graph.nodes.filter((n) => n.id !== b.id);
      graph.edges = graph.edges.filter((e) => e.from !== b.id && e.to !== b.id);
    }
    let y = 60;
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
      const n = await addText(b, 80);
      if (out) graph.edges.push({ from: n.id, to: out.id });
      made++;
    }
    for (const g of (data.groups || [])) {
      const members = [];
      for (const b of (g.blocks || [])) { members.push(await addText(b, 80)); made++; }
      if (!members.length) continue;
      const gn = {
        id: uid(), type: 'group', title: String(g.title || 'Группа').slice(0, 40), enabled: true,
        x: 430, y: Math.round(members.reduce((s, n) => s + n.y, 0) / members.length), color: 'green', chars: 0,
      };
      graph.nodes.push(gn);
      for (const n of members) graph.edges.push({ from: n.id, to: gn.id });
      if (out) graph.edges.push({ from: gn.id, to: out.id });
    }
    markDirty();
    renderAll();
    toast(`Готово: ${made} блок(ов), ${(data.groups || []).length} групп(ы). Проверь канву и нажми ✓`, { ttl: 9000 });
  }
  function showSplitError(pointId, raw) {
    try { lite.log('error', 'ctx:split non-json', String(raw || '').slice(0, 2000)); } catch (_) {}
    const { m, close } = makeModal(`
      <h2>Агент вернул не-JSON</h2>
      <div class="about-desc">Модель иногда добавляет пояснения вместо чистого JSON — это случайность, а не поломка.
      Обычно помогает «Попробовать ещё раз». Ниже — сырой ответ агента.</div>
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
    m.querySelector('#cxe-retry').onclick = () => { close(); runSplit(pointId); };
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
        <p><b>Профиль</b> — это рецепт контекста (канва). Их может быть несколько (вкладки над канвой); в файл
        собран профиль с ● . Остальные профили хранятся <b>в модуле</b> и не теряются. <b>Файл — это рендер
        применённого профиля, а не источник.</b> Новый профиль: «+» → Пустой / Копия активного / Распилить версию.</p>
        <p><b>Старт.</b> При открытии профиль уже содержит один <b>текстовый блок</b>, привязанный к выходу: если
        файл агента есть — в блоке его полное содержимое, иначе блок пустой. Можно сразу править, либо нажать
        <b>✂ Распилить</b> — и монолит разложится на тематические блоки.</p>
        <p><b>Блоки</b> (кнопка «+»): <b>Текст</b> — markdown (правила, стиль, договорённости; правка двойным
        кликом, листание блоков стрелками в модалке) и <b>Группа</b> — профиль-тумблер: соберите в неё блоки и
        включайте/выключайте тему целиком.</p>
        <p><b>Провода.</b> Тяните от правой точки блока к левой точке группы/выхода. Напрямую в выход = постоянный
        контекст; через группу = ситуативный. Наведение на провод → «×» удаляет его (как в n8n).</p>
        <p><b>🕘 Версии (точки восстановления).</b> История файла как «git для одного файла»: <b>Оригинал</b> (🔒,
        снимок при первом открытии) и каждая сборка. От любой версии можно <b>✂ Распилить</b> — локальный агент
        разложит её на блоки канвы. Версии (кроме «Оригинала») удаляются. Так можно пилить и экспериментировать
        сколько угодно — оригинал всегда сохранён.</p>
        <p><b>✓ Подтвердить / ↺ Сбросить.</b> Автосохранения нет — правки копятся, пока не подтвердишь.
        «Подтвердить» сохраняет канву и пересобирает файл текущего агента (старый — в бекап, плюс новая версия).
        Чужой файл без согласия не перезаписывается. «Сбросить» откатывает канву к последнему подтверждённому виду.</p>
        <p><b>Канва.</b> Колесо — зум · перетаскивание фона — перемещение · двойной клик по блоку — редактирование ·
        клик — выделить · Del — удалить · Ctrl+D — дублировать.</p>
      </div>
      <div class="modal-actions"><button class="btn primary" id="cxh-ok">Понятно</button></div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxh-ok').onclick = close;
  }

  // ---------------------------------------------------------------- бинды панели
  $('#ctx-close').addEventListener('click', () => {
    if (unsaved) showConfirm('Закрыть «Контекст»?', 'Есть неподтверждённые изменения — они будут потеряны.', 'Закрыть', () => setOpen(false));
    else setOpen(false);
  });
  wireDel.addEventListener('mouseenter', () => clearTimeout(wireDelHideTimer));
  wireDel.addEventListener('mouseleave', scheduleHideWireDel);
  wireDel.addEventListener('click', () => {
    const f = wireDel.dataset.from, t = wireDel.dataset.to;
    hideWireDelNow();
    if (f && t) removeEdge(f, t);
  });
  $('#ctx-help').addEventListener('click', showHelp);
  $('#ctx-add').addEventListener('click', showAddMenu);
  $('#ctx-split').addEventListener('click', () => pickPointThen(runSplit));
  $('#ctx-fit').addEventListener('click', fitView);
  $('#ctx-apply').addEventListener('click', () => applyCompile());
  $('#ctx-reset').addEventListener('click', resetGraph);
  $('#ctx-points').addEventListener('click', showPoints);
  $('#ctx-settings').addEventListener('click', () => { if (graph) modalSettings(); });
  $('#ctx-ob-split').addEventListener('click', () => { dismissOnboard(); pickPointThen(runSplit); });
  $('#ctx-ob-help').addEventListener('click', showHelp);
  $('#ctx-ob-close').addEventListener('click', dismissOnboard);

  return { isOpen: () => open, setOpen, toggle, onProjectChange, autoApply, applyCompile };
}
