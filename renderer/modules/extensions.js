// LiteEditor — пользовательские модули (extensions): загрузчик + публичный API ctx v1.
// Модуль = папка ~/.LiteEditorAI/modules/<id>/ (manifest.json + index.js, ES-модуль),
// грузится в рантайме динамическим import() по file:// URL из ext:scan (main валидирует).
// Все пользовательские модули делят ОДНУ панель правого слота (#ext-pane, id 'ext' в реестре
// панелей ядра): открыт один, контейнеры остальных живут скрытыми (state сохраняется).
// Модель доверия — Obsidian-style: без песочницы, установка = доверие коду; ошибки модуля
// изолируются (try/catch + toast), редактор живёт дальше. Спецификация — module-kit/GUIDE.md.
// host: { STORE, persist, layout, GUTTER, refitActiveTerminal, closeOtherPanels,
//         getProjects, getActiveId, getTheme, closeMenus, menuRow, spawnFolderTerminal }
import { el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initExtensions(host) {
  const mods = new Map();   // id -> rec
  let extPaneOpen = false;
  let activeExtId = null;   // id модуля, чей контейнер сейчас показан (null — мастер/пусто)
  let extDirPath = '';      // абсолютный путь к ~/.LiteEditorAI/modules (из ext:scan)
  let wizardBox = null;     // контейнер мастера «Создать модуль» (лениво)
  const devTerms = new Map(); // id модуля -> { box, handle } — dev-терминал папки (живёт в панели)
  let termView = null;      // id модуля, чей dev-терминал сейчас показан (иначе null)

  const isEnabled = (id) => (host.STORE.extEnabled || {})[id] !== false;
  const setEnabled = (id, on) => host.persist('extEnabled', { ...(host.STORE.extEnabled || {}), [id]: !!on });
  const modName = (rec) => (rec.manifest && rec.manifest.name) || rec.id;

  function mkRec(m) {
    return {
      id: m.id, dir: m.dir, manifest: m.manifest || {}, error: m.error || '', mainUrl: m.mainUrl, mainFile: m.mainFile,
      status: 'off', // 'off' | 'on' | 'broken'
      container: null, instance: null, ctx: null, title: '', loadSeq: 0,
      closeCbs: [], projCbs: [], themeCbs: [], commands: new Map(),
    };
  }

  // ------------------------------------------------------------ панель (реестр ядра, id 'ext')
  function setOpen(open, opts = {}) {
    if (open === extPaneOpen) return;
    if (open) host.closeOtherPanels('ext');
    const delta = host.layout.ext + host.GUTTER;
    extPaneOpen = open;
    $('#ext-pane').classList.toggle('hidden', !open);
    $('#gutter-ext').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    setTimeout(host.refitActiveTerminal, 150);
    if (!open) {
      const rec = activeExtId ? mods.get(activeExtId) : null;
      if (rec) for (const fn of rec.closeCbs.slice()) { try { fn(); } catch (_) {} }
    }
  }

  // Панель #ext-pane показывает РОВНО одну «вьюху»: контейнер загруженного модуля, мастер
  // «Создать модуль» или dev-терминал папки модуля. hideViews() гасит все, дальше показываем нужную.
  function hideViews() {
    for (const r of mods.values()) if (r.container) r.container.style.display = 'none';
    if (wizardBox) wizardBox.style.display = 'none';
    for (const t of devTerms.values()) t.box.style.display = 'none';
  }
  // mode: 'module' (⟳ виден), 'wizard' (ничего), 'term' (← Назад виден)
  function setHead(mode, title) {
    $('#ext-title').textContent = title;
    $('#ext-reload').style.display = mode === 'module' ? '' : 'none';
    $('#ext-back').style.display = mode === 'term' ? '' : 'none';
  }
  const ensurePaneOpen = () => { if (!extPaneOpen) setOpen(true); };

  function openExt(id) {
    const rec = mods.get(id);
    if (!rec || rec.status !== 'on') return;
    ensurePaneOpen();
    hideViews();
    rec.container.style.display = '';
    setHead('module', rec.title || modName(rec));
    activeExtId = id; termView = null;
  }

  // ------------------------------------------------------------ ctx v1 (публичный API модуля)
  function buildCtx(rec) {
    const id = rec.id;
    return Object.freeze({
      api: 1,
      id,
      panel: Object.freeze({
        element: rec.container,
        setTitle: (t) => { rec.title = String(t || ''); if (activeExtId === id) $('#ext-title').textContent = rec.title || modName(rec); },
        open: () => openExt(id),
        close: () => { if (activeExtId === id && extPaneOpen) setOpen(false); },
        isOpen: () => extPaneOpen && activeExtId === id,
        onClose: (fn) => { rec.closeCbs.push(fn); return () => { rec.closeCbs = rec.closeCbs.filter((f) => f !== fn); }; },
      }),
      ui: Object.freeze({ el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt }),
      storage: Object.freeze({
        get: (k, def) => { const d = (host.STORE.extData || {})[id] || {}; return (k in d) ? d[k] : def; },
        set: (k, v) => { const all = { ...(host.STORE.extData || {}) }; all[id] = { ...(all[id] || {}), [k]: v }; host.persist('extData', all); },
        all: () => ({ ...((host.STORE.extData || {})[id] || {}) }),
      }),
      projects: Object.freeze({
        list: () => host.getProjects(),
        activeId: () => host.getActiveId(),
        onChange: (fn) => { rec.projCbs.push(fn); return () => { rec.projCbs = rec.projCbs.filter((f) => f !== fn); }; },
      }),
      commands: Object.freeze({
        register: (title, fn) => { rec.commands.set(String(title), fn); return () => rec.commands.delete(String(title)); },
      }),
      theme: Object.freeze({
        current: () => host.getTheme(),
        onChange: (fn) => { rec.themeCbs.push(fn); return () => { rec.themeCbs = rec.themeCbs.filter((f) => f !== fn); }; },
      }),
    });
  }

  // ------------------------------------------------------------ жизненный цикл
  // import() файла модуля: сперва нативно по file:// (cache-bust query), при отказе
  // (некоторые конфигурации режут CORS у ES-модулей с file://-страниц) — через Blob URL.
  async function importModule(rec) {
    try { return await import(rec.mainUrl + '?v=' + rec.loadSeq + '-' + Date.now()); }
    catch (e) {
      const r = await lite.fs.readFile(rec.mainFile);
      if (!r || r.error || r.content == null) throw e; // файл не читается — отдаём исходную ошибку import
      const url = URL.createObjectURL(new Blob([r.content], { type: 'text/javascript' }));
      try { return await import(url); } finally { URL.revokeObjectURL(url); }
    }
  }

  async function loadModule(rec) {
    rec.loadSeq++;
    try {
      const ns = await importModule(rec);
      if (typeof ns.activate !== 'function' || typeof ns.deactivate !== 'function')
        throw new Error('index.js должен экспортировать activate(ctx) и deactivate()');
      rec.container = el('div', 'ext-mod');
      rec.container.style.display = 'none';
      $('#ext-body').appendChild(rec.container);
      rec.instance = ns;
      rec.ctx = buildCtx(rec);
      await ns.activate(rec.ctx);
      rec.status = 'on';
    } catch (e) {
      rec.status = 'broken';
      rec.error = String((e && e.message) || e);
      if (rec.container) { try { rec.container.remove(); } catch (_) {} rec.container = null; }
      rec.instance = null; rec.ctx = null;
      toast(`Модуль «${modName(rec)}» не загрузился: ${rec.error}`, { kind: 'error' });
      try { lite.log('error', 'ext activate failed', rec.id, rec.error); } catch (_) {}
    }
  }

  function unloadModule(rec, keepPane) {
    if (rec.instance && rec.status === 'on') {
      try { rec.instance.deactivate(); }
      catch (e) { try { lite.log('warn', 'ext deactivate failed', rec.id, String((e && e.message) || e)); } catch (_) {} }
    }
    if (rec.container) { try { rec.container.remove(); } catch (_) {} }
    rec.container = null; rec.instance = null; rec.ctx = null; rec.status = 'off';
    rec.closeCbs = []; rec.projCbs = []; rec.themeCbs = []; rec.commands = new Map();
    if (activeExtId === rec.id) { activeExtId = null; if (extPaneOpen && !keepPane) setOpen(false); }
  }

  async function toggle(id, on) {
    const rec = mods.get(id);
    if (!rec) return;
    setEnabled(id, on);
    if (on && rec.status === 'off' && !rec.error) await loadModule(rec);
    else if (!on && rec.status !== 'off') unloadModule(rec);
  }

  async function reload(id) {
    const rec = mods.get(id);
    if (!rec) return;
    const wasActive = extPaneOpen && activeExtId === id;
    unloadModule(rec, wasActive);
    // свежий скан — манифест/main могли поменяться (агент правил файлы)
    const r = await lite.ext.scan().catch(() => null);
    const m = r && r.modules.find((x) => x.id === id);
    if (m) { rec.dir = m.dir; rec.manifest = m.manifest || rec.manifest; rec.error = m.error || ''; rec.mainUrl = m.mainUrl; rec.mainFile = m.mainFile; }
    if (rec.error) { toast(`Модуль «${modName(rec)}»: ${rec.error}`, { kind: 'error' }); if (wasActive) setOpen(false); return; }
    await loadModule(rec);
    if (rec.status === 'on') { toast(`Модуль «${modName(rec)}» перезагружен`); if (wasActive) openExt(id); }
    else if (wasActive) setOpen(false);
  }

  async function rescan(quiet) {
    const r = await lite.ext.scan().catch(() => null);
    if (!r) return;
    extDirPath = r.dir;
    const seen = new Set();
    for (const m of r.modules) {
      seen.add(m.id);
      let rec = mods.get(m.id);
      if (!rec) {
        rec = mkRec(m);
        mods.set(m.id, rec);
        if (!m.error && isEnabled(m.id)) await loadModule(rec);
      } else if (rec.status !== 'on') { // выгруженные и сломанные пробуем поднять заново; живые — через reload
        unloadModule(rec); // у broken чистит остатки состояния (deactivate не зовётся — instance нет)
        rec.dir = m.dir; rec.manifest = m.manifest || rec.manifest; rec.error = m.error || ''; rec.mainUrl = m.mainUrl; rec.mainFile = m.mainFile;
        if (!rec.error && isEnabled(m.id)) await loadModule(rec);
      }
    }
    for (const [id, rec] of [...mods]) if (!seen.has(id)) { unloadModule(rec); mods.delete(id); }
    if (!quiet) {
      const on = [...mods.values()].filter((x) => x.status === 'on').length;
      toast(mods.size ? `Модули: активно ${on} из ${mods.size}` : 'Пользовательских модулей не найдено');
    }
    if (host.modsChanged) { try { host.modsChanged(); } catch (_) {} } // квикбар ядра перерисовывает кнопки
  }

  // ------------------------------------------------------------ интеграция с ядром
  function notifyActiveProject(id) {
    for (const rec of mods.values()) if (rec.status === 'on')
      for (const fn of rec.projCbs.slice()) { try { fn(id); } catch (_) {} }
  }
  function notifyTheme(name) {
    for (const rec of mods.values()) if (rec.status === 'on')
      for (const fn of rec.themeCbs.slice()) { try { fn(name); } catch (_) {} }
  }
  function paletteActions() {
    const acts = [];
    for (const rec of mods.values()) if (rec.status === 'on')
      for (const [title, fn] of rec.commands) acts.push({ label: title, run: () => { try { fn(); } catch (e) { toast(`Модуль «${modName(rec)}»: ${String((e && e.message) || e)}`, { kind: 'error' }); } } });
    return acts;
  }

  // Секция «Мои модули» в меню «Модули» (ядро зовёт из buildModulesMenu).
  function buildMenuSection(dd, opts = {}) {
    if (!opts.bare) { // bare: вызвано из flyout-подменю — свой заголовок не нужен
      dd.appendChild(el('div', 'menu-sep'));
      dd.appendChild(el('div', 'menu-label', 'Мои модули'));
    }
    if (!mods.size) dd.appendChild(el('div', 'menu-row disabled', '— пока нет —'));
    for (const rec of mods.values()) {
      const click = rec.error ? null : async () => {
        host.closeMenus();
        if (rec.status === 'broken') await reload(rec.id);
        else if (rec.status === 'off') await loadModule(rec);
        if (rec.status === 'on') openExt(rec.id);
      };
      const row = host.menuRow('layers', modName(rec), click, rec.error ? 'disabled' : '');
      if (rec.error) { row.appendChild(el('span', 'ext-state', '⚠ ошибка')); row.title = rec.error; }
      else if (rec.status === 'broken') { row.appendChild(el('span', 'ext-state', '⚠ сломан')); row.title = rec.error; }
      dd.appendChild(row);
    }
    dd.appendChild(el('div', 'menu-sep'));
    const mrow = host.moduleRow || ((g, t, _d, fn) => host.menuRow(g, t, fn)); // двухстрочный пункт, если ядро его дало
    dd.appendChild(mrow('plus', 'Создать модуль…', 'менеджер пользовательских модулей', () => { host.closeMenus(); openWizard(); }));
    dd.appendChild(mrow('folder', 'Открыть папку модулей', '~/.LiteEditorAI/modules', () => { host.closeMenus(); if (extDirPath) lite.openInFileManager(extDirPath); }));
    dd.appendChild(mrow('refresh', 'Пересканировать', 'перечитать список модулей с диска', () => { host.closeMenus(); rescan(); }));
  }

  // ------------------------------------------------------------ dev-терминал папки модуля
  // Терминал живёт ВНУТРИ панели (#ext-pane), cwd = папка модуля. Агента (любого, со своими
  // настройками) пользователь запускает сам; подсказанную команду лишь предвпечатываем БЕЗ Enter.
  const PROTECTED = new Set(['calculator']); // встроенный пример — не удаляем, без dev-терминала

  function openDevTerminal(rec) {
    ensurePaneOpen();
    hideViews();
    let entry = devTerms.get(rec.id);
    if (!entry) {
      const box = el('div', 'ext-term');
      $('#ext-body').appendChild(box);
      // cwd = папка модуля; агента (любого) пользователь запускает САМ — ничего не предвпечатываем.
      const handle = host.spawnFolderTerminal(box, rec.dir);
      entry = { box, handle };
      devTerms.set(rec.id, entry);
    }
    entry.box.style.display = '';
    setHead('term', modName(rec));
    termView = rec.id; activeExtId = null;
    setTimeout(() => { entry.handle.refit(); entry.handle.focus(); }, 80);
  }

  function deleteModule(rec) {
    showConfirm('Удалить модуль «' + modName(rec) + '»?',
      'Папка модуля переместится в корзину ОС (можно восстановить). Модуль выгрузится из редактора.',
      'Удалить', async () => {
        unloadModule(rec, true);
        const dt = devTerms.get(rec.id);
        if (dt) { try { dt.handle.dispose(); } catch (_) {} dt.box.remove(); devTerms.delete(rec.id); }
        const r = await lite.fs.trash(rec.dir).catch((e) => ({ error: String(e) }));
        if (r && r.error) { toast('Не удалось удалить: ' + r.error, { kind: 'error' }); return; }
        mods.delete(rec.id);
        toast('Модуль «' + modName(rec) + '» удалён');
        if (host.modsChanged) { try { host.modsChanged(); } catch (_) {} }
        openWizard();
      });
  }

  // ------------------------------------------------------------ мастер «Создать модуль»
  // Транслит для имени папки/id из русского названия.
  const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  function slugify(s) {
    return String(s).toLowerCase().split('').map((ch) => TR[ch] != null ? TR[ch] : ch).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function openWizard() {
    ensurePaneOpen();
    if (!wizardBox) { wizardBox = el('div', 'ext-mod'); $('#ext-body').appendChild(wizardBox); }
    hideViews();
    wizardBox.style.display = '';
    setHead('wizard', 'Создать модуль');
    activeExtId = null; termView = null;
    renderWizard();
  }

  function renderWizard() {
    wizardBox.innerHTML = '';
    const w = el('div', 'ext-wizard');
    wizardBox.appendChild(w);

    // -- мои модули: открыть терминал / папка / удалить (встроенный калькулятор — только папка)
    if (mods.size) {
      w.appendChild(el('div', 'ext-wiz-label', 'Мои модули'));
      for (const rec of mods.values()) {
        const row = el('div', 'ext-wiz-mod');
        row.appendChild(el('span', 'ext-wiz-name', modName(rec)));
        const fold = iconBtn('icon-btn', 'folder', 'Открыть папку модуля');
        fold.addEventListener('click', () => lite.openInFileManager(rec.dir));
        if (!PROTECTED.has(rec.id)) {
          const dev = iconBtn('icon-btn', 'terminal', 'Открыть терминал в папке модуля');
          dev.addEventListener('click', () => openDevTerminal(rec));
          row.appendChild(dev);
        }
        row.appendChild(fold);
        if (!PROTECTED.has(rec.id)) {
          const del = iconBtn('icon-btn ext-del', 'trash', 'Удалить модуль');
          del.addEventListener('click', () => deleteModule(rec));
          row.appendChild(del);
        }
        w.appendChild(row);
      }
      w.appendChild(el('div', 'ext-wiz-sep'));
    }

    // -- новый модуль: имя слева + компактная кнопка справа
    w.appendChild(el('div', 'ext-wiz-label', 'Новый модуль'));
    const rowNew = el('div', 'ext-wiz-new');
    const nameIn = el('input'); nameIn.type = 'text'; nameIn.placeholder = 'Имя модуля'; nameIn.spellcheck = false;
    const btn = el('button', 'btn primary ext-wiz-create', 'Создать и открыть терминал');
    rowNew.appendChild(nameIn); rowNew.appendChild(btn);
    const hint = el('div', 'ext-wiz-hint', '');
    nameIn.addEventListener('input', () => { const s = slugify(nameIn.value); hint.textContent = s ? 'папка: ' + s : ''; });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    w.appendChild(rowNew); w.appendChild(hint);

    btn.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      const id = slugify(name);
      if (!name) { toast('Укажите имя модуля', { kind: 'error' }); return; }
      if (!id) { toast('Из имени не вышло корректное имя папки — добавьте латиницу/цифры', { kind: 'error' }); return; }
      if (mods.has(id)) { toast('Модуль с папкой «' + id + '» уже есть', { kind: 'error' }); return; }
      btn.disabled = true;
      const r = await lite.ext.scaffold({ id, name }).catch((e) => ({ error: String(e) }));
      if (!r || r.error) { btn.disabled = false; toast('Не удалось создать модуль: ' + ((r && r.error) || 'ошибка'), { kind: 'error' }); return; }
      await rescan(true);
      const rec = mods.get(id);
      if (rec) await openDevTerminal(rec);
    });
  }

  // ------------------------------------------------------------ init
  $('#ext-close').addEventListener('click', () => setOpen(false));
  $('#ext-reload').addEventListener('click', () => { if (activeExtId) reload(activeExtId); });
  $('#ext-back').addEventListener('click', () => openWizard());
  rescan(true); // стартовая загрузка включённых модулей (папки нет → main создаст + README)

  return {
    isOpen: () => extPaneOpen,
    setOpen,
    open: openExt,
    // Для квикбара ядра: список модулей и открытие «как из меню» (broken — перезагрузить, off — поднять).
    list: () => [...mods.values()].map((r) => ({ id: r.id, name: modName(r), ok: !r.error })),
    quickOpen: async (id) => {
      const rec = mods.get(id);
      if (!rec || rec.error) return;
      if (rec.status === 'broken') await reload(rec.id);
      else if (rec.status === 'off') await loadModule(rec);
      if (rec.status === 'on') openExt(rec.id);
    },
    toggle, reload, rescan,
    buildMenuSection, paletteActions,
    notifyActiveProject, notifyTheme,
    openWizard,
    refitTerminal: () => { if (termView && devTerms.has(termView)) devTerms.get(termView).handle.refit(); },
  };
}
