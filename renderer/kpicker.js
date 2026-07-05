// LiteEditor — пикер записей «Сейфа паролей» (KeePass) для форм подключений (db/rmq/kafka/rh).
// Общий хелпер уровня codeedit.js (модули импортируют его напрямую, ядро не участвует).
// Даёт две операции:
//   pickKeepassCred()  — выбрать запись сейфа → { title, username, password, url } | null;
//   saveCredToKeepass(entry) — добавить запись { title, username, password, url, notes } в базу.
// База может быть уже открыта окном «Сейф паролей» (keepass:status) — тогда работаем с ней и НЕ
// лочим по завершении. Если базу разблокировал сам пикер — по завершении шлёт keepass:lock, чтобы
// расшифрованная база не жила в памяти main дольше необходимого. Recent-список файлов общий с
// окном «Сейф паролей» (localStorage lite.keepass.recent). Секреты записи приходят только для
// выбранной записи (keepass:cred) — ровно как ручной ввод пароля в поле формы.
import { el, icon, toast, makeModal } from './ui.js';

const lite = window.lite;
const RECENT_KEY = 'lite.keepass.recent';
function recents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (_) { return []; } }
function pushRecent(p, name) {
  try {
    const a = recents().filter((x) => x && x.path !== p);
    a.unshift({ path: p, name });
    localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, 8)));
  } catch (_) {}
}
async function kpStatus() { try { return await lite.keepass.status(); } catch (_) { return { open: false }; } }

// Модалка-стейт-машина: шаг «разблокировать» (recent + выбор файла + мастер-пароль) → шаг «выбрать
// запись» (поиск + список). mode 'pick' резолвит креды выбранной записи; mode 'unlock' — true после
// успешного открытия базы (для saveCredToKeepass).
function kpModal(mode, startOpen) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; close(); resolve(v); } };
    const { m, close } = makeModal('', () => { if (!settled) { settled = true; resolve(null); } });
    m.classList.add('kpick-modal');

    const head = el('div', 'kpick-head');
    const chip = el('span', 'kpick-chip'); chip.appendChild(icon('key', 16));
    head.append(chip, el('h2', null, mode === 'pick' ? 'Из сейфа паролей' : 'Разблокировать сейф'));
    const body = el('div', 'kpick-body');
    m.append(head, body);

    let pending = null; // { path, name } — выбранная база на шаге unlock
    function showUnlock(msg) {
      body.innerHTML = '';
      if (msg) body.appendChild(el('div', 'kpick-err', msg));
      const rec = recents();
      if (rec.length) {
        body.appendChild(el('div', 'kpick-label', 'Недавние базы'));
        const list = el('div', 'kpick-recents');
        for (const r of rec) {
          const row = el('button', 'kpick-recent'); row.type = 'button';
          row.append(icon('file', 14), el('span', 'kpick-recent-name', r.name || r.path));
          row.title = r.path;
          row.onclick = () => { pending = { path: r.path, name: r.name }; paintPending(); passIn.focus(); };
          list.appendChild(row);
        }
        body.appendChild(list);
      }
      const pickBtn = el('button', 'btn kpick-pickfile');
      pickBtn.append(icon('folder', 14), el('span', null, 'Выбрать файл .kdbx…'));
      pickBtn.onclick = async () => {
        const r = await lite.keepass.pick();
        if (r && r.ok) { pending = { path: r.path, name: r.name }; paintPending(); passIn.focus(); }
      };
      body.appendChild(pickBtn);
      const pendEl = el('div', 'kpick-pending');
      const paintPending = () => { pendEl.textContent = pending ? ('База: ' + (pending.name || pending.path)) : ''; };
      body.appendChild(pendEl);
      const fRow = el('div', 'field');
      fRow.appendChild(el('label', null, 'Мастер-пароль'));
      const passIn = el('input'); passIn.type = 'password'; passIn.placeholder = '••••••••';
      fRow.appendChild(passIn); body.appendChild(fRow);
      const acts = el('div', 'modal-actions');
      const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = () => done(null);
      const openBtn = el('button', 'btn primary', 'Открыть');
      const tryOpen = async () => {
        if (!pending) { toast('Выберите файл базы', { kind: 'warn' }); return; }
        if (!passIn.value) { toast('Введите мастер-пароль', { kind: 'warn' }); return; }
        openBtn.disabled = true;
        const r = await lite.keepass.open(pending.path, passIn.value);
        openBtn.disabled = false;
        if (!r || !r.ok) { showUnlock((r && r.error) || 'Не удалось открыть базу'); return; }
        pushRecent(pending.path, r.name || pending.name);
        if (mode === 'unlock') { done(true); return; }
        showList(r.entries || []);
      };
      openBtn.onclick = tryOpen;
      passIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryOpen(); });
      acts.append(cancel, openBtn); body.appendChild(acts);
      if (rec.length) { pending = { path: rec[0].path, name: rec[0].name }; paintPending(); }
      setTimeout(() => passIn.focus(), 30);
    }

    function showList(entries) {
      body.innerHTML = '';
      const searchWrap = el('div', 'kpick-search');
      searchWrap.appendChild(icon('search', 14));
      const q = el('input'); q.type = 'text'; q.placeholder = 'Поиск записи…';
      searchWrap.appendChild(q); body.appendChild(searchWrap);
      const list = el('div', 'kpick-list'); body.appendChild(list);
      const empty = el('div', 'kpick-empty', 'Ничего не найдено'); empty.hidden = true; body.appendChild(empty);
      const paint = () => {
        const needle = q.value.trim().toLowerCase();
        list.innerHTML = ''; let shown = 0;
        for (const en of entries) {
          const hay = (en.title + ' ' + (en.username || '') + ' ' + (en.url || '') + ' ' + (en.group || '')).toLowerCase();
          if (needle && !hay.includes(needle)) continue;
          shown++;
          const row = el('button', 'kpick-row'); row.type = 'button';
          row.appendChild(icon('key', 13));
          const txt = el('div', 'kpick-row-text');
          txt.appendChild(el('span', 'kpick-row-title', en.title));
          txt.appendChild(el('span', 'kpick-row-sub', [en.username, en.group].filter(Boolean).join(' · ')));
          row.appendChild(txt);
          row.onclick = async () => {
            const r = await lite.keepass.cred(en.id);
            if (!r || !r.ok) { toast((r && r.error) || 'Не удалось прочитать запись', { kind: 'err' }); return; }
            done({ title: en.title, username: r.username || '', password: r.password || '', url: r.url || '' });
          };
          list.appendChild(row);
          if (shown >= 200) break; // кап DOM — поиск сузит
        }
        empty.hidden = shown > 0;
      };
      q.addEventListener('input', paint);
      paint();
      setTimeout(() => q.focus(), 30);
    }

    if (startOpen) {
      lite.keepass.entries().then((r) => {
        if (r && r.ok) showList(r.entries || []);
        else showUnlock(null); // база успела залочиться — обычный шаг разблокировки
      });
    } else showUnlock(null);
  });
}

