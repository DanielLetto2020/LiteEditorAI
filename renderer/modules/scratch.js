// LiteEditor — модуль «Система · ~» (системный терминал): вкладки независимых шеллов в домашней
// папке, не привязаны к проектам. Раньше жил в ядре (правый слот); с v1.1.x — отдельное окно.
// Самодостаточен: свои xterm-аддоны, свой контекст-меню и paste (без меню-системы редактора).
// PTY общие (lite.pty.*), id вида `__scratch__::tN`; main маршрутизирует pty:data в окно-владельца.
// host: { settings, termTheme, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels }
import { el, iconBtn, icon, showPrompt } from '../ui.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { applyUnicode11, loadFastRenderer, copySelection } from '../termutil.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;
const SCRATCH_ID = '__scratch__';
const isScratch = (id) => typeof id === 'string' && id.startsWith(SCRATCH_ID);

export function initScratch(host) {
  const { settings, termTheme, layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels } = host;

  const scratchTerms = new Map(); // id -> { term, fit, search, container, name }
  let scratchSessions = [];
  let scratchActiveId = null;
  let scratchSeq = 0;
  let scratchOpen = false;
  let menuEl = null;

  function newScratchId() { return SCRATCH_ID + '::t' + (++scratchSeq); }

  // ---- собственный контекст-меню терминала (без меню-системы ядра) ----
  function closeTermMenu() { if (menuEl) { try { menuEl.remove(); } catch (_) {} menuEl = null; } }
  function termMenu(x, y, term, id) {
    closeTermMenu();
    const dd = el('div', 'menu-dropdown');
    dd.style.position = 'fixed'; dd.style.left = x + 'px'; dd.style.top = y + 'px'; dd.style.minWidth = '160px'; dd.style.zIndex = '9999';
    const hasSel = term.hasSelection && term.hasSelection();
    const row = (ic, label, fn, disabled) => {
      const r = el('div', 'menu-row' + (disabled ? ' disabled' : ''));
      r.appendChild(icon(ic, 16)); r.appendChild(el('span', 'menu-label', label));
      if (!disabled) r.addEventListener('click', () => { closeTermMenu(); fn(); });
      return r;
    };
    dd.appendChild(row('copy', 'Копировать', () => { lite.copyText(term.getSelection()); if (term.clearSelection) term.clearSelection(); }, !hasSel));
    dd.appendChild(row('clipboard', 'Вставить', () => pasteInto(id)));
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(row('eraser', 'Очистить', () => { try { term.clear(); } catch (_) {} term.focus(); }));
    dd.appendChild(row('refresh', 'Перезапустить', () => restartScratch(id)));
    dd.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(dd);
    menuEl = dd;
    setTimeout(() => document.addEventListener('mousedown', closeTermMenu, { once: true }), 0);
  }
  async function pasteInto(id) {
    const text = await lite.readClipboard();
    if (text) lite.pty.write(id, text);
    const rec = scratchTerms.get(id); if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
  }

  function createScratchSession(name) {
    const id = newScratchId();
    const container = el('div', 'term-instance');
    $('#scratch-term').appendChild(container);
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
      fontSize: settings.fontSize, cursorBlink: true, allowProposedApi: true, theme: termTheme(), scrollback: 5000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
    applyUnicode11(term);
    term.open(container);
    loadFastRenderer(term);
    fit.fit();
    lite.pty.create({ id, cols: term.cols, rows: term.rows }); // no cwd → ~ (os.homedir)
    term.onData((data) => lite.pty.write(id, data));
    term.onResize(({ cols, rows }) => lite.pty.resize(id, cols, rows));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { addScratchTab(); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { closeScratchTab(scratchActiveId); return false; }
      if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleScratchTab(e.key === 'PageDown' ? 1 : -1); return false; }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term); // copied → swallow; else SIGINT
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteInto(id); return false; }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') { lite.pty.write(id, lite.platform === 'win32' ? '\n' : '\\\r'); return false; }
      return true;
    });
    container.addEventListener('contextmenu', (e) => { e.preventDefault(); termMenu(e.clientX, e.clientY, term, id); });
    scratchTerms.set(id, { term, fit, search, container, name: name || ('Терминал ' + (scratchSessions.length + 1)) });
    scratchSessions.push(id);
    return id;
  }
  function ensureScratch() { if (!scratchSessions.length) scratchActiveId = createScratchSession('Терминал 1'); }
  function showActiveScratch() {
    for (const [sid, rec] of scratchTerms) rec.container.style.display = sid === scratchActiveId ? 'block' : 'none';
    renderScratchTabs();
    refitScratch(true);
  }
  function renderScratchTabs() {
    const bar = $('#scratch-tabs'); if (!bar) return;
    bar.innerHTML = '';
    scratchSessions.forEach((sid) => {
      const rec = scratchTerms.get(sid); if (!rec) return;
      const tab = el('div', 'tab' + (sid === scratchActiveId ? ' active' : ''));
      tab.appendChild(el('span', 'tab-name', rec.name));
      if (scratchSessions.length > 1) {
        const x = iconBtn('tab-close', 'x', 'Закрыть вкладку (Ctrl+Shift+W)', 12);
        x.addEventListener('click', (e) => { e.stopPropagation(); closeScratchTab(sid); });
        tab.appendChild(x);
      }
      tab.addEventListener('click', () => switchScratchTab(sid));
      tab.addEventListener('dblclick', () => renameScratchTab(sid));
      bar.appendChild(tab);
    });
    const add = iconBtn('tab-add', 'plus', 'Новый системный терминал (Ctrl+Shift+T)', 15);
    add.addEventListener('click', () => addScratchTab());
    bar.appendChild(add);
  }
  function switchScratchTab(sid) { if (!scratchTerms.has(sid)) return; scratchActiveId = sid; showActiveScratch(); }
  function addScratchTab() { scratchActiveId = createScratchSession('Терминал ' + (scratchSessions.length + 1)); showActiveScratch(); }
  function closeScratchTab(sid) {
    if (scratchSessions.length <= 1) return; // keep ≥1
    lite.pty.kill(sid);
    const rec = scratchTerms.get(sid);
    if (rec) { try { rec.term.dispose(); } catch (_) {} rec.container.remove(); scratchTerms.delete(sid); }
    const i = scratchSessions.indexOf(sid); scratchSessions.splice(i, 1);
    if (scratchActiveId === sid) scratchActiveId = scratchSessions[Math.max(0, i - 1)];
    showActiveScratch();
  }
  function cycleScratchTab(dir) {
    if (scratchSessions.length < 2) return;
    let i = scratchSessions.indexOf(scratchActiveId) + dir;
    if (i < 0) i = scratchSessions.length - 1; if (i >= scratchSessions.length) i = 0;
    switchScratchTab(scratchSessions[i]);
  }
  function renameScratchTab(sid) {
    const rec = scratchTerms.get(sid); if (!rec) return;
    showPrompt('Переименовать вкладку', 'Название', rec.name, (v) => { rec.name = v; renderScratchTabs(); });
  }
  function refitScratch(focusIt) {
    if (!scratchOpen || !scratchActiveId) return;
    const rec = scratchTerms.get(scratchActiveId); if (!rec) return;
    requestAnimationFrame(() => {
      try { rec.fit.fit(); lite.pty.resize(scratchActiveId, rec.term.cols, rec.term.rows); if (focusIt) rec.term.focus(); } catch (_) {}
    });
  }
  function restartScratch(id) {
    const sid = (id && scratchTerms.has(id)) ? id : scratchActiveId;
    const rec = scratchTerms.get(sid); if (!rec) return;
    try { rec.term.reset(); } catch (_) {}
    lite.pty.restart({ id: sid, cols: rec.term.cols, rows: rec.term.rows }); // no cwd → ~
    rec.term.focus();
  }
  function applyTermTheme() { for (const rec of scratchTerms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} } }
  function applyFontSize() { for (const rec of scratchTerms.values()) { rec.term.options.fontSize = settings.fontSize; try { rec.fit.fit(); } catch (_) {} } refitScratch(); }

  function setScratchOpen(open, opts = {}) {
    if (open === scratchOpen) { if (open) refitScratch(true); return; }
    if (open) closeOtherPanels('scratch');
    const delta = layout.scratch + GUTTER;
    scratchOpen = open;
    $('#scratch-pane').classList.toggle('hidden', !open);
    $('#gutter-scratch').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) { ensureScratch(); setTimeout(() => showActiveScratch(), 60); }
    setTimeout(refitActiveTerminal, 160);
  }

  // вывод PTY этого окна (main маршрутизирует scratch-сессии сюда по owner)
  lite.pty.onData(({ id, data }) => { if (isScratch(id)) { const r = scratchTerms.get(id); if (r) r.term.write(data); } });
  lite.pty.onExit(({ id }) => { if (isScratch(id)) { const r = scratchTerms.get(id); if (r) r.term.write('\r\n\x1b[90m[шелл завершён — ⟳ для нового]\x1b[0m\r\n'); } });

  return {
    isOpen: () => scratchOpen,
    setOpen: setScratchOpen,
    toggle: () => setScratchOpen(!scratchOpen),
    restart: () => restartScratch(scratchActiveId),
    refit: () => refitScratch(true),
    applyTermTheme,
    applyFontSize,
  };
}
