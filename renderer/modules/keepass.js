// LiteEditor — модуль «Сейф паролей» (KeePass/.kdbx). Окно-модуль из меню «Модули».
// Открыть базу KeePass по мастер-паролю и СКОПИРОВАТЬ пароль/токен/любое поле в буфер, не выходя в
// другое приложение. Вся расшифровка — в main (Node + kdbxweb); сюда приходят только МЕТАДАННЫЕ
// записей (заголовок/логин/URL/имена полей и значения НЕсекретных полей). Секретные значения
// (пароли и protected-поля) в рендерер не передаются — копирование/показ делает main по запросу.
// Буфер авто-очищается через ~20с (в main). База стирается из памяти main на «Закрыть»/закрытие окна.
import { el, icon, toast } from '../ui.js';

const lite = window.lite;
const $ = (s) => document.querySelector(s);
const RECENT_KEY = 'lite.keepass.recent';

const KNOWN_LABEL = { UserName: 'Логин', Password: 'Пароль', URL: 'URL', Notes: 'Заметки' };

export function initKeepass() {
  let entries = [];        // метаданные записей из main
  let dbName = '';
  let pending = null;      // {path, name} — файл выбран, ждём мастер-пароль
  let sel = null;          // выбранная запись (метаданные)
  let q = '';
  const body = $('#keepass-body');

  // ---------------- недавние файлы ----------------
  function recents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (_) { return []; } }
  function pushRecent(p, name) { if (!p) return; let r = recents().filter((x) => x.path !== p); r.unshift({ path: p, name }); r = r.slice(0, 8); try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch (_) {} }

  // ---------------- открытие / разблокировка / закрытие ----------------
  async function pickFile() {
    const r = await lite.keepass.pick();
    if (!r || r.canceled) return;
    if (!r.ok) { toast(r.error || 'Не удалось выбрать файл', { kind: 'err' }); return; }
    pending = { path: r.path, name: r.name }; render();
  }
  function openRecent(p, name) { pending = { path: p, name }; render(); }
  async function unlock(password) {
    if (!pending) return;
    if (!password) { toast('Введите мастер-пароль', { kind: 'warn' }); return; }
    const r = await lite.keepass.open(pending.path, password);
    if (!r || !r.ok) { toast((r && r.error) || 'Не удалось открыть', { kind: 'err' }); return; }
    entries = r.entries || []; dbName = r.name || pending.name; pushRecent(pending.path, dbName);
    pending = null; sel = null; q = ''; render();
  }
  function lock() { try { lite.keepass.lock(); } catch (_) {} entries = []; dbName = ''; sel = null; pending = null; q = ''; render(); }
  const isOpen = () => entries.length > 0 || dbName !== '';

  function copyField(id, field, label) {
    lite.keepass.copy(id, field).then((r) => {
      if (r && r.ok) toast(`${label}: скопировано (очистится через 20 с)`, { kind: 'ok' });
      else toast((r && r.error) || 'Не удалось скопировать', { kind: 'err' });
    });
  }

  // ---------------- рендер ----------------
  function render() { if (!body) return; body.textContent = ''; if (!isOpen()) renderLocked(); else renderVault(); }

  function renderLocked() {
    const wrap = el('div', 'kp-locked');
    wrap.appendChild(icon('key', 38));
    wrap.appendChild(el('div', 'kp-locked-h', 'Сейф паролей (KeePass)'));
    if (!pending) {
      wrap.appendChild(el('div', 'kp-locked-tx', 'Откройте файл базы .kdbx — пароли и токены можно будет копировать прямо здесь, не переходя в другое приложение.'));
      const open = el('button', 'btn primary', 'Открыть .kdbx…'); open.addEventListener('click', pickFile); wrap.appendChild(open);
      const rec = recents();
      if (rec.length) {
        const rl = el('div', 'kp-recent'); rl.appendChild(el('div', 'kp-recent-h', 'Недавние'));
        for (const r of rec) {
          const row = el('button', 'kp-recent-row'); row.title = r.path;
          row.appendChild(icon('database', 14)); row.appendChild(el('span', 'kp-recent-name', r.name));
          row.addEventListener('click', () => openRecent(r.path, r.name));
          rl.appendChild(row);
        }
        wrap.appendChild(rl);
      }
    } else {
      wrap.appendChild(el('div', 'kp-locked-tx', 'Файл: ' + (pending.name || pending.path)));
      const form = el('div', 'kp-unlock');
      const pi = el('input', 'kp-pass'); pi.type = 'password'; pi.placeholder = 'Мастер-пароль'; pi.autocomplete = 'off';
      pi.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(pi.value); });
      const go = el('button', 'btn primary', 'Разблокировать'); go.addEventListener('click', () => unlock(pi.value));
      const cancel = el('button', 'btn', 'Отмена'); cancel.addEventListener('click', () => { pending = null; render(); });
      form.appendChild(pi); form.appendChild(go); form.appendChild(cancel);
      wrap.appendChild(form);
      setTimeout(() => pi.focus(), 30);
    }
    body.appendChild(wrap);
  }

  function renderVault() {
    const head = el('div', 'kp-head');
    head.appendChild(el('span', 'kp-db-name', dbName || 'База'));
    const search = el('input', 'kp-search'); search.type = 'search'; search.placeholder = 'Поиск по записям…'; search.value = q;
    search.addEventListener('input', () => { q = search.value; renderList(); });
    head.appendChild(search);
    body.appendChild(head);
    const split = el('div', 'kp-split');
    const listBox = el('div', 'kp-list'); listBox.id = 'kp-list';
    const detail = el('div', 'kp-detail'); detail.id = 'kp-detail';
    split.appendChild(listBox); split.appendChild(detail);
    body.appendChild(split);
    renderList(); renderDetail();
  }

  function matchEntry(en) {
    if (!q) return true;
    const hay = (en.title + ' ' + (en.username || '') + ' ' + (en.url || '') + ' ' + (en.group || '')).toLowerCase();
    return hay.includes(q.toLowerCase());
  }
  function renderList() {
    const box = $('#kp-list'); if (!box) return; box.textContent = '';
    const items = entries.filter(matchEntry).sort((a, b) => a.title.localeCompare(b.title));
    if (!items.length) { box.appendChild(el('div', 'kp-empty', 'Ничего не найдено.')); return; }
    for (const en of items) {
      const row = el('div', 'kp-row' + (sel && sel.id === en.id ? ' active' : ''));
      const main = el('div', 'kp-row-main');
      main.appendChild(el('span', 'kp-row-title', en.title));
      main.appendChild(el('span', 'kp-row-sub', en.username || en.group || ''));
      row.appendChild(main);
      const hasPass = (en.fields || []).some((f) => f.name === 'Password');
      if (hasPass) { const qp = el('button', 'icon-btn kp-quick'); qp.title = 'Скопировать пароль'; qp.appendChild(icon('key', 14)); qp.addEventListener('click', (e) => { e.stopPropagation(); copyField(en.id, 'Password', 'Пароль'); }); row.appendChild(qp); }
      row.addEventListener('click', () => { sel = en; renderList(); renderDetail(); });
      box.appendChild(row);
    }
  }

  function fieldRow(en, f) {
    const label = KNOWN_LABEL[f.name] || f.name;
    const r = el('div', 'kp-field');
    r.appendChild(el('span', 'kp-field-l', label));
    const val = el('span', 'kp-field-v' + (f.secret || f.name === 'URL' ? ' mono' : ''));
    if (f.secret) { val.textContent = '••••••••'; }
    else val.textContent = f.value || '';
    r.appendChild(val);
    const acts = el('div', 'kp-field-acts');
    if (f.secret) {
      const eye = el('button', 'icon-btn'); eye.title = 'Показать'; eye.appendChild(icon('eye', 14));
      let shown = false;
      eye.addEventListener('click', async () => {
        if (shown) { val.textContent = '••••••••'; shown = false; return; }
        const rr = await lite.keepass.reveal(en.id, f.name);
        if (rr && rr.ok) { val.textContent = rr.value; shown = true; } else toast('Не удалось показать', { kind: 'err' });
      });
      acts.appendChild(eye);
    }
    if (f.name === 'URL' && f.value) {
      const open = el('button', 'icon-btn'); open.title = 'Открыть в браузере'; open.appendChild(icon('globe', 14));
      open.addEventListener('click', () => lite.openInBrowser(f.value).then((rr) => { if (rr && rr.error) toast(rr.error, { kind: 'err' }); }));
      acts.appendChild(open);
    }
    const cp = el('button', 'icon-btn'); cp.title = 'Скопировать'; cp.appendChild(icon('copy', 14));
    cp.addEventListener('click', () => copyField(en.id, f.name, label));
    acts.appendChild(cp); r.appendChild(acts);
    return r;
  }
  function renderDetail() {
    const box = $('#kp-detail'); if (!box) return; box.textContent = '';
    if (!sel) { box.appendChild(el('div', 'kp-empty', 'Выберите запись слева.')); return; }
    box.appendChild(el('div', 'kp-detail-title', sel.title));
    const order = { UserName: 0, Password: 1, URL: 2, Notes: 9 };
    const fields = (sel.fields || []).slice().sort((a, b) => (order[a.name] ?? 5) - (order[b.name] ?? 5));
    for (const f of fields) {
      if (f.name === 'Notes' && !f.secret) { box.appendChild(el('div', 'kp-field-l', 'Заметки')); const n = el('div', 'kp-notes'); n.textContent = f.value || ''; box.appendChild(n); continue; }
      box.appendChild(fieldRow(sel, f));
    }
    if (!fields.length) box.appendChild(el('div', 'kp-empty', 'У записи нет полей.'));
  }

  return {
    setOpen(open) { const pane = $('#keepass-pane'); if (pane) pane.classList.toggle('hidden', !open); if (open) render(); },
    isOpen: () => true,
    openFile: pickFile,
    lock,
    confirmClose(proceed) { lock(); proceed(); }, // закрытие окна → стереть базу из памяти
  };
}
