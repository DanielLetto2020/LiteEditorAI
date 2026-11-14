// Доменный модуль «Сейф паролей» (KeePass / .kdbx).
// Расшифровка целиком в main (kdbxweb + @noble/hashes/argon2.js подгружаются лениво при открытии .kdbx).

'use strict';

const fs = require('fs');
const path = require('path');

const KEEPASS_HANDLES = [
  'keepass:pick', 'keepass:open', 'keepass:reveal', 'keepass:copy',
  'keepass:status', 'keepass:entries', 'keepass:cred', 'keepass:add',
];
const KEEPASS_ONS = ['keepass:lock'];

/**
 * @param {object} deps
 * @param {any} deps.app
 * @param {{ handle: (ch: string, fn: (event: any, ...args: any[]) => any) => void, on: (ch: string, fn: (event: any, ...args: any[]) => any) => void }} deps.ipcMain
 * @param {any} deps.dialog
 * @param {any} deps.clipboard
 * @param {(file: string, data: string | Buffer) => void} deps.atomicWriteSync
 * @param {(e: any) => any} deps.senderWin
 * @param {() => any} deps.getMainWindow
 * @param {() => Record<string, any>} deps.lastDirOpts
 * @param {(patch: Record<string, any>) => void} deps.saveState
 */
function registerKeepassIpc(deps) {
  const { app, ipcMain, dialog, clipboard, atomicWriteSync, senderWin, getMainWindow, lastDirOpts, saveState } = deps;

  /** @type {any} */
  let _kdbxweb = null;
  /** @type {any} */
  let _nobleArgon = null;
  function ensureKdbx() {
    if (_kdbxweb) return _kdbxweb;
    _kdbxweb = require('kdbxweb');
    _nobleArgon = require('@noble/hashes/argon2.js');
    _kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type, version) => {
      const fn = type === 0 ? _nobleArgon.argon2d : _nobleArgon.argon2id;
      const out = fn(new Uint8Array(password), new Uint8Array(salt), { t: iterations, m: memory, p: parallelism, dkLen: length, version });
      return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    });
    return _kdbxweb;
  }

  /** @type {any} */
  let kpDb = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let kpClipTimer = null;
  /** @type {(() => void) | null} */
  let kpClipClear = null;
  /** @type {string | null} */
  let kpDbFile = null;
  /** @type {string | null} */
  let kpDbName = null;
  /** @type {string | null} */
  let kpDbStamp = null;
  const kpEntryById = new Map();

  function kpFileStamp(f) { try { const s = fs.statSync(f); return s.mtimeMs + ':' + s.size; } catch (_) { return null; } }
  function kpVal(en, field) { const v = en.fields.get(field); return v && typeof v.getText === 'function' ? v.getText() : (v == null ? '' : String(v)); }

  function kpListEntries() {
    kpEntryById.clear();
    const entries = [];
    const walk = (g, prefix) => {
      const gp = prefix ? prefix + ' / ' + (g.name || '') : (g.name || '');
      for (const en of g.entries) {
        const id = en.uuid && en.uuid.id; if (!id) continue;
        kpEntryById.set(id, en);
        const fields = [];
        for (const [k, v] of en.fields) {
          if (k === 'Title') continue;
          const secret = !!(v && typeof v.getText === 'function');
          if (secret || (v != null && String(v) !== '')) fields.push({ name: k, secret, value: secret ? null : String(v) });
        }
        entries.push({ id, title: kpVal(en, 'Title') || '(без названия)', username: kpVal(en, 'UserName'), url: kpVal(en, 'URL'), group: gp, fields });
      }
      for (const sg of g.groups) walk(sg, gp);
    };
    walk(kpDb.getDefaultGroup(), '');
    return entries;
  }

  ipcMain.handle('keepass:pick', async (e) => {
    const res = await dialog.showOpenDialog(senderWin(e) || getMainWindow(), {
      title: 'Открыть базу KeePass', properties: ['openFile'],
      filters: [{ name: 'KeePass', extensions: ['kdbx'] }, { name: 'Все файлы', extensions: ['*'] }], ...lastDirOpts(),
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const file = res.filePaths[0];
    saveState({ lastOpenDir: path.dirname(file) });
    return { ok: true, path: file, name: path.basename(file) };
  });

  /** @type {(() => void) | null} */
  let kpOwnerUnbind = null;
  function kpBindOwner(wc, db) {
    if (kpOwnerUnbind) kpOwnerUnbind();
    const onGone = () => { kpOwnerUnbind = null; if (kpDb === db) { kpDb = null; kpDbFile = null; kpDbName = null; kpEntryById.clear(); } };
    try { wc.once('destroyed', onGone); } catch (_) {}
    kpOwnerUnbind = () => { kpOwnerUnbind = null; try { wc.removeListener('destroyed', onGone); } catch (_) {} };
  }

  ipcMain.handle('keepass:open', async (e, { path: file, password } = {}) => {
    try {
      if (!file || !fs.existsSync(file)) return { ok: false, error: 'Файл не найден' };
      const kw = ensureKdbx();
      const stamp = kpFileStamp(file);
      const buf = fs.readFileSync(file);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const cred = new kw.Credentials(kw.ProtectedValue.fromString(String(password || '')));
      const db = await kw.Kdbx.load(ab, cred);
      kpDb = db; kpDbFile = file; kpDbName = path.basename(file); kpDbStamp = stamp;
      kpBindOwner(e.sender, db);
      return { ok: true, name: kpDbName, entries: kpListEntries() };
    } catch (err) {
      const code = err && err.code;
      return { ok: false, error: code === 'InvalidKey' ? 'Неверный мастер-пароль' : ('Не удалось открыть базу: ' + ((err && err.message) || err)) };
    }
  });

  ipcMain.handle('keepass:reveal', (_e, { id, field } = {}) => {
    const en = kpEntryById.get(id); if (!en) return { ok: false, error: 'нет записи' };
    return { ok: true, value: kpVal(en, field) };
  });

  ipcMain.handle('keepass:copy', (_e, { id, field } = {}) => {
    const en = kpEntryById.get(id); if (!en) return { ok: false, error: 'нет записи' };
    const val = kpVal(en, field);
    try { clipboard.writeText(val); } catch (_) { return { ok: false, error: 'буфер недоступен' }; }
    if (kpClipTimer) clearTimeout(kpClipTimer);
    kpClipClear = () => { kpClipTimer = null; kpClipClear = null; try { if (clipboard.readText() === val) clipboard.writeText(''); } catch (_) {} };
    kpClipTimer = setTimeout(kpClipClear, 20000);
    return { ok: true };
  });

  ipcMain.on('keepass:lock', () => { if (kpOwnerUnbind) kpOwnerUnbind(); kpDb = null; kpDbFile = null; kpDbName = null; kpEntryById.clear(); });
  app.on('will-quit', () => { if (kpClipClear) { if (kpClipTimer) clearTimeout(kpClipTimer); kpClipClear(); } });

  ipcMain.handle('keepass:status', () => ({ open: !!kpDb, name: kpDbName }));
  ipcMain.handle('keepass:entries', () => {
    if (!kpDb) return { ok: false, closed: true, error: 'База не открыта' };
    try { return { ok: true, name: kpDbName, entries: kpListEntries() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('keepass:cred', (_e, { id } = {}) => {
    const en = kpEntryById.get(id); if (!en) return { ok: false, error: 'нет записи' };
    return { ok: true, username: kpVal(en, 'UserName'), password: kpVal(en, 'Password'), url: kpVal(en, 'URL') };
  });

  let kpAddChain = Promise.resolve();
  ipcMain.handle('keepass:add', (_e, args) => {
    const run = kpAddChain.then(() => kpAddEntry(args || {}));
    kpAddChain = run.then(() => {}, () => {});
    return run;
  });

  /** @param {{ title?: string, username?: string, password?: string, url?: string, notes?: string }} entry */
  async function kpAddEntry({ title, username, password, url, notes } = {}) {
    if (!kpDb || !kpDbFile) return { ok: false, closed: true, error: 'База не открыта' };
    const db = kpDb, file = kpDbFile;
    try {
      const kw = ensureKdbx();
      if (kpFileStamp(file) !== kpDbStamp) return { ok: false, error: 'Файл базы изменился на диске после открытия — откройте его заново, иначе запись затрёт чужие правки' };
      const en = db.createEntry(db.getDefaultGroup());
      en.fields.set('Title', String(title || 'Без названия'));
      if (username) en.fields.set('UserName', String(username));
      if (password) en.fields.set('Password', kw.ProtectedValue.fromString(String(password)));
      if (url) en.fields.set('URL', String(url));
      if (notes) en.fields.set('Notes', String(notes));
      try { fs.copyFileSync(file, file + '.lite-bak'); } catch (_) {}
      try {
        const ab = await db.save();
        atomicWriteSync(file, Buffer.from(ab));
      } catch (e2) {
        const g = en.parentGroup, i = g ? g.entries.indexOf(en) : -1;
        if (i >= 0) g.entries.splice(i, 1);
        throw e2;
      }
      if (kpDb === db) {
        kpDbStamp = kpFileStamp(file);
        kpListEntries();
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
}

module.exports = { registerKeepassIpc, KEEPASS_HANDLES, KEEPASS_ONS };
