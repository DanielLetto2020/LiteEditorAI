// Вынесенное окно терминалов одного проекта (module.html?projId=<id>#projterm).
// Работает поверх общего движка renderer/term-core.js и сохраняет живые PTY при выносе и возврате.

import { summarizeDetachedStatus } from '../lib/projterm-state.js';
import { t as tt } from './i18n.js';
import { icon, toast, initMenus } from './ui.js';
import { scanTermBuffer, createRestGuardController, createTermEngine } from './term-core.js';

const $ = (sel) => document.querySelector(sel);

export function initProjTermWindow(host) {
  const lite = window.lite;
  const params = new URLSearchParams(location.search || '');
  const projId = params.get('projId') || '';

  const pane = $('#projterm-pane');
  initMenus();
  let project = { id: projId, name: projId || 'Проект', path: '', accent: '' };
  let splitFrac = 0.5;
  let engine = null;
  let docking = false;
  let statusTimer = null;
  let snapTimer = null;
  let lastNotifyAt = 0;

  const applyRestGuard = createRestGuardController({
    lite,
    onRestored: () => {
      if (!engine) return;
      engine.showActiveTerminal();
      const rec = engine.terms.get(engine.activeSessionId());
      if (rec) rec.term.focus();
    },
  });

  function isTextEntry(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.closest('.xterm')) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
  }

  function bumpFont(delta) {
    host.settings.fontSize = Math.max(9, Math.min(24, (host.settings.fontSize || 14) + delta));
    host.saveSettings();
    if (engine) engine.applyFontSize();
    try { lite.app.settingsChanged(host.settings); } catch (_) {}
  }

  function runDetachedHotkey(e) {
    if (!e.ctrlKey || e.metaKey) return false;
    if (isTextEntry(e.target)) return false;
    if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); bumpFont(1); return true; }
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); bumpFont(-1); return true; }
    if (e.code === 'KeyD' && e.shiftKey && engine) { e.preventDefault(); engine.toggleTermSplit(); return true; }
    return false;
  }

  function buildStatusPayload() {
    if (!engine) return summarizeDetachedStatus(projId, []);
    const sessions = engine.projSessions(projId).map((sid) => {
      const rec = engine.terms.get(sid);
      const live = !!rec;
      const exited = !!(rec && rec.exited);
      const state = live ? (engine.projState.get(sid) || 'quiet') : 'idle';
      const agent = live ? engine.sessionAgent(sid) : null;
      return {
        sid,
        live,
        exited,
        state,
        agent,
        idle: live && (exited || !agent),
      };
    });
    return summarizeDetachedStatus(projId, sessions);
  }

  function flushStatusReport() {
    clearTimeout(statusTimer);
    statusTimer = null;
    if (!projId) return;
    try { lite.projTerm.reportStatus(buildStatusPayload()); } catch (_) {}
  }

  function scheduleStatusReport() {
    if (statusTimer) return;
    statusTimer = setTimeout(flushStatusReport, 80);
  }

  function flushSnapshotSync() {
    clearTimeout(snapTimer);
    snapTimer = null;
    if (!projId || !engine) return;
    const snap = engine.exportProjectSnapshot(projId);
    if (snap) {
      try { lite.projTerm.syncSnapshot(projId, snap); } catch (_) {}
    }
  }

  function scheduleSnapshotSync() {
    if (snapTimer) return;
    snapTimer = setTimeout(flushSnapshotSync, 150);
  }

  function notifyLocalAgent(state, sid, reason) {
    if (!host.settings.notifications) return;
    if (!engine) return;
    if (sid === engine.activeSessionId() && document.hasFocus()) return;
    if (Date.now() - lastNotifyAt < 1200) return;
    lastNotifyAt = Date.now();
    const title = state !== 'waiting' ? tt('✓ {0} — агент закончил', project.name)
      : reason === 'permission prompt' ? tt('⏳ {0} — Claude просит разрешения', project.name)
      : reason === 'input needed' ? tt('⏳ {0} — Claude задал вопрос', project.name)
      : tt('⏳ {0} — агент ждёт ответа', project.name);
    try {
      const n = new Notification(title, { body: project.path || '', silent: !host.settings.sound, tag: 'lite-' + projId });
      n.onclick = () => { lite.projTerm.focusSession(projId, sid); };
    } catch (_) {}
  }

  function startDockBack() {
    if (docking || !projId) return;
    docking = true;
    const dockBtn = /** @type {HTMLButtonElement | null} */ ($('#pt-dock'));
    if (dockBtn) dockBtn.disabled = true;
    flushSnapshotSync();
    lite.projTerm.dock(projId).catch(() => {
      docking = false;
      if (dockBtn) dockBtn.disabled = false;
    });
  }

  function updateProjectHeader(p) {
    const name = (p && p.name) || projId || 'Проект';
    document.title = 'LiteEditorAI — ' + name;
    const nameEl = $('#pt-proj-name');
    if (nameEl) nameEl.textContent = name;
    const dotEl = /** @type {HTMLElement | null} */ ($('.pt-proj-dot'));
    if (dotEl) dotEl.style.background = (p && p.accent) ? p.accent : 'var(--accent)';
    const pathEl = $('#pt-proj-path');
    if (pathEl) {
      const folder = (p && p.path) || '';
      pathEl.replaceChildren(icon('folder', 13), Object.assign(document.createElement('span'), { className: 'ct', textContent: folder }));
      pathEl.title = folder;
    }
  }

  const minBtn = $('#pt-min');
  const maxBtn = $('#pt-max');
  const closeBtn = $('#pt-close');
  const dockBtn = $('#pt-dock');
  if (minBtn) minBtn.onclick = () => lite.win.minimize();
  if (maxBtn) maxBtn.onclick = () => lite.win.maximizeToggle();
  if (closeBtn) closeBtn.onclick = startDockBack;
  if (dockBtn) dockBtn.onclick = startDockBack;

  engine = createTermEngine({
    lite,
    STORE: host.STORE,
    persist: host.persist,
    getSettings: () => host.settings,
    saveSettings: host.saveSettings,
    termTheme: host.termTheme,
    getProjects: () => [project],
    getActiveId: () => projId,
    isDetached: () => false,
    getSplitFrac: () => splitFrac,
    setSplitFrac: (frac, save) => {
      splitFrac = frac;
      if (save) scheduleSnapshotSync();
    },
    onStatusChange: () => scheduleStatusReport(),
    onTabsChanged: () => scheduleSnapshotSync(),
    onTurnEnd: (_pid, st, sid, reason, worked) => {
      scheduleStatusReport();
      if (st === 'waiting' || worked) notifyLocalAgent(st, sid, reason);
    },
    onHotkey: runDetachedHotkey,
    onSessionExit: () => {
      scheduleStatusReport();
      scheduleSnapshotSync();
    },
  });

  engine.bindUiEvents();
  document.addEventListener('keydown', (e) => { runDetachedHotkey(e); });

  lite.pty.onData(({ id, data }) => engine.handlePtyData(id, data));
  lite.pty.onExit(({ id }) => engine.handlePtyExit(id));

  lite.projTerm.onCollect(({ reqId }) => {
    const snap = engine.exportProjectSnapshot(projId);
    lite.projTerm.sendCollectResult(reqId, snap);
  });

  lite.projTerm.onFocusSession(({ sid }) => {
    if (sid && engine.hasTabSession(sid)) engine.switchTab(sid);
    const target = sid || engine.activeSessionId();
    const rec = target ? engine.terms.get(target) : null;
    if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
  });

  lite.projTerm.onSendText(({ text }) => {
    if (text) engine.sendTextToProject(project, text, { focusProject: false });
  });

  lite.projTerm.onSearchBuffers(({ reqId, query, isRe, caseSens }) => {
    const hits = [];
    for (const [sid, rec] of engine.terms) {
      const list = scanTermBuffer(rec.term, query || '', { isRe: !!isRe, caseSens: !!caseSens });
      for (const h of list) {
        hits.push({ sid, name: rec.name || 'терминал', y: h.y, text: h.text });
      }
    }
    lite.projTerm.sendSearchResult(reqId, hits);
  });

  lite.editorBus.onRestGuard((s) => { try { applyRestGuard(s); } catch (_) {} });

  if (pane) {
    let rezTimer = null;
    new ResizeObserver(() => {
      clearTimeout(rezTimer);
      rezTimer = setTimeout(() => engine.refitActiveTerminal(), 80);
    }).observe(pane);
  }

  // Загружаем переданный снимок вкладок и живые сессии
  (async () => {
    try {
      const res = await lite.projTerm.getInit(projId);
      if (!res || !res.ok) {
        toast('Не удалось открыть окно терминалов проекта', { kind: 'err' });
        try { lite.win.confirmClose(); } catch (_) {}
        return;
      }
      if (res.project) project = { ...project, ...res.project };
      if (res.snapshot && Number.isFinite(res.snapshot.splitFrac)) splitFrac = res.snapshot.splitFrac;
      updateProjectHeader(project);
      engine.importProjectSnapshot(project, res.snapshot, {
        aliveLiveIds: res.aliveLiveIds || null,
        deadOnDetachIds: res.deadOnDetachIds || null,
        applySplitFrac: true,
      });
      engine.showActiveTerminal();
      flushSnapshotSync();
      flushStatusReport();
    } catch (e) {
      toast('Ошибка запуска окна терминалов: ' + ((e && e.message) || e), { kind: 'err' });
    }
  })();

  return {
    setOpen(open) {
      if (pane) pane.classList.toggle('hidden', !open);
      if (open) engine.refitActiveTerminal(true);
    },
    applyTermTheme() { engine.applyThemeAll(); },
    applyFontSize() { engine.applyFontSize(); },
    applyTimeline() { engine.applyTimeline(); },
    refit() { engine.refitActiveTerminal(); },
  };
}
