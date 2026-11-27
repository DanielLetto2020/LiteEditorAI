// Модуль «Центр агентов» (Mission Control): сетка живых сессий, быстрые ответы и дневная статистика.
const lite = window.lite;

const ST_LABEL = {
  busy: 'Работает',
  waiting: 'Ждёт ответа',
  quiet: 'Ожидание',
  idle: 'Простой',
};

function fmtDur(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

export function initAgents(host) {
  const { el, icon, toast, showConfirm } = host;
  const pane = document.getElementById('agents-pane');
  const root = document.getElementById('agents-body');
  if (!pane || !root) return {};

  let tab = 'live'; // live | stats
  let filterStatus = 'all'; // all | waiting | busy
  let search = '';
  /** @type {Map<string, any>} */
  const sessionsMap = new Map();
  let statsSummary = null;
  let subscribed = false;
  let unsubUpdate = null;

  function render() {
    if (!root) return;
    root.replaceChildren();

    const top = el('div', 'agents-top');
    const tabs = el('div', 'agents-tabs');
    for (const [id, lbl] of [['live', 'Живой обзор'], ['stats', 'Статистика']]) {
      const b = el('button', 'agents-tab' + (tab === id ? ' on' : ''), lbl);
      b.onclick = () => { tab = id; render(); };
      tabs.appendChild(b);
    }
    top.appendChild(tabs);

    if (tab === 'live') {
      const fGrp = el('div', 'agents-filter-grp');
      const itemsAll = [...sessionsMap.values()];
      const waitCnt = itemsAll.filter((s) => s.status === 'waiting').length;
      const busyCnt = itemsAll.filter((s) => s.status === 'busy').length;
      for (const [fid, flbl] of [
        ['all', `Все (${itemsAll.length})`],
        ['waiting', `Ждут ответа (${waitCnt})`],
        ['busy', `Работают (${busyCnt})`],
      ]) {
        const fb = el('button', 'agents-fbtn' + (filterStatus === fid ? ' on' : ''), flbl);
        fb.onclick = () => { filterStatus = fid; render(); };
        fGrp.appendChild(fb);
      }
      const sIn = /** @type {HTMLInputElement} */ (document.createElement('input'));
      sIn.type = 'text'; sIn.className = 'agents-search'; sIn.placeholder = 'Фильтр по проекту или ветке…';
      sIn.value = search;
      sIn.oninput = () => { search = sIn.value; renderGridOnly(); };
      top.append(fGrp, sIn);
    } else {
      const sp = el('span', 'grow');
      const clr = el('button', 'btn', 'Сбросить сегодня');
      clr.onclick = async () => {
        if (!(await showConfirm('Сбросить счётчики за сегодня?'))) return;
        const r = await lite.agents.resetToday();
        if (r && r.ok) { statsSummary = r.stats; render(); }
      };
      top.append(sp, clr);
    }
    root.appendChild(top);

    const content = el('div', 'agents-content');
    content.id = 'agents-content-box';
    root.appendChild(content);

    if (tab === 'live') renderGridOnly();
    else renderStats(content);
  }

  function renderGridOnly() {
    const content = document.getElementById('agents-content-box');
    if (!content) return;
    content.replaceChildren();
    const q = search.trim().toLowerCase();
    const orderRank = (st) => (st === 'waiting' ? 0 : st === 'busy' ? 1 : 2);
    const list = [...sessionsMap.values()]
      .filter((s) => (filterStatus === 'all' ? true : s.status === filterStatus))
      .filter((s) => !q || String(s.projName || '').toLowerCase().includes(q) || String(s.branch || '').toLowerCase().includes(q) || String(s.agentKind || '').toLowerCase().includes(q))
      .sort((a, b) => (orderRank(a.status) - orderRank(b.status)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));

    if (!list.length) {
      content.appendChild(el('div', 'rest-empty', 'Нет активных сессий по заданному фильтру'));
      return;
    }

    const grid = el('div', 'agents-grid');
    for (const s of list) {
      const card = el('div', 'agents-card st-' + (s.status || 'quiet'));
      const chead = el('div', 'agents-chead');
      const pn = el('span', 'agents-proj', s.projName || s.projId); pn.setAttribute('data-no-i18n', '');
      chead.appendChild(pn);
      if (s.branch) {
        const br = el('span', 'agents-branch', s.branch); br.setAttribute('data-no-i18n', '');
        chead.appendChild(br);
      }
      const pill = el('span', 'agents-pill ' + (s.status || 'quiet'), ST_LABEL[s.status] || s.status);
      chead.appendChild(pill);
      card.appendChild(chead);

      const meta = el('div', 'agents-meta');
      const ak = el('span', null, s.agentKind ? `${s.agentKind}` : 'shell'); ak.setAttribute('data-no-i18n', '');
      const tm = el('span', null, `• ${fmtDur(Date.now() - (s.statusAt || Date.now()))}`); tm.setAttribute('data-no-i18n', '');
      const goBtn = el('button', 'btn rest-mini-btn'); goBtn.style.marginLeft = 'auto';
      goBtn.append(icon('arrow-right', 12), el('span', null, 'Перейти'));
      goBtn.onclick = () => lite.agents.jumpToSession(s.projId, s.sid);
      meta.append(ak, tm, goBtn);
      card.appendChild(meta);

      const tail = el('pre', 'agents-tail', (Array.isArray(s.tailLines) && s.tailLines.length) ? s.tailLines.join('\n') : '…');
      tail.setAttribute('data-no-i18n', '');
      card.appendChild(tail);

      const rbar = el('div', 'agents-reply-bar');
      if (s.status === 'waiting') {
        for (const [lbl, tx] of [['Да (y)', 'y'], ['Нет (n)', 'n'], ['Enter', '']]) {
          const qb = el('button', 'btn rest-mini-btn', lbl);
          qb.onclick = async () => {
            const res = await lite.agents.quickReply({ sid: s.sid, text: tx, enter: true });
            if (res && !res.ok) toast(res.error || 'Не удалось отправить ответ', { kind: 'err' });
          };
          rbar.appendChild(qb);
        }
      }
      const rIn = /** @type {HTMLInputElement} */ (document.createElement('input'));
      rIn.type = 'text'; rIn.className = 'agents-reply-in'; rIn.placeholder = 'Быстрый ответ в терминал…';
      rIn.setAttribute('data-no-i18n', '');
      rIn.onkeydown = async (e) => {
        if (e.key === 'Enter' && rIn.value) {
          e.preventDefault();
          const val = rIn.value; rIn.value = '';
          await lite.agents.quickReply({ sid: s.sid, text: val, enter: true });
        }
      };
      rbar.appendChild(rIn);
      card.appendChild(rbar);
      grid.appendChild(card);
    }
    content.appendChild(grid);
  }

  function renderStats(content) {
    const sum = statsSummary || { today: { workingMs: 0, waitingMs: 0, idleMs: 0, turns: 0, byAgent: {}, byProject: {} }, days: [] };
    const td = sum.today || {};
    const kpi = el('div', 'agents-kpi-row');
    for (const [val, lbl] of [
      [fmtDur(td.workingMs), 'Время работы сегодня'],
      [fmtDur(td.waitingMs), 'Ожидание ответа сегодня'],
      [String(td.turns || 0), 'Завершённых циклов'],
      [String(Object.keys(td.byAgent || {}).length), 'Активных типов агентов'],
    ]) {
      const box = el('div', 'agents-kpi');
      const b = el('b', null, val); b.setAttribute('data-no-i18n', '');
      box.append(b, el('span', null, lbl));
      kpi.appendChild(box);
    }
    content.appendChild(kpi);

    const days = (sum.days || []).slice(-14);
    if (days.length) {
      const maxW = Math.max(1, ...days.map((d) => d.workingMs || 0));
      const bars = el('div', 'agents-bars');
      for (const d of days) {
        const col = el('div', 'agents-bar-col');
        const fill = el('div', 'agents-bar-fill');
        fill.style.height = Math.max(3, Math.round(((d.workingMs || 0) / maxW) * 100)) + '%';
        fill.title = `${d.date}: ${fmtDur(d.workingMs)} (${d.turns || 0})`;
        const lbl = el('div', 'agents-bar-lbl', String(d.date || '').slice(5)); lbl.setAttribute('data-no-i18n', '');
        col.append(fill, lbl);
        bars.appendChild(col);
      }
      content.appendChild(bars);
    }

    const byAgent = Object.entries(td.byAgent || {});
    if (byAgent.length) {
      const tbl = el('div', 'rest-hdr-tbl');
      for (const [ag, v] of byAgent) {
        const r = el('div', 'rest-hdr-row');
        const k = el('b', null, ag); k.setAttribute('data-no-i18n', '');
        const val = el('span', null, `${fmtDur(v.workingMs)} работы · ${fmtDur(v.waitingMs)} ожидания · ${v.turns || 0} циклов`);
        val.setAttribute('data-no-i18n', '');
        r.append(k, val);
        tbl.appendChild(r);
      }
      content.appendChild(tbl);
    }
  }

  async function ensureSubscribed() {
    if (subscribed) return;
    subscribed = true;
    if (!unsubUpdate) {
      unsubUpdate = lite.agents.onUpdate((ev) => {
        if (!ev) return;
        if (ev.kind === 'upsert' && Array.isArray(ev.items)) {
          for (const it of ev.items) sessionsMap.set(it.sid, it);
          if (tab === 'live') render();
        } else if (ev.kind === 'tails' && Array.isArray(ev.patches)) {
          for (const p of ev.patches) {
            const cur = sessionsMap.get(p.sid);
            if (cur) { cur.tailLines = p.tailLines; cur.updatedAt = p.updatedAt; }
          }
          if (tab === 'live') renderGridOnly();
        } else if (ev.kind === 'remove' && ev.sid) {
          sessionsMap.delete(ev.sid);
          if (tab === 'live') render();
        } else if (ev.kind === 'stats' && ev.stats) {
          statsSummary = ev.stats;
          if (tab === 'stats') render();
        }
      });
    }
    const r = await lite.agents.subscribe();
    if (r && r.ok) {
      sessionsMap.clear();
      for (const it of (r.items || [])) sessionsMap.set(it.sid, it);
      statsSummary = r.stats || null;
      render();
    }
  }

  function stopSubscribed() {
    if (!subscribed) return;
    subscribed = false;
    try { lite.agents.unsubscribe(); } catch (_) {}
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopSubscribed();
    else if (!pane.classList.contains('hidden')) ensureSubscribed().catch(() => {});
  });
  window.addEventListener('beforeunload', () => stopSubscribed());

  return {
    async setOpen(open) {
      pane.classList.toggle('hidden', !open);
      if (open) await ensureSubscribed();
      else stopSubscribed();
    },
    async refresh() {
      const r = await lite.agents.snapshot();
      if (r && r.ok) {
        sessionsMap.clear();
        for (const it of (r.items || [])) sessionsMap.set(it.sid, it);
        statsSummary = r.stats || null;
        render();
      }
    },
  };
}
