// IPC и защита встроенного webview предпросмотра (<webview partition="persist:lite-preview">).
'use strict';

const { validatePreviewUrl } = require('../preview-url');

const PREVIEW_PARTITION = 'persist:lite-preview';
const MAX_LOGS = 150;

/**
 * Регистрация предпросмотра в main: hardening webview, перехват console/network, скриншоты, DevTools.
 * @param {object} deps
 * @param {any} deps.ipcMain
 * @param {any} deps.app
 * @param {any} deps.session
 * @param {any} deps.webContents
 * @param {(buf: Buffer, opts: { dir?: string, prefix?: string }) => { ok?: boolean, path?: string, error?: string }} deps.saveShotPng
 * @param {() => any} deps.getMainWindow
 * @param {(wc: any, ch: string, payload: any) => void} deps.safeSend
 * @param {(lvl: string, src: string, msg: string) => void} [deps.log]
 */
function registerPreviewIpc({ ipcMain, app, session, webContents, saveShotPng, getMainWindow, safeSend, log }) {
  let allowExternal = false;
  let seq = 0;
  /** @type {any[]} */
  const consoleLogs = [];
  /** @type {any[]} */
  const networkErrors = [];
  let sessionHooked = false;

  const pushLog = (arr, item) => {
    arr.push(item);
    if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
  };

  const emitToMain = (payload) => {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (win && !win.isDestroyed()) safeSend(win.webContents, 'preview:event', payload);
  };

  function ensurePreviewSessionHooks() {
    if (sessionHooked) return;
    sessionHooked = true;
    try {
      const ses = session.fromPartition(PREVIEW_PARTITION);
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
      ses.webRequest.onCompleted((details) => {
        if (!details || details.statusCode < 400) return;
        const entry = {
          id: ++seq,
          ts: Date.now(),
          method: details.method || 'GET',
          url: details.url || '',
          statusCode: details.statusCode,
          resourceType: details.resourceType || '',
        };
        pushLog(networkErrors, entry);
        emitToMain({ kind: 'network', entry });
      });
      ses.webRequest.onErrorOccurred((details) => {
        if (!details || details.error === 'net::ERR_ABORTED') return;
        const entry = {
          id: ++seq,
          ts: Date.now(),
          method: details.method || 'GET',
          url: details.url || '',
          error: details.error || 'ERR_FAILED',
          resourceType: details.resourceType || '',
        };
        pushLog(networkErrors, entry);
        emitToMain({ kind: 'network', entry });
      });
    } catch (e) {
      if (typeof log === 'function') log('warn', 'preview', 'session hooks failed: ' + String((e && e.message) || e));
    }
  }

  function hardenWebview(wc) {
    ensurePreviewSessionHooks();
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));

    wc.on('will-navigate', (ev, url) => {
      const v = validatePreviewUrl(url, { allowExternal });
      if (!v.ok) {
        ev.preventDefault();
        emitToMain({ kind: 'blocked', url, error: v.error });
      }
    });

    wc.on('will-redirect', (ev, url) => {
      const v = validatePreviewUrl(url, { allowExternal });
      if (!v.ok) {
        ev.preventDefault();
        emitToMain({ kind: 'blocked', url, error: v.error });
      }
    });

    wc.on('console-message', (_ev, level, message, line, sourceId) => {
      // Electron level: 0 verbose, 1 info, 2 warning, 3 error
      const lvlName = level >= 3 ? 'error' : level === 2 ? 'warn' : 'info';
      const entry = {
        id: ++seq,
        ts: Date.now(),
        level: lvlName,
        message: String(message || '').slice(0, 1000),
        line: Number(line) || 0,
        sourceId: String(sourceId || ''),
      };
      if (level >= 2) pushLog(consoleLogs, entry);
      emitToMain({ kind: 'console', entry });
    });

    wc.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = !!(input.control || input.meta);
      if (ctrl && input.shift && String(input.code) === 'KeyB') {
        ev.preventDefault();
        emitToMain({ kind: 'hotkey', action: 'togglePreview' });
      }
    });
  }

  app.on('web-contents-created', (_ev, wc) => {
    try {
      if (!wc) return;
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (win && !win.isDestroyed() && wc.id === win.webContents.id) {
        wc.on('will-attach-webview', (event, webPreferences, params) => {
          delete webPreferences.preload;
          delete webPreferences.preloadURL;
          webPreferences.nodeIntegration = false;
          webPreferences.nodeIntegrationInSubFrames = false;
          webPreferences.contextIsolation = true;
          webPreferences.sandbox = true;
          webPreferences.webSecurity = true;
          webPreferences.disableDialogs = true;
          webPreferences.partition = PREVIEW_PARTITION;

          const src = params && params.src ? String(params.src) : 'about:blank';
          if (src !== 'about:blank') {
            const v = validatePreviewUrl(src, { allowExternal });
            if (!v.ok) {
              event.preventDefault();
              emitToMain({ kind: 'blocked', url: src, error: v.error });
            }
          }
        });
      }
      if (wc.getType && wc.getType() === 'webview') {
        hardenWebview(wc);
      }
    } catch (_) {}
  });

  ipcMain.handle('preview:setAllowExternal', (_e, /** @type {any} */ { allow } = {}) => {
    allowExternal = !!allow;
    return { ok: true, allowExternal };
  });

  ipcMain.handle('preview:getLogs', () => ({
    ok: true,
    allowExternal,
    consoleLogs: [...consoleLogs],
    networkErrors: [...networkErrors],
  }));

  ipcMain.handle('preview:clearLogs', () => {
    consoleLogs.length = 0;
    networkErrors.length = 0;
    return { ok: true };
  });

  ipcMain.handle('preview:capture', async (_e, /** @type {any} */ { webContentsId, projectDir } = {}) => {
    try {
      const id = Number(webContentsId);
      const wc = Number.isInteger(id) ? webContents.fromId(id) : null;
      if (!wc || wc.isDestroyed() || (wc.getType && wc.getType() !== 'webview')) {
        return { ok: false, error: 'Вкладка предпросмотра не активна' };
      }
      const img = await Promise.race([
        wc.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Таймаут снятия скриншота (6с)')), 6000)),
      ]);
      if (!img || img.isEmpty()) return { ok: false, error: 'Пустой кадр предпросмотра' };
      const res = saveShotPng(img.toPNG(), { dir: projectDir, prefix: 'preview' });
      return res;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('preview:openDevTools', (_e, /** @type {any} */ { webContentsId } = {}) => {
    try {
      const id = Number(webContentsId);
      const wc = Number.isInteger(id) ? webContents.fromId(id) : null;
      if (!wc || wc.isDestroyed() || (wc.getType && wc.getType() !== 'webview')) {
        return { ok: false, error: 'Webview не найден' };
      }
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { registerPreviewIpc, PREVIEW_PARTITION };
