// LiteEditor — модуль «Аудит»: базовый рентген активного проекта (правый слот).
// Следует за активным проектом, как Git/Задачи. Бэкенд (audit:scan) делает один проход
// по дереву и отдаёт агрегаты + находки; модуль только рисует. Вкладки:
//   • Обзор    — паспорт (файлы/строки/вес, языки, категории) + чипы-находки + сводка/экспорт;
//   • Типы     — таблица по расширениям (сортируемая), клик по типу → список файлов;
//   • Крупные  — топ файлов по строкам/весу + флаг «аномалия» (сильно выше нормы для типа);
//   • Медиа    — картинки/видео/архивы/шрифты по весу;
//   • Гигиена  — мусор в гите, минифицированные, дубликаты, осиротевшие (эвристика);
//   • Долг     — TODO/FIXME/HACK и потенциальные секреты (клик → файл на строке);
//   • История  — горячие файлы (git churn), свежие, давно не тронутые.
// Любой файл: клик — открыть в вивере; действия на ховере (копировать путь, в терминал).
// Изолирован по образцу git.js/notes.js: всё из ядра — только через host; UI — из ui.js.
// host: { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject,
//         closeOtherPanels, openInViewer, sendToTerminal }
import { el, icon, iconBtn, toast } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const TABS = [
  { id: 'overview', label: 'Обзор', icon: 'grid' },
  { id: 'types', label: 'Типы', icon: 'layers' },
  { id: 'largest', label: 'Крупные', icon: 'chevron-up' },
  { id: 'media', label: 'Медиа', icon: 'eye' },
  { id: 'hygiene', label: 'Гигиена', icon: 'eraser' },
  { id: 'debt', label: 'Долг', icon: 'flag' },
  { id: 'history', label: 'История', icon: 'git' },
];
const CAT_LABEL = {
  code: 'Код', web: 'Вёрстка', config: 'Конфиги', docs: 'Документы', data: 'Данные',
  image: 'Картинки', media: 'Медиа', archive: 'Архивы', font: 'Шрифты',
  binary: 'Бинарь', other: 'Прочее',
};
const MEDIA_CATS = new Set(['image', 'media', 'archive', 'font']); // вкладка «Медиа»
const FILE_ROWS_MAX = 400;                                        // предел отрисовки списка файлов

// Человекочитаемый вес.
function fmtBytes(n) {
  if (n < 1024) return n + ' Б';
  const u = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
}
// Числа с разделителем разрядов (узкий пробел).
function fmtNum(n) { return (n || 0).toLocaleString('ru-RU').replace(/ /g, ' '); }

