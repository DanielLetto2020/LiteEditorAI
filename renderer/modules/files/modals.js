// Быстрые оверлеи, палитры, пикеры, локальная/git история файла и безопасный парсер превью для IDE-вивера.
import { el, icon, toast, baseName, extOf, fileTypeSvg, makeModal } from '../../ui.js';
import { POPULAR_LANGUAGES, ensureLanguage, mergeRoExtensions } from '../../codeedit.js';
import { SYMBOL_GLYPHS } from './symbol-index.js';
import { MergeView } from '@codemirror/merge';
import { marked } from 'marked';

const lite = typeof window !== 'undefined' ? window.lite : null;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif']);

/**
 * Определить тип визуального превью для файла.
 * SVG намеренно открывается кодом с возможностью переключить «Рядом / Превью», как Markdown и HTML!
 * @param {string | null} file
 * @returns {'image' | 'markdown' | 'html' | 'svg' | null}
 */
export function previewKindFor(file) {
  if (!file) return null;
  const ext = extOf(file);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

export function sanitizePreviewHtml(root) {
  root.querySelectorAll('script, style, iframe, frame, object, embed, base, link, meta, form').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) n.removeAttribute(attr.name);
      else if (/^(href|src|xlink:href)$/.test(name) && /^(javascript|vbscript):/i.test(attr.value.replace(/[\s-]/g, ''))) {
        n.removeAttribute(attr.name);
      } else if ((name === 'id' || name === 'name') && (attr.value in document || document.getElementById(attr.value))) {
        n.removeAttribute(attr.name);
      }
    }
  });
}

export function safeMarkdownFragment(md) {
  const tpl = document.createElement('template');
  try { tpl.innerHTML = String(marked.parse(md || '', { breaks: true })); } catch (_) { return null; }
  sanitizePreviewHtml(tpl.content);
  return tpl.content;
}

export function safeSvgFragment(svgCode) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(svgCode || '');
  sanitizePreviewHtml(tpl.content);
  return tpl.content;
}

export function fuzzyScore(query, candidate) {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const baseIdx = c.lastIndexOf('/') + 1;
  const base = c.slice(baseIdx);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 850 - base.length;
  const subBase = base.indexOf(q);
  if (subBase >= 0) return 700 - subBase * 4 - base.length;
  const subFull = c.indexOf(q);
  if (subFull >= 0) return 520 - subFull;
  // Последовательное вхождение символов (fuzzy)
  let qi = 0;
  let score = 260;
  let prev = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      if (i === prev + 1) score += 14;
      if (i === baseIdx) score += 22;
      if (i === 0 || c[i - 1] === '/' || c[i - 1] === '-' || c[i - 1] === '_' || c[i - 1] === '.') score += 10;
      prev = i;
      qi++;
    }
  }
  return qi === q.length ? score - c.length * 0.4 : -1;
}

function shortCountRu(n, one, few, many) {
  const v = Math.abs(n) % 100, d = v % 10;
  if (v > 10 && v < 20) return n + ' ' + many;
  if (d === 1) return n + ' ' + one;
  if (d >= 2 && d <= 4) return n + ' ' + few;
  return n + ' ' + many;
}

/**
 * Создаёт менеджер быстрых IDE-оверлеев (Quick Open, Command Palette, Go to Line, Language Picker, History).
 */
