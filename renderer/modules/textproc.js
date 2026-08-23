// renderer/modules/textproc.js
// ============================================================================
// Модуль «Обработка текста» — полноэкранный AI-редактор документа (design handoff «Lite Editor v2»).
// Канонический формат документа — Markdown (+ LaTeX через $.../$$...$$). Режим «Разметка» — WYSIWYG-рендер
// этого источника (marked + KaTeX, локально, без CDN — см. AI_CONTEXT.md/CLAUDE.md, пункт про CSP);
// режим «Markdown» — сам источник. Переключение режимов конвертирует контент в обе стороны.
// ============================================================================
import { marked } from 'marked';
import katex from 'katex/dist/katex.mjs';
import 'katex/dist/katex.min.css';
import DOMPurify from 'dompurify';
import { baseName } from '../ui.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

marked.setOptions({ breaks: true });

// ---- Markdown ⇄ HTML (+ формулы) ----------------------------------------------------------
const F_OPEN = '⟦', F_CLOSE = '⟧'; // ⟦ ⟧ — маловероятные в обычном тексте маркеры-плейсхолдеры
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

function extractFormulas(src) {
  const blocks = [], inlines = [];
  let text = String(src || '');
  
  // Блочные формулы: $$...$$
  text = text.replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (_, tex) => {
    const i = blocks.length; blocks.push(tex);
    return F_OPEN + 'B' + i + F_CLOSE;
  });
  // Блочные формулы: \[...\]
  text = text.replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, (_, tex) => {
    const i = blocks.length; blocks.push(tex);
    return F_OPEN + 'B' + i + F_CLOSE;
  });
  // Строчные формулы: \(...\)
  text = text.replace(/(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g, (_, tex) => {
    const i = inlines.length; inlines.push(tex);
    return F_OPEN + 'I' + i + F_CLOSE;
  });
  // Строчные формулы: $...$
  text = text.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_, tex) => {
    const i = inlines.length; inlines.push(tex);
    return F_OPEN + 'I' + i + F_CLOSE;
  });
  
  return { text, blocks, inlines };
}

function renderFormulaHtml(tex, displayMode) {
  try { return katex.renderToString(tex, { throwOnError: false, displayMode }); }
  catch (_) { return '<span class="tp-formula-err">ошибка в формуле</span>'; }
}

function formulaBlockHtml(tex, num) {
  return '<div class="tp-formula-block" contenteditable="false" data-tex="' + escapeAttr(tex) + '">'
    + '<div class="tp-formula-render">' + renderFormulaHtml(tex, true) + '</div>'
    + '<div class="tp-formula-src"><pre>' + escapeHtml(tex) + '</pre></div>'
    + '<span class="tp-formula-num">(' + escapeHtml(num) + ')</span>'
    + '<button type="button" class="tp-formula-toggle" title="Показать/скрыть LaTeX">&lt;/&gt;</button>'
    + '</div>';
}
function formulaInlineHtml(tex) {
  return '<span class="tp-formula-inline" contenteditable="false" data-tex="' + escapeAttr(tex) + '">'
    + renderFormulaHtml(tex, false) + '</span>';
}

// Markdown-источник → HTML для «Разметки». Блочные/инлайн-формулы выносятся в плейсхолдеры до marked
// (чтобы parser их не тронул), потом подставляются готовым KaTeX-рендером.
function mdToHtml(src) {
  const { text, blocks, inlines } = extractFormulas(src);
  let html = marked.parse(text);
  let n = 0;
  blocks.forEach((rawTex, i) => {
    let tex = rawTex.trim(), num;
    const m = tex.match(/\\tag\{([^}]*)\}/);
    if (m) { num = m[1]; tex = tex.replace(/\\tag\{[^}]*\}/, '').trim(); }
    else { n++; num = String(n); }
    const token = F_OPEN + 'B' + i + F_CLOSE;
    const wrapped = new RegExp('<p>\\s*' + reEscape(token) + '\\s*</p>|' + reEscape(token));
    html = html.replace(wrapped, formulaBlockHtml(tex, num));
  });
  inlines.forEach((tex, i) => {
    html = html.split(F_OPEN + 'I' + i + F_CLOSE).join(formulaInlineHtml(tex.trim()));
  });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['contenteditable', 'data-tex'] });
}

