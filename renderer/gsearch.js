// Глобальный поиск по всем проектам (Ctrl+Shift+F) — «Найти во всех проектах» в духе PhpStorm.
//
// Одно окно, четыре области поиска: содержимое файлов, имена файлов, и то и другое, вывод открытых
// терминалов (последнее — прежний «поиск по всем терминалам», он никуда не делся, стал режимом).
// Файловые режимы идут через стриминговый бэкенд `gsearch:*` (main.js): результат приходит пачками,
// поэтому первые попадания видны сразу, а не после обхода всех проектов. Терминальный режим считается
// на месте, по буферам xterm.
//
// Файл лежит рядом с ui.js/codeedit.js как общий хелпер ядра (сайдбар проектов и его поиск — часть
// ядра, а не модуль-окно), но связи с renderer.js не имеет: всё, что нужно, приходит в host.
import { el, icon, hydrateIcons, makeModal, toast, baseName } from './ui.js';

const MODES = [
  { id: 'content', label: 'В содержимом' },
  { id: 'names', label: 'В именах файлов' },
  { id: 'both', label: 'Везде' },
  { id: 'terms', label: 'В терминалах' },
];
const RENDER_CAP = 2000;      // столько строк держим в DOM; остальное живёт только в счётчиках
const TERM_CAP = 600;         // потолок строк для режима терминалов (буферы читаются синхронно)
const PREVIEW_CTX = 12;       // строк контекста вокруг совпадения в предпросмотре
const HIST_MAX = 12;