// Выбрать запись сейфа → { title, username, password, url } | null (отмена).
export async function pickKeepassCred() {
  const st = await kpStatus();
  const res = await kpModal('pick', !!st.open);
  if (!st.open) { try { lite.keepass.lock(); } catch (_) {} } // базу открывал пикер → лочим обратно
  return res;
}

// Готовый ряд кнопок «Из сейфа» / «В сейф» для формы подключения любого модуля.
// opts: { user, pass — input-элементы формы; title(), url() — коллбэки для новой записи; notes }.
export function kpFormButtons(opts) {
  const row = el('div', 'kp-btns');
  const from = el('button', 'btn kp-btn'); from.type = 'button';
  from.append(icon('key', 13), el('span', null, 'Из сейфа'));
  from.title = 'Заполнить пользователя и пароль из записи KeePass';
  from.onclick = async () => {
    const cred = await pickKeepassCred(); if (!cred) return;
    if (opts.user && cred.username) opts.user.value = cred.username;
    if (opts.pass && cred.password) opts.pass.value = cred.password;
    toast('Логин/пароль подставлены из сейфа', { ttl: 3500 });
  };
  const to = el('button', 'btn kp-btn'); to.type = 'button';
  to.append(icon('upload', 13), el('span', null, 'В сейф'));
  to.title = 'Сохранить эти логин/пароль записью в KeePass';
  to.onclick = () => {
    const pv = opts.pass ? opts.pass.value : '';
    if (!pv) { toast('Введите пароль — сохранять в сейф нечего', { kind: 'warn' }); return; }
    saveCredToKeepass({
      title: (opts.title && opts.title()) || 'LiteEditor',
      username: opts.user ? opts.user.value.trim() : '',
      password: pv,
      url: (opts.url && opts.url()) || '',
      notes: opts.notes || 'LiteEditor',
    });
  };
  row.append(from, to);
  return row;
}

// Добавить запись в сейф (форма подключения → «в сейф»). true — записано.
export async function saveCredToKeepass(entry) {
  const st = await kpStatus();
  if (!st.open) {
    const unlocked = await kpModal('unlock', false);
    if (!unlocked) return false;
  }
  let ok = false;
  try {
    const r = await lite.keepass.add(entry || {});
    if (r && r.ok) { toast('Запись добавлена в сейф паролей', { ttl: 4000 }); ok = true; }
    else toast((r && r.error) || 'Не удалось записать в сейф', { kind: 'err', ttl: 8000 });
  } catch (e) { toast(String(e), { kind: 'err' }); }
  if (!st.open) { try { lite.keepass.lock(); } catch (_) {} }
  return ok;
}
