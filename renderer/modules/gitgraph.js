// LiteEditor — «Граф Git»: история веток и коммитов схемой на канве (модуль-окно, только просмотр).
// Новое наверху, старое внизу. Ветка — цветная линия по своей дорожке, коммит — кружок с карточкой
// справа от дорожек. Ответвление уходит от родителя вбок и дальше вверх; слияние приходит сбоку.
// Канва двигается целиком (панорама и масштаб, как в Figma), сами элементы на месте.
// Изолирован: ядро — через host, UI-хелперы — из ui.js, бэкенд — window.lite.git.* (graph/refsSig/
// commitDetail/commitFiles/commitFileDiff). Проектозависимое окно: setOpen зовётся при смене проекта.
// host: { activeProject, STORE, persist }
import { el, icon, toast, makeModal, renderDiffInto } from '../ui.js';
import { t } from '../i18n.js';

const lite = window.lite;

// Геометрия схемы (в координатах «мира», до масштаба)
const LANE_W = 22;      // шаг дорожки
const ROW_H = 56;       // шаг строки (коммита)
const PAD_X = 36;       // отступ первой дорожки от левого края мира
const PAD_Y = 44;       // отступ первой строки от верха мира
const CARD_GAP = 22;    // от самой правой занятой дорожки строки до карточки
const CARD_W = 440;
const CARD_H = 42;
const PAGE = 400;       // коммитов в порции
const COLORS = 8;       // токены --gg-1 … --gg-8
const BUF_ROWS = 40;    // запас строк за краями видимой области при отрисовке
const Z_MIN = 0.3, Z_MAX = 2;
const TOP_GAP = 56;     // старт вида: первая строка под плавающей панелью поиска
const SVGNS = 'http://www.w3.org/2000/svg';

const laneX = (c) => PAD_X + c * LANE_W;
const rowY = (r) => PAD_Y + r * ROW_H;

