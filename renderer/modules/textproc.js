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
  let text = String(src || '').replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (_, tex) => {
    const i = blocks.length; blocks.push(tex);
    return F_OPEN + 'B' + i + F_CLOSE;
  });
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
  const { el, icon, toast, showConfirm, settings, saveSettings, saveUiState, refitActiveTerminal, closeOtherPanels, layout, GUTTER, STORE, persist } = host;
  const lite = window.lite;

  let docOpen = false;
  let currentFile = null;
  let currentName = 'Безымянный';
  let mode = 'wysiwyg'; // 'wysiwyg' | 'markdown'
  let dirty = false;
  let openTabs = [];
  let activeTabId = null;
  let nextTabId = 1;
  // Восстанавливаем вкладки, открытые в прошлый раз (переживает перезапуск приложения —
  // до этого openTabs жил только в памяти и терялся при закрытии окна).
  let restoredActiveTabId = null;
  {
    const saved = STORE && STORE.textproc;
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      openTabs = saved.tabs.map((t) => ({
        id: t.id, absPath: t.absPath || null, name: t.name || 'Безымянный',
        html: t.html || '<p><br></p>', md: t.md || '',
        mode: t.mode === 'markdown' ? 'markdown' : 'wysiwyg', dirty: !!t.dirty,
        chatLog: Array.isArray(t.chatLog) ? t.chatLog : [],
        chatAgent: t.chatAgent || 'claude',
        chatRole: t.chatRole || 'Без роли'
      }));
      nextTabId = openTabs.reduce((m, t) => Math.max(m, t.id), 0) + 1;
      restoredActiveTabId = openTabs.some((t) => t.id === saved.activeTabId) ? saved.activeTabId : openTabs[0].id;
    }
  }
  let persistTabsTimer = null;
  function persistTabs() {
    if (typeof persist !== 'function') return;
    clearTimeout(persistTabsTimer);
    persistTabsTimer = setTimeout(() => {
      persist('textproc', {
        activeTabId,
        tabs: openTabs.map((t) => ({ 
          id: t.id, absPath: t.absPath, name: t.name, 
          html: t.html, md: t.md, mode: t.mode, dirty: t.dirty,
          chatLog: t.chatLog, chatAgent: t.chatAgent, chatRole: t.chatRole
        })),
      });
    }, 600);
  }
  const getActiveProj = () => host.activeProject();
  let chatAgent = ['claude', 'codex', 'antigravity'].includes(settings.tpAgent) ? settings.tpAgent : 'claude';
  let chatRole = 'Без роли';
  let chatLog = [];
  let aiSeq = 0;
  let treeSortMode = 'az';
  
  function fileBadge(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      docx: { cls: 'docx', text: 'DOC' },
      doc:  { cls: 'docx', text: 'DOC' },
      md:   { cls: 'md',   text: 'M↓'  },
      txt:  { cls: 'txt',  text: 'TXT' },
      pdf:  { cls: 'pdf',  text: 'PDF' },
      html: { cls: 'html', text: '<>'  },
      json: { cls: 'json', text: '{ }' },
      canvas: { cls: 'canvas', text: '🎨' },
      csv:  { cls: 'csv',  text: 'CSV' },
      png:  { cls: 'img',  text: 'IMG' },
      jpg:  { cls: 'img',  text: 'IMG' },
      jpeg: { cls: 'img',  text: 'IMG' },
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
    if (typeof saveCurrentTabState === 'function') { saveCurrentTabState(); if (typeof renderTabsUI === 'function') renderTabsUI(); }
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
    $('#doc-editor-wysiwyg').innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['contenteditable', 'data-tex'] });
    $('#doc-editor-md').textContent = '';
    dirty = false;
    updateModeUI();
  }

  // ---- UI Setup ----
  function setupUI() {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}

    $$('.tp-seg-btn[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $$('.tp-tab[data-tab]').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

    $('#doc-toggle-inspector').onclick = () => $('#doc-inspector').classList.toggle('collapsed');
    const toggleSidebarBtn = $('#doc-toggle-sidebar');
    if (toggleSidebarBtn) toggleSidebarBtn.onclick = toggleSidebar;
    const numBtn = $('#doc-toggle-numbering');
    if (numBtn) {
      numBtn.onclick = () => {
        settings.tpShowParaNum = !settings.tpShowParaNum;
        saveSettings();
        updateNumberingUI();
      };
      updateNumberingUI();
    }
    const wysiwygEl = $('#doc-editor-wysiwyg');
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
      btn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        $$('.tp-dd-menu').forEach(m => m.hidden = true);
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
            const val = parseFloat(item.dataset.val) || 1;
            const page = document.querySelector('.tp-page');
            if (page) {
              page.style.transform = `scale(${val})`;
              page.style.transformOrigin = 'top center';
            }
            window.tpCurrentZoom = val;
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

    // Touchpad Pinch-to-Zoom
    window.tpCurrentZoom = window.tpCurrentZoom || 1;
    const workspace = document.querySelector('.tp-workspace');
    if (workspace) {
      workspace.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const zoomSpeed = 0.01;
          window.tpCurrentZoom -= e.deltaY * zoomSpeed;
          window.tpCurrentZoom = Math.max(0.25, Math.min(window.tpCurrentZoom, 3.0));

          const page = document.querySelector('.tp-page');
          if (page) {
            page.style.transform = `scale(${window.tpCurrentZoom})`;
            page.style.transformOrigin = 'top center';
          }

          const zoomBtn = document.querySelector('#doc-zoom-dd .tp-dd-btn span:first-child');
          if (zoomBtn) {
            zoomBtn.textContent = Math.round(window.tpCurrentZoom * 100) + '%';
          }
          document.querySelectorAll('#doc-zoom-dd .tp-dd-item').forEach(i => i.classList.remove('active'));
        }
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
    renderRoles();
    renderSymbols();

    const fi = $('#doc-formula-input');
    fi.oninput = renderFormulaCardPreview;
    $('#doc-formula-blockmode').onchange = renderFormulaCardPreview;
    $('#doc-formula-insert').onclick = insertFormulaFromCard;

    $('#doc-open-btn').onclick = openFile;
    $('#doc-save-btn').onclick = saveFile;

    $('#doc-ai-chat-send').onclick = sendChat;
    $('#doc-ai-chat-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };

    $('#doc-editor-wysiwyg').addEventListener('input', markDirty);
    $('#doc-editor-wysiwyg').addEventListener('input', scheduleScrubberUpdate);
    $('#doc-editor-md').addEventListener('input', markDirty);
    const scrubTrack = $('#doc-scrubber-track');
    if (scrubTrack) {
      scrubTrack.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('tp-scrubber-tick')) return; // клик по метке — свой обработчик (переход), не drag
        scrubberDragging = true;
        handleScrubberDrag(e);
      });
      window.addEventListener('mousemove', (e) => { if (scrubberDragging) handleScrubberDrag(e); });
      window.addEventListener('mouseup', () => { scrubberDragging = false; });
    }
    const canvasEl = document.querySelector('.tp-canvas');
    if (canvasEl) canvasEl.addEventListener('scroll', updateScrubberThumb);
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
    $('#doc-editor-wysiwyg').hidden = mode !== 'wysiwyg';
    $('#doc-editor-md').hidden = mode !== 'markdown';
    updateNumberingUI();
    renderScrubber();
  }
  // Номера абзацев — только в WYSIWYG (в исходном Markdown они не имеют смысла).
  function updateNumberingUI() {
    const btn = $('#doc-toggle-numbering');
    const on = !!settings.tpShowParaNum && mode === 'wysiwyg';
    $('#doc-editor-wysiwyg').classList.toggle('tp-numbered', on);
    if (btn) {
      btn.classList.toggle('on', on);
      btn.disabled = mode !== 'wysiwyg';
      btn.style.opacity = mode !== 'wysiwyg' ? '0.4' : '';
    }
  }

  // ---- Рейка-навигатор: метки заголовков + бегунок текущей позиции (рядом с обычным скроллом) ----
  let scrubberDragging = false;
  let scrubberDebounceTimer = null;
  function computeHeadingMarks() {
    const doc = $('#doc-editor-wysiwyg');
    if (!doc) return [];
    const total = doc.scrollHeight || 1;
    return $$('#doc-editor-wysiwyg h1, #doc-editor-wysiwyg h2, #doc-editor-wysiwyg h3').map((h) => ({
      el: h,
      level: h.tagName.toLowerCase(),
      text: h.textContent.trim().slice(0, 60),
      ratio: Math.max(0, Math.min(1, h.offsetTop / total)),
    }));
  }
  function renderScrubber() {
    const track = $('#doc-scrubber-track');
    if (!track || mode !== 'wysiwyg') { if (track) track.innerHTML = ''; return; }
    const marks = computeHeadingMarks();
    track.innerHTML = '';
    marks.forEach((m) => {
      const tick = el('div', 'tp-scrubber-tick tp-scrubber-tick-' + m.level);
      tick.style.top = (m.ratio * 100) + '%';
      tick.title = m.text;
      tick.onclick = (e) => { e.stopPropagation(); m.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      track.appendChild(tick);
    });
    track.appendChild(el('div', 'tp-scrubber-thumb'));
    updateScrubberThumb();
  }
  function updateScrubberThumb() {
    const canvas = document.querySelector('.tp-canvas');
    const thumb = document.querySelector('#doc-scrubber-track .tp-scrubber-thumb');
    if (!canvas || !thumb) return;
    const maxScroll = canvas.scrollHeight - canvas.clientHeight;
    const ratio = maxScroll > 0 ? canvas.scrollTop / maxScroll : 0;
    thumb.style.top = (ratio * 100) + '%';
  }
  function handleScrubberDrag(e) {
    const track = $('#doc-scrubber-track');
    const canvas = document.querySelector('.tp-canvas');
    if (!track || !canvas) return;
    const r = track.getBoundingClientRect();
    let ratio = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    
    const ticks = track.querySelectorAll('.tp-scrubber-tick');
    let snapRatio = ratio;
    let minDiff = Infinity;
    ticks.forEach(tick => {
      const tr = parseFloat(tick.style.top) / 100;
      const diff = Math.abs(tr * r.height - ratio * r.height);
      if (diff < 10 && diff < minDiff) { minDiff = diff; snapRatio = tr; }
    });
    
    // Отключаем магнит на самых краях, чтобы можно было долистать до верха/низа
    if (ratio * r.height < 10) ratio = 0;
    else if (ratio * r.height > r.height - 10) ratio = 1;
    else ratio = snapRatio;

    canvas.scrollTop = ratio * (canvas.scrollHeight - canvas.clientHeight);
  }
  function scheduleScrubberUpdate() {
    clearTimeout(scrubberDebounceTimer);
    scrubberDebounceTimer = setTimeout(renderScrubber, 800);
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
  }

  function execCmd(cmd, val = null) {
    if (cmd === 'toggleColumns') {
      const s = window.getSelection();
      if (!s.rangeCount) return;
      const html = s.toString();
      if (html) document.execCommand('insertHTML', false, `<div class="tp-columns">${html}</div>`);
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
      openProjectFile(res.file, res.content);
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
  // Синхронизирует номера, которые видит AI, с номерами абзацев, которые видит пользователь
  // (см. .tp-doc.tp-numbered в CSS) — блоки Markdown разбиваются так же, как их видит marked.parse().
  function numberedMarkdownForAI(md) {
    const blocks = String(md || '').split(/\n{2,}/).filter((b) => b.trim().length);
    return blocks.map((b, i) => `[${i + 1}] ${b.trim()}`).join('\n\n');
  }
  function renderChatLog() {
    const box = $('#doc-ai-chat-log');
    box.innerHTML = '';
    chatLog.forEach((m) => {
      const w = el('div', 'tp-msg ' + m.role);
      const b = el('div', 'tp-bubble');
      b.textContent = m.busy ? (m.text + ' ⏳') : m.text;
      if (m.role === 'agent' && !m.busy && m.isReplacement) {
        const acts = el('div', 'tp-bubble-actions');
        const undoBtn = host.iconBtn('tp-bubble-undo', 'undo', 'Отменить автозамену (Cmd+Z)');
        undoBtn.onclick = () => {
          if (mode === 'markdown') { $('#doc-editor-md').focus(); }
          else { $('#doc-editor-wysiwyg').focus(); }
          document.execCommand('undo');
          markDirty();
          updateStatus('Автозамена отменена');
        };
        acts.appendChild(undoBtn);
        b.appendChild(acts);
      }
      w.appendChild(b);
      box.appendChild(w);
    });
    box.scrollTop = box.scrollHeight;
  }
  async function composePrompt(sel, instruction) {
    const parts = [];
    if (chatRole !== 'Без роли') {
      try {
        const content = await lite.fs.readFile(`${getActiveProj().path}/Roles/${chatRole}.md`);
        parts.push(`Действуй в роли: ${chatRole}\n${content}`);
      } catch (e) {
        parts.push(`Действуй в роли: ${chatRole}`);
      }
      parts.push(instruction);
      if (sel.whole) {
        parts.push('Ниже — весь документ (Markdown), разбитый на пронумерованные абзацы вида "[N] текст". Эти номера соответствуют номерам, которые пользователь видит рядом с абзацами в редакторе — используй их только чтобы понять, о каком абзаце идёт речь (например «исправь абзац 5» = блок [5]). Верни ТОЛЬКО итоговый текст для замены: без пояснений, без приветствий, без самих меток [N].');
        parts.push('===ФРАГМЕНТ===\n' + numberedMarkdownForAI(sel.text) + '\n===КОНЕЦ===');
      } else {
        parts.push('Ниже — фрагмент текста. Верни ТОЛЬКО итоговый текст для замены: без пояснений, без приветствий.');
        parts.push('===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
      }
    } else {
      parts.push(instruction);
      if (sel.whole) {
        parts.push('Текущий текст документа (для контекста):');
        parts.push('===ДОКУМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
      } else {
        parts.push('Текущий выделенный фрагмент текста (для контекста):');
        parts.push('===ФРАГМЕНТ===\n' + sel.text + '\n===КОНЕЦ===');
      }
    }
    return parts.join('\n\n');
  }
  async function sendChat() {
    const ta = $('#doc-ai-chat-input');
    const instruction = ta.value.trim();
    if (!instruction) return;
    const sel = selForChat();
    
    // Сохраняем точный Range выделения для автозамены, если выделен фрагмент
    let targetRange = null;
    const sysSel = window.getSelection();
    if (!sel.whole && sysSel && sysSel.rangeCount > 0) {
      targetRange = sysSel.getRangeAt(0).cloneRange();
    }
    
    ta.value = '';
    chatLog.push({ role: 'user', text: instruction });
    const isReplacement = chatRole !== 'Без роли';
    const am = { role: 'agent', text: '', busy: true, reqId: 'tpq' + (++aiSeq), isReplacement };
    chatLog.push(am);
    renderChatLog();
    const offData = lite.tp.onData(({ reqId: r, chunk }) => { if (r !== am.reqId) return; am.text += chunk; renderChatLog(); });
    const offDone = lite.tp.onDone(({ reqId: r, text }) => { 
      if (r !== am.reqId) return; 
      am.busy = false; 
      
      if (chatAgent === 'antigravity') {
        am.text = "Окно Antigravity открыто. ИИ редактирует файл. Как только изменения сохранятся, они мгновенно появятся здесь.";
        cleanup(); renderChatLog();
        return; // Gemini правит файл на диске, мы дождемся onFsChange
      }
      
      am.text = text || ''; 
      cleanup(); renderChatLog(); 
      
      // Автозамена текста
      if (isReplacement) {
        if (targetRange && am.text) {
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(targetRange);
          if (mode === 'markdown') { $('#doc-editor-md').focus(); document.execCommand('insertText', false, am.text); }
          else { $('#doc-editor-wysiwyg').focus(); document.execCommand('insertHTML', false, mdToHtml(am.text)); }
          markDirty();
          updateStatus('Текст изменён AI');
        } else if (sel.whole && am.text) {
          if (mode === 'markdown') { 
            $('#doc-editor-md').focus(); 
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, am.text); 
          } else { 
            $('#doc-editor-wysiwyg').focus(); 
            document.execCommand('selectAll', false, null);
            document.execCommand('insertHTML', false, mdToHtml(am.text)); 
          }
          markDirty();
          updateStatus('Документ изменён AI');
        }
      }
    });
    const offErr = lite.tp.onError(({ reqId: r, error }) => { if (r !== am.reqId) return; am.busy = false; am.text = 'Ошибка: ' + String(error); cleanup(); renderChatLog(); });
    const cleanup = () => { try { offData(); offDone(); offErr(); } catch (_) {} };
    
    const prompt = await composePrompt(sel, instruction);
    
    if (chatAgent === 'antigravity' && currentFile && dirty) {
      await saveFile(); // Сохраняем локальные правки перед вызовом внешнего редактора
    }
    
    lite.tp.run({ reqId: am.reqId, agent: chatAgent, prompt });
  }
  function renderModels() {
    const box = $('#doc-ai-models');
    if (!box.querySelector('button')) {
      box.innerHTML = '<span class="tp-seg-thumb"></span>';
      [['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Gemini']].forEach(([id, lbl]) => {
        const btn = el('button', 'tp-seg-btn', lbl);
        btn.type = 'button';
        btn.dataset.id = id;
        btn.onclick = () => { chatAgent = id; settings.tpAgent = id; saveSettings(); renderModels(); };
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
  async function loadRoles() {
    if (!getActiveProj()) return;
    try {
      const rolesPath = getActiveProj().path + '/Roles';
      const hasDir = await lite.fs.exists(rolesPath);
      if (!hasDir) {
        await lite.fs.mkdir(getActiveProj().path, 'Roles');
        await lite.fs.writeFile(rolesPath + '/Редактор.md', 'Исправь ошибки и опечатки.');
        await lite.fs.writeFile(rolesPath + '/Корректор.md', 'Сделай текст более профессиональным.');
        await lite.fs.writeFile(rolesPath + '/Переводчик.md', 'Переведи текст на английский язык.');
        await lite.fs.writeFile(rolesPath + '/Юрист.md', 'Перепиши текст в строгом юридическом стиле.');
      }
      const entries = await lite.fs.readDir(rolesPath);
      dynamicRoles = ['Без роли'];
      for (const ent of entries) {
        if (!ent.isDir && ent.name.endsWith('.md')) {
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
            openProjectFile(`${getActiveProj().path}/Roles/${r}.md`);
          }));
          dd.appendChild(host.menuRow('trash', 'Удалить', async () => {
            host.closeMenus();
            try {
              await lite.fs.trash(`${getActiveProj().path}/Roles/${r}.md`);
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
      if (!getActiveProj()) {
        toast('Сначала откройте проект в боковой панели', { kind: 'warn' });
        return;
      }
      host.showPrompt('Новая роль', 'Название роли:', 'Моя роль', async (val) => {
        if (!val) return;
        const newName = val.trim();
        if (!newName) return;
        
        try {
          const res = await lite.fs.writeFile(`${getActiveProj().path}/Roles/${newName}.md`, 'Действуй в роли...');
          if (res && res.error) {
            toast('Ошибка записи: ' + res.error, { kind: 'err' });
            return;
          }
          await loadRoles();
          if (typeof openProjectFile === 'function') {
            openProjectFile(`${getActiveProj().path}/Roles/${newName}.md`);
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

  // Контекст для AI-панели: выделенный в документе фрагмент
  document.addEventListener('selectionchange', () => {
    if (!docOpen) return;
    const ctxText = $('#doc-ai-ctx-text');
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && sel.toString().trim();
    if (ctxText) {
      if (hasSel) { 
        const text = sel.toString(); 
        ctxText.textContent = text.slice(0, 100) + (text.length > 100 ? '…' : ''); 
        ctxText.classList.add('filled'); 
      } else if (document.activeElement && document.activeElement.id !== 'doc-ai-chat-input') {
        ctxText.textContent = 'Выделите фрагмент в документе — он попадёт сюда. Ответ можно вставить кнопкой «Заменить».'; 
        ctxText.classList.remove('filled'); 
      }
    }
    if (!hasSel) {
      if (selPopupEl && selPopupEl.style.display !== 'none' && selPopupEl.contains(document.activeElement)) return;
      hideSelPopup();
    }
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
            $('#doc-inspector').classList.remove('collapsed');
            setTab('ai');
            sendChat();
          } else if (selText) {
            const current = aiInput.value.trim();
            aiInput.value = current ? current + '\n\n' + `"${selText}"` : `"${selText}"`;
            input.value = '';
            clearBtn.style.display = 'none';
            hideSelPopup();
            $('#doc-inspector').classList.remove('collapsed');
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
      if (openTabs.length === 0) createNewTab();
      else if (activeTabId === null) switchToTab(restoredActiveTabId != null ? restoredActiveTabId : openTabs[0].id);
    }
    setTimeout(refitActiveTerminal, 150);
  }
  function confirmClose(proceed) {
    if (!dirty) { proceed(); return; }
    showConfirm(
      'Несохранённые изменения',
      'В документе есть несохранённые изменения. Закрыть без сохранения?',
      'Закрыть без сохранения', proceed,
      'Сохранить и закрыть', async () => { const ok = await saveFile(); if (ok) proceed(); },
    );
  }

  // ---- Sidebar & Tabs Logic ----
  const sidebar = $('#doc-sidebar');
  const treeContainer = $('#doc-tree');
  const tabsContainer = $('#doc-tabs-container');

  function toggleSidebar() {
    sidebar.classList.toggle('hidden');
    if (!sidebar.classList.contains('hidden') && getActiveProj()) {
      renderTree(getActiveProj());
    }
  }

  const btnNewFile = $('#btn-tree-new-file');
  const btnNewFolder = $('#btn-tree-new-folder');
  const btnSort = $('#btn-tree-sort');
  const btnCollapse = $('#btn-tree-collapse');

  if (btnNewFile) btnNewFile.onclick = () => {
    if (!getActiveProj()) return;
    host.showPrompt('Новый файл', 'Имя файла (без .md):', 'Новая заметка', async (val) => {
      if (!val) return;
      let name = val.trim();
      if (!name) return;
      if (!name.includes('.')) name += '.md';
      try {
        await lite.fs.create(getActiveProj().path, name, false);
        await renderTree(getActiveProj());
        const sep = getActiveProj().path.includes('\\') ? '\\' : '/';
        const newPath = getActiveProj().path.endsWith(sep) ? (getActiveProj().path + name) : (getActiveProj().path + sep + name);
        openProjectFile(newPath);
      } catch (err) { host.toast('Ошибка: ' + err.message, {kind:'err'}); }
    });
  };

  if (btnNewFolder) btnNewFolder.onclick = () => {
    if (!getActiveProj()) return;
    host.showPrompt('Новая папка', 'Имя папки:', 'Новая папка', async (val) => {
      if (!val) return;
      let name = val.trim();
      if (!name) return;
      try {
        await lite.fs.create(getActiveProj().path, name, true);
        await renderTree(getActiveProj());
      } catch (err) { host.toast('Ошибка: ' + err.message, {kind:'err'}); }
    });
  };

  if (btnSort) btnSort.onclick = () => {
    treeSortMode = (treeSortMode === 'az') ? 'za' : 'az';
    if (getActiveProj()) renderTree(getActiveProj());
  };

  if (btnCollapse) btnCollapse.onclick = () => {
    document.querySelectorAll('.tp-tree-folder-children').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.tp-tree-folder-header .tp-tree-icon').forEach(icon => {
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    });
  };

  async function renderTree(proj) {
    
    loadRoles();
    if (sidebar.classList.contains('hidden')) return;
    if (!proj || !proj.path) return;
    try {
      treeContainer.innerHTML = '';
      
      if (!settings.tpHiddenPaths) {
        // Миграция со старого хранения по имени папки (settings.tpHiddenFolders) — переносим как есть,
        // это лучше, чем молча забыть про то, что было скрыто раньше.
        settings.tpHiddenPaths = Array.isArray(settings.tpHiddenFolders) ? settings.tpHiddenFolders.slice() : ['.obsidian'];
        host.saveSettings();
      }

      const actionsContainer = $('.tp-sidebar-actions');
      let btnHidden = $('#btn-tree-hidden');
      if (!btnHidden && actionsContainer && host.iconBtn) {
        btnHidden = host.iconBtn('tp-icon-btn sm', 'eye-off', '');
        btnHidden.id = 'btn-tree-hidden';
        btnHidden.onclick = () => {
          settings.tpRevealHidden = !settings.tpRevealHidden;
          host.saveSettings();
          renderTree(getActiveProj());
        };
        actionsContainer.appendChild(btnHidden);
      }
      if (btnHidden) {
        const revealing = !!settings.tpRevealHidden;
        btnHidden.title = revealing ? 'Скрытые показаны притушёнными — нажмите, чтобы снова скрыть' : 'Показать скрытые файлы и папки';
        btnHidden.classList.toggle('on', revealing);
        btnHidden.innerHTML = '';
        btnHidden.appendChild(icon(revealing ? 'eye' : 'eye-off', 16));
      }

      const relProjPath = (absPath) => {
        if (!proj.path || !absPath.startsWith(proj.path)) return absPath;
        return absPath.slice(proj.path.length).replace(/^[\\/]+/, '');
      };
      const isHiddenPath = (relPath) => (settings.tpHiddenPaths || []).includes(relPath);
      const setHidden = (relPath, hidden) => {
        if (!settings.tpHiddenPaths) settings.tpHiddenPaths = [];
        settings.tpHiddenPaths = settings.tpHiddenPaths.filter((p) => p !== relPath);
        if (hidden) settings.tpHiddenPaths.push(relPath);
        host.saveSettings();
        renderTree(getActiveProj());
      };

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
        const files = entries.filter(e => !e.dir && /\.(md|txt|docx?|pdf|html?|json|canvas|csv|png|jpe?g)$/i.test(e.name)).sort((a,b) => {
          if (treeSortMode === 'za') return b.name.localeCompare(a.name);
          return a.name.localeCompare(b.name);
        });
        
        for (const d of dirs) {
          if (d.name === 'Roles' || d.name === '.git' || d.name === 'node_modules') continue;
          const dRel = relProjPath(d.path);
          const dHidden = isHiddenPath(dRel);
          if (dHidden && !settings.tpRevealHidden) continue;

          const folderDiv = document.createElement('div');
          folderDiv.className = 'tp-tree-folder' + (dHidden ? ' tp-tree-hidden-item' : '');

          const header = document.createElement('div');
          header.className = 'tp-tree-folder-header';

          const icon = document.createElement('span');
          icon.className = 'tp-tree-icon';
          icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`; // chevron-right

          const label = document.createElement('span');
          label.className = 'tp-tree-item-name';
          label.textContent = d.name;

          header.appendChild(icon);
          const folderIcon = document.createElement('span');
          folderIcon.className = 'tp-folder-glyph';
          folderIcon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
          header.appendChild(folderIcon);
          header.appendChild(label);
          if (dHidden) {
            const unhideBtn = host.iconBtn('tp-tree-unhide-btn', 'eye-off', 'Показать папку');
            unhideBtn.onclick = (e) => { e.stopPropagation(); setHidden(dRel, false); };
            header.appendChild(unhideBtn);
          }
          folderDiv.appendChild(header);

          header.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (host.closeMenus && host.menuRow && host.placeMenu) {
              host.closeMenus();
              const dd = document.createElement('div');
              dd.className = 'menu-dropdown';
              dd.appendChild(host.menuRow('eye-off', dHidden ? 'Показать папку' : 'Скрыть папку', () => {
                host.closeMenus();
                setHidden(dRel, !dHidden);
              }));
              host.placeMenu(dd, e.clientX, e.clientY);
            }
          };
          
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
          const fRel = relProjPath(f.path);
          const fHidden = isHiddenPath(fRel);
          if (fHidden && !settings.tpRevealHidden) continue;

          const item = document.createElement('div');
          item.className = 'tp-tree-item' + (fHidden ? ' tp-tree-hidden-item' : '');

          item.appendChild(fileBadge(f.name));

          const nameSpan = document.createElement('span');
          nameSpan.className = 'tp-tree-item-name';
          nameSpan.textContent = f.name;
          item.appendChild(nameSpan);

          if (fHidden) {
            const unhideBtn = host.iconBtn('tp-tree-unhide-btn', 'eye-off', 'Показать файл');
            unhideBtn.onclick = (e) => { e.stopPropagation(); setHidden(fRel, false); };
            item.appendChild(unhideBtn);
          }

          if (activeTab && f.path === activeTab.path) {
            item.classList.add('active');
          }

          item.onclick = (e) => {
            e.stopPropagation();
            document.querySelectorAll('.tp-tree-item.active').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            openProjectFile(f.path);
          };
          item.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (host.closeMenus && host.menuRow && host.placeMenu) {
              host.closeMenus();
              const dd = document.createElement('div');
              dd.className = 'menu-dropdown';
              dd.appendChild(host.menuRow('eye-off', fHidden ? 'Показать файл' : 'Скрыть файл', () => {
                host.closeMenus();
                setHidden(fRel, !fHidden);
              }));
              host.placeMenu(dd, e.clientX, e.clientY);
            }
          };
          container.appendChild(item);
          hasFiles = true;
        }
        
        if (!hasFiles && level === 0) {
          container.innerHTML = '<div style="padding: 10px; color: var(--tp-text-3); font-size: 13px;">Нет Markdown файлов</div>';
        }
      };
      
      await renderPromptsSection(treeContainer, proj);
      await buildTree(proj.path, treeContainer, 0);
    } catch (e) {
      console.error(e);
    }
  }

  // Закреплённый раздел вверху дерева — прямой доступ к файлам ролей (Roles/), которые сам
  // buildTree() всегда пропускает (см. `d.name === 'Roles'` выше). Не участвует в скрытии.
  async function loadPromptsList(container, proj) {
    container.innerHTML = '';
    try {
      const entries = await lite.fs.readDir(`${proj.path}/Roles`);
      const files = (entries || []).filter((e) => !e.dir && /\.md$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!files.length) {
        container.innerHTML = '<div style="padding:4px 14px;color:var(--tp-text-3);font-size:12.5px;">Нет промтов</div>';
        return;
      }
      files.forEach((f) => {
        const item = document.createElement('div');
        item.className = 'tp-tree-item';
        item.appendChild(fileBadge(f.name));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tp-tree-item-name';
        nameSpan.textContent = f.name;
        item.appendChild(nameSpan);
        item.onclick = (e) => { e.stopPropagation(); openProjectFile(f.path); };
        container.appendChild(item);
      });
    } catch (_) {
      container.innerHTML = '';
    }
  }
  async function renderPromptsSection(container, proj) {
    const wrap = document.createElement('div');
    wrap.className = 'tp-tree-folder tp-tree-pinned';

    const header = document.createElement('div');
    header.className = 'tp-tree-folder-header';
    const chevron = document.createElement('span');
    chevron.className = 'tp-tree-icon';
    chevron.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    const glyph = document.createElement('span');
    glyph.className = 'tp-folder-glyph';
    glyph.appendChild(icon('sparkles', 15));
    const label = document.createElement('span');
    label.className = 'tp-tree-item-name';
    label.textContent = 'Промты';
    header.append(chevron, glyph, label);
    wrap.appendChild(header);

    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'tp-tree-folder-children';
    childrenContainer.style.display = 'none';
    wrap.appendChild(childrenContainer);

    let loaded = false;
    header.onclick = async (e) => {
      e.stopPropagation();
      const collapsed = childrenContainer.style.display === 'none';
      if (collapsed) {
        childrenContainer.style.display = 'block';
        chevron.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
        if (!loaded) { await loadPromptsList(childrenContainer, proj); loaded = true; }
      } else {
        childrenContainer.style.display = 'none';
        chevron.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      }
    };
    container.appendChild(wrap);
    container.appendChild(el('div', 'tp-tree-pinned-sep'));
  }

  async function openProjectFile(absPath, fileContent = null) {
    // Check if already open
    let tab = openTabs.find(t => t.absPath === absPath);
    if (tab) {
      switchToTab(tab.id);
      return;
    }
    
    let content = fileContent;
    if (content === null) {
      // Read file
      const r = await lite.fs.readFile(absPath);
      if (!r || r.error) {
        toast('Ошибка чтения файла', { kind: 'err' });
        return;
      }
      content = r.content;
    }
    
    // Create new tab
    const id = nextTabId++;
    const name = absPath.split(/[\\/]/).pop();
    const isHtml = /\.html?$/i.test(name);
    
    let htmlText = '', mdText = '';
    if (isHtml) {
      htmlText = content;
      const div = document.createElement('div');
      div.innerHTML = content;
      mdText = htmlToMd(div);
    } else {
      htmlText = mdToHtml(content);
      mdText = content;
    }
    
    tab = {
      id,
      absPath,
      name,
      html: htmlText,
      md: mdText,
      mode: 'wysiwyg',
      dirty: false,
      chatLog: [],
      chatAgent: 'claude',
      chatRole: 'Без роли'
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

    persistTabs();
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
      dirty: false,
      chatLog: [],
      chatAgent: 'claude',
      chatRole: 'Без роли'
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
      tab.chatLog = [...chatLog];
      tab.chatAgent = chatAgent;
      tab.chatRole = chatRole;
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
    
    chatLog = Array.isArray(tab.chatLog) ? [...tab.chatLog] : [];
    chatAgent = tab.chatAgent || 'claude';
    chatRole = tab.chatRole || 'Без роли';

    // Load content without resetting mode
    $('#doc-editor-wysiwyg').innerHTML = tab.html;
    $('#doc-editor-md').textContent = tab.md;
    updateModeUI();
    updateStatus(dirty ? 'Изменено' : (tab.absPath ? 'Открыт' : 'Новый файл'));

    renderTabsUI();
    renderChatLog();
    renderModels();
    renderRoles();
  }

  async function closeTab(id) {
    const tabIdx = openTabs.findIndex(t => t.id === id);
    if (tabIdx === -1) return;
    const tab = openTabs[tabIdx];
    
    if (tab.dirty) {
      // For simplicity, we assume we just close without save for now, or prompt
      // We can use native confirmClose logic, but let's just close it.
    }
    
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

  async function onFsChange(proj, files) {
    if (getActiveProj() && getActiveProj().path === proj.path) {
      renderTree(proj);
      
      // Автоматически подтягиваем внешние изменения файла (например, от Gemini), если нет локальных правок
      if (currentFile && !dirty) {
        try {
          const r = await lite.fs.readFile(currentFile);
          if (r && !r.error && r.content !== currentMarkdown()) {
            const canvasEl = document.querySelector('.tp-canvas') || document.querySelector('.tp-doc-editor-wrap');
            const st = canvasEl ? canvasEl.scrollTop : 0;
            
            if (mode === 'markdown') { 
              $('#doc-editor-md').focus(); 
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, r.content); 
            } else { 
              $('#doc-editor-wysiwyg').focus(); 
              document.execCommand('selectAll', false, null);
              document.execCommand('insertHTML', false, mdToHtml(r.content)); 
            }
            
            if (canvasEl) canvasEl.scrollTop = st;
            updateStatus('Синхронизировано с диском (Gemini)');
            setTimeout(() => { dirty = false; renderTabsUI(); }, 10);
          }
        } catch (e) {}
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
