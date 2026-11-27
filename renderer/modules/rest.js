// Модуль «HTTP-клиент» (REST / GraphQL · коллекции · окружения с safeStorage · cURL / .http / OpenAPI).
import { pickKeepassCred } from '../kpicker.js';
import { t } from '../i18n.js';

const lite = window.lite;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function uid(prefix = 'r') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function emptyRequest(partial = {}) {
  return {
    id: partial.id || uid('ri'),
    name: partial.name || 'Новый запрос',
    method: (partial.method || 'GET').toUpperCase(),
    url: partial.url || '',
    params: Array.isArray(partial.params) ? partial.params : [{ key: '', value: '', enabled: true }],
    headers: Array.isArray(partial.headers) && partial.headers.length ? partial.headers : [{ key: '', value: '', enabled: true }],
    auth: partial.auth || { type: 'none' },
    bodyMode: partial.bodyMode || 'none',
    body: partial.body || '',
    graphqlQuery: partial.graphqlQuery || '{\n  \n}',
    graphqlVars: partial.graphqlVars || '{}',
    followRedirects: partial.followRedirects !== false,
    rejectUnauthorized: partial.rejectUnauthorized !== false,
    timeoutMs: partial.timeoutMs || 30000,
  };
}

export function initRest(host) {
  const { el, icon, toast, makeModal, showConfirm, showPrompt, activeProject, sendToTerminal, sendNoteToTerminal } = host;
  const pane = document.getElementById('rest-pane');
  const root = document.getElementById('rest-body');
  const titleEl = document.getElementById('rest-title');
  if (!pane || !root) return {};

  let data = { collections: [], environments: [], history: [] };
  const ui = host.STORE.restUi && typeof host.STORE.restUi === 'object' ? { ...host.STORE.restUi } : {};
  let activeEnvId = ui.activeEnvId || '';
  let activeColId = ui.activeColId || '';
  let activeItemId = ui.activeItemId || '';
  let sideTab = ui.sideTab || 'collections'; // collections | history | local
  let reqTab = 'params'; // params | headers | auth | body | opts
  let resTab = 'body';   // body | headers | timing
  let curReq = emptyRequest();
  let curRes = null;
  let sendingReqId = '';
  let discovered = [];
  let loaded = false;

  const persistUi = () => {
    host.persist('restUi', { activeEnvId, activeColId, activeItemId, sideTab });
  };

  function projId() {
    const p = typeof activeProject === 'function' ? activeProject() : null;
    return (p && p.id) || '__global__';
  }

  function updateHeader() {
    const p = typeof activeProject === 'function' ? activeProject() : null;
    if (titleEl) {
      titleEl.textContent = p ? `${t('HTTP-клиент')} · ${p.name}` : t('HTTP-клиент');
    }
  }

  async function ensureLoad() {
    if (!loaded) {
      const r = await lite.rest.load();
      if (r && r.ok && r.data) {
        data = r.data;
        loaded = true;
        if (activeColId && activeItemId) {
          const c = data.collections.find((x) => x.id === activeColId);
          const it = c && Array.isArray(c.items) ? c.items.find((x) => x.id === activeItemId) : null;
          if (it) curReq = emptyRequest(it);
        }
      }
    }
  }

  function visibleCollections() {
    const pid = projId();
    return (data.collections || []).filter((c) => !c.projectId || c.projectId === '__global__' || c.projectId === pid);
  }

  function visibleEnvs() {
    const pid = projId();
    return (data.environments || []).filter((e) => !e.projectId || e.projectId === '__global__' || e.projectId === pid);
  }

  function formatBytes(b) {
    const n = Number(b) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function prettyResponse(res) {
    if (!res) return '';
    if (res.isBinary) return t('Бинарный ответ') + ` (${formatBytes(res.bytes)})`;
    const ct = String((res.headers && res.headers['content-type']) || '').toLowerCase();
    const txt = String(res.bodyText || '');
    if (ct.includes('json') || /^\s*[[{]/.test(txt)) {
      try { return JSON.stringify(JSON.parse(txt), null, 2); } catch (_) {}
    }
    return txt;
  }

  function kvEditor(rows, keyPh, valPh, onUpdate) {
    const box = el('div', 'rest-kv');
    rows.forEach((row, idx) => {
      const r = el('div', 'rest-kv-row');
      const cb = /** @type {HTMLInputElement} */ (document.createElement('input'));
      cb.type = 'checkbox';
      cb.checked = row.enabled !== false;
      cb.onchange = () => { row.enabled = cb.checked; onUpdate(); };

      const k = /** @type {HTMLInputElement} */ (document.createElement('input'));
      k.type = 'text'; k.placeholder = keyPh; k.value = row.key || '';
      k.setAttribute('data-no-i18n', '');
      k.oninput = () => { row.key = k.value; onUpdate(); };

      const v = /** @type {HTMLInputElement} */ (document.createElement('input'));
      v.type = 'text'; v.placeholder = valPh; v.value = row.value || '';
      v.setAttribute('data-no-i18n', '');
      v.oninput = () => { row.value = v.value; onUpdate(); };

      const del = el('button', 'icon-btn rest-kv-del');
      del.type = 'button';
      del.appendChild(icon('x', 13));
      del.onclick = () => {
        rows.splice(idx, 1);
        if (!rows.length) rows.push({ key: '', value: '', enabled: true });
        onUpdate();
        render();
      };
      r.append(cb, k, v, del);
      box.appendChild(r);
    });
    const addBtn = el('button', 'btn rest-mini-btn', '+ Добавить строку');
    addBtn.type = 'button';
    addBtn.onclick = () => { rows.push({ key: '', value: '', enabled: true }); render(); };
    box.appendChild(addBtn);
    return box;
  }

  async function saveCurrentToCollection(targetColId) {
    let col = data.collections.find((c) => c.id === (targetColId || activeColId));
    if (!col) {
      const name = await showPrompt('Название новой коллекции', 'API проекта');
      if (!name) return;
      col = { id: uid('rc'), name: name.trim(), projectId: projId(), items: [] };
    }
    const nextCol = { ...col, items: [...(col.items || [])] };
    const idx = nextCol.items.findIndex((x) => x.id === curReq.id);
    const copy = { ...curReq };
    if (idx >= 0) nextCol.items[idx] = copy; else nextCol.items.push(copy);
    const res = await lite.rest.saveCollection(nextCol);
    if (res && res.ok && res.data) {
      data = res.data;
      activeColId = res.id;
      activeItemId = copy.id;
      persistUi();
      toast('Запрос сохранён в коллекцию', { kind: 'ok' });
      render();
    }
  }

  async function sendCurrent() {
    if (!String(curReq.url || '').trim()) {
      toast('Введите URL запроса', { kind: 'warn' });
      return;
    }
    sendingReqId = uid('req');
    render();
    const r = await lite.rest.send({
      reqId: sendingReqId,
      request: curReq,
      envId: activeEnvId,
      colId: activeColId,
      itemId: activeItemId,
    });
    sendingReqId = '';
    if (r && r.ok) {
      curRes = r.response;
      if (Array.isArray(r.history)) data.history = r.history;
    } else {
      curRes = { status: 0, error: (r && r.error) || 'Ошибка запроса' };
    }
    render();
  }

  function sendResultToAgent() {
    const lines = [
      `HTTP ${curReq.method} ${curReq.url}`,
    ];
    if (curRes) {
      if (curRes.error) lines.push(`Ошибка: ${curRes.error}`);
      else {
        lines.push(`Статус: ${curRes.status} ${curRes.statusText || ''} (${curRes.timing ? curRes.timing.totalMs : 0} ms)`);
        const body = prettyResponse(curRes);
        if (body) lines.push('Ответ:\n```json\n' + body.slice(0, 3500) + (body.length > 3500 ? '\n...(обрезано)' : '') + '\n```');
      }
    }
    const payload = lines.join('\n') + '\n';
    const p = typeof activeProject === 'function' ? activeProject() : null;
    if (p && p.id && typeof sendNoteToTerminal === 'function') sendNoteToTerminal(p, payload);
    else if (typeof sendToTerminal === 'function') sendToTerminal(payload);
    toast('Отправлено в активный терминал агента', { kind: 'ok' });
  }

  async function discoverLocal() {
    sideTab = 'local';
    persistUi();
    const r = await lite.rest.discoverLocal(projId());
    discovered = (r && r.ok && Array.isArray(r.endpoints)) ? r.endpoints : [];
    render();
    if (!discovered.length) toast('Активные локальные порты для этого проекта не найдены', { kind: 'info' });
  }

  async function openImportModal() {
    const { m, close } = makeModal(`
      <div class="shead" style="padding:0 0 8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
        <h3 style="margin:0;font-size:15px;">Импорт cURL / .http / OpenAPI</h3>
        <span class="grow"></span>
        <button class="icon-btn" id="rest-imp-x" title="Закрыть"></button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin:8px 0;">
        <select id="rest-imp-fmt" class="rest-sel">
          <option value="auto">Автоопределение</option>
          <option value="curl">cURL</option>
          <option value="http">.http / .rest</option>
          <option value="openapi">OpenAPI 3 / Swagger 2 (JSON/YAML)</option>
        </select>
        <button id="rest-imp-file" class="btn">Загрузить из файла…</button>
      </div>
      <textarea id="rest-imp-txt" class="rest-imp-ta" spellcheck="false" data-no-i18n placeholder="Вставьте команду curl, текст .http файла или JSON/YAML OpenAPI…"></textarea>
      <div class="modal-actions">
        <span class="grow"></span>
        <button id="rest-imp-cancel" class="btn">Отмена</button>
        <button id="rest-imp-go" class="btn primary">Импортировать</button>
      </div>
    `);
    m.classList.add('rest-modal');
    m.querySelector('#rest-imp-x').appendChild(icon('x', 16));
    m.querySelector('#rest-imp-x').onclick = close;
    m.querySelector('#rest-imp-cancel').onclick = close;
    const ta = /** @type {HTMLTextAreaElement} */ (m.querySelector('#rest-imp-txt'));
    const fmt = /** @type {HTMLSelectElement} */ (m.querySelector('#rest-imp-fmt'));

    m.querySelector('#rest-imp-file').onclick = async () => {
      const f = await lite.rest.importFile();
      if (f && f.ok && f.content) ta.value = f.content;
      else if (f && f.error) toast(f.error, { kind: 'err' });
    };

    m.querySelector('#rest-imp-go').onclick = async () => {
      const r = await lite.rest.importText({ text: ta.value, format: fmt.value });
      if (!r || !r.ok) { toast((r && r.error) || 'Ошибка импорта', { kind: 'err' }); return; }
      const reqs = (r.requests || []).map((q) => emptyRequest(q));
      if (!reqs.length) { toast('Запросы не найдены', { kind: 'warn' }); return; }
      if (r.kind === 'collection' || reqs.length > 1) {
        const saved = await lite.rest.saveCollection({
          name: r.name || 'Импорт OpenAPI',
          projectId: projId(),
          items: reqs,
        });
        if (saved && saved.ok && saved.data) {
          data = saved.data;
          activeColId = saved.id;
          activeItemId = reqs[0].id;
          curReq = emptyRequest(reqs[0]);
        }
      } else {
        curReq = reqs[0];
        activeColId = '';
        activeItemId = '';
      }
      if (r.vars && Object.keys(r.vars).length) {
        const envVars = Object.entries(r.vars).map(([k, v]) => ({ key: k, value: String(v), secret: false }));
        const er = await lite.rest.saveEnv({ name: 'Импорт .http', projectId: projId(), vars: envVars });
        if (er && er.ok && er.data) { data = er.data; activeEnvId = er.id; }
      }
      persistUi();
      close();
      render();
      toast(`Импортировано запросов: ${reqs.length}`, { kind: 'ok' });
    };
  }

  async function openEnvModal() {
    const envs = visibleEnvs();
    let curEnv = envs.find((e) => e.id === activeEnvId)
      ? JSON.parse(JSON.stringify(envs.find((e) => e.id === activeEnvId)))
      : { id: '', name: 'Локальное', projectId: projId(), vars: [{ key: 'baseUrl', value: 'http://localhost:3000', secret: false }] };

    const { m, close } = makeModal(`
      <div class="shead" style="padding:0 0 8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
        <h3 style="margin:0;font-size:15px;">Переменные окружения ({{var}})</h3>
        <span class="grow"></span>
        <button class="icon-btn" id="rest-env-x" title="Закрыть"></button>
      </div>
      <div id="rest-env-body" class="rest-env-body"></div>
      <div class="modal-actions">
        <button id="rest-env-del" class="btn">Удалить</button>
        <span class="grow"></span>
        <button id="rest-env-cancel" class="btn">Закрыть</button>
        <button id="rest-env-save" class="btn primary">Сохранить</button>
      </div>
    `);
    m.classList.add('rest-modal');
    m.querySelector('#rest-env-x').appendChild(icon('x', 16));
    m.querySelector('#rest-env-x').onclick = close;
    m.querySelector('#rest-env-cancel').onclick = close;
    const eb = m.querySelector('#rest-env-body');

    const drawEnv = () => {
      eb.replaceChildren();
      const top = el('div', 'rest-env-top');
      const sel = /** @type {HTMLSelectElement} */ (document.createElement('select'));
      sel.className = 'rest-sel';
      for (const e of visibleEnvs()) {
        const o = document.createElement('option');
        o.value = e.id; o.textContent = e.name; o.setAttribute('data-no-i18n', '');
        if (e.id === curEnv.id) o.selected = true;
        sel.appendChild(o);
      }
      const newO = document.createElement('option');
      newO.value = '__new__'; newO.textContent = '+ Новое окружение';
      if (!curEnv.id) newO.selected = true;
      sel.appendChild(newO);
      sel.onchange = () => {
        if (sel.value === '__new__') curEnv = { id: '', name: 'Новое окружение', projectId: projId(), vars: [{ key: '', value: '', secret: false }] };
        else curEnv = JSON.parse(JSON.stringify(visibleEnvs().find((x) => x.id === sel.value) || curEnv));
        drawEnv();
      };

      const nm = /** @type {HTMLInputElement} */ (document.createElement('input'));
      nm.type = 'text'; nm.value = curEnv.name || ''; nm.placeholder = 'Название окружения';
      nm.setAttribute('data-no-i18n', '');
      nm.oninput = () => { curEnv.name = nm.value; };
      top.append(sel, nm);
      eb.appendChild(top);

      const list = el('div', 'rest-kv');
      (curEnv.vars || []).forEach((v, idx) => {
        const row = el('div', 'rest-kv-row');
        const k = /** @type {HTMLInputElement} */ (document.createElement('input'));
        k.type = 'text'; k.placeholder = 'Имя (например baseUrl)'; k.value = v.key || ''; k.setAttribute('data-no-i18n', '');
        k.oninput = () => { v.key = k.value; };

        const val = /** @type {HTMLInputElement} */ (document.createElement('input'));
        val.type = v.secret ? 'password' : 'text';
        val.placeholder = v.hasSecret ? '••• сохранено (оставьте пустым)' : 'Значение';
        val.value = v.value || ''; val.setAttribute('data-no-i18n', '');
        val.oninput = () => { v.value = val.value; v.keepSecret = false; };

        const secLbl = el('label', 'rest-sec-chk');
        const secCb = /** @type {HTMLInputElement} */ (document.createElement('input'));
        secCb.type = 'checkbox'; secCb.checked = !!v.secret;
        secCb.onchange = () => { v.secret = secCb.checked; drawEnv(); };
        secLbl.append(secCb, el('span', null, 'Секрет'));

        const del = el('button', 'icon-btn rest-kv-del'); del.type = 'button'; del.appendChild(icon('x', 13));
        del.onclick = () => { curEnv.vars.splice(idx, 1); drawEnv(); };
        row.append(k, val, secLbl, del);
        list.appendChild(row);
      });
      const addV = el('button', 'btn rest-mini-btn', '+ Переменная');
      addV.type = 'button';
      addV.onclick = () => { curEnv.vars.push({ key: '', value: '', secret: false }); drawEnv(); };
      list.appendChild(addV);
      eb.appendChild(list);
    };

    m.querySelector('#rest-env-del').onclick = async () => {
      if (!curEnv.id) return;
      const r = await lite.rest.deleteEnv(curEnv.id);
      if (r && r.ok && r.data) {
        data = r.data;
        if (activeEnvId === curEnv.id) { activeEnvId = ''; persistUi(); }
      }
      close(); render();
    };
    m.querySelector('#rest-env-save').onclick = async () => {
      const payload = {
        ...curEnv,
        vars: (curEnv.vars || []).map((v) => ({ ...v, keepSecret: !!(v.secret && v.hasSecret && !v.value) })),
      };
      const r = await lite.rest.saveEnv(payload);
      if (r && r.ok && r.data) {
        data = r.data;
        activeEnvId = r.id;
        persistUi();
        toast('Окружение сохранено', { kind: 'ok' });
        close(); render();
      }
    };
    drawEnv();
  }

  function render() {
    updateHeader();
    root.replaceChildren();

    const wrap = el('div', 'rest-layout');

    // Левая панель (коллекции, история, локальные порты)
    const side = el('aside', 'rest-side');
    const stabs = el('div', 'rest-tabs');
    for (const [id, lbl] of [['collections', 'Коллекции'], ['history', 'История'], ['local', 'Порты']]) {
      const b = el('button', 'rest-tab' + (sideTab === id ? ' on' : ''), lbl);
      b.onclick = () => {
        sideTab = id; persistUi();
        if (id === 'local' && !discovered.length) discoverLocal(); else render();
      };
      stabs.appendChild(b);
    }
    side.appendChild(stabs);

    const sideBody = el('div', 'rest-side-body');
    if (sideTab === 'collections') {
      const newBtn = el('button', 'btn rest-mini-btn', '+ Новый запрос');
      newBtn.onclick = () => { curReq = emptyRequest(); activeItemId = ''; render(); };
      sideBody.appendChild(newBtn);

      const cols = visibleCollections();
      if (!cols.length) {
        sideBody.appendChild(el('div', 'rest-empty', 'Коллекций пока нет. Создайте запрос или импортируйте OpenAPI / cURL.'));
      }
      for (const col of cols) {
        const cb = el('div', 'rest-col');
        const ch = el('div', 'rest-col-head');
        const cn = el('span', 'rest-col-name', col.name); cn.setAttribute('data-no-i18n', '');
        const cdel = el('button', 'icon-btn'); cdel.appendChild(icon('trash', 12));
        cdel.title = t('Удалить коллекцию');
        cdel.onclick = async () => {
          if (!(await showConfirm(`Удалить коллекцию «${col.name}»?`))) return;
          const r = await lite.rest.deleteCollection(col.id);
          if (r && r.ok && r.data) { data = r.data; if (activeColId === col.id) { activeColId = ''; activeItemId = ''; } render(); }
        };
        ch.append(cn, cdel);
        cb.appendChild(ch);
        for (const it of (col.items || [])) {
          const row = el('button', 'rest-item' + (activeItemId === it.id ? ' on' : ''));
          const mb = el('span', 'rest-m ' + String(it.method || 'GET').toLowerCase(), it.method || 'GET');
          mb.setAttribute('data-no-i18n', '');
          const nm = el('span', 'rest-item-name', it.name || it.url || it.method);
          nm.setAttribute('data-no-i18n', '');
          row.append(mb, nm);
          row.onclick = () => {
            curReq = emptyRequest(it);
            activeColId = col.id; activeItemId = it.id; curRes = null;
            persistUi(); render();
          };
          cb.appendChild(row);
        }
        sideBody.appendChild(cb);
      }
    } else if (sideTab === 'history') {
      const hAct = el('div', 'rest-side-acts');
      const clr = el('button', 'btn rest-mini-btn', 'Очистить');
      clr.onclick = async () => { await lite.rest.clearHistory(); data.history = []; render(); };
      hAct.appendChild(clr);
      sideBody.appendChild(hAct);
      if (!(data.history || []).length) sideBody.appendChild(el('div', 'rest-empty', 'История запросов пуста'));
      for (const h of (data.history || [])) {
        const row = el('button', 'rest-item');
        const mb = el('span', 'rest-m ' + String(h.method || 'GET').toLowerCase(), h.method);
        mb.setAttribute('data-no-i18n', '');
        const u = el('span', 'rest-item-name', h.url); u.setAttribute('data-no-i18n', '');
        const st = el('span', 'rest-h-st', String(h.status || 'ERR')); st.setAttribute('data-no-i18n', '');
        row.append(mb, u, st);
        row.onclick = () => { curReq = emptyRequest({ method: h.method, url: h.url, name: h.url }); render(); };
        sideBody.appendChild(row);
      }
    } else {
      const refBtn = el('button', 'btn rest-mini-btn', 'Сканировать порты проекта');
      refBtn.onclick = discoverLocal;
      sideBody.appendChild(refBtn);
      if (!discovered.length) sideBody.appendChild(el('div', 'rest-empty', 'Нет найденных локальных HTTP-портов'));
      for (const ep of discovered) {
        const row = el('div', 'rest-local-card');
        const top = el('div', 'rest-local-url', ep.baseUrl); top.setAttribute('data-no-i18n', '');
        row.appendChild(top);
        const acts = el('div', 'rest-local-acts');
        const useB = el('button', 'btn rest-mini-btn', 'Запрос');
        useB.onclick = () => { curReq = emptyRequest({ method: 'GET', url: ep.baseUrl + '/', name: `:${ep.port}` }); render(); };
        acts.appendChild(useB);
        if (ep.openApiUrl && ep.specText) {
          const impB = el('button', 'btn rest-mini-btn primary', 'Импорт OpenAPI');
          impB.onclick = async () => {
            const ir = await lite.rest.importText({ text: ep.specText, format: 'openapi', baseUrl: ep.baseUrl });
            if (ir && ir.ok && ir.requests) {
              const sv = await lite.rest.saveCollection({ name: ep.title || ir.name, projectId: projId(), items: ir.requests.map((q) => emptyRequest(q)) });
              if (sv && sv.ok && sv.data) { data = sv.data; activeColId = sv.id; sideTab = 'collections'; render(); }
            }
          };
          acts.appendChild(impB);
        }
        row.appendChild(acts);
        sideBody.appendChild(row);
      }
    }
    side.appendChild(sideBody);

    // Правая рабочая зона: запрос + ответ
    const main = el('div', 'rest-main');

    // Верхняя строка URL
    const bar = el('div', 'rest-urlbar');
    const mSel = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    mSel.className = 'rest-method'; mSel.setAttribute('data-no-i18n', '');
    for (const m of METHODS) {
      const o = document.createElement('option'); o.value = m; o.textContent = m;
      if (curReq.method === m) o.selected = true;
      mSel.appendChild(o);
    }
    mSel.onchange = () => { curReq.method = mSel.value; };

    const uIn = /** @type {HTMLInputElement} */ (document.createElement('input'));
    uIn.type = 'text'; uIn.className = 'rest-url-in'; uIn.placeholder = 'https://api.example.com/v1/users или {{baseUrl}}/health';
    uIn.value = curReq.url || ''; uIn.setAttribute('data-no-i18n', '');
    uIn.oninput = () => { curReq.url = uIn.value; };
    uIn.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendCurrent(); } };

    const envSel = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    envSel.className = 'rest-env-sel';
    const noEnv = document.createElement('option'); noEnv.value = ''; noEnv.textContent = 'Без окружения';
    envSel.appendChild(noEnv);
    for (const ev of visibleEnvs()) {
      const o = document.createElement('option'); o.value = ev.id; o.textContent = ev.name; o.setAttribute('data-no-i18n', '');
      if (ev.id === activeEnvId) o.selected = true;
      envSel.appendChild(o);
    }
    envSel.onchange = () => { activeEnvId = envSel.value; persistUi(); };

    const sendBtn = el('button', 'btn primary', sendingReqId ? 'Отмена' : 'Отправить');
    sendBtn.onclick = () => {
      if (sendingReqId) lite.rest.abort(sendingReqId);
      else sendCurrent();
    };
    const saveBtn = el('button', 'icon-btn'); saveBtn.title = t('Сохранить в коллекцию'); saveBtn.appendChild(icon('save', 15));
    saveBtn.onclick = () => saveCurrentToCollection(activeColId);
    const curlBtn = el('button', 'icon-btn'); curlBtn.title = t('Копировать как cURL'); curlBtn.appendChild(icon('copy', 15));
    curlBtn.onclick = async () => {
      const exp = await lite.rest.exportText({ format: 'curl', request: curReq });
      if (exp && exp.ok && exp.text) {
        await navigator.clipboard.writeText(exp.text);
        toast('cURL скопирован', { kind: 'ok' });
      }
    };
    bar.append(mSel, uIn, envSel, sendBtn, saveBtn, curlBtn);
    main.appendChild(bar);

    // Вкладки запроса
    const rtabs = el('div', 'rest-tabs');
    for (const [id, lbl] of [['params', 'Params'], ['headers', 'Headers'], ['auth', 'Auth'], ['body', 'Body'], ['opts', 'Настройки']]) {
      const b = el('button', 'rest-tab' + (reqTab === id ? ' on' : ''), lbl);
      b.onclick = () => { reqTab = id; render(); };
      rtabs.appendChild(b);
    }
    main.appendChild(rtabs);

    const reqPane = el('div', 'rest-req-pane');
    if (reqTab === 'params') {
      reqPane.appendChild(kvEditor(curReq.params, 'Параметр', 'Значение', () => {}));
    } else if (reqTab === 'headers') {
      reqPane.appendChild(kvEditor(curReq.headers, 'Заголовок', 'Значение', () => {}));
    } else if (reqTab === 'auth') {
      const aBox = el('div', 'rest-auth');
      const aSel = /** @type {HTMLSelectElement} */ (document.createElement('select'));
      aSel.className = 'rest-sel';
      for (const [v, lbl] of [['none', 'Без авторизации'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = lbl;
        if ((curReq.auth && curReq.auth.type) === v) o.selected = true;
        aSel.appendChild(o);
      }
      aSel.onchange = () => { curReq.auth = { type: aSel.value }; render(); };

      const kpBtn = el('button', 'btn rest-mini-btn', 'Из сейфа');
      kpBtn.onclick = async () => {
        const cred = await pickKeepassCred();
        if (!cred) return;
        if (curReq.auth.type === 'bearer') curReq.auth.token = cred.password || '';
        else if (curReq.auth.type === 'apikey') curReq.auth.apiKeyValue = cred.password || '';
        else { curReq.auth = { type: 'basic', user: cred.username || '', pass: cred.password || '' }; }
        render();
        toast('Подставлено из сейфа паролей', { kind: 'ok' });
      };
      aBox.append(el('div', 'rest-auth-top'));
      aBox.firstChild.append(aSel, kpBtn);

      const at = (curReq.auth && curReq.auth.type) || 'none';
      if (at === 'bearer') {
        const inp = /** @type {HTMLInputElement} */ (document.createElement('input'));
        inp.type = 'password'; inp.placeholder = curReq.auth.hasSecret ? '••• сохранён (введите новый для замены)' : 'Токен или {{token}}';
        inp.value = curReq.auth.token || ''; inp.setAttribute('data-no-i18n', '');
        inp.oninput = () => { curReq.auth.token = inp.value; };
        aBox.appendChild(inp);
      } else if (at === 'basic') {
        const u = /** @type {HTMLInputElement} */ (document.createElement('input'));
        u.type = 'text'; u.placeholder = 'Логин'; u.value = curReq.auth.user || ''; u.setAttribute('data-no-i18n', '');
        u.oninput = () => { curReq.auth.user = u.value; };
        const p = /** @type {HTMLInputElement} */ (document.createElement('input'));
        p.type = 'password'; p.placeholder = curReq.auth.hasSecret ? '••• сохранён' : 'Пароль'; p.value = curReq.auth.pass || ''; p.setAttribute('data-no-i18n', '');
        p.oninput = () => { curReq.auth.pass = p.value; };
        aBox.append(u, p);
      } else if (at === 'apikey') {
        const n = /** @type {HTMLInputElement} */ (document.createElement('input'));
        n.type = 'text'; n.placeholder = 'Имя (X-API-Key)'; n.value = curReq.auth.apiKeyName || 'X-API-Key'; n.setAttribute('data-no-i18n', '');
        n.oninput = () => { curReq.auth.apiKeyName = n.value; };
        const v = /** @type {HTMLInputElement} */ (document.createElement('input'));
        v.type = 'password'; v.placeholder = curReq.auth.hasSecret ? '••• сохранён' : 'Ключ или {{apiKey}}'; v.value = curReq.auth.apiKeyValue || ''; v.setAttribute('data-no-i18n', '');
        v.oninput = () => { curReq.auth.apiKeyValue = v.value; };
        aBox.append(n, v);
      }
      reqPane.appendChild(aBox);
    } else if (reqTab === 'body') {
      const modes = el('div', 'rest-body-modes');
      for (const [m, lbl] of [['none', 'Нет'], ['json', 'JSON'], ['graphql', 'GraphQL'], ['raw', 'Текст'], ['form', 'Form']]) {
        const rb = el('button', 'rest-chip' + (curReq.bodyMode === m ? ' on' : ''), lbl);
        rb.onclick = () => { curReq.bodyMode = m; render(); };
        modes.appendChild(rb);
      }
      reqPane.appendChild(modes);
      if (curReq.bodyMode === 'graphql') {
        const gq = /** @type {HTMLTextAreaElement} */ (document.createElement('textarea'));
        gq.className = 'rest-ta'; gq.spellcheck = false; gq.setAttribute('data-no-i18n', '');
        gq.value = curReq.graphqlQuery || ''; gq.placeholder = 'query { ... }';
        gq.oninput = () => { curReq.graphqlQuery = gq.value; };
        const gv = /** @type {HTMLTextAreaElement} */ (document.createElement('textarea'));
        gv.className = 'rest-ta rest-ta-sm'; gv.spellcheck = false; gv.setAttribute('data-no-i18n', '');
        gv.value = curReq.graphqlVars || '{}'; gv.placeholder = '{"id": 1}';
        gv.oninput = () => { curReq.graphqlVars = gv.value; };
        reqPane.append(gq, gv);
      } else if (curReq.bodyMode !== 'none') {
        const ta = /** @type {HTMLTextAreaElement} */ (document.createElement('textarea'));
        ta.className = 'rest-ta'; ta.spellcheck = false; ta.setAttribute('data-no-i18n', '');
        ta.value = curReq.body || '';
        ta.oninput = () => { curReq.body = ta.value; };
        reqPane.appendChild(ta);
      }
    } else {
      const optBox = el('div', 'rest-opts');
      const rLbl = el('label', 'rest-sec-chk');
      const rCb = /** @type {HTMLInputElement} */ (document.createElement('input'));
      rCb.type = 'checkbox'; rCb.checked = curReq.followRedirects !== false;
      rCb.onchange = () => { curReq.followRedirects = rCb.checked; };
      rLbl.append(rCb, el('span', null, 'Следовать за редиректами (с зачисткой Authorization на чужом origin)'));

      const tlsLbl = el('label', 'rest-sec-chk');
      const tlsCb = /** @type {HTMLInputElement} */ (document.createElement('input'));
      tlsCb.type = 'checkbox'; tlsCb.checked = curReq.rejectUnauthorized !== false;
      tlsCb.onchange = () => { curReq.rejectUnauthorized = tlsCb.checked; };
      tlsLbl.append(tlsCb, el('span', null, 'Проверять TLS-сертификаты'));
      optBox.append(rLbl, tlsLbl);
      reqPane.appendChild(optBox);
    }
    main.appendChild(reqPane);

    // Секция ответа
    const resBox = el('div', 'rest-res-box');
    if (curRes) {
      const rhead = el('div', 'rest-res-head');
      if (curRes.error) {
        const eb = el('span', 'rest-st err', curRes.error); eb.setAttribute('data-no-i18n', '');
        rhead.appendChild(eb);
      } else {
        const cls = curRes.status >= 500 ? 'err' : curRes.status >= 400 ? 'warn' : curRes.status >= 200 ? 'ok' : '';
        const sb = el('span', 'rest-st ' + cls, `${curRes.status} ${curRes.statusText || ''}`); sb.setAttribute('data-no-i18n', '');
        const tm = el('span', 'rest-meta', `${curRes.timing ? curRes.timing.totalMs : 0} ms · ${formatBytes(curRes.bytes)}`); tm.setAttribute('data-no-i18n', '');
        rhead.append(sb, tm);
      }
      const sp = el('span', 'grow');
      const openV = el('button', 'btn rest-mini-btn', 'В вивер');
      openV.onclick = () => lite.editorBus.openTextInViewer('response.json', prettyResponse(curRes));
      const toAgent = el('button', 'btn rest-mini-btn primary', 'Отправить агенту');
      toAgent.onclick = sendResultToAgent;
      rhead.append(sp, openV, toAgent);
      resBox.appendChild(rhead);

      if (!curRes.error) {
        const rtt = el('div', 'rest-tabs');
        for (const [id, lbl] of [['body', 'Body'], ['headers', 'Headers'], ['timing', 'Timing']]) {
          const b = el('button', 'rest-tab' + (resTab === id ? ' on' : ''), lbl);
          b.onclick = () => { resTab = id; render(); };
          rtt.appendChild(b);
        }
        resBox.appendChild(rtt);

        const rc = el('div', 'rest-res-body');
        if (resTab === 'body') {
          const pre = el('pre', 'rest-pre', prettyResponse(curRes));
          pre.setAttribute('data-no-i18n', '');
          rc.appendChild(pre);
        } else if (resTab === 'headers') {
          const tbl = el('div', 'rest-hdr-tbl');
          for (const [k, v] of Object.entries(curRes.headers || {})) {
            const r = el('div', 'rest-hdr-row');
            const ke = el('b', null, k); ke.setAttribute('data-no-i18n', '');
            const ve = el('span', null, Array.isArray(v) ? v.join(', ') : String(v)); ve.setAttribute('data-no-i18n', '');
            r.append(ke, ve);
            tbl.appendChild(r);
          }
          rc.appendChild(tbl);
        } else {
          const tData = curRes.timing || {};
          const list = el('div', 'rest-timing');
          for (const [k, lbl] of [['dnsMs', 'DNS'], ['tcpMs', 'TCP'], ['tlsMs', 'TLS'], ['ttfbMs', 'TTFB'], ['downloadMs', 'Download'], ['totalMs', 'Total']]) {
            const r = el('div', 'rest-hdr-row');
            r.append(el('b', null, lbl), el('span', null, `${tData[k] || 0} ms`));
            list.appendChild(r);
          }
          rc.appendChild(list);
        }
        resBox.appendChild(rc);
      }
    } else {
      resBox.appendChild(el('div', 'rest-empty', 'Нажмите «Отправить» (Ctrl+Enter) для выполнения запроса'));
    }
    main.appendChild(resBox);

    wrap.append(side, main);
    root.appendChild(wrap);
  }

  return {
    async setOpen(open) {
      pane.classList.toggle('hidden', !open);
      if (open) {
        await ensureLoad();
        render();
      }
    },
    async handleArg(arg) {
      await ensureLoad();
      if (arg && typeof arg === 'object' && arg.url) {
        curReq = emptyRequest({ method: arg.method || 'GET', url: String(arg.url), name: String(arg.url) });
        activeColId = ''; activeItemId = ''; curRes = null;
      }
      render();
    },
    discoverLocal,
    openImportModal,
    openEnvModal,
  };
}