// Цвет цепочки от вершины с веткой — по имени ветки: схема не перекрашивается от перезагрузки.
function colorForName(name) {
  const n = String(name).replace(/^[^/]+\/(?=.)/, (m) => (/^(origin|upstream)\//.test(m) ? '' : m)); // origin/dev и dev — один цвет
  if (/^(main|master|trunk)$/.test(n)) return 1;
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return 2 + (h % (COLORS - 1));
}
// %D с --decorate=full: «HEAD -> refs/heads/dev, refs/remotes/origin/dev, tag: refs/tags/v1.0»
// → [{ kind:'head'|'branch'|'remote'|'tag', name, current? }]
function parseRefs(s) {
  const out = [];
  for (let part of String(s || '').split(', ')) {
    part = part.trim();
    if (!part) continue;
    let current = false;
    if (part === 'HEAD') { out.push({ kind: 'head', name: 'HEAD' }); continue; }
    if (part.startsWith('HEAD -> ')) { out.push({ kind: 'head', name: 'HEAD' }); part = part.slice(8); current = true; }
    if (part.startsWith('tag: ')) part = part.slice(5);
    if (part.startsWith('refs/heads/')) out.push({ kind: 'branch', name: part.slice(11), current });
    else if (part.startsWith('refs/remotes/')) { if (!/\/HEAD$/.test(part)) out.push({ kind: 'remote', name: part.slice(13) }); } // origin/HEAD — шум
    else if (part.startsWith('refs/tags/')) out.push({ kind: 'tag', name: part.slice(10) });
  }
  return out;
}
function relTime(sec) {
  if (!sec) return '';
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'ru', { numeric: 'auto' }); } catch (_) { return ''; }
  const d = sec - Date.now() / 1000, a = Math.abs(d);
  if (a < 60) return rtf.format(Math.round(d), 'second');
  if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(d / 86400), 'day');
  if (a < 86400 * 365) return rtf.format(Math.round(d / (86400 * 30)), 'month');
  return rtf.format(Math.round(d / (86400 * 365)), 'year');
}
function absTime(sec) {
  if (!sec) return '';
  try { return new Date(sec * 1000).toLocaleString(document.documentElement.lang || 'ru', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return ''; }
}
// S-образная кривая между центрами двух строк: от (x1,y1) уходит вниз, вбок и приходит в (x2,y2) вертикально
const sCurve = (x1, y1, x2, y2) => { const ym = (y1 + y2) / 2; return `C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`; };

// ── Раскладка дорожек ─────────────────────────────────────────────────────────────────────────
// Коммиты приходят в topo-порядке (дети раньше родителей). lanes[j] — хеш коммита, которого ждёт
// дорожка j. Коммит встаёт на ждущую его дорожку; остальные ждавшие сходятся в него (это вершины
// веток, ответвившихся от него). Первый родитель продолжает дорожку, второй и дальше (слияние) —
// на уже ждущей его дорожке или на свободной. Состояние живёт между порциями (дозагрузка).
// Дорожка 0 — «магистраль»: цепочка первых родителей main/master (нет их — текущей ветки). Она
// всегда слева и одного цвета, остальные ветки отходят от неё вправо.
// Цепочка (ch) — общий объект дорожки { id, color, auto }: цвет безымянной дорожки уточняется, когда
// ниже по ней встречается коммит с именем ветки, и рёбра, нарисованные раньше, перекрашиваются вместе.
const TRUNK_HOLD = '#trunk';   // дорожка 0 занята под магистраль, пока её вершина не встретилась
function pickTrunkTip(commits, head) {
  const has = (re) => commits.find((c) => parseRefs(c.refs).some((x) => x.kind === 'branch' && re.test(x.name)));
  const byRemote = (re) => commits.find((c) => parseRefs(c.refs).some((x) => x.kind === 'remote' && re.test(x.name)));
  const c = has(/^(main|master|trunk)$/) || byRemote(/^[^/]+\/(main|master|trunk)$/) || (head && commits.find((x) => x.h === head)) || commits[0];
  return c ? c.h : null;
}
function createLayout(head) {
  return { head, lanes: [], laneCh: [], nextColor: 0, nextChain: 1, pending: new Map(), rows: [], edges: [], byHash: new Map(), trunkNext: undefined };
}
function layoutAppend(L, commits) {
  if (L.trunkNext === undefined) {
    L.trunkNext = pickTrunkTip(commits, L.head);
    if (L.trunkNext) { L.lanes[0] = TRUNK_HOLD; L.laneCh[0] = null; }
  }
  const trunkCh = L.trunkCh || (L.trunkCh = { id: 0, color: 1, auto: false });
  const autoColor = () => 2 + (L.nextColor++ % (COLORS - 1));     // цвет 1 — только у магистрали
  // Соседние живые дорожки одного цвета сливаются в глазах: занятый цвет сдвигаем на следующий
  // свободный (детерминированно — история та же, цвета те же).
  const freeColor = (want) => {
    const used = new Set([1]);
    for (let j = 0; j < L.lanes.length; j++) if (L.lanes[j] != null && L.laneCh[j]) used.add(L.laneCh[j].color);
    for (let k = 0; k < COLORS - 1; k++) { const cc = 2 + ((want - 2 + k) % (COLORS - 1)); if (!used.has(cc)) return cc; }
    return want;
  };
  const newCh = (color, auto, used = true) => ({ id: L.nextChain++, color: freeColor(color), auto, used });
  const freeLane = () => { let j = L.lanes.indexOf(null); if (j < 0) { j = L.lanes.length; L.lanes.push(null); } return j; };
  for (const c of commits) {
    const r = L.rows.length;
    const lanesBefore = L.lanes;
    const isTrunk = c.h === L.trunkNext;
    const refs = parseRefs(c.refs);
    const named = refs.find((x) => x.kind === 'branch') || refs.find((x) => x.kind === 'remote');
    const waiting = [];
    for (let j = 0; j < L.lanes.length; j++) if (L.lanes[j] === c.h) waiting.push(j);
    let col, ch;
    if (isTrunk) { col = 0; ch = trunkCh; }
    else if (waiting.length) {
      col = waiting[0]; ch = L.laneCh[col]; ch.used = true;
      if (ch.auto && named) { ch.auto = false; const want = colorForName(named.name); if (want !== ch.color) { const keep = ch.color; ch.color = -1; ch.color = freeColor(want); if (ch.color === -1) ch.color = keep; } }
    } else {
      col = freeLane();
      ch = named ? newCh(colorForName(named.name), false) : newCh(autoColor(), true);
    }
    // рёбра от детей, ждавших этот коммит, завершаются здесь
    // Дорожка, заведённая под второго родителя и не нёсшая своих коммитов, — просто подводка слияния:
    // она красится в цвет ветки, в которую пришла (слияние из main — цветом main).
    for (const e of (L.pending.get(c.h) || [])) { e.rB = r; e.cB = col; if (e.second && !e.ch.used) e.ch = ch; }
    L.pending.delete(c.h);
    const after = L.lanes.slice();
    for (const j of waiting) after[j] = null;
    if (isTrunk) after[0] = null;
    L.lanes = after;
    const addEdge = (lane, parent, eCh, second) => {
      const e = { rA: r, cA: col, lane, rB: -1, cB: lane, ch: eCh, h: c.h, p: parent, second };
      L.edges.push(e);
      if (!L.pending.has(parent)) L.pending.set(parent, []);
      L.pending.get(parent).push(e);
    };
    if (isTrunk) L.trunkNext = c.p[0] || null;
    c.p.forEach((p, i) => {
      if (i === 0) {
        L.lanes[col] = p; L.laneCh[col] = ch;
        addEdge(col, p, ch);
        return;
      }
      let j = L.lanes.indexOf(p);
      if (j < 0) { j = freeLane(); L.lanes[j] = p; L.laneCh[j] = newCh(autoColor(), true, false); }
      addEdge(j, p, L.laneCh[j], true);
    });
    while (L.lanes.length && L.lanes[L.lanes.length - 1] == null) L.lanes.pop();
    // самая правая дорожка, занятая в этой строке (проходящие линии и изгибы в соседних промежутках):
    // правее неё стоит карточка, и линии её не пересекают
    let maxCol = col;
    for (let j = lanesBefore.length - 1; j > maxCol; j--) if (lanesBefore[j] != null && lanesBefore[j] !== TRUNK_HOLD) { maxCol = j; break; }
    for (let j = L.lanes.length - 1; j > maxCol; j--) if (L.lanes[j] != null && L.lanes[j] !== TRUNK_HOLD) { maxCol = j; break; }
    const row = { c, r, col, ch, refs, maxCol, merge: c.p.length > 1 };
    L.rows.push(row);
    L.byHash.set(c.h, row);
  }
}

export function initGitGraph(host) {
  let open = false;
  let proj = null;
  let L = createLayout('');
  let more = false, loading = false, loadSeq = 0;
  let headHash = '', headBranch = '';
  let sig = '';
  let selected = null;          // хеш выделенного коммита
  let hoverChain = null;
  let view = { x: 0, y: 0, z: 1 };
  let rendered = { a: -1, b: -1 };
  let search = { q: '', hits: [], i: -1 };
  const ui = { remotes: true, tags: true, ...((host.STORE && host.STORE.gitGraphUi) || {}) };
  const saveUi = () => { try { host.persist && host.persist('gitGraphUi', { remotes: ui.remotes, tags: ui.tags }); } catch (_) {} };

  // ── DOM ──────────────────────────────────────────────────────────────────────────────────────
  const pane = document.getElementById('gitgraph-pane');
  const body = document.getElementById('gitgraph-body');
  const projLbl = document.getElementById('gitgraph-proj');
  body.innerHTML = '';

  const canvas = el('div', 'gg-canvas');
  canvas.tabIndex = 0;
  const world = el('div', 'gg-world');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'gg-svg');
  const gEdges = document.createElementNS(SVGNS, 'g');
  const gLinks = document.createElementNS(SVGNS, 'g');
  const gNodes = document.createElementNS(SVGNS, 'g');
  gLinks.setAttribute('class', 'gg-links');
  svg.append(gLinks, gEdges, gNodes);
  const cards = el('div', 'gg-cards');
  world.append(svg, cards);
  canvas.appendChild(world);

  // плавающая панель поверх канвы: поиск и фильтры
  const bar = el('div', 'gg-bar');
  const sWrap = el('label', 'gg-search');
  sWrap.appendChild(icon('search', 14));
  const sInput = el('input');
  sInput.type = 'text'; sInput.placeholder = 'Сообщение, хеш, автор…'; sInput.spellcheck = false;
  const sCount = el('span', 'gg-scount');
  sCount.setAttribute('data-no-i18n', '');
  sWrap.append(sInput, sCount);
  const tgl = (label, key) => {
    const b = el('button', 'gg-toggle' + (ui[key] ? ' on' : ''), label);
    b.type = 'button';
    b.onclick = () => { ui[key] = !ui[key]; b.classList.toggle('on', ui[key]); saveUi(); reload(true); };
    return b;
  };
  bar.append(sWrap, tgl('Удалённые', 'remotes'), tgl('Теги', 'tags'));

  const zoomBox = el('div', 'gg-zoom');
  const zBtn = (ic, title, fn) => { const b = el('button', 'icon-btn'); b.appendChild(icon(ic, 14)); b.title = title; b.onclick = fn; return b; };
  const zLbl = el('button', 'gg-zlbl', '100%');
  zLbl.title = 'Масштаб 100%';
  zLbl.setAttribute('data-no-i18n', '');
  zLbl.onclick = () => zoomAt(1, canvas.clientWidth / 2, canvas.clientHeight / 2);
  zoomBox.append(zBtn('minus', 'Мельче (Ctrl+колесо)', () => zoomAt(view.z / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2)), zLbl,
    zBtn('plus', 'Крупнее (Ctrl+колесо)', () => zoomAt(view.z * 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2)));

  const mini = el('canvas', 'gg-mini');
  mini.title = 'Мини-карта: клик — перейти';
  const status = el('div', 'gg-status');
  const empty = el('div', 'gg-empty hidden');
  const details = el('aside', 'gg-details hidden');

  body.append(canvas, bar, zoomBox, mini, status, empty, details);

  // ── Загрузка ──────────────────────────────────────────────────────────────────────────────────
  function showEmpty(title, text) {
    empty.innerHTML = '';
    empty.append(icon('gitgraph', 34), el('div', 'gg-empty-t', title));
    if (text) empty.appendChild(el('div', 'gg-empty-s', text));
    empty.classList.remove('hidden');
    canvas.classList.add('hidden'); bar.classList.add('hidden'); zoomBox.classList.add('hidden'); mini.classList.add('hidden'); status.classList.add('hidden');
  }
  function hideEmpty() {
    empty.classList.add('hidden');
    canvas.classList.remove('hidden'); bar.classList.remove('hidden'); zoomBox.classList.remove('hidden'); mini.classList.remove('hidden'); status.classList.remove('hidden');
  }
  function setProjLabel() {
    if (!projLbl) return;
    projLbl.textContent = '';
    projLbl.appendChild(el('span', null, 'Граф Git'));
    if (proj) {
      const n = el('span', 'gg-pname', proj.name || proj.path);
      n.setAttribute('data-no-i18n', '');
      projLbl.append(el('span', 'gg-dot', '·'), n);
    }
    if (headBranch) {
      const b = el('span', 'gg-pbranch');
      b.append(icon('git', 12), el('span', null, headBranch));
      b.setAttribute('data-no-i18n', '');
      projLbl.appendChild(b);
    }
  }

  async function reload(keepView) {
    const seq = ++loadSeq;
    proj = host.activeProject();
    selected = selected && keepView ? selected : null;
    if (!proj) { headBranch = ''; setProjLabel(); showEmpty('Проект не открыт', 'Откройте проект в редакторе — граф покажет его историю.'); return; }
    loading = true;
    let r;
    try { r = await lite.git.graph(proj.path, { skip: 0, limit: PAGE, remotes: ui.remotes, tags: ui.tags }); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (seq !== loadSeq) return;
    loading = false;
    if (!r || r.repo === false) { headBranch = ''; setProjLabel(); showEmpty('Не git-репозиторий', 'В папке проекта нет репозитория Git.'); return; }
    if (r.ok === false) { setProjLabel(); showEmpty('Не удалось прочитать историю', r.error || ''); toast(t('Граф Git: {0}', r.error || 'ошибка git'), { kind: 'err' }); return; }
    headHash = r.head || ''; headBranch = r.branch || '';
    setProjLabel();
    if (r.empty) { showEmpty('Коммитов пока нет', 'Сделайте первый коммит — здесь появится его кружок.'); return; }
    hideEmpty();
    const oldTop = keepView ? topRowHash() : null;
    L = createLayout(headHash);
    layoutAppend(L, r.commits);
    more = !!r.more;
    try { sig = (await lite.git.refsSig(proj.path)).sig || ''; } catch (_) {}
    sizeWorld();
    if (keepView && oldTop && L.byHash.has(oldTop)) { applyView(); }
    else { view.z = 1; toHead(false); }   // другой проект — с масштаба 100% и от HEAD
    rendered = { a: -1, b: -1 };
    renderVisible(true);
    if (search.q) runSearch(search.q, false);
    if (selected && L.byHash.has(selected)) openDetails(selected); else closeDetails();
  }
  async function loadMore() {
    if (!more || loading || !proj) return;
    loading = true;
    const seq = loadSeq;
    let r;
    try { r = await lite.git.graph(proj.path, { skip: L.rows.length, limit: PAGE, remotes: ui.remotes, tags: ui.tags }); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    loading = false;
    if (seq !== loadSeq) return;
    if (!r || r.ok === false) { more = false; toast(t('Граф Git: {0}', (r && r.error) || 'ошибка git'), { kind: 'err' }); renderStatus(); return; }
    layoutAppend(L, r.commits);
    more = !!r.more && r.commits.length > 0;
    sizeWorld();
    rendered = { a: -1, b: -1 };
    renderVisible(true);
    if (search.q) runSearch(search.q, false);
  }
  function topRowHash() {
    const r = Math.max(0, Math.floor((-view.y / view.z - PAD_Y) / ROW_H));
    return L.rows[r] ? L.rows[r].c.h : null;
  }
  // Ref'ы сдвинулись (коммит, checkout, fetch) — перечитать. Дёшево: одна подпись for-each-ref.
  async function checkFresh() {
    if (!open || !proj || loading) return;
    let s = '';
    try { s = (await lite.git.refsSig(proj.path)).sig || ''; } catch (_) { return; }
    if (s && s !== sig) reload(true);
  }

  // ── Вид (панорама/масштаб) ───────────────────────────────────────────────────────────────────
  let worldW = 0, worldH = 0;
  function sizeWorld() {
    let w = 0;
    for (const row of L.rows) w = Math.max(w, laneX(row.maxCol) + CARD_GAP + CARD_W);
    worldW = w + PAD_X; worldH = rowY(L.rows.length) + (more ? ROW_H * 2 : PAD_Y);
    world.style.width = worldW + 'px'; world.style.height = worldH + 'px';
    svg.setAttribute('width', worldW); svg.setAttribute('height', worldH);
    svg.setAttribute('viewBox', `0 0 ${worldW} ${worldH}`);
  }
  function clampView() {
    const cw = canvas.clientWidth || 800, ch = canvas.clientHeight || 600;
    const w = worldW * view.z, h = worldH * view.z;
    const slack = 120;
    // мир не уезжает за край целиком: остаётся «люфт» slack, а узкий мир свободно ходит по ширине окна
    view.x = Math.min(Math.max(0, cw - w) + slack, Math.max(Math.min(0, cw - w) - slack, view.x));
    view.y = Math.min(slack, Math.max(Math.min(0, ch - h) - slack, view.y));
  }
  let rafPending = false;
  function applyView() {
    clampView();
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    canvas.style.backgroundSize = `${26 * view.z}px ${26 * view.z}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    zLbl.textContent = Math.round(view.z * 100) + '%';
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; renderVisible(false); drawMini(); maybeLoadMore(); });
    }
  }
  function zoomAt(z, cx, cy) {
    const z2 = Math.max(Z_MIN, Math.min(Z_MAX, z));
    view.x = cx - (cx - view.x) * (z2 / view.z);
    view.y = cy - (cy - view.y) * (z2 / view.z);
    view.z = z2;
    applyView();
  }
  function centerRow(r, smooth) {
    const row = L.rows[r]; if (!row) return;
    const ch = canvas.clientHeight || 600;
    const tx = Math.min(40, 40 - (laneX(0) - PAD_X) * view.z);
    const ty = ch * 0.38 - rowY(r) * view.z;
    animateTo(tx, ty, smooth);
  }
  let anim = null;
  function animateTo(tx, ty, smooth) {
    if (anim) cancelAnimationFrame(anim);
    if (!smooth) { view.x = tx; view.y = ty; applyView(); return; }
    const sx = view.x, sy = view.y, t0 = performance.now(), dur = 260;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      view.x = sx + (tx - sx) * e; view.y = sy + (ty - sy) * e; applyView();
      anim = k < 1 ? requestAnimationFrame(step) : null;
    };
    anim = requestAnimationFrame(step);
  }
  function toHead(smooth = true) {
    const row = headHash && L.byHash.get(headHash);
    if (row && row.r > 6) { centerRow(row.r, smooth); return; }
    animateTo(40, TOP_GAP, smooth);
  }
  function fit() {
    const cw = canvas.clientWidth || 800;
    const z = Math.max(Z_MIN, Math.min(1, (cw - 80) / Math.max(1, worldW)));
    view.z = z;
    animateTo(40, TOP_GAP, false);
  }
  function maybeLoadMore() {
    if (!more || loading) return;
    const ch = canvas.clientHeight || 600;
    const bottomRow = (ch - view.y) / view.z / ROW_H;
    if (bottomRow > L.rows.length - 60) loadMore();
  }

  // ── Отрисовка видимого окна строк ────────────────────────────────────────────────────────────
  function visibleRange() {
    const ch = canvas.clientHeight || 600;
    const a = Math.floor((-view.y / view.z - PAD_Y) / ROW_H) - 1;
    const b = Math.ceil(((ch - view.y) / view.z - PAD_Y) / ROW_H) + 1;
    return { a: Math.max(0, a), b: Math.min(L.rows.length - 1, b) };
  }
  function renderVisible(force) {
    if (!L.rows.length) return;
    const v = visibleRange();
    if (!force && v.a >= rendered.a && v.b <= rendered.b) return;
    const a = Math.max(0, v.a - BUF_ROWS), b = Math.min(L.rows.length - 1, v.b + BUF_ROWS);
    rendered = { a, b };
    gEdges.textContent = ''; gNodes.textContent = ''; gLinks.textContent = ''; cards.textContent = '';
    const lastY = rowY(L.rows.length - 1) + (more ? ROW_H * 1.5 : ROW_H * 0.6);
    for (const e of L.edges) {
      const rB = e.rB < 0 ? L.rows.length : e.rB;  // родитель ещё не загружен — линия уходит вниз за край
      if (rB < a || e.rA > b) continue;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', edgePath(e, lastY));
      path.setAttribute('class', `gg-e gg-c${e.ch.color}` + (e.rB < 0 ? ' open' : ''));
      path.dataset.chain = e.ch.id;
      gEdges.appendChild(path);
    }
    for (let r = a; r <= b; r++) drawRow(L.rows[r]);
    applyHighlight();
    renderStatus();
  }
  function edgePath(e, lastY) {
    const x1 = laneX(e.cA), y1 = rowY(e.rA);
    const xl = laneX(e.lane);
    if (e.rB < 0) {
      let d = `M ${x1} ${y1} `;
      if (xl !== x1) d += sCurve(x1, y1, xl, y1 + ROW_H) + ' ';
      return d + `L ${xl} ${Math.max(lastY, y1 + ROW_H)}`;
    }
    const x2 = laneX(e.cB), y2 = rowY(e.rB);
    if (e.rB - e.rA <= 1) return `M ${x1} ${y1} ` + (x1 === x2 ? `L ${x2} ${y2}` : sCurve(x1, y1, x2, y2));
    let d = `M ${x1} ${y1} `;
    let y = y1;
    if (xl !== x1) { d += sCurve(x1, y1, xl, y1 + ROW_H) + ' '; y = y1 + ROW_H; }
    const yEnd = xl !== x2 ? y2 - ROW_H : y2;   // изгиб у родителя — в последнем промежутке
    if (yEnd > y) d += `L ${xl} ${yEnd} `;
    if (xl !== x2) d += sCurve(xl, yEnd, x2, y2);
    return d;
  }
  function drawRow(row) {
    const { c, r, col } = row;
    const color = row.ch.color, chain = row.ch.id;
    const cx = laneX(col), cy = rowY(r);
    const isHead = c.h === headHash;
    const cardX = laneX(row.maxCol) + CARD_GAP;
    // коннектор кружок → карточка
    const ln = document.createElementNS(SVGNS, 'line');
    ln.setAttribute('x1', cx + 8); ln.setAttribute('y1', cy); ln.setAttribute('x2', cardX); ln.setAttribute('y2', cy);
    ln.setAttribute('class', `gg-link gg-c${color}`);
    ln.dataset.chain = chain;
    gLinks.appendChild(ln);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', `gg-node gg-c${color}` + (row.merge ? ' merge' : '') + (isHead ? ' head' : '') + (selected === c.h ? ' sel' : ''));
    g.dataset.chain = chain; g.dataset.h = c.h;
    if (isHead) g.appendChild(circle(cx, cy, 11, 'gg-halo'));
    g.appendChild(circle(cx, cy, row.merge ? 5.5 : 6.5, 'gg-dot'));
    gNodes.appendChild(g);

    const card = el('div', 'gg-card' + (selected === c.h ? ' sel' : '') + (isHead ? ' head' : '') + (search.q && hitSet.has(c.h) ? ' match' : '') + (search.hits[search.i] === c.h ? ' cur' : ''));
    card.dataset.h = c.h; card.dataset.chain = chain;
    card.setAttribute('data-no-i18n', '');
    card.style.left = cardX + 'px'; card.style.top = (cy - CARD_H / 2) + 'px';
    card.style.setProperty('--gg-lane', `var(--gg-${color})`);
    const top = el('div', 'gg-ctop');
    for (const ref of row.refs) {
      if (ref.kind === 'head') continue;
      const chip = el('span', 'gg-ref ' + ref.kind + (ref.current ? ' cur' : ''));
      if (ref.kind === 'tag') chip.appendChild(icon('tag', 11));
      chip.appendChild(el('span', null, ref.name));
      top.appendChild(chip);
    }
    top.appendChild(el('span', 'gg-subj', c.s || '—'));
    const meta = el('div', 'gg-cmeta');
    meta.append(el('span', 'gg-hash', c.h.slice(0, 7)), el('span', 'gg-sep', '·'), el('span', 'gg-author', c.an), el('span', 'gg-sep', '·'), el('span', 'gg-when', relTime(c.at)));
    if (row.merge) meta.append(el('span', 'gg-sep', '·'), el('span', 'gg-mergetag', t('слияние')));
    card.title = `${c.s}\n${c.h}\n${c.an} · ${absTime(c.at)}`;
    card.append(top, meta);
    cards.appendChild(card);
  }
  function circle(cx, cy, rr, cls) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', rr); c.setAttribute('class', cls);
    return c;
  }
  function renderStatus() {
    status.textContent = '';
    status.setAttribute('data-no-i18n', '');
    status.append(el('span', null, t('Коммитов: {0}{1}', L.rows.length, more ? '+' : '')));
    if (loading) status.append(el('span', 'gg-sep', '·'), el('span', null, t('загрузка…')));
    status.append(el('span', 'gg-sep', '·'), el('span', 'gg-hint', t('тяните канву мышью · колесо — прокрутка · Ctrl+колесо — масштаб')));
  }

  // ── Подсветка цепочки под курсором ───────────────────────────────────────────────────────────
  function applyHighlight() {
    world.classList.toggle('hl', hoverChain != null);
    for (const n of world.querySelectorAll('.on')) n.classList.remove('on');
    if (hoverChain == null) return;
    for (const n of world.querySelectorAll(`[data-chain="${hoverChain}"]`)) n.classList.add('on');
  }
  function setHover(ch) {
    const v = ch == null ? null : String(ch);
    if (v === hoverChain) return;
    hoverChain = v; applyHighlight();
  }
  world.addEventListener('mouseover', (e) => {
    if (drag && drag.moved) return;
    const tEl = e.target.closest && e.target.closest('[data-chain]');
    setHover(tEl ? tEl.dataset.chain : null);
  });
  world.addEventListener('mouseleave', () => setHover(null));

  // ── Мышь: панорама, клик, колесо ─────────────────────────────────────────────────────────────
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (anim) { cancelAnimationFrame(anim); anim = null; }
    drag = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target };
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; canvas.classList.add('panning'); setHover(null); }
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    canvas.classList.remove('panning');
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.moved || e.type === 'pointercancel') return;
    const hit = d.target && d.target.closest && d.target.closest('[data-h]');
    if (hit) select(hit.dataset.h, false);
    else if (selected) { selected = null; closeDetails(); renderVisible(true); }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (anim) { cancelAnimationFrame(anim); anim = null; }
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {           // Ctrl+колесо и щипок тачпада
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      zoomAt(view.z * k, e.clientX - r.left, e.clientY - r.top);
      return;
    }
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    view.x -= dx; view.y -= dy;
    applyView();
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (e.target !== canvas) return;
    const step = 120;
    const k = e.key;
    if (k === 'Home' || k === 'h' || k === 'H' || k === 'р' || k === 'Р') toHead();
    else if (k === 'f' || k === 'F' || k === 'а' || k === 'А') fit();
    else if (k === '+' || k === '=') zoomAt(view.z * 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === '-' || k === '_') zoomAt(view.z / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === '0') zoomAt(1, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === 'ArrowUp') { view.y += step; applyView(); }
    else if (k === 'ArrowDown') { view.y -= step; applyView(); }
    else if (k === 'ArrowLeft') { view.x += step; applyView(); }
    else if (k === 'ArrowRight') { view.x -= step; applyView(); }
    else if (k === 'PageUp') { view.y += canvas.clientHeight * 0.8; applyView(); }
    else if (k === 'PageDown') { view.y -= canvas.clientHeight * 0.8; applyView(); }
    else if (k === 'Escape' && selected) { selected = null; closeDetails(); renderVisible(true); }
    else return;
    e.preventDefault();
  });

  // ── Выделение и панель деталей ───────────────────────────────────────────────────────────────
  function select(h, jump) {
    const row = L.byHash.get(h); if (!row) return;
    selected = h;
    if (jump) centerRow(row.r, true);
    renderVisible(true);
    openDetails(h);
  }
  let detSeq = 0;
  async function openDetails(h) {
    const row = L.byHash.get(h); if (!row || !proj) return;
    const seq = ++detSeq;
    const c = row.c;
    details.innerHTML = '';
    details.classList.remove('hidden');
    details.style.setProperty('--gg-lane', `var(--gg-${row.ch.color})`);
    const head = el('div', 'gg-dhead');
    const x = el('button', 'icon-btn'); x.appendChild(icon('x', 15)); x.title = 'Закрыть (Esc)';
    x.onclick = () => { selected = null; closeDetails(); renderVisible(true); };
    head.append(el('span', 'gg-dlane'), el('span', 'gg-dttl', 'Коммит'), el('span', 'grow'), x);
    const subj = el('div', 'gg-dsubj', c.s || '—'); subj.setAttribute('data-no-i18n', '');
    const msg = el('div', 'gg-dmsg'); msg.setAttribute('data-no-i18n', '');
    const meta = el('div', 'gg-dmeta');
    const kv = (k, v, mono) => { const r = el('div', 'gg-kv'); const vv = el('div', 'gg-v' + (mono ? ' mono' : '')); vv.setAttribute('data-no-i18n', ''); if (v instanceof Node) vv.appendChild(v); else vv.textContent = v; r.append(el('div', 'gg-k', k), vv); meta.appendChild(r); return vv; };
    const hashV = el('span', 'gg-hashfull', c.h);
    const cp = el('button', 'icon-btn gg-copy'); cp.appendChild(icon('copy', 13)); cp.title = 'Копировать хеш';
    cp.onclick = () => { lite.copyText(c.h); toast('Хеш скопирован'); };
    const hv = el('span', 'gg-hrow'); hv.append(hashV, cp);
    kv('Хеш', hv, true);
    kv('Автор', `${c.an}${c.ae ? ' <' + c.ae + '>' : ''}`);
    kv('Дата', `${absTime(c.at)} · ${relTime(c.at)}`);
    const commV = kv('Коммиттер', '…'); commV.parentNode.classList.add('hidden');
    if (row.refs.some((x2) => x2.kind !== 'head')) {
      const box = el('span', 'gg-dchips');
      for (const ref of row.refs) { if (ref.kind === 'head') continue; const chip = el('span', 'gg-ref ' + ref.kind + (ref.current ? ' cur' : '')); if (ref.kind === 'tag') chip.appendChild(icon('tag', 11)); chip.appendChild(el('span', null, ref.name)); box.appendChild(chip); }
      kv('Ссылки', box);
    }
    if (c.p.length) {
      const box = el('span', 'gg-dchips');
      for (const p of c.p) {
        const b = el('button', 'gg-parent', p.slice(0, 7));
        b.title = L.byHash.has(p) ? t('Перейти к родителю') : t('Родитель ещё не загружен');
        b.onclick = () => { if (L.byHash.has(p)) select(p, true); };
        box.appendChild(b);
      }
      kv(c.p.length > 1 ? 'Родители' : 'Родитель', box);
    }
    const acts = el('div', 'gg-dacts');
    const bMsg = el('button', 'btn'); bMsg.append(icon('copy', 13), el('span', null, 'Сообщение')); bMsg.title = 'Копировать сообщение коммита';
    let fullMsg = c.s;
    bMsg.onclick = () => { lite.copyText(fullMsg); toast('Сообщение скопировано'); };
    const bGo = el('button', 'btn'); bGo.append(icon('locate', 13), el('span', null, 'На схеме')); bGo.title = 'Показать коммит в центре схемы';
    bGo.onclick = () => centerRow(row.r, true);
    acts.append(bMsg, bGo);
    const filesHead = el('div', 'gg-dsec', 'Изменённые файлы');
    const files = el('div', 'gg-files');
    files.appendChild(el('div', 'gg-muted', 'Загрузка…'));
    details.append(head, subj, msg, meta, acts, filesHead, files);

    const [d, f] = await Promise.all([
      lite.git.commitDetail(proj.path, c.h).catch((e) => ({ ok: false, error: String(e) })),
      lite.git.commitFiles(proj.path, c.h, c.p.length > 1).catch((e) => ({ ok: false, error: String(e) })),
    ]);
    if (seq !== detSeq || selected !== h) return;
    if (d && d.ok) {
      fullMsg = d.body || c.s;
      const rest = fullMsg.split('\n').slice(1).join('\n').trim();
      msg.textContent = rest;
      msg.classList.toggle('hidden', !rest);
      if (d.cn && (d.cn !== d.an || Math.abs((d.ct || 0) - (d.at || 0)) > 60)) {
        commV.textContent = `${d.cn}${d.ce ? ' <' + d.ce + '>' : ''} · ${absTime(d.ct)}`;
        commV.parentNode.classList.remove('hidden');
      }
    } else if (d && d.error) toast(t('Граф Git: {0}', d.error), { kind: 'err' });
    files.textContent = '';
    filesHead.textContent = '';
    filesHead.append(el('span', null, c.p.length > 1 ? 'Принесло слияние' : 'Изменённые файлы'));
    if (!f || f.ok === false) { files.appendChild(el('div', 'gg-muted', (f && f.error) || 'ошибка')); return; }
    filesHead.appendChild(el('span', 'gg-fcount', String(f.files.length)));
    if (!f.files.length) files.appendChild(el('div', 'gg-muted', 'Нет изменённых файлов'));
    for (const file of f.files.slice(0, 500)) {
      const k = (file.code || '?')[0];
      const rowEl = el('button', 'gg-file');
      rowEl.setAttribute('data-no-i18n', '');
      const slash = file.rel.lastIndexOf('/');
      rowEl.append(el('span', 'gg-fk k' + k, k), el('span', 'gg-fname', slash >= 0 ? file.rel.slice(slash + 1) : file.rel));
      if (slash >= 0) rowEl.appendChild(el('span', 'gg-fdir', file.rel.slice(0, slash)));
      rowEl.title = file.rel;
      rowEl.onclick = () => showDiff(c, file.rel);
      files.appendChild(rowEl);
    }
    if (f.files.length > 500) files.appendChild(el('div', 'gg-muted', t('и ещё {0}', f.files.length - 500)));
  }
  function closeDetails() { details.classList.add('hidden'); details.innerHTML = ''; detSeq++; }
  async function showDiff(c, rel) {
    const { m, close } = makeModal(`
      <div class="mhead"><div><div class="mt"></div><div class="ms"></div></div><span class="grow"></span><button class="icon-btn" id="gg-dx" title="Закрыть" aria-label="Закрыть"></button></div>
      <div class="gg-diff"></div>`);
    m.classList.add('gg-diff-modal');
    m.querySelector('.mt').textContent = rel;
    m.querySelector('.mt').setAttribute('data-no-i18n', '');
    m.querySelector('.ms').textContent = `${c.h.slice(0, 7)} · ${c.s}`;
    m.querySelector('.ms').setAttribute('data-no-i18n', '');
    m.querySelector('#gg-dx').appendChild(icon('x', 16));
    m.querySelector('#gg-dx').onclick = close;
    const view2 = m.querySelector('.gg-diff');
    view2.appendChild(el('div', 'diff-empty', 'Загрузка…'));
    let r;
    try { r = await lite.git.commitFileDiff(proj.path, c.h, rel, c.p.length > 1); } catch (e) { r = { error: String(e) }; }
    if (r && r.error) { view2.textContent = ''; view2.appendChild(el('div', 'diff-empty', r.error)); toast(t('Граф Git: {0}', r.error), { kind: 'err' }); return; }
    renderDiffInto(view2, (r && r.diff) || '', rel);
  }

  // ── Поиск ─────────────────────────────────────────────────────────────────────────────────────
  let hitSet = new Set();
  function runSearch(q, jump) {
    search.q = q.trim().toLowerCase();
    if (!search.q) { search = { q: '', hits: [], i: -1 }; hitSet = new Set(); sCount.textContent = ''; renderVisible(true); return; }
    const prev = search.hits[search.i];
    search.hits = L.rows.filter(({ c }) => c.h.startsWith(search.q) || c.s.toLowerCase().includes(search.q) || c.an.toLowerCase().includes(search.q) || c.ae.toLowerCase().includes(search.q) || c.refs.toLowerCase().includes(search.q)).map((row) => row.c.h);
    hitSet = new Set(search.hits);
    search.i = prev && hitSet.has(prev) ? search.hits.indexOf(prev) : (search.hits.length ? 0 : -1);
    updateCount();
    if (jump && search.i >= 0) select(search.hits[search.i], true);
    else renderVisible(true);
  }
  function updateCount() {
    sCount.textContent = search.q ? (search.hits.length ? `${search.i + 1}/${search.hits.length}${more ? '+' : ''}` : '0') : '';
    sWrap.classList.toggle('none', !!search.q && !search.hits.length);
  }
  let sT = null;
  sInput.addEventListener('input', () => { clearTimeout(sT); sT = setTimeout(() => runSearch(sInput.value, true), 160); });
  sInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(sT);
      if (sInput.value.trim().toLowerCase() !== search.q) { runSearch(sInput.value, true); return; }
      if (!search.hits.length) return;
      search.i = (search.i + (e.shiftKey ? -1 : 1) + search.hits.length) % search.hits.length;
      updateCount();
      select(search.hits[search.i], true);
    } else if (e.key === 'Escape') { sInput.value = ''; runSearch('', false); canvas.focus(); }
  });

  // ── Мини-карта ───────────────────────────────────────────────────────────────────────────────
  const tokenColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function drawMini() {
    if (mini.classList.contains('hidden') || !L.rows.length) return;
    const W = 96, H = Math.max(80, Math.min(canvas.clientHeight - 120, 360));
    const dpr = window.devicePixelRatio || 1;
    if (mini.width !== W * dpr || mini.height !== H * dpr) { mini.width = W * dpr; mini.height = H * dpr; mini.style.width = W + 'px'; mini.style.height = H + 'px'; }
    const g = mini.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const n = L.rows.length;
    const maxC = L.rows.reduce((m, r) => Math.max(m, r.col), 0) + 1;
    const sx = Math.min(8, (W - 12) / maxC), sy = H / Math.max(n, 1);
    const cols = []; for (let i = 1; i <= COLORS; i++) cols[i] = tokenColor('--gg-' + i);
    const step = Math.max(1, Math.floor(n / (H * 2)));
    for (let i = 0; i < n; i += step) {
      const row = L.rows[i];
      g.fillStyle = cols[row.ch.color] || '#888';
      g.fillRect(6 + row.col * sx, i * sy, Math.max(2, sx - 2), Math.max(1.5, sy * step));
    }
    // рамка видимой области
    const ch = canvas.clientHeight || 600;
    const r0 = Math.max(0, (-view.y / view.z - PAD_Y) / ROW_H), r1 = Math.min(n, ((ch - view.y) / view.z - PAD_Y) / ROW_H);
    g.strokeStyle = tokenColor('--text-dim'); g.lineWidth = 1;
    g.fillStyle = tokenColor('--hover-2');
    const y0 = r0 * sy, hh = Math.max(6, (r1 - r0) * sy);
    g.fillRect(1, y0, W - 2, hh); g.strokeRect(1.5, y0 + 0.5, W - 3, hh - 1);
  }
  let miniDrag = false;
  const miniJump = (e) => {
    const r = mini.getBoundingClientRect();
    const H = r.height, n = L.rows.length;
    const row = Math.max(0, Math.min(n - 1, Math.round((e.clientY - r.top) / H * n)));
    const ch = canvas.clientHeight || 600;
    view.y = ch / 2 - rowY(row) * view.z; applyView();
  };
  mini.addEventListener('pointerdown', (e) => { miniDrag = true; mini.setPointerCapture(e.pointerId); miniJump(e); e.preventDefault(); });
  mini.addEventListener('pointermove', (e) => { if (miniDrag) miniJump(e); });
  mini.addEventListener('pointerup', (e) => { miniDrag = false; try { mini.releasePointerCapture(e.pointerId); } catch (_) {} });

  // ── Окно ──────────────────────────────────────────────────────────────────────────────────────
  window.addEventListener('focus', () => { checkFresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFresh(); });
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => applyView(), 60); });

  function isOpen() { return open; }
  function setOpen(o) {
    open = !!o;
    if (pane) pane.classList.toggle('hidden', !open);
    if (!open) return;
    const p = host.activeProject();
    // смена проекта — полная перезагрузка (и подъём к HEAD); тот же проект — только проверка свежести
    if (!proj || !p || p.path !== proj.path || !L.rows.length) { selected = null; search = { q: '', hits: [], i: -1 }; hitSet = new Set(); sInput.value = ''; sCount.textContent = ''; reload(false); }
    else checkFresh();
  }
  return {
    isOpen, setOpen,
    refresh: () => reload(true),
    toHead: () => toHead(true),
    fit,
    focusSearch: () => { sInput.focus(); sInput.select(); },
  };
}
