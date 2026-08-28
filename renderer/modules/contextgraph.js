// LiteEditor — модуль «Контекст»: канва файла CLAUDE.md + память, файлы .claude, анализ диалогов.
//
// ⚠️ МОДЕЛЬ КАНВЫ (переделана в v1.1.137): единственный носитель текста — САМ ФАЙЛ
// <proj>/CLAUDE.md. Блок на канве = секция файла (заголовок + текст до следующего заголовка),
// порядок блоков сверху вниз = порядок разделов в файле. Модуль хранит только раскладку.
// Любая правка сразу пишет файл целиком и кладёт ПРЕЖНЮЮ версию в историю (50 копий, замки).
// Профили, тумблеры блоков, «Подтвердить» и реконсиляция убраны: канва не может разойтись с файлом.
//
// Изолирован по канону: всё из ядра — через host-колбэки, UI — из ui.js, бэкенд — window.lite.*.
// host: { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels }
import { el, icon, toast, makeModal, showConfirm, showPrompt } from '../ui.js';
import { MergeView } from '@codemirror/merge';
import { marked } from 'marked';
import { t } from '../i18n.js';
import { createCodeEditor, languageFor, ensureLanguage, mergeRoExtensions } from '../codeedit.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

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

  // ── Модель (v1.1.137): единственный носитель текста — сам файл CLAUDE.md ────────────────────
  // Блок на канве = секция файла (заголовок + текст до следующего заголовка). Порядок блоков
  // СВЕРХУ ВНИЗ по канве = порядок секций в файле. Модуль хранит только раскладку (позиции).
  // Любая правка содержания пишет файл целиком и кладёт ПРЕЖНЮЮ версию в историю.
  let open = false;
  let proj = null;          // {id, path, name}
  let blocks = [];          // [{id, title, content, chars, x, y}] — id локальный, живёт только в сессии
  let view = { x: 0, y: 0, z: 1 };
  let fileText = '';        // последнее прочитанное содержимое файла
  let fileHash = '';        // его хэш — защита от записи поверх чужой правки
  let fileExists = false;
  let points = [];          // история версий [{id,name,ts,locked,note,chars}]
  let sel = null;           // id выделенного блока
  let loadSeq = 0;
  let externalChange = false;
  let watchedProj = null;
  let busy = false;         // идёт запись — не даём параллельных мутаций
  let modalOpen = false;    // открыта модалка блока → авторазбитие ждёт
  let blockPreviewMode = false;  // «Оригинал/Превью» в модалке раздела — общий на все разделы
  let extTimer = null;      // «устаканивание» перед перечитыванием файла
  // Открытые редакторы с несохранёнными правками (раздел канвы, файл памяти, файл .claude).
  // Нужны при закрытии ОКНА: оболочка спрашивает модуль через confirmClose, и без этого набора
  // окно закрывалось молча вместе с несохранённым текстом. Множество, а не флаг: модалки
  // складываются друг на друга (из «Анализа диалогов» открывается редактор файла).
  const dirtyEditors = new Set();
  let dirtyKeySeq = 0;
  const markDirty = (key, on) => { if (on) dirtyEditors.add(key); else dirtyEditors.delete(key); };
  let loadedProj = null;    // для какого проекта канва реально прочитана (см. onProjectChange/setTab)

  const canvas = $('#ctx-canvas');
  const world = $('#ctx-world');
  const nodesBox = $('#ctx-nodes');
  const onboardDismissed = () => { try { return localStorage.getItem('lite.ctx.onboard') === '1'; } catch (_) { return false; } };
  function dismissOnboard() { try { localStorage.setItem('lite.ctx.onboard', '1'); } catch (_) {} const ob = $('#ctx-onboard'); if (ob) ob.hidden = true; }

  // Заголовок блока = первый markdown-заголовок контента (заголовки внутри ```-кода игнорируем).
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
    return first || 'Блок';
  }
  // Срезать ПУСТЫЕ строки по краям блока, не трогая отступы. Обычный trim() съедал ведущие пробелы
  // первой строки — и раздел, начинающийся с отступного блока кода (4 пробела), после сохранения
  // переставал быть кодом: markdown видел обычный абзац.
  const trimBlank = (s) => String(s == null ? '' : s).replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
  // Файл → секции. ЛЮБОЙ заголовок начинает новую секцию; преамбула до первого заголовка — тоже блок.
  function splitSections(src) {
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
    const out = [];
    const firstI = heads.length ? heads[0].i : lines.length;
    const pre = trimBlank(lines.slice(0, firstI).join('\n'));
    if (pre.trim()) out.push({ title: titleFromContent(pre), content: pre });
    for (let k = 0; k < heads.length; k++) {
      const to = k + 1 < heads.length ? heads[k + 1].i : lines.length;
      const content = trimBlank(lines.slice(heads[k].i, to).join('\n'));
      if (content.trim()) out.push({ title: heads[k].title.slice(0, 60) || 'Блок', content });
    }
    return out;
  }
  // Порядок разделов в файле задаётся полем ord (позиция при чтении файла), а НЕ координатами:
  // расстановка карточек на канве — дело удобства и файл не трогает.
  const ordered = () => blocks.slice().sort((a, b) => a.ord - b.ord);
  const assemble = () => ordered().map((b) => trimBlank(b.content)).filter((x) => x.trim()).join('\n\n') + '\n';
  const totalChars = () => blocks.reduce((s, b) => s + (b.chars || 0), 0);

  // ── Загрузка ───────────────────────────────────────────────────────────────────────────────
  function setOpen(o, opts = {}) {
    const p = activeProject();
    if (o && !p && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (o === open) { if (o && p) onProjectChange(p); else if (o) onProjectGone(); return; }
    if (o) closeOtherPanels('ctx');
    const delta = layout.ctx + GUTTER;
    open = o;
    if (!o) stopWatch();
    $('#ctx-pane').classList.toggle('hidden', !o);
    $('#gutter-ctx').classList.toggle('hidden', !o);
    if (opts.grow !== false) lite.win.growBy(o ? delta : -delta);
    saveUiState();
    if (o && p) loadCanvas(p);
    setTimeout(refitActiveTerminal, 150);
  }
  const toggle = () => setOpen(!open);

  function startWatch() {
    if (!proj) return;
    if (watchedProj && watchedProj !== proj.id) { lite.ctx.unwatchOutputs(watchedProj); watchedProj = null; }
    if (watchedProj !== proj.id) { lite.ctx.watchOutputs(proj.id, proj.path); watchedProj = proj.id; }
  }
  function stopWatch() {
    if (watchedProj) { lite.ctx.unwatchOutputs(watchedProj); watchedProj = null; }
    clearTimeout(extTimer);
    externalChange = false; renderExtern();
  }
  function renderExtern() { const b = $('#ctx-extern'); if (b) b.hidden = !externalChange; }

  async function loadCanvas(p) {
    proj = { id: p.id, path: p.path, name: p.name };
    startWatch();
    const seq = ++loadSeq;
    if (!lite.ctx || typeof lite.ctx.state !== 'function') {
      toast(t('Эта возможность появилась в новой версии — перезапустите редактор, чтобы она заработала'), { kind: 'warn', ttl: 9000 });
      return;
    }
    const r = await lite.ctx.state(p.id, p.path);
    if (seq !== loadSeq || !open) return;
    if (!r || !r.ok) { toast(t('Не прочитать CLAUDE.md: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
    applyState(r);
    loadedProj = p.id;
  }
  // Раскладка накладывается на секции по заголовку: у знакомых блоков позиция сохраняется,
  // новые (агент дописал раздел) встают в конец колонки — так перестройка не рушит расстановку.
  function applyState(r) {
    fileText = r.text || ''; fileHash = r.hash || ''; fileExists = !!r.exists;
    points = r.points || [];
    const lay = (r.graph && Array.isArray(r.graph.layout)) ? r.graph.layout : [];
    view = (r.graph && r.graph.view && typeof r.graph.view.z === 'number') ? r.graph.view : { x: 0, y: 0, z: 1 };
    const byTitle = new Map();
    for (const l of lay) if (!byTitle.has(l.title)) byTitle.set(l.title, l);
    blocks = splitSections(fileText).map((sec, i) => {
      const known = byTitle.get(sec.title);
      if (known) byTitle.delete(sec.title);
      const g = gridSlot(i);
      return { id: 'b' + i + '-' + Math.random().toString(36).slice(2, 6), title: sec.title, content: sec.content,
        chars: sec.content.length, ord: i,
        x: known && known.x != null ? known.x : g.x, y: known && known.y != null ? known.y : g.y };
    });
    sel = null;
    renderAll();
    maybeFit();
  }
  // Сетка: место i-го блока при выравнивании — по столбцам сверху вниз, потом вправо.
  function gridSlot(i) {
    const rows = Math.max(1, Math.floor((canvas.clientHeight - 80) / ROW_H)) || 4;
    return { x: 60 + Math.floor(i / rows) * COL_W, y: 40 + (i % rows) * ROW_H };
  }
  // «Выровнять» — разложить карточки сеткой в порядке разделов файла. Файл не трогает.
  function alignGrid() {
    ordered().forEach((b, i) => { const g = gridSlot(i); b.x = g.x; b.y = g.y; });
    renderNodes(); saveLayout();
    setTimeout(fitView, 60);
  }
  // Активного проекта не стало (закрыли последний / удалили из списка). Показывать его данные
  // дальше нельзя: человек считает проект закрытым, а правка ушла бы в его файл.
  function onProjectGone() {
    stopWatch();
    proj = null;
    resetCanvasState();
    mem.data = null; mem.path = null; mem.open.clear();
    cfs.data = null; cfs.sel = null;
    mineForget();
    if (curTab === 'mem') renderMem();
    else if (curTab === 'files') renderFiles();
    else if (curTab === 'mine') renderMine();
  }
  // Забыть реестр правил В ПАМЯТИ (сохранённый в localStorage остаётся и поднимется обратно, когда
  // проект снова станет активным). Без этого карточки закрытого проекта продолжали висеть на
  // вкладке, а действия над ними молча ничего не делали.
  function mineForget() {
    mine.rules = []; mine.done = []; mine.remaining = 0; mine.totalFiles = 0; mine.batches = 0;
    mine.summary = ''; mine.sel = new Set(); mine.scanned = null; mine.scanPath = null;
    mine.ctx = null; mine.raw = '';
  }
  function onProjectChange(p) {
    if (open && p && curTab === 'canvas') loadCanvas(p);
    else if (open && p) { proj = { id: p.id, path: p.path, name: p.name }; resetCanvasState(); }
    if (open && curTab === 'mine') mineScan();
    if (open && curTab === 'mem') { mem.data = null; mem.path = null; memLoad(); }
    if (open && curTab === 'files') { cfs.data = null; cfsLoad(); }
  }

  // Сбросить прочитанное: проект сменился, а перечитывать канву сейчас незачем (открыта другая
  // вкладка). Пустое состояние безопасно — persist() из него ничего не запишет.
  function resetCanvasState() {
    blocks = []; fileText = ''; fileHash = ''; fileExists = false; points = []; sel = null;
    loadedProj = null; fitted = false;
    externalChange = false; renderExtern();
    renderAll();   // и в скрытой вкладке тоже: иначе в DOM висят карточки прежнего проекта
  }

  // ── Запись файла ───────────────────────────────────────────────────────────────────────────
  // Единственная точка, где файл меняется. Копия ПРЕЖНЕЙ версии снимается на стороне main.
  async function persist(name, note) {
    if (!proj || busy) return false;
    if (loadedProj !== proj.id) { toast(t('Канва ещё не перечитана под этот проект'), { kind: 'warn' }); return false; }   // пустое/чужое состояние в файл не пишем
    busy = true;
    try {
      const text = assemble();
      const r = await lite.ctx.save({ projId: proj.id, projPath: proj.path, text, name, note, expectHash: fileHash });
      if (!r || !r.ok) {
        if (r && r.stale) { // агент успел записать файл первым — не затираем, показываем расхождение
          externalChange = true; renderExtern();
          toast(t('Файл изменился снаружи — канва обновлена, повторите правку'), { kind: 'warn', ttl: 9000 });
          await reloadFromDisk();
          return false;
        }
        toast(t('Не сохранить CLAUDE.md: {0}', (r && r.error) || '?'), { kind: 'err' });
        return false;
      }
      fileText = text; fileHash = r.hash; fileExists = true; points = r.points || points;
      externalChange = false; renderExtern();
      saveLayout();
      renderAll();
      return true;
    } finally { busy = false; }
  }
  function saveLayout() {
    if (!proj) return;
    const lay = ordered().map((b) => ({ title: b.title, x: b.x, y: b.y }));
    try { lite.ctx.layout(proj.id, { v: 2, layout: lay, view }).catch(() => {}); } catch (_) {}   // раскладка — вещь необязательная: молча переживаем отказ
  }
  async function reloadFromDisk() {
    if (!proj) return;
    const seq = ++loadSeq;
    const r = await lite.ctx.state(proj.id, proj.path);
    if (seq !== loadSeq || !r || !r.ok) return;
    applyState(r);
  }

  // ── Рендер ─────────────────────────────────────────────────────────────────────────────────
  function renderAll() {
    if (!proj) { nodesBox.innerHTML = ''; renderStats(); return; }
    applyView();
    renderNodes();
    renderStats();
    const ob = $('#ctx-onboard');
    if (ob) ob.hidden = !(blocks.length === 0 && !onboardDismissed());
  }
  function applyView() { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`; }
  function renderNodes() {
    nodesBox.innerHTML = '';
    for (const b of blocks) {
      const box = el('div', 'ctx-node' + (sel === b.id ? ' sel' : ''));
      box.dataset.id = b.id;
      box.style.left = b.x + 'px'; box.style.top = b.y + 'px';
      const head = el('div', 'ctx-nhead');
      head.appendChild(icon('note', 14));
      head.appendChild(el('span', 'ctx-ntitle', b.title));
      box.appendChild(head);
      const body = el('div', 'ctx-nbody');
      const prev = el('div', 'ctx-nprev');
      // заголовок уже в шапке карточки — в превью его не дублируем, показываем только тело
      const lines = b.content.replace(/\r\n?/g, '\n').split('\n');
      const start = /^#{1,6}\s/.test(lines[0] || '') ? 1 : 0;
      const tail = lines.slice(start).filter((l, i) => i > 0 || l.trim()).slice(0, 4).join('\n');
      if (tail.trim()) renderSafeMarkdown(prev, tail);
      else prev.appendChild(el('div', 'ctx-nempty', 'пусто'));
      body.appendChild(prev);
      box.appendChild(body);
      const foot = el('div', 'ctx-nfoot');
      foot.appendChild(el('span', 'ctx-nchars', fmtTok(b.chars || 0)));
      const acts = el('div', 'ctx-nacts');
      const act = (ic, title, fn) => {
        const btn = el('button', 'ctx-nact');
        btn.appendChild(icon(ic, 13)); btn.title = title;
        btn.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        acts.appendChild(btn);
      };
      act('pencil', 'Редактировать блок', () => modalBlock(b));
      act('terminal', 'Спросить агента про этот раздел (вставить в терминал, без Enter)', () => askAbout(b));
      act('trash', 'Удалить блок из файла', () => deleteBlock(b));
      foot.appendChild(acts);
      box.appendChild(foot);

      nodesBox.appendChild(box);
    }
  }
  function renderStats() {
    const bar = $('#ctx-stats'); if (!bar) return;
    bar.textContent = '';
    if (!proj) { bar.appendChild(el('span', 'ctx-chip', 'Проект не открыт')); return; }
    const name = el('span', 'ctx-chip' + (fileExists ? '' : ' off'));
    name.appendChild(el('b', null, 'CLAUDE.md'));
    name.appendChild(el('span', null, fileExists ? fmtTok(totalChars()) : 'файла нет'));
    name.title = proj.path + '/CLAUDE.md';
    bar.appendChild(name);
    if (fileExists) bar.appendChild(el('span', 'ctx-chip', `${blocks.length} ${plural(blocks.length, 'блок', 'блока', 'блоков')}`));
    if (points.length) bar.appendChild(el('span', 'ctx-chip', `${points.length} ${plural(points.length, 'версия', 'версии', 'версий')} в истории`));
    bar.appendChild(el('span', 'ctx-hint', 'Правки пишутся в файл сразу, прежняя версия — в историю'));
  }
  const NODE_W = 260, ROW_H = 150, COL_W = 296;   // шаг сетки: карточка (260px) + зазор
  function fitView() {
    if (!blocks.length) { view = { x: 40, y: 40, z: 1 }; applyView(); saveLayout(); return; }
    const r = canvas.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of blocks) {
      const h = (nodesBox.querySelector(`.ctx-node[data-id="${CSS.escape(b.id)}"]`) || {}).offsetHeight || 120;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + NODE_W); maxY = Math.max(maxY, b.y + h);
    }
    const pad = 40;
    const z = Math.min(1, Math.min((r.width - pad * 2) / Math.max(1, maxX - minX), (r.height - pad * 2) / Math.max(1, maxY - minY)));
    view = { z: Math.max(0.25, z), x: pad - minX * z, y: pad - minY * z };
    applyView(); saveLayout();
  }
  let fitted = false;
  function maybeFit() { if (!fitted && blocks.length) { fitted = true; setTimeout(fitView, 80); } }

  // ── Перетаскивание и панорама ──────────────────────────────────────────────────────────────
  // Перетаскивание — ТОЛЬКО расстановка карточек: файл оно не трогает и копию не снимает.
  // Порядок разделов в файле задаётся полем ord (как прочитали), менять его мышью нельзя.
  let drag = null;
  let lastTap = { id: null, t: 0 };   // ручной двойной клик (см. pointerup)
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !proj) return;
    if (e.target.closest('button')) return;
    const nodeEl = e.target.closest('.ctx-node');
    if (nodeEl) {
      const b = blocks.find((x) => x.id === nodeEl.dataset.id);
      if (!b) return;
      sel = b.id;   // ⚠️ без renderNodes(): пересоздание узла между кликами ломает dblclick
      nodesBox.querySelectorAll('.ctx-node.sel').forEach((n) => n.classList.remove('sel'));
      nodeEl.classList.add('sel');
      drag = { kind: 'node', b, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, moved: false };
      canvas.setPointerCapture(e.pointerId); e.preventDefault();
      return;
    }
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    canvas.setPointerCapture(e.pointerId);
    sel = null;
    nodesBox.querySelectorAll('.ctx-node.sel').forEach((n) => n.classList.remove('sel'));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'node') {
      const dx = (e.clientX - drag.sx) / view.z, dy = (e.clientY - drag.sy) / view.z;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
      drag.b.x = Math.round(drag.ox + dx); drag.b.y = Math.round(drag.oy + dy);
      const elx = nodesBox.querySelector(`.ctx-node[data-id="${CSS.escape(drag.b.id)}"]`);
      if (elx) { elx.style.left = drag.b.x + 'px'; elx.style.top = drag.b.y + 'px'; }
    } else {
      view.x = drag.vx + (e.clientX - drag.sx); view.y = drag.vy + (e.clientY - drag.sy);
      applyView();
    }
  });
  canvas.addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.kind === 'pan') { saveLayout(); return; }
    if (d.moved) { saveLayout(); lastTap = { id: null, t: 0 }; return; }
    // не двигали — это клик. Второй клик по той же карточке за 400 мс = открыть раздел.
    const now = Date.now();
    if (lastTap.id === d.b.id && now - lastTap.t < 400) { lastTap = { id: null, t: 0 }; modalBlock(d.b); }
    else lastTap = { id: d.b.id, t: now };
  });
  canvas.addEventListener('wheel', (e) => {
    if (!proj) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const z2 = Math.max(0.25, Math.min(2.5, view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    view.x = cx - (cx - view.x) * (z2 / view.z); view.y = cy - (cy - view.y) * (z2 / view.z); view.z = z2;
    applyView(); saveLayout();
  }, { passive: false });

  // ── Мутации ────────────────────────────────────────────────────────────────────────────────
  async function addBlock() {
    if (!proj) { toast('Сначала открой проект'); return; }
    showPrompt('Новый раздел', 'Заголовок', '', async (title) => {
      const name = String(title || '').trim() || 'Новый раздел';
      const g = gridSlot(blocks.length);
      blocks.push({ id: 'b' + Date.now().toString(36), title: name, content: `## ${name}\n\n`, chars: name.length + 6, ord: blocks.length, x: g.x, y: g.y });
      if (!(await persist('Добавлен раздел', name))) return;
      await reloadFromDisk();
      const created = blocks.find((b) => b.title === name);
      if (created) modalBlock(created);
    });
  }
  function deleteBlock(b) {
    showConfirm('Удалить раздел из файла?', `«${b.title}» исчезнет из CLAUDE.md. Прежняя версия файла уйдёт в историю — откат в один клик.`, 'Удалить', async () => {
      blocks = blocks.filter((x) => x.id !== b.id);
      if (await persist('Удалён раздел', b.title)) toast(t('Раздел удалён, прежняя версия в истории'), { ttl: 6000 });
      else await reloadFromDisk();
    });
  }
  function askAbout(b) {
    if (!proj) return;
    lite.editorBus.sendToTerminal(`В ${proj.path}/CLAUDE.md есть раздел «${b.title}». `);
    toast(t('Вставлено в терминал проекта — допишите вопрос и нажмите Enter'), { ttl: 7000 });
  }

  // ── Модалка блока: слева список разделов, справа редактор ─────────────────────────────────
  // Открыл — листаешь разделы, правишь, сохраняешь, не выходя наружу. Список слева на всю высоту:
  // видно оглавление файла целиком и можно прыгать между разделами.
  function modalBlock(startBlock) {
    let editor = null, cur = startBlock, dirty = false;
    let preview = blockPreviewMode;   // режим показа общий для всех разделов и переживает переход
    const dirtyKey = 'block:' + (++dirtyKeySeq);
    modalOpen = true;
    const { m, close } = makeModal(`<div class="ctx-bl-top">
        <h2>Разделы CLAUDE.md</h2>
        <button class="ctx-x" id="cxm-x" title="Закрыть">✕</button>
      </div>
      <div class="ctx-bl-grid">
        <div class="ctx-bl-side">
          <div class="ctx-bl-sidehead">Оглавление</div>
          <div id="cxm-list" class="ctx-bl-list"></div>
        </div>
        <div class="ctx-bl-main">
          <div class="about-desc mem-ed-sub" id="cxm-path"></div>
          <div class="ctx-medbar">
            <div class="ctx-seg">
              <button class="ctx-segbtn on" id="cxm-mode-edit">✎ Оригинал</button>
              <button class="ctx-segbtn" id="cxm-mode-view">👁 Превью</button>
            </div>
            <span id="cxm-chars" class="ctx-mchars"></span>
            <div class="mine-fl-sp"></div>
            <button class="btn sm" id="cxm-prev-b" title="Предыдущий раздел">◀</button>
            <button class="btn sm" id="cxm-next-b" title="Следующий раздел">▶</button>
          </div>
          <div class="fed-body">
            <div id="cxm-ed" class="ctx-med"></div>
            <div id="cxm-prev" class="fed-prev" hidden></div>
          </div>
          <div class="modal-actions">
            <button class="btn danger-btn" id="cxm-del">Удалить раздел</button>
            <button class="btn" id="cxm-cancel">Закрыть</button>
            <button class="btn primary" id="cxm-save" hidden>Сохранить</button>
          </div>
        </div>
      </div>`, () => { modalOpen = false; markDirty(dirtyKey, false); if (editor) editor.destroy(); });
    m.classList.add('ctx-modal', 'ctx-modal-block');
    const listEl = m.querySelector('#cxm-list');
    const pathEl = m.querySelector('#cxm-path');
    const chars = m.querySelector('#cxm-chars');
    const saveBtn = m.querySelector('#cxm-save');
    const prevBox = m.querySelector('#cxm-prev');
    const host2 = m.querySelector('#cxm-ed');
    let orig = '';

    const recheck = () => {
      dirty = !!editor && editor.getValue() !== orig;
      markDirty(dirtyKey, dirty);
      saveBtn.hidden = !dirty;
      m.querySelector('#cxm-cancel').textContent = dirty ? 'Отмена' : 'Закрыть';
      drawList();
      return dirty;
    };
    const mkEditor = (doc, lang) => createCodeEditor(host2, {
      doc, wrap: true, fold: true, language: lang || [],
      onChange: (v) => { chars.textContent = fmtTok(v.length); recheck(); },
    });
    // Показать раздел в редакторе. Если текущий не сохранён — сначала спросим.
    function openBlock(b, force) {
      if (!b) return;
      if (!force && dirty) {
        showConfirm('Раздел не сохранён', `В «${cur.title}» есть правки. Сохранить перед переходом?`,
          'Сохранить и перейти', async () => { if (await doSave()) openBlock(b, true); },
          'Без сохранения', () => openBlock(b, true));
        return;
      }
      cur = b; orig = b.content;
      if (editor) { editor.destroy(); host2.textContent = ''; }
      editor = mkEditor(orig, languageFor('block.md', (sup) => {
        if (!editor) return;
        const v = editor.getValue(); editor.destroy(); host2.textContent = '';
        editor = mkEditor(v, sup); recheck();
      }));
      pathEl.textContent = b.title;                       // в шапке — только раздел…
      pathEl.title = (proj ? proj.path + '/CLAUDE.md' : '');  // …полный путь под курсором
      chars.textContent = fmtTok(orig.length);
      setMode(preview);
      recheck();
      const row = listEl.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
    function drawList() {
      listEl.textContent = '';
      for (const b of ordered()) {
        const it = el('div', 'ctx-bl-item' + (cur && b.id === cur.id ? ' on' : ''));
        it.dataset.id = b.id;
        it.appendChild(el('span', 'ctx-bl-name', b.title));
        it.appendChild(el('span', 'ctx-bl-size', fmtTok(b.chars || 0)));
        if (cur && b.id === cur.id && dirty) it.appendChild(el('span', 'ctx-bl-dot', '●'));
        it.addEventListener('click', () => openBlock(b));
        listEl.appendChild(it);
      }
    }
    const setMode = (on) => {
      preview = on; blockPreviewMode = on;
      if (on) renderSafeMarkdown(prevBox, editor.getValue());
      host2.hidden = on; prevBox.hidden = !on;
      m.querySelector('#cxm-mode-view').classList.toggle('on', on);
      m.querySelector('#cxm-mode-edit').classList.toggle('on', !on);
    };
    async function doSave() {
      const text = editor.getValue();
      cur.content = text; cur.chars = text.length; cur.title = titleFromContent(text);
      if (!(await persist('Правка раздела', cur.title))) { await reloadFromDisk(); return false; }
      orig = text; recheck();
      toast(t('Сохранено в CLAUDE.md, прежняя версия в истории'), { ttl: 5000 });
      return true;
    }
    const step = (delta) => {
      const list = ordered();
      const i = list.findIndex((x) => x.id === cur.id);
      openBlock(list[i + delta]);
    };
    m.querySelector('#cxm-mode-edit').addEventListener('click', () => setMode(false));
    m.querySelector('#cxm-mode-view').addEventListener('click', () => setMode(true));
    m.querySelector('#cxm-prev-b').addEventListener('click', () => step(-1));
    m.querySelector('#cxm-next-b').addEventListener('click', () => step(1));
    saveBtn.addEventListener('click', doSave);
    const bye = () => { if (!dirty) { close(); return; } showConfirm('Закрыть без сохранения?', 'Правки будут потеряны.', 'Закрыть', close); };
    m.querySelector('#cxm-cancel').addEventListener('click', bye);
    m.querySelector('#cxm-x').addEventListener('click', bye);
    m.querySelector('#cxm-del').addEventListener('click', () => { const b = cur; close(); deleteBlock(b); });
    drawList();
    openBlock(startBlock, true);
  }

  // ── История версий ─────────────────────────────────────────────────────────────────────────
  // Слева пагинированный список (по 10), справа дифф выбранной версии с текущим файлом —
  // устройство повторяет «Локальную историю» вивера (renderer/modules/files.js: showLocalHistory).
  const PT_PAGE = 10;
  async function showPoints(preselect) {
    if (!proj) { toast('Сначала открой проект'); return; }
    const r = await lite.ctx.points(proj.id);
    if (r && r.ok) points = r.list || [];
    let page = 0, curId = preselect || null, mv = null;
    const { m, close } = makeModal(`<div class="ctx-bl-top">
        <h2>🕘 История CLAUDE.md</h2>
        <button class="ctx-x" id="cxh-x" title="Закрыть">✕</button>
      </div>
      <div class="about-desc">Копия снимается перед каждой правкой. Хранятся ${(r && r.keep) || 50} последних версий; версия с замком 🔒 не удаляется и в лимит не входит.</div>
      <div class="hist-grid">
        <div class="hist-left">
          <div id="cxh-list" class="hist-list"></div>
          <div id="cxh-pager" class="db-pager"></div>
        </div>
        <div class="hist-right">
          <div id="cxh-labels" class="hist-collabels"></div>
          <div id="cxh-diff" class="hist-diff"></div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn" id="cxh-close">Закрыть</button></div>`,
      () => { if (mv) { try { mv.destroy(); } catch (_) {} mv = null; } });
    m.classList.add('ctx-modal', 'ctx-modal-hist');
    const listEl = m.querySelector('#cxh-list');
    const pagerEl = m.querySelector('#cxh-pager');
    const diffEl = m.querySelector('#cxh-diff');
    const labels = m.querySelector('#cxh-labels');

    const sorted = () => points.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    let diffSeq = 0;   // клик по версии, пока читается предыдущая, иначе оставлял лишний MergeView
    const showDiff = async (pt) => {
      curId = pt.id;
      const my = ++diffSeq;
      if (mv) { try { mv.destroy(); } catch (_) {} mv = null; }
      diffEl.textContent = '';
      const rr = await lite.ctx.pointRead(proj.id, pt.id);
      if (my !== diffSeq) return;
      if (!rr || !rr.ok) { diffEl.appendChild(el('div', 'ctx-addhint', t('Не прочитать версию'))); return; }
      labels.textContent = '';
      labels.appendChild(el('div', 'hist-collabel', `${fmtTs(pt.ts)} · ${pt.name}`));
      labels.appendChild(el('div', 'hist-collabel', 'Текущий файл'));
      await ensureLanguage('CLAUDE.md');
      if (my !== diffSeq) return;
      // collapseUnchanged — показываем ТОЛЬКО изменённые куски друг за другом, неизменные
      // длинноты сворачиваются (margin — сколько строк контекста оставить вокруг правки).
      mv = new MergeView({
        a: { doc: rr.text, extensions: mergeRoExtensions('CLAUDE.md') },
        b: { doc: fileText, extensions: mergeRoExtensions('CLAUDE.md') },
        parent: diffEl, highlightChanges: true, gutter: true,
        collapseUnchanged: { margin: 2, minSize: 4 },
      });
    };
    const draw = () => {
      const all = sorted();
      const pages = Math.max(1, Math.ceil(all.length / PT_PAGE));
      if (page >= pages) page = pages - 1;
      listEl.textContent = '';
      if (!all.length) listEl.appendChild(el('div', 'ctx-addhint', 'Версий пока нет — они появляются при каждой правке.'));
      for (const pt of all.slice(page * PT_PAGE, page * PT_PAGE + PT_PAGE)) {
        const it = el('div', 'hist-item' + (curId === pt.id ? ' active' : ''));
        const top = el('div', 'hist-when');
        if (pt.locked) top.appendChild(el('span', 'hist-tag', '🔒'));
        top.appendChild(el('span', null, fmtTs(pt.ts)));
        top.appendChild(el('span', 'hist-size', fmtTok(pt.chars || 0)));
        it.appendChild(top);
        it.appendChild(el('div', 'hist-name', pt.name));
        if (pt.note) it.appendChild(el('div', 'hist-note', pt.note));
        const acts = el('div', 'hist-acts');
        const act = (ic, title, fn, cls) => {
          const b = el('button', 'mem-act' + (cls ? ' ' + cls : ''));
          b.appendChild(icon(ic, 13)); b.title = title;
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          acts.appendChild(b);
        };
        act('refresh', 'Восстановить эту версию в файл', () => restorePoint(pt, close));
        act('pencil', pt.note ? 'Изменить комментарий' : 'Добавить комментарий', () => {
          showPrompt('Комментарий к версии', 'Чем эта версия важна', pt.note || '', async (v) => {
            const rr = await lite.ctx.pointNote(proj.id, pt.id, v);
            if (rr && rr.ok) { points = rr.list; draw(); }
          });
        });
        act(pt.locked ? 'lock' : 'unlock', pt.locked ? 'Снять замок (версия снова попадёт под ротацию)' : 'Защитить от ротации', async () => {
          const rr = await lite.ctx.pointLock(proj.id, pt.id, !pt.locked);
          if (rr && rr.ok) { points = rr.list; draw(); }
          else toast(t('Не изменить замок: {0}', (rr && rr.error) || '?'), { kind: 'err' });
        }, pt.locked ? 'on' : '');
        if (!pt.locked) act('trash', 'Удалить версию', () => {
          showConfirm('Удалить версию?', `«${pt.name}» от ${fmtTs(pt.ts)} исчезнет безвозвратно.`, 'Удалить', async () => {
            const rr = await lite.ctx.pointDelete(proj.id, pt.id);
            if (rr && rr.ok) { points = rr.list; draw(); } else toast(t('Не удалить: {0}', (rr && rr.error) || '?'), { kind: 'err' });
          });
        }, 'danger');
        it.appendChild(acts);
        it.addEventListener('click', () => { showDiff(pt); draw(); });
        listEl.appendChild(it);
      }
      pagerEl.textContent = '';
      if (all.length > PT_PAGE) {
        pagerEl.appendChild(el('span', 'db-pageinfo', `${page * PT_PAGE + 1}–${Math.min(all.length, (page + 1) * PT_PAGE)} из ${all.length}`));
        const prev = el('button', 'mem-act'); prev.appendChild(icon('chevron-left', 13)); prev.disabled = page <= 0;
        prev.addEventListener('click', () => { if (page > 0) { page--; draw(); } });
        const next = el('button', 'mem-act'); next.appendChild(icon('chevron-right', 13)); next.disabled = page >= pages - 1;
        next.addEventListener('click', () => { if (page < pages - 1) { page++; draw(); } });
        pagerEl.append(prev, next);
      }
    };
    draw();
    const first = sorted()[0];
    if (first) showDiff(preselect ? (points.find((x) => x.id === preselect) || first) : first);
    m.querySelector('#cxh-close').addEventListener('click', close);
    m.querySelector('#cxh-x').addEventListener('click', close);
  }
  function restorePoint(pt, closeFn) {
    showConfirm('Восстановить версию?', `CLAUDE.md станет таким, каким был ${fmtTs(pt.ts)} («${pt.name}»). Текущее содержимое уйдёт в историю — вернуть можно будет так же.`, 'Восстановить', async () => {
      const rr = await lite.ctx.pointRead(proj.id, pt.id);
      if (!rr || !rr.ok) { toast(t('Не прочитать версию'), { kind: 'err' }); return; }
      const r2 = await lite.ctx.save({ projId: proj.id, projPath: proj.path, text: rr.text, name: 'Откат к версии', note: fmtTs(pt.ts) + ' · ' + pt.name, expectHash: fileHash });
      if (!r2 || !r2.ok) { toast(t('Не восстановить: {0}', (r2 && r2.error) || '?'), { kind: 'err' }); return; }
      if (closeFn) closeFn();
      await reloadFromDisk();
      toast(t('Файл восстановлен из версии от {0}', fmtTs(pt.ts)), { ttl: 7000 });
    });
  }
  // Сравнение текущего файла с последней версией — отдельной кнопкой в тулбаре.
  async function showLastDiff() {
    if (!proj) { toast('Сначала открой проект'); return; }
    const r = await lite.ctx.points(proj.id);
    if (r && r.ok) points = r.list || [];
    const last = points.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    if (!last) { toast(t('Сравнивать не с чем — в истории пока нет версий'), { kind: 'warn' }); return; }
    showPoints(last.id);
  }

  // ── Внешние правки (агент дописал файл) ────────────────────────────────────────────────────
  // Одновременно файл правит либо агент, либо человек, поэтому слияния нет: просто перечитываем.
  // Пауза перед чтением — агент дописывает файл в несколько заходов, иначе поймаем середину записи.
  const SETTLE_MS = 1500;
  function onExternalChange() {
    if (!open || !proj || curTab !== 'canvas') return;
    clearTimeout(extTimer);
    extTimer = setTimeout(async () => {
      const r = await lite.ctx.state(proj.id, proj.path);
      if (!r || !r.ok) return;
      if (r.hash === fileHash) return;                 // это была наша собственная запись
      if (modalOpen || busy) {                          // человек правит прямо сейчас — не мешаем
        externalChange = true; renderExtern();
        return;
      }
      applyState(r);
      externalChange = false; renderExtern();
      toast(t('CLAUDE.md изменён агентом — канва перестроена, прежняя версия в истории'), { ttl: 8000 });
    }, SETTLE_MS);
  }

  // ── Справка ────────────────────────────────────────────────────────────────────────────────
  function showHelp() {
    const { m, close } = makeModal(`
      <h2>Как работает «Канва»</h2>
      <div class="ctx-help">
        <p><b>Зачем это.</b> Claude Code при старте читает <b>CLAUDE.md</b> в корне проекта. Канва
        показывает этот файл разделами: каждый заголовок — отдельный блок, видно вес каждого куска
        в токенах и всего файла целиком.</p>
        <p><b>Канва — это и есть файл.</b> Правите блок и сохраняете — файл меняется сразу, никаких
        «подтвердить». Перетаскивание карточек — только расстановка: порядок разделов в файле остаётся
        тем же, каким прочитан. Кнопка «сетка» раскладывает карточки в порядке разделов.</p>
        <p><b>История и откат.</b> Перед каждой правкой прежняя версия файла уходит в историю (🕘):
        хранятся последние 50, у каждой можно оставить комментарий. Нажмите <b>🔒</b> — версия
        перестанет удаляться и не будет занимать место в лимите. Кнопка <b>⇄</b> показывает, что
        изменилось между текущим файлом и последней версией.</p>
        <p><b>Агент правит тот же файл.</b> Если Claude Code допишет CLAUDE.md сам, канва заметит это
        и перестроится, сохранив расстановку знакомых блоков; версия ДО его правки уйдёт в историю,
        так что откатить чужую правку можно так же, как свою.
        Пока открыт редактор блока, канва ждёт — вместо перестройки загорится «⚠ файл изменён агентом».</p>
      </div>
      <div class="modal-actions"><button class="btn primary" id="cxh-ok">Понятно</button></div>`);
    m.classList.add('ctx-modal');
    m.querySelector('#cxh-ok').addEventListener('click', close);
  }

  // ── Бинды ──────────────────────────────────────────────────────────────────────────────────
  $('#ctx-help').addEventListener('click', showHelp);
  $('#ctx-add').addEventListener('click', addBlock);
  $('#ctx-fit').addEventListener('click', fitView);
  $('#ctx-align').addEventListener('click', alignGrid);
  $('#ctx-points').addEventListener('click', () => showPoints());
  $('#ctx-diff').addEventListener('click', showLastDiff);
  $('#ctx-extern').addEventListener('click', async () => { await reloadFromDisk(); externalChange = false; renderExtern(); toast(t('Канва перечитана из файла'), { ttl: 5000 }); });
  $('#ctx-ob-help').addEventListener('click', showHelp);
  $('#ctx-ob-close').addEventListener('click', dismissOnboard);
  $('#ctx-ob-create').addEventListener('click', async () => {
    if (!proj) { toast('Сначала открой проект'); return; }
    blocks = [{ id: 'b0', title: proj.name || 'Проект', content: `# ${proj.name || 'Проект'}\n\nЧто это за проект и как с ним работать.\n`, chars: 60, ord: 0, x: 140, y: 60 }];
    if (await persist('Создание файла', 'файл создан из модуля')) { dismissOnboard(); await reloadFromDisk(); }
  });
  lite.ctx.onOutputChanged(({ projId } = {}) => { if (open && proj && projId === proj.id) onExternalChange(); });

  // ============================================================ вкладка «Анализ диалогов» (ctxmine)
  // Извлечение долгоиграющих правил из истории диалогов агента по проекту. Ничего в реальные файлы НЕ
  // пишет — только собирает реестр и показывает, сгруппировав по рекомендации «куда положить». Бэкенд —
  // window.lite.ctxmine (main: ctxmine:scan/analyze/abort), чтение транскриптов ~/.claude/projects/*.jsonl.
  const PLACEMENTS = [
    { key: 'global', label: 'Главный контекст', sub: '~/.claude/CLAUDE.md — личное, для всех проектов', cls: 'glob' },
    { key: 'project', label: 'Проектный контекст', sub: 'CLAUDE.md этого проекта', cls: 'proj' },
    { key: 'skill', label: 'Скилл', sub: '.claude/skills/<имя>/SKILL.md — процедура, которую агент применит сам', cls: 'skill' },
    { key: 'command', label: 'Команда', sub: '.claude/commands/<имя>.md — то, что вы запускаете руками', cls: 'cmd' },
    { key: 'hook', label: 'Хук', sub: '.claude/settings.json — срабатывает автоматически, без модели', cls: 'hook' },
    { key: 'memory', label: 'Память', sub: 'разовый факт, полезный для памяти', cls: 'mem' },
    { key: 'skip', label: 'На ревью', sub: 'спорное/частное — пока никуда', cls: 'skip' },
  ];
  const PLACE_KEYS = PLACEMENTS.map((p) => p.key);
  const CAT_RU = { 'code-style': 'стиль кода', 'error-fix': 'грабли', workflow: 'процесс', preference: 'предпочтение', tooling: 'инструменты', architecture: 'архитектура', other: 'прочее' };
  const CONF_RU = { high: 'высокая', medium: 'средняя', low: 'низкая' };
  const CONF_ORD = { high: 3, medium: 2, low: 1 };
  const mineEl = $('#ctx-mine');
  // rules — накопленный реестр (персист в localStorage per-project); done — имена уже разобранных сессий
  // (батчинг + «только новые»); ctx — содержимое существующих CLAUDE.md для дедупа; sel — выбор
  // правил для записи в файлы. У правила могут быть поля status:'ignored', applied:true, exists:true (B).
  const mine = { scanned: null, scanPath: null, running: false, reqId: 0, raw: '', t0: 0, timer: null, q: '', cat: '', conf: '',
    rules: [], done: [], remaining: 0, totalFiles: 0, batches: 0, summary: '', ctx: null, showIgnored: false, hideExists: false, sel: new Set() };
  let curTab = 'canvas';
  const hasRules = () => mine.rules.length > 0 || mine.batches > 0;

  // ── Персист реестра между перезапусками (localStorage окна модуля, ключ по пути проекта) ──
  const mineKey = (p) => 'lite.ctxmine.v1.' + (p || '');
  function mineLoad(p) {
    mine.rules = []; mine.done = []; mine.remaining = 0; mine.totalFiles = 0; mine.batches = 0; mine.summary = ''; mine.sel = new Set();
    try {
      const raw = localStorage.getItem(mineKey(p));
      if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.rules)) { mine.rules = d.rules; mine.done = Array.isArray(d.done) ? d.done : []; mine.summary = d.summary || ''; mine.totalFiles = d.totalFiles || 0; mine.batches = d.batches || 0; } }
    } catch (_) {}
  }
  function mineSave() {
    if (!mine.scanPath) return;
    try { localStorage.setItem(mineKey(mine.scanPath), JSON.stringify({ rules: mine.rules, done: mine.done, summary: mine.summary, totalFiles: mine.totalFiles, batches: mine.batches, updatedAt: Date.now() })); } catch (_) {}
  }

  function fmtBytes(n) { n = n || 0; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(0) + ' КБ'; return (n / 1048576).toFixed(1) + ' МБ'; }
  const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return (a > 10 && a < 20) ? many : (b > 1 && b < 5) ? few : (b === 1) ? one : many; };
  const placeOf = (r) => (PLACE_KEYS.includes(r && r.placement) ? r.placement : 'skip');

  function setTab(name) {
    curTab = name;
    document.querySelectorAll('#ctx-tabs .ctx-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    const canvasMode = name === 'canvas';
    for (const sel of ['#ctx-stats', '#ctx-canvas']) { const e = $(sel); if (e) e.style.display = canvasMode ? '' : 'none'; }
    if (mineEl) mineEl.style.display = name === 'mine' ? 'flex' : 'none';
    if (memEl) memEl.style.display = name === 'mem' ? 'flex' : 'none';
    if (filesEl) filesEl.style.display = name === 'files' ? 'flex' : 'none';
    // вернулись на «Канву» после смены проекта — прочитать файл нового проекта
    if (canvasMode && proj && loadedProj !== proj.id) loadCanvas(proj);
    if (name === 'mine') { renderMine(); mineScan(); mineCheckArtifacts(); }
    if (name === 'mem') memLoad();
    if (name === 'files') cfsLoad();
  }

  async function mineScan() {
    const p = activeProject();
    if (!p) { mine.scanned = null; mine.scanPath = null; renderMine(); return; }
    if (mine.scanPath !== p.path) { mine.scanPath = p.path; mine.raw = ''; mine.ctx = null; mine.scanned = null; mineLoad(p.path); if (curTab === 'mine') renderMine(); } // новый проект — поднять его сохранённый реестр сразу
    try { const r = await lite.ctxmine.scan(p.path); if (r && r.ok && mine.scanPath === p.path && curTab === 'mine') { mine.scanned = r; if (!mine.totalFiles) mine.totalFiles = r.sessions || 0; renderMine(); } }
    catch (_) {}
    // подгрузить существующий контекст (CLAUDE.md) для дедупа (B) — однократно на проект
    if (!mine.ctx && p) {
      try { const c = await lite.ctxmine.context(p.path); if (c && c.ok && mine.scanPath === p.path) { mine.ctx = c; markExists(); if (curTab === 'mine') renderGroups(); } } catch (_) {}
    }
  }

  // Полный сброс накопленного реестра (анализ «Заново» / стирание сохранённого).
  function mineReset() {
    mine.rules = []; mine.done = []; mine.remaining = 0; mine.batches = 0; mine.summary = ''; mine.sel = new Set();
    try { if (mine.scanPath) localStorage.removeItem(mineKey(mine.scanPath)); } catch (_) {}
  }
  // Слить правила нового батча в накопленный реестр: дубли по нормализованному заголовку — объединяем
  // (суммируем occurrences, берём бóльшую уверенность; правки пользователя — edited — не перетираем).
  const ruleKey = (r) => String((r && r.title) || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // done хранит и строки (сессия пройдена целиком), и {f,off} (пройдена частично — плавающее окно
  // по длинной сессии). Для счётчиков это разные вещи: частичная ещё не закрыта.
  const doneName = (d) => (typeof d === 'string' ? d : (d && d.f) || '');
  const doneFull = () => mine.done.filter((d) => typeof d === 'string').length;
  const donePartial = () => mine.done.filter((d) => d && typeof d !== 'string').length;
  // Скилл/команду/хук нельзя «дописать буллетом» — это осмысленный файл или конфиг.
  // Поэтому такие правила уходят агенту: он и создаст артефакт по нашей формулировке.
  const HANDOFF = {
    skill: 'Заведи скилл в .claude/skills/ по этому правилу',
    command: 'Заведи команду в .claude/commands/ по этому правилу',
    hook: 'Настрой хук в .claude/settings.json по этому правилу',
  };
  function ruleHandoff(r) {
    const pl = placeOf(r);
    const lead = HANDOFF[pl]; if (!lead) return;
    lite.editorBus.sendToTerminal(`${lead}: «${r.title}». Подробности: ${String(r.detail || '').replace(/\s+/g, ' ')} `);
    toast(t('Правило отправлено в терминал проекта — проверьте формулировку и нажмите Enter'), { ttl: 8000 });
  }
  // Какое имя файла получит правило: слаг из заголовка (та же транслитерация, что на бэкенде).
  const ruleSlug = (r) => String((r && (r.artifact || r.title)) || '').toLowerCase()
    .replace(/[а-яё]/g, (c) => ({ а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }[c] || ''))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rule';
  const ruleFileHint = (r) => {
    const pl = placeOf(r), sl = ruleSlug(r);
    if (pl === 'skill') return `.claude/skills/${sl}/SKILL.md`;
    if (pl === 'command') return `.claude/commands/${sl}.md`;
    if (pl === 'hook') return '.claude/settings.json → hooks';
    return '';
  };
  // Проверка «а не создан ли уже такой скилл/команда» — чтобы реестр не предлагал одно и то же.
  async function mineCheckArtifacts() {
    if (!lite.ctxfs || !lite.ctxfs.artifactState) return;
    const p = activeProject(); if (!p) return;
    const items = mine.rules.filter((r) => ['skill', 'command'].includes(placeOf(r)))
      .map((r) => ({ key: ruleKey(r), kind: placeOf(r), slug: ruleSlug(r), title: r.title }));
    if (!items.length) return;
    try {
      const rr = await lite.ctxfs.artifactState('project', p.path, items);
      if (!rr || !rr.ok) return;
      let changed = false;
      for (const r of mine.rules) {
        const st = rr.states[ruleKey(r)];
        if (!st) continue;
        const made = !!st.exists;
        if (r.made !== made) { r.made = made; changed = true; }
      }
      if (changed) { mineSave(); renderGroups(); }
    } catch (_) {}
  }
  // Создание артефакта из правила: заготовку пишет main (структура скилла/команды фиксированная),
  // дальше человек дописывает шаги — поэтому сразу открываем созданный файл в редакторе.
  async function ruleCreateArtifact(r) {
    const pl = placeOf(r);
    const p = activeProject(); if (!p) { toast('Сначала открой проект'); return; }
    if (!lite.ctxfs || !lite.ctxfs.createArtifact) { toast(t('Эта возможность появилась в новой версии — перезапустите редактор, чтобы она заработала'), { kind: 'warn', ttl: 9000 }); return; }
    if (pl === 'hook') { // settings.json не патчим вслепую — отдаём заготовку и открываем файл
      const st = await lite.ctxfs.hookStub(r.title, r.detail);
      if (st && st.ok) { try { lite.copyText(st.text); } catch (_) {} }
      toast(t('Заготовка хука скопирована — вставьте её в settings.json'), { ttl: 9000 });
      const rr = await lite.ctxfs.read('project', p.path, 'settings.json');
      if (rr && rr.ok) {
        openFileEditor({ title: 'Правка файла', subtitle: rr.file, file: rr.file, text: rr.text, language: 'settings.json',
          scope: 'project', rel: 'settings.json',
          onSave: async (body) => lite.ctxfs.write('project', p.path, 'settings.json', body) });
      } else toast(t('Файла .claude/settings.json пока нет — создайте его во вкладке «Файлы»'), { kind: 'warn', ttl: 8000 });
      return;
    }
    showConfirm('Создать заготовку?', `Будет создан файл ${ruleFileHint(r)} с описанием из правила. Дальше его нужно дописать — модуль откроет файл сразу после создания.`, 'Создать', async () => {
      const rr = await lite.ctxfs.createArtifact({ scope: 'project', projPath: p.path, kind: pl, slug: ruleSlug(r), title: r.title, detail: r.detail, evidence: r.evidence });
      if (!rr || !rr.ok) { toast(t('Не создать: {0}', (rr && rr.error) || '?'), { kind: 'err', ttl: 8000 }); return; }
      r.made = true; mineSave(); renderGroups();
      toast(t('Создано: {0}', rr.rel || rr.file), { ttl: 7000 });
      const rd = await lite.ctxfs.read('project', p.path, rr.rel);
      if (rd && rd.ok) openFileEditor({ title: 'Правка файла', subtitle: rd.file, file: rd.file, text: rd.text, language: rr.rel,
        scope: 'project', rel: rr.rel, onSave: async (body) => lite.ctxfs.write('project', p.path, rr.rel, body) });
      cfsLoad(true);
    });
  }
  function mergeRules(incoming) {
    const idx = new Map(mine.rules.map((r, i) => [ruleKey(r), i]));
    let added = 0;
    for (const r of incoming) {
      const k = ruleKey(r); if (!k) continue;
      if (idx.has(k)) {
        const ex = mine.rules[idx.get(k)];
        ex.occurrences = (ex.occurrences || 1) + (r.occurrences || 1);
        if ((CONF_ORD[r.confidence] || 0) > (CONF_ORD[ex.confidence] || 0)) { ex.confidence = r.confidence; if (!ex.placementEdited) { ex.placement = r.placement; ex.placement_reason = r.placement_reason; } }
        if (!ex.edited && (r.detail || '').length > (ex.detail || '').length) ex.detail = r.detail;
        if (!ex.evidence && r.evidence) ex.evidence = r.evidence;
      } else { mine.rules.push({ ...r }); idx.set(k, mine.rules.length - 1); added++; }
    }
    return { added };
  }

  // Дедуп (B): пометить правила, чьи заголовки уже встречаются в существующих CLAUDE.md.
  const normTxt = (s) => String(s || '').toLowerCase().replace(/[^0-9a-zа-яё ]/gi, ' ').replace(/\s+/g, ' ').trim();
  function markExists() {
    if (!mine.ctx) return;
    const files = { global: normTxt(mine.ctx.global), project: normTxt(mine.ctx.project) };
    for (const r of mine.rules) {
      const f = files[placeOf(r)]; const t = normTxt(r.title);
      r.exists = !!(f && t && t.length > 6 && f.includes(t));
    }
  }

  // Список разговоров проекта: видно, когда, о чём и разобран ли; можно взять конкретный.
  // Длинная сессия не обязана уместиться в один проход — по ней едет плавающее окно, и в списке
  // она помечается «дочитывается».
  async function mineSessions() {
    const p = activeProject(); if (!p) return;
    if (!lite.ctxmine.sessions) { toast(t('Эта возможность появилась в новой версии — перезапустите редактор, чтобы она заработала'), { kind: 'warn', ttl: 9000 }); return; }
    const r = await lite.ctxmine.sessions(p.path, mine.done);
    if (!r || !r.ok) { toast(t('Не прочитать список сессий: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
    const list = r.list || [];
    const { m, close } = makeModal(`<h2>Разговоры по проекту</h2>
      <div class="about-desc">Каждая строка — одна сессия Claude Code. Отметьте нужные и разберите только их; длинные сессии читаются частями, «дочитывается» значит, что остался хвост.</div>
      <div class="ctx-medbar">
        <input type="search" id="ms-q" class="mine-search" placeholder="поиск по тексту и дате">
        <select id="ms-f" class="mine-sel">
          <option value="">все</option><option value="no">не разобранные</option>
          <option value="partial">дочитываются</option><option value="full">разобранные</option>
        </select>
        <span id="ms-n" class="ctx-mchars"></span>
        <div class="mine-fl-sp"></div>
        <button class="btn sm" id="ms-all">Отметить видимые</button>
        <button class="btn sm" id="ms-none">Снять всё</button>
      </div>
      <div id="ms-list" class="ctx-vlist"></div>
      <div class="modal-actions"><button class="btn" id="ms-close">Закрыть</button>
        <button class="btn primary" id="ms-run">Разобрать выбранные</button></div>`);
    m.classList.add('ctx-modal', 'ctx-modal-sessions');
    const box = m.querySelector('#ms-list');
    const sel = new Set();
    const STATE = { full: ['разобрана', 'ok'], partial: ['дочитывается', 'warn'], no: ['не разобрана', ''] };
    // Группировка по дню: «Сегодня / Вчера / дата» — так в длинном списке видно, когда что было.
    const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
    const dayLabel = (ts) => {
      const d = new Date(ts), now = new Date();
      const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      const yest = new Date(now.getTime() - 86400000);
      if (same(d, now)) return 'Сегодня';
      if (same(d, yest)) return 'Вчера';
      try { return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }); } catch (_) { return fmtTs(ts); }
    };
    let q = '', flt = '';
    const visible = () => list.filter((it) => {
      if (flt && it.state !== flt) return false;
      if (!q) return true;
      const hay = (it.title + ' ' + fmtTs(it.mtime) + ' ' + dayLabel(it.mtime)).toLowerCase();
      return hay.includes(q);
    });
    const draw = () => {
      box.textContent = '';
      const vis = visible();
      m.querySelector('#ms-n').textContent = t('Выбрано: {0} из {1}', sel.size, vis.length);
      m.querySelector('#ms-run').disabled = !sel.size;
      if (!vis.length) { box.appendChild(el('div', 'ctx-addhint', list.length ? 'Под фильтр ничего не подходит.' : 'Сессий не найдено.')); return; }
      let lastDay = null;
      for (const it of vis) {
        const k = dayKey(it.mtime);
        if (k !== lastDay) { lastDay = k; box.appendChild(el('div', 'ms-day', dayLabel(it.mtime))); }
        const row = el('div', 'ctx-vrow');
        const lab = el('label', 'ctx-rc-lab');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = sel.has(it.file);
        cb.addEventListener('change', () => { if (cb.checked) sel.add(it.file); else sel.delete(it.file); draw(); });
        lab.appendChild(cb);
        const info = el('div', 'ms-info');
        const head = el('div', 'ctx-vhead');
        const [stx, scls] = STATE[it.state] || STATE.no;
        head.appendChild(el('span', 'ctx-rc-tag ' + scls, stx));
        head.appendChild(el('span', 'ctx-vname', fmtTs(it.mtime)));
        head.appendChild(el('span', 'ctx-vmeta', `${it.messages} ${plural(it.messages, 'реплика', 'реплики', 'реплик')} · ${fmtBytes(it.bytes)}`));
        info.appendChild(head);
        if (it.title) info.appendChild(el('div', 'ms-title', it.title));
        lab.appendChild(info);
        row.appendChild(lab);
        box.appendChild(row);
      }
    };
    const qEl = m.querySelector('#ms-q');
    qEl.addEventListener('input', () => { q = qEl.value.trim().toLowerCase(); draw(); qEl.focus(); });
    const fEl = m.querySelector('#ms-f');
    fEl.addEventListener('change', () => { flt = fEl.value; draw(); });
    m.querySelector('#ms-all').addEventListener('click', () => { for (const it of visible()) sel.add(it.file); draw(); });
    m.querySelector('#ms-none').addEventListener('click', () => { sel.clear(); draw(); });
    m.querySelector('#ms-close').addEventListener('click', close);
    m.querySelector('#ms-run').addEventListener('click', () => { close(); mineRun(true, [...sel]); });
    draw();
  }

  // cont=true — догрузить следующий батч НЕразобранных сессий (новые первыми) и слить; иначе — заново.
  // only — разобрать ровно эти файлы сессий (из «Выбрать сессии…»); иначе идёт обычная очередь.
  function mineRun(cont, only) {
    const p = activeProject();
    if (!p) { toast('Сначала открой проект'); return; }
    if (mine.running) return;
    if (!cont) mineReset();
    mine.running = true; mine.reqId = Date.now() * 1000 + Math.floor(Math.random() * 1000); mine.raw = ''; mine.t0 = Date.now();
    if (mine.timer) clearInterval(mine.timer);
    mine.timer = setInterval(() => { const e = $('#mine-elapsed'); if (e) e.textContent = Math.floor((Date.now() - mine.t0) / 1000) + ' с'; }, 1000);
    lite.ctxmine.analyze(mine.reqId, p.path, { done: cont ? mine.done : [], only: (only && only.length) ? only : undefined });
    renderMine();
  }
  function mineStop() { if (mine.running) lite.ctxmine.abort(mine.reqId); }
  function mineEnd() { mine.running = false; if (mine.timer) { clearInterval(mine.timer); mine.timer = null; } }

  // ── Триаж (D): игнор/возврат и правка правила ──
  function ignoreRule(r) { r.status = (r.status === 'ignored') ? '' : 'ignored'; if (r.status === 'ignored') mine.sel.delete(ruleKey(r)); mineSave(); renderGroups(); }
  function editRule(r) {
    const { m, close } = makeModal('<h2>Изменить правило</h2><div class="mine-edit"></div><div class="modal-actions"><button class="btn" id="me-cancel">Отмена</button><button class="btn primary" id="me-save">Сохранить</button></div>');
    const box = m.querySelector('.mine-edit');
    const ti = el('input', 'mine-edit-in'); ti.value = r.title || '';
    const de = el('textarea', 'mine-edit-ta'); de.value = r.detail || '';
    const pl = el('select', 'mine-edit-sel'); for (const P of PLACEMENTS) pl.appendChild(new Option(P.label, P.key)); pl.value = placeOf(r);
    box.appendChild(el('label', 'mine-edit-l', 'Заголовок')); box.appendChild(ti);
    box.appendChild(el('label', 'mine-edit-l', 'Детали')); box.appendChild(de);
    box.appendChild(el('label', 'mine-edit-l', 'Куда положить')); box.appendChild(pl);
    m.querySelector('#me-cancel').addEventListener('click', close);
    m.querySelector('#me-save').addEventListener('click', () => {
      const wasKey = ruleKey(r), wasSel = mine.sel.has(wasKey);
      r.title = ti.value.trim() || r.title; r.detail = de.value.trim(); r.placement = pl.value; r.edited = true; r.placementEdited = true;
      // выбор привязан к заголовку — переносим его на новый ключ, иначе счётчик «Выбрано» врёт,
      // а «Применить выбранные» считает правила, которых в реестре под этим ключом уже нет
      const nowKey = ruleKey(r);
      if (nowKey !== wasKey) { mine.sel.delete(wasKey); if (wasSel) mine.sel.add(nowKey); }
      close(); mineSave(); markExists(); renderGroups();
    });
    setTimeout(() => ti.focus(), 30);
  }

  // ── Применение (A): выбранные правила → дописать в нужный CLAUDE.md (с подтверждением) ──
  // Правила из старого реестра с placement:'agents' (когда модуль ещё умел Codex) больше не в
  // PLACE_KEYS → placeOf() отдаёт 'skip', и они спокойно оседают в группе «На ревью».
  const APPLY_PLACES = ['global', 'project'];
  const FILE_LABEL = { global: '~/.claude/CLAUDE.md', project: 'CLAUDE.md проекта' };
  function selectedApplicable() { return mine.rules.filter((r) => mine.sel.has(ruleKey(r)) && r.status !== 'ignored' && APPLY_PLACES.includes(placeOf(r))); }
  function applySelected() {
    const items = selectedApplicable();
    if (!items.length) { toast('Нет выбранных правил для записи (память и «на ревью» в файлы не пишутся)', { kind: 'warn' }); return; }
    const by = {}; for (const r of items) (by[placeOf(r)] = by[placeOf(r)] || []).push(r);
    const summary = Object.entries(by).map(([pl, arr]) => `${FILE_LABEL[pl]} — ${arr.length} ${plural(arr.length, 'правило', 'правила', 'правил')}`).join('; ');
    showConfirm('Записать правила в файлы?', 'Будут дописаны: ' + summary + '. Файлы изменятся на диске.', 'Записать', async () => {
      const p = activeProject();
      if (!p) { toast(t('Проект закрыт — записывать правила некуда'), { kind: 'warn' }); return; }
      const payload = items.map((r) => ({ placement: placeOf(r), title: r.title, detail: r.detail }));
      let res; try { res = await lite.ctxmine.apply(p.path, payload); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      if (res && res.ok) {
        for (const r of items) { r.applied = true; mine.sel.delete(ruleKey(r)); }
        mineSave();
        try { const c = await lite.ctxmine.context(p.path); if (c && c.ok) { mine.ctx = c; markExists(); } } catch (_) {}
        renderMine();
        const n = (res.applied || []).reduce((s, a) => s + a.count, 0);
        toast(t('Записано: {0} {1}', n, plural(n, 'правило', 'правила', 'правил')), { kind: 'ok' });
      } else { toast((res && res.error) || 'Не удалось записать', { kind: 'err' }); }
    });
  }

  lite.ctxmine.onProgress((d) => {
    if (!d || d.reqId !== mine.reqId) return;
    if (d.stage === 'delta') { mine.raw = (mine.raw + (d.delta || '')).slice(-12000); const pre = $('#mine-live'); if (pre) { pre.textContent = mine.raw; pre.scrollTop = pre.scrollHeight; } }
  });
  lite.ctxmine.onResult((d) => {
    if (!d || d.reqId !== mine.reqId) return;
    mineEnd();
    const meta = d.meta || {};
    const { added } = mergeRules(Array.isArray(d.rules) ? d.rules : []);
    for (const n of (meta.batchFiles || [])) {   // запись по сессии ОДНА: свежая заменяет прежнюю
      const nm = doneName(n); if (!nm) continue;
      mine.done = mine.done.filter((d) => doneName(d) !== nm);
      mine.done.push(n);
    }
    mine.batches++;
    mine.remaining = meta.remaining || 0;
    mine.totalFiles = meta.totalFiles || mine.totalFiles;
    if (d.summary) mine.summary = d.summary;
    markExists();
    mineSave();
    renderMine();
    const tail = mine.remaining > 0 ? ` · ещё ${mine.remaining} — «Продолжить»` : '';
    toast(`Часть ${mine.batches}: +${added} новых (всего ${mine.rules.length})${tail}`, { kind: 'ok' });
  });
  lite.ctxmine.onError((d) => {
    if (!d || d.reqId !== mine.reqId) return;
    mineEnd();
    if (d.raw) mine.raw = d.raw;
    renderMine();
    if (!d.aborted) toast(d.error || 'Ошибка анализа', { kind: 'err' });
  });

  function chip(text, cls) { return el('span', 'mine-chip' + (cls ? ' ' + cls : ''), text); }
  function ruleToText(r) { return `${r.title || ''}\n${r.detail || ''}${r.evidence ? '\n(где: ' + r.evidence + ')' : ''}`.trim(); }

  function ruleCard(r) {
    const k = ruleKey(r);
    const card = el('div', 'mine-card conf-' + (r.confidence || 'low') + (r.status === 'ignored' ? ' is-ignored' : '') + (r.applied ? ' is-applied' : ''));
    const top = el('div', 'mine-card-top');
    const cb = el('input', 'mine-cb'); cb.type = 'checkbox'; cb.checked = mine.sel.has(k); cb.disabled = r.status === 'ignored';
    cb.title = APPLY_PLACES.includes(placeOf(r)) ? 'Выбрать для записи в файл'
      : (HANDOFF[placeOf(r)] ? 'Скилл/команда/хук — это файл или конфиг, его создаёт агент (кнопка ❯_ на карточке)'
      : 'Память и «на ревью» в файлы не пишутся');
    cb.addEventListener('change', () => { if (cb.checked) mine.sel.add(k); else mine.sel.delete(k); renderGroups(); });
    top.appendChild(cb);
    top.appendChild(el('span', 'mine-card-title', r.title || '(без названия)'));
    const acts = el('div', 'mine-card-acts');
    const ed = el('button', 'icon-btn'); ed.title = 'Изменить'; ed.appendChild(icon('pencil', 14)); ed.addEventListener('click', () => editRule(r)); acts.appendChild(ed);
    const ig = el('button', 'icon-btn'); ig.title = r.status === 'ignored' ? 'Вернуть' : 'Игнорировать'; ig.appendChild(icon(r.status === 'ignored' ? 'refresh' : 'x', 14)); ig.addEventListener('click', () => ignoreRule(r)); acts.appendChild(ig);
    if (HANDOFF[placeOf(r)]) {
      const add = el('button', 'icon-btn');
      add.title = r.made ? 'Уже создано — открыть файл' : 'Создать заготовку файла из этого правила';
      add.appendChild(icon(r.made ? 'check' : 'plus', 14));
      add.addEventListener('click', () => ruleCreateArtifact(r));
      acts.appendChild(add);
      const hd = el('button', 'icon-btn');
      hd.title = 'Поручить агенту завести это (вставит просьбу в терминал проекта, без Enter)';
      hd.appendChild(icon('terminal', 14));
      hd.addEventListener('click', () => ruleHandoff(r));
      acts.appendChild(hd);
    }
    const cp = el('button', 'icon-btn'); cp.title = 'Скопировать'; cp.appendChild(icon('copy', 14)); cp.addEventListener('click', () => { try { lite.copyText(ruleToText(r)); toast('Скопировано', { kind: 'ok' }); } catch (_) {} }); acts.appendChild(cp);
    top.appendChild(acts); card.appendChild(top);
    const chips = el('div', 'mine-chips');
    if (r.category) chips.appendChild(chip(CAT_RU[r.category] || r.category, 'cat'));
    chips.appendChild(chip(CONF_RU[r.confidence] || r.confidence || '—', 'conf c-' + (r.confidence || 'low')));
    if (r.occurrences > 1) chips.appendChild(chip('×' + r.occurrences, 'occ'));
    if (r.edited) chips.appendChild(chip('изменено', 'edited'));
    if (r.applied) chips.appendChild(chip('записано', 'applied'));
    else if (r.exists) chips.appendChild(chip('уже есть', 'exists'));
    const hint = ruleFileHint(r);
    if (hint) { const c = chip(r.made ? '✓ ' + hint : hint, r.made ? 'applied' : 'file'); c.title = r.made ? 'Файл уже создан' : 'Такой файл будет создан'; chips.appendChild(c); }
    card.appendChild(chips);
    if (r.detail) card.appendChild(el('div', 'mine-detail', r.detail));
    if (r.evidence) { const ev = el('div', 'mine-evi', '💡 ' + r.evidence); if (r.placement_reason) ev.title = 'Куда положить: ' + r.placement_reason; card.appendChild(ev); }
    return card;
  }
  function matchFilter(r) {
    if (r.status === 'ignored' && !mine.showIgnored) return false;
    if (mine.hideExists && (r.exists || r.applied)) return false;
    if (mine.cat && r.category !== mine.cat) return false;
    if (mine.conf && r.confidence !== mine.conf) return false;
    if (mine.q) { const hay = ((r.title || '') + ' ' + (r.detail || '') + ' ' + (r.evidence || '')).toLowerCase(); if (!hay.includes(mine.q.toLowerCase())) return false; }
    return true;
  }

  function renderGroups() {
    const box = $('#mine-groups'); if (!box) return;
    box.textContent = '';
    // панель массовых действий (A + триаж)
    const bulk = el('div', 'mine-bulk');
    const selN = selectedApplicable().length;
    bulk.appendChild(el('span', 'mine-bulk-n', `Выбрано: ${mine.sel.size}`));
    const selAll = el('button', 'btn sm', 'Выбрать видимые');
    selAll.addEventListener('click', () => { for (const r of mine.rules.filter(matchFilter)) if (r.status !== 'ignored') mine.sel.add(ruleKey(r)); renderGroups(); });
    bulk.appendChild(selAll);
    const clr = el('button', 'btn sm', 'Снять'); clr.disabled = !mine.sel.size; clr.addEventListener('click', () => { mine.sel.clear(); renderGroups(); }); bulk.appendChild(clr);
    const apply = el('button', 'btn primary sm', `Применить выбранные${selN ? ' (' + selN + ')' : ''}`); apply.disabled = !selN; apply.addEventListener('click', applySelected); bulk.appendChild(apply);
    bulk.appendChild(el('div', 'mine-fl-sp'));
    const ignChk = el('label', 'mine-toggle'); const ic = el('input'); ic.type = 'checkbox'; ic.checked = mine.showIgnored; ic.addEventListener('change', () => { mine.showIgnored = ic.checked; renderGroups(); }); ignChk.appendChild(ic); ignChk.appendChild(el('span', null, 'игнор')); bulk.appendChild(ignChk);
    const exChk = el('label', 'mine-toggle'); const ec = el('input'); ec.type = 'checkbox'; ec.checked = mine.hideExists; ec.addEventListener('change', () => { mine.hideExists = ec.checked; renderGroups(); }); exChk.appendChild(ec); exChk.appendChild(el('span', null, 'скрыть «уже есть»')); bulk.appendChild(exChk);
    box.appendChild(bulk);

    const buckets = {}; for (const k of PLACE_KEYS) buckets[k] = [];
    for (const r of mine.rules.filter(matchFilter)) buckets[placeOf(r)].push(r);
    let shown = 0;
    for (const pl of PLACEMENTS) {
      const arr = buckets[pl.key]; if (!arr.length) continue;
      shown += arr.length;
      const sec = el('section', 'mine-group pl-' + pl.cls);
      const h = el('header', 'mine-group-head');
      h.appendChild(el('span', 'mine-group-dot'));
      h.appendChild(el('span', 'mine-group-label', pl.label));
      h.appendChild(el('span', 'mine-group-sub', pl.sub));
      h.appendChild(el('span', 'mine-group-n', String(arr.length)));
      sec.appendChild(h);
      const cards = el('div', 'mine-cards');
      arr.sort((a, b) => (CONF_ORD[b.confidence] || 0) - (CONF_ORD[a.confidence] || 0) || (b.occurrences || 0) - (a.occurrences || 0));
      for (const r of arr) cards.appendChild(ruleCard(r));
      sec.appendChild(cards); box.appendChild(sec);
    }
    if (!shown) box.appendChild(el('div', 'mine-empty', 'Под фильтр ничего не подходит.'));
  }

  function mineExportText() {
    if (!mine.rules.length) return '';
    const lines = ['# Реестр правил из диалогов', ''];
    if (mine.summary) lines.push(mine.summary, '');
    for (const pl of PLACEMENTS) {
      const arr = mine.rules.filter((r) => placeOf(r) === pl.key && r.status !== 'ignored');
      if (!arr.length) continue;
      lines.push('## ' + pl.label + ' (' + pl.sub + ')', '');
      for (const r of arr) { lines.push('- ' + (r.title || '')); if (r.detail) lines.push('  ' + r.detail); }
      lines.push('');
    }
    return lines.join('\n');
  }
  function mineExportJson() {
    if (!mine.rules.length) return;
    try {
      const blob = new Blob([JSON.stringify({ summary: mine.summary, rules: mine.rules }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      const nm = (activeProject() && activeProject().name) || 'project';
      a.download = 'rules-' + nm.replace(/[^\w.-]/g, '_') + '.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (_) { toast('Не удалось экспортировать', { kind: 'err' }); }
  }

  function renderMine() {
    if (!mineEl) return;
    mineEl.textContent = '';
    const p = activeProject();
    const sc = mine.scanned;

    const head = el('div', 'mine-head');
    head.appendChild(el('div', 'mine-proj', p ? 'Проект: ' + p.name : 'Проект не открыт'));
    if (p && sc) {
      if (sc.found && sc.sessions) {
        const period = sc.first ? (fmtTs(sc.first) + ' — ' + fmtTs(sc.last)) : '';
        head.appendChild(el('div', 'mine-scan', `${sc.sessions} сессий · ${sc.messages} реплик · ${fmtBytes(sc.bytes)}${period ? ' · ' + period : ''}`));
      } else {
        head.appendChild(el('div', 'mine-scan mine-empty', 'Транскриптов Claude Code для этого проекта пока нет (~/.claude/projects/).'));
      }
    }
    const total = (sc && sc.sessions) || mine.totalFiles || 0;
    const pending = Math.max(0, total - doneFull());       // сколько сессий ещё не закрыто (вкл. новые и недочитанные)
    const actions = el('div', 'mine-actions');
    if (mine.running) {
      const stop = el('button', 'btn danger', 'Стоп'); stop.addEventListener('click', mineStop); actions.appendChild(stop);
    } else {
      const canRun = !!(p && sc && sc.found && sc.sessions);
      if (hasRules() && pending > 0) {
        const fresh = mine.done.length > 0; // уже что-то разбирали → это «продолжить/новые/дочитать»
        const cont = el('button', 'btn primary', `${fresh ? 'Продолжить' : 'Анализировать'} — ещё ${pending} ${plural(pending, 'сессия', 'сессии', 'сессий')}`);
        cont.disabled = !canRun; cont.addEventListener('click', () => mineRun(true)); actions.appendChild(cont);
      }
      const run = el('button', 'btn' + (hasRules() && pending > 0 ? '' : ' primary'), hasRules() ? 'Заново' : 'Анализировать диалоги');
      run.disabled = !canRun; run.addEventListener('click', () => mineRun(false)); actions.appendChild(run);
      const pick = el('button', 'btn', 'Выбрать сессии…');
      pick.title = 'Список разговоров по проекту — можно разобрать конкретный';
      pick.disabled = !canRun; pick.addEventListener('click', mineSessions); actions.appendChild(pick);
    }
    head.appendChild(actions);
    head.appendChild(el('div', 'mine-note', 'Реестр копится и сохраняется между перезапусками. Чтобы записать правила в CLAUDE.md — отметьте их галочками и нажмите «Применить выбранные» (с подтверждением).'));
    mineEl.appendChild(head);

    if (mine.running) {
      const prog = el('div', 'mine-progress');
      const line = el('div', 'mine-prog-line');
      line.appendChild(el('span', 'mine-spinner'));
      line.appendChild(el('span', 'mine-prog-tx', 'Claude анализирует историю диалогов…'));
      const elapsed = el('span', 'mine-elapsed', '0 с'); elapsed.id = 'mine-elapsed'; line.appendChild(elapsed);
      prog.appendChild(line);
      const pre = el('pre', 'mine-live'); pre.id = 'mine-live'; pre.textContent = mine.raw || '…'; prog.appendChild(pre);
      mineEl.appendChild(prog);
    }

    if (hasRules()) {
      const body = el('div', 'mine-body');
      const summ = el('div', 'mine-summary');
      if (mine.summary) summ.appendChild(el('div', 'mine-summary-tx', mine.summary));
      const counts = el('div', 'mine-counts');
      const byPlace = {}; for (const k of PLACE_KEYS) byPlace[k] = 0;
      for (const r of mine.rules) byPlace[placeOf(r)]++;
      counts.appendChild(chip('всего: ' + mine.rules.length, 'total'));
      for (const pl of PLACEMENTS) if (byPlace[pl.key]) counts.appendChild(chip(pl.label + ': ' + byPlace[pl.key], 'pl-' + pl.cls));
      summ.appendChild(counts);
      const totalF = (sc && sc.sessions) || mine.totalFiles || 0;
      if (totalF) {
        const pr = el('div', 'mine-prog-info');
        const part = donePartial();
        pr.appendChild(el('span', null, `Разобрано ${doneFull()} из ${totalF} ${plural(totalF, 'сессии', 'сессий', 'сессий')}`
          + (part ? ` · ${part} ${plural(part, 'дочитывается', 'дочитываются', 'дочитываются')}` : '')
          + (mine.batches > 1 ? ` · частей: ${mine.batches}` : '')));
        if (pending > 0) pr.appendChild(el('span', 'mine-prog-more', mine.done.length ? ' — есть неразобранное, «Продолжить»' : ''));
        summ.appendChild(pr);
      }
      body.appendChild(summ);

      const filters = el('div', 'mine-filters');
      const q = el('input', 'mine-search'); q.type = 'search'; q.placeholder = 'Поиск по правилам…'; q.value = mine.q;
      q.addEventListener('input', () => { mine.q = q.value; renderGroups(); });
      filters.appendChild(q);
      const catSel = el('select', 'mine-sel'); catSel.appendChild(new Option('все категории', ''));
      for (const [k, v] of Object.entries(CAT_RU)) catSel.appendChild(new Option(v, k));
      catSel.value = mine.cat; catSel.addEventListener('change', () => { mine.cat = catSel.value; renderGroups(); });
      filters.appendChild(catSel);
      const confSel = el('select', 'mine-sel'); confSel.appendChild(new Option('любая уверенность', ''));
      for (const [k, v] of Object.entries(CONF_RU)) confSel.appendChild(new Option(v, k));
      confSel.value = mine.conf; confSel.addEventListener('change', () => { mine.conf = confSel.value; renderGroups(); });
      filters.appendChild(confSel);
      filters.appendChild(el('div', 'mine-fl-sp'));
      const cpAll = el('button', 'btn', 'Копировать всё'); cpAll.addEventListener('click', () => { try { lite.copyText(mineExportText()); toast('Реестр скопирован', { kind: 'ok' }); } catch (_) {} });
      filters.appendChild(cpAll);
      const exp = el('button', 'btn', 'Экспорт JSON'); exp.addEventListener('click', mineExportJson);
      filters.appendChild(exp);
      body.appendChild(filters);

      const groups = el('div', 'mine-groups'); groups.id = 'mine-groups'; body.appendChild(groups);
      mineEl.appendChild(body);
      renderGroups();
    } else if (!mine.running) {
      const intro = el('div', 'mine-intro');
      intro.appendChild(el('div', 'mine-intro-h', 'Анализ диалогов с агентами'));
      intro.appendChild(el('div', 'mine-intro-tx', 'Claude прочитает историю ваших диалогов по этому проекту (исправления, грабли, договорённости) и соберёт реестр правил с рекомендацией, куда каждое положить — в главный контекст, проектный или в память. Длинную историю можно разбирать частями («Продолжить»). Реестр сохраняется; выбранные правила можно записать в файлы (с подтверждением).'));
      mineEl.appendChild(intro);
    }
  }

  // ============================================================ вкладка «Память» (ctxmem, только чтение)
  // Claude Code хранит долгую память НЕ в проекте, а в каталоге сессий: ~/.claude/projects/<enc(путь)>/
  // memory/ — по файлу на факт плюс индекс MEMORY.md. Индекс уезжает в контекст КАЖДОЙ сессии целиком,
  // тела читаются по надобности — поэтому счётчики токенов показываем раздельно. Отдельной «глобальной»
  // памяти у Claude Code нет: её роль играет память домашнего каталога, это и есть область «Общая».
  // Вкладка НИЧЕГО не пишет — редактирование памяти будет отдельным заходом.
  const memEl = $('#ctx-mem');
  // Мост window.lite строится в preload при СТАРТЕ редактора: пока пользователь не перезапустился
  // после обновления, новых методов там нет. Без этой проверки вызов молча падал необработанным
  // rejection'ом — кнопка выглядела «мёртвой» (так и случилось с «Корзиной» в v1.1.132).
  function memBridge(name) {
    const api = lite.ctxmem;
    if (api && typeof api[name] === 'function') return api[name];
    toast(t('Эта возможность появилась в новой версии — перезапустите редактор, чтобы она заработала'), { kind: 'warn', ttl: 9000 });
    return null;
  }
  const MEM_TYPES = { user: 'о пользователе', feedback: 'обратная связь', project: 'о проекте', reference: 'ссылка' };
  // Две области памяти. «Домашняя» — НЕ общая свалка на все проекты: Claude Code кладёт память по
  // рабочему каталогу сессии, и каталог ~ — такой же «проект». Просто в него попадает то, что вы
  // наговорили агенту, запустив его прямо из домашней папки, вне какого-либо проекта. В сессии
  // конкретного проекта эта память НЕ подмешивается — потому и показываем её отдельно.
  const MEM_SCOPES = [
    { key: 'project', label: 'Проект', hint: 'Память сессий, запущенных в каталоге активного проекта.' },
    { key: 'home', label: 'Домашняя (~)', hint: 'Память сессий, запущенных в домашнем каталоге, вне проектов. В сессии проектов она не попадает.' },
  ];
  const mem = { data: null, path: null, scope: 'project', loading: false, q: '', type: '', open: new Set(), error: '', sort: 'mtime', fav: new Set() };
  // Избранное — «моя» пометка поверх чужих файлов, поэтому живёт в модуле, а не во фронтматтере:
  // память пишет агент, и любое наше поле он рано или поздно затрёт при обновлении факта.
  const MEM_SORTS = [['mtime', 'сначала свежие'], ['chars', 'сначала крупные'], ['name', 'по имени']];
  const memFavKey = () => 'lite.ctxmemfav.v1.' + ((mem.data && mem.data.dir) || mem.scope);
  function memFavLoad() {
    mem.fav = new Set();
    try { const raw = localStorage.getItem(memFavKey()); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) mem.fav = new Set(a); } } catch (_) {}
  }
  function memFavSave() { try { localStorage.setItem(memFavKey(), JSON.stringify([...mem.fav])); } catch (_) {} }

  let memSeq = 0;   // ответ предыдущей области, пришедший позже, подставлял чужие файлы
  async function memLoad(force) {
    const p = activeProject();
    const key = (mem.scope === 'home' ? '~' : (p && p.path) || '');
    if (!force && mem.data && mem.path === key) { renderMem(); return; }
    if (mem.scope !== 'home' && !p) { mem.data = null; mem.path = null; renderMem(); return; }
    const my = ++memSeq;
    mem.loading = true; mem.error = ''; renderMem();
    let r;
    try {
      if (!lite.ctxmem || typeof lite.ctxmem.list !== 'function') throw new Error('перезапустите редактор — мост ещё старый');
      r = await lite.ctxmem.list(p && p.path, mem.scope);
    } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (my !== memSeq) return;   // область успели переключить — этот ответ уже не нужен
    mem.loading = false;
    if (!r || r.ok === false) { mem.error = (r && r.error) || 'не прочитать память'; mem.data = null; toast(t('Память: не удалось прочитать — {0}', mem.error), { kind: 'err' }); }
    else { mem.data = r; mem.path = key; memFavLoad(); }
    renderMem();
  }
  const memFilter = (it) => {
    if (mem.type && it.type !== mem.type) return false;
    if (!mem.q) return true;
    const q = mem.q.toLowerCase();
    return (it.name + ' ' + it.description + ' ' + it.body).toLowerCase().includes(q);
  };
  // Цель [[ссылки]] — слаг `name:` из фронтматтера, который совпадает с именем файла не всегда.
  const memIs = (x, key) => x.file.replace(/\.md$/i, '') === key || String(x.name || '') === key;
  // Раскрыть карточку по ссылке и подскроллить к ней.
  function memGoTo(name) {
    const it = (mem.data && mem.data.items || []).find((x) => memIs(x, name));
    if (!it) return;
    mem.q = ''; mem.type = ''; mem.open.add(it.file);
    renderMem();
    const card = memEl.querySelector(`.mem-card[data-file="${CSS.escape(it.file)}"]`);
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // Кто ссылается на эту память (обратные связи). Их в файлах нет — считаем по всему набору.
  const memInbound = (it) => {
    const keys = [it.file.replace(/\.md$/i, ''), String(it.name || '')].filter(Boolean);
    return ((mem.data && mem.data.items) || []).filter((x) => x.file !== it.file && (x.links || []).some((l) => keys.includes(l)));
  };
  // Показать текст «как есть» (вывод bash -n и подобное): моноширинно, со скроллом.
  // Раньше здесь звался infoModal(), которого в модуле не было, — кнопка «Проверить синтаксис»
  // падала ReferenceError'ом ровно в том случае, ради которого нужна: когда ошибка нашлась.
  function infoModal(title, text) {
    const { m, close } = makeModal(`<h2 class="ctx-info-h"></h2>
      <pre class="ctx-info-pre"></pre>
      <div class="modal-actions"><button class="btn primary" id="cxi-ok">Понятно</button></div>`);
    m.classList.add('ctx-modal', 'ctx-modal-wide');
    m.querySelector('.ctx-info-h').textContent = title;
    m.querySelector('.ctx-info-pre').textContent = String(text == null ? '' : text);
    m.querySelector('#cxi-ok').addEventListener('click', close);
  }
  // ── Общий редактор текстового файла: CodeMirror + «Сохранить» + «🕘 История копий».
  // Используется и памятью, и вкладкой «Файлы» — разница только в load/save, поэтому они приходят
  // колбэками. Каждое сохранение на стороне main сначала кладёт копию (ротация 10 на путь).
  function openFileEditor(opts) {
    const { title, subtitle, file, text, language, onSave } = opts;
    const dirtyKey = 'file:' + (++dirtyKeySeq);
    let editor = null;
    const name = String(language || file || '');
    const isMd = /\.(md|markdown)$/i.test(name);
    const isJson = /\.(json|jsonc|json5)$/i.test(name);
    const isJsonl = /\.(jsonl|ndjson)$/i.test(name);
    const isSh = /\.(sh|bash|zsh)$/i.test(name) || /^\.?(bashrc|zshrc|profile)$/i.test(name);
    const { m, close } = makeModal(`<h2>${title.replace(/[<>&]/g, '')}</h2>
      <div class="about-desc mem-ed-sub"></div>
      <div class="ctx-medbar">
        <div class="ctx-seg" id="fed-modes" hidden>
          <button class="ctx-segbtn on" id="fed-mode-src">✎ Оригинал</button>
          <button class="ctx-segbtn" id="fed-mode-prev">👁 Превью</button>
        </div>
        <button class="btn sm" id="fed-fold" hidden>Свернуть всё</button>
        <button class="btn sm" id="fed-unfold" hidden>Развернуть всё</button>
        <button class="btn sm" id="fed-jsonl" hidden>Разобрать записи</button>
        <button class="btn sm" id="fed-sh" hidden>Проверить синтаксис</button>
        <span id="fed-chars" class="ctx-mchars"></span>
        <div class="mine-fl-sp"></div>
        <button class="btn sm" id="fed-hist">🕘 История копий</button>
      </div>
      <div class="fed-body">
        <div id="fed-ed" class="ctx-med"></div>
        <div id="fed-prev" class="fed-prev" hidden></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="fed-cancel">Закрыть</button>
        <button class="btn primary" id="fed-save" hidden>Сохранить</button>
      </div>`, () => { markDirty(dirtyKey, false); if (editor) editor.destroy(); });
    // Файловый редактор живёт в модалке НА ВЕСЬ ЭКРАН (90×90 % окна) и тянется вместе с ним:
    // размеры в vw/vh, поэтому resize окна модуля обрабатывается браузером сам, без слушателей.
    m.classList.add('ctx-modal', 'ctx-modal-file');
    m.querySelector('.mem-ed-sub').textContent = subtitle || file || '';
    const chars = m.querySelector('#fed-chars');
    const saveBtn = m.querySelector('#fed-save');
    const cancelBtn = m.querySelector('#fed-cancel');
    const prevBox = m.querySelector('#fed-prev');
    const host = m.querySelector('#fed-ed');
    let orig = String(text == null ? '' : text);
    const recheck = () => {
      const dirty = !!editor && editor.getValue() !== orig;
      markDirty(dirtyKey, dirty);
      saveBtn.hidden = !dirty;
      cancelBtn.textContent = dirty ? 'Отмена' : 'Закрыть';
      return dirty;
    };
    // languageFor отдаёт подсветку из общего реестра CodeMirror по имени файла (md/json/…);
    // если пакет языка ещё не подгружен, он приезжает следующим микротаском — редактор
    // тогда просто пересоздаётся с ним (для одноразовой модалки это дешевле reconfigure).
    const mk = (lang, doc) => createCodeEditor(host, {
      doc, language: lang || [],
      wrap: true,          // длинные строки переносим — горизонтально скроллить конфиги невозможно
      fold: true,          // стрелки сворачивания: объекты JSON, разделы markdown
      onChange: (v) => { chars.textContent = fmtTok(v.length); recheck(); },
    });
    editor = mk(languageFor(name, (support) => {
      if (!editor) return;
      const cur = editor.getValue();
      editor.destroy(); host.textContent = '';
      editor = mk(support, cur);
      recheck();
    }), orig);
    chars.textContent = fmtTok(orig.length);
    // markdown → переключатель «Оригинал / Превью»; json → сворачивание ключей
    if (isMd) {
      const seg = m.querySelector('#fed-modes'); seg.hidden = false;
      const setMode = (preview) => {
        if (preview) renderSafeMarkdown(prevBox, editor.getValue());
        host.hidden = preview; prevBox.hidden = !preview;
        m.querySelector('#fed-mode-prev').classList.toggle('on', preview);
        m.querySelector('#fed-mode-src').classList.toggle('on', !preview);
      };
      m.querySelector('#fed-mode-src').addEventListener('click', () => setMode(false));
      m.querySelector('#fed-mode-prev').addEventListener('click', () => setMode(true));
    }
    if (isJson || isJsonl) {
      const f = m.querySelector('#fed-fold'), u = m.querySelector('#fed-unfold');
      f.hidden = false; u.hidden = false;
      f.addEventListener('click', () => editor.foldAll());
      u.addEventListener('click', () => editor.unfoldAll());
    }
    // .jsonl — по записи на строку: в сыром виде это нечитаемая простыня. «Разобрать записи»
    // показывает каждую строку развёрнутым JSON (в превью, файл при этом не меняется).
    if (isJsonl) {
      const b = m.querySelector('#fed-jsonl'); b.hidden = false;
      b.addEventListener('click', () => {
        const lines = editor.getValue().split('\n').filter((l) => l.trim());
        const out = []; let bad = 0;
        lines.forEach((l, i) => {
          try { out.push('── запись ' + (i + 1) + ' ──\n' + JSON.stringify(JSON.parse(l), null, 2)); }
          catch (_) { bad++; out.push('── запись ' + (i + 1) + ' (не разобралась) ──\n' + l); }
        });
        prevBox.textContent = out.join('\n\n');
        host.hidden = true; prevBox.hidden = false;
        toast(t('Разобрано записей: {0}{1}', lines.length, bad ? t(' · не разобралось: {0}', bad) : ''), { ttl: 6000 });
      });
    }
    // shell — «bash -n» только разбирает скрипт, ничего не выполняя: удобно перед сохранением хука
    if (isSh && opts.rel) {
      const b = m.querySelector('#fed-sh'); b.hidden = false;
      b.addEventListener('click', async () => {
        const r = await lite.ctxfs.shcheck(opts.scope, (activeProject() || {}).path, opts.rel);
        if (!r || !r.ok) { toast(t('Не проверить синтаксис: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
        if (r.clean) toast(t('Синтаксис в порядке'), { kind: 'ok', ttl: 5000 });
        else infoModal('Ошибка синтаксиса', r.message || '—');
      });
    }
    const doSave = async () => {
      const body = editor.getValue();
      const r = await onSave(body);
      if (!r || !r.ok) { toast(t('Не сохранить: {0}', (r && r.error) || '?'), { kind: 'err' }); return false; }
      orig = body; recheck();
      toast(t('Сохранено: {0}', subtitle || file || ''), { ttl: 5000 });
      return true;
    };
    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', () => {
      if (!recheck()) { close(); return; }
      showConfirm('Закрыть без сохранения?', 'Правки будут потеряны.', 'Закрыть', close);
    });
    m.querySelector('#fed-hist').addEventListener('click', () => openBackups(file, (txt) => {
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: txt } });
      recheck();
      toast(t('Версия подставлена в редактор — нажмите «Сохранить», чтобы записать'), { ttl: 8000 });
    }));
    return { close };
  }
  // История копий одного файла: показать, посмотреть, подставить в открытый редактор.
  async function openBackups(file, onPick) {
    if (!lite.ctxbk || typeof lite.ctxbk.list !== 'function') {
      toast(t('Эта возможность появилась в новой версии — перезапустите редактор, чтобы она заработала'), { kind: 'warn', ttl: 9000 });
      return;
    }
    const r = await lite.ctxbk.list(file);
    if (!r || !r.ok) { toast(t('Не открыть историю копий: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
    const { m, close } = makeModal(`<h2>🕘 История копий</h2>
      <div class="about-desc">Копия снимается перед каждым сохранением из модуля. Хранятся ${(r.keep || 10)} последних на файл, лишние удаляются.</div>
      <div id="bk-list" class="ctx-vlist"></div>
      <div class="modal-actions"><button class="btn" id="bk-dir">Открыть папку</button><button class="btn primary" id="bk-close">Закрыть</button></div>`);
    m.classList.add('ctx-modal', 'ctx-modal-wide');
    const list = m.querySelector('#bk-list');
    if (!r.list.length) list.appendChild(el('div', 'ctx-addhint', 'Копий пока нет — они появятся после первого сохранения.'));
    for (const rec of r.list) {
      const row = el('div', 'ctx-vrow');
      const head = el('div', 'ctx-vhead');
      head.appendChild(el('span', 'ctx-vname', fmtTs(rec.ts)));
      head.appendChild(el('span', 'ctx-vmeta', fmtTok(rec.chars)));
      row.appendChild(head);
      if (!file) row.appendChild(el('div', 'mem-file', rec.file));
      const acts = el('div', 'ctx-vacts');
      if (rec.gone) acts.appendChild(el('span', 'ctx-vmeta', 'копия пропала с диска'));
      else {
        const use = el('button', 'btn sm', onPick ? 'Подставить в редактор' : 'Восстановить в файл');
        use.addEventListener('click', async () => {
          if (onPick) {
            const rr = await lite.ctxbk.read(rec.id);
            if (!rr || !rr.ok) { toast(t('Не прочитать копию: {0}', (rr && rr.error) || '?'), { kind: 'err' }); return; }
            onPick(rr.text); close();
          } else {
            showConfirm('Восстановить эту копию?', `Текущее содержимое ${rec.file} уйдёт в новую копию, файл заменится версией от ${fmtTs(rec.ts)}.`, 'Восстановить', async () => {
              const rr = await lite.ctxbk.restore(rec.id);
              if (!rr || !rr.ok) { toast(t('Не восстановить: {0}', (rr && rr.error) || '?'), { kind: 'err' }); return; }
              toast(t('Файл восстановлен из копии')); close();
              memLoad(true); cfsLoad(true);   // копия могла быть и файлом .claude, и памятью — перечитываем обе вкладки
            });
          }
        });
        acts.appendChild(use);
      }
      row.appendChild(acts);
      list.appendChild(row);
    }
    m.querySelector('#bk-dir').addEventListener('click', () => lite.openInFileManager(r.dir));
    m.querySelector('#bk-close').addEventListener('click', close);
  }
  // Правка файла памяти: правится ВЕСЬ файл, вместе с фронтматтером (описание и тип тоже иногда
  // надо поправить). Сырьё берём отдельной ручкой — в списке тела приходят уже без фронтматтера.
  async function memEdit(it) {
    const save = memBridge('save'); if (!save) return;
    const read = memBridge('read'); if (!read) return;
    const p = activeProject();
    const r = await read(p && p.path, mem.scope, it.file);
    if (!r || !r.ok) { toast(t('Не прочитать файл памяти: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
    openFileEditor({
      title: 'Правка памяти',
      subtitle: r.file,
      file: r.file,
      text: r.text,
      language: it.file,
      onSave: async (body) => {
        const rr = await save(p && p.path, mem.scope, it.file, body);
        if (rr && rr.ok) memLoad(true);
        return rr;
      },
    });
  }

  function memCard(it) {
    const card = el('div', 'mem-card' + (mem.open.has(it.file) ? ' open' : '') + (mem.fav.has(it.file) ? ' fav' : ''));
    card.dataset.file = it.file;
    const head = el('div', 'mem-head');
    head.addEventListener('click', () => { if (mem.open.has(it.file)) mem.open.delete(it.file); else mem.open.add(it.file); renderMem(); });
    head.appendChild(el('span', 'mem-caret', mem.open.has(it.file) ? '▾' : '▸'));
    head.appendChild(el('span', 'mem-name', it.name));
    if (it.type) head.appendChild(el('span', 'mem-tag t-' + it.type, MEM_TYPES[it.type] || it.type));
    const meta = el('div', 'mem-meta');
    meta.appendChild(el('span', null, fmtTok(it.chars)));
    if (it.mtime) meta.appendChild(el('span', null, fmtTs(it.mtime)));
    head.appendChild(el('div', 'mem-sp'));
    head.appendChild(meta);
    // действия карточки: клики не должны сворачивать/разворачивать её, поэтому глушим всплытие
    const acts = el('div', 'mem-acts');
    const act = (ic, title, fn, cls) => {
      const b = el('button', 'mem-act' + (cls ? ' ' + cls : ''));
      b.appendChild(icon(ic, 14)); b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      acts.appendChild(b);
      return b;
    };
    const isFav = mem.fav.has(it.file);
    act('star', isFav ? 'Убрать из избранного' : 'В избранное — такие всегда сверху', () => {
      if (isFav) mem.fav.delete(it.file); else mem.fav.add(it.file);
      memFavSave(); renderMem();
    }, isFav ? 'on' : '');
    act('pencil', 'Редактировать файл памяти', () => memEdit(it));
    act('terminal', 'Спросить агента про эту память — вставить в терминал проекта (без Enter)', () => memAsk(it));
    act('trash', 'Удалить в корзину (можно восстановить)', () => memDelete(it), 'danger');
    head.appendChild(acts);
    card.appendChild(head);
    if (it.description) card.appendChild(el('div', 'mem-desc', it.description));
    if (!mem.open.has(it.file)) return card;
    const bodyBox = el('div', 'mem-body');
    if (it.tooBig) bodyBox.textContent = 'Файл слишком большой для показа — откройте его в файловом менеджере.';
    else renderSafeMarkdown(bodyBox, it.body || '(пусто)');
    card.appendChild(bodyBox);
    if (it.links && it.links.length) {
      const row = el('div', 'mem-links');
      row.appendChild(el('span', 'mem-links-lab', 'связи:'));
      for (const l of it.links) {
        const broken = (it.broken || []).includes(l);
        const chip = el('button', 'mem-link' + (broken ? ' broken' : ''), l);
        chip.title = broken ? 'Ссылка ведёт в никуда — такой памяти нет' : 'Перейти к этой памяти';
        if (!broken) chip.addEventListener('click', () => memGoTo(l));
        else chip.disabled = true;
        row.appendChild(chip);
      }
      card.appendChild(row);
    }
    const inb = memInbound(it);
    if (inb.length) {
      const row = el('div', 'mem-links');
      row.appendChild(el('span', 'mem-links-lab', 'ссылаются на неё:'));
      for (const x of inb) {
        const chip = el('button', 'mem-link', x.name);
        chip.title = 'Перейти к этой памяти';
        chip.addEventListener('click', () => memGoTo(x.file.replace(/\.md$/i, '')));   // по файлу — он есть всегда
        row.appendChild(chip);
      }
      card.appendChild(row);
    }
    const foot = el('div', 'mem-foot');
    foot.appendChild(el('span', 'mem-file', it.file));
    card.appendChild(foot);
    return card;
  }
  // «Спросить агента»: вставляем в терминал проекта путь к файлу и заготовку вопроса — БЕЗ Enter,
  // чтобы человек дописал вопрос сам (тот же уговор, что в «Задачах»).
  function memAsk(it) {
    const dir = mem.data && mem.data.dir;
    if (!dir) return;
    lite.editorBus.sendToTerminal(`Прочитай файл памяти ${dir}/${it.file} («${it.name}») и ответь на вопрос: `);
    toast(t('Вставлено в терминал проекта: {0} — допишите вопрос и нажмите Enter', it.name), { ttl: 7000 });
  }
  function memDelete(it) {
    const inIndex = !!(mem.data && mem.data.index.some((r) => r.file === it.file));
    // два ЦЕЛЬНЫХ сообщения вместо склейки с условным хвостом — иначе перевод разъезжается
    let why = inIndex
      ? t('«{0}» уедет в ~/.claude/custom-trash-memory, а строка о ней исчезнет из MEMORY.md. Восстановить можно из корзины.', it.name)
      : t('«{0}» уедет в ~/.claude/custom-trash-memory. Восстановить можно из корзины.', it.name);
    // Кто на неё ссылается: после удаления эти [[ссылки]] станут битыми. Молча плодить обрывы —
    // ровно то, из-за чего связи в памяти со временем и разваливаются, поэтому предупреждаем заранее.
    const inbound = memInbound(it);
    if (inbound.length) why += ' ' + t('На неё ссылаются другие памяти ({0}): {1} — их связи станут битыми.', inbound.length, inbound.map((x) => x.name).join(', '));
    showConfirm('Удалить память в корзину?', why, 'Удалить', async () => {
        const del = memBridge('del'); if (!del) return;
        const p = activeProject();
        const r = await del(p && p.path, mem.scope, it.file);
        if (!r || !r.ok) { toast(t('Не удалить память: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
        mem.open.delete(it.file); mem.fav.delete(it.file); memFavSave();
        toast(t('«{0}» — в корзине', it.name), { ttl: 6000 });
        memLoad(true);
      });
  }
  async function memTrash() {
    const fn = memBridge('trash'); if (!fn) return;
    const r = await fn();
    if (!r || !r.ok) { toast(t('Не открыть корзину: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
    const { m, close } = makeModal(`<h2>🗑 Корзина памяти</h2>
      <div class="about-desc">Удалённые файлы памяти со всех проектов. Восстановление возвращает и файл, и его строку в <code>MEMORY.md</code> на прежнее место.</div>
      <div id="mtr-list" class="ctx-vlist"></div>
      <div class="modal-actions"><button class="btn" id="mtr-dir">Открыть папку</button><button class="btn primary" id="mtr-close">Закрыть</button></div>`);
    m.classList.add('ctx-modal', 'ctx-modal-wide');
    const list = m.querySelector('#mtr-list');
    const draw = (rows) => {
      list.textContent = '';
      if (!rows.length) { list.appendChild(el('div', 'ctx-addhint', 'Корзина пуста.')); return; }
      for (const rec of rows) {
        const row = el('div', 'ctx-vrow');
        const head = el('div', 'ctx-vhead');
        head.appendChild(el('span', 'ctx-vname', rec.name));
        head.appendChild(el('span', 'ctx-vmeta', `${fmtTok(rec.chars)} · ${fmtTs(rec.ts)} · ${rec.scope === 'home' ? 'домашняя' : 'проект'}`));
        row.appendChild(head);
        row.appendChild(el('div', 'mem-file', rec.dir + '/' + rec.file));
        const acts = el('div', 'ctx-vacts');
        if (rec.gone) acts.appendChild(el('span', 'ctx-vmeta', 'файл из корзины пропал — восстанавливать нечего'));
        else {
          const b = el('button', 'btn sm', 'Восстановить');
          b.addEventListener('click', async () => {
            const restore = memBridge('restore'); if (!restore) return;
            const rr = await restore(rec.id);
            if (!rr || !rr.ok) { toast(t('Не восстановить: {0}', (rr && rr.error) || '?'), { kind: 'err' }); return; }
            toast(t('«{0}» восстановлена', rec.name));
            const fresh = await lite.ctxmem.trash();
            draw((fresh && fresh.list) || []);
            memLoad(true);
          });
          acts.appendChild(b);
        }
        row.appendChild(acts);
        list.appendChild(row);
      }
    };
    draw(r.list || []);
    m.querySelector('#mtr-dir').addEventListener('click', () => lite.openInFileManager(r.dir));
    m.querySelector('#mtr-close').addEventListener('click', close);
  }

  function renderMem() {
    if (!memEl) return;
    memEl.textContent = '';
    const d = mem.data;

    // ── шапка: область, обновление, папка ──
    const bar = el('div', 'mem-bar');
    const seg = el('div', 'ctx-seg');
    for (const sc of MEM_SCOPES) {
      const b = el('button', 'ctx-segbtn' + (mem.scope === sc.key ? ' on' : ''), sc.label);
      b.title = sc.hint;
      b.addEventListener('click', () => { if (mem.scope === sc.key) return; mem.scope = sc.key; mem.open.clear(); mem.data = null; memLoad(); });
      seg.appendChild(b);
    }
    bar.appendChild(seg);
    const refresh = el('button', 'btn sm', '⟳ Обновить');
    refresh.addEventListener('click', () => memLoad(true));
    bar.appendChild(refresh);
    if (d && d.dir) {
      const openDir = el('button', 'btn sm', 'Открыть папку');
      openDir.title = d.dir;
      // ⚠️ мост зовётся lite.openInFileManager — пространства lite.shell в preload НЕТ.
      // Вызов fire-and-forget: shell:openPath намеренно отвечает сразу, а ошибку открытия пишет в лог.
      openDir.addEventListener('click', () => lite.openInFileManager(d.dir));
      bar.appendChild(openDir);
    }
    const trashBtn = el('button', 'btn sm', '🗑 Корзина');
    trashBtn.title = 'Удалённые файлы памяти — можно восстановить';
    trashBtn.addEventListener('click', memTrash);
    bar.appendChild(trashBtn);
    bar.appendChild(el('div', 'mine-fl-sp'));
    if (d && d.items.length) {
      const right = el('div', 'mem-bar-r');
      const sort = el('select', 'mine-sel');
      sort.title = 'Порядок списка (избранное всегда сверху)';
      for (const [v, lbl] of MEM_SORTS) { const o = el('option', null, lbl); o.value = v; if (mem.sort === v) o.selected = true; sort.appendChild(o); }
      sort.addEventListener('change', () => { mem.sort = sort.value; renderMem(); });
      right.appendChild(sort);
      const q = el('input', 'mine-search'); q.type = 'search'; q.placeholder = 'поиск по памяти'; q.value = mem.q;
      q.dataset.keepFocus = '1';
      q.addEventListener('input', () => {
        const at = q.selectionStart;
        mem.q = q.value.trim();
        renderMem();
        // фокус переносим на НОВОЕ поле: старое уже выброшено из документа вместе со всей вкладкой
        const fresh = memEl.querySelector('.mine-search[data-keep-focus="1"]');
        if (fresh) { fresh.focus(); try { fresh.setSelectionRange(at, at); } catch (_) {} }
      });
      right.appendChild(q);
      const sel = el('select', 'mine-sel');
      const opt = (v, t) => { const o = el('option', null, t); o.value = v; if (mem.type === v) o.selected = true; sel.appendChild(o); };
      opt('', 'все типы');
      for (const [k, lbl] of Object.entries(MEM_TYPES)) if (d.items.some((i) => i.type === k)) opt(k, lbl);
      sel.addEventListener('change', () => { mem.type = sel.value; renderMem(); });
      right.appendChild(sel);
      bar.appendChild(right);
    }
    memEl.appendChild(bar);
    const scope = MEM_SCOPES.find((x) => x.key === mem.scope);
    if (scope) memEl.appendChild(el('div', 'mem-scope', scope.hint));

    if (mem.loading) { memEl.appendChild(el('div', 'mine-empty', 'Читаю память…')); return; }
    if (mem.error) { memEl.appendChild(el('div', 'mine-empty', t('Не удалось прочитать память: {0}', mem.error))); return; }
    if (mem.scope === 'project' && !activeProject()) { memEl.appendChild(el('div', 'mine-empty', 'Сначала откройте проект.')); return; }
    if (!d) { memEl.appendChild(el('div', 'mine-empty', 'Память ещё не прочитана — нажмите «⟳ Обновить».')); return; }

    if (!d.exists || !d.items.length) {
      const intro = el('div', 'mine-intro');
      intro.appendChild(el('div', 'mine-intro-h', 'Память пока пуста'));
      intro.appendChild(el('div', 'mine-intro-tx', 'Claude Code записывает сюда факты, которые стоит помнить между сессиями: кто вы и как работаете, ваши поправки, договорённости по проекту, ссылки на внешние ресурсы. Файлы появятся сами, когда агент сочтёт что-то достойным запоминания. Память лежит рядом с историей сессий, а не в самом проекте.'));
      if (d.dir) intro.appendChild(el('div', 'mem-path', d.dir));
      memEl.appendChild(intro);
      return;
    }

    // ── сводка: сколько весит индекс (всегда в контексте) и тела (по надобности) ──
    const sum = el('div', 'mem-sum');
    const bodies = d.items.reduce((a, i) => a + (i.chars || 0), 0);
    const stat = (val, lab, title) => { const w = el('div', 'mem-stat'); w.title = title || ''; w.appendChild(el('b', null, val)); w.appendChild(el('span', null, lab)); return w; };
    sum.appendChild(stat(String(d.items.length), plural(d.items.length, 'факт', 'факта', 'фактов')));
    sum.appendChild(stat(fmtTok(d.indexChars || 0), 'индекс — в контексте всегда', 'MEMORY.md целиком попадает в контекст каждой сессии'));
    sum.appendChild(stat(fmtTok(bodies), 'тела — по надобности', 'Файлы памяти читаются агентом, когда он вспоминает соответствующий факт'));
    memEl.appendChild(sum);
    if (d.dir) { const pth = el('div', 'mem-path', d.dir); pth.title = 'Каталог памяти'; memEl.appendChild(pth); }

    // ── расхождения: то, чего не видно без ручной сверки ──
    const warns = [];
    if (!d.hasIndex) warns.push('Индекса MEMORY.md нет — Claude Code не увидит эту память в начале сессии.');
    if (d.missing.length) warns.push(t('В индексе есть записи без файла ({0}): {1}', d.missing.length, d.missing.join(', ')));
    if (d.orphans.length) warns.push(t('Файлы вне индекса ({0}): {1} — агент про них не вспомнит.', d.orphans.length, d.orphans.join(', ')));
    const broken = d.items.reduce((a, i) => a + ((i.broken || []).length), 0);
    if (broken) warns.push(t('Ссылок в никуда: {0} — они помечены красным в карточках.', broken));
    if (d.truncated) warns.push('Показаны не все файлы — их слишком много.');
    for (const w of warns) memEl.appendChild(el('div', 'mem-warn', w));

    const list = el('div', 'mem-list');
    const by = {
      mtime: (a, b) => (b.mtime || 0) - (a.mtime || 0),
      chars: (a, b) => (b.chars || 0) - (a.chars || 0),
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'ru'),
    }[mem.sort] || ((a, b) => (b.mtime || 0) - (a.mtime || 0));
    // избранное всегда выше — независимо от выбранной сортировки (внутри группы порядок обычный)
    const shown = d.items.filter(memFilter).sort((a, b) => {
      const fa = mem.fav.has(a.file) ? 0 : 1, fb = mem.fav.has(b.file) ? 0 : 1;
      return fa !== fb ? fa - fb : by(a, b);
    });
    for (const it of shown) list.appendChild(memCard(it));
    if (!shown.length) list.appendChild(el('div', 'mine-empty', 'Под фильтр ничего не подходит.'));
    memEl.appendChild(list);
  }

  // ============================================================ вкладка «Файлы» (ctxfs)
  // Дерево того, чем НАСТРАИВАЮТ агента: .claude проекта (+ его CLAUDE.md рядом) и глобальный
  // ~/.claude. Служебные каталоги (projects/ на 115 МБ, security/ на 300 МБ, cache/, plugins/)
  // в дерево не попадают — это не настройки. Файл открывается в том же редакторе, что и память,
  // с историей копий; сохранение всегда сначала кладёт копию (ротация 10 на путь).
  const filesEl = $('#ctx-files');
  const FILE_SCOPES = [
    { key: 'project', label: 'Проект', hint: 'Папка .claude в проекте: правила, скиллы, команды, настройки — и CLAUDE.md рядом с ней.' },
    { key: 'home', label: 'Глобально (~)', hint: 'Папка ~/.claude: глобальный CLAUDE.md, settings.json, ваши команды и скиллы для всех проектов.' },
  ];
  const cfs = { scope: 'project', data: null, loading: false, error: '', open: new Set(), sel: null };

  let cfsSeq = 0;
  async function cfsLoad(force) {
    const p = activeProject();
    if (cfs.scope !== 'home' && !p) { cfs.data = null; renderFiles(); return; }
    if (!force && cfs.data && cfs.data.scope === cfs.scope) { renderFiles(); return; }
    if (!lite.ctxfs || typeof lite.ctxfs.tree !== 'function') {
      cfs.error = 'перезапустите редактор — мост ещё старый'; cfs.data = null; renderFiles(); return;
    }
    const my = ++cfsSeq;
    const askedScope = cfs.scope;   // дерево помечаем ТОЙ областью, которую спрашивали, а не текущей
    cfs.loading = true; cfs.error = ''; renderFiles();
    let r;
    try { r = await lite.ctxfs.tree(askedScope, p && p.path); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (my !== cfsSeq) return;
    cfs.loading = false;
    if (!r || !r.ok) { cfs.error = (r && r.error) || 'не прочитать папку'; cfs.data = null; }
    else { cfs.data = { ...r, scope: askedScope }; }
    renderFiles();
  }
  async function cfsOpen(node) {
    const p = activeProject();
    const r = await lite.ctxfs.read(cfs.scope, p && p.path, node.rel);
    if (!r || !r.ok) { toast(t('Не открыть файл: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
    // Большой файл не тянем целиком: открываем окнами (см. openBigViewer) и ТОЛЬКО на чтение —
    // сохранить кусок нельзя, не потеряв невидимую часть.
    if (!r.whole) { openBigViewer(node, r); return; }
    openFileEditor({
      title: 'Правка файла',
      subtitle: r.file,
      file: r.file,
      text: r.text,
      language: node.name,
      scope: cfs.scope, rel: node.rel,
      onSave: async (body) => {
        const rr = await lite.ctxfs.write(cfs.scope, p && p.path, node.rel, body);
        if (rr && rr.ok) cfsLoad(true);
        return rr;
      },
    });
  }
  // ── Просмотр большого файла окнами ────────────────────────────────────────────────────────
  // Держим максимум ТРИ соседних окна (предыдущее / видимое / следующее). Доехал до края —
  // подгружаем соседнее, а дальнее выбрасываем: сколько бы ни было в файле мегабайт, в памяти
  // всегда лежит около 384 КБ. Режим только для чтения — редактировать кусок нельзя.
  const BIG_KEEP = 3;
  function openBigViewer(node, first) {
    const p = activeProject();
    let wins = [{ start: first.start, end: first.end, text: first.text }];  // отсортированы по start
    let busy = false, editor = null;
    const size = first.size;
    const { m, close } = makeModal(`<h2>Просмотр большого файла</h2>
      <div class="about-desc mem-ed-sub"></div>
      <div class="ctx-medbar">
        <span class="mem-warn big-note">Только чтение: файл открыт частями, правка вернётся при размере до ${fmtBytes(first.editable ? first.size : 512 * 1024)}.</span>
        <div class="mine-fl-sp"></div>
        <span id="big-pos" class="ctx-mchars"></span>
        <button class="btn sm" id="big-top">В начало</button>
        <button class="btn sm" id="big-end">В конец</button>
      </div>
      <div class="fed-body"><div id="big-ed" class="ctx-med"></div></div>
      <div class="modal-actions"><button class="btn primary" id="big-close">Закрыть</button></div>`, () => { if (editor) editor.destroy(); });
    m.classList.add('ctx-modal', 'ctx-modal-file');
    m.querySelector('.mem-ed-sub').textContent = first.file;
    const host = m.querySelector('#big-ed');
    const pos = m.querySelector('#big-pos');
    const docText = () => wins.map((w) => w.text).join('');
    const paint = (keepBottom) => {
      const view = editor && editor.view;
      const prevH = view ? view.scrollDOM.scrollHeight : 0;
      const prevTop = view ? view.scrollDOM.scrollTop : 0;
      const text = docText();
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text } });
      if (view && keepBottom) view.scrollDOM.scrollTop = prevTop + (view.scrollDOM.scrollHeight - prevH);
      const from = wins[0].start, to = wins[wins.length - 1].end;
      pos.textContent = `${fmtBytes(from)} – ${fmtBytes(to)} из ${fmtBytes(size)}`;
    };
    const load = async (offset, side) => {
      if (busy) return;
      busy = true;
      try {
        const r = await lite.ctxfs.read(cfs.scope, p && p.path, node.rel, offset);
        if (!r || !r.ok || !r.text) return;
        if (wins.some((w) => w.start === r.start)) return;      // это окно уже показано
        if (side === 'down') { wins.push({ start: r.start, end: r.end, text: r.text }); if (wins.length > BIG_KEEP) wins.shift(); }
        else { wins.unshift({ start: r.start, end: r.end, text: r.text }); if (wins.length > BIG_KEEP) wins.pop(); }
        paint(side === 'up');
      } finally { busy = false; }
    };
    editor = createCodeEditor(host, {
      doc: first.text, readOnly: true, wrap: true,
      language: languageFor(node.name, (sup) => {
        if (!editor) return;
        const cur = editor.getValue(); const sc = editor.view.scrollDOM.scrollTop;
        editor.destroy(); host.textContent = '';
        editor = createCodeEditor(host, { doc: cur, readOnly: true, wrap: true, language: sup });
        editor.view.scrollDOM.scrollTop = sc;
        bindScroll();
      }),
    });
    function bindScroll() {
      const sd = editor.view.scrollDOM;
      sd.addEventListener('scroll', () => {
        const nearBottom = sd.scrollTop + sd.clientHeight > sd.scrollHeight - 400;
        const nearTop = sd.scrollTop < 400;
        const last = wins[wins.length - 1], head = wins[0];
        if (nearBottom && last.end < size) load(last.end, 'down');
        else if (nearTop && head.start > 0) load(Math.max(0, head.start - (first.window || 128 * 1024)), 'up');
      });
    }
    bindScroll();
    paint(false);
    // Прыжок к краю файла. wins НЕ трогаем до ответа: пока идёт чтение, слушатель скролла
    // продолжает работать, а на пустом wins он падал (wins[0]/wins.at(-1) === undefined).
    const jump = async (off, toBottom) => {
      if (busy) return;
      busy = true;
      try {
        const r = await lite.ctxfs.read(cfs.scope, p && p.path, node.rel, off);
        if (!r || !r.ok) { toast(t('Не прочитать файл: {0}', (r && r.error) || '?'), { kind: 'err' }); return; }
        wins = [{ start: r.start, end: r.end, text: r.text }];
        paint(false);
        editor.view.scrollDOM.scrollTop = toBottom ? editor.view.scrollDOM.scrollHeight : 0;
      } finally { busy = false; }
    };
    m.querySelector('#big-top').addEventListener('click', () => jump(0, false));
    m.querySelector('#big-end').addEventListener('click', () => jump(Math.max(0, size - (first.window || 128 * 1024)), true));
    m.querySelector('#big-close').addEventListener('click', close);
  }
  // «Спросить агента» для файла настроек: тот же уговор, что в памяти — путь + заготовка, без Enter.
  function cfsAsk(node, abs) {
    lite.editorBus.sendToTerminal(`Посмотри файл ${abs} и `);
    toast(t('Путь вставлен в терминал проекта — допишите просьбу и нажмите Enter'), { ttl: 7000 });
  }
  function renderFiles() {
    if (!filesEl) return;
    filesEl.textContent = '';
    const bar = el('div', 'mem-bar');
    const seg = el('div', 'ctx-seg');
    for (const sc of FILE_SCOPES) {
      const b = el('button', 'ctx-segbtn' + (cfs.scope === sc.key ? ' on' : ''), sc.label);
      b.title = sc.hint;
      b.addEventListener('click', () => { if (cfs.scope === sc.key) return; cfs.scope = sc.key; cfs.data = null; cfs.open.clear(); cfsLoad(); });
      seg.appendChild(b);
    }
    bar.appendChild(seg);
    const refresh = el('button', 'btn sm', '⟳ Обновить');
    refresh.addEventListener('click', () => cfsLoad(true));
    bar.appendChild(refresh);
    if (cfs.data && cfs.data.root) {
      const openDir = el('button', 'btn sm', 'Открыть папку');
      openDir.title = cfs.data.root;
      openDir.addEventListener('click', () => lite.openInFileManager(cfs.data.root));
      bar.appendChild(openDir);
    }
    const hist = el('button', 'btn sm', '🕘 История копий');
    hist.title = 'Все копии, снятые модулем перед сохранением';
    hist.addEventListener('click', () => openBackups('', null));
    bar.appendChild(hist);
    filesEl.appendChild(bar);
    const sc = FILE_SCOPES.find((x) => x.key === cfs.scope);
    if (sc) filesEl.appendChild(el('div', 'mem-scope', sc.hint));

    if (cfs.loading) { filesEl.appendChild(el('div', 'mine-empty', 'Читаю папку…')); return; }
    if (cfs.error) { filesEl.appendChild(el('div', 'mine-empty', t('Не прочитать папку: {0}', cfs.error))); return; }
    if (cfs.scope !== 'home' && !activeProject()) { filesEl.appendChild(el('div', 'mine-empty', 'Сначала откройте проект.')); return; }
    const d = cfs.data;
    if (!d) { filesEl.appendChild(el('div', 'mine-empty', 'Папка ещё не прочитана — нажмите «⟳ Обновить».')); return; }
    if (d.root) { const pth = el('div', 'mem-path', d.root); pth.title = 'Корень области'; filesEl.appendChild(pth); }
    const all = [...(d.extra || []), ...(d.nodes || [])];
    if (!all.length) {
      const intro = el('div', 'mine-intro');
      intro.appendChild(el('div', 'mine-intro-h', d.exists ? 'Папка пуста' : 'Папки .claude пока нет'));
      intro.appendChild(el('div', 'mine-intro-tx', 'Здесь живут правила, скиллы, команды и настройки, которыми настраивают агента. Файлы появятся, когда вы их заведёте — например, командой /init или вручную.'));
      filesEl.appendChild(intro);
      return;
    }
    if (d.truncated) filesEl.appendChild(el('div', 'mem-warn', 'Показаны не все файлы — их слишком много.'));

    // Дерево: плоский список с отступами по глубине; папки сворачиваются.
    const tree = el('div', 'cfs-tree');
    const hidden = (rel) => { // скрыт, если ЛЮБОЙ из родителей свёрнут
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) if (!cfs.open.has(parts.slice(0, i).join('/'))) return true;
      return false;
    };
    for (const n of all) {
      if (!n.outside && hidden(n.rel)) continue;
      const depth = n.outside ? 0 : n.rel.split('/').length - 1;
      const row = el('div', 'cfs-row' + (n.dir ? ' dir' : '') + (cfs.sel === n.rel ? ' on' : ''));
      row.style.paddingLeft = (6 + depth * 14) + 'px';
      if (n.dir) {
        row.appendChild(el('span', 'cfs-caret', cfs.open.has(n.rel) ? '▾' : '▸'));
        row.appendChild(icon('folder', 14));
      } else {
        row.appendChild(el('span', 'cfs-caret', ''));
        row.appendChild(icon('file', 14));
      }
      row.appendChild(el('span', 'cfs-name', n.name));
      if (n.outside) row.appendChild(el('span', 'cfs-tag', 'в корне проекта'));
      if (!n.dir && !n.editable) row.appendChild(el('span', 'cfs-tag', 'частями'));
      row.appendChild(el('div', 'mem-sp'));
      // Правая часть строки — СЕТКА из трёх колонок одинаковой ширины у папок и файлов
      // (элементы · вес · дата). Пустые ячейки всё равно рисуем: иначе вес папки и вес файла
      // встают в разные позиции и колонка «пляшет».
      const meta = el('div', 'cfs-meta');
      meta.appendChild(el('span', 'cfs-c1', n.dir ? t('{0} эл.', n.items || 0) : ''));
      meta.appendChild(el('span', 'cfs-c2', fmtBytes(n.size || 0)));
      meta.appendChild(el('span', 'cfs-c3', (!n.dir && n.mtime) ? fmtTs(n.mtime) : ''));
      row.appendChild(meta);
      if (n.dir) {
        row.appendChild(el('div', 'mem-acts cfs-acts-empty'));   // держим место кнопок, чтобы сетка не съезжала
      } else {
        const acts = el('div', 'mem-acts');
        const abs = n.outside
          ? (activeProject() ? activeProject().path + '/CLAUDE.md' : n.name)
          : (d.root + '/' + n.rel);
        const act = (ic, title, fn) => {
          const b = el('button', 'mem-act');
          b.appendChild(icon(ic, 14)); b.title = title;
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          acts.appendChild(b);
        };
        act('copy', 'Скопировать путь к файлу', () => { lite.copyText(abs); toast(t('Путь скопирован: {0}', abs), { ttl: 5000 }); });
        act('terminal', 'Спросить агента про этот файл — вставить путь в терминал проекта (без Enter)', () => cfsAsk(n, abs));
        row.appendChild(acts);
      }
      row.addEventListener('click', () => {
        if (n.dir) { if (cfs.open.has(n.rel)) cfs.open.delete(n.rel); else cfs.open.add(n.rel); renderFiles(); return; }
        cfs.sel = n.rel; renderFiles(); cfsOpen(n);
      });
      tree.appendChild(row);
    }
    filesEl.appendChild(tree);
  }

  document.querySelectorAll('#ctx-tabs .ctx-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // Канва пишет файл сразу, поэтому «неподтверждённой канвы» не бывает. А вот открытый редактор
  // (раздел, память, файл .claude) с несохранённым текстом закрытие задерживает: раньше окно
  // закрывалось молча и правки пропадали — оболочка как раз и спрашивает модуль ради этого.
  function confirmClose(proceed) {
    if (!dirtyEditors.size) { proceed(); return; }
    showConfirm('Закрыть окно «Контекст»?',
      'В открытом редакторе есть несохранённые правки — они будут потеряны.',
      'Закрыть без сохранения', proceed);
  }

  return { isOpen: () => open, setOpen, toggle, onProjectChange, confirmClose };
}