// HTML (из contenteditable) → Markdown-источник. Покрывает только то, что реально производит
// наш тулбар (execCommand) + формулы — не претендует на полный конвертер произвольного HTML.
function htmlToMd(root) {
  const mdEscape = (t) => t.replace(/[\\`*_$]/g, '\\$&');
  function inlineOf(node) {
    let s = '';
    node.childNodes.forEach((n) => { s += oneInline(n); });
    return s;
  }
  function oneInline(n) {
    if (n.nodeType === Node.TEXT_NODE) return mdEscape(n.textContent);
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    if (n.classList.contains('tp-formula-inline')) return '$' + (n.dataset.tex || '') + '$';
    if (n.classList.contains('tp-formula-block')) return '\n\n$$' + (n.dataset.tex || '') + '$$\n\n';
    switch (n.tagName.toLowerCase()) {
      case 'strong': case 'b': { const t = inlineOf(n); return t.trim() ? '**' + t + '**' : t; }
      case 'em': case 'i': { const t = inlineOf(n); return t.trim() ? '*' + t + '*' : t; }
      case 'u': { const t = inlineOf(n); return t.trim() ? '<u>' + t + '</u>' : t; }
      case 'code': return '`' + n.textContent + '`';
      case 'br': return '\n';
      default: return inlineOf(n);
    }
  }
  function listOf(n, ordered) {
    let s = '', i = 1;
    n.childNodes.forEach((li) => {
      if (li.nodeType !== Node.ELEMENT_NODE || li.tagName.toLowerCase() !== 'li') return;
      s += (ordered ? (i++ + '. ') : '- ') + inlineOf(li).trim() + '\n';
    });
    return s + '\n';
  }
  function blockOf(n) {
    if (n.nodeType === Node.TEXT_NODE) { const t = n.textContent.trim(); return t ? mdEscape(t) + '\n\n' : ''; }
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    if (n.classList.contains('tp-formula-block')) return '$$' + (n.dataset.tex || '') + '$$\n\n';
    switch (n.tagName.toLowerCase()) {
      case 'h1': return '# ' + inlineOf(n).trim() + '\n\n';
      case 'h2': return '## ' + inlineOf(n).trim() + '\n\n';
      case 'h3': return '### ' + inlineOf(n).trim() + '\n\n';
      case 'ul': return listOf(n, false);
      case 'ol': return listOf(n, true);
      case 'blockquote': return inlineOf(n).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      default: { const t = inlineOf(n).trim(); return t ? t + '\n\n' : ''; }
    }
  }
  let out = '';
  root.childNodes.forEach((n) => { out += blockOf(n); });
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function initTextProc(host) {
  const { el, toast, showConfirm, settings, saveSettings, saveUiState, refitActiveTerminal, closeOtherPanels, layout, GUTTER } = host;
  const lite = window.lite;

  let docOpen = false;
  let currentFile = null;
  let currentName = 'Безымянный';
  let mode = 'wysiwyg'; // 'wysiwyg' | 'markdown'
  let dirty = false;
  let openTabs = [];
  let activeTabId = null;
  let nextTabId = 1;
  let activeProj = null;
  let chatAgent = ['claude', 'codex', 'antigravity'].includes(settings.tpAgent) ? settings.tpAgent : 'claude';
  // Режим: 'chat' (Ассистент — текст в ответ) | 'agent' (Агент — правит файл сам).
  let chatMode = settings.tpMode === 'agent' ? 'agent' : 'chat';
  // Режим берём из тумблера для всех моделей (Antigravity в чате идёт как `agy --mode plan`).
  const effMode = () => chatMode;
  // Скрепка: приложен ли документ к сообщению. Выключена — обычный разговор без контекста.
  // Точечная правка абзаца делается через всплывающую панель у выделения, поэтому скрепка = весь документ.
  let attachDoc = settings.tpAttachDoc !== false;
  let chatRole = 'Без роли';
  let chatLog = [];
  let aiSeq = 0;
  // Сортировка дерева. TREE_SORTS — все доступные порядки; в «цикле» участвуют только
  // отмеченные пользователем (левый клик по кнопке листает их по кругу, правый — меню).
  const TREE_SORTS = [
    { id: 'az',  label: 'Имя: А → Я' },
    { id: 'za',  label: 'Имя: Я → А' },
    { id: 'new', label: 'Изменён: сначала новые' },
    { id: 'old', label: 'Изменён: сначала старые' },
  ];
  let treeSortMode = TREE_SORTS.some((x) => x.id === settings.tpSortMode) ? settings.tpSortMode : 'az';
  let treeSortCycle = Array.isArray(settings.tpSortCycle) && settings.tpSortCycle.length
    ? settings.tpSortCycle.filter((id) => TREE_SORTS.some((x) => x.id === id))
    : ['az', 'za'];
  // Скрытые файлы: точечные (.obsidian и т.п.) + вручную спрятанные пути.
  let treeShowHidden = settings.tpShowHidden === true;
  let treeHiddenPaths = Array.isArray(settings.tpHiddenPaths) ? settings.tpHiddenPaths.slice() : [];
  function isHiddenEntry(e) {
    return (e.name || '').startsWith('.') || treeHiddenPaths.includes(e.path);
  }
  function sortEntries(list) {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const t = (e) => new Date(e.mtime || e.ctime || 0).getTime();
    if (treeSortMode === 'za') return list.sort((a, b) => byName(b, a));
    if (treeSortMode === 'new') return list.sort((a, b) => t(b) - t(a) || byName(a, b));
    if (treeSortMode === 'old') return list.sort((a, b) => t(a) - t(b) || byName(a, b));
    return list.sort(byName);
  }

  // ---- Контекстное меню (правая кнопка / два пальца) --------------------------------------
  // Пункт: { label, onClick } | { label, checked, order, onToggle } | { sep: true } | { title: '…' }
  function showContextMenu(x, y, items) {
    document.querySelectorAll('.tp-ctx-menu').forEach((m) => m.remove());
    const menu = el('div', 'tp-ctx-menu');
    items.forEach((it) => {
      if (it.sep) { menu.appendChild(el('div', 'tp-ctx-sep')); return; }
      if (it.title) { menu.appendChild(el('div', 'tp-ctx-title', it.title)); return; }
      const row = el('div', 'tp-ctx-item' + (it.active ? ' active' : ''));
      if (it.onToggle) {
        const box = el('button', 'tp-ctx-check' + (it.checked ? ' on' : ''), it.checked ? String(it.order) : '');
        box.type = 'button';
        box.title = it.checked ? 'Убрать из переключения по кругу' : 'Добавить в переключение по кругу';
        box.onclick = (e) => { e.stopPropagation(); it.onToggle(); };
        row.appendChild(box);
      }
      const lbl = el('span', 'tp-ctx-label', it.label);
      row.appendChild(lbl);
      lbl.onclick = () => { menu.remove(); if (it.onClick) it.onClick(); };
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.round(Math.max(8, Math.min(x, window.innerWidth - w - 8))) + 'px';
    menu.style.top = Math.round(Math.max(8, Math.min(y, window.innerHeight - h - 8))) + 'px';
    const close = (e) => {
      if (menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener('mousedown', close, true);
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', esc); }
    });
    return menu;
  }
  
  function fileBadge(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      docx: { cls: 'docx', text: 'DOC' },
      doc:  { cls: 'docx', text: 'DOC' },
      md:   { cls: 'md',   text: 'M↓'  },
      txt:  { cls: 'txt',  text: 'TXT' },
    };
    const m = map[ext] || { cls: 'other', text: '•' };
    const el = document.createElement('span');
    el.className = 'tp-file-badge tp-ext-' + m.cls;
    el.textContent = m.text;
    return el;
  }
  
  let dynamicRoles = ['Без роли'];

  const SYMBOLS = [
    { label: 'x²', tex: '^{}' }, { label: 'x₂', tex: '_{}' }, { label: '½', tex: '\\frac{}{}' }, { label: '√', tex: '\\sqrt{}' },
    { label: '∑', tex: '\\sum_{}^{}' }, { label: '∫', tex: '\\int_{}^{}' }, { label: '∏', tex: '\\prod_{}^{}' }, { label: 'lim', tex: '\\lim_{}' },
    { label: 'π', tex: '\\pi' }, { label: 'α', tex: '\\alpha' }, { label: 'β', tex: '\\beta' }, { label: 'θ', tex: '\\theta' },
    { label: '≤', tex: '\\leq' }, { label: '≥', tex: '\\geq' }, { label: '≠', tex: '\\neq' }, { label: '±', tex: '\\pm' },
    { label: '×', tex: '\\times' }, { label: '÷', tex: '\\div' }, { label: '→', tex: '\\to' }, { label: '∞', tex: '\\infty' },
    { label: 'ā', tex: '\\vec{}' }, { label: '∂', tex: '\\partial' }, { label: '∈', tex: '\\in' }, { label: '·', tex: '\\cdot' },
  ];

  // ---- Рейка-навигатор: метки заголовков + бегунок текущей позиции (рядом с обычным скроллом) ----
  let tocHasContent = false;
  let scrubberDebounceTimer = null;
  function computeHeadingMarks() {
    const doc = $('#doc-editor-wysiwyg');
    const canvas = document.querySelector('.tp-canvas');
    if (!doc || !canvas) return [];
    const maxScroll = Math.max(1, canvas.scrollHeight - canvas.clientHeight);
    return $$('#doc-editor-wysiwyg h1, #doc-editor-wysiwyg h2, #doc-editor-wysiwyg h3').map((h) => {
      let offset = h.offsetTop;
      let curr = h.offsetParent;
      while (curr && curr !== canvas && curr !== document.body) {
        offset += curr.offsetTop;
        curr = curr.offsetParent;
      }
      return {
        el: h,
        level: h.tagName.toLowerCase(),
        text: h.textContent.trim().slice(0, 80),
        top: offset,
        ratio: Math.max(0, Math.min(1, offset / maxScroll)),
      };
    });
  }
  // Навигация по главам «как в дипсике»: у правого края идёт столбик коротких чёрточек —
  // по одной на заголовок. Наводишь на любую — на её месте разворачивается весь список глав
  // (названия слева, чёрточки остаются справа, строка под курсором подсвечена). Клик — переход.
  let tocMarks = [];          // [{ mark, row, item }]
  let tocHideTimer = null;
  function renderScrubber() {
    const rail = $('#doc-toc-rail');
    const list = $('#doc-toc-list');
    const clear = () => {
      if (rail) { rail.innerHTML = ''; rail.hidden = true; }
      if (list) { list.innerHTML = ''; list.hidden = true; list.classList.remove('visible'); }
      tocMarks = [];
      tocHasContent = false;
    };
    if (!rail || !list || mode !== 'wysiwyg') { clear(); return; }
    const marks = computeHeadingMarks();
    if (marks.length === 0) { clear(); return; }
    tocHasContent = true;
    rail.innerHTML = '';
    list.innerHTML = '';
    rail.hidden = false;
    list.hidden = true;
    list.classList.remove('visible');

    const jump = (m) => { hideTocList(true); m.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    // Фактический шаг между чёрточками и «плотный» режим списка для длинных документов.
    const railH = Math.max(80, (document.querySelector('.tp-canvas')?.getBoundingClientRect().height || 600) - 100);
    const railStep = Math.max(5, Math.min(14, Math.floor(railH / marks.length)));
    list.classList.toggle('dense', marks.length > 24);

    tocMarks = marks.map((m, i) => {
      // Чёрточки распределены по рейке ровно, а не по месту главы в тексте: так они не
      // слипаются в кучу на длинных документах и совпадают со строками раскрытого списка.
      const row = el('div', 'tp-toc-rail-row ' + m.level);
      row.style.top = (((i + 0.5) / marks.length) * 100) + '%';
      // Глав может быть много: сужаем строку-мишень под фактический шаг, иначе они
      // перекрывают друг друга и навести можно только на последнюю.
      if (railStep < 14) { row.style.height = railStep + 'px'; row.style.marginTop = (-railStep / 2) + 'px'; }
      row.appendChild(el('div', 'tp-toc-rail-dash'));
      row.addEventListener('mouseenter', () => showTocList(row));
      row.addEventListener('click', (e) => { e.stopPropagation(); jump(m); });
      rail.appendChild(row);

      // Строка раскрытого списка: название прижато вправо, к своей чёрточке.
      const item = el('div', 'tp-toc-item ' + m.level);
      const text = el('span', 'tp-toc-item-text', m.text);
      text.title = m.text;
      item.appendChild(text);
      item.appendChild(el('span', 'tp-toc-item-dash'));
      item.addEventListener('click', (e) => { e.stopPropagation(); jump(m); });
      list.appendChild(item);

      return { mark: m, row, item };
    });
    placeTocRail();
    updateTocActive();
  }

  // Раскрыть список на месте той чёрточки, на которую навели.
  function showTocList(anchorRow) {
    const rail = $('#doc-toc-rail');
    const list = $('#doc-toc-list');
    const canvas = document.querySelector('.tp-canvas');
    if (!rail || !list || !canvas || !tocMarks.length) return;
    clearTimeout(tocHideTimer);
    detachTocLayer();
    list.hidden = false;
    const railRect = rail.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    // Правый край списка совпадает с рейкой: чёрточки остаются на своих местах, слева к ним
    // «выезжают» названия — панель не прыгает в другой угол экрана.
    list.style.right = Math.round(Math.max(0, window.innerWidth - railRect.right)) + 'px';
    // Длинное содержание должно использовать всю доступную высоту, а не обрезаться на середине.
    list.style.maxHeight = Math.round(Math.max(160, cRect.height - 24)) + 'px';
    const aRect = (anchorRow || rail).getBoundingClientRect();
    const h = list.offsetHeight;
    const top = Math.max(cRect.top + 8, Math.min(aRect.top + aRect.height / 2 - h / 2, cRect.bottom - h - 8));
    list.style.top = Math.round(top) + 'px';
    list.classList.add('visible');
    rail.classList.add('is-open'); // сами чёрточки на рейке гасим: их место занял список
    // Если список прокручиваемый — показываем ту главу, на которую навели, и текущую рядом.
    if (list.scrollHeight > list.clientHeight) {
      const anchor = tocMarks.find((t) => t.row === anchorRow) || tocMarks.find((t) => t.item.classList.contains('current'));
      if (anchor) list.scrollTop = Math.max(0, anchor.item.offsetTop - list.clientHeight / 2);
    }
  }
  function hideTocList(now) {
    const rail = $('#doc-toc-rail');
    const list = $('#doc-toc-list');
    if (!list) return;
    clearTimeout(tocHideTimer);
    const doHide = () => {
      list.classList.remove('visible');
      list.hidden = true;
      if (rail) rail.classList.remove('is-open');
    };
    if (now) doHide();
    else tocHideTimer = setTimeout(doHide, 160);
  }

  // Рейка и список нарисованы поверх страницы (position: fixed). Держим их прямо в body:
  // внутри .tp-canvas они оказывались под её собственной полосой прокрутки, и та забирала
  // себе наведение и клики — чёрточки было видно, но нажать на них было нельзя.
  function detachTocLayer() {
    const rail = $('#doc-toc-rail');
    const list = $('#doc-toc-list');
    [rail, list].forEach((n) => { if (n && n.parentElement !== document.body) document.body.appendChild(n); });
  }
  function placeTocRail() {
    const rail = $('#doc-toc-rail');
    const canvas = document.querySelector('.tp-canvas');
    if (!rail || !canvas || rail.hidden) return;
    detachTocLayer();
    const r = canvas.getBoundingClientRect();
    // Ширина полосы прокрутки: рейку ставим ЛЕВЕЕ неё, иначе она перекрывает чёрточки.
    const sb = Math.max(0, canvas.offsetWidth - canvas.clientWidth);
    // Отступ сверху был 60px — он компенсировал полосу вкладок, лежавшую внутри прокрутки.
    // Вкладки вынесены наружу, верх области прокрутки теперь и есть верх текста, поэтому
    // рейка идёт по всей высоте — вровень с полосой прокрутки, без ступеньки посередине.
    rail.style.top = Math.round(r.top + 12) + 'px';
    rail.style.height = Math.round(Math.max(80, r.height - 24)) + 'px';
    rail.style.right = Math.round(Math.max(4, window.innerWidth - r.right + sb + 2)) + 'px';
  }

  // Текущая глава = последний заголовок выше верхней кромки экрана.
  function updateTocActive() {
    const canvas = document.querySelector('.tp-canvas');
    if (!canvas || !tocMarks.length) return;
    const y = canvas.scrollTop + 90;
    let idx = 0;
    tocMarks.forEach((t, i) => { if (t.mark.top <= y) idx = i; });
    tocMarks.forEach((t, i) => {
      t.row.classList.toggle('active', i === idx);
      t.item.classList.toggle('current', i === idx);
    });
  }

  function scheduleScrubberUpdate() {
    window.tpZoomBase = null; // текст правили — высота содержимого другая
    clearTimeout(scrubberDebounceTimer);
    scrubberDebounceTimer = setTimeout(renderScrubber, 800);
  }

  // ---- helpers ----
  function getActiveEditor() { return mode === 'wysiwyg' ? $('#doc-editor-wysiwyg') : $('#doc-editor-md'); }
  function currentMarkdown() { return mode === 'wysiwyg' ? htmlToMd($('#doc-editor-wysiwyg')) : $('#doc-editor-md').textContent; }
  function currentHtml() { return mode === 'wysiwyg' ? $('#doc-editor-wysiwyg').innerHTML : mdToHtml($('#doc-editor-md').textContent); }
  function htmlDocWrap(inner) { return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + inner + '</body></html>'; }
  function markDirty() {
    dirty = true;
    if (typeof saveCurrentTabState === 'function') { saveCurrentTabState(); if (typeof renderTabsUI === 'function') renderTabsUI(); }
    scheduleAutosave();
  }
  function updateStatus(text) {
    const statusLabel = $('#doc-status-label');
    if (text != null && statusLabel) statusLabel.textContent = text;
    
    const nameLabel = $('#doc-name-label');
    if (nameLabel) nameLabel.textContent = currentName;
  }
  // Тулбар — полоса с прокруткой (overflow), поэтому выпадающее меню, нарисованное внутри неё,
  // срезалось по её краю и выбрать пункт было нельзя. Показываем меню отдельным слоем:
  // position: fixed + координаты кнопки. Заодно не даём вылезти за край окна.
  // Меню выпадашек переносятся в конец страницы (см. ниже), поэтому искать их пункты
  // «внутри выпадашки» больше нельзя — ищем по метке владельца.
  function ddItems(ddId) {
    return Array.from(document.querySelectorAll('.tp-dd-menu[data-owner="' + ddId + '"] .tp-dd-item'));
  }
  function placeMenuByButton(btn, menu, align) {
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.margin = '0';
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    const w = menu.offsetWidth || 160;
    const left = align === 'right' ? (r.right - w) : r.left;
    menu.style.left = Math.round(Math.max(8, Math.min(left, window.innerWidth - w - 8))) + 'px';
    menu.style.right = 'auto';
    const maxH = Math.max(140, window.innerHeight - r.bottom - 20);
    menu.style.maxHeight = maxH + 'px';
  }

  // Ссылки на функции масштаба: они объявлены внутри setupUI, а нужны обработчику кнопки «Панели».
  let tpSetZoomRef = null, tpFitZoomRef = null;
  function updateThumb(container, activeBtn) {
    if (!container || !activeBtn) return;
    const thumb = container.querySelector('.tp-seg-thumb');
    if (!thumb) return;
    
    container._activeBtn = activeBtn;
    
    const apply = () => {
      const btn = container._activeBtn;
      if (btn && btn.offsetWidth > 0) {
        thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
        thumb.style.width = `${btn.offsetWidth}px`;
      }
    };
    apply();
    
    if (!container._thumbObs) {
      container._thumbObs = new ResizeObserver(apply);
      container._thumbObs.observe(container);
    }
  }
  function loadDocument(html) {
    mode = 'wysiwyg';
    $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['contenteditable', 'data-tex'] });
    $('#doc-editor-md').textContent = '';
    dirty = false;
    updateModeUI();
  }

  // ---- UI Setup ----
  let uiWired = false; // повторный setOpen не должен дублировать addEventListener (wheel-зум, input и т.д.)
  function setupUI() {
    if (uiWired) { updateModeUI(); return; }
    uiWired = true;
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}

    $$('.tp-seg-btn[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $$('.tp-tab[data-tab]').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

    $('#doc-toggle-inspector').onclick = () => {
      const layoutEl = document.querySelector('.tp-layout');
      const collapsed = layoutEl.classList.toggle('inspector-collapsed');
      // Убрал панель — значит хочет читать шире: подгоняем страницу по ширине.
      // Вернул — возвращаем 100%. Ждём конца анимации панели, иначе меряем на лету.
      setTimeout(() => { if (tpFitZoomRef) tpFitZoomRef(collapsed); }, 440);
    };
    const toggleSidebarBtn = $('#doc-toggle-sidebar');
    if (toggleSidebarBtn) toggleSidebarBtn.onclick = toggleSidebar;

    
    // Responsive toolbar logic
    
    // Paragraph numbering toggle
    const toggleNumBtn = $('#doc-toggle-numbering');
    if (toggleNumBtn) {
      toggleNumBtn.addEventListener('click', () => {
        const editor = $('#doc-editor-wysiwyg');
        if (editor) {
          editor.classList.toggle('show-paragraph-numbers');
          toggleNumBtn.classList.toggle('active');
        }
      });
    }

    const tbMerged = $('.tp-toolbar-merged');
    if (tbMerged) {
      const overflowBtnWrap = $('.tp-toolbar-overflow-btn');
      const overflowBtn = $('#doc-toolbar-overflow-btn');
      const overflowMenu = $('#doc-toolbar-overflow-menu');
      const layoutEl = document.querySelector('.tp-layout');
      const rowEl = tbMerged.closest('.tp-shell-row--toolbar') || tbMerged.parentElement;

      const collapsibles = Array.from(tbMerged.querySelectorAll('.tp-pill-btn, .tp-dropdown, .tp-pill-sep')).filter(el =>
        el.id !== 'doc-zoom-dd' && el.id !== 'doc-lineheight-dd' && el.id !== 'doc-format-dd'
      );

      if (overflowBtn) {
        if (overflowMenu && overflowMenu.parentElement !== document.body) document.body.appendChild(overflowMenu);
        overflowBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const hidden = overflowMenu.hasAttribute('hidden');
          document.querySelectorAll('.tp-dd-menu').forEach(m => m.setAttribute('hidden', ''));
          if (hidden) { overflowMenu.removeAttribute('hidden'); placeMenuByButton(overflowBtn, overflowMenu, 'right'); }
          else overflowMenu.setAttribute('hidden', '');
        });
      }

      // Лёгкое переполнение: сжатие «Открыть/Сохранить» в иконки делает CSS (плавно) при открытой панели;
      // здесь только прячем в меню кнопки, если после сжатия всё равно не влезло. Пересчёт — редкий (не покадрово).
      let reflowing = false;
      let visibleCount = collapsibles.length;
      function reflow() {
        if (reflowing || !overflowBtnWrap) return;
        reflowing = true;
        
        // Сначала возвращаем всё в исходное состояние (все кнопки на месте, тексты показаны)
        tbMerged.classList.remove('tp-toolbar-narrow');
        while (visibleCount < collapsibles.length) { tbMerged.insertBefore(collapsibles[visibleCount], overflowBtnWrap); visibleCount++; }
        overflowBtnWrap.setAttribute('hidden', '');
        
        // ШАГ 1: Если не влезает, сначала жертвуем текстом на крупных кнопках (превращаем в иконки)
        if (tbMerged.scrollWidth > tbMerged.clientWidth + 1) {
          tbMerged.classList.add('tp-toolbar-narrow');
        }
        
        // ШАГ 2: Если даже после превращения в иконки всё ещё не влезает, начинаем прятать инструменты форматирования
        if (tbMerged.scrollWidth > tbMerged.clientWidth + 1) {
          overflowBtnWrap.removeAttribute('hidden');
          while (visibleCount > 0 && tbMerged.scrollWidth > tbMerged.clientWidth + 1) {
            overflowMenu.insertBefore(collapsibles[visibleCount - 1], overflowMenu.firstChild);
            visibleCount--;
          }
        }
        reflowing = false;
      }

      let rafId = 0;
      const sched = () => { if (rafId) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(reflow); };
      if (rowEl && window.ResizeObserver) new ResizeObserver(sched).observe(rowEl);
      window.addEventListener('resize', sched);
      // при открытии/закрытии дерева пересчитываем ПОСЛЕ анимации сжатия (~0.3с), один раз
      if (layoutEl && window.MutationObserver) {
        new MutationObserver(() => {
          // пересчёт (кнопки в/из меню) — ТОЛЬКО после конца анимации, чтобы не дёргать её посреди хода
          setTimeout(reflow, 480);
        }).observe(layoutEl, { attributes: true, attributeFilter: ['class'] });
      }
      reflow();
      setTimeout(reflow, 200);
    }

    document.addEventListener('mouseup', () => setTimeout(maybeShowSelectionUI, 10));
    document.addEventListener('dblclick', () => setTimeout(maybeShowSelectionUI, 10));

    $$('[data-cmd]').forEach((node) => {
      if (node.classList.contains('tp-dropdown')) return;
      if (node.tagName === 'SELECT') node.onchange = (e) => execCmd(node.dataset.cmd, e.target.value);
      else { node.onclick = (e) => { e.preventDefault(); execCmd(node.dataset.cmd); }; node.onmousedown = (e) => e.preventDefault(); }
    });

    // Custom Dropdowns Logic
    $$('.tp-dropdown').forEach(dd => {
      const btn = dd.querySelector('.tp-dd-btn');
      const menu = dd.querySelector('.tp-dd-menu');
      if (!btn || !menu) return;
      // Prevent focus theft from contenteditable so Selection stays intact
      // (without this, formatBlock/fontName commands apply to nothing)
      btn.onmousedown = (e) => e.preventDefault();
      btn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        $$('.tp-dd-menu').forEach(m => m.hidden = true);
        menu.hidden = !wasHidden;
        if (!menu.hidden) placeMenuByButton(btn, menu, 'left');
      };
      // ВАЖНО: обработчики вешаем ДО переноса, пока меню ещё внутри выпадашки.
      dd.querySelectorAll('.tp-dd-item').forEach(item => {
        item.onmousedown = (e) => e.preventDefault();
        item.onclick = (e) => {
          e.stopPropagation();
          menu.hidden = true;
          ddItems(dd.id).forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          btn.querySelector('span:first-child').textContent = item.textContent;
          if (dd.id === 'doc-zoom-dd') {
            const val = parseFloat(item.dataset.val) || 1;
            tpSetZoom(val);
          } else if (dd.id === 'doc-lineheight-dd') {
            const val = parseFloat(item.dataset.val) || 1.6;
            const doc = document.querySelector('.tp-doc');
            if (doc) {
              doc.style.lineHeight = val;
              doc.style.setProperty('--doc-p-spacing', (val * 0.75) + 'em');
            }
          } else if (dd.dataset.cmd) {
            execCmd(dd.dataset.cmd, item.dataset.val);
          }
        };
      });
      // У панели инструментов включено размытие фона, а такой блок становится точкой отсчёта
      // для «плавающих» элементов и вдобавок обрезает их своим краем. Поэтому меню выселяем
      // в конец страницы: только там координаты считаются от окна и ничто их не режет.
      menu.dataset.owner = dd.id;
      if (menu.parentElement !== document.body) document.body.appendChild(menu);
    });
    
    document.addEventListener('click', (e) => {
      // Меню теперь лежит вне выпадашки, поэтому проверяем и его самого.
      if (!e.target.closest('.tp-dropdown') && !e.target.closest('.tp-dd-menu')) {
        $$('.tp-dd-menu').forEach(m => m.hidden = true);
      }
    });

    // Масштаб через CSS-свойство zoom, а не transform:scale. transform не меняет поток,
    // поэтому у прокручиваемой области не появляется скролл → увеличенная страница вылезает
    // за canvas, и правый край длинных заголовков обрезается без возможности доскроллить.
    // zoom меняет поток: появляется прокрутка, заголовки не «уходят за страницу».
    // Масштабируем .tp-page-wrap (вкладки + страница вместе), чтобы закладка не отрывалась.
    // ЛУПА. Лист остаётся ровно таким же — той же ширины и высоты, на том же месте.
    // Увеличивается только содержимое ВНУТРИ него, вокруг точки под курсором, и ездит
    // прокруткой внутри листа. Строки не перевёрстываются: увеличение делает transform,
    // а он не меняет раскладку. Размер области прокрутки задаёт распорка (tp-zoom-sizer),
    // иначе окно не знало бы, что содержимое стало больше.
    function tpApplyZoom(val, anchor) {
      const page = document.querySelector('.tp-page');
      const view = document.querySelector('.tp-zoom-view');
      const sizer = document.querySelector('.tp-zoom-sizer');
      const inner = document.querySelector('.tp-zoom-inner');
      const wrap = document.querySelector('.tp-page-wrap');
      if (wrap) { wrap.style.zoom = ''; wrap.style.width = ''; wrap.style.maxWidth = ''; } // остатки прежних подходов
      if (!page || !view || !sizer || !inner) return;

      const prevScale = window.tpCurrentZoom || 1;
      // Точка содержимого, которая должна остаться под курсором.
      let keep = null;
      if (anchor && page.classList.contains('is-zoomed')) {
        keep = {
          x: (view.scrollLeft + anchor.x) / prevScale,
          y: (view.scrollTop + anchor.y) / prevScale,
          px: anchor.x, py: anchor.y,
        };
      }

      // Сброс режима лупы (нужен и при 100%, и при уменьшении).
      const resetMagnifier = () => {
        window.tpZoomBase = null;
        page.classList.remove('is-zoomed');
        page.style.padding = '';
        view.style.height = ''; view.style.width = '';
        sizer.style.width = ''; sizer.style.height = '';
        inner.style.transform = ''; inner.style.width = '';
      };

      // Вкладки — «шапка» листа, поэтому при уменьшении они должны мельчать вместе с ним,
      // иначе широкая полоса вкладок висит над узкой страницей.
      const tabsBar = document.querySelector('#doc-tabs-container');
      const setTabsScale = (v) => { if (tabsBar) tabsBar.style.zoom = v < 1 ? String(v) : ''; };

      if (Math.abs(val - 1) < 0.001) {
        resetMagnifier();
        if (wrap) wrap.style.zoom = '';
        setTabsScale(1);
        return;
      }

      // МЕНЬШЕ 100% — уменьшается сам лист, как в Word: страница становится мельче и целиком
      // помещается на экран, а интерфейс остаётся прежнего размера. Лупа тут не при чём:
      // разглядывать нечего, наоборот — нужен общий вид.
      if (val < 1) {
        resetMagnifier();
        if (wrap) wrap.style.zoom = String(val);
        setTabsScale(val);
        return;
      }
      if (wrap) wrap.style.zoom = '';
      setTabsScale(1);

      // «Родные» размеры содержимого при 100%. Мерить их на каждом щелчке колеса нельзя:
      // браузер пересчитывает раскладку всего документа дважды за кадр — отсюда рывки.
      // Меряем один раз и запоминаем; сбрасываем при смене документа, режима, размера окна
      // и после правок текста.
      if (!window.tpZoomBase) {
        inner.style.transform = ''; inner.style.width = '';
        sizer.style.width = ''; sizer.style.height = '';
        view.style.height = ''; view.style.width = '';
        page.style.padding = '';
        page.classList.remove('is-zoomed');
        const r = inner.getBoundingClientRect();
        const cs = getComputedStyle(page);
        window.tpZoomBase = {
          w: Math.round(r.width), h: Math.round(r.height),
          padX: parseFloat(cs.paddingLeft) || 0, padY: parseFloat(cs.paddingTop) || 0,
        };
      }
      const baseW = window.tpZoomBase.w, baseH = window.tpZoomBase.h;
      const padX0 = window.tpZoomBase.padX, padY0 = window.tpZoomBase.padY;
      if (!baseW || !baseH) { window.tpZoomBase = null; return; }

      // Поля листа мягко убираются по мере увеличения: при 100% они полные, к 200% сходят
      // на нет. Иначе крупный текст читается «внутри рамки» — белая кайма съедает место,
      // которого при увеличении и так не хватает.
      const k = Math.max(0, Math.min(1, 2 - val));
      const padX = Math.round(padX0 * k), padY = Math.round(padY0 * k);
      page.style.padding = padY + 'px ' + padX + 'px';

      // Окно растёт ровно на столько, на сколько ушли поля, — то есть максимум до размера
      // самого листа. Сам лист при этом не меняется ни на пиксель.
      page.classList.add('is-zoomed');
      view.style.width = Math.round(baseW + 2 * (padX0 - padX)) + 'px';
      view.style.height = Math.round(baseH + 2 * (padY0 - padY)) + 'px';
      sizer.style.width = Math.round(baseW * val) + 'px';
      sizer.style.height = Math.round(baseH * val) + 'px';
      inner.style.width = baseW + 'px';
      inner.style.transform = 'scale(' + val + ')';

      // Возвращаем под курсор ту же точку содержимого.
      if (keep) {
        view.scrollLeft = Math.max(0, keep.x * val - keep.px);
        view.scrollTop = Math.max(0, keep.y * val - keep.py);
      } else if (anchor) {
        view.scrollLeft = Math.max(0, anchor.x * val - anchor.x);
        view.scrollTop = Math.max(0, anchor.y * val - anchor.y);
      }
    }

    // Применить масштаб и синхронизировать подпись в выпадашке «100%».
    let zoomPending = window.tpCurrentZoom || 1; // накопитель для колеса, см. ниже
    function tpSetZoom(val, anchor) {
      const next = Math.max(0.25, Math.min(val, 3.0));
      tpApplyZoom(next, anchor);      // считает от прежнего масштаба, поэтому вызывается ДО его смены
      window.tpCurrentZoom = next;
      zoomPending = next;             // выбор из списка сбивает накопитель колеса
      const zoomBtn = document.querySelector('#doc-zoom-dd .tp-dd-btn span:first-child');
      if (zoomBtn) zoomBtn.textContent = Math.round(window.tpCurrentZoom * 100) + '%';
      ddItems('doc-zoom-dd').forEach((i) => {
        i.classList.toggle('active', Math.abs(parseFloat(i.dataset.val) - window.tpCurrentZoom) < 0.001);
      });
    }
    tpSetZoomRef = tpSetZoom;

    // Панель убрали — места стало больше. Раньше здесь увеличивался масштаб; теперь честнее
    // просто расширить сам лист: строка становится длиннее, размер текста не меняется.
    function tpFitPageToWidth(wide) {
      const canvas = document.querySelector('.tp-canvas');
      if (!canvas) return;
      if (!wide) { canvas.style.removeProperty('--tp-page-max'); return; }
      const avail = Math.max(600, canvas.clientWidth - 24);
      canvas.style.setProperty('--tp-page-max', Math.round(Math.min(avail, 1400)) + 'px');
    }
    tpFitZoomRef = tpFitPageToWidth;

    // Масштаб колесом с Ctrl / щипком на тачпаде.
    window.tpCurrentZoom = window.tpCurrentZoom || 1;
    const workspace = document.querySelector('.tp-workspace');
    if (workspace) {
      let zoomRaf = 0, zoomAnchor = null;
      workspace.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        // Точка под курсором в координатах окна-листа: именно она должна остаться на месте.
        const view = document.querySelector('.tp-zoom-view');
        if (view) {
          const r = view.getBoundingClientRect();
          zoomAnchor = { x: e.clientX - r.left, y: e.clientY - r.top };
        }
        // Колесо и тачпад присылают события пачками, а смена масштаба перекладывает весь
        // документ заново. Копим дельту и перерисовываем один раз на кадр — иначе «кисель».
        zoomPending = Math.max(0.25, Math.min(zoomPending - e.deltaY * 0.01, 3.0));
        if (zoomRaf) return;
        zoomRaf = requestAnimationFrame(() => {
          zoomRaf = 0;
          // Мягкий магнит на 100%: рядом со стом процентами показываем ровно 100 и держим,
          // пока колесо не «переедет» зону притяжения. Так легко вернуться к исходному виду
          // и не получить случайные 98 или 103 процента.
          const SNAP = 0.06;
          const raw = zoomPending;                       // накопитель колеса — «настоящее» значение
          const shown = Math.abs(raw - 1) < SNAP ? 1 : raw;
          tpSetZoom(shown, zoomAnchor);
          zoomPending = raw;                             // иначе из зоны притяжения не выехать
        });
      }, { passive: false });
    }

    $$('[data-color]').forEach((node) => {
      node.onclick = (e) => { e.preventDefault(); execCmd('foreColor', node.dataset.color); };
      node.onmousedown = (e) => e.preventDefault();
    });
    const colorPicker = $('#doc-color-picker');
    if (colorPicker) colorPicker.oninput = (e) => execCmd('foreColor', e.target.value);

    $('#doc-undo-btn').onclick = () => { getActiveEditor().focus(); document.execCommand('undo'); };
    $('#doc-redo-btn').onclick = () => { getActiveEditor().focus(); document.execCommand('redo'); };

    renderModels();
    renderMode();
    renderAttach();
    updateCtxHint();
    watchCanvasScroll();
    renderRoles();
    renderSymbols();
    refreshAgentStatus();
    setTimeout(renderScrubber, 400); // документ восстанавливается асинхронно — досчитываем содержание

    const fi = $('#doc-formula-input');
    fi.oninput = renderFormulaCardPreview;
    $('#doc-formula-blockmode').onchange = renderFormulaCardPreview;
    $('#doc-formula-insert').onclick = insertFormulaFromCard;
    renderFormulaCardPreview(); // в поле лежит формула по умолчанию — показываем её сразу, без первого клика

    $('#doc-open-btn').onclick = openFile;
    $('#doc-save-btn').onclick = saveFile;
    if (window.lite.app.onSaveAs) {
      window.lite.app.onSaveAs(() => saveFileAs());
    }
    if (window.lite.app.onExportDocx) {
      window.lite.app.onExportDocx(async () => {
        if (!lite.tp.exportDocx) { toast('Экспорт недоступен', { kind: 'err' }); return; }
        toast('Экспорт начат...');
        const r = await lite.tp.exportDocx({ content: currentMarkdown(), name: currentName });
        if (!r || r.canceled) return;
        if (!r.ok) { toast(r.error || 'Ошибка экспорта', { kind: 'err' }); return; }
        toast('Экспортировано в ' + r.name);
      });
    }
    // Файл → Новый файл (Cmd/Ctrl+N) из системного меню.
    if (window.lite.app.onNewFile) window.lite.app.onNewFile(() => createNewTab());
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    });

    $('#doc-ai-chat-send').onclick = sendChat;
    const attachBtn = $('#doc-ai-attach');
    if (attachBtn) attachBtn.onclick = () => {
      attachDoc = !attachDoc; settings.tpAttachDoc = attachDoc; saveSettings();
      renderAttach(); updateCtxHint();
    };
    $('#doc-ai-chat-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };

    $('#doc-editor-wysiwyg').addEventListener('input', markDirty);
    $('#doc-editor-wysiwyg').addEventListener('input', scheduleScrubberUpdate);
    $('#doc-editor-wysiwyg').addEventListener('input', updateDocPlaceholder);
    
    // Smart Paste: перехват вставки для формул из нейросетей
    $('#doc-editor-wysiwyg').addEventListener('paste', (e) => {
      const plain = e.clipboardData.getData('text/plain');
      if (!plain) return;
      
      const { blocks, inlines } = extractFormulas(plain);
      if (blocks.length > 0 || inlines.length > 0) {
        const htmlData = e.clipboardData.getData('text/html') || '';
        // Если это ответ ИИ (есть классы katex/math) ИЛИ явно используются LaTeX скобки
        const isAI = htmlData.includes('katex') || htmlData.includes('math') || htmlData.includes('mjx');
        const usesExplicitLatex = blocks.length > 0 || plain.includes('\\(') || plain.includes('\\[');
        
        if (!htmlData || usesExplicitLatex || isAI) {
          e.preventDefault();
          const html = mdToHtml(plain);
          document.execCommand('insertHTML', false, html);
          markDirty();
          updateDocPlaceholder();
        }
      }
    });

    $('#doc-editor-md').addEventListener('input', markDirty);
    $('#doc-editor-md').addEventListener('input', updateDocPlaceholder);
    // Когда окно снова становится активным, а документ пуст и фокус ни на чём (не в чате) —
    // возвращаем курсор в редактор, чтобы он мигал (частая проблема после запуска приложения).
    window.addEventListener('focus', () => {
      const ed = $('#doc-editor-wysiwyg');
      if (docOpen && ed && !ed.hidden && !ed.textContent.trim()) {
        const ae = document.activeElement;
        if (!ae || ae === document.body || ae === ed) focusDocEditor();
      }
    });

    // Рейка живёт поверх страницы: при изменении размера окна пересчитываем её координаты.
    window.addEventListener('resize', () => { placeTocRail(); hideTocList(true); });
    const tocRailEl = $('#doc-toc-rail');
    const tocListEl = $('#doc-toc-list');
    if (tocRailEl) {
      // Достаточно навести на полосу вообще: берём ближайшую к курсору чёрточку.
      // Требовать попадания точно в засечку — слишком строго, промахнуться легко.
      const openNearest = (e) => {
        if (!tocMarks.length) return;
        let best = null, bestD = Infinity;
        tocMarks.forEach((t) => {
          const r = t.row.getBoundingClientRect();
          const d = Math.abs(r.top + r.height / 2 - e.clientY);
          if (d < bestD) { bestD = d; best = t.row; }
        });
        if (best) showTocList(best);
      };
      tocRailEl.addEventListener('mouseenter', openNearest);
      tocRailEl.addEventListener('mousemove', (e) => { if (!$('#doc-toc-list').classList.contains('visible')) openNearest(e); });
      tocRailEl.addEventListener('mouseleave', () => hideTocList());
    }
    if (tocListEl) {
      tocListEl.addEventListener('mouseenter', () => clearTimeout(tocHideTimer));
      tocListEl.addEventListener('mouseleave', () => hideTocList());
    }

    $('#doc-editor-wysiwyg').addEventListener('click', (e) => {
      const btn = e.target.closest('.tp-formula-toggle');
      if (btn) { e.preventDefault(); btn.parentElement.classList.toggle('show-src'); }
    });

    applyCardOrder();
    setupCardsDnD();
    updateModeUI();
    setTab('ai');
    updateStatus('Новый файл');
    renderChatLog();
  }

  // ---- Drag-and-drop порядка карточек (персистится в settings) ----
  function applyCardOrder() {
    const order = Array.isArray(settings.tpCardOrder) && settings.tpCardOrder.length ? settings.tpCardOrder : ['format', 'formula'];
    order.forEach((id, i) => { const c = $(`.tp-card[data-drop="${id}"]`); if (c) c.style.order = i; });
  }
  function setupCardsDnD() {
    let dragId = null;
    $$('.tp-card').forEach((card) => {
      const head = card.querySelector('.tp-card-head[draggable="true"]');
      if (!head) return;
      
      head.ondragstart = (e) => {
        dragId = head.dataset.dragId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
        card.classList.add('dragging');
        if (e.dataTransfer.setDragImage) {
          e.dataTransfer.setDragImage(card, 20, 20); // Snapshot of the actual card!
        }
      };
      
      head.ondragend = () => { 
        dragId = null; 
        $$('.tp-card').forEach((c) => c.classList.remove('dragging', 'drag-over')); 
      };
      
      card.ondragover = (e) => { 
        e.preventDefault(); 
        e.dataTransfer.dropEffect = 'move'; 
        if (dragId && card.dataset.drop !== dragId) card.classList.add('drag-over'); 
      };
      
      card.ondragleave = (e) => { 
        if (!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); 
      };
      
      card.ondrop = (e) => {
        e.preventDefault(); 
        card.classList.remove('drag-over');
        const dropId = card.dataset.drop;
        if (!dragId || dragId === dropId) return;
        
        let order = (Array.isArray(settings.tpCardOrder) && settings.tpCardOrder.length) 
          ? [...settings.tpCardOrder] 
          : $$('.tp-card').map((c) => c.dataset.drop);
          
        const from = order.indexOf(dragId), to = order.indexOf(dropId);
        if (from > -1 && to > -1) {
          order.splice(to, 0, order.splice(from, 1)[0]);
          settings.tpCardOrder = order; 
          saveSettings();
          applyCardOrder();
        }
      };
    });
  }

  // ---- режимы/вкладки ----
  function setMode(m) {
    if (m === mode) return;
    if (m === 'markdown') { const md = htmlToMd($('#doc-editor-wysiwyg')); $('#doc-editor-md').textContent = md; }
    else { $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(mdToHtml($('#doc-editor-md').textContent), { ADD_ATTR: ['contenteditable', 'data-tex'] }); }
    mode = m;
    updateModeUI();
  }
  function updateModeUI() {
    let activeBtn = null;
    $$('.tp-seg-btn[data-mode]').forEach((b) => {
      const isActive = b.dataset.mode === mode;
      b.classList.toggle('active', isActive);
      if (isActive) activeBtn = b;
    });
    updateThumb($('#doc-mode-toggle'), activeBtn);
    window.tpZoomBase = null; // содержимое сменилось — прежний замер для лупы недействителен
    $('#doc-editor-wysiwyg').hidden = mode !== 'wysiwyg';
    $('#doc-editor-md').hidden = mode !== 'markdown';
    renderScrubber();
    updateDocPlaceholder();
  }
  // Показывать приглашение (tp-doc-empty), когда документ фактически пуст — учитываем не только
  // текст, но и картинки/формулы/таблицы, чтобы плейсхолдер не «просвечивал» сквозь медиа.
  function updateDocPlaceholder() {
    const w = $('#doc-editor-wysiwyg');
    if (w) {
      const empty = !w.textContent.trim() && !w.querySelector('img, table, hr, [data-tex], .tp-formula-block');
      w.classList.toggle('tp-doc-empty', empty);
    }
    const m = $('#doc-editor-md');
    if (m) m.classList.toggle('tp-doc-empty', !m.textContent.trim());
  }
  function setTab(t) {
    let activeBtn = null;
    $$('.tp-tab[data-tab]').forEach((b) => {
      const isActive = b.dataset.tab === t;
      b.classList.toggle('active', isActive);
      if (isActive) activeBtn = b;
    });
    updateThumb($('#doc-inspector-tabs'), activeBtn);
    $('#doc-panel-edit').hidden = t !== 'edit';
    $('#doc-panel-ai').hidden = t !== 'ai';
    // Карточка «Формула» скрыта через hidden: KaTeX в скрытом блоке рисуется вхолостую,
    // поэтому предпросмотр обновляем в момент открытия вкладки.
    if (t === 'edit') renderFormulaCardPreview();
  }

  function updateToolbarState() {
    if (mode !== 'wysiwyg') return;
    try {
      $$('.tp-toolbar-merged [data-cmd]').forEach(btn => {
        if (btn.classList.contains('tp-dropdown')) return;
        let active = false;
        try { active = document.queryCommandState(btn.dataset.cmd); } catch (_) {}
        btn.classList.toggle('active', active);
      });
      let format = '';
      try { format = document.queryCommandValue('formatBlock'); } catch (_) {}
      const formatDd = $('#doc-format-dd');
      if (formatDd) {
        let matched = false;
        ddItems('doc-format-dd').forEach(item => {
          const val = item.dataset.val.replace(/[<>]/g, '').toLowerCase();
          const fmt = (format || 'p').replace(/[<>]/g, '').toLowerCase();
          const isActive = (val === fmt || (val === 'p' && (fmt === '' || fmt === 'div')));
          item.classList.toggle('active', isActive);
          if (isActive) {
            formatDd.querySelector('.tp-dd-btn span:first-child').textContent = item.textContent;
            matched = true;
          }
        });
        if (!matched) {
          formatDd.querySelector('.tp-dd-btn span:first-child').textContent = 'Обычный';
          const pItem = formatDd.querySelector('[data-val="<p>"]');
          if (pItem) pItem.classList.add('active');
        }
      }
    } catch (e) {}
  }

  function execCmd(cmd, val = null) {
    if (cmd === 'toggleColumns') {
      const s = window.getSelection();
      if (!s.rangeCount) return;
      const text = s.toString(); // Selection.toString() = plain text → экранируем перед insertHTML
      if (text) document.execCommand('insertHTML', false, `<div class="tp-columns">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`);
      return markDirty();
    }
    if (cmd === 'insertTable') {
      document.execCommand('insertHTML', false, '<table class="tp-table"><tbody><tr><td>Ячейка 1</td><td>Ячейка 2</td></tr><tr><td>Ячейка 3</td><td>Ячейка 4</td></tr></tbody></table><br>');
      return markDirty();
    }
    if (cmd === 'toggleNumbers') {
      if (mode === 'markdown' && window.cm) {
        cm.setOption('lineNumbers', !cm.getOption('lineNumbers'));
      } else {
        document.execCommand('insertOrderedList');
      }
      return markDirty();
    }

    try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
    getActiveEditor().focus();
    document.execCommand(cmd, false, val);
    updateToolbarState();
    markDirty();
  }

  // ---- Открыть/Сохранить (нативные диалоги через IPC — см. AI_CONTEXT.md, «подводный камень» №2) ----
  async function openFile() {
    if (!lite.tp.openFile) { toast('Нативный диалог недоступен', { kind: 'err' }); return; }
    const res = await lite.tp.openFile();
    if (!res || res.canceled) return;
    if (!res.ok) { toast(res.error || 'Не удалось открыть файл', { kind: 'err' }); return; }
    
    // Check if openProjectFile exists (we will inject it shortly), else fallback
    if (typeof openProjectFile === 'function') {
      openProjectFile(res.file);
    } else {
      currentFile = res.file; currentName = res.name;
      const isHtml = /\.html?$/i.test(res.name);
      loadDocument(isHtml ? res.content : mdToHtml(res.content));
      updateStatus('Открыт');
      toast('Файл открыт: ' + res.name);
    }
  }
  async function saveFile() {
    if (!currentFile) return saveFileAs();
    const isHtml = /\.html?$/i.test(currentFile);
    const content = isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown();
    const r = await lite.fs.writeFile(currentFile, content);
    if (r && !r.error) {
      dirty = false;
      if (typeof saveCurrentTabState === 'function') {
        saveCurrentTabState();
        if (typeof renderTabsUI === 'function') renderTabsUI();
      }
      updateStatus('Сохранено · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
      toast('Файл сохранён');
      return true;
    }
    toast('Ошибка сохранения: ' + (r && r.error), { kind: 'err' });
    return false;
  }
  async function saveFileAs() {
    if (!lite.tp.saveFileAs) { toast('Нативный диалог недоступен', { kind: 'err' }); return false; }
    const r = await lite.tp.saveFileAs({ content: currentMarkdown(), name: currentName, ext: 'md' });
    if (!r || r.canceled) return false;
    if (!r.ok) { toast(r.error || 'Не удалось сохранить файл', { kind: 'err' }); return false; }
    currentFile = r.file; currentName = r.name; dirty = false;
    if (typeof saveCurrentTabState === 'function') {
        const tab = openTabs.find(t => t.id === activeTabId);
        if (tab) { tab.absPath = r.file; tab.name = r.name; }
        saveCurrentTabState();
        if (typeof renderTabsUI === 'function') renderTabsUI();
    }
    updateStatus('Сохранено · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    toast('Файл сохранён');
    return true;
  }

  // ---- Автосейв (Obsidian-style): вкладка с файлом пишется на диск через 1.5с тишины ----
  // Безымянные вкладки автосейва не имеют (некуда писать) — их защищает confirm при закрытии.
  let autosaveT = null;
  function scheduleAutosave() {
    if (!currentFile) return;
    clearTimeout(autosaveT);
    autosaveT = setTimeout(async () => {
      if (!currentFile || !dirty) return;
      const isHtml = /\.html?$/i.test(currentFile);
      const content = isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown();
      const r = await lite.fs.writeFile(currentFile, content);
      if (r && !r.error) {
        dirty = false;
        saveCurrentTabState(); renderTabsUI();
        updateStatus('Автосохранено · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
      }
    }, 1500);
  }
  // Сохранить произвольную вкладку (в т.ч. фоновую) — для confirm'ов закрытия.
  async function saveTabToDisk(tab) {
    if (!tab.absPath) {
      if (tab.id !== activeTabId) switchToTab(tab.id); // saveFileAs работает с активным контентом
      return await saveFileAs();
    }
    const isHtml = /\.html?$/i.test(tab.absPath);
    let content;
    if (tab.id === activeTabId) content = isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown();
    else if (isHtml) content = htmlDocWrap(tab.html);
    else if (tab.mode === 'markdown') content = tab.md;
    else { const d = document.createElement('div'); d.innerHTML = tab.html; content = htmlToMd(d); } // wysiwyg-снапшот → md
    const r = await lite.fs.writeFile(tab.absPath, content);
    if (r && r.error) { toast('Ошибка сохранения: ' + r.error, { kind: 'err' }); return false; }
    tab.dirty = false;
    if (tab.id === activeTabId) dirty = false;
    renderTabsUI();
    return true;
  }

  // ---- Формула (карточка инспектора: локальный KaTeX, инлайн/блок с нумерацией) ----
  function renderFormulaCardPreview() {
    const ta = $('#doc-formula-input');
    const pv = $('#doc-formula-preview');
    const isBlock = $('#doc-formula-blockmode').checked;
    try { pv.innerHTML = katex.renderToString(ta.value || '', { throwOnError: false, displayMode: isBlock }); }
    catch (_) { pv.textContent = 'Ошибка в формуле'; }
  }
  function insertSymbol(tex) {
    const ta = $('#doc-formula-input');
    const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
    ta.value = v.slice(0, s) + tex + v.slice(en);
    let caret = s + tex.length;
    const b = tex.indexOf('{}');
    if (b >= 0) caret = s + b + 1;
    ta.focus(); ta.setSelectionRange(caret, caret);
    renderFormulaCardPreview();
  }
  function insertFormulaFromCard() {
    const tex = ($('#doc-formula-input').value || '').trim();
    if (!tex) return;
    const isBlock = $('#doc-formula-blockmode').checked;
    if (mode === 'markdown') {
      $('#doc-editor-md').focus();
      document.execCommand('insertText', false, isBlock ? ('\n\n$$' + tex + '$$\n\n') : (' $' + tex + '$ '));
    } else {
      const ed = $('#doc-editor-wysiwyg');
      ed.focus();
      if (isBlock) {
        const num = ed.querySelectorAll('.tp-formula-block').length + 1;
        document.execCommand('insertHTML', false, formulaBlockHtml(tex, String(num)) + '<p><br></p>');
      } else {
        document.execCommand('insertHTML', false, formulaInlineHtml(tex) + '&nbsp;');
      }
    }
    markDirty();
    updateStatus('Формула вставлена');
  }

  // ---- AI Chat (реальный агент через lite.tp.run → main.js спавнит claude/codex CLI) ----
  // Скрепка снята — контекст не шлём вовсе; нажата — шлём документ целиком.
  // Точечная работа с абзацем идёт через всплывающую панель у выделения, а не через чат.
  function selForChat() {
    if (!attachDoc) return { text: '', whole: false, none: true };
    return { text: currentMarkdown(), whole: true };
  }
  // Кнопка-скрепка у поля ввода: включает/выключает передачу документа.
  function renderAttach() {
    const btn = $('#doc-ai-attach');
    if (!btn) return;
    btn.classList.toggle('active', attachDoc);
    btn.title = attachDoc
      ? 'Документ приложен — снимите, чтобы просто поговорить'
      : 'Документ не приложен — нажмите, чтобы приложить';
  }
  function renderChatLog() {
    const box = $('#doc-ai-chat-log');
    box.innerHTML = '';
    chatLog.forEach((m) => {
      const w = el('div', 'tp-msg ' + m.role);
      if (m.reqId) w.dataset.req = m.reqId; // якорь для in-place стриминга (tp:data)
      const b = el('div', 'tp-bubble');
      // Ответ агента прогоняем через тот же конвейер, что и документ (Markdown + KaTeX), иначе
      // формулы висят в чате сырым текстом вида $\frac{a}{b}$. Во время стрима — обычный текст:
      // рендерить недописанную формулу бессмысленно, KaTeX ругался бы на каждый чанк.
      if (m.role === 'agent' && !m.busy && m.text) {
        b.classList.add('tp-bubble-rich');
        b.innerHTML = DOMPurify.sanitize(mdToHtml(m.text), { ADD_ATTR: ['contenteditable', 'data-tex'] });
      } else {
        b.textContent = m.busy ? (m.text + ' ⏳') : m.text;
      }
      // Отказ по авторизации: команду входа даём кнопкой, чтобы не набирать руками.
      if (m.loginCmd) {
        w.classList.add('tp-msg-auth');
        const acts = el('div', 'tp-bubble-actions');
        const copyBtn = el('button', 'tp-bubble-replace', 'Скопировать «' + m.loginCmd + '»');
        copyBtn.type = 'button';
        copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(m.loginCmd); toast('Команда скопирована — вставьте её в терминал'); }
          catch (_) { toast('Не удалось скопировать', { kind: 'err' }); }
        };
        acts.appendChild(copyBtn);
        b.appendChild(acts);
      }
      if (m.role === 'agent' && !m.busy && !m.noReplace) {
        const acts = el('div', 'tp-bubble-actions');
        const replaceBtn = el('button', 'tp-bubble-replace', 'Заменить');
        replaceBtn.type = 'button';
        replaceBtn.onclick = () => {
          if (mode === 'markdown') { $('#doc-editor-md').focus(); document.execCommand('insertText', false, m.text); }
          else { $('#doc-editor-wysiwyg').focus(); document.execCommand('insertHTML', false, mdToHtml(m.text)); }
          markDirty();
          updateStatus('Текст заменён');
        };
        acts.appendChild(replaceBtn);
        b.appendChild(acts);
      }
      w.appendChild(b);
      box.appendChild(w);
    });
    box.scrollTop = box.scrollHeight;
  }
  // Стрим-чанк: правим текст пузыря на месте (пересборка чата на каждый чанк сбрасывала бы скролл
  // и мигала DOM); к низу липнем, только если читатель и так внизу.
  function updateStreamBubble(am) {
    const box = $('#doc-ai-chat-log');
    const b = box && box.querySelector(`[data-req="${am.reqId}"] .tp-bubble`);
    if (!b) { renderChatLog(); return; }
    b.textContent = am.text + (am.busy ? ' ⏳' : '');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  // Памятка о нумерации абзацев: нужна обоим режимам — пользователь может попросить
  // «перепиши абзац 7», а номера в редакторе считаются не так, как их посчитал бы агент.
  const NUMBERING_NOTE = 'Важно: визуальные номера абзацев в редакторе присваиваются ТОЛЬКО обычным текстовым абзацам. Заголовки (###), блоки кода (```) и формулы ($$) пропускаются и НЕ нумеруются. Если пользователь просит отредактировать конкретный абзац по номеру, считай только обычный текст!';
  async function composePrompt(sel, instruction) {
    const parts = [];
    if (chatRole !== 'Без роли' && activeProj) {
      // fs:readFile резолвится {content}|{error} и не реджектится — в промпт идёт СОДЕРЖИМОЕ, не объект
      try {
        const r = await lite.fs.readFile(`${activeProj.path}/Roles/${chatRole}.md`);
        parts.push(`Действуй в роли: ${chatRole}` + (r && r.content != null ? `\n${r.content}` : ''));
      } catch (e) {
        parts.push(`Действуй в роли: ${chatRole}`);
      }
    } else if (chatRole !== 'Без роли') {
      parts.push(`Действуй в роли: ${chatRole}`);
    }
    
    if (effMode() === 'agent') {
      parts.push(`Отредактируй файл: ${currentFile || 'текущий файл'}`);
      parts.push(`Инструкция: ${instruction}`);
      if (!sel.whole && !sel.none) {
        parts.push('Ограничься редактированием только этого фрагмента:\n===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
      }
      if (sel.whole) parts.push(NUMBERING_NOTE);
      return parts.join('\n\n');
    }

    // Скрепка снята — это обычный разговор: ни документа, ни требования «верни только текст».
    if (sel.none) {
      parts.push(instruction);
      return parts.join('\n\n');
    }

    parts.push(instruction);
    // Режим «Ассистент» — это разговор: модель отвечает репликой, документ не переписывает.
    // Раньше здесь стояло «верни ТОЛЬКО итоговый текст», и на любую фразу в чат падал весь документ.
    // Правкой текста занимается режим «Агент» (он редактирует файл на диске).
    parts.push(
      'Ниже приложен ' + (sel.whole ? 'документ пользователя (Markdown)' : 'фрагмент текста') + ' — это контекст для ответа.\n' +
      'Отвечай обычной репликой, по существу и кратко. НЕ выводи документ целиком и не пересказывай его, ' +
      'если об этом не попросили прямо. Если просят показать конкретную правку — покажи только изменённый кусок.'
    );
    if (sel.whole) {
      parts.push(NUMBERING_NOTE);
    }
    parts.push('===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
    return parts.join('\n\n');
  }
  async function sendChat() {
    const ta = $('#doc-ai-chat-input');
    const instruction = ta.value.trim();
    if (!instruction) return;
    const sel = selForChat();
    ta.value = '';
    chatLog.push({ role: 'user', text: instruction });
    // Без приложенного документа ответ — реплика в разговоре, вставлять её в текст незачем.
    const am = { role: 'agent', text: '', busy: true, noReplace: sel.none, reqId: 'tpq' + (++aiSeq) };
    chatLog.push(am);
    while (chatLog.length > 200) chatLog.shift(); // кап истории: чат не растёт бесконечно
    renderChatLog();
    const offData = lite.tp.onData(({ reqId: r, chunk }) => { if (r !== am.reqId) return; am.text += chunk; updateStreamBubble(am); });
    const offDone = lite.tp.onDone(({ reqId: r, text }) => { 
      if (r !== am.reqId) return; 
      am.busy = false; 
      
      if (effMode() === 'agent') {
        const label = chatAgent === 'antigravity' ? 'Antigravity' : 'Агент';
        am.text = label + " выполнил инструкцию. Обновляю документ с диска…";
        am.noReplace = true; // агент правит файл сам — вставлять статус в документ незачем
        cleanup(); renderChatLog();
        reloadCurrentFile(); // агент правит файл на диске → подтягиваем изменения в редактор
        return;
      }

      am.text = text || '';
      cleanup(); renderChatLog();
    });
    const offErr = lite.tp.onError(({ reqId: r, error, authRequired, loginCmd }) => {
      if (r !== am.reqId) return;
      am.busy = false;
      am.noReplace = true;      // текст ошибки нечего вставлять в документ
      am.text = String(error);
      am.loginCmd = authRequired ? loginCmd : null; // → в пузыре появится кнопка с командой входа
      if (authRequired) refreshAgentStatus();         // и подсказка над чатом тоже обновится
      cleanup(); renderChatLog();
    });
    const cleanup = () => { try { offData(); offDone(); offErr(); } catch (_) {} };
    
    const prompt = await composePrompt(sel, instruction);

    // В агент-режиме агент правит файл на диске — сначала сбрасываем несохранённые правки.
    if (effMode() === 'agent' && currentFile && dirty) {
      await saveFile();
    }

    lite.tp.run({
      reqId: am.reqId,
      model: chatAgent,
      mode: effMode(),
      prompt,
      cwd: activeProj ? activeProj.path : null,
      file: currentFile || null
    });
  }
  // ---- Готовность агента: установлен ли CLI и выполнен ли вход ----------------------------
  // Проверка идёт по файлам с кредами (см. main.js) — это подсказка, а не запрет: отправить
  // запрос всё равно можно, а точную причину отказа мы разберём из ответа агента.
  const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
  let agentStatus = null;
  async function refreshAgentStatus() {
    try { agentStatus = await lite.tp.agentStatus(); } catch (_) { agentStatus = null; }
    renderAgentStatus();
  }
  function renderAgentStatus() {
    const box = $('#doc-ai-agent-status');
    if (!box) return;
    const st = agentStatus && agentStatus[chatAgent];
    box.innerHTML = '';
    if (!st || (st.installed && st.loggedIn)) { box.hidden = true; return; }
    box.hidden = false;
    const label = AGENT_LABELS[chatAgent] || chatAgent;
    if (!st.installed) {
      box.appendChild(el('div', 'tp-agent-status-text',
        `Утилита «${st.cmd}» не найдена на компьютере — модель ${label} работать не будет. Установите её и откройте панель заново.`));
      return;
    }
    const how = chatAgent === 'claude'
      ? `Запустите в терминале «${st.loginCmd}» и внутри наберите /login.`
      : `Выполните в терминале: ${st.loginCmd}`;
    box.appendChild(el('div', 'tp-agent-status-text', `Похоже, вход в ${label} не выполнен. ${how}`));
    const row = el('div', 'tp-agent-status-actions');
    const send = el('button', 'tp-btn tp-btn-accent', 'Вставить команду в терминал');
    send.onclick = () => {
      try { host.sendToTerminal(st.loginCmd); toast('Команда отправлена в терминал главного окна'); }
      catch (_) { toast('Не удалось открыть терминал', { kind: 'err' }); }
    };
    const copy = el('button', 'tp-btn', 'Скопировать');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(st.loginCmd); toast('Команда скопирована'); } catch (_) {}
    };
    const again = el('button', 'tp-btn', 'Проверить снова');
    again.onclick = () => refreshAgentStatus();
    row.append(send, copy, again);
    box.appendChild(row);
  }

  function renderModels() {
    const box = $('#doc-ai-models');
    // в разметке уже лежит .tp-seg-thumb → children.length===0 не срабатывало никогда, кнопки моделей не строились
    if (!box.querySelector('.tp-seg-btn')) {
      box.innerHTML = '<span class="tp-seg-thumb"></span>';
      [['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity']].forEach(([id, lbl]) => {
        const btn = el('button', 'tp-seg-btn', lbl);
        btn.type = 'button';
        btn.title = 'Модель ' + lbl;
        btn.dataset.id = id;
        btn.onclick = () => { chatAgent = id; settings.tpAgent = id; saveSettings(); renderModels(); renderMode(); renderAgentStatus(); };
        box.appendChild(btn);
      });
    }

    let activeBtn = null;
    box.querySelectorAll('.tp-seg-btn').forEach(btn => {
      const isActive = chatAgent === btn.dataset.id;
      btn.className = 'tp-seg-btn' + (isActive ? ' active' : '');
      if (isActive) activeBtn = btn;
    });

    // Need a tiny delay for layout to calculate offsetWidth if first time rendering
    requestAnimationFrame(() => updateThumb(box, activeBtn));
  }
  // Тумблер режима: Ассистент (чат) / Агент (правит файл). Доступен для всех моделей.
  function renderMode() {
    const box = $('#doc-ai-mode');
    if (!box) return;
    if (!box.querySelector('.tp-seg-btn')) {
      box.innerHTML = '<span class="tp-seg-thumb"></span>';
      [['chat', 'Ассистент', 'Возвращает текст в чат — вставляешь кнопкой «Заменить». Точечно, с просмотром.'],
       ['agent', 'Агент', 'Автономно правит файл целиком и сохраняет. Для объёмных задач по всему документу.']].forEach(([id, lbl, tip]) => {
        const btn = el('button', 'tp-seg-btn', lbl);
        btn.type = 'button';
        btn.title = tip;
        btn.dataset.mode = id;
        btn.onclick = () => {
          chatMode = id; settings.tpMode = id; saveSettings(); renderMode();
        };
        box.appendChild(btn);
      });
    }
    const shown = effMode();
    let activeBtn = null;
    box.querySelectorAll('.tp-seg-btn').forEach(btn => {
      const isActive = shown === btn.dataset.mode;
      btn.className = 'tp-seg-btn' + (isActive ? ' active' : '');
      btn.disabled = false;
      btn.style.opacity = '';
      if (isActive) activeBtn = btn;
    });
    requestAnimationFrame(() => updateThumb(box, activeBtn));
  }
  async function loadRoles() {
    if (!activeProj) return;
    try {
      const rolesPath = activeProj.path + '/Roles';
      const hasDir = await lite.fs.exists(rolesPath);
      if (!hasDir) {
        await lite.fs.mkdir(activeProj.path, 'Roles');
        await lite.fs.writeFile(rolesPath + '/Редактор.md', 'Исправь ошибки и опечатки.');
        await lite.fs.writeFile(rolesPath + '/Корректор.md', 'Сделай текст более профессиональным.');
        await lite.fs.writeFile(rolesPath + '/Переводчик.md', 'Переведи текст на английский язык.');
        await lite.fs.writeFile(rolesPath + '/Юрист.md', 'Перепиши текст в строгом юридическом стиле.');
      }
      const entries = await lite.fs.readDir(rolesPath);
      dynamicRoles = ['Без роли'];
      // fs:readDir отдаёт {name, path, dir} (не isDir); при ошибке — {error}, не массив
      for (const ent of (Array.isArray(entries) ? entries : [])) {
        if (!ent.dir && ent.name.endsWith('.md')) {
          dynamicRoles.push(ent.name.replace(/\.md$/, ''));
        }
      }
      if (!dynamicRoles.includes(chatRole)) chatRole = 'Без роли';
    } catch (e) {
      console.error('Failed to load roles:', e);
    }
    renderRoles();
  }

  function renderRoles() {
    const box = $('#doc-ai-roles');
    if (!box) return;
    box.innerHTML = '';
    dynamicRoles.forEach((r) => {
      const btn = document.createElement('button');
      btn.className = 'tp-chip' + (chatRole === r ? ' on' : '');
      btn.textContent = r;
      btn.type = 'button';
      btn.title = r === 'Без роли' ? 'Без роли' : 'Роль «' + r + '» (ПКМ — изменить или удалить)';
      btn.onclick = () => { chatRole = r; renderRoles(); };
      if (r !== 'Без роли') {
        btn.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          host.closeMenus();
          const dd = host.el('div', 'menu-dropdown');
          dd.style.minWidth = '180px';
          dd.appendChild(host.menuRow('pencil', 'Редактировать', () => {
            host.closeMenus();
            openProjectFile(`${activeProj.path}/Roles/${r}.md`);
          }));
          dd.appendChild(host.menuRow('trash', 'Удалить', async () => {
            host.closeMenus();
            try {
              await lite.fs.trash(`${activeProj.path}/Roles/${r}.md`);
              await loadRoles();
            } catch (err) { console.error(err); host.toast('Ошибка: ' + err.message, { kind: 'err' }); }
          }, 'danger'));
          host.placeMenu(dd, e.clientX, e.clientY);
        };
      }
      box.appendChild(btn);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'tp-chip';
    addBtn.textContent = '+';
    addBtn.type = 'button';
    addBtn.title = 'Добавить роль';
    addBtn.onclick = () => {
      if (!activeProj) {
        toast('Сначала откройте проект в боковой панели', { kind: 'warn' });
        return;
      }
      host.showPrompt('Новая роль', 'Название роли:', 'Моя роль', async (val) => {
        if (!val) return;
        const newName = val.trim();
        if (!newName) return;
        
        try {
          const res = await lite.fs.writeFile(`${activeProj.path}/Roles/${newName}.md`, 'Действуй в роли...');
          if (res && res.error) {
            toast('Ошибка записи: ' + res.error, { kind: 'err' });
            return;
          }
          await loadRoles();
          if (typeof openProjectFile === 'function') {
            openProjectFile(`${activeProj.path}/Roles/${newName}.md`);
          } else {
            toast('Роль создана, откройте её слева', { kind: 'info' });
          }
        } catch(e) { 
          console.error(e);
          toast('Системная ошибка: ' + e.message, { kind: 'err' });
        }
      });
    };
    box.appendChild(addBtn);
  }
  function renderSymbols() {
    const box = $('#doc-formula-symbols');
    if (box.children.length) return;
    SYMBOLS.forEach((s) => {
      const btn = el('button', null, s.label);
      btn.type = 'button'; btn.title = s.tex;
      btn.onclick = () => insertSymbol(s.tex);
      box.appendChild(btn);
    });
  }

  // Блок «Контекст» в AI-панели: что именно уйдёт модели при следующей отправке.
  function updateCtxHint() {
    const ctxText = $('#doc-ai-ctx-text');
    if (!ctxText) return;
    if (!attachDoc) {
      ctxText.textContent = 'Документ не приложен — обычный разговор. Скрепка у поля ввода прикладывает текст.';
      ctxText.classList.remove('filled');
      return;
    }
    const chars = currentMarkdown().length;
    ctxText.textContent = chars
      ? `Документ приложен целиком (${chars.toLocaleString('ru-RU')} символов). Для правки одного абзаца выделите его в тексте или укажите номер абзаца — включите нумерацию в режиме «Разметка». Работает и в «Ассистенте», и в «Агенте».`
      : 'Документ пуст — приложить нечего.';
    ctxText.classList.toggle('filled', !!chars);
  }

  // Контекст для AI-панели: выделенный в документе фрагмент
  document.addEventListener('selectionchange', () => {
    if (!docOpen) return;
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && sel.toString().trim();
    updateCtxHint();
    if (!hasSel) {
      if (selPopupEl && selPopupEl.style.display !== 'none' && selPopupEl.contains(document.activeElement)) return;
      hideSelPopup();
    }
    updateToolbarState();
  });

  document.addEventListener('mousedown', (e) => {
    if (selPopupEl && selPopupEl.style.display !== 'none') {
      if (!selPopupEl.contains(e.target)) {
        hideSelPopup();
      }
    }
  });

  // ---- Плавающий попап при выделении: панель форматирования + мини-вопрос к AI ----
  let selPopupEl = null;
  let selPopupRange = null; // сохранённый Range — фокус на инпуте попапа может сбить window.getSelection()

  // Позиционируем элемент относительно selection (range) с учетом границ экрана
  function positionNearRange(node, range, side = 'above') {
    const r = range.getBoundingClientRect();
    node.style.display = 'flex';
    const nr = node.getBoundingClientRect();
    let x = r.left + (r.width / 2) - (nr.width / 2);
    let y = side === 'below' ? r.bottom + 8 : r.top - nr.height - 8;
    x = Math.max(8, Math.min(x, window.innerWidth - nr.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - nr.height - 8));
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }

  function ensureSelPopup() {
    if (!selPopupEl) {
      selPopupEl = el('div', 'tp-sel-popup');
      
      const fmtRow = el('div', 'tp-sel-popup-fmt');
      [['bold', 'Жирный'], ['italic', 'Курсив'], ['underline', 'Подчёркнутый']].forEach(([cmd, title]) => {
        const btn = host.iconBtn('tp-pill-btn', cmd, '');
        btn.dataset.cmd = cmd;
        fmtRow.appendChild(btn);
      });
      fmtRow.appendChild(el('span', 'tp-pill-sep'));
      const listBtn = host.iconBtn('tp-pill-btn', 'list', '');
      listBtn.dataset.cmd = 'insertUnorderedList';
      fmtRow.appendChild(listBtn);
      
      selPopupEl.appendChild(fmtRow);

      fmtRow.querySelectorAll('[data-cmd]').forEach((btn) => {
        btn.onmousedown = (e) => e.preventDefault();
        btn.onclick = (e) => {
          e.preventDefault();
          if (selPopupRange) restoreSelPopupRange();
          execCmd(btn.dataset.cmd);
          refreshSelPopupActiveStates();
        };
      });

      const aiRow = el('div', 'tp-sel-popup-row');
      aiRow.appendChild(el('span', 'tp-sel-popup-arrow', '↳'));
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'tp-sel-popup-input'; input.placeholder = 'Задать вопрос по теме…';
      
      const clearBtn = host.iconBtn('tp-sel-popup-clear', 'close', 'Очистить');
      clearBtn.style.display = 'none';
      clearBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        input.value = '';
        clearBtn.style.display = 'none';
        input.focus();
      };
      input.addEventListener('input', () => {
        clearBtn.style.display = input.value.trim() ? 'flex' : 'none';
      });

      aiRow.appendChild(input);
      aiRow.appendChild(clearBtn);
      
      const send = host.iconBtn('tp-sel-popup-send', 'send', 'В панель AI');
      aiRow.appendChild(send);
      
      selPopupEl.appendChild(aiRow);

      selPopupEl.style.display = 'none';
      selPopupEl.onmousedown = (e) => e.stopPropagation();

      const submit = () => {
        const q = input.value.trim();
        restoreSelPopupRange();
        
        const aiInput = $('#doc-ai-chat-input');
        const selText = window.getSelection().toString().trim();
        
        if (aiInput) {
          if (q) {
            aiInput.value = q;
            input.value = '';
            clearBtn.style.display = 'none';
            hideSelPopup();
            document.querySelector('.tp-layout').classList.remove('inspector-collapsed');
            setTab('ai');
            sendChat();
          } else if (selText) {
            const current = aiInput.value.trim();
            aiInput.value = current ? current + '\n\n' + `"${selText}"` : `"${selText}"`;
            input.value = '';
            clearBtn.style.display = 'none';
            hideSelPopup();
            document.querySelector('.tp-layout').classList.remove('inspector-collapsed');
            setTab('ai');
            setTimeout(() => {
              if (aiInput) {
                aiInput.focus();
                aiInput.selectionStart = aiInput.selectionEnd = aiInput.value.length;
              }
            }, 50);
          }
        }
      };
      send.onclick = submit;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') hideSelPopup();
      };
    }

    const layer = document.body;
    if (selPopupEl.parentNode !== layer) {
      layer.appendChild(selPopupEl);
      selPopupEl.style.zIndex = '99999';
    }
  }

  function restoreSelPopupRange() {
    if (!selPopupRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(selPopupRange);
  }
  function refreshSelPopupActiveStates() {
    if (!selPopupEl) return;
    selPopupEl.querySelectorAll('[data-cmd]').forEach((btn) => {
      let active = false;
      try { active = document.queryCommandState(btn.dataset.cmd); } catch (_) {}
      btn.classList.toggle('on', active);
    });
  }
  function hideSelPopup() {
    if (selPopupEl) selPopupEl.style.display = 'none';
    selPopupRange = null;
  }
  function showSelectionUI(range) {
    try {
      selPopupRange = range.cloneRange();
      ensureSelPopup();
      
      const fmtRow = selPopupEl.querySelector('.tp-sel-popup-fmt');
      if (mode === 'wysiwyg') {
        refreshSelPopupActiveStates();
        fmtRow.style.display = 'flex';
      } else {
        fmtRow.style.display = 'none';
      }
      
      positionNearRange(selPopupEl, range, 'above');
    } catch (e) { console.error("Popup Error: ", e); }
  }
  function maybeShowSelectionUI() {
    try {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        showSelectionUI(sel.getRangeAt(0));
      }
    } catch (e) { console.error("Selection UI Error: ", e); }
  }

  // ---- Interface for Main ----
  function setDocOpen(open, opts = {}) {
    if (open === docOpen) return;
    if (open) closeOtherPanels('doc');
    const delta = layout.doc + GUTTER;
    docOpen = open;
    $('#doc-pane').classList.toggle('hidden', !open);
    const gDoc = $('#gutter-doc'); if (gDoc) gDoc.classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) {
      setupUI();
      if (openTabs.length === 0) restoreLastOrNew();
    }
    setTimeout(refitActiveTerminal, 150);
  }
  function confirmClose(proceed) {
    saveCurrentTabState(); // свежие правки активной вкладки → в снапшот
    const dirtyTabs = openTabs.filter((t) => t.dirty);
    if (!dirtyTabs.length) { proceed(); return; }
    const names = dirtyTabs.map((t) => '«' + t.name + '»').join(', ');
    showConfirm(
      'Несохранённые изменения',
      'Не сохранено: ' + names + '. Закрыть окно?',
      'Сохранить и закрыть', async () => {
        for (const t of dirtyTabs) { if (!(await saveTabToDisk(t))) return; } // отмена/ошибка = не закрываем
        proceed();
      },
      'Закрыть без сохранения', proceed,
    );
  }

  // ---- Sidebar & Tabs Logic ----
  const sidebar = $('#doc-sidebar');
  const treeContainer = $('#doc-tree');
  const tabsContainer = $('#doc-tabs-container');

  function toggleSidebar() {
    sidebar.classList.toggle('hidden');
    const layout = sidebar.closest('.tp-layout');
    if (layout) layout.classList.toggle('sidebar-collapsed', sidebar.classList.contains('hidden'));
    
    if (!sidebar.classList.contains('hidden')) {
      if (activeProj) renderTree(activeProj);
      setTimeout(maybeShowNewFileTip, 600); // после анимации раскрытия панели
    }
  }

  // Кнопку «новый файл» в панели дерева не замечают (её ищут в меню «Файл»).
  // Один раз при первом показе дерева подсказываем, что она тут.
  function maybeShowNewFileTip() {
    if (settings.tpTipNewFile === 'seen') return;
    const btn = $('#btn-tree-new-file');
    if (!btn || !btn.getBoundingClientRect().width) return;
    settings.tpTipNewFile = 'seen';
    saveSettings();
    const r = btn.getBoundingClientRect();
    const tip = el('div', 'tp-tip');
    tip.appendChild(el('div', 'tp-tip-title', 'Новый документ — здесь'));
    tip.appendChild(el('div', null, 'Эта кнопка создаёт файл в папке проекта. Рядом: новая папка, сортировка (правой кнопкой — выбор порядка) и показ скрытых файлов.'));
    const ok = el('button', 'tp-btn tp-btn-accent', 'Понятно');
    ok.onclick = () => tip.remove();
    tip.appendChild(ok);
    document.body.appendChild(tip);
    tip.style.left = Math.round(Math.max(12, Math.min(r.left - 8, window.innerWidth - tip.offsetWidth - 12))) + 'px';
    tip.style.top = Math.round(r.bottom + 10) + 'px';
    setTimeout(() => tip.remove(), 20000);
  }

  const btnNewFile = $('#btn-tree-new-file');
  const btnNewFolder = $('#btn-tree-new-folder');
  const btnSort = $('#btn-tree-sort');
  const btnCollapse = $('#btn-tree-collapse');

  if (btnNewFile) btnNewFile.onclick = () => {
    if (!activeProj) return;
    host.showPrompt('Новый файл', 'Имя файла (без .md):', 'Новая заметка', async (val) => {
      if (!val) return;
      let name = val.trim();
      if (!name) return;
      if (!name.includes('.')) name += '.md';
      try {
        await lite.fs.create(activeProj.path, name, false);
        await renderTree(activeProj);
        const sep = activeProj.path.includes('\\') ? '\\' : '/';
        const newPath = activeProj.path.endsWith(sep) ? (activeProj.path + name) : (activeProj.path + sep + name);
        openProjectFile(newPath);
      } catch (err) { host.toast('Ошибка: ' + err.message, {kind:'err'}); }
    });
  };

  if (btnNewFolder) btnNewFolder.onclick = () => {
    if (!activeProj) return;
    host.showPrompt('Новая папка', 'Имя папки:', 'Новая папка', async (val) => {
      if (!val) return;
      let name = val.trim();
      if (!name) return;
      try {
        await lite.fs.create(activeProj.path, name, true);
        await renderTree(activeProj);
      } catch (err) { host.toast('Ошибка: ' + err.message, {kind:'err'}); }
    });
  };

  // Меню по правой кнопке на файле/папке: спрятать из дерева или вернуть обратно.
  function showEntryMenu(ev, entry) {
    ev.preventDefault();
    ev.stopPropagation();
    const manual = treeHiddenPaths.includes(entry.path);
    const items = [{ title: entry.name }];
    items.push(manual
      ? { label: 'Показывать снова', onClick: () => setEntryHidden(entry.path, false) }
      : { label: 'Скрыть из дерева', onClick: () => setEntryHidden(entry.path, true) });
    items.push({ sep: true });
    items.push({ label: treeShowHidden ? 'Не показывать скрытые' : 'Показать скрытые файлы', onClick: toggleShowHidden });
    showContextMenu(ev.clientX, ev.clientY, items);
  }
  function setEntryHidden(path, hidden) {
    treeHiddenPaths = treeHiddenPaths.filter((x) => x !== path);
    if (hidden) treeHiddenPaths.push(path);
    settings.tpHiddenPaths = treeHiddenPaths;
    saveSettings();
    if (hidden && !treeShowHidden) toast('Скрыто. Вернуть — кнопка с глазом в панели слева');
    if (activeProj) renderTree(activeProj);
  }
  function toggleShowHidden() {
    treeShowHidden = !treeShowHidden;
    settings.tpShowHidden = treeShowHidden;
    saveSettings();
    updateHiddenBtn();
    if (activeProj) renderTree(activeProj);
  }
  function updateHiddenBtn() {
    const b = $('#btn-tree-hidden');
    if (!b) return;
    b.classList.toggle('active', treeShowHidden);
    b.title = treeShowHidden ? 'Скрытые файлы показаны — нажмите, чтобы спрятать' : 'Показать скрытые файлы';
    b.innerHTML = '';
    b.removeAttribute('data-icon'); // иконку ставим руками: hydrateIcons отрабатывает один раз при старте
    b.appendChild(host.icon(treeShowHidden ? 'eye' : 'eye-off', 22));
  }
  function applySort(id) {
    treeSortMode = id;
    settings.tpSortMode = id;
    saveSettings();
    updateSortBtn();
    if (activeProj) renderTree(activeProj);
  }
  function updateSortBtn() {
    if (!btnSort) return;
    const cur = TREE_SORTS.find((x) => x.id === treeSortMode);
    btnSort.title = 'Сортировка: ' + (cur ? cur.label : treeSortMode) + ' (правой кнопкой — выбор)';
  }
  // Левый клик листает по кругу только отмеченные порядки.
  if (btnSort) btnSort.onclick = () => {
    const cycle = treeSortCycle.length ? treeSortCycle : ['az', 'za'];
    const i = cycle.indexOf(treeSortMode);
    applySort(cycle[(i + 1) % cycle.length]);
  };
  // Правый клик: выбрать порядок сразу (клик по названию) либо отметить,
  // какие порядки участвуют в переключении по кругу (клик по квадратику с номером).
  if (btnSort) btnSort.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const build = () => TREE_SORTS.map((sortItem) => ({
      label: sortItem.label,
      active: sortItem.id === treeSortMode,
      checked: treeSortCycle.includes(sortItem.id),
      order: treeSortCycle.indexOf(sortItem.id) + 1,
      onClick: () => applySort(sortItem.id),
      onToggle: () => {
        if (treeSortCycle.includes(sortItem.id)) {
          if (treeSortCycle.length > 1) treeSortCycle = treeSortCycle.filter((x) => x !== sortItem.id);
          else { toast('Хотя бы один порядок должен остаться'); return; }
        } else treeSortCycle.push(sortItem.id);
        settings.tpSortCycle = treeSortCycle;
        saveSettings();
        showContextMenu(ev.clientX, ev.clientY, [{ title: 'Сортировка' }, ...build()]); // перерисовать с новыми номерами
      },
    }));
    showContextMenu(ev.clientX, ev.clientY, [{ title: 'Сортировка' }, ...build()]);
  });

  const btnHidden = $('#btn-tree-hidden');
  if (btnHidden) btnHidden.onclick = toggleShowHidden;
  updateHiddenBtn();
  updateSortBtn();

  if (btnCollapse) btnCollapse.onclick = () => {
    document.querySelectorAll('.tp-tree-folder-children').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.tp-tree-folder-header .tp-tree-icon').forEach(icon => {
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    });
  };

  async function renderTree(proj) {
    activeProj = proj;
    loadRoles();
    if (sidebar.classList.contains('hidden')) return;
    if (!proj || !proj.path) return;
    try {
      treeContainer.innerHTML = '';
      
      // Search functionality
    const searchInput = $('#doc-tree-search');
    if (searchInput) {
      searchInput.oninput = (e) => {
        const query = e.target.value.toLowerCase();
        const items = document.querySelectorAll('.tp-tree-item, .tp-tree-folder');
        items.forEach(item => {
          if (item.textContent.toLowerCase().includes(query)) {
            item.style.display = '';
            // If it's a folder, ensure it's visible if children match
            if (item.classList.contains('tp-tree-folder')) {
              item.style.display = 'block';
            }
          } else {
            item.style.display = 'none';
          }
        });
        
        // Ensure folders are shown if any child is visible
        document.querySelectorAll('.tp-tree-folder').forEach(folder => {
          const hasVisibleChild = Array.from(folder.querySelectorAll('.tp-tree-item')).some(child => child.style.display !== 'none');
          if (hasVisibleChild) {
            folder.style.display = 'block';
            folder.querySelector('.tp-tree-folder-children').style.display = 'block';
            const icon = folder.querySelector('.tp-tree-icon');
            if (icon) icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
          }
        });
      };
    }

    const buildTree = async (dirPath, container, level) => {
        const entries = await lite.fs.readDir(dirPath);

        let hasFiles = false;
        // Скрытые (точечные + спрятанные вручную) показываем только при включённом «глазе».
        const visible = entries.filter((e) => treeShowHidden || !isHiddenEntry(e));
        const dirs = sortEntries(visible.filter((e) => e.dir));
        const files = sortEntries(visible.filter((e) => !e.dir && (e.name.endsWith('.md') || e.name.endsWith('.txt') || e.name.endsWith('.docx'))));
        
        for (const d of dirs) {
          if (d.name === 'Roles' || d.name === '.git' || d.name === 'node_modules') continue;
          
          const folderDiv = document.createElement('div');
          folderDiv.className = 'tp-tree-folder';
          
          const header = document.createElement('div');
          header.className = 'tp-tree-folder-header' + (isHiddenEntry(d) ? ' tp-tree-hidden' : '');
          header.addEventListener('contextmenu', (ev) => showEntryMenu(ev, d));
          
          const icon = document.createElement('span');
          icon.className = 'tp-tree-icon';
          icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`; // chevron-right
          
          const label = document.createElement('span');
          label.textContent = d.name;
          
          header.appendChild(icon);
          const folderIcon = document.createElement('span');
          folderIcon.className = 'tp-folder-glyph';
          folderIcon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
          header.appendChild(folderIcon);
          header.appendChild(label);
          folderDiv.appendChild(header);
          
          const childrenContainer = document.createElement('div');
          childrenContainer.className = 'tp-tree-folder-children';
          childrenContainer.style.display = 'none';
          folderDiv.appendChild(childrenContainer);
          
          container.appendChild(folderDiv);
          
          let loaded = false;
          header.onclick = async (e) => {
            e.stopPropagation();
            const isCollapsed = childrenContainer.style.display === 'none';
            if (isCollapsed) {
              childrenContainer.style.display = 'block';
              icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg>`; // chevron-down
              if (!loaded) {
                await buildTree(d.path, childrenContainer, level + 1);
                loaded = true;
              }
            } else {
              childrenContainer.style.display = 'none';
              icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`; // chevron-right
            }
          };
          hasFiles = true;
        }
        
        for (const f of files) {
          const item = document.createElement('div');
          item.className = 'tp-tree-item' + (isHiddenEntry(f) ? ' tp-tree-hidden' : '');
          item.addEventListener('contextmenu', (ev) => showEntryMenu(ev, f));
          
          if (f.ctime && f.mtime) {
            const cStr = new Date(f.ctime).toLocaleString();
            const mStr = new Date(f.mtime).toLocaleString();
            item.title = `Создан: ${cStr}\nИзменён: ${mStr}`;
          }
          
          item.appendChild(fileBadge(f.name));
          
          const nameSpan = document.createElement('span');
          nameSpan.className = 'tp-tree-item-name';
          nameSpan.textContent = f.name;
          item.appendChild(nameSpan);
          
          const curTab = openTabs.find((t) => t.id === activeTabId);
          if (curTab && f.path === curTab.absPath) {
            item.classList.add('active');
          }
          
          item.onclick = (e) => {
            e.stopPropagation();
            document.querySelectorAll('.tp-tree-item.active').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            openProjectFile(f.path);
          };
          container.appendChild(item);
          hasFiles = true;
        }
        
        if (!hasFiles && level === 0) {
          container.innerHTML = '<div style="padding: 10px; color: var(--tp-text-3); font-size: 13px;">Нет Markdown файлов</div>';
        }
      };
      
      await buildTree(proj.path, treeContainer, 0);
    } catch (e) {
      console.error(e);
    }
  }

  async function openProjectFile(absPath) {
    // Check if already open
    let tab = openTabs.find(t => t.absPath === absPath);
    if (tab) {
      switchToTab(tab.id);
      return;
    }
    
    // Read file
    const r = await lite.fs.readFile(absPath);
    if (!r || r.error) {
      toast('Ошибка чтения файла', { kind: 'err' });
      return;
    }
    
    // Create new tab
    const id = nextTabId++;
    const name = baseName(absPath);
    const isHtml = /\.html?$/i.test(name);
    // HTML с диска = внешний контент: санитизация ДО хранения (иначе innerHTML в switchToTab исполнит
    // разметку с onerror и т.п.); htmlToMd ждёт DOM-корень, не строку.
    let safeHtml = null, mdSrc = r.content;
    if (isHtml) {
      safeHtml = DOMPurify.sanitize(r.content, { ADD_ATTR: ['contenteditable', 'data-tex'] });
      const root = document.createElement('div');
      root.innerHTML = safeHtml;
      mdSrc = htmlToMd(root);
    }
    tab = {
      id,
      absPath,
      name,
      html: isHtml ? safeHtml : mdToHtml(r.content),
      md: mdSrc,
      mode: 'wysiwyg',
      dirty: false,
      // Позиция чтения с прошлого запуска: файл открывается там, где его закрыли.
      scrollTop: savedScrollFor(absPath)
    };
    
    openTabs.push(tab);
    renderTabsUI();
    switchToTab(id);
    // switchToTab выходит сразу, если вкладка уже активна (бывает при восстановлении сессии),
    // и тогда содержание не пересчитывалось. Строим его явно, когда текст уже в редакторе.
    setTimeout(renderScrubber, 60);
  }

  // Полоса вкладок вынесена из прокручиваемой области, своей полосы прокрутки у неё нет.
  // Без этого вкладки и страница разъезжаются на ширину скроллбара.
  function alignTabsBar() {
    const canvas = document.querySelector('.tp-canvas');
    if (!canvas || !tabsContainer) return;
    const sb = Math.max(0, canvas.offsetWidth - canvas.clientWidth);
    // Страница центрируется внутри области прокрутки, а та у́же на ширину полосы прокрутки.
    // Чтобы левые края вкладок и страницы совпали, полосе вкладок нужны И правый отступ
    // на ширину скроллбара, И такая же прибавка к предельной ширине: иначе сама полоса
    // остаётся отцентрованной по-старому и уезжает вправо на половину скроллбара.
    tabsContainer.style.paddingRight = (10 + sb) + 'px';
    tabsContainer.style.maxWidth = (1020 + sb) + 'px';
  }
  window.addEventListener('resize', () => { window.tpZoomBase = null; alignTabsBar(); });

  function renderTabsUI() {
    tabsContainer.innerHTML = '';
    openTabs.forEach(t => {
      const el = document.createElement('div');
      el.className = 'tp-doc-tab' + (t.id === activeTabId ? ' active' : '');
      el.title = (t.absPath || t.name) + (t.dirty ? ' — не сохранён' : '');
      el.innerHTML = `<span>${escapeHtml(t.name)}${t.dirty ? '*' : ''}</span>`;

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tp-doc-tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Закрыть вкладку';
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeTab(t.id);
      };
      
      el.appendChild(closeBtn);
      el.onclick = () => switchToTab(t.id);
      tabsContainer.appendChild(el);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'tp-doc-tab-add';
    addBtn.textContent = '+';
    addBtn.title = 'Новая вкладка';
    addBtn.onclick = () => createNewTab();
    tabsContainer.appendChild(addBtn);
    alignTabsBar();
  }
  
  async function restoreLastOrNew() {
    // Восстанавливаем ВСЕ ранее открытые сохранённые файлы; активной делаем последнюю.
    const files = (Array.isArray(settings.tpOpenFiles) && settings.tpOpenFiles.length)
      ? settings.tpOpenFiles
      : (settings.tpLastFile ? [settings.tpLastFile] : []);
    let opened = 0;
    for (const f of files) {
      try {
        const r = await lite.fs.readFile(f); // тихая проверка: файл ещё существует?
        if (r && !r.error) { await openProjectFile(f); opened++; }
      } catch (e) { /* удалён/недоступен — пропускаем */ }
    }
    if (opened === 0) { createNewTab(); return; }
    if (settings.tpLastFile) {
      const t = openTabs.find(x => x.absPath === settings.tpLastFile);
      if (t) switchToTab(t.id);
    }
  }

  // ---- Позиция чтения --------------------------------------------------------------------
  // Храним scrollTop по абсолютному пути файла, чтобы документ открывался там, где его закрыли.
  // Карта чистится до 50 последних файлов, иначе settings разрастается без предела.
  function savedScrollFor(absPath) {
    const map = settings.tpScroll;
    return (map && typeof map[absPath] === 'number') ? map[absPath] : 0;
  }
  function rememberScroll(absPath, top) {
    if (!absPath) return;
    if (!settings.tpScroll || typeof settings.tpScroll !== 'object') settings.tpScroll = {};
    settings.tpScroll[absPath] = top;
    const keys = Object.keys(settings.tpScroll);
    if (keys.length > 50) delete settings.tpScroll[keys[0]];
  }
  // Слушатель скролла: активная вкладка помнит позицию всегда, а не только при переключении.
  // Пишем в settings редко (через таймер) — сохранение на каждый пиксель прокрутки било бы по диску.
  let scrollSaveTimer = null;
  function watchCanvasScroll() {
    const canvas = document.querySelector('.tp-canvas');
    if (!canvas || canvas.dataset.scrollWatched) return;
    canvas.dataset.scrollWatched = '1';
    canvas.addEventListener('scroll', () => {
      updateTocActive();
      const tab = openTabs.find(t => t.id === activeTabId);
      if (!tab) return;
      tab.scrollTop = canvas.scrollTop;
      if (!tab.absPath) return;
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => { rememberScroll(tab.absPath, tab.scrollTop); saveSettings(); }, 700);
    }, { passive: true });
  }

  // Запоминаем набор открытых сохранённых файлов и активный — для восстановления при следующем запуске.
  function persistSession() {
    try {
      settings.tpOpenFiles = openTabs.filter(t => t.absPath).map(t => t.absPath);
      const act = openTabs.find(t => t.id === activeTabId);
      if (act && act.absPath) settings.tpLastFile = act.absPath;
      openTabs.forEach(t => { if (t.absPath && typeof t.scrollTop === 'number') rememberScroll(t.absPath, t.scrollTop); });
      saveSettings();
    } catch (e) {}
  }

  function createNewTab() {
    const id = nextTabId++;
    const tab = {
      id,
      absPath: null,
      name: 'Безымянный',
      html: '<p><br></p>',
      md: '',
      mode: 'wysiwyg',
      dirty: false
    };
    openTabs.push(tab);
    renderTabsUI();
    switchToTab(id);
    persistSession();
    // Новый пустой файл: ставим фокус (мигающий курсор). Несколько попыток — при запуске окно
    // может быть ещё не активно, и одиночный focus() не даёт мигающего курсора.
    requestAnimationFrame(focusDocEditor);
    setTimeout(focusDocEditor, 120);
    setTimeout(focusDocEditor, 400);
  }

  // Ставит фокус в редактор «Разметки» и курсор в начало. Курсор мигает только когда окно активно.
  function focusDocEditor() {
    const ed = $('#doc-editor-wysiwyg');
    if (!ed || ed.hidden) return;
    ed.focus();
    try {
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(ed); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    } catch (_) {}
  }

  function saveCurrentTabState() {
    if (activeTabId === null) return;
    const tab = openTabs.find(t => t.id === activeTabId);
    if (tab) {
      tab.mode = mode;
      tab.dirty = dirty;
      tab.html = $('#doc-editor-wysiwyg').innerHTML;
      tab.md = $('#doc-editor-md').textContent;
      const canvas = document.querySelector('.tp-canvas');
      if (canvas) tab.scrollTop = canvas.scrollTop;
    }
  }

  function switchToTab(id) {
    if (activeTabId === id) return;
    saveCurrentTabState();
    
    const tab = openTabs.find(t => t.id === id);
    if (!tab) return;
    
    activeTabId = id;
    currentFile = tab.absPath;
    currentName = tab.name;
    mode = tab.mode;
    dirty = tab.dirty;

    // Load content without resetting mode (sanitize при каждой инъекции — как в setMode/loadDocument)
    $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(tab.html, { ADD_ATTR: ['contenteditable', 'data-tex'] });
    $('#doc-editor-md').textContent = tab.md;
    updateModeUI();
    updateStatus(dirty ? 'Изменено' : (tab.absPath ? 'Открыт' : 'Новый файл'));

    renderTabsUI();
    
    // Restore scroll position
    const canvas = document.querySelector('.tp-canvas');
    if (canvas) {
      // Need a small timeout to let the DOM render before scrolling
      setTimeout(() => {
        canvas.scrollTop = tab.scrollTop || 0;
      }, 10);
    }
    
    persistSession();
  }

  async function closeTab(id) {
    const tab = openTabs.find(t => t.id === id);
    if (!tab) return;
    if (tab.id === activeTabId) saveCurrentTabState(); // снять свежие правки в снапшот перед проверкой
    if (tab.dirty) {
      showConfirm(
        'Несохранённые изменения',
        `«${tab.name}» не сохранён. Сохранить перед закрытием?`,
        'Сохранить и закрыть', async () => { if (await saveTabToDisk(tab)) reallyCloseTab(id); },
        'Закрыть без сохранения', () => reallyCloseTab(id),
      );
      return;
    }
    reallyCloseTab(id);
  }
  function reallyCloseTab(id) {
    const tabIdx = openTabs.findIndex(t => t.id === id);
    if (tabIdx === -1) return;
    openTabs.splice(tabIdx, 1);
    if (activeTabId === id) {
      activeTabId = null;
      if (openTabs.length > 0) {
        switchToTab(openTabs[Math.max(0, tabIdx - 1)].id);
      } else {
        createNewTab();
      }
    } else {
      renderTabsUI();
    }
    persistSession();
  }

  async function reloadCurrentFile() {
    if (!currentFile) return;
    const r = await lite.fs.readFile(currentFile);
    if (r && !r.error) {
      const isHtml = /\.html?$/i.test(currentFile);
      let safeHtml = null, mdSrc = r.content;
      if (isHtml) {
        safeHtml = DOMPurify.sanitize(r.content, { ADD_ATTR: ['contenteditable', 'data-tex'] });
        const root = document.createElement('div');
        root.innerHTML = safeHtml;
        mdSrc = htmlToMd(root);
      } else {
        safeHtml = mdToHtml(r.content);
      }
      
      const tab = openTabs.find(t => t.id === activeTabId);
      if (tab) {
        tab.html = safeHtml;
        tab.md = mdSrc;
        tab.dirty = false;
        dirty = false;
        
        $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(safeHtml, { ADD_ATTR: ['contenteditable', 'data-tex'] });
        $('#doc-editor-md').textContent = mdSrc;
        
        updateStatus('Обновлен с диска');
        renderTabsUI();
        updateDocPlaceholder();

        toast('Документ обновлён ИИ', { kind: 'success' });
      }
    }
  }

  function onFsChange(proj, files) {
    if (activeProj && activeProj.path === proj.path) {
      renderTree(proj);
    }
    if (currentFile && files.includes(currentFile)) {
      if (!dirty) {
        reloadCurrentFile();
      }
    }
  }

  return {
    renderTree,
    onFsChange,
    isOpen: () => docOpen,
    setOpen: setDocOpen,
    toggle: () => setDocOpen(!docOpen),
    showSettings: () => { /* TODO */ },
    confirmClose,
  };
}
