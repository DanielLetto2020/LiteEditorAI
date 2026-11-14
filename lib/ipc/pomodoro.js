// Доменный модуль «Помодоро»: долгоживущий движок таймера в main + IPC пульта/оверлея.
// Таймер живёт в main (а не в окне модуля), чтобы отсчёт переживал закрытие окна «Помодоро».

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @param {object} deps
 * @param {{ handle: (ch: string, fn: (event: any, ...args: any[]) => any) => void, on: (ch: string, fn: (event: any, ...args: any[]) => any) => void }} deps.ipcMain
 * @param {any} deps.dialog
 * @param {any} deps.Notification
 * @param {(key: string) => any} deps.readStoreKey
 * @param {(key: string, val: any) => void} deps.writeStoreKey
 * @param {(file: string, data: string | Buffer) => void} deps.atomicWriteSync
 * @param {() => any} deps.loadState
 * @param {(patch: Record<string, any>) => void} deps.saveState
 * @param {() => Record<string, any>} deps.lastDirOpts
 * @param {() => string} deps.backupStamp
 * @param {number} deps.importMaxBytes
 * @param {(e: any) => any} deps.senderWin
 * @param {() => any} deps.getMainWindow
 * @param {() => { id?: string, name?: string } | null} deps.getActiveProject
 * @param {(win: any, ch: string, payload?: any) => boolean} deps.sendTo
 * @param {(ch: string, payload?: any) => void} deps.broadcastToModules
 * @param {(ch: string, payload?: any) => void} deps.forwardToEditor
 */
