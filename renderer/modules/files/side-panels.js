// Боковые инструментальные панели окна «Проект» (живут в левой колонке рядом с «Файлы» и «Коммит»,
// не закрываются при клике по результату, переключаются через #vcs-strip или Alt+1..6):
//   • Поиск и замена по проекту (#side-search-pane) — стриминг через gsearch, маски файлов, |W|, Aa, .*, F4/Shift+F4;
//   • Структура файла (#side-outline-pane) — живое дерево символов с подсветкой позиции курсора и сортировкой;
//   • Задачи в коде TODO/FIXME (#side-todos-pane) — группировка по файлам и фильтр по тегу;
//   • Закладки (#side-bookmarks-pane) — список закладок проекта с подписями и быстрым переходом.
import { el, icon, toast, showConfirm, showPrompt, baseName, extOf, fileTypeSvg } from '../../ui.js';
import { t as tr } from '../../i18n.js';
import { kindGlyph, extractFileSymbols, enclosingSymbolAtLine } from './symbol-index.js';

function joinPath(base, rel) {
  const sep = String(base || '').includes('\\') ? '\\' : '/';
  return String(base || '').replace(/[/\\]+$/, '') + sep + String(rel || '').replace(/^[/\\]+/, '').replace(/\//g, sep);
}

function relTo(base, file) {
  const b = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const f = String(file || '').replace(/\\/g, '/');
  return f.startsWith(b + '/') ? f.slice(b.length + 1) : f;
}

function shortRu(n, one, few, many) {
  const v = Math.abs(n) % 100, d = v % 10;
  if (v > 10 && v < 20) return n + ' ' + many;
  if (d === 1) return n + ' ' + one;
  if (d >= 2 && d <= 4) return n + ' ' + few;
  return n + ' ' + many;
}

export function createSidePanels(host) {
  const lite = host.lite || window.lite;
  const {
    activeProject, openFile, getCurrentFile, getEditorText, getCurrentSymbols,
    getBookmarks, saveBookmarks, onReplaced, toggleBookmarkHere,
  } = host;

  let activePanelName = null;
  let lastCursorLine = 1;

  function resolveCurrentSymbols() {
    if (getCurrentSymbols) return getCurrentSymbols() || [];
    const f = getCurrentFile ? getCurrentFile() : null;
    const txt = getEditorText ? getEditorText() : '';
    if (!f || !txt) return [];
    return extractFileSymbols(txt, extOf(f));
  }

  // =========================================================================
  // 1. ПОИСК И ЗАМЕНА ПО ПРОЕКТУ (#side-search-pane)
  // =========================================================================
  let searchMounted = false;
  let replaceExpanded = false;
  let masksExpanded = false;
  let sFlags = { caseSensitive: false, wholeWord: false, regex: false };
  let sRunId = null;
  let sRunSeq = 0;
  let sTimer = null;
  let flatHits = [];          // [{ abs, rel, line, text, mcol, len, rowEl, key }]
  let activeHitIdx = -1;
  const dismissedKeys = new Set();
  let sDom = null;

  function parseMaskInput(raw) {
    // Поддержка единого поля вида "*.js, !test/**, src/**"
    const inc = [], exc = [];
    for (const part of String(raw || '').split(',')) {
      const s = part.trim();
      if (!s) continue;
      if (s.startsWith('!')) { if (s.slice(1).trim()) exc.push(s.slice(1).trim()); }
      else inc.push(s);
    }
    return { include: inc.join(', '), exclude: exc.join(', ') };
  }

  function mountSearchPane(pane) {
    if (searchMounted || !pane) return;
    searchMounted = true;
    pane.replaceChildren();

    const head = el('div', 'pane-head side-head');
    head.appendChild(el('span', 'pane-title', tr('Поиск в проекте')));
    head.appendChild(el('div', 'drag-space-static'));
    const maskToggle = el('button', 'icon-btn'); maskToggle.type = 'button'; maskToggle.title = tr('Фильтр файлов (*.js, !dist/**)');
    maskToggle.appendChild(icon('filter', 14));
    const collapseBtn = el('button', 'icon-btn'); collapseBtn.type = 'button'; collapseBtn.title = tr('Свернуть/развернуть все файлы');
    collapseBtn.appendChild(icon('obs-collapse', 14));
    const refreshBtn = el('button', 'icon-btn'); refreshBtn.type = 'button'; refreshBtn.title = tr('Повторить поиск');
    refreshBtn.appendChild(icon('refresh', 14));
    head.append(maskToggle, collapseBtn, refreshBtn);

    const controls = el('div', 'sp-search-controls');
    const row1 = el('div', 'sp-input-row');
    const replChev = el('button', 'sp-chev-btn'); replChev.type = 'button'; replChev.title = tr('Показать/скрыть замену (Ctrl+Shift+R)');
    replChev.appendChild(icon('chevron-right', 13));

    const qBox = el('div', 'sp-qbox');
    const qInput = el('input', 'sp-input'); qInput.type = 'text'; qInput.placeholder = tr('Найти в проекте…'); qInput.spellcheck = false;
    const flagsBox = el('div', 'sp-flags');
    const mkFlag = (key, label, title) => {
      const b = el('button', 'sp-flag', label); b.type = 'button'; b.title = title;
      b.onclick = () => { sFlags[key] = !sFlags[key]; b.classList.toggle('on', sFlags[key]); triggerSearch(true); };
      return b;
    };
    const btnCase = mkFlag('caseSensitive', 'Aa', tr('Учитывать регистр'));
    const btnWord = mkFlag('wholeWord', 'ab', tr('Слово целиком'));
    const btnRx = mkFlag('regex', '.*', tr('Регулярное выражение'));
    flagsBox.append(btnCase, btnWord, btnRx);
    qBox.append(qInput, flagsBox);
    row1.append(replChev, qBox);

    const row2 = el('div', 'sp-input-row sp-replace-row hidden');
    row2.appendChild(el('span', 'sp-chev-spacer'));
    const rInput = el('input', 'sp-input sp-rinput'); rInput.type = 'text'; rInput.placeholder = tr('Заменить на…'); rInput.spellcheck = false;
    const rAllBtn = el('button', 'sp-act-btn primary', tr('Заменить все')); rAllBtn.type = 'button'; rAllBtn.disabled = true;
    row2.append(rInput, rAllBtn);

    const rowMasks = el('div', 'sp-masks-row hidden');
    const mInput = el('input', 'sp-input sp-mask-input'); mInput.type = 'text';
    mInput.placeholder = tr('Файлы: напр. *.js, src/**, !test/**'); mInput.spellcheck = false;
    rowMasks.appendChild(mInput);

    controls.append(row1, row2, rowMasks);

    const status = el('div', 'sp-status');
    const results = el('div', 'sp-results');
    pane.append(head, controls, status, results);

    sDom = { pane, qInput, rInput, mInput, row2, rowMasks, replChev, maskToggle, status, results, rAllBtn, btnCase, btnWord, btnRx };

    replChev.onclick = () => setReplaceVisible(!replaceExpanded);
    maskToggle.onclick = () => {
      masksExpanded = !masksExpanded;
      rowMasks.classList.toggle('hidden', !masksExpanded);
      maskToggle.classList.toggle('on', masksExpanded || !!mInput.value.trim());
      if (masksExpanded) mInput.focus();
      else if (mInput.value.trim()) triggerSearch(true);
    };
    let allCollapsed = false;
    collapseBtn.onclick = () => {
      allCollapsed = !allCollapsed;
      results.querySelectorAll('.sp-file-group').forEach((g) => g.classList.toggle('collapsed', allCollapsed));
    };
    refreshBtn.onclick = () => triggerSearch(true);

    qInput.addEventListener('input', () => triggerSearch(false));
    qInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); triggerSearch(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepSearchHit(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepSearchHit(-1); }
    });
    mInput.addEventListener('input', () => {
      maskToggle.classList.toggle('on', masksExpanded || !!mInput.value.trim());
      triggerSearch(false);
    });
    mInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerSearch(true); } });
    rInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runReplaceAll(); } });
    rAllBtn.onclick = () => runReplaceAll();

    // Подписки стримингового поиска gsearch
    if (lite.gsearch) {
      lite.gsearch.onHit((p) => { if (p.runId && p.runId === sRunId) appendStreamHits(p.hits || []); });
      lite.gsearch.onDone((p) => { if (p.runId && p.runId === sRunId) finishStreamSearch(p); });
    }
  }

  function setReplaceVisible(on) {
    if (!sDom) return;
    replaceExpanded = !!on;
    sDom.row2.classList.toggle('hidden', !replaceExpanded);
    sDom.replChev.replaceChildren(icon(replaceExpanded ? 'chevron-down' : 'chevron-right', 13));
    updateReplaceBtn();
  }

  function updateReplaceBtn() {
    if (!sDom) return;
    const activeCount = flatHits.filter((h) => !dismissedKeys.has(h.key)).length;
    sDom.rAllBtn.disabled = activeCount === 0;
    sDom.rAllBtn.textContent = activeCount ? `${tr('Заменить')} (${activeCount})` : tr('Заменить');
  }

  let fileGroups = new Map(); // rel -> { box, body, badge, hits: [] }

  function clearSearchResults() {
    flatHits = [];
    activeHitIdx = -1;
    dismissedKeys.clear();
    fileGroups = new Map();
    if (sDom) {
      sDom.results.replaceChildren();
      updateReplaceBtn();
    }
  }

  function ensureFileGroup(proj, rel) {
    let fg = fileGroups.get(rel);
    if (fg) return fg;
    const box = el('div', 'sp-file-group');
    const head = el('div', 'sp-file-head');
    const chev = el('span', 'sp-file-chev', '▾');
    const ic = fileTypeSvg(rel);
    const name = el('span', 'sp-file-name', baseName(rel));
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const dirEl = dir ? el('span', 'sp-file-dir', dir) : null;
    const badge = el('span', 'sp-badge', '0');
    const dismissFile = el('button', 'sp-dismiss'); dismissFile.type = 'button'; dismissFile.title = tr('Скрыть этот файл из выдачи');
    dismissFile.textContent = '×';

    head.append(chev, ic, name);
    if (dirEl) head.appendChild(dirEl);
    head.append(badge, dismissFile);

    const body = el('div', 'sp-file-body');
    head.addEventListener('click', (e) => {
      if (e.target === dismissFile) return;
      box.classList.toggle('collapsed');
    });
    dismissFile.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const h of fg.hits) dismissedKeys.add(h.key);
      box.remove();
      fileGroups.delete(rel);
      refreshSearchSummary();
    });

    box.append(head, body);
    sDom.results.appendChild(box);
    fg = { box, body, badge, hits: [] };
    fileGroups.set(rel, fg);
    return fg;
  }

  function appendStreamHits(hits) {
    const p = activeProject();
    if (!p || !sDom) return;
    for (const h of hits) {
      if (flatHits.length >= 1500) break;
      const rel = String(h.file || '').replace(/\\/g, '/');
      const abs = joinPath(p.path, rel);
      const line = h.line || 1;
      const key = `${rel}:${line}:${h.mcol || 0}`;
      const fg = ensureFileGroup(p, rel);

      const row = el('div', 'sp-hit-row');
      row.appendChild(el('span', 'sp-hit-ln', String(line)));
      const txt = el('span', 'sp-hit-txt');
      const raw = String(h.text || '');
      const leadTrim = raw.length - raw.trimStart().length;
      let trimmed = raw.trimStart();
      let mStart = Math.max(0, (h.mcol | 0) - leadTrim);
      // Совпадение далеко от начала строки — сдвигаем окно, чтобы найденное было видно в узкой панели
      if (mStart > 18) {
        const cut = mStart - 12;
        trimmed = '…' + trimmed.slice(cut);
        mStart = mStart - cut + 1;
      }
      trimmed = trimmed.slice(0, 220);
      const mEnd = Math.min(trimmed.length, mStart + Math.max(0, h.len | 0));
      row.title = raw.trim().slice(0, 400);
      if (mEnd > mStart && (h.len | 0) > 0) {
        txt.appendChild(document.createTextNode(trimmed.slice(0, mStart)));
        txt.appendChild(el('mark', 'sp-mark', trimmed.slice(mStart, mEnd)));
        txt.appendChild(document.createTextNode(trimmed.slice(mEnd)));
      } else {
        txt.textContent = trimmed;
      }
      const xBtn = el('button', 'sp-dismiss'); xBtn.type = 'button'; xBtn.title = tr('Исключить совпадение');
      xBtn.textContent = '×';
      row.append(txt, xBtn);

      const item = { abs, rel, line, text: raw, mcol: h.mcol || 0, len: h.len || 0, rowEl: row, key };
      const idx = flatHits.length;
      flatHits.push(item);
      fg.hits.push(item);
      fg.badge.textContent = String(fg.hits.length);

      row.addEventListener('click', (e) => {
        if (e.target === xBtn) return;
        selectSearchHit(idx, true);
      });
      row.addEventListener('dblclick', (e) => {
        if (e.target === xBtn) return;
        selectSearchHit(idx, false);
      });
      xBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissedKeys.add(key);
        row.remove();
        const rem = fg.hits.filter((it) => !dismissedKeys.has(it.key)).length;
        if (!rem) { fg.box.remove(); fileGroups.delete(rel); }
        else fg.badge.textContent = String(rem);
        refreshSearchSummary();
      });

      fg.body.appendChild(row);
    }
    refreshSearchSummary();
  }

  function refreshSearchSummary(doneInfo = null) {
    if (!sDom) return;
    const active = flatHits.filter((h) => !dismissedKeys.has(h.key));
    const filesN = fileGroups.size;
    if (!active.length && doneInfo && !sRunId) {
      sDom.status.textContent = tr('Ничего не найдено');
    } else if (active.length) {
      sDom.status.textContent = `${shortRu(active.length, 'совпадение', 'совпадения', 'совпадений')} в ${shortRu(filesN, 'файле', 'файлах', 'файлах')}${sRunId ? '…' : ''}`;
    } else if (!sRunId) {
      sDom.status.textContent = '';
    }
    updateReplaceBtn();
  }

  function finishStreamSearch(p) {
    sRunId = null;
    if (p && p.error && sDom) sDom.status.textContent = p.error;
    else refreshSearchSummary(p || {});
  }

  function triggerSearch(immediate = false) {
    clearTimeout(sTimer);
    if (immediate) runProjectSearch();
    else sTimer = setTimeout(runProjectSearch, 240);
  }

  async function runProjectSearch() {
    if (!sDom) return;
    const p = activeProject();
    if (!p) { sDom.status.textContent = tr('Проект не выбран'); return; }
    const seq = ++sRunSeq;
    if (sRunId && lite.gsearch) {
      const prev = sRunId; sRunId = null;
      try { await lite.gsearch.cancel(prev); } catch (_) {}
    }
    if (seq !== sRunSeq) return;
    clearSearchResults();
    const q = sDom.qInput.value;
    if (!q) { sDom.status.textContent = ''; return; }

    const masks = parseMaskInput(sDom.mInput.value);
    sDom.status.textContent = tr('Поиск…');

    // Для запросов ≥ 2 символов используем быстрый стриминговый gsearch с масками и wholeWord;
    // для 1 символа (gsearch требует ≥ 2) — прозрачный фолбэк на fs.search.
    if (q.length >= 2 && lite.gsearch) {
      const id = 'sp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      sRunId = id;
      const r = await lite.gsearch.start(id, q, {
        mode: 'content',
        caseSensitive: sFlags.caseSensitive,
        wholeWord: sFlags.wholeWord,
        regex: sFlags.regex,
        include: masks.include,
        exclude: masks.exclude,
      }, [{ id: p.id || 'cur', name: p.name || '', path: p.path }]);
      if ((!r || r.ok === false) && sRunId === id) {
        sRunId = null;
        sDom.status.textContent = (r && r.error) || tr('Ошибка поиска');
      }
      return;
    }

    const rxQuery = sFlags.wholeWord && !sFlags.regex
      ? `\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
      : q;
    const r = await lite.fs.search(p.path, rxQuery, {
      caseSensitive: sFlags.caseSensitive,
      regex: sFlags.regex || sFlags.wholeWord,
    });
    if (seq !== sRunSeq) return;
    if (r && r.error) { sDom.status.textContent = r.error; return; }
    const hits = ((r && r.matches) || []).map((mt) => ({
      file: mt.file,
      line: mt.line,
      text: mt.text,
      mcol: 0,
      len: 0,
    }));
    appendStreamHits(hits);
    refreshSearchSummary({});
  }

  function selectSearchHit(idx, previewOnly = true) {
    const item = flatHits[idx];
    if (!item || dismissedKeys.has(item.key)) return;
    activeHitIdx = idx;
    if (sDom) {
      sDom.results.querySelectorAll('.sp-hit-row.sel').forEach((n) => n.classList.remove('sel'));
    }
    item.rowEl.classList.add('sel');
    item.rowEl.scrollIntoView({ block: 'nearest' });
    openFile(item.abs, item.line, { preview: previewOnly });
  }

  function stepSearchHit(dir = 1) {
    const valid = [];
    for (let i = 0; i < flatHits.length; i++) {
      if (!dismissedKeys.has(flatHits[i].key)) valid.push(i);
    }
    if (!valid.length) return false;
    const curPos = valid.indexOf(activeHitIdx);
    let nextPos;
    if (curPos < 0) nextPos = dir > 0 ? 0 : valid.length - 1;
    else nextPos = (curPos + dir + valid.length) % valid.length;
    selectSearchHit(valid[nextPos], true);
    return true;
  }

  async function runReplaceAll() {
    const p = activeProject();
    if (!p || !sDom) return;
    const q = sDom.qInput.value;
    if (!q) return;
    const active = flatHits.filter((h) => !dismissedKeys.has(h.key));
    if (!active.length) return;

    const byFile = new Map();
    for (const h of active) {
      if (!byFile.has(h.rel)) byFile.set(h.rel, new Set());
      byFile.get(h.rel).add(h.line);
    }
    const replacement = sDom.rInput.value;
    const doExec = async () => {
      sDom.rAllBtn.disabled = true;
      sDom.rAllBtn.textContent = tr('Заменяю…');
      let actualQuery = q;
      let actualRegex = sFlags.regex;
      let actualRepl = replacement;
      if (sFlags.wholeWord && !sFlags.regex) {
        actualQuery = `\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        actualRegex = true;
        actualRepl = replacement.replace(/\$/g, '$$$$');
      }
      const targets = [...byFile.entries()].map(([file, set]) => ({ file, lines: [...set] }));
      const r = await lite.fs.replace(p.path, actualQuery, { caseSensitive: sFlags.caseSensitive, regex: actualRegex }, actualRepl, targets);
      if (!r || r.error) {
        toast((r && r.error) || tr('Ошибка замены'), { kind: 'err', ttl: 7000 });
        updateReplaceBtn();
        return;
      }
      toast(`Заменено: ${shortRu(r.lines, 'строка', 'строки', 'строк')} в ${shortRu(r.files, 'файле', 'файлах', 'файлах')}`);
      if (onReplaced) onReplaced();
      triggerSearch(true);
    };

    if (byFile.size > 1 || active.length > 5) {
      showConfirm(
        tr('Заменить в проекте?'),
        `Будет выполнено замен: ${active.length} в ${shortRu(byFile.size, 'файле', 'файлах', 'файлах')}.`,
        tr('Заменить'),
        doExec,
      );
    } else {
      await doExec();
    }
  }

  function focusSearch(opts = {}) {
    if (!sDom) return;
    if (opts.replace !== undefined) setReplaceVisible(!!opts.replace);
    if (opts.wholeWord !== undefined) {
      sFlags.wholeWord = !!opts.wholeWord;
      sDom.btnWord.classList.toggle('on', sFlags.wholeWord);
    }
    if (opts.filesMask !== undefined) {
      masksExpanded = true;
      sDom.rowMasks.classList.remove('hidden');
      sDom.mInput.value = opts.filesMask;
      sDom.maskToggle.classList.add('on');
    }
    if (opts.query !== undefined) {
      sDom.qInput.value = opts.query;
      triggerSearch(true);
    } else if (opts.filesMask !== undefined && sDom.qInput.value.trim()) {
      triggerSearch(true);
    }
    requestAnimationFrame(() => {
      sDom.qInput.focus();
      sDom.qInput.select();
    });
  }

  // =========================================================================
  // 2. СТРУКТУРА ФАЙЛА / OUTLINE (#side-outline-pane)
  // =========================================================================
  let outlineMounted = false;
  let outlineAlpha = false;
  let oDom = null;

  function mountOutlinePane(pane) {
    if (outlineMounted || !pane) return;
    outlineMounted = true;
    pane.replaceChildren();
    const head = el('div', 'pane-head side-head');
    head.appendChild(el('span', 'pane-title', tr('Структура')));
    head.appendChild(el('div', 'drag-space-static'));
    const sortBtn = el('button', 'icon-btn'); sortBtn.type = 'button'; sortBtn.title = tr('Сортировка: по порядку / А–Я');
    sortBtn.appendChild(icon('obs-sort', 14));
    head.appendChild(sortBtn);

    const filterWrap = el('div', 'sp-filter-bar');
    const fInput = el('input', 'sp-input'); fInput.type = 'text'; fInput.placeholder = tr('Фильтр символов…'); fInput.spellcheck = false;
    filterWrap.appendChild(fInput);

    const list = el('div', 'sp-results sp-outline-list');
    pane.append(head, filterWrap, list);
    oDom = { pane, fInput, list, sortBtn };

    sortBtn.onclick = () => { outlineAlpha = !outlineAlpha; sortBtn.classList.toggle('on', outlineAlpha); renderOutline(); };
    fInput.addEventListener('input', () => renderOutline());
  }

  function renderOutline() {
    if (!oDom) return;
    const file = getCurrentFile();
    oDom.list.replaceChildren();
    if (!file) {
      oDom.list.appendChild(el('div', 'tree-empty', tr('Откройте файл, чтобы увидеть его структуру')));
      return;
    }
    const allSyms = resolveCurrentSymbols();
    const syms = allSyms.slice();
    if (!syms.length) {
      oDom.list.appendChild(el('div', 'tree-empty', tr('Символы в этом файле не найдены')));
      return;
    }
    const curLn = (host.getCursorLine && host.getCursorLine()) || lastCursorLine || 1;
    const activeSym = enclosingSymbolAtLine(allSyms, curLn);
    const q = oDom.fInput.value.trim().toLowerCase();
    const filtered = q ? syms.filter((s) => s.name.toLowerCase().includes(q)) : syms;
    if (outlineAlpha) filtered.sort((a, b) => a.name.localeCompare(b.name));

    for (const s of filtered) {
      const row = el('div', 'sp-sym-row' + (activeSym && activeSym.line === s.line && activeSym.name === s.name ? ' active' : ''));
      row.dataset.line = String(s.line);
      row.appendChild(el('span', 'ov-kind ov-' + s.kind, kindGlyph(s.kind)));
      row.appendChild(el('span', 'sp-sym-name', s.name));
      if (s.detail) row.appendChild(el('span', 'sp-sym-sig', s.detail));
      row.appendChild(el('span', 'sp-sym-ln', ':' + s.line));
      row.addEventListener('click', () => openFile(file, s.line, { preview: false }));
      oDom.list.appendChild(row);
    }
  }

  function highlightActiveOutlineLine(lineNumber) {
    lastCursorLine = lineNumber || 1;
    if (!oDom || oDom.pane.classList.contains('hidden')) return;
    const activeSym = enclosingSymbolAtLine(resolveCurrentSymbols(), lastCursorLine);
    oDom.list.querySelectorAll('.sp-sym-row').forEach((r) => {
      r.classList.toggle('active', !!(activeSym && Number(r.dataset.line) === activeSym.line));
    });
  }

  // =========================================================================
  // 3. TODO / FIXME ПО ПРОЕКТУ (#side-todos-pane)
  // =========================================================================
  let todosMounted = false;
  let todoTagFilter = 'ALL';
  let cachedTodos = [];
  let tDom = null;

  function mountTodosPane(pane) {
    if (todosMounted || !pane) return;
    todosMounted = true;
    pane.replaceChildren();
    const head = el('div', 'pane-head side-head');
    const title = el('span', 'pane-title', 'TODO');
    const cnt = el('span', 'tabs-count', '');
    head.append(title, cnt, el('div', 'drag-space-static'));
    const refBtn = el('button', 'icon-btn'); refBtn.type = 'button'; refBtn.title = tr('Пересканировать TODO в проекте');
    refBtn.appendChild(icon('refresh', 14));
    head.appendChild(refBtn);

    const chips = el('div', 'sp-chips');
    for (const [id, lbl] of [['ALL', tr('Все')], ['TODO', 'TODO'], ['FIXME', 'FIXME'], ['BUG', 'BUG/HACK']]) {
      const c = el('button', 'sp-chip' + (todoTagFilter === id ? ' on' : ''), lbl); c.type = 'button';
      c.onclick = () => {
        todoTagFilter = id;
        chips.querySelectorAll('.sp-chip').forEach((b) => b.classList.toggle('on', b === c));
        renderTodosList();
      };
      chips.appendChild(c);
    }
    const filterWrap = el('div', 'sp-filter-bar');
    const fInput = el('input', 'sp-input'); fInput.type = 'text'; fInput.placeholder = tr('Фильтр задач…'); fInput.spellcheck = false;
    filterWrap.appendChild(fInput);

    const list = el('div', 'sp-results');
    pane.append(head, chips, filterWrap, list);
    tDom = { pane, cnt, fInput, list };
    refBtn.onclick = () => scanTodos();
    fInput.addEventListener('input', () => renderTodosList());
  }

  async function scanTodos() {
    if (!tDom) return;
    const p = activeProject();
    if (!p) { tDom.list.replaceChildren(el('div', 'tree-empty', tr('Проект не выбран'))); return; }
    tDom.list.replaceChildren(el('div', 'git-loading', tr('Сканирование…')));
    const r = await lite.fs.search(p.path, '\\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\\b', { regex: true, caseSensitive: true });
    if (r && r.error) { tDom.list.replaceChildren(el('div', 'tree-empty', r.error)); return; }
    cachedTodos = ((r && r.matches) || []).map((mt) => {
      const rel = String(mt.file || '').replace(/\\/g, '/');
      const kind = ((mt.text.match(/\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\b/) || [])[1] || 'TODO').toUpperCase();
      return { rel, abs: joinPath(p.path, rel), line: mt.line, text: mt.text.trim(), kind };
    });
    renderTodosList();
  }

  function renderTodosList() {
    if (!tDom) return;
    const q = tDom.fInput.value.trim().toLowerCase();
    const items = cachedTodos.filter((it) => {
      if (todoTagFilter === 'TODO' && it.kind !== 'TODO' && it.kind !== 'NOTE') return false;
      if (todoTagFilter === 'FIXME' && it.kind !== 'FIXME') return false;
      if (todoTagFilter === 'BUG' && !['BUG', 'HACK', 'XXX'].includes(it.kind)) return false;
      if (q && !(it.rel + ':' + it.line + ' ' + it.text).toLowerCase().includes(q)) return false;
      return true;
    });
    tDom.cnt.textContent = items.length ? String(items.length) : '';
    tDom.list.replaceChildren();
    if (!items.length) {
      tDom.list.appendChild(el('div', 'tree-empty', tr('Заметок TODO/FIXME не найдено')));
      return;
    }
    const byFile = new Map();
    for (const it of items) {
      if (!byFile.has(it.rel)) byFile.set(it.rel, []);
      byFile.get(it.rel).push(it);
    }
    for (const [rel, arr] of byFile) {
      const box = el('div', 'sp-file-group');
      const head = el('div', 'sp-file-head');
      head.append(el('span', 'sp-file-chev', '▾'), fileTypeSvg(rel), el('span', 'sp-file-name', baseName(rel)), el('span', 'sp-badge', String(arr.length)));
      const body = el('div', 'sp-file-body');
      head.onclick = () => box.classList.toggle('collapsed');
      for (const it of arr) {
        const row = el('div', 'sp-hit-row');
        row.title = it.text.slice(0, 400);
        row.appendChild(el('span', 'ov-kind ov-todo-' + it.kind.toLowerCase(), it.kind));
        row.appendChild(el('span', 'sp-hit-ln', ':' + it.line));
        row.appendChild(el('span', 'sp-hit-txt', it.text.slice(0, 160)));
        row.onclick = () => openFile(it.abs, it.line, { preview: true });
        row.ondblclick = () => openFile(it.abs, it.line, { preview: false });
        body.appendChild(row);
      }
      box.append(head, body);
      tDom.list.appendChild(box);
    }
  }

  // =========================================================================
  // 4. ЗАКЛАДКИ (#side-bookmarks-pane)
  // =========================================================================
  let bmMounted = false;
  let bDom = null;

  function mountBookmarksPane(pane) {
    if (bmMounted || !pane) return;
    bmMounted = true;
    pane.replaceChildren();
    const head = el('div', 'pane-head side-head');
    const title = el('span', 'pane-title', tr('Закладки'));
    const cnt = el('span', 'tabs-count', '');
    head.append(title, cnt, el('div', 'drag-space-static'));
    const addBtn = el('button', 'icon-btn'); addBtn.type = 'button'; addBtn.title = tr('Поставить/снять закладку на текущей строке (Ctrl+F2)');
    addBtn.appendChild(icon('plus', 14));
    head.appendChild(addBtn);

    const list = el('div', 'sp-results');
    pane.append(head, list);
    bDom = { pane, cnt, list };
    addBtn.onclick = () => { if (toggleBookmarkHere) toggleBookmarkHere(); renderBookmarksPane(); };
  }

  function removeOneBookmark(target) {
    const items = getBookmarks ? getBookmarks() : [];
    const idx = items.indexOf(target);
    if (idx >= 0) {
      items.splice(idx, 1);
      if (saveBookmarks) saveBookmarks();
    }
  }

  function promptBookmarkLabel(target) {
    showPrompt(tr('Подпись закладки'), tr('Краткая заметка (необязательно)'), target.label || '', (val) => {
      target.label = String(val || '').trim();
      if (saveBookmarks) saveBookmarks();
      renderBookmarksPane();
    });
  }

  function renderBookmarksPane() {
    if (!bDom) return;
    const p = activeProject();
    const items = getBookmarks() || [];
    bDom.cnt.textContent = items.length ? String(items.length) : '';
    bDom.list.replaceChildren();
    if (!items.length) {
      bDom.list.appendChild(el('div', 'tree-empty', tr('Закладок пока нет.\nНажмите Ctrl+F2 или кликните слева от номера строки.')));
      return;
    }
    for (const b of items) {
      const rel = p ? relTo(p.path, b.file) : b.file;
      const row = el('div', 'sp-hit-row sp-bm-row');
      row.appendChild(el('span', 'cm-bm-mark', '★'));
      const main = el('div', 'sp-bm-main');
      const top = el('div', 'sp-bm-top');
      top.append(fileTypeSvg(b.file), el('span', 'sp-file-name', baseName(b.file)), el('span', 'sp-hit-ln', ':' + b.line));
      main.appendChild(top);
      main.appendChild(el('div', 'sp-bm-sub', b.label ? `${b.label} · ${rel}` : rel));
      const editBtn = el('button', 'sp-dismiss'); editBtn.type = 'button'; editBtn.title = tr('Подписать закладку');
      editBtn.appendChild(icon('pencil', 11));
      const delBtn = el('button', 'sp-dismiss'); delBtn.type = 'button'; delBtn.title = tr('Удалить закладку');
      delBtn.textContent = '×';
      row.append(main, editBtn, delBtn);

      row.onclick = (e) => {
        if (editBtn.contains(e.target) || e.target === delBtn) return;
        openFile(b.file, b.line, { preview: false });
      };
      editBtn.onclick = (e) => { e.stopPropagation(); promptBookmarkLabel(b); };
      delBtn.onclick = (e) => { e.stopPropagation(); removeOneBookmark(b); renderBookmarksPane(); };
      bDom.list.appendChild(row);
    }
  }

  let outlineRefreshTimer = null;

  return {
    mount({ search, outline, todos, bookmarks }) {
      mountSearchPane(search);
      mountOutlinePane(outline);
      mountTodosPane(todos);
      mountBookmarksPane(bookmarks);
    },
    setActivePanel(name) {
      activePanelName = name || null;
    },
    openSearch(opts) {
      activePanelName = 'search';
      focusSearch(opts || {});
    },
    openOutline() {
      activePanelName = 'outline';
      renderOutline();
    },
    openTodos() {
      activePanelName = 'todos';
      scanTodos();
    },
    openBookmarks() {
      activePanelName = 'bookmarks';
      renderBookmarksPane();
    },
    refreshActive() {
      if (activePanelName === 'outline') renderOutline();
      else if (activePanelName === 'todos') scanTodos();
      else if (activePanelName === 'bookmarks') renderBookmarksPane();
      else if (activePanelName === 'search') triggerSearch(true);
    },
    onFileOpened() {
      if (activePanelName === 'outline') renderOutline();
    },
    onDocChanged() {
      if (activePanelName !== 'outline') return;
      clearTimeout(outlineRefreshTimer);
      outlineRefreshTimer = setTimeout(renderOutline, 220);
    },
    onCursorLine(lineNum) {
      highlightActiveOutlineLine(lineNum);
    },
    stepSearchResult: stepSearchHit,
    clearSearchResults,
  };
}