export function initAudit(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, openInViewer, sendToTerminal } = host;

  let auditOpen = false;
  let tab = 'overview';
  let source = 'git';                 // 'git' | 'fs' — источник файлов
  let largestMode = 'lines';          // 'lines' | 'bytes' — режим вкладки «Крупные»
  let largestAnomaly = false;         // показывать только аномалии (вкладка «Крупные»)
  let typesSort = 'bytes';            // 'files' | 'lines' | 'bytes' — сортировка таблицы типов
  let typeFilter = null;              // null | категория — фильтр вкладки «Типы» (клик по категории в «Обзоре»)
  let drillExt = null;                // null | расширение — раскрытый список файлов одного типа
  const cache = new Map();            // projId → результат скана
  let scanSeq = 0;                    // защита от гонок async-скана

  function curProj() { return activeProject(); }

  // ---------------- данные ----------------
  async function scan(force) {
    const p = curProj();
    if (!p) return;
    if (!force && cache.has(p.id)) { renderBody(); return; }
    const seq = ++scanSeq;
    cache.set(p.id, { loading: true });
    renderBody();
    let res;
    try { res = await lite.audit.scan(p.path, { source }); }
    catch (e) { res = { error: String(e && e.message || e) }; }
    if (seq !== scanSeq) return;                 // более новый скан уже идёт
    cache.set(p.id, res || { error: 'Пустой ответ' });
    if (auditOpen) renderBody();
  }

  // ---------------- рендер ----------------
  function renderBody() {
    const body = $('#audit-body');
    if (!body) return;
    const p = curProj();
    const title = $('#audit-proj');
    if (title) title.textContent = p ? ('Аудит — ' + p.name) : 'Аудит проекта';

    if (!p) {
      body.innerHTML = '';
      body.appendChild(el('div', 'au-empty', 'Откройте проект слева, чтобы проанализировать его.'));
      return;
    }
    const data = cache.get(p.id);

    body.innerHTML = '';
    body.appendChild(renderControls(data));
    body.appendChild(renderTabs());

    const content = el('div', 'au-content');
    body.appendChild(content);

    if (!data || data.loading) { content.appendChild(el('div', 'au-empty', 'Сканирую проект…')); return; }
    if (data.error) { content.appendChild(el('div', 'au-empty au-err', 'Ошибка: ' + data.error)); return; }
    if (!data.totals || !data.totals.files) { content.appendChild(el('div', 'au-empty', 'Файлов не найдено.')); return; }

    if (tab === 'overview') renderOverview(content, data);
    else if (tab === 'types') renderTypes(content, data);
    else if (tab === 'largest') renderLargest(content, data);
    else if (tab === 'media') renderMedia(content, data);
    else if (tab === 'hygiene') renderHygiene(content, data);
    else if (tab === 'debt') renderDebt(content, data);
    else if (tab === 'history') renderHistory(content, data);
  }
  function goTab(id) { tab = id; drillExt = null; typeFilter = null; renderBody(); }

  // Шапка: источник (git/fs) + кнопка «Сканировать» + сводка последнего скана.
  function renderControls(data) {
    const bar = el('div', 'au-controls');
    const seg = el('div', 'au-seg');
    for (const s of [['git', 'git-tracked'], ['fs', 'весь каталог']]) {
      const b = el('button', 'au-segbtn' + (source === s[0] ? ' active' : ''), s[1]);
      b.title = s[0] === 'git' ? 'Только файлы под контролем git (честный фильтр — без node_modules/сборки)'
        : 'Весь рабочий каталог (служебные папки вроде node_modules/.git всё равно пропускаются)';
      b.onclick = () => { if (source === s[0]) return; source = s[0]; scan(true); };
      seg.appendChild(b);
    }
    bar.appendChild(seg);

    const scanBtn = el('button', 'au-scan');
    scanBtn.append(icon('refresh', 14), el('span', null, 'Сканировать'));
    scanBtn.onclick = () => scan(true);
    bar.appendChild(scanBtn);

    const note = el('div', 'au-note');
    if (data && data.gitless && source === 'git') note.textContent = 'git-репозиторий не найден — показан весь каталог';
    else if (data && data.capped) note.textContent = 'показаны не все файлы (слишком большое дерево)';
    bar.appendChild(note);
    return bar;
  }

  function renderTabs() {
    const row = el('div', 'au-tabs');
    for (const t of TABS) {
      const b = el('button', 'au-tab' + (tab === t.id ? ' active' : ''));
      b.append(icon(t.icon, 14), el('span', null, t.label));
      b.onclick = () => { if (tab === t.id) return; tab = t.id; drillExt = null; typeFilter = null; renderBody(); };
      row.appendChild(b);
    }
    return row;
  }

  // ---- Обзор ----
  function renderOverview(root, d) {
    const t = d.totals;
    const cards = el('div', 'au-cards');
    cards.appendChild(statCard('file', 'Файлов', fmtNum(t.files)));
    cards.appendChild(statCard('note', 'Строк кода', fmtNum(t.lines)));
    cards.appendChild(statCard('archive', 'Вес', fmtBytes(t.bytes)));
    root.appendChild(cards);

    // Действия: сводка в буфер (#17) + экспорт отчёта (#20).
    const acts = el('div', 'au-actions');
    const sumBtn = el('button', 'au-actbtn'); sumBtn.append(icon('copy', 14), el('span', null, 'Скопировать сводку'));
    sumBtn.title = 'Markdown-паспорт проекта в буфер (для агента / заметки)';
    sumBtn.onclick = () => { lite.copyText(buildSummaryMd(d)); toast('Сводка скопирована'); };
    const expBtn = el('button', 'au-actbtn'); expBtn.append(icon('download', 14), el('span', null, 'Экспорт отчёта'));
    expBtn.title = 'Сохранить полный отчёт в файл (.md / .json)';
    expBtn.onclick = () => exportReport(d);
    acts.append(sumBtn, expBtn);
    root.appendChild(acts);

    // Чипы-находки: счётчик + переход на вкладку (секреты — тревожным цветом).
    const CHIP = [
      ['Мусор', (d.junk || []).length, 'hygiene', false],
      ['Минифиц.', (d.minified || []).length, 'hygiene', false],
      ['Дубли', (d.dupes || []).length, 'hygiene', false],
      ['Осиротевшие', (d.orphans || []).length, 'hygiene', false],
      ['TODO', (d.todos || []).length, 'debt', false],
      ['Секреты', (d.secrets || []).length, 'debt', true],
    ];
    const chipRow = el('div', 'au-chips');
    let any = false;
    for (const [lbl, n, dest, warn] of CHIP) {
      if (!n) continue; any = true;
      const c = el('button', 'au-chip2' + (warn ? ' warn' : ''));
      c.append(el('span', 'au-chip-n', String(n)), el('span', null, lbl));
      c.onclick = () => goTab(dest);
      chipRow.appendChild(c);
    }
    if (!any) chipRow.appendChild(el('div', 'au-allgood', '✓ Находок по гигиене и долгу нет'));
    root.appendChild(chipRow);

    // Языки — бары по строкам.
    if (d.langs && d.langs.length) {
      root.appendChild(el('div', 'au-h', 'Языки (по строкам)'));
      const max = d.langs[0].lines || 1;
      const wrap = el('div', 'au-bars');
      for (const l of d.langs) {
        if (!l.lines) continue;
        const r = el('div', 'au-bar');
        r.appendChild(el('span', 'au-bar-lbl', '.' + l.ext));
        const track = el('div', 'au-bar-track');
        const fill = el('div', 'au-bar-fill'); fill.style.width = Math.max(3, Math.round(l.lines / max * 100)) + '%';
        track.appendChild(fill);
        r.appendChild(track);
        r.appendChild(el('span', 'au-bar-val', fmtNum(l.lines)));
        wrap.appendChild(r);
      }
      root.appendChild(wrap);
    }

    // Категории — компактная сводка; клик ведёт во вкладку «Типы», отфильтрованную по категории.
    if (d.byCat && d.byCat.length) {
      root.appendChild(el('div', 'au-h', 'Категории — клик откроет типы'));
      const grid = el('div', 'au-catgrid');
      for (const c of d.byCat) {
        const cell = el('button', 'au-cat');
        cell.appendChild(el('span', 'au-cat-name', CAT_LABEL[c.cat] || c.cat));
        cell.appendChild(el('span', 'au-cat-meta', fmtNum(c.files) + ' ф · ' + fmtBytes(c.bytes)));
        cell.title = 'Показать типы категории «' + (CAT_LABEL[c.cat] || c.cat) + '»';
        cell.onclick = () => { typeFilter = c.cat; drillExt = null; tab = 'types'; renderBody(); };
        grid.appendChild(cell);
      }
      root.appendChild(grid);
    }
    if (t.skippedBig) root.appendChild(el('div', 'au-foot', t.skippedBig + ' крупных файлов не посчитаны построчно (> 4 МБ)'));
  }
  function statCard(ic, label, value) {
    const c = el('div', 'au-statcard');
    c.appendChild(icon(ic, 18));
    c.appendChild(el('div', 'au-stat-val', value));
    c.appendChild(el('div', 'au-stat-lbl', label));
    return c;
  }

  // ---- Типы ----
  function renderTypes(root, d) {
    if (drillExt) { renderTypeDrill(root, d); return; }
    const total = d.totals.bytes || 1;
    let rows = d.byExt.slice();
    if (typeFilter) rows = rows.filter((e) => e.cat === typeFilter);
    rows.sort((a, b) => (b[typesSort] || 0) - (a[typesSort] || 0));

    if (typeFilter) {
      const banner = el('div', 'au-filter');
      banner.appendChild(el('span', 'au-filter-lbl', 'Категория: ' + (CAT_LABEL[typeFilter] || typeFilter)));
      const reset = el('button', 'au-filter-x'); reset.append(icon('x', 13), el('span', null, 'все типы'));
      reset.onclick = () => { typeFilter = null; renderBody(); };
      banner.appendChild(reset);
      root.appendChild(banner);
    }
    root.appendChild(el('div', 'au-h', 'Клик по типу — список файлов'));

    const table = el('div', 'au-table');
    const head = el('div', 'au-tr au-thead');
    head.appendChild(el('div', 'au-td au-c-ext', 'Тип'));
    head.appendChild(sortTh('Файлов', 'files'));
    head.appendChild(sortTh('Строк', 'lines'));
    head.appendChild(sortTh('Вес', 'bytes'));
    head.appendChild(el('div', 'au-td au-c-share', 'Доля'));
    table.appendChild(head);

    for (const e of rows) {
      const tr = el('button', 'au-tr au-tr-btn');
      tr.title = 'Показать файлы типа .' + e.ext;
      tr.onclick = () => { drillExt = e.ext; renderBody(); };
      const extc = el('div', 'au-td au-c-ext');
      extc.appendChild(el('span', 'au-ext', '.' + e.ext));
      extc.appendChild(el('span', 'au-cat-tag', CAT_LABEL[e.cat] || e.cat));
      tr.appendChild(extc);
      tr.appendChild(el('div', 'au-td au-num', fmtNum(e.files)));
      tr.appendChild(el('div', 'au-td au-num', e.lines ? fmtNum(e.lines) : '—'));
      tr.appendChild(el('div', 'au-td au-num', fmtBytes(e.bytes)));
      const share = el('div', 'au-td au-c-share');
      const track = el('div', 'au-share-track');
      const fill = el('div', 'au-share-fill'); fill.style.width = Math.max(2, Math.round(e.bytes / total * 100)) + '%';
      track.appendChild(fill);
      share.appendChild(track);
      tr.appendChild(share);
      table.appendChild(tr);
    }
    if (!rows.length) table.appendChild(el('div', 'au-empty', 'Нет типов в этой категории.'));
    root.appendChild(table);
  }
  function sortTh(label, key) {
    const th = el('div', 'au-td au-num au-sortable' + (typesSort === key ? ' active' : ''), label + (typesSort === key ? ' ↓' : ''));
    th.onclick = () => { typesSort = key; renderBody(); };
    return th;
  }
  // Раскрытый список файлов одного типа (.ext).
  function renderTypeDrill(root, d) {
    const back = el('button', 'au-back');
    back.append(icon('chevron-left', 15), el('span', null, 'К типам'));
    back.onclick = () => { drillExt = null; renderBody(); };
    root.appendChild(back);
    root.appendChild(el('div', 'au-h', 'Файлы .' + drillExt + ' (по весу)'));
    const list = d.files.filter((f) => f.ext === drillExt).sort((a, b) => b.bytes - a.bytes);
    if (!list.length) { root.appendChild(el('div', 'au-empty', 'Файлы этого типа не попали в выборку.')); return; }
    root.appendChild(fileList(list, { value: (f) => fmtBytes(f.bytes), capped: d.filesCapped }));
  }

  // ---- Крупные ----
  // Аномалия (#4): файл сильно тяжелее «нормы» своего типа (≥3× медианы и заметного размера).
  function anomalySet(d, metric) {
    const med = new Map(); // ext → медиана метрики
    const byExt = new Map();
    for (const f of d.files) { const v = metric(f); if (v == null) continue; (byExt.get(f.ext) || byExt.set(f.ext, []).get(f.ext)).push(v); }
    for (const [ext, arr] of byExt) { arr.sort((a, b) => a - b); med.set(ext, arr[Math.floor(arr.length / 2)] || 0); }
    const set = new Set();
    for (const f of d.files) { const v = metric(f); if (v == null) continue; const m = med.get(f.ext) || 0; if (m > 0 && v >= m * 3 && v >= (metric === bytesOf ? 50 * 1024 : 400)) set.add(f.rel); }
    return set;
  }
  const bytesOf = (f) => f.bytes;
  const linesOf = (f) => (f.hasLines ? f.lines : null);

  function renderLargest(root, d) {
    const bar = el('div', 'au-barrow');
    const seg = el('div', 'au-seg au-seg-inline');
    for (const s of [['lines', 'по строкам'], ['bytes', 'по весу']]) {
      const b = el('button', 'au-segbtn' + (largestMode === s[0] ? ' active' : ''), s[1]);
      b.onclick = () => { if (largestMode === s[0]) return; largestMode = s[0]; renderBody(); };
      seg.appendChild(b);
    }
    bar.appendChild(seg);
    const anomBtn = el('button', 'au-chip' + (largestAnomaly ? ' active' : ''), 'только аномалии');
    anomBtn.title = 'Файлы, сильно превышающие норму для своего типа (≥3× медианы)';
    anomBtn.onclick = () => { largestAnomaly = !largestAnomaly; renderBody(); };
    bar.appendChild(anomBtn);
    root.appendChild(bar);

    const metric = largestMode === 'lines' ? linesOf : bytesOf;
    const anom = anomalySet(d, metric);
    let list = largestMode === 'lines'
      ? d.files.filter((f) => f.hasLines).sort((a, b) => b.lines - a.lines)
      : d.files.slice().sort((a, b) => b.bytes - a.bytes);
    if (largestAnomaly) list = list.filter((f) => anom.has(f.rel));
    if (!list.length) { root.appendChild(el('div', 'au-empty', largestAnomaly ? 'Аномалий не найдено.' : 'Нет данных.')); return; }
    root.appendChild(fileList(list, {
      value: (f) => largestMode === 'lines' ? fmtNum(f.lines) + ' стр' : fmtBytes(f.bytes),
      badge: (f) => anom.has(f.rel) ? 'аномалия' : null,
      capped: d.filesCapped,
    }));
  }

  // ---- Медиа ----
  function renderMedia(root, d) {
    const list = d.files.filter((f) => MEDIA_CATS.has(f.cat)).sort((a, b) => b.bytes - a.bytes);
    if (!list.length) { root.appendChild(el('div', 'au-empty', 'Картинок, видео, архивов и шрифтов не найдено.')); return; }
    root.appendChild(fileList(list, { value: (f) => fmtBytes(f.bytes), capped: d.filesCapped }));
  }

  // ---- Гигиена ----
  function renderHygiene(root, d) {
    let any = false;
    if ((d.junk || []).length) { any = true;
      section(root, 'Мусор в гите', d.junk.length, 'обычно не должно лежать под версионным контролем');
      root.appendChild(fileList(d.junk, { sub: (f) => f.reason, value: (f) => fmtBytes(f.bytes) }));
    }
    if ((d.minified || []).length) { any = true;
      section(root, 'Минифицированные / длинные строки', d.minified.length, 'вероятно сгенерировано — не ревьюить вручную');
      root.appendChild(fileList(d.minified, { value: (f) => fmtNum(f.maxLine) + ' симв/стр' }));
    }
    if ((d.dupes || []).length) { any = true;
      section(root, 'Дубликаты (одинаковое содержимое)', d.dupes.length, 'идентичные файлы — кандидаты на объединение');
      for (const g of d.dupes) {
        const box = el('div', 'au-dupe');
        box.appendChild(el('div', 'au-dupe-head', g.files.length + ' копии · ' + fmtBytes(g.bytes) + ' каждая'));
        box.appendChild(fileList(g.files.map((rel) => ({ rel, bytes: g.bytes })), { value: (f) => fmtBytes(f.bytes) }));
        root.appendChild(box);
      }
    } else if (d.dupesSkipped) { root.appendChild(el('div', 'au-foot', 'Дубликаты не считались — слишком много кандидатов.')); }
    if ((d.orphans || []).length) { any = true;
      section(root, 'Возможно осиротевшие', d.orphans.length, '⚠ эвристика: имя файла не встречается в других файлах — проверяйте перед удалением');
      root.appendChild(fileList(d.orphans, { value: (f) => fmtBytes(f.bytes) }));
    } else if (d.orphansSkipped) { root.appendChild(el('div', 'au-foot', 'Осиротевшие не искались — проект слишком большой для эвристики.')); }
    if (!any) root.appendChild(el('div', 'au-empty', '✓ Чисто: мусора, дубликатов и подозрительных файлов не найдено.'));
  }

  // ---- Долг ----
  function renderDebt(root, d) {
    let any = false;
    if ((d.secrets || []).length) { any = true;
      section(root, '⚠ Потенциальные секреты', d.secrets.length, 'возможные ключи/токены/пароли — проверьте и уберите из репозитория');
      root.appendChild(fileList(d.secrets, { sub: (f) => f.rule + ': ' + f.text, lineOf: (f) => f.line, value: (f) => 'стр ' + f.line, danger: true }));
    }
    if ((d.todos || []).length) { any = true;
      section(root, 'TODO / FIXME / HACK', d.todos.length, 'метки техдолга в коде');
      root.appendChild(fileList(d.todos, { badge: (f) => f.kind, sub: (f) => f.text, lineOf: (f) => f.line, value: (f) => 'стр ' + f.line }));
    }
    if (!any) root.appendChild(el('div', 'au-empty', '✓ Меток техдолга и подозрительных секретов не найдено.'));
  }

  // ---- История ----
  function renderHistory(root, d) {
    const h = d.history || { mode: 'mtime', churn: [], recent: [], stale: [] };
    if (h.mode === 'mtime') root.appendChild(el('div', 'au-foot', 'git недоступен — по времени изменения файла (mtime).'));
    if (h.mode === 'git' && h.churn.length) {
      section(root, 'Горячие файлы (правок больше всего)', h.churn.length, 'за последние ' + (h.windowCommits || '') + ' коммитов — тут кластеризуются баги');
      root.appendChild(fileList(h.churn, { value: (f) => f.commits + '×' }));
    }
    if (h.recent && h.recent.length) {
      section(root, 'Свежие изменения', h.recent.length, h.mode === 'git' ? 'по дате последнего коммита' : 'по mtime');
      root.appendChild(fileList(h.recent, { value: (f) => fmtDate(f.when) }));
    }
    if (h.stale && h.stale.length) {
      section(root, 'Давно не тронуты', h.stale.length, 'кандидаты в забытый/мёртвый код');
      root.appendChild(fileList(h.stale, { value: (f) => fmtDate(f.when) }));
    }
  }

  function section(root, title, count, hint) {
    const head = el('div', 'au-sec');
    head.appendChild(el('span', 'au-sec-title', title));
    head.appendChild(el('span', 'au-sec-count', String(count)));
    root.appendChild(head);
    if (hint) root.appendChild(el('div', 'au-sec-hint', hint));
  }

  // Общий список файлов: путь (каталог+имя), опц. подстрока, бейдж, значение справа, действия на ховере.
  // opts: { value(f), sub(f), badge(f), lineOf(f), capped, danger }
  function fileList(items, opts = {}) {
    const list = el('div', 'au-files');
    for (const f of items.slice(0, FILE_ROWS_MAX)) {
      const ln = opts.lineOf ? opts.lineOf(f) : null;
      const row = el('div', 'au-frow' + (opts.sub ? ' au-frow-2' : '') + (opts.danger ? ' au-danger' : ''));
      row.title = f.rel + (ln ? ':' + ln : '') + ' — открыть в вивере';
      const wrap = el('div', 'au-fwrap');
      const l1 = el('div', 'au-fmain');
      const slash = f.rel.lastIndexOf('/');
      const dir = slash >= 0 ? f.rel.slice(0, slash + 1) : '';
      const name = slash >= 0 ? f.rel.slice(slash + 1) : f.rel;
      if (dir) l1.appendChild(el('span', 'au-fdir', dir));
      l1.appendChild(el('span', 'au-fname', name));
      const badge = opts.badge ? opts.badge(f) : null;
      if (badge) l1.appendChild(el('span', 'au-badge', badge));
      wrap.appendChild(l1);
      if (opts.sub) { const s = opts.sub(f); if (s) wrap.appendChild(el('div', 'au-fsub', s)); }
      row.appendChild(wrap);
      if (opts.value) row.appendChild(el('span', 'au-fval', opts.value(f)));
      row.appendChild(rowActions(f, ln));
      row.onclick = () => openFile(f.rel, ln);
      list.appendChild(row);
    }
    if (items.length > FILE_ROWS_MAX) list.appendChild(el('div', 'au-foot', 'Показаны первые ' + FILE_ROWS_MAX + ' из ' + fmtNum(items.length) + ' файлов.'));
    else if (opts.capped) list.appendChild(el('div', 'au-foot', 'Список файлов усечён — очень большой проект.'));
    return list;
  }
  // Действия по файлу (#18): копировать путь, отправить в терминал. Клик по строке = открыть в вивере.
  function rowActions(f, ln) {
    const box = el('div', 'au-facts');
    const copy = iconBtn('au-fact', 'copy', 'Скопировать путь', 13);
    copy.onclick = (e) => { e.stopPropagation(); lite.copyText(f.rel); toast('Путь скопирован'); };
    box.appendChild(copy);
    if (sendToTerminal) {
      const term = iconBtn('au-fact', 'terminal', 'В терминал: разобрать файл', 13);
      term.onclick = (e) => { e.stopPropagation(); sendToTerminal('Открой и проанализируй файл ' + f.rel + (ln ? ' (строка ' + ln + ')' : '') + ': '); toast('Вставлено в терминал'); };
      box.appendChild(term);
    }
    return box;
  }
  function openFile(rel, line) {
    const p = curProj();
    if (!p) return;
    if (!openInViewer) { toast('Вивер недоступен'); return; }
    // Путь от бэкенда — относительный с '/'; собираем абсолютный через корень проекта.
    const sep = p.path.includes('\\') ? '\\' : '/';
    const abs = p.path.replace(/[\/]+$/, '') + sep + rel.split('/').join(sep);
    openInViewer(abs, line || undefined);
  }

  // Короткая дата YYYY-MM-DD из ISO.
  function fmtDate(iso) { return (iso || '').slice(0, 10); }

  // Markdown-паспорт проекта (кнопка «Скопировать сводку»).
  function buildSummaryMd(d) {
    const t = d.totals;
    const L = [];
    L.push('# Аудит проекта');
    L.push('');
    L.push('- Файлов: ' + fmtNum(t.files) + ' · Строк: ' + fmtNum(t.lines) + ' · Вес: ' + fmtBytes(t.bytes) + ' · Источник: ' + (d.source === 'git' ? 'git-tracked' : 'весь каталог'));
    if (d.langs && d.langs.length) L.push('- Языки: ' + d.langs.map((l) => '.' + l.ext + ' ' + fmtNum(l.lines)).join(', '));
    L.push('');
    L.push('## Находки');
    L.push('- Мусор в гите: ' + (d.junk || []).length);
    L.push('- TODO/FIXME: ' + (d.todos || []).length + ' · Секреты(?): ' + (d.secrets || []).length);
    L.push('- Минифицированные: ' + (d.minified || []).length + ' · Дубликаты: ' + (d.dupes || []).length + ' · Осиротевшие(эвр.): ' + (d.orphans || []).length);
    const big = d.files.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    if (big.length) { L.push(''); L.push('## Крупнейшие по весу'); for (const f of big) L.push('- ' + f.rel + ' — ' + fmtBytes(f.bytes)); }
    if (d.history && d.history.mode === 'git' && d.history.churn.length) {
      L.push(''); L.push('## Горячие файлы (git)'); for (const f of d.history.churn.slice(0, 5)) L.push('- ' + f.rel + ' — ' + f.commits + ' правок');
    }
    return L.join('\n') + '\n';
  }
  // Полный отчёт (экспорт): сводка + развёрнутые списки.
  function buildReportMd(d) {
    const L = [buildSummaryMd(d).trimEnd(), ''];
    const dump = (title, items, fmt) => { if (!items || !items.length) return; L.push('## ' + title + ' (' + items.length + ')'); for (const x of items.slice(0, 300)) L.push('- ' + fmt(x)); L.push(''); };
    dump('Мусор в гите', d.junk, (f) => f.rel + ' — ' + f.reason);
    dump('TODO / FIXME', d.todos, (f) => f.rel + ':' + f.line + ' [' + f.kind + '] ' + f.text);
    dump('Потенциальные секреты', d.secrets, (f) => f.rel + ':' + f.line + ' [' + f.rule + ']');
    dump('Минифицированные', d.minified, (f) => f.rel + ' — ' + f.maxLine + ' симв/стр');
    dump('Дубликаты', (d.dupes || []).map((g) => ({ s: g.files.join(' = ') + ' (' + fmtBytes(g.bytes) + ')' })), (x) => x.s);
    dump('Осиротевшие (эвристика)', d.orphans, (f) => f.rel);
    if (d.history && d.history.mode === 'git') dump('Горячие файлы', d.history.churn, (f) => f.rel + ' — ' + f.commits + ' правок');
    return L.join('\n') + '\n';
  }
  async function exportReport(d) {
    const proj = curProj();
    const safe = proj ? proj.name.replace(/[^\p{L}\p{N}.-]+/gu, '_').replace(/^_+|_+$/g, '') : '';
    const base = (safe || 'project') + '-audit.md';
    const r = await lite.audit.export(buildReportMd(d), base);
    if (!r || r.canceled) return;
    if (r.error) { toast('Ошибка экспорта: ' + r.error, { kind: 'err' }); return; }
    toast('Отчёт сохранён');
  }

  // ---------------- панель правого слота ----------------
  function setAuditOpen(open, opts = {}) {
    if (open && !curProj() && !opts.allowEmpty) { toast('Сначала открой проект'); return; }
    if (open === auditOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('audit');
    const delta = layout.audit + GUTTER;
    auditOpen = open;
    $('#audit-pane').classList.toggle('hidden', !open);
    $('#gutter-audit').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    setTimeout(refitActiveTerminal, 150);
  }
  function toggleAudit() { setAuditOpen(!auditOpen); }

  // Открытие/смена проекта: рисуем; авто-скан если для проекта ещё нет результата.
  function renderPanel() {
    if (!auditOpen) return;
    renderBody();
    const p = curProj();
    if (p && !cache.has(p.id)) scan(false);
  }

  return {
    isOpen: () => auditOpen,
    setOpen: setAuditOpen,
    toggle: toggleAudit,
    renderPanel,
    rescan: () => scan(true),
  };
}
