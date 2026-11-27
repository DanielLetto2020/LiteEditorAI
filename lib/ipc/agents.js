// IPC «Центра агентов» (Mission Control): реестр живых сессий, хвост вывода (128 КБ ring),
// коалесируемая рассылка ТОЛЬКО при наличии подписчиков (0 накладных расходов в фоне) и статистика дня.
'use strict';

const fs = require('fs');
const path = require('path');
const { extractTailLines } = require('../agent-tail');
const { createAgentStats } = require('../agent-stats');
const { resolveGitDirs } = require('../git-watch');

const BRANCH_TTL_MS = 5000;

/**
 * Регистрация IPC для «Центра агентов».
 * @param {object} deps
 * @param {any} deps.ipcMain
 * @param {any} deps.ptyRings
 * @param {() => any[]} deps.getProjects
 * @param {() => any} deps.getStatsData
 * @param {(v: any) => void} deps.setStatsData
 * @param {(sid: string, text: string, enter: boolean) => boolean} deps.writeQuickReply
 * @param {(projId: string, sid: string) => void} deps.jumpToSession
 * @param {(wc: any, ch: string, payload: any) => void} deps.safeSend
 * @param {(lvl: string, src: string, msg: string) => void} [deps.log]
 */
function registerAgentsIpc({ ipcMain, ptyRings, getProjects, getStatsData, setStatsData, writeQuickReply, jumpToSession, safeSend }) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Set<any>} */
  const subscribers = new Set();
  /** @type {Map<string, { branch: string, ts: number }>} */
  const branchCache = new Map();

  const statsTracker = createAgentStats({
    getData: getStatsData,
    setData: setStatsData,
  });

  const dirtyStatus = new Set();
  const dirtyTails = new Set();
  let statusTimer = null;
  let tailTimer = null;
  let statsTimer = null;

  function readBranchCached(projPath) {
    if (!projPath) return '';
    const now = Date.now();
    const hit = branchCache.get(projPath);
    if (hit && now - hit.ts < BRANCH_TTL_MS) return hit.branch;
    let branch = '';
    try {
      const dirs = resolveGitDirs(projPath);
      if (dirs && dirs.gitDir) {
        const headPath = path.join(dirs.gitDir, 'HEAD');
        const head = fs.readFileSync(headPath, 'utf8').trim();
        if (head.startsWith('ref: ')) {
          branch = head.slice(5).replace(/^refs\/heads\//, '');
        } else if (head) {
          branch = head.slice(0, 8);
        }
      }
    } catch (_) {}
    branchCache.set(projPath, { branch, ts: now });
    if (branchCache.size > 100) {
      const first = branchCache.keys().next().value;
      if (first) branchCache.delete(first);
    }
    return branch;
  }

  function lookupProject(projId) {
    const list = typeof getProjects === 'function' ? getProjects() : [];
    return (Array.isArray(list) ? list : []).find((p) => p && p.id === projId) || null;
  }

  function buildTail(sid, sRec) {
    const raw = ptyRings ? ptyRings.readTail(sid, 4096) : '';
    const lines = extractTailLines(raw, 4, 160);
    if (lines.length) return lines;
    if (Array.isArray(sRec && sRec.screenTail) && sRec.screenTail.length) {
      return sRec.screenTail.slice(-4);
    }
    return [];
  }

  function toViewItem(s) {
    const proj = lookupProject(s.projId);
    const projPath = s.projPath || (proj && proj.path) || '';
    const branch = projPath ? readBranchCached(projPath) : '';
    return {
      sid: s.sid,
      projId: s.projId,
      projName: s.projName || (proj && proj.name) || s.projId,
      projPath,
      branch,
      title: s.title || '',
      agentKind: s.agentKind || null,
      status: s.status || 'quiet',
      statusAt: s.statusAt || s.updatedAt || Date.now(),
      updatedAt: s.updatedAt || Date.now(),
      tailLines: s.tailLines || buildTail(s.sid, s),
    };
  }

  function pruneSubscribers() {
    for (const wc of [...subscribers]) {
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) subscribers.delete(wc);
    }
  }

  function broadcastUpdate(payload) {
    pruneSubscribers();
    if (!subscribers.size) return;
    for (const wc of subscribers) {
      safeSend(wc, 'agents:update', payload);
    }
  }

  function flushStatus() {
    statusTimer = null;
    if (!dirtyStatus.size) return;
    const items = [];
    for (const sid of dirtyStatus) {
      const s = sessions.get(sid);
      if (s) {
        s.tailLines = buildTail(sid, s);
        s.lastTailSig = s.tailLines.join('\n');
        items.push(toViewItem(s));
      }
    }
    dirtyStatus.clear();
    if (subscribers.size && items.length) {
      broadcastUpdate({ kind: 'upsert', items });
    }
  }

  function flushTails() {
    tailTimer = null;
    pruneSubscribers();
    if (!subscribers.size || !dirtyTails.size) {
      dirtyTails.clear();
      return;
    }
    const patches = [];
    for (const sid of dirtyTails) {
      const s = sessions.get(sid);
      if (!s) continue;
      const lines = buildTail(sid, s);
      const sig = lines.join('\n');
      if (sig !== s.lastTailSig) {
        s.lastTailSig = sig;
        s.tailLines = lines;
        patches.push({ sid, tailLines: lines, updatedAt: Date.now() });
      }
    }
    dirtyTails.clear();
    if (patches.length) {
      broadcastUpdate({ kind: 'tails', patches });
    }
  }

  function scheduleStatus(sid) {
    dirtyStatus.add(sid);
    if (!subscribers.size || statusTimer) return;
    statusTimer = setTimeout(flushStatus, 50);
  }

  function markTailDirty(sid) {
    if (!subscribers.size || !sessions.has(sid)) return;
    dirtyTails.add(sid);
    if (!tailTimer) tailTimer = setTimeout(flushTails, 250);
  }

  function removeSession(sid) {
    if (!sid) return;
    sessions.delete(sid);
    dirtyStatus.delete(sid);
    dirtyTails.delete(sid);
    statsTracker.removeSession(sid);
    if (subscribers.size) broadcastUpdate({ kind: 'remove', sid });
  }

  statsTimer = setInterval(() => {
    try { statsTracker.checkpoint(); } catch (_) {}
  }, 60 * 1000);
  if (statsTimer.unref) statsTimer.unref();

  ipcMain.on('agents:reportMeta', (_e, meta) => {
    if (!meta || !meta.sid) return;
    const sid = String(meta.sid);
    const now = Date.now();
    const prev = sessions.get(sid);
    const status = String(meta.status || (prev && prev.status) || 'quiet');
    const changedStatus = !prev || prev.status !== status;
    const next = {
      sid,
      projId: String(meta.projId || (prev && prev.projId) || '__global__'),
      projName: meta.projName ? String(meta.projName) : (prev && prev.projName) || '',
      projPath: meta.projPath ? String(meta.projPath) : (prev && prev.projPath) || '',
      title: meta.title != null ? String(meta.title) : (prev && prev.title) || '',
      agentKind: meta.agentKind !== undefined ? meta.agentKind : (prev ? prev.agentKind : null),
      status,
      statusAt: changedStatus ? now : (prev ? prev.statusAt : now),
      updatedAt: now,
      screenTail: Array.isArray(meta.screenTail) ? meta.screenTail : (prev ? prev.screenTail : []),
      tailLines: prev ? prev.tailLines : [],
      lastTailSig: prev ? prev.lastTailSig : '',
    };
    sessions.set(sid, next);
    statsTracker.updateSession(sid, { status, agentKind: next.agentKind, projId: next.projId });
    scheduleStatus(sid);
  });

  ipcMain.handle('agents:subscribe', (e) => {
    const wc = e.sender;
    if (wc && !subscribers.has(wc)) {
      subscribers.add(wc);
      wc.once('destroyed', () => {
        subscribers.delete(wc);
        if (!subscribers.size) {
          if (tailTimer) { clearTimeout(tailTimer); tailTimer = null; }
          dirtyTails.clear();
        }
      });
    }
    const items = [...sessions.values()].map(toViewItem);
    return { ok: true, items, stats: statsTracker.getSummary() };
  });

  ipcMain.handle('agents:unsubscribe', (e) => {
    subscribers.delete(e.sender);
    if (!subscribers.size) {
      if (tailTimer) { clearTimeout(tailTimer); tailTimer = null; }
      dirtyTails.clear();
    }
    return { ok: true };
  });

  ipcMain.handle('agents:snapshot', () => ({
    ok: true,
    items: [...sessions.values()].map(toViewItem),
    stats: statsTracker.getSummary(),
  }));

  ipcMain.handle('agents:quickReply', (_e, /** @type {any} */ { sid, text = '', enter = true } = {}) => {
    if (!sid) return { ok: false, error: 'Не указана сессия' };
    const sent = writeQuickReply(String(sid), String(text || ''), enter !== false);
    if (!sent) return { ok: false, error: 'Терминальная сессия не найдена' };
    return { ok: true };
  });

  ipcMain.handle('agents:jumpToSession', (_e, /** @type {any} */ { projId, sid } = {}) => {
    if (!projId || !sid) return { ok: false, error: 'Не указан проект или сессия' };
    jumpToSession(String(projId), String(sid));
    return { ok: true };
  });

  ipcMain.handle('agents:stats', () => ({ ok: true, stats: statsTracker.getSummary() }));

  ipcMain.handle('agents:resetToday', () => {
    statsTracker.resetToday();
    const summary = statsTracker.getSummary();
    broadcastUpdate({ kind: 'stats', stats: summary });
    return { ok: true, stats: summary };
  });

  return {
    markTailDirty,
    removeSession,
    flush: () => {
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
      try { statsTracker.flush(); } catch (_) {}
    },
  };
}

module.exports = { registerAgentsIpc };
