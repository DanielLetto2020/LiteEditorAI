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
import { baseName, makeModal, icon } from '../ui.js';

const $ = (s) => document.querySelector(s);
// Строка с подстановкой: в словаре живёт ШАБЛОН («… {0} …»), значения вставляем после перевода —
// иначе экстрактор растаскивает фразу на обрывки, которые нечем переводить.
const tf = (tpl, ...vals) => String(tpl).replace(/\{(\d+)\}/g, (_, i) => String(vals[+i] == null ? '' : vals[+i]));
const $$ = (s) => Array.from(document.querySelectorAll(s));

marked.setOptions({ breaks: true });

// Один набор для ВСЕХ мест санитизации: атрибуты наших неразрушимых блоков (формулы, front matter)
// должны переживать DOMPurify, иначе исходник из data-* теряется и обратная конвертация его не вернёт.
const SANITIZE = { ADD_ATTR: ['contenteditable', 'data-tex', 'data-delim', 'data-fm'] };

// ---- Markdown ⇄ HTML (+ формулы) ----------------------------------------------------------
const F_OPEN = '⟦', F_CLOSE = '⟧'; // ⟦ ⟧ — маловероятные в обычном тексте маркеры-плейсхолдеры
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

// Разделители формул. Кроме долларов принимаем \[…\] и \(…\): именно так формулы выдают
// нейросети, и вставленный из чата текст раньше оставался сырым LaTeX. Тип разделителя запоминаем
// (delim) и возвращаем при обратной конвертации — иначе первое же автосохранение переписало бы
// \[…\] в $$…$$ по всему чужому файлу.
function extractFormulas(src) {
  const blocks = [], inlines = [];
  let text = String(src || '').replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (_, tex) => {
    const i = blocks.length; blocks.push({ tex, delim: 'dollar' });
    return F_OPEN + 'B' + i + F_CLOSE;
  });
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
    const i = blocks.length; blocks.push({ tex, delim: 'bracket' });
    return F_OPEN + 'B' + i + F_CLOSE;
  });
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => {
    const i = inlines.length; inlines.push({ tex, delim: 'paren' });
    return F_OPEN + 'I' + i + F_CLOSE;
  });
  text = text.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_, tex) => {
    const i = inlines.length; inlines.push({ tex, delim: 'dollar' });
    return F_OPEN + 'I' + i + F_CLOSE;
  });
  return { text, blocks, inlines };
}

function renderFormulaHtml(tex, displayMode) {
  try { return katex.renderToString(tex, { throwOnError: false, displayMode }); }
  catch (_) { return '<span class="tp-formula-err">ошибка в формуле</span>'; }
}

function formulaBlockHtml(tex, num, delim) {
  return '<div class="tp-formula-block" contenteditable="false" data-tex="' + escapeAttr(tex) + '"'
    + (delim && delim !== 'dollar' ? ' data-delim="' + escapeAttr(delim) + '"' : '') + '>'
    + '<div class="tp-formula-render">' + renderFormulaHtml(tex, true) + '</div>'
    + '<div class="tp-formula-src"><pre>' + escapeHtml(tex) + '</pre></div>'
    + '<span class="tp-formula-num">(' + escapeHtml(num) + ')</span>'
    + '<button type="button" class="tp-formula-toggle" title="Показать/скрыть LaTeX">&lt;/&gt;</button>'
    + '</div>';
}
function formulaInlineHtml(tex, delim) {
  return '<span class="tp-formula-inline" contenteditable="false" data-tex="' + escapeAttr(tex) + '"'
    + (delim && delim !== 'dollar' ? ' data-delim="' + escapeAttr(delim) + '"' : '') + '>'
    + renderFormulaHtml(tex, false) + '</span>';
}

// YAML front matter (`---` … `---` в самом начале файла) — НЕ markdown: marked видит в нём
// горизонтальную линию и setext-заголовок, и после первого же сохранения шапка файла оказывалась
// переписана как «## owner: ...». А front matter несут и правила проекта, и роли агентов в
// .claude/agents/*.md, и заметки Obsidian. Поэтому вырезаем его до парсера и держим отдельным
// нередактируемым блоком с исходником в data-fm — тем же приёмом, что и формулы.
const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function splitFrontMatter(src) {
  const text = String(src == null ? '' : src);
  const m = FRONT_MATTER_RE.exec(text);
  return m ? { fm: m[1], rest: text.slice(m[0].length) } : { fm: null, rest: text };
}
function frontMatterHtml(fm) {
  return '<div class="tp-frontmatter" contenteditable="false" data-fm="' + escapeAttr(fm) + '">'
    + '<pre>' + escapeHtml(fm) + '</pre></div>';
}

// Markdown-источник → HTML для «Разметки». Блочные/инлайн-формулы выносятся в плейсхолдеры до marked
// (чтобы parser их не тронул), потом подставляются готовым KaTeX-рендером.
function mdToHtml(src) {
  const { fm, rest } = splitFrontMatter(src);
  const { text, blocks, inlines } = extractFormulas(rest);
  let html = (fm == null ? '' : frontMatterHtml(fm)) + marked.parse(text);
  let n = 0;
  blocks.forEach((b, i) => {
    let tex = b.tex.trim(), num;
    const m = tex.match(/\\tag\{([^}]*)\}/);
    if (m) { num = m[1]; tex = tex.replace(/\\tag\{[^}]*\}/, '').trim(); }
    else { n++; num = String(n); }
    const token = F_OPEN + 'B' + i + F_CLOSE;
    const wrapped = new RegExp('<p>\\s*' + reEscape(token) + '\\s*</p>|' + reEscape(token));
    html = html.replace(wrapped, formulaBlockHtml(tex, num, b.delim));
  });
  inlines.forEach((f, i) => {
    html = html.split(F_OPEN + 'I' + i + F_CLOSE).join(formulaInlineHtml(f.tex.trim(), f.delim));
  });
  return DOMPurify.sanitize(html, SANITIZE);
}

