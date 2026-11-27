// Правая колонка #mcp-pane и модалки MCP Store / Ресурсы проекта / Подключение агентов.
import { el, icon, iconBtn, makeModal } from '../ui.js';

const PRESET_SHORT = {
  strict: 'Strict',
  dev_safe: 'Dev non-prod RO',
  custom: 'Свой',
};

const ASK_REASON_LABEL = {
  unbound_resource: 'Ресурс не привязан',
  prod_resource: 'PROD-ресурс',
  write_tool: 'Изменение данных',
};

function fmtTime(ts) {
  try {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return '';
  }
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Инициализировать встроенную правую колонку MCP и модалки MCP Store.
 * @param {Record<string, any>} host
 */
export function initMcp(host) {
  const { lite, withHk, getActiveId, getActiveProject, getActiveSessionId, getLayout, setLayoutProp, onLayoutChange, openSettings, toast } = host;

  /** @type {'session' | 'project' | 'all'} */
  let filterMode = 'project';
  /** @type {any[]} */
  let entries = [];
  /** @type {any[]} */
  let pending = [];
  /** @type {any} */
  let status = { config: { enabled: true }, binding: { preset: 'strict' }, stats: { listening: false, pendingCount: 0 } };
  const expandedIds = new Set();
  const seenApprovals = new Map();
  let cooldownTimer = null;

  const pane = () => document.getElementById('mcp-pane');
  const gutter = () => document.getElementById('gutter-mcp');
  const hdrBtn = () => document.getElementById('btn-mcp');
  const badge = () => document.getElementById('mcp-btn-badge');

  function isOpen() {
    return !!getLayout().mcpOpen;
  }

  function syncOpenDom() {
    const open = isOpen();
    const p = pane(), g = gutter(), b = hdrBtn();
    if (p) p.classList.toggle('hidden', !open);
    if (g) g.classList.toggle('hidden', !open);
    if (b) b.classList.toggle('on', open);
    updateBadge();
  }

  function updateBadge() {
    const b = badge();
    if (!b) return;
    const count = pending.length;
    b.textContent = count > 0 ? String(Math.min(count, 99)) : '';
    b.classList.toggle('show', count > 0);
  }

  function setOpen(open) {
    const want = !!open;
    if (want === isOpen()) return;
    setLayoutProp('mcpOpen', want);
    syncOpenDom();
    onLayoutChange();
    if (want) refresh().catch(() => {});
  }

  function toggle() {
    setOpen(!isOpen());
  }

  async function refresh() {
    if (!lite.mcp) return;
    const pid = getActiveId() || '__global__';
    try {
      const [st, au] = await Promise.all([
        lite.mcp.status(pid),
        lite.mcp.audit({ limit: 250 }),
      ]);
      if (st && st.ok) status = st;
      if (au && au.ok) {
        entries = Array.isArray(au.entries) ? au.entries : [];
        pending = Array.isArray(au.pending) ? au.pending : [];
      }
    } catch (_) {}
    syncSeenApprovals();
    renderPane();
  }

  function syncSeenApprovals() {
    const alive = new Set(pending.map((a) => a.id));
    for (const id of [...seenApprovals.keys()]) {
      if (!alive.has(id)) seenApprovals.delete(id);
    }
    const now = Date.now();
    for (const a of pending) {
      if (!seenApprovals.has(a.id)) seenApprovals.set(a.id, now);
    }
    if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
    let minRem = Infinity;
    for (const a of pending) {
      const delay = Number(a.delayMs) || 0;
      if (!delay) continue;
      const elapsed = now - (seenApprovals.get(a.id) || now);
      if (elapsed < delay) minRem = Math.min(minRem, delay - elapsed + 20);
    }
    if (Number.isFinite(minRem)) {
      cooldownTimer = setTimeout(() => { cooldownTimer = null; renderApprovals(); }, minRem);
    }
  }

  function visibleEntries() {
    const pid = getActiveId() || '__global__';
    const sid = typeof getActiveSessionId === 'function' ? getActiveSessionId() : '';
    if (filterMode === 'session' && sid) return entries.filter((e) => e.ptyId === sid);
    if (filterMode === 'project') return entries.filter((e) => e.projectId === pid);
    return entries;
  }

  function upsertEntry(rec) {
    if (!rec || !rec.id) return;
    const idx = entries.findIndex((e) => e.id === rec.id);
    if (idx >= 0) entries[idx] = rec;
    else entries.unshift(rec);
    if (entries.length > 400) entries.length = 400;
  }

  function renderApprovals() {
    const root = pane();
    if (!root) return;
    const box = root.querySelector('.mcp-approvals');
    if (!box) return;
    box.replaceChildren();
    const pid = getActiveId() || '__global__';
    const curList = filterMode === 'all' ? pending : pending.filter((a) => a.projectId === pid);
    const otherList = pending.filter((a) => a.projectId !== pid);

    const banner = root.querySelector('.mcp-other-banner');
    if (banner) {
      if (filterMode !== 'all' && otherList.length) {
        banner.classList.remove('hidden');
        banner.textContent = '';
        banner.append(icon('shield', 14), el('span', null, `В других проектах ждут подтверждения: ${otherList.length} (нажмите, чтобы показать)`));
      } else {
        banner.classList.add('hidden');
      }
    }

    const now = Date.now();
    for (const ap of curList) {
      const isProd = ap.askReason === 'prod_resource' || /prod/i.test(ap.resourceName || '');
      const card = el('div', 'mcp-ap-card' + (isProd ? ' prod' : ''));

      const top = el('div', 'mcp-ap-top');
      const toolEl = el('span', 'mcp-ap-tool', ap.tool);
      toolEl.setAttribute('data-no-i18n', '');
      const reasonEl = el('span', 'mcp-ap-reason', ASK_REASON_LABEL[ap.askReason] || 'Подтверждение');
      top.append(toolEl, reasonEl);
      card.appendChild(top);

      const meta = el('div', 'mcp-ap-meta');
      const ag = el('span', 'mcp-pill', ap.agentKind || 'agent'); ag.setAttribute('data-no-i18n', '');
      meta.appendChild(ag);
      if (ap.resourceName) {
        const rs = el('span', 'mcp-pill' + (isProd ? ' prod' : ''), ap.resourceName); rs.setAttribute('data-no-i18n', '');
        meta.appendChild(rs);
      }
      if (ap.projectName) {
        const pn = el('span', null, ap.projectName); pn.setAttribute('data-no-i18n', '');
        meta.appendChild(pn);
      }
      card.appendChild(meta);

      const preview = ap.sql || JSON.stringify(ap.argsPreview || {}, null, 2);
      if (preview && preview !== '{}') {
        const pre = el('pre', 'mcp-ap-code', preview);
        pre.setAttribute('data-no-i18n', '');
        card.appendChild(pre);
      }

      const acts = el('div', 'mcp-ap-actions');
      const delay = Number(ap.delayMs) || 0;
      const locked = delay > 0 && (now - (seenApprovals.get(ap.id) || now)) < delay;

      const mkBtn = (label, decision, cls) => {
        const b = el('button', 'btn ' + (cls || ''), label);
        if (locked && decision !== 'deny') b.disabled = true;
        b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await lite.mcp.approve(ap.id, decision);
            if (!r || !r.ok) toast((r && r.error) || 'Не удалось обработать запрос', { kind: 'err' });
            await refresh();
          } catch (e) { toast(String(e && e.message), { kind: 'err' }); }
        };
        return b;
      };

      if (ap.askReason === 'unbound_resource') {
        acts.appendChild(mkBtn('Разрешить и привязать', 'bind', 'primary'));
      } else {
        acts.appendChild(mkBtn('Разрешить в сессии', 'session', 'primary'));
      }
      acts.appendChild(mkBtn('Только раз', 'once', ''));
      acts.appendChild(mkBtn('Отклонить', 'deny', ''));
      card.appendChild(acts);
      box.appendChild(card);
    }
  }

  function renderFeed() {
    const root = pane();
    if (!root) return;
    const feed = root.querySelector('.mcp-feed');
    if (!feed) return;
    feed.replaceChildren();
    const rows = visibleEntries();
    if (!rows.length) {
      const empty = el('div', 'mcp-empty');
      empty.appendChild(el('div', null, 'Здесь появятся вызовы MCP-инструментов активных агентов и запросы на доступ к БД, серверам и контейнерам.'));
      const act = el('div', 'mcp-empty-actions');
      const bRes = el('button', 'btn primary', 'Ресурсы проекта');
      bRes.onclick = () => openProjectResourcesModal();
      const bConn = el('button', 'btn', 'Подключить агента');
      bConn.onclick = () => openConnectModal();
      act.append(bRes, bConn);
      empty.appendChild(act);
      feed.appendChild(empty);
      return;
    }

    for (const item of rows) {
      const card = el('div', 'mcp-item status-' + item.status);
      const top = el('div', 'mcp-item-row');
      top.appendChild(el('span', 'mcp-st ' + item.status));
      const toolEl = el('span', 'mcp-item-tool', item.tool);
      toolEl.setAttribute('data-no-i18n', '');
      top.appendChild(toolEl);

      const packEl = el('span', 'mcp-pill', item.pack); packEl.setAttribute('data-no-i18n', '');
      top.appendChild(packEl);

      const agEl = el('span', 'mcp-pill', item.agentKind || 'agent'); agEl.setAttribute('data-no-i18n', '');
      top.appendChild(agEl);
      card.appendChild(top);

      const sub = el('div', 'mcp-item-sub');
      if (item.resourceName) {
        const rn = el('span', 'mcp-item-res', item.resourceName); rn.setAttribute('data-no-i18n', '');
        sub.appendChild(rn);
      }
      const statText = [
        item.durationMs ? `${item.durationMs} ms` : '',
        item.bytesOut ? fmtBytes(item.bytesOut) : '',
        fmtTime(item.ts),
      ].filter(Boolean).join(' · ');
      const stSpan = el('span', null, statText); stSpan.setAttribute('data-no-i18n', '');
      stSpan.style.marginLeft = 'auto';
      sub.appendChild(stSpan);
      card.appendChild(sub);

      if (item.error && !expandedIds.has(item.id)) {
        const er = el('div', null, item.error);
        er.style.fontSize = '11px';
        er.style.color = 'var(--err)';
        er.setAttribute('data-no-i18n', '');
        card.appendChild(er);
      }

      top.onclick = () => {
        if (expandedIds.has(item.id)) expandedIds.delete(item.id);
        else expandedIds.add(item.id);
        renderFeed();
      };

      if (expandedIds.has(item.id)) {
        const det = el('div', 'mcp-item-detail');
        const argStr = item.sql || JSON.stringify(item.previewArgs || {}, null, 2);
        const preIn = el('pre', null, argStr); preIn.setAttribute('data-no-i18n', '');
        det.appendChild(preIn);

        if (item.error || item.previewOut) {
          const preOut = el('pre', null, item.error || item.previewOut);
          preOut.setAttribute('data-no-i18n', '');
          if (item.error) preOut.style.color = 'var(--err)';
          det.appendChild(preOut);
        }

        const acts = el('div', 'mcp-detail-acts');
        const bCopy = el('button', 'btn', 'Копировать');
        bCopy.onclick = () => {
          lite.copyText(item.error || item.previewOut || argStr);
          toast('Скопировано');
        };
        acts.appendChild(bCopy);

        if (item.sql && item.resourceId && lite.db && typeof lite.db.openSql === 'function') {
          const bSql = el('button', 'btn primary', 'Открыть SQL в БД');
          bSql.onclick = () => lite.db.openSql(item.resourceId, item.sql);
          acts.appendChild(bSql);
        }
        det.appendChild(acts);
        card.appendChild(det);
      }

      feed.appendChild(card);
    }
  }

  function renderPane() {
    syncOpenDom();
    const root = pane();
    if (!root) return;
    if (!root.firstChild) {
      const head = el('div', 'mcp-head');
      const tw = el('div', 'mcp-title-wrap');
      const dot = el('span', 'mcp-dot');
      const title = el('span', 'mcp-title', 'MCP'); title.setAttribute('data-no-i18n', '');
      const chip = el('span', 'mcp-proj-chip'); chip.setAttribute('data-no-i18n', '');
      tw.append(dot, title, chip);

      const sp = el('span', 'grow');
      const bStore = iconBtn('icon-btn', 'grid', 'Каталог паков MCP Store', 15);
      bStore.onclick = () => openStoreModal();
      const bConn = iconBtn('icon-btn', 'terminal', 'Подключить CLI-агента', 15);
      bConn.onclick = () => openConnectModal();
      const bSet = iconBtn('icon-btn', 'gear', 'Настройки MCP', 15);
      bSet.onclick = () => openSettings();
      const bClr = iconBtn('icon-btn', 'eraser', 'Очистить журнал', 15);
      bClr.onclick = async () => { await lite.mcp.auditClear(); entries = []; renderFeed(); };
      const bClose = iconBtn('icon-btn', 'x', withHk ? withHk('Скрыть панель', 'toggleMcp') : 'Скрыть панель', 15);
      bClose.id = 'mcp-close-btn';
      bClose.onclick = () => setOpen(false);
      head.append(tw, sp, bStore, bConn, bSet, bClr, bClose);

      const bar = el('div', 'mcp-bar');
      const tabs = el('div', 'mcp-tabs');
      for (const [id, lbl] of [['session', 'Сессия'], ['project', 'Проект'], ['all', 'Все']]) {
        const tb = el('button', 'mcp-tab', lbl);
        tb.dataset.mode = id;
        tb.onclick = () => { filterMode = /** @type {any} */ (id); renderPane(); };
        tabs.appendChild(tb);
      }
      const pBtn = el('button', 'mcp-preset-btn');
      pBtn.title = 'Настроить пресет и ресурсы проекта';
      pBtn.onclick = () => openProjectResourcesModal();
      bar.append(tabs, pBtn);

      const banner = el('div', 'mcp-other-banner hidden');
      banner.onclick = () => { filterMode = 'all'; renderPane(); };

      const approvals = el('div', 'mcp-approvals');
      const feed = el('div', 'mcp-feed');
      root.append(head, bar, banner, approvals, feed);
    }

    const dot = root.querySelector('.mcp-dot');
    const listening = !!(status && status.stats && status.stats.listening && status.config && status.config.enabled !== false);
    if (dot) dot.classList.toggle('on', listening);

    const proj = getActiveProject ? getActiveProject() : null;
    const chip = root.querySelector('.mcp-proj-chip');
    if (chip) chip.textContent = (proj && proj.name) || 'Общее';

    root.querySelectorAll('.mcp-tab').forEach((b) => {
      if (b instanceof HTMLElement) b.classList.toggle('on', b.dataset.mode === filterMode);
    });

    const pBtn = root.querySelector('.mcp-preset-btn');
    const preset = (status && status.binding && status.binding.preset) || 'strict';
    if (pBtn) {
      pBtn.className = 'mcp-preset-btn ' + preset;
      pBtn.replaceChildren(icon('shield', 12), el('span', null, PRESET_SHORT[preset] || preset));
    }

    renderApprovals();
    renderFeed();
  }

  async function openProjectResourcesModal(projectObj) {
    const p = projectObj || (getActiveProject ? getActiveProject() : null) || { id: '__global__', name: 'Общее' };
    const pid = p.id || '__global__';
    const { m, close } = makeModal(`
      <div class="shead" style="padding:0 0 8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
        <h3 style="margin:0;font-size:15px;"><span>Ресурсы MCP</span><span data-no-i18n> · </span><span id="mcp-rm-pname" data-no-i18n></span></h3>
        <span class="grow"></span>
        <button class="icon-btn" id="mcp-rm-x" title="Закрыть"></button>
      </div>
      <div class="mcp-modal-body" id="mcp-rm-body">Загрузка…</div>
      <div class="modal-actions"><span class="grow"></span><button class="btn primary" id="mcp-rm-ok">Готово</button></div>
    `);
    m.classList.add('mcp-modal');
    m.querySelector('#mcp-rm-pname').textContent = p.name || pid;
    m.querySelector('#mcp-rm-x').appendChild(icon('x', 16));
    m.querySelector('#mcp-rm-x').onclick = close;
    m.querySelector('#mcp-rm-ok').onclick = close;

    const body = m.querySelector('#mcp-rm-body');
    const [bRes, rRes] = await Promise.all([lite.mcp.getBinding(pid), lite.mcp.resources()]);
    let binding = (bRes && bRes.binding) || { preset: 'strict', dbIds: [], serverIds: [], rhIds: [], containerTargets: [], denyDbIds: [], denyContainerTargets: [] };
    const resources = (rRes && rRes.resources) || { db: [], server: [], rh: [], container: [] };

    const saveBinding = async (next) => {
      const res = await lite.mcp.setBinding(pid, next);
      if (res && res.binding) binding = res.binding;
      draw();
      refresh().catch(() => {});
    };

    const draw = () => {
      body.replaceChildren();
      const presets = el('div', 'mcp-preset-grid');
      const defs = [
        ['dev_safe', 'Разрешить все non-prod БД и локальные контейнеры (read-only)', 'Все не-prod БД и локальный Docker/Podman доступны агентам сразу только на чтение. Prod-БД и SSH-серверы остаются под Zero-Trust.'],
        ['strict', 'Строгий Zero-Trust (только явно отмеченные)', 'Агенты видят только явно выбранные ниже ресурсы; остальные требуют подтверждения.'],
        ['custom', 'Своя конфигурация', 'Точная ручная комбинация правил и исключений для этого проекта.'],
      ];
      for (const [id, title, desc] of defs) {
        const opt = el('button', 'mcp-preset-opt' + (binding.preset === id ? ' on' : ''));
        opt.append(el('b', null, title), el('span', null, desc));
        opt.onclick = async () => {
          const res = await lite.mcp.applyPreset(pid, /** @type {any} */ (id));
          if (res && res.binding) binding = res.binding;
          draw();
          refresh().catch(() => {});
        };
        presets.appendChild(opt);
      }
      body.appendChild(presets);

      const KIND_FIELD = {
        server: 'serverIds',
        rh: 'rhIds',
        rmq: 'rmqIds',
        kafka: 'kafkaIds',
        storage: 'storageIds',
        jira: 'jiraIds',
        project: 'projectIds',
      };

      const renderSection = (title, items, kind, emptyMsg = 'Нет настроенных подключений') => {
        const sec = el('div', 'mcp-res-sec');
        sec.appendChild(el('div', 'mcp-res-title', title));
        if (!items.length) {
          sec.appendChild(el('div', null, emptyMsg));
          body.appendChild(sec);
          return;
        }
        for (const it of items) {
          const row = el('label', 'mcp-res-row');
          const cb = /** @type {HTMLInputElement} */ (document.createElement('input'));
          cb.type = 'checkbox';

          let autoByPreset = false;
          if (kind === 'db' && binding.allowAllNonProdDbs && !it.isProd && !(binding.denyDbIds || []).includes(it.id)) autoByPreset = true;
          if (kind === 'container' && binding.allowAllLocalContainers && it.isLocal && !(binding.denyContainerTargets || []).includes(it.id)) autoByPreset = true;

          const explicit = kind === 'db' ? (binding.dbIds || []).includes(it.id)
            : kind === 'container' ? (binding.containerTargets || []).includes(it.id)
              : (binding[KIND_FIELD[kind]] || []).includes(it.id);

          cb.checked = explicit || autoByPreset;
          cb.onchange = () => {
            const next = { ...binding };
            if (kind === 'db') {
              next.dbIds = [...(next.dbIds || [])];
              next.denyDbIds = [...(next.denyDbIds || [])];
              if (cb.checked) {
                next.denyDbIds = next.denyDbIds.filter((x) => x !== it.id);
                if (!next.dbIds.includes(it.id)) next.dbIds.push(it.id);
              } else {
                next.dbIds = next.dbIds.filter((x) => x !== it.id);
                if (next.allowAllNonProdDbs && !it.isProd && !next.denyDbIds.includes(it.id)) next.denyDbIds.push(it.id);
              }
            } else if (kind === 'container') {
              next.containerTargets = [...(next.containerTargets || [])];
              next.denyContainerTargets = [...(next.denyContainerTargets || [])];
              if (cb.checked) {
                next.denyContainerTargets = next.denyContainerTargets.filter((x) => x !== it.id);
                if (!next.containerTargets.includes(it.id)) next.containerTargets.push(it.id);
              } else {
                next.containerTargets = next.containerTargets.filter((x) => x !== it.id);
                if (next.allowAllLocalContainers && it.isLocal && !next.denyContainerTargets.includes(it.id)) next.denyContainerTargets.push(it.id);
              }
            } else if (KIND_FIELD[kind]) {
              const fk = KIND_FIELD[kind];
              const arr = new Set(next[fk] || []);
              if (cb.checked) arr.add(it.id); else arr.delete(it.id);
              next[fk] = [...arr];
            }
            saveBinding(next);
          };

          const nm = el('span', null, it.name || it.id); nm.setAttribute('data-no-i18n', '');
          row.append(cb, nm);
          if (it.isProd) {
            const pr = el('span', 'mcp-pill prod', 'PROD'); pr.setAttribute('data-no-i18n', '');
            row.appendChild(pr);
          } else if (autoByPreset && !explicit) {
            const ap = el('span', 'mcp-pill safe', 'Пресет RO');
            row.appendChild(ap);
          }
          if (it.noCloud) {
            const nc = el('span', 'mcp-pill', 'noCloud'); nc.setAttribute('data-no-i18n', '');
            row.appendChild(nc);
          }
          if (it.subtitle) {
            const sb = el('span', 'mcp-res-sub', it.subtitle); sb.setAttribute('data-no-i18n', '');
            row.appendChild(sb);
          }
          sec.appendChild(row);
        }
        body.appendChild(sec);
      };

      renderSection('Базы данных', resources.db || [], 'db');
      renderSection('Контейнеры (Docker / Podman)', resources.container || [], 'container');
      renderSection('Серверы', resources.server || [], 'server');
      renderSection('SSH-профили (Удалённые хосты)', resources.rh || [], 'rh');
      renderSection('RabbitMQ', resources.rmq || [], 'rmq');
      renderSection('Kafka', resources.kafka || [], 'kafka');
      renderSection('Хранилища (S3 / MinIO)', resources.storage || [], 'storage');
      renderSection('Jira', resources.jira || [], 'jira', 'Нет настроенных аккаунтов');
      const otherProjects = (resources.project || []).filter((p) => p.id !== pid);
      renderSection('Другие проекты (read-only)', otherProjects, 'project', 'Нет других проектов');
    };

    draw();
  }

  async function openStoreModal() {
    const { m, close } = makeModal(`
      <div class="shead" style="padding:0 0 8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
        <h3 style="margin:0;font-size:15px;">MCP Store — каталог модульных паков</h3>
        <span class="grow"></span>
        <button class="icon-btn" id="mcp-st-x" title="Закрыть"></button>
      </div>
      <div class="mcp-modal-body" id="mcp-st-body">Загрузка…</div>
      <div class="modal-actions"><span class="grow"></span><button class="btn primary" id="mcp-st-ok">Готово</button></div>
    `);
    m.classList.add('mcp-modal');
    m.querySelector('#mcp-st-x').appendChild(icon('x', 16));
    m.querySelector('#mcp-st-x').onclick = close;
    m.querySelector('#mcp-st-ok').onclick = close;

    const body = m.querySelector('#mcp-st-body');
    const [pkRes, stRes] = await Promise.all([lite.mcp.packs(), lite.mcp.status()]);
    let config = (stRes && stRes.config) || { enabled: true, packs: {} };
    let packs = (pkRes && pkRes.packs) || [];

    const saveCfg = async (nextCfg) => {
      const r = await lite.mcp.setConfig(nextCfg);
      if (r && r.config) config = r.config;
      const pk = await lite.mcp.packs();
      if (pk && pk.packs) packs = pk.packs;
      draw();
      refresh().catch(() => {});
    };

    const draw = () => {
      body.replaceChildren();
      for (const p of packs) {
        const card = el('div', 'mcp-pack-card');
        const head = el('div', 'mcp-pack-head');
        const info = el('div', 'grow');
        const ttl = el('b', null, p.name);
        const ver = el('span', 'mcp-pill', `v${p.version} · ${p.tools.length}`); ver.setAttribute('data-no-i18n', '');
        const desc = el('div', null, p.description);
        desc.style.fontSize = '12px'; desc.style.color = 'var(--text-dim)'; desc.style.marginTop = '2px';
        info.append(ttl, ' ', ver, desc);

        const sw = el('button', 'sw-t' + (p.enabled ? ' on' : ''));
        sw.onclick = () => {
          const next = { ...config, packs: { ...(config.packs || {}) } };
          const prev = next.packs[p.id] || { enabled: true, disabledTools: [] };
          next.packs[p.id] = { ...prev, enabled: !p.enabled };
          saveCfg(next);
        };
        head.append(info, sw);
        card.appendChild(head);

        const toolsBox = el('div', 'mcp-pack-tools');
        for (const t of p.tools) {
          const row = el('div', 'mcp-tool-row');
          const cb = /** @type {HTMLInputElement} */ (document.createElement('input'));
          cb.type = 'checkbox';
          cb.checked = !!t.enabled;
          cb.disabled = !p.enabled;
          cb.onchange = () => {
            const next = { ...config, packs: { ...(config.packs || {}) } };
            const prev = next.packs[p.id] || { enabled: p.enabled, disabledTools: [] };
            const set = new Set(prev.disabledTools || []);
            if (cb.checked) set.delete(t.name); else set.add(t.name);
            next.packs[p.id] = { ...prev, disabledTools: [...set] };
            saveCfg(next);
          };
          const code = el('code', null, t.name); code.setAttribute('data-no-i18n', '');
          const pill = el('span', 'mcp-pill safe', t.mode === 'read' ? 'RO' : t.mode); pill.setAttribute('data-no-i18n', '');
          const td = el('span', null, t.title || t.description);
          row.append(cb, code, pill, td);
          toolsBox.appendChild(row);
        }
        card.appendChild(toolsBox);
        body.appendChild(card);
      }
    };

    draw();
  }

  async function openConnectModal() {
    const p = (getActiveProject ? getActiveProject() : null) || { id: '__global__', name: 'Общее', path: '' };
    const { m, close } = makeModal(`
      <div class="shead" style="padding:0 0 8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
        <h3 style="margin:0;font-size:15px;">Подключить CLI-агента к MCP Hub</h3>
        <span class="grow"></span>
        <button class="icon-btn" id="mcp-cn-x" title="Закрыть"></button>
      </div>
      <div class="mcp-modal-body" id="mcp-cn-body">Загрузка…</div>
      <div class="modal-actions">
        <button class="btn" id="mcp-cn-revoke">Отозвать ручные токены</button>
        <span class="grow"></span>
        <button class="btn primary" id="mcp-cn-ok">Готово</button>
      </div>
    `);
    m.classList.add('mcp-modal');
    m.querySelector('#mcp-cn-x').appendChild(icon('x', 16));
    m.querySelector('#mcp-cn-x').onclick = close;
    m.querySelector('#mcp-cn-ok').onclick = close;
    m.querySelector('#mcp-cn-revoke').onclick = async () => {
      await lite.mcp.revokeTokens(p.id);
      toast('Ручные токены проекта отозваны');
      load('claude');
    };

    const body = m.querySelector('#mcp-cn-body');
    let curAgent = 'claude';

    const load = async (agentKind) => {
      curAgent = agentKind;
      const res = await lite.mcp.agentSnippets({ agentKind, projectId: p.id, projectName: p.name });
      body.replaceChildren();

      const note = el('div', null, 'В терминалах самого LiteEditor переменные окружения MCP передаются автоматически каждой вкладке. Кнопка ниже нужна, чтобы зарегистрировать LiteEditor MCP глобально или для CLI-запусков.');
      note.style.fontSize = '12px'; note.style.color = 'var(--text-dim)';
      body.appendChild(note);

      const tabs = el('div', 'mcp-tabs');
      tabs.style.alignSelf = 'flex-start';
      const labels = { claude: 'Claude Code', agy: 'Antigravity (agy)', codex: 'Codex', gemini: 'Gemini CLI' };
      for (const ag of (res.agents || [])) {
        const tb = el('button', 'mcp-tab' + (ag.kind === curAgent ? ' on' : ''), labels[ag.kind] || ag.kind);
        tb.setAttribute('data-no-i18n', '');
        tb.onclick = () => load(ag.kind);
        tabs.appendChild(tb);
      }
      body.appendChild(tabs);

      const cmdBox = el('pre', 'mcp-code-box', (res.snippet && res.snippet.command) || '');
      cmdBox.setAttribute('data-no-i18n', '');
      body.appendChild(cmdBox);

      const acts = el('div', 'mcp-detail-acts');
      const bAuto = el('button', 'btn primary', 'Подключить автоматически');
      bAuto.onclick = async () => {
        bAuto.disabled = true;
        const r = await lite.mcp.connectAgent({ agentKind: curAgent, projectId: p.id, projectName: p.name, projectPath: p.path });
        bAuto.disabled = false;
        if (r && r.ok) toast(`Агент ${curAgent} подключён к MCP Hub`);
        else toast((r && r.error) || 'Не удалось подключить', { kind: 'err', ttl: 7000 });
      };
      const bCopy = el('button', 'btn', 'Копировать команду');
      bCopy.onclick = () => { lite.copyText((res.snippet && res.snippet.command) || ''); toast('Команда скопирована'); };
      acts.append(bAuto, bCopy);
      body.appendChild(acts);
    };

    load('claude');
  }

  function init() {
    syncOpenDom();
    const b = hdrBtn();
    if (b) b.addEventListener('click', () => toggle());
    if (lite.mcp && typeof lite.mcp.onEvent === 'function') {
      lite.mcp.onEvent((ev) => {
        if (!ev) return;
        if (ev.kind === 'audit' && ev.entry) {
          upsertEntry(ev.entry);
          if (ev.stats) status = { ...status, stats: ev.stats };
          renderFeed();
          updateBadge();
        } else if (ev.kind === 'approval' && ev.approval) {
          pending = [...pending.filter((x) => x.id !== ev.approval.id), ev.approval];
          syncSeenApprovals();
          updateBadge();
          if (ev.autoOpen && !isOpen()) setOpen(true);
          renderApprovals();
        } else if (ev.kind === 'approval_resolved') {
          pending = pending.filter((x) => x.id !== ev.id);
          syncSeenApprovals();
          updateBadge();
          renderApprovals();
        } else if (ev.kind === 'audit_cleared') {
          entries = [];
          renderFeed();
        } else if (ev.kind === 'binding' || ev.kind === 'config' || ev.kind === 'tools_changed') {
          refresh().catch(() => {});
        }
      });
    }
    if (isOpen()) refresh().catch(() => {});
  }

  return {
    init,
    toggle,
    setOpen,
    isOpen,
    refresh,
    onProjectChange: () => { if (isOpen()) refresh().catch(() => {}); },
    onSessionChange: () => { if (isOpen() && filterMode === 'session') renderFeed(); },
    openProjectResourcesModal,
    openStoreModal,
    openConnectModal,
  };
}
