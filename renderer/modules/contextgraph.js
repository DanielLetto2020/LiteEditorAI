// LiteEditor — модуль «Контекст»: per-project граф контекста агента (канва в духе n8n).
// Блоки-источники (текст/файл/команда/слот агента) → группы-профили с тумблерами → ноды-выходы
// (Claude → CLAUDE.local.md, Codex → AGENTS.md). Семантика топологии: блок, воткнутый в выход
// напрямую — постоянный контекст; через группу — переключаемый профиль. Компиляция и бекапы —
// в main (ctx:*), здесь только канва/модалки/оркестрация. Изолирован по канону модулей:
// всё из ядра — через host-колбэки, UI-хелперы — прямые импорты из ui.js, бэкенд — window.lite.ctx.
// host: { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, getActiveId, closeOtherPanels }
import { el, icon, toast, makeModal, showConfirm } from '../ui.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';

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
const OUT_FILES = { claude: 'CLAUDE.local.md', codex: 'AGENTS.md' };
const SPLIT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md' }; // исходники для «Распилить»
const CTX_MARKER = '<!-- LiteEditorAI:contextgraph'; // шапка наших скомпилированных файлов (синхронно с main.js)
const GROUP_COLORS = ['green', 'info', 'warn', 'danger'];

const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
  let saveTimer = null;
  const slotBadges = new Set(); // nodeId слотов с непросмотренными записями агента
  let splitSrc = { claude: false, codex: false }; // какие исходники реально есть в проекте

  const canvas = $('#ctx-canvas');
  const world = $('#ctx-world');
  const wiresSvg = $('#ctx-wires');
  const nodesBox = $('#ctx-nodes');

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
  const sources = () => graph.nodes.filter((n) => n.type !== 'out' && n.type !== 'group');

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (proj && graph) lite.ctx.save(proj.id, graph); }, 400);
  }
  function markDirty() { if (graph) { graph.dirty = true; scheduleSave(); updateStats(); } }

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
    if (proj && proj.id !== p.id) lite.ctx.unwatchSlots(proj.id);
    proj = { id: p.id, path: p.path, name: p.name };
    const seq = ++loadSeq;
    const r = await lite.ctx.load(p.id);
    if (seq !== loadSeq || !open) return;
    graph = normalizeGraph(r && r.graph);
    sel = null;
    slotBadges.clear();
    lite.ctx.watchSlots(p.id, p.path);
    renderAll();
    refreshLiveChars(seq); // файлы/слоты: подтянуть актуальные размеры после рендера
    detectSplitSources(); // какие кнопки «✂ распилить» показывать
  }
  // Детект исходников: CLAUDE.md — как есть; AGENTS.md — только если он НЕ наш скомпилированный
  // (иначе предлагали бы распилить собственную сборку). Кнопок столько, сколько файлов есть.
  async function detectSplitSources() {
    if (!proj) { splitSrc = { claude: false, codex: false }; updateSplitUi(); return; }
    const [cEx, aRes] = await Promise.all([
      lite.fs.exists(proj.path + '/CLAUDE.md'),
      lite.fs.readFile(proj.path + '/AGENTS.md'),
    ]);
    splitSrc = {
      claude: !!cEx,
      codex: !!(aRes && !aRes.error && aRes.content && !aRes.content.startsWith(CTX_MARKER)),
    };
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
    if (changed) { renderAll(); scheduleSave(); }
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
    if (!proj || !graph) { nodesBox.innerHTML = ''; wiresSvg.innerHTML = ''; updateStats(); return; }
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

    box.addEventListener('dblclick', (e) => { e.stopPropagation(); openNodeModal(n); });
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
      p.addEventListener('click', (ev) => { ev.stopPropagation(); sel = { kind: 'edge', from: e.from, to: e.to }; renderAll(); });
      p.addEventListener('dblclick', (ev) => { ev.stopPropagation(); removeEdge(e.from, e.to); });
      wiresSvg.appendChild(p);
    }
  }
  function updateStats() {
    const bar = $('#ctx-stats');
    if (!bar) return;
    bar.innerHTML = '';
    $('#ctx-stale').hidden = !(graph && graph.dirty);
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
    if (graph.dirty) bar.appendChild(el('span', 'ctx-chip warn', 'не применено — подействует на новые сессии'));
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
    lite.ctx.blockDelete(proj.id, proj.path, n); // свои файлы (локальный текст/слот) подчищаются
    markDirty();
    renderAll();
  }
  function deleteSelection() {
    if (!sel || !graph) return;
    if (sel.kind === 'edge') { removeEdge(sel.from, sel.to); return; }
    const n = nodeById(sel.id);
    if (!n) return;
    if (n.type === 'out') { toast('Ноды-выходы удалить нельзя — их можно выключить'); return; }
    const hasContent = ((n.type === 'text' && !String(n.ref || '').startsWith('lib:')) || n.type === 'slot') && (n.chars || 0) > 0;
    if (hasContent) showConfirm('Удалить блок?', `«${n.title}» и его файл будут удалены безвозвратно.`, 'Удалить', () => removeNode(n));
    else removeNode(n);
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
      else { sel = { kind: 'node', id: drag.id }; renderAll(); }
    } else if (drag.kind === 'pan') {
      if (!drag.moved) { sel = null; renderAll(); }
      else scheduleSave();
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
    scheduleSave();
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
      <div id="cxm-ed" class="ctx-med"></div>
      <div class="ctx-mfoot">
        <span id="cxm-chars" class="ctx-mchars"></span>
        <span id="cxm-libinfo" class="ctx-mchars"></span>
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
      await lite.ctx.blockDelete(proj.id, proj.path, { ...n }); // локальный файл больше не нужен
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
      <label class="ctx-mcheck"><input type="checkbox" id="cxs-auto"> автособирать контекст при открытии новой вкладки-терминала</label>
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
        scheduleSave();
        close();
        toast(mv && mv.moved ? `Настройки сохранены · перенесено бекапов: ${mv.moved} → ${mv.dir}` : 'Настройки сохранены', { ttl: 7000 });
        return;
      }
      s.backupDir = newDir;
      scheduleSave();
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

  // ---------------------------------------------------------------- сборка (Применить)
  async function applyCompile(opts = {}) {
    if (!proj || !graph) return;
    const btn = $('#ctx-apply');
    btn.disabled = true;
    clearTimeout(saveTimer);
    await lite.ctx.save(proj.id, graph); // компилятор читает граф с диска — сначала зафиксировать
    const r = await lite.ctx.compile({ projId: proj.id, projPath: proj.path, force: !!opts.force });
    btn.disabled = false;
    if (!r || r.error) { toast((r && r.error) || 'ошибка сборки', { kind: 'err', ttl: 8000 }); return; }
    if (r.graph) { graph = normalizeGraph(r.graph); renderAll(); }
    if (r.conflicts && r.conflicts.length && !opts.force) {
      showConfirm('Файл создан не LiteEditor', `${r.conflicts.join(' и ')} уже существует и не похож на наш. Забекапить и заменить?`, 'Забекапить и заменить', () => applyCompile({ force: true }));
      return;
    }
    const parts = r.results.map((x) => `${x.file} ${fmtTok(x.chars)}${x.wrote ? (x.backup ? ` (бекап: ${x.backup})` : '') : ' — без изменений'}`);
    if (!parts.length) parts.push('нечего собирать — подключи блоки к выходам');
    for (const err of (r.errors || [])) toast(err, { kind: 'err', ttl: 8000 });
    const bdir = (r.results.find((x) => x.bdir) || {}).bdir;
    toast('Контекст: ' + parts.join(' · ') + (bdir ? ` · бекапы в ${bdir}` : ''), { ttl: 8000 });
    detectSplitSources(); // сборка могла перезаписать чужой AGENTS.md нашим — кнопки распила пересчитать
  }
  // Автосборка при новой вкладке-терминала проекта (хук из createSession в ядре).
  // Тихая: только если граф есть, autoApply включён и есть несобранные изменения.
  async function autoApply(p) {
    try {
      let g = (proj && p.id === proj.id && graph) ? graph : null;
      if (!g) { const r = await lite.ctx.load(p.id); g = r && r.graph; }
      if (!g || !g.dirty || (g.settings && g.settings.autoApply === false)) return;
      if (!(g.nodes || []).some((n) => n.type !== 'out')) return;
      const r = await lite.ctx.compile({ projId: p.id, projPath: p.path });
      if (r && r.ok && proj && p.id === proj.id && open) { graph = normalizeGraph(r.graph); renderAll(); }
    } catch (_) {}
  }

  // ---------------------------------------------------------------- «Распилить CLAUDE.md»
  function extractJson(text) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  }
  async function runSplit(which) {
    if (!proj || !graph) return;
    const srcName = SPLIT_FILES[which] || 'CLAUDE.md';
    const src = await lite.fs.readFile(proj.path + '/' + srcName);
    if (!src || src.error || !src.content) { toast(srcName + ' не найден в корне проекта', { kind: 'err' }); return; }
    // бекап исходника перед распилом — сам файл мы не меняем, но пользователю спокойнее с копией
    const bkp = await lite.ctx.backupFile(proj.id, proj.path, srcName);
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
      'Верни СТРОГО JSON без пояснений и без markdown-ограждений, схема:',
      '{"always":[{"title":"...","content":"..."}],"groups":[{"title":"...","blocks":[{"title":"...","content":"..."}]}]}',
      'Правила: content — дословные фрагменты исходника (markdown), ничего не сочиняй и не пересказывай;',
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
    if (!data || (!Array.isArray(data.always) && !Array.isArray(data.groups))) { toast('Агент вернул не-JSON — попробуй ещё раз', { kind: 'err', ttl: 8000 }); return; }
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

  // ---------------------------------------------------------------- бинды панели
  $('#ctx-close').addEventListener('click', () => setOpen(false));
  $('#ctx-add').addEventListener('click', showAddMenu);
  $('#ctx-apply').addEventListener('click', () => applyCompile());
  $('#ctx-split').addEventListener('click', splitClick);
  $('#ctx-settings').addEventListener('click', () => { if (graph) modalSettings(); });
  $('#ctx-empty-add').addEventListener('click', showAddMenu);
  lite.ctx.onSlotChanged(({ projId, nodeId }) => {
    if (!proj || projId !== proj.id || !graph) return;
    const n = graph.nodes.find((x) => x.type === 'slot' && x.id === nodeId);
    if (!n) return;
    slotBadges.add(nodeId);
    lite.ctx.blockRead(proj.id, proj.path, n).then((r) => { if (r) { n.chars = r.chars; if (graph) { graph.dirty = true; scheduleSave(); } renderAll(); } });
  });

  return { isOpen: () => open, setOpen, toggle, onProjectChange, autoApply, applyCompile };
}
