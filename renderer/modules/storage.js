// Модуль «Внешние хранилища»: подключения к объектным хранилищам + файловый браузер.
// Первый адаптер — S3 (AWS / MinIO / R2 / Yandex и т.п.); архитектура адаптерная — вкладки
// адаптеров под главными вкладками. ГЛАВНЫЕ вкладки «Проект / Общие» (как в «Задачах»):
// подключение принадлежит scope (id проекта или '__global__'), перенос между областями —
// смена одного поля (st:setScope), а не переписывание двух файлов.
// Бэкенд — lib/storage.js (+ lib/storage-s3.js), мост — lite.storage, все ответы {ok,...}.
// Возможности адаптера приходят в conn.caps — UI прячет недоступное (задел под WebDAV).
import { el, icon, iconBtn, hydrateIcons, toast, makeModal, showConfirm, showPrompt, baseName } from '../ui.js';
import { languageFor } from '../codeedit.js';
import { kpFormButtons } from '../kpicker.js';

const lite = window.lite;
const $ = (s) => document.querySelector(s);
const GLOBAL_SCOPE = '__global__';
// Полоса адаптеров. FTP/SFTP сюда сознательно НЕ добавляем — их целиком закрывает модуль
// «Удалённые хосты» (профили, браузер файлов, правка в вивере); дубликат не нужен.
const ADAPTER_TABS = [['s3', 'S3', true], ['webdav', 'WebDAV', false]];
const DEFAULT_CAPS = { buckets: true, presign: true, acl: true, publicUrl: true };
// Пресеты популярных S3-провайдеров: подставляют endpoint/регион/path-style (значения — типовые,
// endpoint часто зависит от региона аккаунта — поле остаётся редактируемым).
const PRESETS = [
  ['aws', 'Amazon S3', { endpoint: '', region: 'us-east-1', ps: false }],
  ['minio', 'MinIO (локальный)', { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', ps: true }],
  ['yandex', 'Yandex Object Storage', { endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', ps: false }],
  ['b2', 'Backblaze B2', { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', ps: false }],
  ['do', 'DigitalOcean Spaces', { endpoint: 'https://fra1.digitaloceanspaces.com', region: 'fra1', ps: false }],
  ['wasabi', 'Wasabi', { endpoint: 'https://s3.eu-central-1.wasabisys.com', region: 'eu-central-1', ps: false }],
  ['gcs', 'Google Cloud Storage (interop)', { endpoint: 'https://storage.googleapis.com', region: 'auto', ps: false }],
  ['r2', 'Cloudflare R2', { endpoint: 'https://ACCOUNT_ID.r2.cloudflarestorage.com', region: 'auto', ps: false }],
  ['selectel', 'Selectel', { endpoint: 'https://s3.ru-1.storage.selcloud.ru', region: 'ru-1', ps: false }],
  ['vk', 'VK Cloud', { endpoint: 'https://hb.ru-msk.vkcloud-storage.ru', region: 'ru-msk', ps: false }],
  ['timeweb', 'Timeweb Cloud', { endpoint: 'https://s3.twcstorage.ru', region: 'ru-1', ps: true }],
];
const fmtSize = (n) => { n = +n || 0; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' МБ'; return (n / 1073741824).toFixed(2) + ' ГБ'; };
const fmtDate = (t) => { if (!t) return '—'; const d = new Date(t); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const extOf = (name) => String(name).split('.').pop().toLowerCase();

export function initStorage(host) {
  const { activeProject, createCodeEditor, STORE, persist,
    menuRow, placeMenu, closeMenus, sendToTerminal, openInViewer,
    showConfirm: hostConfirm } = host;
  const confirm2 = hostConfirm || showConfirm;

  let stOpen = false;
  const stUi = STORE.stUi && typeof STORE.stUi === 'object' ? STORE.stUi : {};
  const saveUi = () => { try { persist('stUi', stUi); } catch (_) {} };
  let tab = stUi.tab === 'global' ? 'global' : 'project';   // главная вкладка; «Проект» — первая и дефолт
  let adapter = ADAPTER_TABS.some(([k, , on]) => on && k === stUi.adapter) ? stUi.adapter : 's3';
  let conns = [];          // публичный список (секретов нет — только hasSecret/hasSessionToken/caps)
  let secure = true;
  let renderSeq = 0;
  let restoredOnce = false; // восстановление открытых вкладок прошлого запуска (stUi.openTabs)

  // --- воркспейс ---
  let connListMode = true; // true = список подключений, false = открытое подключение
  let openConns = [];      // ids открытых вкладок-подключений
  let activeId = null, activeConn = null;
  let curBucket = null, curPrefix = '';   // null bucket = вид «бакеты»
  let buckets = [];
  let bucketsLoading = false;
  let listing = { dirs: [], files: [], nextToken: null, loading: false };
  let listSeq = 0;         // инвалидация листинга (смена пути/подключения/открытие файла)
  let treeSeq = 0;         // инвалидация асинхронной загрузки дерева
  let viewer = null;       // { bucket, key, kind, ... } — открытый в вивере объект
  let curEditor = null;    // живой CodeMirror вивера (destroy на ЛЮБОМ пути выхода)
  let curListBox = null;   // живой контейнер списка (перерисовка без пересоздания = скролл жив)
  const expanded = new Set();    // раскрытые узлы дерева: nodeKey(bucket, prefix)
  const treeNodes = new Map();   // nodeKey → { row, chev, childBox, ... } — подсветка + точечный рефреш
  const selection = new Set();   // выбранные ключи файлов (мультивыбор)
  let filterText = '';           // фильтр по текущему листингу (живёт в сессии)
  const sort = stUi.sort && ['name', 'size', 'mtime'].includes(stUi.sort.key) ? { ...stUi.sort } : { key: 'name', dir: 1 };

  // --- передачи ---
  let opSeq = 0;
  const transfers = new Map();     // opId → {phase, key, name, bucket, prefix, loaded, total, speed, ...}
  const transferRows = new Map();  // opId → {fill, pct} — точечное обновление прогресса без rebuild
  const newOpId = () => 'op' + Date.now().toString(36) + (++opSeq);

  const caps = () => (activeConn && activeConn.caps) || DEFAULT_CAPS;
  const canWrite = () => !!activeConn && !activeConn.readOnly && !activeConn.anonymous;

  // Куда смотрит активная главная вкладка (калька currentTarget из «Задач»).
  function currentScope() {
    if (tab === 'global') return { kind: 'global', id: GLOBAL_SCOPE, name: 'Общие' };
    const p = activeProject();
    return p ? { kind: 'project', id: p.id, name: p.name } : null;
  }

  // ============================================================ роутер
  async function renderPanel() {
    const seq = ++renderSeq;
    const body = $('#storage-body');
    if (!body) return;
    destroyEditor(); // любой полный перерендер сносит DOM вивера — инстанс CodeMirror не бросаем
    if (connListMode || !activeId) {
      const r = await lite.storage.list();
      if (seq !== renderSeq || !stOpen) return;
      conns = (r && r.connections) || [];
      secure = !r || r.secure !== false;
      // восстановление открытых вкладок прошлого запуска (как в «Базах данных»)
      if (!restoredOnce) {
        restoredOnce = true;
        const ids = (Array.isArray(stUi.openTabs) ? stUi.openTabs : []).filter((id) => conns.some((c) => c.id === id));
        if (ids.length) {
          openConns = ids;
          const actId = (stUi.activeTab && ids.includes(stUi.activeTab)) ? stUi.activeTab : ids[ids.length - 1];
          const act = conns.find((c) => c.id === actId);
          if (act) { openConnection(act); return; }
        }
      }
      body.innerHTML = '';
      renderConnStrip(body);
      renderConnList(body);
    } else {
      body.innerHTML = '';
      renderConnStrip(body);
      renderWorkspace(body);
    }
    hydrateIcons(body);
  }

  // Полоса открытых подключений (как вкладки подключений в «Базах данных»).
  function renderConnStrip(body) {
    if (!openConns.length) return;
    const strip = el('div', 'st-connstrip');
    const listBtn = el('button', 'st-ctab' + (connListMode ? ' on' : ''));
    listBtn.append(icon('grid', 13), el('span', null, 'Подключения'));
    listBtn.onclick = () => { connListMode = true; renderPanel(); };
    strip.appendChild(listBtn);
    for (const id of openConns) {
      const c = conns.find((x) => x.id === id) || (activeConn && activeConn.id === id ? activeConn : null);
      if (!c) continue;
      const t = el('button', 'st-ctab' + (!connListMode && id === activeId ? ' on' : ''));
      if (c.color) t.style.borderTop = `2px solid ${c.color}`;
      t.append(icon('cloud', 13), el('span', null, c.name || id));
      const x = el('span', 'st-ctab-x', '×');
      x.onclick = (e) => { e.stopPropagation(); closeConnection(id); };
      t.appendChild(x);
      t.onclick = () => openConnection(c);
      strip.appendChild(t);
    }
    body.appendChild(strip);
  }

  // ============================================================ список подключений
  function tabsRow() {
    const scope = currentScope();
    const wrap = el('div', 'nt-tabs st-tabs');
    for (const [k, l, ic] of [['project', 'Проект', 'folder'], ['global', 'Общие', 'globe']]) {
      const b = el('button', 'nt-tab' + (tab === k ? ' active' : ''));
      b.append(icon(ic, 15), el('span', null, k === 'project' && scope && scope.kind === 'project' ? `Проект · ${scope.name}` : l));
      b.onclick = () => { if (tab !== k) { tab = k; stUi.tab = k; saveUi(); renderPanel(); } };
      wrap.appendChild(b);
    }
    return wrap;
  }
  function adapterRow() {
    const wrap = el('div', 'st-atabs');
    for (const [k, l, ready] of ADAPTER_TABS) {
      const b = el('button', 'st-atab' + (adapter === k ? ' on' : ''));
      b.textContent = l;
      if (!ready) { b.disabled = true; b.title = 'Адаптер в планах'; b.appendChild(el('span', 'st-atab-soon', 'скоро')); }
      else b.onclick = () => { if (adapter !== k) { adapter = k; stUi.adapter = k; saveUi(); renderPanel(); } };
      wrap.appendChild(b);
    }
    return wrap;
  }

  function renderConnList(body) {
    const scope = currentScope();
    body.appendChild(tabsRow());
    body.appendChild(adapterRow());
    const wrap = el('div', 'st-list-wrap');
    body.appendChild(wrap);
    if (!secure) wrap.appendChild(el('div', 'db-warn', '⚠ Системное хранилище ключей недоступно — секреты шифруются слабее.'));
    if (tab === 'project' && !scope) {
      wrap.appendChild(el('div', 'st-empty', 'Откройте проект слева, чтобы вести его хранилища. Либо переключитесь на вкладку «Общие».'));
      return;
    }
    const top = el('div', 'db-topbar');
    top.appendChild(el('span', 'db-topbar-title', 'Подключения'));
    const add = iconBtn('drow-act', 'plus', 'Новое подключение', 16);
    add.onclick = () => connModal(null);
    top.appendChild(add);
    wrap.appendChild(top);
    const list = conns.filter((c) => (c.adapter || 's3') === adapter && (c.scope || GLOBAL_SCOPE) === scope.id);
    if (!list.length) {
      wrap.appendChild(el('div', 'st-empty', tab === 'project'
        ? `У проекта «${scope.name}» нет подключений. Добавьте первое кнопкой ＋ (или перенесите из «Общих»).`
        : 'Общих подключений нет. Добавьте первое кнопкой ＋.'));
      return;
    }
    const groups = {};
    for (const c of list) { const g = c.category || 'Все'; (groups[g] = groups[g] || []).push(c); }
    const cats = Object.keys(groups).sort((a, b) => (a === 'Все' ? -1 : b === 'Все' ? 1 : a.localeCompare(b)));
    for (const cat of cats) {
      const block = el('div', 'docker-group-block');
      const head = el('div', 'docker-group-head st-cat-head');
      head.append(el('span', 'dgrp-name', cat), el('span', 'dgrp-count', String(groups[cat].length)));
      const bodyEl = el('div', 'docker-group-body');
      for (const c of groups[cat]) bodyEl.appendChild(connCard(c, scope));
      block.append(head, bodyEl);
      wrap.appendChild(block);
    }
  }

  function connCard(c, scope) {
    const row = el('div', 'db-conn-row clickable st-conn-row');
    if (c.color) { row.style.borderLeft = `3px solid ${c.color}`; row.style.paddingLeft = '6px'; }
    row.appendChild(icon('cloud', 16));
    const main = el('div', 'drow-main');
    const nameRow = el('span', 'drow-name', c.name || '(без имени)');
    if (c.isProd) nameRow.appendChild(el('span', 'st-badge st-badge-prod', 'PROD'));
    if (c.readOnly) nameRow.appendChild(el('span', 'st-badge', 'только чтение'));
    if (c.anonymous) nameRow.appendChild(el('span', 'st-badge st-badge-anon', 'анонимно'));
    main.appendChild(nameRow);
    const place = c.endpoint ? c.endpoint.replace(/^https?:\/\//, '') : `AWS · ${c.region || 'us-east-1'}`;
    main.appendChild(el('span', 'drow-sub', `S3 · ${place}${c.defaultBucket ? ' · 🪣 ' + c.defaultBucket : ''}`));
    row.appendChild(main);
    if (openConns.includes(c.id)) row.appendChild(el('span', 'db-ro-badge', 'открыто'));
    const acts = el('div', 'drow-acts');
    // перенос Проект ⇄ Общие (сменой scope — одна атомарная запись)
    const toGlobal = scope.kind === 'project';
    const mv = iconBtn('drow-act', toGlobal ? 'globe' : 'folder', toGlobal ? 'Перенести в «Общие»' : 'Перенести в проект', 13);
    mv.onclick = async (e) => {
      e.stopPropagation();
      let dest, destName;
      if (toGlobal) { dest = GLOBAL_SCOPE; destName = 'Общие'; }
      else {
        const p = activeProject();
        if (!p) { toast('Нет активного проекта — некуда перенести', { kind: 'err' }); return; }
        dest = p.id; destName = p.name;
      }
      const r = await lite.storage.setScope(c.id, dest);
      if (!r.ok) { toast(r.error || 'Не удалось перенести', { kind: 'err' }); return; }
      adoptConn(r.connection);
      toast(`Перенесено в «${destName}»`);
      renderPanel();
    };
    const edit = iconBtn('drow-act', 'pencil', 'Изменить', 13);
    edit.onclick = (e) => { e.stopPropagation(); connModal(c); };
    const del = iconBtn('drow-act danger', 'trash', 'Удалить', 13);
    del.onclick = (e) => {
      e.stopPropagation();
      confirm2('Удалить подключение?', `«${c.name}» удалится из списка (само хранилище не трогается).`, 'Удалить', async () => {
        const r = await lite.storage.delete(c.id);
        if (!r.ok) { toast(r.error || 'Не удалось удалить', { kind: 'err' }); return; }
        closeConnection(c.id, true);
        renderPanel();
      });
    };
    acts.append(mv, edit, del);
    row.appendChild(acts);
    row.addEventListener('click', () => openConnection(c));
    return row;
  }

  // Освежить запись в кэшах после save/setScope — иначе полоса вкладок и шапка дерева живут со старым именем/scope.
  function adoptConn(pub) {
    if (!pub) return;
    const i = conns.findIndex((x) => x.id === pub.id);
    if (i >= 0) conns[i] = pub; else conns.push(pub);
    if (activeId === pub.id) activeConn = pub;
  }

  // ============================================================ форма подключения
  function connModal(existing, presetSecret) {
    const scope = currentScope();
    if (!existing && !scope) { toast('Откройте проект или переключитесь на «Общие»', { kind: 'err' }); return; }
    const c = existing ? { ...existing } : { adapter, scope: scope.id, region: 'us-east-1', category: 'Все' };
    const { m, close } = makeModal(`<h2>${c.id ? 'Изменить' : 'Новое'} подключение S3</h2><div id="stf" class="db-form"></div>`);
    m.classList.add('db-modal', 'db-conn-modal');
    const f = m.querySelector('#stf');
    const field = (label, node) => { const w = el('div', 'db-field'); w.append(el('label', null, label), node); f.appendChild(w); return node; };
    const mk = (lbl, node) => { const w = el('div', 'db-field'); w.append(el('label', null, lbl), node); return w; };
    const inp = (val, ph, type) => { const i = el('input'); i.type = type || 'text'; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
    const check = (lbl, val, cls) => { const w = el('label', 'db-check' + (cls ? ' ' + cls : '')); const i = el('input'); i.type = 'checkbox'; i.checked = !!val; w.append(i, document.createTextNode(' ' + lbl)); return [w, i]; };

    const name = field('Имя', inp(c.name, 'Прод-бакет отчётов'));
    // категория: выбор из существующих + новая (паттерн формы «Баз данных»)
    const cats = [...new Set(conns.map((x) => x.category || 'Все'))];
    if (!cats.includes('Все')) cats.unshift('Все');
    if (c.category && !cats.includes(c.category)) cats.push(c.category);
    const catSel = el('select');
    for (const cc of cats) { const o = new Option(cc, cc); if (cc === (c.category || 'Все')) o.selected = true; catSel.appendChild(o); }
    const CAT_NEW = '__newcat__'; catSel.appendChild(new Option('➕ Новая категория…', CAT_NEW));
    const catNew = inp('', 'Название новой категории'); catNew.style.display = 'none';
    catSel.onchange = () => { const isNew = catSel.value === CAT_NEW; catNew.style.display = isNew ? '' : 'none'; if (isNew) catNew.focus(); };
    const catWrap = el('div', 'db-cat-wrap'); catWrap.append(catSel, catNew);
    field('Категория', catWrap);
    const getCategory = () => (catSel.value === CAT_NEW ? catNew.value.trim() : catSel.value) || 'Все';

    // пресеты провайдеров: подставляют endpoint/регион/path-style; поле остаётся редактируемым
    const presetSel = el('select');
    presetSel.appendChild(new Option('— свои значения —', ''));
    for (const [k, l] of PRESETS) presetSel.appendChild(new Option(l, k));
    field('Провайдер', presetSel);

    const grp = el('div', 'db-group');
    const endpoint = inp(c.endpoint || '', 'https://storage.example.com (пусто = AWS)');
    const region = inp(c.region || 'us-east-1', 'us-east-1');
    const [psL, ps] = check('Path-style адресация (MinIO / локальные S3)', c.forcePathStyle);
    grp.append(mk('Endpoint', endpoint), mk('Регион', region), psL);
    f.appendChild(grp);
    presetSel.onchange = () => {
      const p = PRESETS.find(([k]) => k === presetSel.value);
      if (!p) return;
      endpoint.value = p[2].endpoint; region.value = p[2].region; ps.checked = p[2].ps;
    };

    const [anonL, anon] = check('Анонимный доступ (публичный бакет, без ключей — только чтение)', c.anonymous, 'db-check-warn');
    f.appendChild(anonL);
    const keysGrp = el('div', 'db-group');
    const akey = inp(c.accessKeyId || '', 'Access Key ID');
    const skey = inp(presetSecret || '', c.id && c.hasSecret ? '(без изменений)' : 'Secret Access Key', 'password');
    const kpRow = kpFormButtons({
      user: akey, pass: skey,
      title: () => name.value.trim() || 'LiteEditor: внешнее хранилище',
      url: () => endpoint.value.trim(),
      notes: 'LiteEditor · модуль «Внешние хранилища»',
    });
    const stoken = inp('', c.id && c.hasSessionToken ? '(без изменений)' : 'Session Token (для временных STS-ключей, опц.)', 'password');
    let clearToken = false;
    const tokRow = el('div', 'st-tokrow');
    tokRow.appendChild(stoken);
    if (c.id && c.hasSessionToken) {
      // сохранённый токен нельзя показать (шифрован в main) — но можно явно удалить
      const tclr = el('button', 'btn st-tok-clear', 'Очистить');
      tclr.type = 'button';
      tclr.title = 'Удалить сохранённый Session Token при сохранении';
      tclr.onclick = () => { clearToken = !clearToken; stoken.disabled = clearToken; stoken.placeholder = clearToken ? '(будет удалён)' : '(без изменений)'; tclr.classList.toggle('danger', clearToken); };
      tokRow.appendChild(tclr);
    }
    keysGrp.append(mk('Access Key ID', akey), mk('Secret Key', skey), kpRow, mk('Session Token', tokRow));
    f.appendChild(keysGrp);
    // «анонимно» только ПРЯЧЕТ ключи — сохранённые значения не стираются (выключил обратно — всё на месте)
    const syncAnon = () => { keysGrp.style.display = anon.checked ? 'none' : ''; };
    anon.onchange = syncAnon; syncAnon();

    const grp2 = el('div', 'db-group');
    const defBucket = inp(c.defaultBucket || '', 'открывать сразу этот бакет (опц.)');
    const pubBase = inp(c.publicBaseUrl || '', 'https://cdn.example.com — база публичных ссылок (опц.)');
    grp2.append(mk('Бакет по умолчанию', defBucket), mk('Публичный базовый URL', pubBase));
    f.appendChild(grp2);

    const [roL, ro] = check('Только чтение (запрет загрузки/удаления/переименования)', c.readOnly);
    f.appendChild(roL);
    const colorSel = el('select');
    for (const [v, lbl] of [['', 'без цвета'], ['#e5484d', '🔴 красный (prod)'], ['#f5a623', '🟠 янтарный (stage)'], ['#30a46c', '🟢 зелёный (dev)'], ['#0091ff', '🔵 синий'], ['#8e4ec6', '🟣 фиолетовый']]) { const o = new Option(lbl, v); if ((c.color || '') === v) o.selected = true; colorSel.appendChild(o); }
    field('Цвет окружения', colorSel);
    const [prodL, prod] = check('PRODUCTION — подтверждать разрушающие операции', c.isProd, 'db-check-warn');
    f.appendChild(prodL);

    const collect = () => {
      const o = {
        id: c.id, adapter: c.adapter || 's3', scope: c.scope || (scope && scope.id) || GLOBAL_SCOPE,
        name: name.value.trim(), category: getCategory(),
        endpoint: endpoint.value.trim().replace(/\/+$/, ''), region: region.value.trim() || 'us-east-1',
        forcePathStyle: ps.checked, anonymous: anon.checked,
        accessKeyId: akey.value.trim(),
        defaultBucket: defBucket.value.trim(), publicBaseUrl: pubBase.value.trim().replace(/\/+$/, ''),
        readOnly: ro.checked, color: colorSel.value, isProd: prod.checked,
      };
      if (skey.value) o.secretKey = skey.value;
      if (clearToken) o.sessionToken = '';
      else if (stoken.value) o.sessionToken = stoken.value;
      if (c.source) o.source = c.source; // метка «создано из контейнера X» — для дедупа повторных кликов
      return o;
    };
    const row = el('div', 'gm-actions'); row.style.marginTop = '12px';
    const status = el('span', 'db-test-status');
    const test = el('button', 'btn', 'Тест');
    test.onclick = async () => {
      status.textContent = 'Проверяю…'; status.className = 'db-test-status';
      const r = await lite.storage.test(collect());
      if (r.ok) { status.textContent = '✓ ' + (r.info || 'подключение успешно'); status.classList.add('ok'); }
      else { status.textContent = '✕ ' + (r.error || 'не удалось'); status.classList.add('err'); }
    };
    const save = el('button', 'btn primary', 'Сохранить');
    save.onclick = async () => {
      const o = collect();
      if (!o.name) { toast('Введите имя', { kind: 'err' }); return; }
      const r = await lite.storage.save(o);
      if (!r.ok) { toast(r.error || 'Не удалось сохранить', { kind: 'err' }); return; }
      adoptConn(r.connection);
      close(); renderPanel();
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    row.append(test, save, cancel);
    f.appendChild(row); f.appendChild(status);
    hydrateIcons(m);
  }

  // «Контейнеры» → MinIO: существующее подключение того же источника — открыть; нет — префилл-форма.
  function openFromContainer(payload) {
    const p = payload && payload.prefill;
    if (!p) return;
    const existing = conns.find((x) => x.source && x.source === p.source);
    if (existing) { openConnection(existing); return; }
    const { secretKey, ...rest } = p;
    connModal({ ...rest, scope: GLOBAL_SCOPE }, secretKey || '');
    if (!payload.published) toast('API-порт MinIO (9000) не проброшен на хост — проверьте -p', { kind: 'err', ttl: 8000 });
  }

  // ============================================================ открытие/закрытие подключения
  async function openConnection(c) {
    if (activeId === c.id) { connListMode = false; renderPanel(); return; } // возврат на вкладку БЕЗ сброса позиции
    connListMode = false;
    if (!openConns.includes(c.id)) openConns.push(c.id);
    activeId = c.id; activeConn = c;
    curBucket = null; curPrefix = ''; viewer = null; buckets = []; selection.clear(); filterText = '';
    listing = { dirs: [], files: [], nextToken: null, loading: false };
    ++listSeq; ++treeSeq; // запоздалые ответы прежнего подключения — в мусор
    stUi.openTabs = openConns.slice(); stUi.activeTab = c.id; saveUi();
    await renderPanel();
    // бакет по умолчанию — сразу в него (список бакетов может быть недоступен по правам)
    if (c.defaultBucket) navigateTo(c.defaultBucket, '');
  }
  function closeConnection(id, silent) {
    openConns = openConns.filter((x) => x !== id);
    stUi.openTabs = openConns.slice();
    if (stUi.activeTab === id) stUi.activeTab = openConns[openConns.length - 1] || '';
    saveUi();
    for (const k of [...expanded]) if (k.startsWith(id + ' ')) expanded.delete(k);
    if (activeId === id) {
      activeId = null; activeConn = null; viewer = null;
      ++listSeq; ++treeSeq;
      connListMode = true;
    }
    if (!silent) renderPanel();
  }

  // ============================================================ воркспейс
  function renderWorkspace(body) {
    const ws = el('div', 'st-ide');
    const side = el('div', 'st-side');
    const main = el('div', 'st-main');
    ws.append(side, main);
    body.appendChild(ws);
    body.appendChild(transfersBar());
    renderTree(side);
    renderMain(main);
  }

  // ---------------- дерево: бакеты → префиксы (лениво; treeSeq-гард против смены подключения) ----------------
  async function renderTree(side) {
    const seq = ++treeSeq;
    const id = activeId;
    side.innerHTML = '';
    treeNodes.clear();
    const head = el('div', 'st-side-head');
    head.append(icon('cloud', 14), el('span', 'st-side-title', (activeConn && activeConn.name) || ''));
    const rf = iconBtn('drow-act', 'refresh', 'Перечитать бакеты', 13);
    rf.onclick = () => { const s = $('#storage-body .st-side'); if (s) renderTree(s); };
    head.appendChild(rf);
    side.appendChild(head);
    const treeBox = el('div', 'st-tree');
    side.appendChild(treeBox);
    treeBox.appendChild(el('div', 'st-dim', 'Загрузка…'));
    bucketsLoading = true;
    const r = await lite.storage.buckets(id);
    if (seq !== treeSeq || activeId !== id) return; // подключение сменили — ответ чужой
    const conn = activeConn;
    if (!conn) return; // вкладку успели закрыть
    bucketsLoading = false;
    treeBox.innerHTML = '';
    if (!r.ok) {
      // ListBuckets часто запрещён (анонимно / узкие права) — работаем от бакета по умолчанию
      if (conn.defaultBucket) {
        buckets = [{ name: conn.defaultBucket }];
        treeBox.appendChild(el('div', 'st-dim st-dim-note', 'Список бакетов недоступен — показан бакет из подключения'));
      } else {
        buckets = [];
        treeBox.appendChild(el('div', 'st-dim', '✕ ' + (r.error || 'бакеты недоступны') + '. Укажите «Бакет по умолчанию» в подключении.'));
        if (curBucket == null && !viewer) repaintMain();
        return;
      }
    } else buckets = r.buckets || [];
    // правая зона могла отрисовать вид «Бакеты» раньше, чем список приехал — освежить
    if (curBucket == null && !viewer) repaintMain();
    if (!buckets.length) { treeBox.appendChild(el('div', 'st-dim', 'Бакетов нет.')); return; }
    for (const b of buckets) treeBox.appendChild(treeNode(b.name, '', b.name, 0, 'box'));
    markTreeActive();
    hydrateIcons(treeBox);
  }

  const nodeKey = (bucket, prefix) => activeId + ' ' + bucket + ' ' + (prefix || '');
  function treeNode(bucket, prefix, label, depth, iconName) {
    const wrap = el('div');
    const k = nodeKey(bucket, prefix);
    const row = el('div', 'tree-row dir st-tree-row');
    row.style.paddingLeft = (depth * 12 + 8) + 'px';
    const chev = el('span', 'tree-chev', expanded.has(k) ? '▾' : '▸');
    row.append(chev, icon(iconName, 14), el('span', 'tree-name', label));
    const childBox = el('div', 'tree-children');
    childBox.style.display = 'none';
    treeNodes.set(k, { row, chev, childBox, bucket, prefix, depth });
    // клик по строке = переход в неё справа + раскрытие; клик по шеврону = только свернуть/развернуть
    chev.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (expanded.has(k)) { expanded.delete(k); childBox.style.display = 'none'; chev.textContent = '▸'; }
      else { expanded.add(k); await expandNode(chev, childBox, bucket, prefix, depth); }
    });
    row.addEventListener('click', async () => {
      if (!expanded.has(k)) { expanded.add(k); await expandNode(chev, childBox, bucket, prefix, depth); }
      navigateTo(bucket, prefix);
    });
    wrap.append(row, childBox);
    if (expanded.has(k)) expandNode(chev, childBox, bucket, prefix, depth);
    return wrap;
  }
  async function expandNode(chev, childBox, bucket, prefix, depth) {
    chev.textContent = '▾';
    childBox.style.display = 'block';
    // dataset.loaded ставится ТОЛЬКО при успехе: разовая сетевая ошибка не кэшируется навечно —
    // повторное свернуть/развернуть перечитает узел
    if (childBox.dataset.loaded === '1') return;
    const seq = treeSeq;
    childBox.innerHTML = '';
    childBox.appendChild(el('div', 'st-dim', '…'));
    const r = await lite.storage.ls(activeId, bucket, prefix, null);
    if (seq !== treeSeq) return;
    childBox.innerHTML = '';
    if (!r.ok) { childBox.appendChild(el('div', 'st-dim', '✕ ' + (r.error || ''))); return; }
    childBox.dataset.loaded = '1';
    for (const d of r.dirs) childBox.appendChild(treeNode(bucket, d.prefix, d.name, depth + 1, 'folder'));
    if (!r.dirs.length) childBox.appendChild(el('div', 'st-dim st-dim-leaf', '(нет подпапок)'));
    markTreeActive();
    hydrateIcons(childBox);
  }
  // Точечный рефреш узла после мутаций (mkdir / удаление папки) — дерево видит изменения сразу.
  async function refreshTreeNode(bucket, prefix) {
    const n = treeNodes.get(nodeKey(bucket, prefix));
    if (!n) return;
    // дочерние узлы будут пересозданы — убираем их записи из индекса
    const base = activeId + ' ' + bucket + ' ' + (prefix || '');
    for (const k of [...treeNodes.keys()]) if (k !== base && k.startsWith(base)) treeNodes.delete(k);
    delete n.childBox.dataset.loaded;
    if (expanded.has(nodeKey(bucket, prefix))) await expandNode(n.chev, n.childBox, bucket, prefix, n.depth);
  }
  // Подсветка активного узла дерева — после каждого перехода.
  function markTreeActive() {
    const activeKey = curBucket != null ? nodeKey(curBucket, curPrefix) : null;
    for (const [k, n] of treeNodes) n.row.classList.toggle('open', k === activeKey);
  }

  // ---------------- правая зона: список объектов / вивер ----------------
  function renderMain(main) {
    main.innerHTML = '';
    if (viewer) { renderViewer(main); return; }
    destroyEditor(); // вышли из вивера любым путём — CodeMirror не бросаем живым
    curListBox = null;
    main.appendChild(crumbsRow());
    if (curBucket == null) { renderBucketsView(main); return; }
    main.appendChild(toolbarRow());
    const box = el('div', 'st-list');
    main.appendChild(box);
    curListBox = box;
    wireDropZone(box);
    renderObjects(box);
  }
  function repaintMain() {
    const body = $('#storage-body'); if (!body) return;
    const main = body.querySelector('.st-main');
    if (main) { renderMain(main); hydrateIcons(main); }
  }
  // Перерисовать только список В ТОМ ЖЕ контейнере (скролл сохраняется) — фильтр/сортировка/догрузка.
  function repaintList(keepScroll) {
    if (!curListBox) { repaintMain(); return; }
    const st = keepScroll ? curListBox.scrollTop : 0;
    renderObjects(curListBox);
    curListBox.scrollTop = st;
    hydrateIcons(curListBox);
  }

  function crumbsRow() {
    const row = el('div', 'st-crumbs');
    const root = el('button', 'st-crumb', 'Бакеты');
    root.onclick = () => { curBucket = null; curPrefix = ''; viewer = null; selection.clear(); markTreeActive(); repaintMain(); };
    row.appendChild(root);
    if (curBucket != null) {
      row.appendChild(el('span', 'st-crumb-sep', '/'));
      const b = el('button', 'st-crumb st-crumb-bucket');
      b.append(icon('box', 12), el('span', null, curBucket));
      b.onclick = () => navigateTo(curBucket, '');
      row.appendChild(b);
      // сегменты БЕЗ выбрасывания пустых: у ключей вида «a//b/» крошки должны вести в точный префикс
      const parts = curPrefix ? curPrefix.slice(0, -1).split('/') : [];
      let acc = '';
      for (const p of parts) {
        acc += p + '/';
        const target = acc;
        row.appendChild(el('span', 'st-crumb-sep', '/'));
        const seg = el('button', 'st-crumb', p || '∅');
        seg.onclick = () => navigateTo(curBucket, target);
        row.appendChild(seg);
      }
    }
    return row;
  }

  function toolbarRow() {
    const bar = el('div', 'st-toolbar');
    if (canWrite()) {
      const up = el('button', 'btn st-tbtn');
      up.append(icon('upload', 13), el('span', null, 'Загрузить'));
      up.onclick = pickAndUpload;
      const mkBtn = el('button', 'btn st-tbtn');
      mkBtn.append(icon('obs-new-folder', 13), el('span', null, 'Папка'));
      mkBtn.onclick = makeFolder;
      bar.append(up, mkBtn);
    } else {
      bar.appendChild(el('span', 'st-dim', activeConn.anonymous ? 'Анонимный доступ — только чтение' : (activeConn.readOnly ? 'Подключение только для чтения' : '')));
    }
    // фильтр по текущему листингу (клиентский, живёт в сессии)
    const flt = el('input', 'st-filter');
    flt.type = 'search'; flt.placeholder = 'Фильтр…'; flt.value = filterText;
    flt.oninput = () => { filterText = flt.value; repaintList(false); };
    bar.appendChild(flt);
    const rf = el('button', 'btn st-tbtn st-tbtn-r');
    rf.append(icon('refresh', 13), el('span', null, 'Обновить'));
    rf.onclick = () => navigateTo(curBucket, curPrefix);
    bar.appendChild(rf);
    return bar;
  }

  function renderBucketsView(main) {
    const box = el('div', 'st-list');
    main.appendChild(box);
    if (bucketsLoading) { box.appendChild(el('div', 'st-dim st-loadnote', 'Загрузка…')); return; }
    if (!buckets.length) { box.appendChild(el('div', 'st-empty', 'Бакетов нет (или список недоступен по правам — укажите «Бакет по умолчанию» в подключении).')); return; }
    const t = el('div', 'st-table');
    const h = el('div', 'st-row st-row-head');
    h.append(el('span', 'st-cell st-cell-name', 'Бакет'), el('span', 'st-cell st-cell-date', 'Создан'));
    t.appendChild(h);
    for (const b of buckets) {
      const r = el('div', 'st-row');
      const nm = el('span', 'st-cell st-cell-name');
      nm.append(icon('box', 14), el('span', null, b.name));
      r.append(nm, el('span', 'st-cell st-cell-date', b.createdAt ? fmtDate(b.createdAt) : '—'));
      r.onclick = () => navigateTo(b.name, '');
      t.appendChild(r);
    }
    box.appendChild(t);
    hydrateIcons(box);
  }

  async function navigateTo(bucket, prefix) {
    curBucket = bucket; curPrefix = prefix || ''; viewer = null;
    selection.clear();
    const seq = ++listSeq;
    listing = { dirs: [], files: [], nextToken: null, loading: true };
    markTreeActive();
    repaintMain(); // моментально показать крошки + лоадер (не ложное «папка пуста»)
    const r = await lite.storage.ls(activeId, bucket, curPrefix, null);
    if (seq !== listSeq) return;
    listing = r.ok
      ? { dirs: r.dirs, files: r.files, nextToken: r.nextToken, loading: false }
      : { dirs: [], files: [], nextToken: null, loading: false, error: r.error };
    repaintList(false);
  }

  // видимый срез листинга: фильтр + сортировка (папки всегда отдельно и сверху)
  function visibleListing() {
    const q = filterText.trim().toLowerCase();
    const dirs = listing.dirs.filter((d) => !q || d.name.toLowerCase().includes(q))
      .slice().sort((a, b) => a.name.localeCompare(b.name) * (sort.key === 'name' ? sort.dir : 1));
    const files = listing.files.filter((f) => !q || f.name.toLowerCase().includes(q))
      .slice().sort((a, b) => {
        if (sort.key === 'size') return (a.size - b.size) * sort.dir;
        if (sort.key === 'mtime') return ((a.mtime || 0) - (b.mtime || 0)) * sort.dir;
        return a.name.localeCompare(b.name) * sort.dir;
      });
    return { dirs, files };
  }

  function renderObjects(box) {
    box.innerHTML = '';
    if (listing.loading) { box.appendChild(el('div', 'st-dim st-loadnote', 'Загрузка…')); return; }
    if (listing.error) { box.appendChild(el('div', 'st-empty', '✕ ' + listing.error)); return; }
    if (!listing.dirs.length && !listing.files.length && !listing.nextToken) {
      box.appendChild(el('div', 'st-empty', (curPrefix ? 'Папка пуста.' : 'Бакет пуст.') + (canWrite() ? ' Перетащите файлы сюда или нажмите «Загрузить».' : '')));
      return;
    }
    const { dirs, files } = visibleListing();
    selectionBar(box);
    const t = el('div', 'st-table');
    t.appendChild(sortableHead());
    for (const d of dirs) {
      const r = el('div', 'st-row');
      r.appendChild(el('span', 'st-cell st-cell-check'));
      const nm = el('span', 'st-cell st-cell-name');
      nm.append(icon('folder', 14), el('span', null, d.name));
      r.append(nm, el('span', 'st-cell st-cell-size', '—'), el('span', 'st-cell st-cell-date', '—'));
      r.onclick = () => navigateTo(curBucket, d.prefix);
      r.oncontextmenu = (e) => { e.preventDefault(); dirMenu(e, d); };
      t.appendChild(r);
    }
    for (const fo of files) {
      const r = el('div', 'st-row' + (selection.has(fo.key) ? ' sel' : ''));
      const cb = el('span', 'st-cell st-cell-check');
      const chk = el('input'); chk.type = 'checkbox'; chk.checked = selection.has(fo.key);
      chk.onclick = (e) => { e.stopPropagation(); if (chk.checked) selection.add(fo.key); else selection.delete(fo.key); r.classList.toggle('sel', chk.checked); refreshSelectionBar(); };
      cb.appendChild(chk);
      r.appendChild(cb);
      const nm = el('span', 'st-cell st-cell-name');
      nm.append(icon(IMG_EXT.has(extOf(fo.name)) ? 'image' : 'file', 14), el('span', null, fo.name));
      r.append(nm, el('span', 'st-cell st-cell-size', fmtSize(fo.size)), el('span', 'st-cell st-cell-date', fmtDate(fo.mtime)));
      r.onclick = () => openObject(fo.key);
      r.oncontextmenu = (e) => { e.preventDefault(); fileMenu(e, fo); };
      t.appendChild(r);
    }
    if (!dirs.length && !files.length && filterText) t.appendChild(el('div', 'st-empty', 'Ничего не найдено по фильтру.'));
    box.appendChild(t);
    if (listing.nextToken) {
      const more = el('button', 'btn st-more', 'Показать ещё (в бакете больше 1000 объектов)');
      more.onclick = async () => {
        const seq = listSeq; // пока грузилась страница, могли уйти в другую папку → ответ чужой
        more.disabled = true; more.textContent = 'Загрузка…';
        const r = await lite.storage.ls(activeId, curBucket, curPrefix, listing.nextToken);
        if (seq !== listSeq) return;
        if (!r.ok) { toast(r.error || 'Не удалось догрузить', { kind: 'err' }); more.disabled = false; more.textContent = 'Показать ещё'; return; }
        const seen = new Set(listing.dirs.map((d) => d.prefix)); // страница может повторить CommonPrefixes
        listing.dirs.push(...r.dirs.filter((d) => !seen.has(d.prefix)));
        listing.files.push(...r.files);
        listing.nextToken = r.nextToken;
        repaintList(true); // тот же контейнер, скролл сохраняется
      };
      box.appendChild(more);
    }
    hydrateIcons(box);
  }

  function sortableHead() {
    const h = el('div', 'st-row st-row-head');
    h.appendChild(el('span', 'st-cell st-cell-check'));
    const cols = [['name', 'Имя', 'st-cell-name'], ['size', 'Размер', 'st-cell-size'], ['mtime', 'Изменён', 'st-cell-date']];
    for (const [key, label, cls] of cols) {
      const c = el('span', 'st-cell ' + cls + ' st-sortable', label + (sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''));
      c.title = 'Сортировать';
      c.onclick = () => {
        if (sort.key === key) sort.dir = -sort.dir; else { sort.key = key; sort.dir = 1; }
        stUi.sort = { ...sort }; saveUi();
        repaintList(true);
      };
      h.appendChild(c);
    }
    return h;
  }

  // ---------------- мультивыбор: полоса пакетных действий ----------------
  function selectionBar(box) {
    const bar = el('div', 'st-selbar');
    bar.id = 'st-selbar';
    box.appendChild(bar);
    refreshSelectionBar();
  }
  function refreshSelectionBar() {
    const bar = $('#st-selbar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!selection.size) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.appendChild(el('span', 'st-sel-count', `Выбрано: ${selection.size}`));
    const dl = el('button', 'btn st-tbtn');
    dl.append(icon('download', 13), el('span', null, 'Скачать'));
    dl.onclick = () => downloadObjects([...selection].map((k) => ({ key: k, name: baseName(k) })));
    bar.appendChild(dl);
    if (canWrite()) {
      const del = el('button', 'btn st-tbtn st-danger');
      del.append(icon('trash', 13), el('span', null, 'Удалить'));
      del.onclick = () => deleteObjects([...selection], `${selection.size} объектов`);
      bar.appendChild(del);
    }
    const clr = el('button', 'btn st-tbtn', 'Снять выбор');
    clr.onclick = () => { selection.clear(); repaintList(true); };
    bar.appendChild(clr);
    hydrateIcons(bar);
  }

  // ---------------- контекстные меню ----------------
  function fileMenu(e, fo) {
    closeMenus();
    const cp = caps();
    const dd = el('div', 'menu-dropdown');
    dd.appendChild(menuRow('eye', 'Открыть', () => { closeMenus(); openObject(fo.key); }));
    dd.appendChild(menuRow('external-link', 'Открыть в вивере редактора', () => { closeMenus(); stageToViewer(fo); }));
    dd.appendChild(menuRow('download', 'Скачать…', () => { closeMenus(); downloadObjects([fo]); }));
    if (cp.presign || cp.acl || cp.publicUrl) dd.appendChild(menuRow('link', 'Доступ и ссылки…', () => { closeMenus(); linkModal(fo.key); }));
    dd.appendChild(menuRow('copy', 'Копировать ключ', () => { closeMenus(); lite.copyText(fo.key); toast('Ключ скопирован'); }));
    dd.appendChild(menuRow('copy', 'Копировать s3:// URI', () => { closeMenus(); lite.copyText(`s3://${curBucket}/${fo.key}`); toast('URI скопирован'); }));
    dd.appendChild(menuRow('terminal', 'Путь в терминал', () => { closeMenus(); try { sendToTerminal(`s3://${curBucket}/${fo.key}`); toast('Отправлено в терминал'); } catch (_) { toast('Терминал недоступен', { kind: 'err' }); } }));
    if (canWrite()) {
      dd.appendChild(menuRow('copy', 'Копировать в…', () => { closeMenus(); copyMoveModal(fo, false); }));
      dd.appendChild(menuRow('arrow-right', 'Переместить в…', () => { closeMenus(); copyMoveModal(fo, true); }));
      dd.appendChild(menuRow('pencil', 'Переименовать…', () => { closeMenus(); renameObject(fo); }));
      dd.appendChild(menuRow('trash', 'Удалить', () => { closeMenus(); deleteObjects([fo.key], fo.name); }, 'danger'));
    }
    placeMenu(dd, e.clientX, e.clientY);
    hydrateIcons(dd);
  }
  function dirMenu(e, d) {
    closeMenus();
    const dd = el('div', 'menu-dropdown');
    dd.appendChild(menuRow('folder', 'Открыть', () => { closeMenus(); navigateTo(curBucket, d.prefix); }));
    dd.appendChild(menuRow('download', 'Скачать папку…', () => { closeMenus(); downloadPrefix(d); }));
    dd.appendChild(menuRow('copy', 'Копировать префикс', () => { closeMenus(); lite.copyText(d.prefix); toast('Префикс скопирован'); }));
    if (canWrite()) {
      dd.appendChild(menuRow('trash', 'Удалить со всем содержимым', () => { closeMenus(); deletePrefix(d); }, 'danger'));
    }
    placeMenu(dd, e.clientX, e.clientY);
    hydrateIcons(dd);
  }

  // Подтверждение с усилением для PRODUCTION-подключений.
  function guardedConfirm(title, text, yesLabel, run) {
    const extra = activeConn && activeConn.isProd ? ` ⚠ Подключение «${activeConn.name}» помечено как PRODUCTION.` : '';
    confirm2(title, text + extra, yesLabel, run);
  }

  function makeFolder() {
    showPrompt('Новая папка', 'Имя папки (станет префиксом ключей)', '', async (nm) => {
      const name = String(nm || '').trim().replace(/^\/+|\/+$/g, '');
      if (!name) return;
      const r = await lite.storage.mkdir(activeId, curBucket, curPrefix + name + '/');
      if (!r.ok) { toast(r.error || 'Не удалось создать', { kind: 'err' }); return; }
      refreshTreeNode(curBucket, curPrefix); // дерево видит новую папку сразу
      navigateTo(curBucket, curPrefix);
    });
  }
  function renameObject(fo) {
    showPrompt('Переименовать', 'Новое имя (copy + delete — у S3 это не атомарно)', fo.name, async (nm) => {
      const name = String(nm || '').trim();
      if (!name || name === fo.name) return;
      const to = curPrefix + name;
      guardedConfirm('Переименовать объект?', `«${fo.name}» → «${name}».`, 'Переименовать', async () => {
        const r = await lite.storage.rename(activeId, curBucket, fo.key, to);
        if (!r.ok) { toast(r.error || 'Не удалось переименовать', { kind: 'err' }); return; }
        navigateTo(curBucket, curPrefix);
      });
    });
  }
  // «Копировать в…» / «Переместить в…»: назначение — префикс в этом же бакете.
  function copyMoveModal(fo, move) {
    const { m, close } = makeModal(`<h2>${move ? 'Переместить' : 'Копировать'} объект</h2><div class="st-links" id="stcm"></div>`);
    m.classList.add('db-modal');
    const box = m.querySelector('#stcm');
    box.appendChild(el('div', 'st-linkkey', fo.key));
    const row = el('div', 'st-linkrow');
    row.appendChild(el('span', 'st-linklabel', 'Префикс назначения:'));
    const dst = el('input', 'st-linkinp');
    dst.value = curPrefix; dst.placeholder = 'например logs/2026/ (пусто = корень бакета)';
    row.appendChild(dst);
    box.appendChild(row);
    const act = el('div', 'gm-actions');
    const ok = el('button', 'btn primary', move ? 'Переместить' : 'Копировать');
    ok.onclick = async () => {
      let prefix = dst.value.trim().replace(/^\/+/, '');
      if (prefix && !prefix.endsWith('/')) prefix += '/';
      const to = prefix + fo.name;
      if (to === fo.key) { toast('Назначение совпадает с исходным', { kind: 'err' }); return; }
      const r = move ? await lite.storage.rename(activeId, curBucket, fo.key, to) : await lite.storage.copy(activeId, curBucket, fo.key, to);
      if (!r.ok) { toast(r.error || 'Не удалось', { kind: 'err' }); return; }
      close();
      toast(move ? 'Перемещено' : 'Скопировано');
      navigateTo(curBucket, curPrefix);
    };
    const cancel = el('button', 'btn', 'Отмена'); cancel.onclick = close;
    act.append(ok, cancel);
    box.appendChild(act);
  }
  function deleteObjects(keys, label) {
    guardedConfirm('Удалить из хранилища?', `«${label || keys[0]}» будет удалён безвозвратно (корзины у S3 нет).`, 'Удалить', async () => {
      const r = await lite.storage.remove(activeId, curBucket, keys);
      if (!r.ok) { toast(r.error || 'Не удалось удалить', { kind: 'err' }); return; }
      for (const k of keys) selection.delete(k);
      if (viewer && viewer.bucket === curBucket && keys.includes(viewer.key)) viewer = null;
      navigateTo(curBucket, curPrefix);
    });
  }
  function deletePrefix(d) {
    guardedConfirm('Удалить папку?', `Все объекты под «${d.prefix}» будут удалены безвозвратно.`, 'Удалить всё', async () => {
      const r = await lite.storage.removePrefix(activeId, curBucket, d.prefix);
      if (!r.ok) { toast(r.error || 'Не удалось удалить', { kind: 'err' }); navigateTo(curBucket, curPrefix); return; }
      toast(`Удалено объектов: ${r.deleted}`);
      refreshTreeNode(curBucket, curPrefix); // удалённая папка исчезает и из дерева
      navigateTo(curBucket, curPrefix);
    });
  }

  // ---------------- вивер объекта ----------------
  async function openObject(key) {
    const bucket = curBucket;
    const seq = ++listSeq;
    viewer = { bucket, key, loading: true };
    repaintMain();
    const r = await lite.storage.read(activeId, bucket, key);
    if (seq !== listSeq || !viewer || viewer.key !== key || viewer.bucket !== bucket) return;
    viewer = r.ok ? { bucket, key, ...r } : { bucket, key, kind: 'error', error: r.error };
    repaintMain();
    if (!caps().acl) return;
    // публичность — лениво, одним запросом; гард по bucket+key (одинаковые ключи в разных бакетах)
    lite.storage.aclGet(activeId, bucket, key).then((a) => {
      if (!viewer || viewer.key !== key || viewer.bucket !== bucket) return;
      viewer.acl = a.ok ? a : { supported: false };
      const badge = $('#storage-body .st-acl-badge');
      if (badge) fillAclBadge(badge);
    });
  }
  function fillAclBadge(badge) {
    badge.innerHTML = '';
    if (!caps().acl) { badge.textContent = ''; badge.className = 'st-acl-badge st-dim'; return; }
    const a = viewer && viewer.acl;
    if (!a) { badge.textContent = '…'; return; }
    if (!a.supported) { badge.textContent = 'ACL недоступны (публичность — политикой бакета)'; badge.className = 'st-acl-badge st-dim'; return; }
    badge.className = 'st-acl-badge ' + (a.public ? 'st-acl-pub' : 'st-acl-priv');
    badge.textContent = a.public ? '🌐 Публичный' : '🔒 Приватный';
  }
  function destroyEditor() { if (curEditor) { try { curEditor.destroy(); } catch (_) {} curEditor = null; } }

  function renderViewer(main) {
    destroyEditor();
    const v = viewer;
    const bar = el('div', 'st-viewbar');
    const back = el('button', 'btn st-tbtn');
    back.append(icon('chevron-left', 13), el('span', null, 'К списку'));
    back.onclick = () => { viewer = null; repaintMain(); };
    bar.appendChild(back);
    bar.appendChild(el('span', 'st-viewname', v.key.slice(curPrefix.length) || v.key));
    const aclBadge = el('span', 'st-acl-badge');
    fillAclBadge(aclBadge);
    bar.appendChild(aclBadge);
    const dl = el('button', 'btn st-tbtn');
    dl.append(icon('download', 13), el('span', null, 'Скачать'));
    dl.onclick = () => downloadObjects([{ key: v.key, name: baseName(v.key) }]);
    bar.appendChild(dl);
    if (caps().presign || caps().acl || caps().publicUrl) {
      const ln = el('button', 'btn st-tbtn');
      ln.append(icon('link', 13), el('span', null, 'Ссылки'));
      ln.onclick = () => linkModal(v.key);
      bar.appendChild(ln);
    }
    main.appendChild(bar);

    if (v.meta) {
      const props = el('div', 'st-props');
      const pieces = [fmtSize(v.meta.size), v.meta.contentType || '—', v.meta.storageClass || '', v.meta.mtime ? fmtDate(v.meta.mtime) : '', v.meta.etag ? 'ETag ' + v.meta.etag.slice(0, 12) : ''];
      props.textContent = pieces.filter(Boolean).join(' · ');
      main.appendChild(props);
    }
    const box = el('div', 'st-view');
    main.appendChild(box);
    if (v.loading) { box.appendChild(el('div', 'st-dim st-loadnote', 'Загрузка…')); return; }
    if (v.kind === 'error') { box.appendChild(el('div', 'st-empty', '✕ ' + (v.error || 'не удалось открыть'))); return; }
    if (v.kind === 'image') {
      const img = el('img', 'st-img');
      img.src = v.dataUrl;
      box.appendChild(img);
      return;
    }
    if (v.kind === 'binary') {
      const card = el('div', 'st-bincard');
      card.append(icon('file', 28), el('div', null, v.note || `Двоичный файл, ${fmtSize(v.size)}`), el('div', 'st-dim', 'Просмотр недоступен — скачайте или откройте по ссылке.'));
      box.appendChild(card);
      hydrateIcons(card);
      return;
    }
    // текст → CodeMirror только-чтение с подсветкой по расширению ключа
    if (v.truncated) box.appendChild(el('div', 'st-truncnote', `Показаны первые 2 МБ из ${fmtSize(v.size)}.`));
    const edBox = el('div', 'st-editor');
    box.appendChild(edBox);
    curEditor = createCodeEditor(edBox, {
      doc: v.content || '',
      language: languageFor(v.key, () => {}),
      readOnly: true,
    });
  }

  // Открыть объект во внешнем вивере редактора (tmp-копия, read-only по смыслу).
  async function stageToViewer(fo) {
    const r = await lite.storage.stage(activeId, curBucket, fo.key);
    if (!r.ok) { toast(r.error || 'Не удалось подготовить файл', { kind: 'err' }); return; }
    try { openInViewer(r.path); toast('Открыто в вивере (временная копия — правки в хранилище не вернутся)', { ttl: 6000 }); }
    catch (_) { toast('Вивер недоступен', { kind: 'err' }); }
  }

  // ---------------- доступ и ссылки ----------------
  async function linkModal(key) {
    const cp = caps();
    const { m } = makeModal(`<h2>Доступ и ссылки</h2><div id="stl" class="st-links"></div>`);
    m.classList.add('db-modal');
    const box = m.querySelector('#stl');
    box.appendChild(el('div', 'st-linkkey', key));
    const aclRow = el('div', 'st-linkrow');
    if (cp.acl) { aclRow.appendChild(el('span', 'st-dim', 'Проверяю доступ…')); box.appendChild(aclRow); }
    const pubRow = el('div', 'st-linkrow');
    box.appendChild(pubRow);

    if (cp.presign) {
      // presigned: TTL-селектор + генерация (≤ 7 суток — предел SigV4)
      const signRow = el('div', 'st-linkrow');
      signRow.appendChild(el('span', 'st-linklabel', 'Временная ссылка:'));
      const ttl = el('select');
      for (const [v, l] of [[900, '15 минут'], [3600, '1 час'], [86400, '24 часа'], [604800, '7 дней (максимум)']]) ttl.appendChild(new Option(l, v));
      ttl.value = '3600';
      const gen = el('button', 'btn', 'Создать');
      const out = el('div', 'st-linkout');
      gen.onclick = async () => {
        out.textContent = '…';
        const r = await lite.storage.presign(activeId, curBucket, key, +ttl.value, 'GET');
        if (!r.ok) { out.textContent = '✕ ' + (r.error || ''); return; }
        out.innerHTML = '';
        const inp = el('input', 'st-linkinp'); inp.value = r.url; inp.readOnly = true;
        const cpBtn = el('button', 'btn', 'Копировать');
        cpBtn.onclick = () => { lite.copyText(r.url); toast('Ссылка скопирована'); };
        out.append(inp, cpBtn);
        out.appendChild(el('div', 'st-dim', `Действует до ${fmtDate(r.expiresAt)}. Ссылка даёт доступ любому, кто её получит.`));
      };
      signRow.append(ttl, gen);
      if (activeConn.anonymous) { ttl.disabled = true; gen.disabled = true; signRow.appendChild(el('span', 'st-dim', ' анонимное подключение — подпись недоступна')); }
      box.append(signRow, out);
    }

    if (!cp.acl) { hydrateIcons(m); return; }
    // публичность объекта (ACL) + публичная ссылка
    const a = await lite.storage.aclGet(activeId, curBucket, key);
    aclRow.innerHTML = '';
    if (!a.ok) {
      aclRow.appendChild(el('span', 'st-dim', '✕ ' + (a.error || 'ACL недоступны')));
    } else if (!a.supported) {
      aclRow.appendChild(el('span', 'st-dim', 'На этом хранилище ACL объектов отключены — публичность задаётся политикой бакета.'));
    } else {
      const syncViewerBadge = (isPub) => {
        // бейдж в вивере ЗА модалкой не должен отставать от переключения
        if (viewer && viewer.key === key && viewer.bucket === curBucket) {
          viewer.acl = { supported: true, public: isPub };
          const badge = $('#storage-body .st-acl-badge');
          if (badge) fillAclBadge(badge);
        }
      };
      const setRow = async (isPub) => {
        aclRow.innerHTML = '';
        aclRow.appendChild(el('span', 'st-linklabel', 'Доступ:'));
        aclRow.appendChild(el('span', isPub ? 'st-acl-pub' : 'st-acl-priv', isPub ? '🌐 Публичный' : '🔒 Приватный'));
        if (canWrite()) {
          const tgl = el('button', 'btn', isPub ? 'Закрыть доступ' : 'Открыть доступ');
          tgl.onclick = () => guardedConfirm(isPub ? 'Закрыть доступ?' : 'Открыть доступ всем?',
            isPub ? 'Объект перестанет быть доступным по публичной ссылке.' : 'Объект сможет читать ЛЮБОЙ по прямой ссылке.',
            isPub ? 'Закрыть' : 'Открыть', async () => {
              const r = await lite.storage.aclSet(activeId, curBucket, key, !isPub);
              if (!r.ok) { toast(r.error || 'Не удалось изменить доступ', { kind: 'err' }); return; }
              syncViewerBadge(!isPub);
              setRow(!isPub); fillPub(!isPub);
            });
          aclRow.appendChild(tgl);
        }
      };
      const fillPub = async (isPub) => {
        pubRow.innerHTML = '';
        if (!isPub || !cp.publicUrl) return;
        const u = await lite.storage.publicUrl(activeId, curBucket, key);
        if (!u.ok) return;
        pubRow.appendChild(el('span', 'st-linklabel', 'Публичная ссылка:'));
        const inp = el('input', 'st-linkinp'); inp.value = u.url; inp.readOnly = true;
        const cpBtn = el('button', 'btn', 'Копировать');
        cpBtn.onclick = () => { lite.copyText(u.url); toast('Ссылка скопирована'); };
        pubRow.append(inp, cpBtn);
      };
      setRow(!!a.public); fillPub(!!a.public);
    }
    hydrateIcons(m);
  }

  // ---------------- передачи: загрузка / скачивание / прогресс ----------------
  async function pickAndUpload() {
    const r = await lite.storage.pickUploads();
    if (!r.ok || !r.paths || !r.paths.length) return;
    startUploads(r.paths);
  }
  function startUploads(paths) {
    if (!curBucket) { toast('Сначала откройте бакет', { kind: 'err' }); return; }
    const bucket = curBucket, prefix = curPrefix; // куда РЕАЛЬНО грузим — для точечного рефреша по завершении
    // Объект с таким же ключом будет перезаписан безвозвратно — у S3 нет корзины, поэтому спрашиваем.
    const existing = paths.map((p) => baseName(p)).filter((nm) => listing.files.some((f) => f.name === nm));
    const run = () => {
      for (const p of paths) {
        const name = baseName(p);
        const key = prefix + name;
        const opId = newOpId();
        transfers.set(opId, { phase: 'upload', key, name, bucket, prefix, loaded: 0, total: 0, speed: 0, lastLoaded: 0, lastT: Date.now(), status: 'run' });
        lite.storage.upload(activeId, bucket, key, p, opId).then((res) => {
          if (!res.ok) { const t = transfers.get(opId); if (t) { t.status = 'err'; t.error = res.error; } paintTransfersBar(); }
        });
      }
      paintTransfersBar();
    };
    const start = () => {
      if (!existing.length) { run(); return; }
      const list = existing.slice(0, 5).join(', ') + (existing.length > 5 ? ` и ещё ${existing.length - 5}` : '');
      guardedConfirm('Перезаписать существующие объекты?',
        `В «${bucket}/${prefix}» уже есть: ${list}. Старая версия будет заменена безвозвратно — корзины у S3 нет.`,
        'Перезаписать', run);
    };
    if (activeConn.isProd) guardedConfirm('Загрузить в PRODUCTION?', `Файлов: ${paths.length} → «${bucket}/${prefix}».`, 'Загрузить', start);
    else start();
  }
  async function downloadObjects(objs) {
    const r = await lite.storage.pickDownloadDir();
    if (!r.ok || !r.dir) return;
    for (const o of objs) {
      const opId = newOpId();
      const name = o.name || baseName(o.key);
      transfers.set(opId, { phase: 'download', key: o.key, name, loaded: 0, total: 0, speed: 0, lastLoaded: 0, lastT: Date.now(), status: 'run' });
      lite.storage.download(activeId, curBucket, o.key, r.dir + '/' + name, opId).then((res) => {
        if (!res.ok) { const t = transfers.get(opId); if (t) { t.status = 'err'; t.error = res.error; } paintTransfersBar(); }
      });
    }
    paintTransfersBar();
  }
  async function downloadPrefix(d) {
    const r = await lite.storage.pickDownloadDir();
    if (!r.ok || !r.dir) return;
    const opId = newOpId();
    transfers.set(opId, { phase: 'download', key: d.prefix, name: d.name + '/', loaded: 0, total: 0, speed: 0, lastLoaded: 0, lastT: Date.now(), status: 'run' });
    lite.storage.downloadPrefix(activeId, curBucket, d.prefix, r.dir + '/' + d.name, opId).then((res) => {
      if (!res.ok) { const t = transfers.get(opId); if (t) { t.status = 'err'; t.error = res.error; } paintTransfersBar(); }
    });
    paintTransfersBar();
  }
  function wireDropZone(box) {
    // Гард нужен ВСЕГДА: без preventDefault Chromium навигирует окно модуля на file:// сброшенного
    // файла (на read-only подключении drop раньше уничтожал весь UI).
    box.addEventListener('dragover', (e) => { e.preventDefault(); if (canWrite()) box.classList.add('drag-over'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('drag-over');
      if (!canWrite()) { toast(activeConn && activeConn.anonymous ? 'Анонимное подключение — загрузка недоступна' : 'Подключение только для чтения', { kind: 'err' }); return; }
      const paths = [...(e.dataTransfer.files || [])].map((f) => lite.pathForFile(f)).filter(Boolean);
      if (paths.length) startUploads(paths);
    });
  }

  // Полоса передач: полная пересборка — только при добавлении/смене статуса; прогресс — точечно
  // (fill/pct), иначе кнопка «×» пересоздавалась под курсором на каждом событии.
  function transfersBar() {
    const bar = el('div', 'st-transfers');
    bar.id = 'st-transfers';
    paintTransfersBar(bar);
    return bar;
  }
  function paintTransfersBar(barArg) {
    const bar = barArg || $('#st-transfers');
    if (!bar) return;
    bar.innerHTML = '';
    transferRows.clear();
    if (!transfers.size) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const head = el('div', 'st-tr-head');
    head.append(el('span', null, `Передачи (${transfers.size})`));
    const clear = el('button', 'st-tr-clear', 'убрать завершённые');
    clear.onclick = () => { for (const [id, t] of transfers) if (t.status !== 'run') transfers.delete(id); paintTransfersBar(); };
    head.appendChild(clear);
    bar.appendChild(head);
    for (const [opId, t] of transfers) {
      const row = el('div', 'st-tr-row');
      row.append(icon(t.phase === 'upload' ? 'upload' : 'download', 13));
      row.appendChild(el('span', 'st-tr-name', t.name));
      if (t.status === 'run') {
        const prog = el('div', 'st-tr-bar');
        const fill = el('div', 'st-tr-fill');
        const pctNow = t.total ? Math.min(100, Math.round(t.loaded / t.total * 100)) : 0;
        fill.style.width = pctNow + '%';
        prog.appendChild(fill);
        row.appendChild(prog);
        const pct = el('span', 'st-tr-pct', (t.total ? pctNow + '%' : fmtSize(t.loaded)) + (t.speed ? ' · ' + fmtSize(t.speed) + '/с' : ''));
        row.appendChild(pct);
        const x = el('button', 'st-tr-x', '×');
        x.title = 'Отменить';
        x.onclick = () => { lite.storage.cancel(opId); t.status = 'cancelled'; paintTransfersBar(); };
        row.appendChild(x);
        transferRows.set(opId, { fill, pct });
      } else if (t.status === 'done') {
        row.appendChild(el('span', 'st-tr-ok', '✓ готово'));
      } else if (t.status === 'cancelled') {
        row.appendChild(el('span', 'st-dim', 'отменено'));
      } else {
        row.appendChild(el('span', 'st-tr-err', '✕ ' + (t.error || 'ошибка')));
      }
      bar.appendChild(row);
    }
    hydrateIcons(bar);
  }
  function updateTransferRow(opId) {
    const t = transfers.get(opId);
    const r = transferRows.get(opId);
    if (!t || !r) return;
    const pctNow = t.total ? Math.min(100, Math.round(t.loaded / t.total * 100)) : 0;
    r.fill.style.width = pctNow + '%';
    r.pct.textContent = (t.total ? pctNow + '%' : fmtSize(t.loaded)) + (t.speed ? ' · ' + fmtSize(t.speed) + '/с' : '');
  }

  // события прогресса — от бэкенда в это окно
  lite.storage.onProgress(({ opId, loaded, total }) => {
    const t = transfers.get(opId);
    if (!t || t.status !== 'run') return;
    const now = Date.now();
    const dt = (now - t.lastT) / 1000;
    if (dt > 0.4) { t.speed = (loaded - t.lastLoaded) / dt; t.lastLoaded = loaded; t.lastT = now; }
    t.loaded = loaded; t.total = total;
    updateTransferRow(opId);
  });
  lite.storage.onDone(({ opId }) => {
    const t = transfers.get(opId);
    if (!t) return;
    t.status = 'done';
    paintTransfersBar();
    // рефреш ТОЛЬКО если пользователь всё ещё смотрит папку, куда грузилось, и не в вивере —
    // иначе завершение фоновой загрузки выбивало из открытого файла / дёргало чужой префикс
    if (t.phase === 'upload' && !viewer && curBucket === t.bucket && curPrefix === t.prefix) navigateTo(curBucket, curPrefix);
    setTimeout(() => { if (transfers.get(opId) === t && t.status === 'done') { transfers.delete(opId); paintTransfersBar(); } }, 5000);
  });
  lite.storage.onOpErr(({ opId, error }) => {
    const t = transfers.get(opId);
    if (!t) return;
    if (t.status === 'cancelled') { transfers.delete(opId); paintTransfersBar(); return; } // отмена — не ошибка
    t.status = 'err'; t.error = error;
    toast('Передача не удалась: ' + error, { kind: 'err' });
    paintTransfersBar();
  });

  // ============================================================ контракт панели
  function setOpen(open, _opts = {}) {
    stOpen = !!open;
    const pane = $('#storage-pane');
    if (pane) pane.classList.toggle('hidden', !stOpen);
    if (stOpen) renderPanel();
  }
  return {
    isOpen: () => stOpen,
    setOpen,
    toggle: () => setOpen(!stOpen),
    renderPanel,
    refresh: () => renderPanel(),
    addConnection: () => connModal(null),
    openFromContainer,
  };
}