function registerPomodoroIpc(deps) {
  const {
    ipcMain, dialog, Notification,
    readStoreKey, writeStoreKey, atomicWriteSync,
    loadState, saveState, lastDirOpts, backupStamp, importMaxBytes,
    senderWin, getMainWindow, getActiveProject,
    sendTo, broadcastToModules, forwardToEditor,
  } = deps;

  const POMO = {
    running: false, paused: false,
    phase: 'idle',   // 'idle' | 'work' | 'short' | 'long'
    remaining: 0,    // секунд до конца текущей фазы
    cycle: 0,        // завершённых рабочих интервалов в текущем подходе
    /** @type {any} */
    tech: null,      // снимок техники {name, work, short, long, cyclesBeforeLong, block, allowSkip}
  };
  /** @type {ReturnType<typeof setInterval> | null} */
  let pomoTimer = null;

  function pomoPhaseTotal() {
    const t = POMO.tech || {};
    const mins = POMO.phase === 'work' ? t.work : POMO.phase === 'long' ? t.long : POMO.phase === 'short' ? t.short : 0;
    return Math.max(1, Math.round((mins || 0) * 60));
  }
  function pomoSnapshot() {
    return { running: POMO.running, paused: POMO.paused, phase: POMO.phase, remaining: POMO.remaining, total: pomoPhaseTotal(), cycle: POMO.cycle, tech: POMO.tech };
  }
  function pomoEmit() {
    const snap = pomoSnapshot();
    broadcastToModules('pomodoro:tick', snap);
    sendTo(getMainWindow(), 'pomodoro:tick', snap);
  }

  function readPomoLog() { const v = readStoreKey('pomodoroLog'); return Array.isArray(v) ? v : []; }
  function pomoRecordDone() {
    const log = readPomoLog();
    const activeProjectInfo = getActiveProject();
    log.push({
      ts: Date.now(),
      techName: (POMO.tech && POMO.tech.name) || '',
      workMin: (POMO.tech && POMO.tech.work) || 0,
      projId: (activeProjectInfo && activeProjectInfo.id) || null,
      projName: (activeProjectInfo && activeProjectInfo.name) || null,
    });
    if (log.length > 5000) log.splice(0, log.length - 5000);
    writeStoreKey('pomodoroLog', log);
    broadcastToModules('pomodoro:logChanged', null);
  }

  function pomoNotifyPhase(from, to) {
    if (from === to) return;
    const cfg = readStoreKey('pomodoro') || {};
    /** @type {Record<string, string>} */
    const label = { work: 'Работа', short: 'Короткий перерыв', long: 'Длинный перерыв' };
    if (cfg.notifyOn !== false && Notification.isSupported()) {
      try {
        new Notification({
          title: to === 'work' ? 'Перерыв окончен — за работу' : 'Время отдыхать 🍅',
          body: to === 'work' ? 'Возвращайтесь к делу' : (label[to] + ' — агенты продолжают работать'),
          silent: true,
        }).show();
      } catch (_) {}
    }
    if (cfg.soundOn !== false) sendTo(getMainWindow(), 'pomodoro:chime', { to });
  }

  function pomoSyncOverlay() {
    const onBreak = POMO.running && (POMO.phase === 'short' || POMO.phase === 'long');
    const block = !!(POMO.tech && POMO.tech.block);
    if (onBreak && block) {
      forwardToEditor('editor:restGuard', {
        show: true, phase: POMO.phase, remaining: POMO.remaining, total: pomoPhaseTotal(), paused: POMO.paused,
        allowSkip: !!(POMO.tech && POMO.tech.allowSkip), techName: POMO.tech && POMO.tech.name,
      });
    } else {
      forwardToEditor('editor:restGuard', { show: false });
    }
  }

  function pomoSetPhase(phase) {
    POMO.phase = phase;
    const t = POMO.tech || {};
    const mins = phase === 'work' ? t.work : phase === 'long' ? t.long : phase === 'short' ? t.short : 0;
    POMO.remaining = Math.max(1, Math.round((mins || 0) * 60));
  }

  function pomoAdvance(viaSkip) {
    const t = POMO.tech || {};
    const from = POMO.phase;
    if (from === 'work') {
      if (!viaSkip) pomoRecordDone();
      POMO.cycle += 1;
      const beforeLong = Math.max(1, t.cyclesBeforeLong || 4);
      pomoSetPhase((POMO.cycle % beforeLong === 0) ? 'long' : 'short');
    } else {
      pomoSetPhase('work');
    }
    pomoSyncOverlay();
    pomoNotifyPhase(from, POMO.phase);
    pomoEmit();
  }

  function pomoTick() {
    if (!POMO.running || POMO.paused) return;
    POMO.remaining -= 1;
    if (POMO.remaining <= 0) { pomoAdvance(false); return; }
    if (POMO.phase === 'short' || POMO.phase === 'long') pomoSyncOverlay();
    pomoEmit();
  }

  function pomoEnsureTimer() {
    if (!pomoTimer) { pomoTimer = setInterval(pomoTick, 1000); if (pomoTimer.unref) pomoTimer.unref(); }
  }

  function pomoStart(tech) {
    if (!tech) return { ok: false, error: 'Не задана техника' };
    POMO.tech = {
      name: String(tech.name || 'Помодоро'),
      work: Number(tech.work) || 25, short: Number(tech.short) || 5, long: Number(tech.long) || 15,
      cyclesBeforeLong: Math.max(1, Number(tech.cyclesBeforeLong) || 4),
      block: tech.block !== false, allowSkip: tech.allowSkip !== false,
    };
    POMO.running = true; POMO.paused = false; POMO.cycle = 0;
    pomoSetPhase('work');
    pomoEnsureTimer();
    pomoSyncOverlay();
    pomoEmit();
    return { ok: true };
  }

  function pomoStop() {
    POMO.running = false; POMO.paused = false; POMO.phase = 'idle'; POMO.remaining = 0; POMO.cycle = 0;
    if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = null; }
    pomoSyncOverlay();
    pomoEmit();
    return { ok: true };
  }

  ipcMain.handle('pomodoro:start', (_e, { tech } = {}) => pomoStart(tech));
  ipcMain.handle('pomodoro:stop', () => pomoStop());
  ipcMain.handle('pomodoro:pause', () => { if (POMO.running) { POMO.paused = true; pomoSyncOverlay(); pomoEmit(); } return { ok: true }; });
  ipcMain.handle('pomodoro:resume', () => { if (POMO.running) { POMO.paused = false; pomoSyncOverlay(); pomoEmit(); } return { ok: true }; });
  ipcMain.handle('pomodoro:skip', () => { if (POMO.running) pomoAdvance(true); return { ok: true }; });
  ipcMain.handle('pomodoro:getState', () => pomoSnapshot());
  ipcMain.handle('pomodoro:history', () => readPomoLog());
  ipcMain.on('editor:pomodoroSkip', () => { if (POMO.running && (POMO.phase === 'short' || POMO.phase === 'long')) pomoAdvance(true); });

  ipcMain.handle('pomodoro:exportFile', async (e, { json, name } = {}) => {
    const safe = String(name || 'lite-pomodoro').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 80);
    const last = loadState().lastOpenDir;
    const res = await dialog.showSaveDialog(senderWin(e) || getMainWindow(), {
      title: 'Экспорт техник помодоро',
      defaultPath: path.join(last && fs.existsSync(last) ? last : os.homedir(), `${safe}_${backupStamp()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    try { atomicWriteSync(res.filePath, String(json)); saveState({ lastOpenDir: path.dirname(res.filePath) }); return { ok: true, file: res.filePath }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });

  ipcMain.handle('pomodoro:importFile', async (e) => {
    const res = await dialog.showOpenDialog(senderWin(e) || getMainWindow(), {
      title: 'Импорт техник помодоро', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }], ...lastDirOpts(),
    });
    if (res.canceled || res.filePaths.length === 0) return { canceled: true };
    const file = res.filePaths[0];
    try {
      const stat = fs.statSync(file);
      if (stat.size > importMaxBytes) return { ok: false, error: `Файл слишком большой (${Math.round(stat.size / 1024)} КБ)` };
      const content = fs.readFileSync(file, 'utf8');
      saveState({ lastOpenDir: path.dirname(file) });
      return { ok: true, content };
    } catch (err) { return { ok: false, error: 'Не удалось прочитать файл: ' + String((err && err.message) || err) }; }
  });

  return { stop: pomoStop };
}

module.exports = { registerPomodoroIpc };