// HTML (из contenteditable) → Markdown-источник.
//
// ВАЖНО про охват: сюда попадает не только то, что нарисовал наш тулбар, но и результат mdToHtml
// от ЛЮБОГО .md-файла проекта (дерево слева открывает файлы редактора). А сохранение идёт через
// эту функцию — в том числе автосейвом через 1.5 с после первой же правки. Поэтому конвертер
// обязан покрывать всё, что marked производит из markdown: раньше ссылки, блоки кода, таблицы,
// картинки, заголовки от H4, вложенность списков и `---` при первом же сохранении молча
// превращались в плоский текст, и файл был испорчен без единого предупреждения.
// Формула → исходный вид: тем же разделителем, каким пришла (см. extractFormulas).
function wrapBlock(n) {
  const tex = n.dataset.tex || '';
  return n.dataset.delim === 'bracket' ? ('\\[' + tex + '\\]') : ('$$' + tex + '$$');
}
function wrapInline(n) {
  const tex = n.dataset.tex || '';
  return n.dataset.delim === 'paren' ? ('\\(' + tex + '\\)') : ('$' + tex + '$');
}

function htmlToMd(root) {
  const mdEscape = (t) => t.replace(/[\\`*_$]/g, '\\$&');
  const attr = (n, a) => (n.getAttribute && n.getAttribute(a)) || '';
  // Блочные теги: встретив их среди детей контейнера (contenteditable любит оборачивать в <div>),
  // разбираем контейнер блоками, а не склеиваем всё в один абзац.
  const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'ul', 'ol', 'pre', 'table', 'blockquote', 'hr']);
  const hasBlockChild = (n) => [...n.childNodes].some((c) => c.nodeType === Node.ELEMENT_NODE && BLOCK.has(c.tagName.toLowerCase()));
  function codeBlockOf(n) {
    const codeEl = n.tagName.toLowerCase() === 'code' ? n : n.querySelector('code');
    const lang = (String((codeEl && codeEl.className) || '').match(/language-([\w+#.-]+)/) || ['', ''])[1];
    const body = String((codeEl || n).textContent || '').replace(/\n+$/, '');
    // Забор длиннее самой длинной серии обратных кавычек внутри: иначе блок, В КОТОРОМ показан
    // markdown с ```, закрылся бы на первой же внутренней тройке и разорвал документ.
    const longest = (body.match(/`{3,}/g) || []).reduce((m, x) => Math.max(m, x.length), 2);
    const fence = '`'.repeat(longest + 1);
    return fence + lang + '\n' + body + '\n' + fence + '\n\n';
  }
  function inlineOf(node) {
    let s = '';
    node.childNodes.forEach((n) => { s += oneInline(n); });
    return s;
  }
  function oneInline(n) {
    if (n.nodeType === Node.TEXT_NODE) return mdEscape(n.textContent);
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    if (n.classList.contains('tp-frontmatter')) return '---\n' + (n.dataset.fm || '') + '\n---\n\n';
    if (n.classList.contains('tp-formula-inline')) return wrapInline(n);
    if (n.classList.contains('tp-formula-block')) return '\n\n' + wrapBlock(n) + '\n\n';
    switch (n.tagName.toLowerCase()) {
      case 'strong': case 'b': { const t = inlineOf(n); return t.trim() ? '**' + t + '**' : t; }
      case 'em': case 'i': { const t = inlineOf(n); return t.trim() ? '*' + t + '*' : t; }
      case 'u': { const t = inlineOf(n); return t.trim() ? '<u>' + t + '</u>' : t; }
      case 'del': case 's': case 'strike': { const t = inlineOf(n); return t.trim() ? '~~' + t + '~~' : t; }
      // Ссылка без href (якорь-заглушка) — просто текст, иначе получился бы «[текст]()».
      case 'a': { const t = inlineOf(n) || mdEscape(attr(n, 'href')); const h = attr(n, 'href'); return h ? '[' + t + '](' + h + ')' : t; }
      case 'img': return '![' + attr(n, 'alt') + '](' + attr(n, 'src') + ')';
      case 'code': return '`' + n.textContent + '`';
      case 'pre': return '\n\n' + codeBlockOf(n);
      case 'hr': return '\n\n---\n\n';
      case 'br': return '\n';
      default: return inlineOf(n);
    }
  }
  // Текст пункта отдельно от вложенных списков: иначе вложенность схлопывалась в один уровень.
  function listOf(n, ordered, depth) {
    const pad = '  '.repeat(depth || 0);
    let s = '', i = 1;
    n.childNodes.forEach((li) => {
      if (li.nodeType !== Node.ELEMENT_NODE || li.tagName.toLowerCase() !== 'li') return;
      let inline = '', nested = '';
      li.childNodes.forEach((c) => {
        const tag = c.nodeType === Node.ELEMENT_NODE ? c.tagName.toLowerCase() : '';
        if (tag === 'ul') nested += listOf(c, false, (depth || 0) + 1);
        else if (tag === 'ol') nested += listOf(c, true, (depth || 0) + 1);
        else inline += oneInline(c);
      });
      s += pad + (ordered ? (i++ + '. ') : '- ') + inline.trim() + '\n' + nested;
    });
    return depth ? s : s + '\n';
  }
  function tableOf(n) {
    const rows = [...n.querySelectorAll('tr')];
    if (!rows.length) return '';
    const cells = (tr) => [...tr.children].map((c) => inlineOf(c).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim());
    const head = cells(rows[0]);
    let s = '| ' + head.join(' | ') + ' |\n|' + head.map(() => ' --- ').join('|') + '|\n';
    for (const tr of rows.slice(1)) {
      const c = cells(tr);
      while (c.length < head.length) c.push('');
      s += '| ' + c.join(' | ') + ' |\n';
    }
    return s + '\n';
  }
  function blockOf(n) {
    if (n.nodeType === Node.TEXT_NODE) { const t = n.textContent.trim(); return t ? mdEscape(t) + '\n\n' : ''; }
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    if (n.classList.contains('tp-frontmatter')) return '---\n' + (n.dataset.fm || '') + '\n---\n\n';
    if (n.classList.contains('tp-formula-block')) return wrapBlock(n) + '\n\n';
    // Инлайн-формула может оказаться и прямым ребёнком корня: блочная формула внутри абзаца
    // разрывает <p> (div в p недопустим), и хвост абзаца вываливается наружу. Без этой ветки
    // span уходил в default → inlineOf → и формула превращалась в текст KaTeX-рендера
    // («xix\_ixi») — молчаливая потеря содержимого при первом же сохранении.
    if (n.classList.contains('tp-formula-inline')) return wrapInline(n);
    const tag = n.tagName.toLowerCase();
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return '#'.repeat(+tag[1]) + ' ' + inlineOf(n).trim() + '\n\n';
      case 'ul': return listOf(n, false, 0);
      case 'ol': return listOf(n, true, 0);
      case 'pre': return codeBlockOf(n);
      case 'table': return tableOf(n);
      case 'hr': return '---\n\n';
      case 'blockquote': {
        const inner = hasBlockChild(n) ? [...n.childNodes].map(blockOf).join('').trim() : inlineOf(n).trim();
        return inner.split('\n').map((l) => (l.trim() ? '> ' + l : '>')).join('\n') + '\n\n';
      }
      default: {
        if (hasBlockChild(n)) { let s = ''; n.childNodes.forEach((c) => { s += blockOf(c); }); return s; }
        const t = inlineOf(n).trim();
        return t ? t + '\n\n' : '';
      }
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
  // Список агентов задаёт main (встроенные + ~/.LiteEditorAI/tpAgents.json) — тут только выбранный id.
  let agentList = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }, { id: 'gemini', label: 'Gemini' }];
  let chatAgent = settings.tpAgent || 'claude';
  // Режим работы с ИИ. 'chat' — агент отвечает текстом, файлы правит редактор (как было всегда).
  // 'agent' — CLI запускается с авто-одобрением и правит файл на диске сам. Второй режим НЕ
  // сохраняется между запусками: включать его должно быть осознанным действием каждый раз.
  let aiMode = 'chat';
  let chatRole = 'Без роли';
  let chatLog = [];
  let aiSeq = 0;
  // Скрепка: прикладывать ли документ к сообщению. Раньше документ уходил агенту ВСЕГДА, и
  // спросить «а как правильно пишется?» было нельзя — на любую фразу приходил переписанный текст.
  let attachCtx = settings.tpAttach !== false;
  let treeSortMode = 'az';
  
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

  // ---- helpers ----
  function getActiveEditor() { return mode === 'wysiwyg' ? $('#doc-editor-wysiwyg') : $('#doc-editor-md'); }
  function currentMarkdown() { return mode === 'wysiwyg' ? htmlToMd($('#doc-editor-wysiwyg')) : $('#doc-editor-md').textContent; }
  function currentHtml() { return mode === 'wysiwyg' ? $('#doc-editor-wysiwyg').innerHTML : mdToHtml($('#doc-editor-md').textContent); }
  function htmlDocWrap(inner) { return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + inner + '</body></html>'; }
  function markDirty() {
    dirty = true;
    scheduleOutline();
    if (typeof saveCurrentTabState === 'function') { saveCurrentTabState(); if (typeof renderTabsUI === 'function') renderTabsUI(); }
    scheduleAutosave();
  }
  function updateStatus(text) {
    if (text != null) $('#doc-status-label').textContent = text;
    $('#doc-name-label').textContent = currentName;
  }
  function updateThumb(container, activeBtn) {
    if (!container || !activeBtn) return;
    const thumb = container.querySelector('.tp-seg-thumb');
    if (!thumb) return;
    
    const apply = () => {
      if (activeBtn.offsetWidth > 0) {
        thumb.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
        thumb.style.width = `${activeBtn.offsetWidth}px`;
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
    $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(html, SANITIZE);
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

    $('#doc-toggle-inspector').onclick = () => $('#doc-inspector').classList.toggle('collapsed');
    const toggleSidebarBtn = $('#doc-toggle-sidebar');
    if (toggleSidebarBtn) toggleSidebarBtn.onclick = toggleSidebar;

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
      btn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        // Закрываем чужие меню, но НЕ те, внутри которых сами лежим: выпадашки масштаба/интервала
        // могут быть перенесены в «⋯», и закрытие предка спрятало бы их вместе с собой.
        $$('.tp-dd-menu').forEach((m) => { if (!m.contains(dd)) m.hidden = true; });
        menu.hidden = !wasHidden;
      };
      dd.querySelectorAll('.tp-dd-item').forEach(item => {
        item.onclick = (e) => {
          e.stopPropagation();
          menu.hidden = true;
          dd.querySelectorAll('.tp-dd-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          btn.querySelector('span:first-child').textContent = item.textContent;
          if (dd.id === 'doc-zoom-dd') {
            applyZoom(parseFloat(item.dataset.val) || 1);
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
    });
    
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tp-dropdown')) {
        $$('.tp-dd-menu').forEach(m => m.hidden = true);
      }
    });

    // Масштаб: колесо с Ctrl (и пинч тачпада — он приходит тем же событием) + Ctrl +/−/0.
    const workspace = document.querySelector('.tp-workspace');
    if (workspace) {
      workspace.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        applyZoom(curZoom - e.deltaY * 0.01);
      }, { passive: false });
    }
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(curZoom + 0.1); }
      else if (e.key === '-') { e.preventDefault(); applyZoom(curZoom - 0.1); }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1); }
    });
    applyZoom(curZoom); // восстановить сохранённый масштаб

    $$('[data-color]').forEach((node) => {
      node.onclick = (e) => { e.preventDefault(); execCmd('foreColor', node.dataset.color); };
      node.onmousedown = (e) => e.preventDefault();
    });
    const colorPicker = $('#doc-color-picker');
    if (colorPicker) colorPicker.oninput = (e) => execCmd('foreColor', e.target.value);

    $('#doc-undo-btn').onclick = () => { getActiveEditor().focus(); document.execCommand('undo'); };
    $('#doc-redo-btn').onclick = () => { getActiveEditor().focus(); document.execCommand('redo'); };

    loadAgents();
    renderRoles();
    renderSymbols();
    const agentsBtn = $('#doc-ai-agents-cfg');
    if (agentsBtn) agentsBtn.onclick = showAgentsEditor;
    $$('#doc-ai-mode .tp-seg-btn[data-aimode]').forEach((b) => { b.onclick = () => requestAiMode(b.dataset.aimode); });
    updateAiModeUI();

    const fi = $('#doc-formula-input');
    fi.oninput = renderFormulaCardPreview;
    $('#doc-formula-blockmode').onchange = renderFormulaCardPreview;
    $('#doc-formula-insert').onclick = insertFormulaFromCard;

    $('#doc-open-btn').onclick = openFile;
    $('#doc-save-btn').onclick = saveFile;
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    });

    $('#doc-ai-chat-send').onclick = () => { if (busyReq) { lite.tp.cancel(busyReq); return; } sendChat(); };
    $('#doc-ai-chat-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };
    const attachBtn = $('#doc-ai-attach');
    if (attachBtn) attachBtn.onclick = () => {
      attachCtx = !attachCtx;
      settings.tpAttach = attachCtx; saveSettings();
      updateAttachUI();
    };

    $('#doc-editor-wysiwyg').addEventListener('input', markDirty);
    $('#doc-editor-md').addEventListener('input', markDirty);
    $('#doc-editor-wysiwyg').addEventListener('click', (e) => {
      const btn = e.target.closest('.tp-formula-toggle');
      if (btn) { e.preventDefault(); btn.parentElement.classList.toggle('show-src'); }
    });

    setupPillOverflow();
    applyCardOrder();
    setupCardsDnD();
    updateModeUI();
    setTab('ai');
    updateStatus('Новый файл');
    renderChatLog();
    updateAttachUI();
  }

  // Скрепка: вид кнопки + подсказка контекста. Держим в одном месте — состояние читают оба.
  function updateAttachUI() {
    const btn = $('#doc-ai-attach');
    if (btn) {
      btn.classList.toggle('on', attachCtx);
      btn.title = attachCtx ? 'Документ приложен — снять' : 'Приложить документ к сообщению';
    }
    const ta = $('#doc-ai-chat-input');
    if (ta) ta.placeholder = attachCtx ? 'Что сделать с текстом?' : 'Спросить агента (без документа)';
    updateCtxIndicator();
  }

  // ---- Масштаб страницы -----------------------------------------------------------------------
  // Раньше страница масштабировалась через transform: scale(). Визуально это работает, но раскладку
  // НЕ меняет: .tp-canvas продолжает считать страницу прежнего размера, поэтому при увеличении низ
  // документа было не доскроллить, а при уменьшении оставалась пустая полоса; в разделённом окне
  // отмасштабированный слой ещё и наезжал на инспектор (жалоба из PR #10). CSS-свойство zoom в
  // Chromium (а у нас только он) пересчитывает раскладку по-настоящему — скролл и попадание курсора
  // остаются честными.
  const ZOOM_MIN = 0.25, ZOOM_MAX = 3;
  let curZoom = (() => { const v = parseFloat(settings.tpZoom); return v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1; })();
  function applyZoom(val) {
    curZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(val * 100) / 100));
    const page = document.querySelector('.tp-page');
    if (page) page.style.zoom = String(curZoom);
    const label = document.querySelector('#doc-zoom-dd .tp-dd-btn span:first-child');
    if (label) label.textContent = Math.round(curZoom * 100) + '%';
    document.querySelectorAll('#doc-zoom-dd .tp-dd-item').forEach((i) => {
      i.classList.toggle('active', Math.abs(parseFloat(i.dataset.val) - curZoom) < 0.001);
    });
    settings.tpZoom = curZoom; saveSettings();
  }

  // ---- Тулбар: лишние кнопки уезжают в «⋯» -----------------------------------------------------
  // Пилл форматирования — flex фиксированной высоты: в узком окне кнопки сжимались и наезжали друг
  // на друга (жалоба из PR #10). Переносим хвост в выпадающее меню, а не сжимаем. Узлы ИМЕННО
  // переносим (appendChild), а не клонируем — обработчики висят на самих кнопках.
  let pillOrder = null;
  function refitPill() {
    const pill = $('#doc-format-pill');
    const more = $('#doc-pill-more');
    const menu = $('#doc-pill-overflow');
    if (!pill || !more || !menu) return;
    if (!pillOrder) pillOrder = Array.from(pill.children).filter((n) => n !== more);
    pillOrder.forEach((n) => pill.insertBefore(n, more)); // всё обратно в исходном порядке
    more.hidden = true;
    menu.hidden = true;
    const fits = () => pill.scrollWidth <= pill.clientWidth + 1;
    if (fits()) return;
    more.hidden = false;
    for (let i = pillOrder.length - 1; i >= 0 && !fits(); i--) menu.insertBefore(pillOrder[i], menu.firstChild);
    // Ведущий разделитель в меню — мусор: убираем, пока он первый.
    while (menu.firstChild && menu.firstChild.classList && menu.firstChild.classList.contains('tp-pill-sep')) {
      pill.insertBefore(menu.firstChild, more);
    }
  }
  function setupPillOverflow() {
    const pill = $('#doc-format-pill');
    if (!pill || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => refitPill());
    ro.observe(pill.parentElement || pill);
    refitPill();
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
    else { $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(mdToHtml($('#doc-editor-md').textContent), SANITIZE); }
    mode = m;
    updateModeUI();
    if (activeInspectorTab === 'outline') renderOutline();
  }
  function updateModeUI() {
    let activeBtn = null;
    $$('.tp-seg-btn[data-mode]').forEach((b) => {
      const isActive = b.dataset.mode === mode;
      b.classList.toggle('active', isActive);
      if (isActive) activeBtn = b;
    });
    updateThumb($('#doc-mode-toggle'), activeBtn);
    $('#doc-editor-wysiwyg').hidden = mode !== 'wysiwyg';
    $('#doc-editor-md').hidden = mode !== 'markdown';
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
    const outline = $('#doc-panel-outline');
    if (outline) outline.hidden = t !== 'outline';
    activeInspectorTab = t;
    if (t === 'outline') renderOutline();
  }

  // ---- Содержание: навигация по заголовкам документа ------------------------------------------
  // Работает в обоих режимах: в «Разметке» — по элементам h1…h6, в «Markdown» — по строкам вида
  // «## Заголовок» (там DOM плоский, элементов заголовков просто нет).
  let activeInspectorTab = 'ai';
  let outlineT = null;
  function collectHeadings() {
    if (mode === 'markdown') {
      const src = $('#doc-editor-md').textContent || '';
      const out = [];
      let pos = 0, fence = false;
      for (const line of src.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;   // «#» внутри блока кода — не заголовок
        const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) out.push({ level: m[1].length, text: m[2], pos });
        pos += line.length + 1;
      }
      return out;
    }
    return Array.from($('#doc-editor-wysiwyg').querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map((node) => ({ level: +node.tagName[1], text: (node.textContent || '').trim(), node }))
      .filter((h) => h.text);
  }
  function gotoHeading(h) {
    if (mode === 'markdown') {
      // Скролл к строке: ставим Range на позицию заголовка в текстовом узле редактора.
      const ed = $('#doc-editor-md');
      const tn = ed.firstChild;
      if (!tn || tn.nodeType !== Node.TEXT_NODE) { ed.scrollIntoView({ block: 'start' }); return; }
      const r = document.createRange();
      const at = Math.min(h.pos, tn.length);
      r.setStart(tn, at); r.setEnd(tn, Math.min(at + 1, tn.length));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const rect = r.getBoundingClientRect();
      const canvas = document.querySelector('.tp-canvas');
      if (canvas && rect.height) canvas.scrollTop += rect.top - canvas.getBoundingClientRect().top - 80;
      ed.focus();
      return;
    }
    if (h.node) h.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function renderOutline() {
    const box = $('#doc-outline');
    if (!box) return;
    const items = collectHeadings();
    box.innerHTML = '';
    if (!items.length) {
      box.appendChild(el('div', 'tp-outline-empty', 'Заголовков нет. Разметьте текст: «# Заголовок», «## Подзаголовок».'));
      return;
    }
    const min = Math.min(...items.map((h) => h.level));
    items.forEach((h) => {
      const row = el('button', 'tp-outline-item lvl' + Math.min(h.level - min, 3), h.text);
      row.type = 'button';
      row.title = h.text;
      row.onclick = () => gotoHeading(h);
      box.appendChild(row);
    });
  }
  // Содержание живое: правки заголовков видны без переключения вкладок (но перерисовываем
  // только когда вкладка открыта — на каждый набранный символ строить список незачем).
  function scheduleOutline() {
    if (activeInspectorTab !== 'outline') return;
    clearTimeout(outlineT);
    outlineT = setTimeout(renderOutline, 400);
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
      // ⚠️ window.cm в проекте никто не присваивает — ветка сейчас недостижима, и в markdown
      // кнопка всегда вставляет нумерованный список. Обращение через window, чтобы это не было
      // ещё и ReferenceError, если экземпляр CodeMirror когда-нибудь начнут туда класть.
      if (mode === 'markdown' && window.cm) {
        window.cm.setOption('lineNumbers', !window.cm.getOption('lineNumbers'));
      } else {
        document.execCommand('insertOrderedList');
      }
      return markDirty();
    }

    try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
    getActiveEditor().focus();
    document.execCommand(cmd, false, val);
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
    const tabId = activeTabId, file = currentFile;
    const isHtml = /\.html?$/i.test(file);
    // Ровно та же осторожность, что в автосейве: снимаем «не сохранено» только с того текста,
    // который реально ушёл на диск, и только со СВОЕЙ вкладки (см. комментарий в scheduleAutosave).
    for (let pass = 0; pass < 3; pass++) {
      const content = isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown();
      const r = await lite.fs.writeFile(file, content);
      if (!r || r.error) { toast('Ошибка сохранения: ' + ((r && r.error) || 'ошибка записи'), { kind: 'err' }); return false; }
      if (activeTabId !== tabId) return true;
      if (content !== (isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown())) continue; // печатали во время записи
      dirty = false;
      saveCurrentTabState();
      renderTabsUI();
      updateStatus('Сохранено · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
      toast('Файл сохранён');
      return true;
    }
    scheduleAutosave();
    return false;
  }
  async function saveFileAs() {
    if (!lite.tp.saveFileAs) { toast('Нативный диалог недоступен', { kind: 'err' }); return false; }
    // Формат — по тому, что открыто (как в saveFile): раньше «Сохранить как» всегда отдавал markdown,
    // и открытый .html молча превращался в md-текст.
    const wasHtml = /\.html?$/i.test(currentFile || currentName || '');
    const r = await lite.tp.saveFileAs({
      content: wasHtml ? htmlDocWrap(currentHtml()) : currentMarkdown(),
      name: currentName, ext: wasHtml ? 'html' : 'md',
    });
    if (!r || r.canceled) return false;
    if (!r.ok) { toast(r.error || 'Не удалось сохранить файл', { kind: 'err' }); return false; }
    // Пользователь мог сменить расширение прямо в диалоге — приводим содержимое к выбранному формату.
    const nowHtml = /\.html?$/i.test(r.file || '');
    if (nowHtml !== wasHtml) {
      const fixed = nowHtml ? htmlDocWrap(currentHtml()) : currentMarkdown();
      const w = await lite.fs.writeFile(r.file, fixed);
      if (w && w.error) { toast('Ошибка сохранения: ' + w.error, { kind: 'err' }); return false; }
    }
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
      const tabId = activeTabId, file = currentFile;
      const isHtml = /\.html?$/i.test(file);
      const content = isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown();
      const r = await lite.fs.writeFile(file, content);
      if (!r || r.error) return;
      // Пока шла запись, человек мог печатать дальше или уйти на другую вкладку. `dirty` и
      // saveCurrentTabState() относятся к АКТИВНОЙ вкладке — снимать флаг вслепую нельзя:
      // на чужой вкладке это пометило бы её несохранённые правки сохранёнными (и closeTab
      // закрыл бы её без вопроса), а на своей — потеряло бы набранное за время записи.
      if (activeTabId !== tabId) return;               // ушли на другую вкладку — флаг снимет её собственное сохранение
      if (content !== (isHtml ? htmlDocWrap(currentHtml()) : currentMarkdown())) { scheduleAutosave(); return; }
      dirty = false;
      saveCurrentTabState(); renderTabsUI();
      updateStatus('Автосохранено · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
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
  function selForChat() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && getActiveEditor().contains(sel.anchorNode)) return { text: sel.toString(), whole: false };
    return { text: currentMarkdown(), whole: true };
  }
  function renderChatLog() {
    const box = $('#doc-ai-chat-log');
    box.innerHTML = '';
    chatLog.forEach((m) => {
      const w = el('div', 'tp-msg ' + m.role);
      if (m.reqId) w.dataset.req = m.reqId; // якорь для in-place стриминга (tp:data)
      const b = el('div', 'tp-bubble' + (m.failed ? ' tp-bubble-err' : ''));
      b.textContent = m.busy ? (m.text + ' ⏳') : m.text;
      // Команда входа — отдельной кнопкой: набирать её из текста ошибки руками неудобно.
      if (m.loginCmd) {
        const acts = el('div', 'tp-bubble-actions');
        const copyBtn = el('button', 'tp-bubble-replace', 'Скопировать команду входа');
        copyBtn.title = m.loginCmd;
        copyBtn.type = 'button';
        copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(m.loginCmd); toast('Команда скопирована ✓'); }
          catch (e) { toast('Не удалось скопировать команду', { kind: 'err' }); }
        };
        acts.appendChild(copyBtn);
        b.appendChild(acts);
      }
      // «Заменить» — только у настоящего ответа: ошибку агента вставлять в документ незачем.
      if (m.role === 'agent' && !m.busy && !m.failed) {
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
    parts.push(instruction);
    // Скрепка снята — это просто вопрос. Без фрагмента требование «верни ТОЛЬКО текст замены»
    // бессмысленно и вредно: агент отвечал бы переписанным пустым местом вместо ответа.
    if (sel) {
      parts.push('Ниже — ' + (sel.whole ? 'весь документ (Markdown)' : 'фрагмент текста') + '. Верни ТОЛЬКО итоговый текст для замены: без пояснений, без приветствий.');
      parts.push('===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
    }
    return parts.join('\n\n');
  }
  // Перечитать документ с диска: после агент-режима файл на диске новее того, что в окне.
  async function reloadFromDisk() {
    if (!currentFile) return;
    const r = await lite.fs.readFile(currentFile);
    if (!r || r.error) { toast(tf('Агент отработал, но файл не перечитать: {0}', (r && r.error) || '—'), { kind: 'err' }); return; }
    const tab = openTabs.find((t) => t.id === activeTabId);
    const html = mdToHtml(r.content);
    $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(html, SANITIZE);
    $('#doc-editor-md').textContent = r.content;
    if (tab) { tab.html = html; tab.md = r.content; tab.dirty = false; }
    dirty = false;
    renderTabsUI();
    updateStatus(tf('Обновлён агентом · {0}', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })));
    if (activeInspectorTab === 'outline') renderOutline();
  }
  // Промпт агент-режима: файл он открывает сам, поэтому в тексте — путь и задача, без «верни текст».
  function composeAgentPrompt(instruction) {
    return [
      'Файл: ' + currentFile,
      instruction,
      'Внеси правки прямо в этот файл. Не создавай копий и не трогай другие файлы без необходимости.',
    ].join('\n\n');
  }
  async function sendChat() {
    const ta = $('#doc-ai-chat-input');
    const instruction = ta.value.trim();
    if (!instruction) return;
    const agentMode = aiMode === 'agent';
    if (agentMode) {
      if (!currentFile) { toast('Агент-режим работает с файлом на диске — сохраните документ', { kind: 'warn' }); return; }
      // Сохраняем ПЕРЕД запуском: иначе агент правит одну версию файла, а окно держит другую.
      if (dirty && !(await saveFile())) { toast('Файл не сохранён — агент не запущен', { kind: 'err' }); return; }
    }
    const sel = (!agentMode && attachCtx) ? selForChat() : null;
    ta.value = '';
    chatLog.push({ role: 'user', text: instruction });
    const am = { role: 'agent', text: '', busy: true, reqId: 'tpq' + (++aiSeq), agentMode };
    chatLog.push(am);
    while (chatLog.length > 200) chatLog.shift(); // кап истории: чат не растёт бесконечно
    renderChatLog();
    updateSendButton();
    const offData = lite.tp.onData(({ reqId: r, chunk }) => { if (r !== am.reqId) return; am.text += chunk; updateStreamBubble(am); });
    const offDone = lite.tp.onDone(async ({ reqId: r, text }) => {
      if (r !== am.reqId) return;
      am.busy = false; am.text = text || '';
      cleanup(); renderChatLog();
      if (agentMode) await reloadFromDisk();
    });
    const offErr = lite.tp.onError(({ reqId: r, error, authRequired, loginCmd }) => {
      if (r !== am.reqId) return;
      am.busy = false; am.failed = true;
      am.text = authRequired ? String(error) : ('Ошибка: ' + String(error));
      if (authRequired && loginCmd) am.loginCmd = loginCmd;
      cleanup(); renderChatLog();
      // Агент мог успеть что-то записать до остановки — показываем актуальный файл, а не старый.
      if (agentMode) reloadFromDisk();
    });
    const cleanup = () => { busyReq = null; updateSendButton(); try { offData(); offDone(); offErr(); } catch (_) {} };

    busyReq = am.reqId;
    const prompt = agentMode ? composeAgentPrompt(instruction) : await composePrompt(sel, instruction);
    lite.tp.run({ reqId: am.reqId, agent: chatAgent, prompt, mode: agentMode ? 'agent' : 'chat', cwd: agentMode ? dirOf(currentFile) : undefined });
  }
  // Пока агент работает, кнопка отправки становится «Стоп»: до сих пор запущенный процесс нельзя
  // было прервать ничем, кроме таймаута, — а в агент-режиме он всё это время правит файлы.
  let busyReq = null;
  function updateSendButton() {
    const btn = $('#doc-ai-chat-send');
    if (!btn) return;
    const busy = !!busyReq;
    btn.classList.toggle('stopping', busy);
    btn.title = busy ? 'Остановить агента' : 'Отправить';
    btn.dataset.icon = busy ? 'stop' : 'send';
    btn.innerHTML = '';
    btn.appendChild(icon(busy ? 'stop' : 'send', 16));
  }
  // Перечень моделей — из main: встроенные + пользовательские (tpAgents.json). Поэтому строим
  // сегмент заново на каждый renderModels: список может поменяться после правки настроек.
  async function loadAgents() {
    try {
      const r = await lite.tp.agents();
      if (r && r.ok && Array.isArray(r.list) && r.list.length) agentList = r.list;
    } catch (_) { /* остаёмся на встроенном списке */ }
    if (!agentList.some((a) => a.id === chatAgent)) chatAgent = agentList[0].id;
    renderModels();
  }
  function renderModels() {
    const box = $('#doc-ai-models');
    if (!box) return;
    box.innerHTML = '<span class="tp-seg-thumb"></span>';
    let activeBtn = null;
    agentList.forEach((a) => {
      const btn = el('button', 'tp-seg-btn' + (chatAgent === a.id ? ' active' : ''), a.label || a.id);
      btn.type = 'button';
      btn.dataset.id = a.id;
      btn.onclick = () => { chatAgent = a.id; settings.tpAgent = a.id; saveSettings(); renderModels(); };
      box.appendChild(btn);
      if (chatAgent === a.id) activeBtn = btn;
    });
    // Need a tiny delay for layout to calculate offsetWidth if first time rendering
    requestAnimationFrame(() => updateThumb(box, activeBtn));
  }

  // ---- Режим «Агент»: CLI правит файл сам ------------------------------------------------------
  // Плата за автономность — отсутствие подтверждений: агент применяет правки без спроса. Поэтому
  // режим включается только осознанно и только там, где есть что править: документ должен лежать
  // на диске (каталог файла станет рабочим), а перед запуском он принудительно сохраняется —
  // иначе агент правит одну версию, а окно держит другую, и любое автосохранение затрёт чужую работу.
  function updateAiModeUI() {
    let activeBtn = null;
    $$('#doc-ai-mode .tp-seg-btn[data-aimode]').forEach((b) => {
      const on = b.dataset.aimode === aiMode;
      b.classList.toggle('active', on);
      if (on) activeBtn = b;
    });
    updateThumb($('#doc-ai-mode'), activeBtn);
    const ta = $('#doc-ai-chat-input');
    if (ta && aiMode === 'agent') ta.placeholder = 'Что поручить агенту? Он изменит файл сам';
    else updateAttachUI();
  }
  function setAiMode(m) { aiMode = m; updateAiModeUI(); }
  async function requestAiMode(m) {
    if (m === aiMode) return;
    if (m !== 'agent') { setAiMode('chat'); return; }
    if (!currentFile) {
      toast('Агент-режим работает с файлом на диске — сохраните документ', { kind: 'warn' });
      updateAiModeUI();
      return;
    }
    const agent = agentList.find((a) => a.id === chatAgent);
    if (agent && agent.canAgent === false) {
      toast(tf('У агента «{0}» не задан режим правки файлов', agent.label || agent.id), { kind: 'warn' });
      updateAiModeUI();
      return;
    }
    const dir = dirOf(currentFile);
    const underGit = await isUnderGit(dir);
    const text = underGit
      ? tf('Агент будет сам изменять файлы в каталоге {0} — без подтверждения каждой правки. Каталог под git, правки можно откатить.', dir)
      : tf('Агент будет сам изменять файлы в каталоге {0} — без подтверждения каждой правки. Каталог НЕ под git, откатить правки будет нечем.', dir);
    showConfirm(
      'Включить режим «Агент»?', text,
      'Включить', () => setAiMode('agent'),
      'Отмена', () => updateAiModeUI(),
    );
  }
  function dirOf(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : s;
  }
  async function isUnderGit(dir) {
    try { const r = await lite.git.info(dir); return !!(r && !r.error && r.branch); }
    catch (_) { return false; }
  }

  // Редактор списка агентов: сам файл tpAgents.json, а не отдельная форма на каждое поле —
  // набор ключей у CLI разный, и форма устарела бы с первой же новой утилитой.
  const AGENTS_HINT = 'Массив записей. Поля: id (обязательно), label, cmd, args (массив), via ("arg" — промпт последним аргументом, "stdin" — на вход), pty (true для CLI, требующих TTY), hidden (true — убрать встроенного из списка). Пустой файл = только встроенные.';
  async function showAgentsEditor() {
    let raw = '', file = '';
    try { const r = await lite.tp.agents(); if (r && r.ok) { raw = r.raw || ''; file = r.file || ''; } }
    catch (_) { /* редактируем с нуля */ }
    const { m, close } = makeModal(`
      <h2 class="cm-title">Агенты</h2>
      <div class="about-desc tp-agents-hint"></div>
      <textarea id="tp-agents-json" class="tp-agents-json" spellcheck="false" rows="12"></textarea>
      <div class="tp-agents-file"></div>
      <div class="modal-actions">
        <button id="tp-agents-cancel" class="btn">Отмена</button>
        <button id="tp-agents-save" class="btn primary">Сохранить</button>
      </div>`);
    m.querySelector('.tp-agents-hint').textContent = AGENTS_HINT;
    m.querySelector('.tp-agents-file').textContent = file;
    const ta = m.querySelector('#tp-agents-json');
    ta.value = raw || JSON.stringify([{ id: 'agy', label: 'Antigravity', cmd: 'agy', args: ['-p'], via: 'arg', pty: true }], null, 2);
    ta.focus();
    m.querySelector('#tp-agents-cancel').onclick = close;
    m.querySelector('#tp-agents-save').onclick = async () => {
      const r = await lite.tp.saveAgents(ta.value);
      if (!r || !r.ok) { toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' }); return; }
      close();
      await loadAgents();
      toast('Список агентов обновлён');
    };
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

  // Контекст для AI-панели: что именно уйдёт агенту при следующем сообщении.
  function updateCtxIndicator() {
    const ctxText = $('#doc-ai-ctx-text');
    if (!ctxText) return;
    if (!attachCtx) {
      ctxText.textContent = 'Документ не приложен — обычный разговор. Скрепка слева от поля ввода прикладывает текст.';
      ctxText.classList.remove('filled');
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && getActiveEditor().contains(sel.anchorNode)) {
      const text = sel.toString();
      if (text.trim()) { ctxText.textContent = text.slice(0, 100) + (text.length > 100 ? '…' : ''); ctxText.classList.add('filled'); return; }
    }
    ctxText.textContent = 'Выделите фрагмент в документе — он попадёт сюда. Ответ можно вставить кнопкой «Заменить».';
    ctxText.classList.remove('filled');
  }
  document.addEventListener('selectionchange', () => { if (docOpen) updateCtxIndicator(); });

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
      if (openTabs.length === 0) createNewTab();
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
    if (!sidebar.classList.contains('hidden') && activeProj) {
      renderTree(activeProj);
    }
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

  if (btnSort) btnSort.onclick = () => {
    treeSortMode = (treeSortMode === 'az') ? 'za' : 'az';
    if (activeProj) renderTree(activeProj);
  };

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
        const dirs = entries.filter(e => e.dir).sort((a,b) => {
          if (treeSortMode === 'za') return b.name.localeCompare(a.name);
          return a.name.localeCompare(b.name);
        });
        const files = entries.filter(e => !e.dir && (e.name.endsWith('.md') || e.name.endsWith('.txt') || e.name.endsWith('.docx'))).sort((a,b) => {
          if (treeSortMode === 'za') return b.name.localeCompare(a.name);
          return a.name.localeCompare(b.name);
        });
        
        for (const d of dirs) {
          if (d.name === 'Roles' || d.name === '.git' || d.name === 'node_modules') continue;
          
          const folderDiv = document.createElement('div');
          folderDiv.className = 'tp-tree-folder';
          
          const header = document.createElement('div');
          header.className = 'tp-tree-folder-header';
          
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
          item.className = 'tp-tree-item';
          
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

  // Пути, которые СЕЙЧАС читаются с диска. Клик по файлу в дереве открывает вкладку, но между
  // кликом и появлением вкладки идёт await: двойной клик (обычный жест в дереве файлов) успевал
  // пройти проверку «уже открыт» дважды и заводил ДВЕ вкладки одного файла. Дальше правки в одной
  // затирались сохранением другой — тихая потеря текста.
  const openingFiles = new Set();
  async function openProjectFile(absPath) {
    // Check if already open
    let tab = openTabs.find(t => t.absPath === absPath);
    if (tab) {
      switchToTab(tab.id);
      return;
    }
    if (openingFiles.has(absPath)) return;
    openingFiles.add(absPath);
    try {
      await openProjectFileInner(absPath);
    } finally { openingFiles.delete(absPath); }
  }
  async function openProjectFileInner(absPath) {
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
      safeHtml = DOMPurify.sanitize(r.content, SANITIZE);
      const root = document.createElement('div');
      root.innerHTML = safeHtml;
      mdSrc = htmlToMd(root);
    }
    const tab = {
      id,
      absPath,
      name,
      html: isHtml ? safeHtml : mdToHtml(r.content),
      md: mdSrc,
      mode: 'wysiwyg',
      dirty: false
    };
    
    openTabs.push(tab);
    renderTabsUI();
    switchToTab(id);
  }

  function renderTabsUI() {
    tabsContainer.innerHTML = '';
    openTabs.forEach(t => {
      const el = document.createElement('div');
      el.className = 'tp-doc-tab' + (t.id === activeTabId ? ' active' : '');
      el.innerHTML = `<span>${escapeHtml(t.name)}${t.dirty ? '*' : ''}</span>`;
      
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tp-doc-tab-close';
      closeBtn.textContent = '×';
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
    addBtn.onclick = () => createNewTab();
    tabsContainer.appendChild(addBtn);
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
  }

  function saveCurrentTabState() {
    if (activeTabId === null) return;
    const tab = openTabs.find(t => t.id === activeTabId);
    if (tab) {
      tab.mode = mode;
      tab.dirty = dirty;
      tab.html = $('#doc-editor-wysiwyg').innerHTML;
      tab.md = $('#doc-editor-md').textContent;
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
    $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(tab.html, SANITIZE);
    $('#doc-editor-md').textContent = tab.md;
    updateModeUI();
    updateStatus(dirty ? 'Изменено' : (tab.absPath ? 'Открыт' : 'Новый файл'));
    if (activeInspectorTab === 'outline') renderOutline();

    renderTabsUI();
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
  }

  function onFsChange(proj, _files) {
    if (activeProj && activeProj.path === proj.path) {
      renderTree(proj);
    }
  }

  return {
    renderTree,
    onFsChange,
    isOpen: () => docOpen,
    setOpen: setDocOpen,
    toggle: () => setDocOpen(!docOpen),
    confirmClose,
  };
}