export function createViewerOverlays(ctx) {
  // ctx: { activeProject, getAllFiles, getRecentFiles, getOpenFiles, getCurrentFile, getCurrentSymbols,
  //        symbolIndex, getCommands, openFile, gotoLineCol, setLanguageOverride, showCommitDiff,
  //        saveIfCurrent, reloadCurrentIfMatch, cancelAutosaveFor }
  let activeOverlay = null;

  function closeOverlay() {
    if (activeOverlay) {
      activeOverlay.remove();
      activeOverlay = null;
    }
  }

  function mountOverlayBox(wide = false) {
    closeOverlay();
    const root = el('div', 'ov-backdrop');
    const box = el('div', 'ov-box' + (wide ? ' wide' : ''));
    root.appendChild(box);
    root.addEventListener('mousedown', (e) => { if (e.target === root) closeOverlay(); });
    document.body.appendChild(root);
    activeOverlay = root;
    return { root, box };
  }

  function openGenericList({ placeholder, initialValue = '', hint = '', wide = false, getItems, renderRow, onPick, onAltPick }) {
    const { box } = mountOverlayBox(wide);
    const head = el('div', 'ov-head');
    head.appendChild(icon('search', 15));
    const inp = el('input', 'ov-input');
    inp.type = 'text';
    inp.placeholder = placeholder;
    inp.value = initialValue;
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    head.appendChild(inp);
    if (hint) head.appendChild(el('span', 'ov-hint', hint));
    const list = el('div', 'ov-list');
    box.append(head, list);

    let items = [];
    let sel = 0;

    const paintActive = () => {
      const children = list.children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle('sel', i === sel);
      }
      if (children[sel]) children[sel].scrollIntoView({ block: 'nearest' });
    };

    const refresh = () => {
      items = (getItems(inp.value) || []).slice(0, 120);
      sel = 0;
      list.replaceChildren();
      if (!items.length) {
        list.appendChild(el('div', 'ov-empty', 'Ничего не найдено'));
        return;
      }
      items.forEach((it, idx) => {
        const row = el('div', 'ov-row' + (idx === 0 ? ' sel' : ''));
        renderRow(row, it);
        row.addEventListener('mouseenter', () => { sel = idx; paintActive(); });
        row.addEventListener('click', (e) => {
          const item = items[idx];
          closeOverlay();
          if ((e.ctrlKey || e.metaKey || e.shiftKey) && onAltPick) onAltPick(item);
          else onPick(item);
        });
        list.appendChild(row);
      });
    };

    inp.addEventListener('input', refresh);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length) { sel = (sel + 1) % items.length; paintActive(); }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) { sel = (sel - 1 + items.length) % items.length; paintActive(); }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[sel];
        closeOverlay();
        if (item) {
          if ((e.ctrlKey || e.metaKey) && onAltPick) onAltPick(item);
          else onPick(item);
        }
      }
    });

    refresh();
    setTimeout(() => {
      inp.focus();
      if (initialValue) inp.setSelectionRange(initialValue.length, initialValue.length);
    }, 0);
  }

  /**
   * Универсальный Quick Open (Ctrl+P):
   *   "" / "foo"     — файлы проекта (поддержка foo.js:42, Ctrl+Enter открывает справа в сплите)
   *   ":42" / ":42:8"— строка и столбец в текущем файле
   *   "@name"        — символ текущего файла
   *   "#name"        — символ во всём проекте (ProjectSymbolIndex)
   *   ">cmd"         — команда из палитры команд
   */
  async function openQuickOpen(initialPrefix = '') {
    const p = ctx.activeProject();
    const allRelFiles = p ? await ctx.getAllFiles(p.path) : [];
    const recentAbs = ctx.getRecentFiles();
    const openAbs = new Set(ctx.getOpenFiles());
    const projRoot = p ? p.path.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const toAbs = (rel) => (projRoot ? projRoot + '/' + rel : rel);
    const toRel = (abs) => {
      const norm = String(abs || '').replace(/\\/g, '/');
      return (projRoot && norm.startsWith(projRoot + '/')) ? norm.slice(projRoot.length + 1) : norm;
    };

    openGenericList({
      placeholder: 'Файл, :строка, @символ файла, #символ проекта, >команда…',
      initialValue: initialPrefix,
      hint: 'Ctrl+Enter — в сплит',
      wide: true,
      getItems: (raw) => {
        const val = String(raw || '');
        const trimmed = val.trim();

        // 1. Режим команд (>...)
        if (trimmed.startsWith('>')) {
          const q = trimmed.slice(1).trim().toLowerCase();
          const cmds = ctx.getCommands();
          return cmds
            .filter((c) => !q || c.label.toLowerCase().includes(q) || (c.category && c.category.toLowerCase().includes(q)))
            .map((c) => ({ mode: 'cmd', cmd: c }));
        }

        // 2. Режим перехода к строке (:42 или :42:10)
        if (trimmed.startsWith(':')) {
          const m = trimmed.slice(1).trim().match(/^(\d+)?(?::(\d+))?$/);
          const line = m && m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
          const col = m && m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
          return [{ mode: 'line', line, col, hasNum: !!(m && m[1]) }];
        }

        // 3. Режим символов текущего файла (@...)
        if (trimmed.startsWith('@')) {
          const q = trimmed.slice(1).trim().toLowerCase();
          const syms = ctx.getCurrentSymbols() || [];
          return syms
            .filter((s) => !q || s.name.toLowerCase().includes(q))
            .map((s) => ({ mode: 'sym', sym: s }));
        }

        // 4. Режим символов по всему проекту (#...)
        if (trimmed.startsWith('#')) {
          const q = trimmed.slice(1).trim();
          const hits = ctx.symbolIndex ? ctx.symbolIndex.searchSymbols(q, 80) : [];
          return hits.map((s) => ({ mode: 'projsym', sym: s, abs: toAbs(s.rel) }));
        }

        // 5. Файлы проекта (+ поддержка суффикса :line[:col])
        if (!p) return [];
        let fileQuery = trimmed;
        let gotoLn = null;
        const lm = trimmed.match(/^(.*?):(\d+)(?::(\d+))?$/);
        if (lm) {
          fileQuery = lm[1].trim();
          gotoLn = parseInt(lm[2], 10) || 1;
        }

        if (!fileQuery) {
          // Пустой запрос: сначала открытые и недавние файлы проекта, затем первые файлы дерева
          const seen = new Set();
          const out = [];
          for (const abs of recentAbs) {
            if (!abs.startsWith(projRoot + '/')) continue;
            const rel = toRel(abs);
            if (seen.has(rel)) continue;
            seen.add(rel);
            out.push({ mode: 'file', rel, abs, line: gotoLn, badge: openAbs.has(abs) ? 'открыт' : 'недавний' });
          }
          for (const rel of allRelFiles) {
            if (out.length >= 80) break;
            if (seen.has(rel)) continue;
            seen.add(rel);
            const abs = toAbs(rel);
            out.push({ mode: 'file', rel, abs, line: gotoLn, badge: openAbs.has(abs) ? 'открыт' : '' });
          }
          return out;
        }

        const scored = [];
        for (const rel of allRelFiles) {
          const sc = fuzzyScore(fileQuery, rel);
          if (sc < 0) continue;
          const abs = toAbs(rel);
          const bonus = openAbs.has(abs) ? 25 : 0;
          scored.push({ sc: sc + bonus, rel, abs });
        }
        scored.sort((a, b) => b.sc - a.sc || a.rel.localeCompare(b.rel));
        return scored.slice(0, 100).map((x) => ({
          mode: 'file',
          rel: x.rel,
          abs: x.abs,
          line: gotoLn,
          badge: openAbs.has(x.abs) ? 'открыт' : '',
        }));
      },
      renderRow: (row, it) => {
        if (it.mode === 'cmd') {
          row.appendChild(icon(it.cmd.icon || 'wand', 14));
          const cat = it.cmd.category ? `${it.cmd.category}: ` : '';
          row.appendChild(el('span', 'ov-name', cat + it.cmd.label));
          if (it.cmd.keys) row.appendChild(el('kbd', 'ov-kbd', it.cmd.keys));
        } else if (it.mode === 'line') {
          row.appendChild(icon('arrow-right', 14));
          row.appendChild(el('span', 'ov-name', it.hasNum ? `Перейти к строке ${it.line}${it.col > 1 ? `, столбец ${it.col}` : ''}` : 'Введите номер строки (:строка[:столбец])'));
        } else if (it.mode === 'sym') {
          row.appendChild(el('span', 'ov-kind ov-' + it.sym.kind, SYMBOL_GLYPHS[it.sym.kind] || '·'));
          row.appendChild(el('span', 'ov-name', it.sym.name));
          if (it.sym.detail) row.appendChild(el('span', 'ov-detail', it.sym.detail));
          row.appendChild(el('span', 'ov-path', ':' + it.sym.line));
        } else if (it.mode === 'projsym') {
          row.appendChild(el('span', 'ov-kind ov-' + it.sym.kind, SYMBOL_GLYPHS[it.sym.kind] || '·'));
          row.appendChild(el('span', 'ov-name', it.sym.name));
          row.appendChild(el('span', 'ov-path', `${it.sym.rel}:${it.sym.line}`));
        } else {
          row.appendChild(fileTypeSvg(it.rel));
          const slash = it.rel.lastIndexOf('/');
          const fname = slash >= 0 ? it.rel.slice(slash + 1) : it.rel;
          const fdir = slash >= 0 ? it.rel.slice(0, slash) : '';
          row.appendChild(el('span', 'ov-name', fname + (it.line ? ':' + it.line : '')));
          if (fdir) row.appendChild(el('span', 'ov-path', fdir));
          if (it.badge) row.appendChild(el('span', 'ov-badge', it.badge));
        }
      },
      onPick: (it) => {
        if (it.mode === 'cmd') it.cmd.run();
        else if (it.mode === 'line') ctx.gotoLineCol(it.line, it.col);
        else if (it.mode === 'sym') ctx.gotoLineCol(it.sym.line, 1);
        else if (it.mode === 'projsym') ctx.openFile(it.abs, it.sym.line, { preview: false });
        else if (it.mode === 'file') ctx.openFile(it.abs, it.line, { preview: false });
      },
      onAltPick: (it) => {
        if (it.mode === 'file') ctx.openFile(it.abs, it.line, { preview: false, group: 'split' });
        else if (it.mode === 'projsym') ctx.openFile(it.abs, it.sym.line, { preview: false, group: 'split' });
      },
    });
  }

  function openCommandPalette() {
    openQuickOpen('>');
  }

  function openGotoLine() {
    openQuickOpen(':');
  }

  function openSymbolOutlineOverlay() {
    openQuickOpen('@');
  }

  function openProjectSymbolOverlay() {
    openQuickOpen('#');
  }

  function openLanguagePicker(currentOverride) {
    const items = [
      { id: '', label: 'Автоопределение по имени файла' },
      ...POPULAR_LANGUAGES.map((name) => ({ id: name, label: name })),
    ];
    openGenericList({
      placeholder: 'Выбрать синтаксис для текущего файла…',
      getItems: (q) => {
        const ql = String(q || '').trim().toLowerCase();
        return ql ? items.filter((x) => x.label.toLowerCase().includes(ql)) : items;
      },
      renderRow: (row, it) => {
        const active = (currentOverride || '') === it.id;
        row.appendChild(icon(active ? 'check' : 'code', 14));
        row.appendChild(el('span', 'ov-name', it.label));
        if (active) row.appendChild(el('span', 'ov-badge', 'текущий'));
      },
      onPick: (it) => {
        ctx.setLanguageOverride(it.id || null);
      },
    });
  }

  async function showLocalHistoryModal(file) {
    if (!file) { toast('Нет открытого файла'); return; }
    const r = await lite.fs.histList(file);
    const items = (r && r.items) || [];
    if (!items.length) { toast('Локальная история пуста — версии копятся автоматически при правках'); return; }
    await ensureLanguage(file);
    let cur = '';
    try { const rf = await lite.fs.readFile(file); if (rf && !rf.error) cur = rf.content; } catch (_) {}
    let mv = null, closed = false, showSeq = 0;
    const destroyMv = () => { if (mv) { try { mv.destroy(); } catch (_) {} mv = null; } };
    const HIST_TAG_LABEL = { save: 'автосейв', ext: 'внешняя правка' };

    const { m, close } = makeModal(`
      <div class="hist-head"><span class="hist-title"></span><span class="hist-count"></span></div>
      <div class="hist-grid">
        <div class="hist-list"></div>
        <div class="hist-right">
          <div class="hist-collabels"><span>Выбранная версия</span><span>Текущий файл</span></div>
          <div class="hist-diff"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="hist-close">Закрыть</button>
        <button class="btn primary" id="hist-restore" disabled>Откатить к этой версии</button>
      </div>`, () => { closed = true; destroyMv(); });
    m.classList.add('modal-hist');
    m.querySelector('.hist-title').textContent = 'Локальная история — ' + baseName(file);
    m.querySelector('.hist-count').textContent = shortCountRu(items.length, 'версия', 'версии', 'версий');
    m.querySelector('#hist-close').onclick = close;
    const listEl = m.querySelector('.hist-list');
    const diffEl = m.querySelector('.hist-diff');
    const restoreBtn = m.querySelector('#hist-restore');
    let selContent = null;

    restoreBtn.onclick = async () => {
      if (selContent == null) return;
      const content = selContent;
      restoreBtn.disabled = true;
      await ctx.cancelAutosaveFor(file);
      try { await lite.fs.histSnapshot(file); } catch (_) {}
      const w = await lite.fs.writeFile(file, content);
      if (w && w.error) { toast(w.error, { kind: 'err', ttl: 7000 }); restoreBtn.disabled = false; return; }
      close();
      toast('Файл откатан к выбранной версии');
      ctx.reloadCurrentIfMatch(file);
    };

    const show = async (it, row) => {
      const my = ++showSeq;
      listEl.querySelectorAll('.hist-item').forEach((x) => x.classList.toggle('active', x === row));
      selContent = null; restoreBtn.disabled = true;
      const rr = await lite.fs.histRead(file, it.name);
      if (closed || my !== showSeq) return;
      if (!rr || rr.error) { toast((rr && rr.error) || 'не удалось прочитать версию', { kind: 'err' }); return; }
      selContent = rr.content;
      restoreBtn.disabled = false;
      destroyMv(); diffEl.replaceChildren();
      const ro = mergeRoExtensions(file);
      mv = new MergeView({
        a: { doc: rr.content, extensions: ro },
        b: { doc: cur, extensions: ro },
        parent: diffEl,
        highlightChanges: true,
        gutter: true,
        diffConfig: { scanLimit: 20000, timeout: 2500 },
      });
    };

    items.forEach((it, i) => {
      const row = el('div', 'hist-item');
      const d = new Date(it.ts);
      row.append(
        el('span', 'hist-when', d.toLocaleDateString() + ' ' + d.toLocaleTimeString()),
        el('span', 'hist-tag t-' + it.tag, HIST_TAG_LABEL[it.tag] || it.tag),
        el('span', 'hist-size', Math.max(1, Math.round(it.size / 1024)) + ' КБ'),
      );
      row.addEventListener('click', () => show(it, row));
      listEl.appendChild(row);
      if (i === 0) show(it, row);
    });
  }

  async function showFileGitHistoryOverlay(file) {
    const p = ctx.activeProject();
    if (!p || !file) { toast('Нет открытого файла проекта'); return; }
    const r = await lite.git.fileLog(p.path, file, 120);
    if (!r || r.error) { toast((r && r.error) || 'не удалось получить историю файла', { kind: 'err' }); return; }
    const commits = r.commits || [];
    if (!commits.length) { toast('История файла в git пуста'); return; }
    const rootNorm = p.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const fileNorm = file.replace(/\\/g, '/');
    const rel = fileNorm.startsWith(rootNorm + '/') ? fileNorm.slice(rootNorm.length + 1) : fileNorm;

    openGenericList({
      placeholder: `История «${baseName(file)}» в git (${commits.length} коммитов)…`,
      wide: true,
      getItems: (q) => {
        const ql = String(q || '').trim().toLowerCase();
        return ql ? commits.filter((c) => (c.hash + ' ' + c.subject + ' ' + c.author).toLowerCase().includes(ql)) : commits;
      },
      renderRow: (row, c) => {
        row.append(
          el('span', 'ov-kind', c.hash.slice(0, 7)),
          el('span', 'ov-name', c.subject),
          el('span', 'ov-path', `${c.when} · ${c.author}`),
        );
      },
      onPick: (c) => ctx.showCommitDiff(p.path, c.hash, rel, { name: baseName(file) }),
    });
  }

  return {
    closeOverlay,
    isOpen: () => !!activeOverlay,
    openQuickOpen,
    openCommandPalette,
    openGotoLine,
    openSymbolOutlineOverlay,
    openProjectSymbolOverlay,
    openLanguagePicker,
    showLocalHistoryModal,
    showFileGitHistoryOverlay,
  };
}