// host: { projects, activeId, setActive, openInViewer, terms, jumpToSession, scanTermBuffer,
//         categories, STORE, persist }
export function openGlobalSearch(host, initial = {}) {
  const st = Object.assign({
    mode: 'content', caseSensitive: false, regex: false, wholeWord: false,
    include: '', exclude: '', scopeOff: [],
  }, (host.STORE && host.STORE.gsearch) || {}, initial);

  const { m, close } = makeModal(`
    <div class="gsx">
      <div class="gsx-head">
        <div class="gsx-qwrap">
          <span class="gsx-qic" data-icon="search" data-icon-size="15"></span>
          <input type="text" id="gsx-q" placeholder="что ищем во всех проектах…" spellcheck="false" autocomplete="off">
          <div class="gsx-flags">
            <button id="gsx-case" class="gsx-flag" title="Учитывать регистр">Aa</button>
            <button id="gsx-word" class="gsx-flag" title="Слово целиком">|W|</button>
            <button id="gsx-re" class="gsx-flag" title="Регулярное выражение">.*</button>
          </div>
        </div>
        <button id="gsx-run" class="btn primary">Искать</button>
        <button id="gsx-close" class="gsx-x" title="Закрыть (Esc)" data-icon="x" data-icon-size="15"></button>
      </div>
      <div class="gsx-modes" id="gsx-modes"></div>
      <div class="gsx-masks">
        <input type="text" id="gsx-incl" placeholder="только файлы: *.js, src/**">
        <input type="text" id="gsx-excl" placeholder="кроме файлов: *.min.js, docs/**">
      </div>
      <div id="gsx-hist" class="gsx-hist"></div>
      <div class="gsx-main">
        <aside class="gsx-scope">
          <div class="gsx-sub">Где искать</div>
          <div class="gsx-presets" id="gsx-presets"></div>
          <div class="gsx-projs" id="gsx-projs"></div>
        </aside>
        <div class="gsx-res" id="gsx-res"></div>
        <div class="gsx-prev" id="gsx-prev"></div>
      </div>
      <div class="gsx-foot"><span class="gsx-status" id="gsx-status"></span></div>
    </div>`, () => stopEverything());
  m.classList.add('gsx-modal');
  hydrateIcons(m);

  const $$ = (sel) => m.querySelector(sel);
  const qEl = $$('#gsx-q'), resEl = $$('#gsx-res'), prevEl = $$('#gsx-prev'), statusEl = $$('#gsx-status');
  const inclEl = $$('#gsx-incl'), exclEl = $$('#gsx-excl'), histEl = $$('#gsx-hist');

  // ── состояние выдачи ───────────────────────────────────────────────────────────────
  let runId = null;             // текущий запрос бэкенда (null = не ищем)
  let groups = new Map();       // rootId → { proj, box, body, cntEl, files: Map(rel → {box, body, cntEl, n}) }
  let totalHits = 0, totalFiles = 0, rendered = 0, capNoted = false;
  let selected = null;          // выделенная строка результата
  const offHit = host.lite.gsearch.onHit((p) => { if (p.runId === runId) addHits(p.hits || []); });
  const offProg = host.lite.gsearch.onProgress((p) => { if (p.runId === runId) setStatus(`Смотрю «${p.name || '…'}» · просмотрено файлов: ${p.scanned} · найдено: ${totalHits}`); });
  const offDone = host.lite.gsearch.onDone((p) => { if (p.runId === runId) finish(p); });

  function stopEverything() {
    if (runId) { try { host.lite.gsearch.cancel(runId); } catch (_) {} runId = null; }
    offHit(); offProg(); offDone();
  }
  const setStatus = (txt) => { statusEl.textContent = txt; };

  // ── область поиска: пресеты + чекбоксы проектов ────────────────────────────────────
  const projs = () => host.projects();
  // Область поиска хранится «от противного» — списком ИСКЛЮЧЁННЫХ проектов. Иначе проект, добавленный
  // после прошлого поиска, молча выпадал бы из области: сохранённый список выбранных его не знает.
  const off = new Set(Array.isArray(st.scopeOff) ? st.scopeOff : []);
  const chosen = new Set(projs().filter((p) => !off.has(p.id)).map((p) => p.id));
  function renderScope() {
    const box = $$('#gsx-projs');
    box.innerHTML = '';
    for (const p of projs()) {
      const row = el('label', 'gsx-proj');
      const cb = el('input');
      cb.type = 'checkbox'; cb.checked = chosen.has(p.id);
      cb.addEventListener('change', () => { cb.checked ? chosen.add(p.id) : chosen.delete(p.id); updateScopeInfo(); });
      const dot = el('span', 'gsx-dot');
      if (p.accent) dot.style.background = p.accent;
      const name = el('span', 'gsx-proj-name', p.name);
      name.title = p.path || '';
      row.append(cb, dot, name);
      if (p.favorite) row.appendChild(icon('star', 12));
      box.appendChild(row);
    }
    updateScopeInfo();
  }
  function updateScopeInfo() {
    const n = chosen.size;
    $$('#gsx-presets').dataset.count = String(n);
    const info = m.querySelector('.gsx-scope .gsx-sub');
    info.textContent = `Где искать — ${n} из ${projs().length}`;
  }
  function applyPreset(kind, arg) {
    chosen.clear();
    const all = projs();
    if (kind === 'all') all.forEach((p) => chosen.add(p.id));
    else if (kind === 'fav') all.filter((p) => p.favorite).forEach((p) => chosen.add(p.id));
    else if (kind === 'active') { const a = host.activeId(); if (a) chosen.add(a); }
    else if (kind === 'cat') all.filter((p) => p.category === arg).forEach((p) => chosen.add(p.id));
    else if (kind === 'none') { /* пусто */ }
    renderScope();
  }
  {
    const pres = $$('#gsx-presets');
    const btn = (label, kind, arg) => {
      const b = el('button', 'gsx-preset', label);
      b.addEventListener('click', () => applyPreset(kind, arg));
      pres.appendChild(b);
    };
    btn('Все', 'all'); btn('Избранное', 'fav'); btn('Текущий', 'active'); btn('Снять все', 'none');
    for (const c of host.categories()) btn(c, 'cat', c);
  }
  renderScope();

  // ── режимы и флаги ─────────────────────────────────────────────────────────────────
  const modeBtns = new Map();
  {
    const box = $$('#gsx-modes');
    for (const mo of MODES) {
      const b = el('button', 'gsx-mode', mo.label);
      b.addEventListener('click', () => { st.mode = mo.id; syncMode(); run(); });
      modeBtns.set(mo.id, b); box.appendChild(b);
    }
  }
  const flagEls = { caseSensitive: $$('#gsx-case'), wholeWord: $$('#gsx-word'), regex: $$('#gsx-re') };
  for (const [key, b] of Object.entries(flagEls))
    b.addEventListener('click', () => { st[key] = !st[key]; syncMode(); run(); });
  function syncMode() {
    for (const [id, b] of modeBtns) b.classList.toggle('on', id === st.mode);
    for (const [key, b] of Object.entries(flagEls)) b.classList.toggle('on', !!st[key]);
    const files = st.mode !== 'terms';
    m.querySelector('.gsx-masks').classList.toggle('off', !files);
    m.querySelector('.gsx-scope').classList.toggle('off', !files);
    prevEl.classList.toggle('hidden', !files);
  }
  qEl.value = initial.query || '';
  inclEl.value = st.include || ''; exclEl.value = st.exclude || '';
  syncMode();

  // ── история запросов ───────────────────────────────────────────────────────────────
  function hist() { return Array.isArray(host.STORE.gsearchHist) ? host.STORE.gsearchHist : []; }
  function pushHist(q) {
    const next = [q, ...hist().filter((x) => x !== q)].slice(0, HIST_MAX);
    host.persist('gsearchHist', next);
    renderHist();
  }
  function renderHist() {
    histEl.innerHTML = '';
    const items = hist();
    if (!items.length) { histEl.classList.add('hidden'); return; }
    histEl.classList.remove('hidden');
    histEl.appendChild(el('span', 'gsx-hist-lb', 'Недавнее:'));
    for (const q of items.slice(0, 8)) {
      const c = el('button', 'gsx-chip', q);
      c.addEventListener('click', () => { qEl.value = q; run(); });
      histEl.appendChild(c);
    }
  }
  renderHist();

  // ── запуск / остановка поиска ──────────────────────────────────────────────────────
  function resetResults() {
    resEl.innerHTML = ''; prevEl.innerHTML = '';
    groups = new Map(); totalHits = 0; totalFiles = 0; rendered = 0; capNoted = false; selected = null;
  }
  function saveState() {
    st.include = inclEl.value.trim(); st.exclude = exclEl.value.trim();
    st.scopeOff = projs().filter((p) => !chosen.has(p.id)).map((p) => p.id);
    host.persist('gsearch', { mode: st.mode, caseSensitive: st.caseSensitive, regex: st.regex, wholeWord: st.wholeWord, include: st.include, exclude: st.exclude, scopeOff: st.scopeOff });
  }
  async function run() {
    const query = qEl.value;
    if (runId) { try { await host.lite.gsearch.cancel(runId); } catch (_) {} runId = null; }
    resetResults();
    if (!query || query.length < 2) { setStatus('Введите минимум 2 символа'); setRunning(false); return; }
    saveState(); pushHist(query);
    if (st.mode === 'terms') { runTerms(query); return; }
    const roots = projs().filter((p) => chosen.has(p.id) && p.path).map((p) => ({ id: p.id, name: p.name, path: p.path }));
    if (!roots.length) { setStatus('Не выбрано ни одного проекта'); setRunning(false); return; }
    const id = 'gsx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    runId = id;
    setRunning(true);
    setStatus('Ищу…');
    const r = await host.lite.gsearch.start(id, query, {
      mode: st.mode, caseSensitive: st.caseSensitive, regex: st.regex, wholeWord: st.wholeWord,
      include: st.include, exclude: st.exclude,
    }, roots);
    if (!r || r.ok === false) {
      runId = null; setRunning(false);
      // строки цельные, без склейки: иначе половина фразы осталась бы непереведённой
      if (r && r.error) { toast(`Поиск: ${r.error}`, { kind: 'err' }); setStatus(r.error); }
      else { toast('Не удалось запустить поиск', { kind: 'err' }); setStatus('Не удалось запустить поиск'); }
    }
  }
  function setRunning(on) {
    const b = $$('#gsx-run');
    b.textContent = on ? 'Стоп' : 'Искать';
    b.classList.toggle('busy', on);
  }
  function finish(p) {
    runId = null; setRunning(false);
    if (p.error) { toast(`Поиск: ${p.error}`, { kind: 'err' }); }
    const parts = [];
    parts.push(p.cancelled ? 'Остановлено' : 'Готово');
    parts.push(`совпадений: ${totalHits}`);
    parts.push(`файлов: ${totalFiles}`);
    parts.push(`проектов: ${groups.size}`);
    parts.push(`просмотрено: ${p.scanned}`);
    parts.push(`${(p.ms / 1000).toFixed(1)} с`);
    if (p.capped) parts.push('достигнут потолок выдачи');
    if (p.error) parts.push(`ошибка: ${p.error}`);
    setStatus(parts.join(' · '));
    if (!totalHits && !p.error) setStatus(`Ничего не найдено · просмотрено файлов: ${p.scanned}`);
  }

  // ── инкрементальный рендер выдачи ──────────────────────────────────────────────────
  function groupFor(rootId) {
    let g = groups.get(rootId);
    if (g) return g;
    const proj = projs().find((p) => p.id === rootId) || { id: rootId, name: '—', path: '' };
    const box = el('div', 'gsx-group');
    const head = el('div', 'gsx-ghead');
    const dot = el('span', 'gsx-dot');
    if (proj.accent) dot.style.background = proj.accent;
    const cntEl = el('span', 'gsx-cnt', '0');
    head.append(dot, el('span', 'gsx-gname', proj.name), cntEl);
    const pathEl = el('span', 'gsx-gpath', proj.path || '');
    head.appendChild(pathEl);
    const body = el('div', 'gsx-gbody');
    head.addEventListener('click', () => body.classList.toggle('hidden'));
    box.append(head, body);
    resEl.appendChild(box);
    g = { proj, box, body, cntEl, n: 0, files: new Map() };
    groups.set(rootId, g);
    return g;
  }
  function fileFor(g, rel) {
    let f = g.files.get(rel);
    if (f) return f;
    const box = el('div', 'gsx-file');
    const head = el('div', 'gsx-fhead');
    head.appendChild(icon('file', 13));
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    head.appendChild(el('span', 'gsx-fdir', dir));
    head.appendChild(el('span', 'gsx-fname', baseName(rel)));
    const cntEl = el('span', 'gsx-cnt', '0');
    head.appendChild(cntEl);
    const body = el('div', 'gsx-fbody');
    head.addEventListener('click', () => body.classList.toggle('hidden'));
    box.append(head, body);
    g.body.appendChild(box);
    totalFiles++;
    f = { box, body, cntEl, n: 0 };
    g.files.set(rel, f);
    return f;
  }
  function addHits(hits) {
    for (const h of hits) {
      totalHits++;
      const g = groupFor(h.rootId);
      g.n++; g.cntEl.textContent = String(g.n);
      const f = fileFor(g, h.file);
      f.n++; f.cntEl.textContent = String(f.n);
      if (rendered >= RENDER_CAP) {
        if (!capNoted) { capNoted = true; resEl.appendChild(el('div', 'gsx-more', `Показаны первые ${RENDER_CAP} строк — уточните запрос или область поиска`)); }
        continue;
      }
      rendered++;
      f.body.appendChild(hitRow(g.proj, h));
    }
    if (runId) setStatus(`Ищу… найдено: ${totalHits} в ${totalFiles} файлах (${groups.size} проектов)`);
  }
  // Строка выдачи: номер + текст с подсветкой совпадения. Текст кладём узлами, а не innerHTML —
  // содержимое чужих файлов не должно попадать в разметку.
  function hitRow(proj, h) {
    const row = el('div', 'gsx-hit');
    row.appendChild(el('span', 'gsx-ln', h.line ? String(h.line) : '—'));
    const txt = el('span', 'gsx-text');
    const s = String(h.text || '');
    const a = Math.max(0, h.mcol | 0), b = Math.min(s.length, a + (h.len | 0));
    if (b > a) {
      txt.appendChild(document.createTextNode(s.slice(0, a)));
      txt.appendChild(el('mark', 'gsx-mark', s.slice(a, b)));
      txt.appendChild(document.createTextNode(s.slice(b)));
    } else txt.textContent = s;
    row.appendChild(txt);
    const abs = (proj.path || '').replace(/\/+$/, '') + '/' + h.file;
    row.addEventListener('click', () => { select(row); showPreview(proj, h, abs); });
    row.addEventListener('dblclick', () => openHit(proj, h, abs));
    row.dataset.line = String(h.line || 0);
    row._open = () => openHit(proj, h, abs);
    row._prev = () => showPreview(proj, h, abs);
    return row;
  }
  function select(row) {
    if (selected) selected.classList.remove('sel');
    selected = row;
    if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
  }
  function openHit(proj, h, abs) {
    if (proj.id && proj.id !== host.activeId()) host.setActive(proj.id);   // вивер следует за активным проектом
    host.openInViewer(abs, h.line || 1);
    close();
  }

  // ── предпросмотр найденного места ──────────────────────────────────────────────────
  let prevFile = null, prevText = null;
  async function showPreview(proj, h, abs) {
    prevEl.innerHTML = '';
    const head = el('div', 'gsx-prev-head');
    head.appendChild(el('span', 'gsx-prev-path', h.file));
    const openBtn = el('button', 'btn gsx-prev-open', 'Открыть');
    openBtn.addEventListener('click', () => openHit(proj, h, abs));
    head.appendChild(openBtn);
    prevEl.appendChild(head);
    if (!h.line) { prevEl.appendChild(el('div', 'gsx-prev-note', 'Совпадение в имени файла')); return; }
    if (prevFile !== abs) {
      const r = await host.lite.fs.readFile(abs);
      if (!r || r.error) { prevEl.appendChild(el('div', 'gsx-prev-note', (r && r.error) || 'не удалось прочитать файл')); return; }
      prevFile = abs; prevText = r.content;
    }
    const rows = String(prevText).split('\n');
    const from = Math.max(0, h.line - 1 - PREVIEW_CTX), to = Math.min(rows.length, h.line + PREVIEW_CTX);
    const pre = el('div', 'gsx-prev-code');
    for (let i = from; i < to; i++) {
      const ln = el('div', 'gsx-prev-row' + (i + 1 === h.line ? ' hit' : ''));
      ln.appendChild(el('span', 'gsx-prev-ln', String(i + 1)));
      ln.appendChild(el('span', 'gsx-prev-src', rows[i]));
      pre.appendChild(ln);
    }
    prevEl.appendChild(pre);
    requestAnimationFrame(() => { const hitRowEl = pre.querySelector('.hit'); if (hitRowEl) hitRowEl.scrollIntoView({ block: 'center' }); });
  }

  // ── режим «в терминалах» (буферы открытых сессий, без похода в main) ───────────────
  function runTerms(query) {
    setRunning(false);
    let total = 0;
    for (const [sid, rec] of host.terms()) {
      if (total >= TERM_CAP) break;
      const hits = host.scanTermBuffer(rec.term, query);
      if (!hits.length) continue;
      const proj = projs().find((p) => p.id === rec.projId) || { id: rec.projId, name: '—', path: '' };
      const g = groupFor(rec.projId);
      const f = fileFor(g, rec.name || 'терминал');
      for (const h of hits) {
        if (total >= TERM_CAP) break;
        total++; totalHits++; g.n++; f.n++;
        const row = el('div', 'gsx-hit');
        row.appendChild(el('span', 'gsx-ln', String(h.y)));
        row.appendChild(el('span', 'gsx-text', h.text));
        const jump = () => { host.jumpToSession(rec.projId, sid); requestAnimationFrame(() => { try { rec.term.scrollToLine(Math.max(0, h.y - 2)); rec.search.findNext(query); } catch (_) {} }); close(); };
        row.addEventListener('click', () => select(row));
        row.addEventListener('dblclick', jump);
        row._open = jump; row._prev = () => {};
        f.body.appendChild(row);
      }
      g.cntEl.textContent = String(g.n); f.cntEl.textContent = String(f.n);
      void proj;
    }
    setStatus(total ? `Найдено ${total} строк в ${totalFiles} сессиях (${groups.size} проектов)` : 'Ничего не найдено в открытых сессиях');
  }

  // ── клавиатура и запуск ────────────────────────────────────────────────────────────
  let timer = null;
  qEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); run(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  });
  for (const inp of [inclEl, exclEl]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $$('#gsx-run').addEventListener('click', () => { if (runId) { host.lite.gsearch.cancel(runId); } else run(); });
  $$('#gsx-close').addEventListener('click', close);
  function moveSel(dir) {
    const rows = [...m.querySelectorAll('.gsx-hit')].filter((r) => r.offsetParent !== null);
    if (!rows.length) return;
    const i = selected ? rows.indexOf(selected) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + dir))] || rows[0];
    select(next);
    if (next._prev) next._prev();
  }
  m.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && e.target !== qEl) { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter' && selected && e.target !== qEl) { e.preventDefault(); selected._open && selected._open(); }
  });
  setTimeout(() => { qEl.focus(); qEl.select(); }, 30);
  if (initial.query) run();
  return { close };
}
