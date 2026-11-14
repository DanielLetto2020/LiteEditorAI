// Доменный модуль «Озвучка» (модуль voice): ленивая подгрузка python-сайдкара TTS, слежение за буфером обмена
// и маршрутизация «Озвучить» из терминала через единый moduleRouter.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * @param {object} deps
 * @param {{ handle: (ch: string, fn: (event: any, ...args: any[]) => any) => void, on: (ch: string, fn: (event: any, ...args: any[]) => any) => void }} deps.ipcMain
 * @param {any} deps.dialog
 * @param {any} deps.clipboard
 * @param {string} deps.storeDir
 * @param {() => Record<string, any>} deps.readSettingsCached
 * @param {(lvl: string, src: string, msg: string) => void} deps.log
 * @param {(wc: any, ch: string, payload?: any) => void} deps.safeSend
 * @param {(e: any) => any} deps.senderWin
 * @param {() => any} deps.getMainWindow
 * @param {{ sendWhenReady: Function, markReady: Function }} deps.moduleRouter
 */
function registerVoiceIpc(deps) {
  const {
    ipcMain, dialog, clipboard, storeDir,
    readSettingsCached, log, safeSend, senderWin, getMainWindow, moduleRouter,
  } = deps;

  /** @type {typeof import('../tts') | null} */
  let ttsBackend = null;
  function getTts() {
    if (!ttsBackend) {
      ttsBackend = require('../tts');
      ttsBackend.configure({ dir: path.join(storeDir, 'tts'), log });
    }
    return ttsBackend;
  }

  ipcMain.handle('tts:state', (_e, opts = {}) => getTts().state(readSettingsCached(), { fresh: !!opts.fresh }));
  ipcMain.handle('tts:warmup', () => getTts().warmup(readSettingsCached()));
  ipcMain.handle('tts:speak', async (_e, { text, voice, rate } = {}) => {
    const r = await getTts().speak(readSettingsCached(), { text, voice, rate });
    if (!r || r.ok !== true) return r || { ok: false, error: 'синтез не удался' };
    if (r.skipped) return { ok: true, skipped: true, reason: r.reason || '' };
    try { return { ok: true, wav: fs.readFileSync(r.file), dur: r.dur || 0, cached: !!r.cached }; }
    catch (e) { return { ok: false, error: `не прочитать аудио: ${(e && e.message) || e}` }; }
  });
  ipcMain.handle('tts:pick', async (e, what) => {
    const win = senderWin(e) || getMainWindow();
    const r = what === 'model'
      ? await dialog.showOpenDialog(win, {
        title: 'Файл модели голоса (v4_ru.pt)', properties: ['openFile'],
        filters: [{ name: 'Модель Silero', extensions: ['pt'] }],
      })
      : await dialog.showOpenDialog(win, { title: 'Интерпретатор Python с torch', properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });
  ipcMain.handle('tts:downloadModel', async (e) => getTts().downloadModel((p) => safeSend(e.sender, 'tts:downloadProgress', p)));

  const CLIP_POLL_MS = 500;
  /** @type {ReturnType<typeof setInterval> | null} */
  let clipTimer = null;
  /** @type {any} */
  let clipOwner = null;
  let clipLast = '', clipSelLast = '', clipWantSel = false;

  function clipStop() { if (clipTimer) { clearInterval(clipTimer); clipTimer = null; } clipOwner = null; }
  function clipRead(type) { try { return clipboard.readText(type) || ''; } catch (_) { return ''; } }
  function clipMark(t) { return t.length + ':' + crypto.createHash('sha1').update(t).digest('hex'); }
  function clipTick() {
    if (!clipOwner || clipOwner.isDestroyed()) { clipStop(); return; }
    const t = clipRead();
    const mark = t ? clipMark(t) : '';
    if (t && mark !== clipLast) { clipLast = mark; safeSend(clipOwner, 'tts:clip', { text: t, source: 'clipboard' }); }
    if (!clipWantSel) return;
    const s = clipRead('selection');
    const sMark = s ? clipMark(s) : '';
    if (s && sMark !== clipSelLast && sMark !== clipLast) { clipSelLast = sMark; safeSend(clipOwner, 'tts:clip', { text: s, source: 'selection' }); }
  }

  ipcMain.on('tts:clipWatch', (e, opts = {}) => {
    clipWantSel = !!opts.selection;
    if (!opts.on) { clipStop(); return; }
    clipOwner = e.sender;
    const cur = clipRead();
    clipLast = cur ? clipMark(cur) : '';
    const curSel = clipWantSel ? clipRead('selection') : '';
    clipSelLast = curSel ? clipMark(curSel) : '';
    if (!clipTimer) clipTimer = setInterval(clipTick, CLIP_POLL_MS);
  });

  ipcMain.on('voice:open', (_e, payload) => {
    if (!payload || typeof payload !== 'object' || !payload.text) return;
    moduleRouter.sendWhenReady('voice', 'voice:open', payload, { focus: true, maxQueue: 10 });
  });
  ipcMain.on('voice:panelReady', () => {
    moduleRouter.markReady('voice');
  });

  function stop() {
    clipStop();
    if (ttsBackend) { try { ttsBackend.stop(); } catch (_) {} }
  }

  return { stop };
}

module.exports = { registerVoiceIpc };
