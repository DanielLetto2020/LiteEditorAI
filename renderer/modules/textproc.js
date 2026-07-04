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
    $('#doc-editor-md').addEventListener('input', markDirty);
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
      const b = el('div', 'tp-bubble');
      b.textContent = m.busy ? (m.text + ' ⏳') : m.text;
      if (m.role === 'agent' && !m.busy) {
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
  async function composePrompt(sel, instruction) {
    const parts = [];
    if (chatRole !== 'Без роли') {
      try {
        const content = await lite.fs.readFile(`${activeProj.path}/Roles/${chatRole}.md`);
        parts.push(`Действуй в роли: ${chatRole}\n${content}`);
      } catch (e) {
        parts.push(`Действуй в роли: ${chatRole}`);
      }
    }
    parts.push(instruction);
    parts.push('Ниже — ' + (sel.whole ? 'весь документ (Markdown)' : 'фрагмент текста') + '. Верни ТОЛЬКО итоговый текст для замены: без пояснений, без приветствий.');
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
    const am = { role: 'agent', text: '', busy: true, reqId: 'tpq' + (++aiSeq) };
    chatLog.push(am);
    renderChatLog();
    const offData = lite.tp.onData(({ reqId: r, chunk }) => { if (r !== am.reqId) return; am.text += chunk; renderChatLog(); });
    const offDone = lite.tp.onDone(({ reqId: r, text }) => { if (r !== am.reqId) return; am.busy = false; am.text = text || ''; cleanup(); renderChatLog(); });
    const offErr = lite.tp.onError(({ reqId: r, error }) => { if (r !== am.reqId) return; am.busy = false; am.text = 'Ошибка: ' + String(error); cleanup(); renderChatLog(); });
    const cleanup = () => { try { offData(); offDone(); offErr(); } catch (_) {} };
    
    const prompt = await composePrompt(sel, instruction);
    lite.tp.run({ reqId: am.reqId, agent: chatAgent, prompt });
  }
  function renderModels() {
    const box = $('#doc-ai-models');
    if (box.children.length === 0) {
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

  // Контекст для AI-панели: выделенный в документе фрагмент
  document.addEventListener('selectionchange', () => {
    if (!docOpen) return;
    const ctxText = $('#doc-ai-ctx-text');
    if (!ctxText) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && getActiveEditor().contains(sel.anchorNode)) {
      const text = sel.toString();
      if (text.trim()) { ctxText.textContent = text.slice(0, 100) + (text.length > 100 ? '…' : ''); ctxText.classList.add('filled'); return; }
    }
    ctxText.textContent = 'Выделите фрагмент в документе — он попадёт сюда. Ответ можно вставить кнопкой «Заменить».';
    ctxText.classList.remove('filled');
  });

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
          
          if (activeTab && f.path === activeTab.path) {
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
    const name = lite.path.basename(absPath);
    const isHtml = /\.html?$/i.test(name);
    
    tab = {
      id,
      absPath,
      name,
      html: isHtml ? r.content : mdToHtml(r.content),
      md: isHtml ? htmlToMd(r.content) : r.content,
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
    
    // Load content without resetting mode
    $('#doc-editor-wysiwyg').innerHTML = tab.html;
    $('#doc-editor-md').textContent = tab.md;
    updateModeUI();
    updateStatus(dirty ? 'Изменено' : (tab.absPath ? 'Открыт' : 'Новый файл'));
    
    renderTabsUI();
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

  function onFsChange(proj, files) {
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
    showSettings: () => { /* TODO */ },
    confirmClose,
  };
}
