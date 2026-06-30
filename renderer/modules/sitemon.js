// LiteEditor — модуль «Мониторинг сайтов» (downdetector-стиль). Окно-модуль из меню «Модули».
// Список отслеживаемых URL: main в фоне периодически проверяет доступность (HTTP статус + задержка),
// хранит историю и шлёт нативное уведомление при СМЕНЕ состояния (упал/поднялся). Это окно — UI:
// добавить/править/удалить сайт, посмотреть статус/задержку/историю, «проверить сейчас».
import { el, icon, toast, makeModal, showConfirm } from '../ui.js';

const lite = window.lite;
const $ = (s) => document.querySelector(s);

function fmtAgo(ts) {
  if (!ts) return 'ещё не проверялся';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + ' с назад';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
  return Math.floor(sec / 3600) + ' ч назад';
}
const fmtInt = (n) => (n >= 60 ? (n % 60 ? Math.floor(n / 60) + ' мин ' + (n % 60) + ' с' : Math.floor(n / 60) + ' мин') : n + ' с');

export function initSitemon() {
  let sites = [];
  let unsub = null;
  const body = $('#sitemon-body');

  async function reload() { try { sites = (await lite.sitemon.list()) || []; render(); } catch (_) {} }

  // ---------------- добавить / править ----------------
  function siteDialog(existing) {
    const { m, close } = makeModal(`<h2>${existing ? 'Изменить сайт' : 'Добавить сайт'}</h2><div class="sm-form"></div><div class="modal-actions"><button class="btn" id="sm-cancel">Отмена</button><button class="btn primary" id="sm-save">${existing ? 'Сохранить' : 'Добавить'}</button></div>`);
    const f = m.querySelector('.sm-form');
    const url = el('input', 'sm-in'); url.placeholder = 'https://example.com'; url.value = existing ? existing.url : ''; url.spellcheck = false;
    const name = el('input', 'sm-in'); name.placeholder = 'Название (необязательно)'; name.value = existing ? existing.name : '';
    const intv = el('input', 'sm-in'); intv.type = 'number'; intv.min = '15'; intv.max = '3600'; intv.value = existing ? existing.intervalSec : 60;
    f.appendChild(el('label', 'sm-l', 'URL')); f.appendChild(url);
    f.appendChild(el('label', 'sm-l', 'Название')); f.appendChild(name);
    f.appendChild(el('label', 'sm-l', 'Интервал проверки, сек (15–3600)')); f.appendChild(intv);
    m.querySelector('#sm-cancel').addEventListener('click', close);
    m.querySelector('#sm-save').addEventListener('click', async () => {
      const payload = { name: name.value, url: url.value, intervalSec: parseInt(intv.value, 10) || 60 };
      const r = existing ? await lite.sitemon.edit(existing.id, payload) : await lite.sitemon.add(payload.name, payload.url, payload.intervalSec);
      if (r && r.ok) { close(); reload(); } else toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' });
    });
    setTimeout(() => url.focus(), 30);
  }

  // ---------------- история (мини-полоса uptime) ----------------
  function historyBar(hist) {
    const bar = el('div', 'sm-hist');
    const arr = (hist || []).slice(-40);
    for (const h of arr) { const c = el('span', 'sm-tick ' + (h.up ? 'up' : 'down')); c.title = new Date(h.t).toLocaleTimeString() + ' · ' + (h.up ? ('OK ' + h.ms + ' мс') : ('недоступен' + (h.code ? ' (HTTP ' + h.code + ')' : ''))); bar.appendChild(c); }
    return bar;
  }
  function uptimePct(hist) { const a = hist || []; if (!a.length) return null; return Math.round((a.filter((h) => h.up).length / a.length) * 100); }

  function siteCard(s) {
    const state = s.up === true ? 'up' : s.up === false ? 'down' : 'unknown';
    const card = el('div', 'sm-card ' + state);
    const top = el('div', 'sm-top');
    top.appendChild(el('span', 'sm-dot ' + state));
    const main = el('div', 'sm-main');
    main.appendChild(el('span', 'sm-name', s.name || s.url));
    main.appendChild(el('span', 'sm-url', s.url));
    top.appendChild(main);
    const acts = el('div', 'sm-acts');
    const chk = el('button', 'icon-btn'); chk.title = 'Проверить сейчас'; chk.appendChild(icon('refresh', 14)); chk.addEventListener('click', () => lite.sitemon.checkNow(s.id)); acts.appendChild(chk);
    const ed = el('button', 'icon-btn'); ed.title = 'Изменить'; ed.appendChild(icon('pencil', 14)); ed.addEventListener('click', () => siteDialog(s)); acts.appendChild(ed);
    const rm = el('button', 'icon-btn'); rm.title = 'Удалить'; rm.appendChild(icon('trash', 14)); rm.addEventListener('click', () => showConfirm('Удалить сайт?', '«' + (s.name || s.url) + '» перестанет отслеживаться.', 'Удалить', async () => { await lite.sitemon.remove(s.id); reload(); })); acts.appendChild(rm);
    top.appendChild(acts);
    card.appendChild(top);

    const stat = el('div', 'sm-stat');
    const label = state === 'up' ? 'Доступен' : state === 'down' ? 'Недоступен' : 'Проверяется…';
    stat.appendChild(el('span', 'sm-state ' + state, label));
    if (s.up === true) stat.appendChild(el('span', 'sm-ms', s.ms + ' мс' + (s.code ? ' · HTTP ' + s.code : '')));
    else if (s.up === false) stat.appendChild(el('span', 'sm-err', s.error || 'нет связи'));
    const up = uptimePct(s.history); if (up != null) stat.appendChild(el('span', 'sm-uptime', 'uptime ' + up + '%'));
    stat.appendChild(el('span', 'sm-meta', fmtAgo(s.checkedAt) + ' · кажд. ' + fmtInt(s.intervalSec)));
    card.appendChild(stat);
    card.appendChild(historyBar(s.history));
    return card;
  }

  function render() {
    if (!body) return; body.textContent = '';
    const head = el('div', 'sm-head');
    head.appendChild(el('span', 'sm-h-title', 'Мониторинг сайтов'));
    const all = el('button', 'btn sm', 'Проверить все'); all.disabled = !sites.length; all.addEventListener('click', () => lite.sitemon.checkNow()); head.appendChild(all);
    const add = el('button', 'btn primary sm', '＋ Сайт'); add.addEventListener('click', () => siteDialog(null)); head.appendChild(add);
    body.appendChild(head);

    if (!sites.length) { body.appendChild(el('div', 'sm-empty', 'Сайтов пока нет. Нажмите «＋ Сайт», чтобы начать отслеживать доступность — при падении придёт уведомление.')); return; }
    const down = sites.filter((s) => s.up === false).length;
    if (down) { const b = el('div', 'sm-banner'); b.appendChild(icon('warning', 15)); b.appendChild(el('span', null, `Недоступны сейчас: ${down} из ${sites.length}`)); body.appendChild(b); }
    const list = el('div', 'sm-list');
    const order = sites.slice().sort((a, b) => (a.up === false ? 0 : 1) - (b.up === false ? 0 : 1) || (a.name || a.url).localeCompare(b.name || b.url));
    for (const s of order) list.appendChild(siteCard(s));
    body.appendChild(list);
  }

  return {
    setOpen(open) {
      const pane = $('#sitemon-pane'); if (pane) pane.classList.toggle('hidden', !open);
      if (open) {
        reload();
        if (!unsub) unsub = lite.sitemon.onUpdate((list) => { sites = list || []; render(); });
      }
    },
    isOpen: () => true,
    addSite: () => siteDialog(null),
    checkAll: () => lite.sitemon.checkNow(),
  };
}
