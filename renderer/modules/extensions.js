// LiteEditor — пользовательские модули (extensions): загрузчик + публичный API ctx v1.
// Модуль = папка ~/.LiteEditorAI/modules/<id>/ (manifest.json + index.js, ES-модуль),
// грузится в рантайме динамическим import() по file:// URL из ext:scan (main валидирует).
// Все пользовательские модули делят ОДНУ панель правого слота (#ext-pane, id 'ext' в реестре
// панелей ядра): открыт один, контейнеры остальных живут скрытыми (state сохраняется).
// Модель доверия — Obsidian-style: без песочницы, установка = доверие коду; ошибки модуля
// изолируются (try/catch + toast), редактор живёт дальше. Спецификация — module-kit/GUIDE.md.
// host: { STORE, persist, layout, GUTTER, refitActiveTerminal, closeOtherPanels,
//         getProjects, getActiveId, getTheme, closeMenus, menuRow, openModuleDev }
import { el, icon, iconBtn, toast, makeModal, showConfirm, showPrompt } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

export function initExtensions(host) {
  const mods = new Map();   // id -> rec
  let extPaneOpen = false;
  let activeExtId = null;   // id модуля, чей контейнер сейчас показан (null — мастер/пусто)
  let extDirPath = '';      // абсолютный путь к ~/.LiteEditorAI/modules (из ext:scan)
  let wizardBox = null;     // контейнер мастера «Создать модуль» (лениво)

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

  function showOnly(id) { // показать контейнер одного модуля (или мастера при id === null)
    for (const r of mods.values()) if (r.container) r.container.style.display = (r.id === id) ? '' : 'none';
    if (wizardBox) wizardBox.style.display = (id === null) ? '' : 'none';
  }

  function openExt(id) {
    const rec = mods.get(id);
    if (!rec || rec.status !== 'on') return;
    showOnly(id);
    $('#ext-title').textContent = rec.title || modName(rec);
    $('#ext-reload').style.display = '';
    activeExtId = id;
    if (!extPaneOpen) setOpen(true);
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
  function buildMenuSection(dd) {
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(el('div', 'menu-label', 'Мои модули'));
    if (!mods.size) dd.appendChild(el('div', 'menu-row disabled', '— пока нет —'));
    for (const rec of mods.values()) {
      const click = rec.error ? null : async () => {
        host.closeMenus();
        if (rec.status === 'broken') await reload(rec.id);
        else if (!isEnabled(rec.id)) await toggle(rec.id, true);
        else if (rec.status === 'off') await loadModule(rec);
        if (rec.status === 'on') openExt(rec.id);
      };
      const row = host.menuRow('layers', modName(rec), click, rec.error ? 'disabled' : '');
      if (rec.error) { row.appendChild(el('span', 'ext-state', '⚠ ошибка')); row.title = rec.error; }
      else {
        if (rec.status === 'broken') { row.appendChild(el('span', 'ext-state', '⚠ сломан')); row.title = rec.error; }
        const tg = iconBtn('ext-toggle' + (isEnabled(rec.id) ? ' on' : ''), 'power', isEnabled(rec.id) ? 'Выключить' : 'Включить');
        tg.addEventListener('click', (e) => { e.stopPropagation(); host.closeMenus(); toggle(rec.id, !isEnabled(rec.id)); });
        row.appendChild(tg);
      }
      dd.appendChild(row);
    }
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(host.menuRow('plus', 'Создать модуль…', () => { host.closeMenus(); openWizard(); }));
    dd.appendChild(host.menuRow('folder', 'Открыть папку модулей', () => { host.closeMenus(); if (extDirPath) lite.openInFileManager(extDirPath); }));
    dd.appendChild(host.menuRow('refresh', 'Пересканировать', () => { host.closeMenus(); rescan(); }));
  }

  // ------------------------------------------------------------ мастер «Создать модуль»
  // Скаффолд раскладывает main (заготовка + GUIDE/CLAUDE.md/AGENTS.md из приложения),
  // затем папка модуля открывается как проект и в её терминале стартует ЛИЧНЫЙ агент
  // пользователя (claude/codex) с заданием. Никаких ключей/сети со стороны редактора.
  const wizState = () => (host.STORE.extData || {}).__wizard || {};
  const saveWiz = (patch) => host.persist('extData', { ...(host.STORE.extData || {}), __wizard: { ...wizState(), ...patch } });

  function shellQuote(s) {
    if (lite.platform === 'win32') return '"' + String(s).replace(/"/g, "'") + '"';
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }
  function agentCmd(agent, prompt) {
    return (agent === 'codex' ? 'codex ' : 'claude ') + shellQuote(prompt);
  }
  function runAgent(dir, name, task, agent, isNew) {
    const prompt = 'Прочитай файл GUIDE.md в текущей папке — это полная спецификация модуля LiteEditor. ' +
      (isNew ? 'Реализуй модуль: ' : 'Доработай существующий модуль: ') + task +
      '. Весь код — в index.js (activate/deactivate). Когда закончишь — сообщи, что модуль готов: ' +
      'пользователь проверит его через меню «Модули → Пересканировать».';
    host.openModuleDev(dir, 'Модуль: ' + name, agentCmd(agent, prompt));
    toast('Открываю терминал модуля и запускаю агента…');
  }
  // Транслит для авто-id из русского названия (слаг можно поправить руками).
  const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  function slugify(s) {
    return String(s).toLowerCase().split('').map((ch) => TR[ch] != null ? TR[ch] : ch).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function openWizard() {
    host.closeOtherPanels('ext');
    if (!wizardBox) { wizardBox = el('div', 'ext-mod'); $('#ext-body').appendChild(wizardBox); }
    showOnly(null);
    activeExtId = null;
    $('#ext-title').textContent = 'Создать модуль';
    $('#ext-reload').style.display = 'none';
    if (!extPaneOpen) setOpen(true);
    renderWizard();
  }

  async function renderWizard() {
    wizardBox.innerHTML = '';
    const w = el('div', 'ext-wizard');
    wizardBox.appendChild(w);

    // -- доработка существующих
    if (mods.size) {
      w.appendChild(el('div', 'ext-wiz-label', 'Мои модули — доработка'));
      for (const rec of mods.values()) {
        const row = el('div', 'ext-wiz-mod');
        row.appendChild(el('span', 'ext-wiz-name', modName(rec)));
        const dev = el('button', 'btn', 'Доработать');
        dev.addEventListener('click', () => {
          showPrompt('Доработка «' + modName(rec) + '»', 'Что изменить или добавить?', '', (v) => {
            runAgent(rec.dir, modName(rec), v, wizState().agent || 'claude', false);
          });
        });
        const fold = iconBtn('', 'folder', 'Открыть папку модуля');
        fold.addEventListener('click', () => lite.openInFileManager(rec.dir));
        row.appendChild(dev); row.appendChild(fold);
        w.appendChild(row);
      }
      w.appendChild(el('div', 'ext-wiz-sep'));
    }

    // -- новый модуль
    w.appendChild(el('div', 'ext-wiz-label', 'Новый модуль'));
    const nameIn = el('input'); nameIn.type = 'text'; nameIn.placeholder = 'Название (например: Конвертер валют)'; nameIn.spellcheck = false;
    const idIn = el('input'); idIn.type = 'text'; idIn.placeholder = 'id (a-z, 0-9, дефис) — авто из названия'; idIn.spellcheck = false;
    let idTouched = false;
    idIn.addEventListener('input', () => { idTouched = true; });
    nameIn.addEventListener('input', () => { if (!idTouched) idIn.value = slugify(nameIn.value); });
    const descIn = el('textarea'); descIn.placeholder = 'Что должен делать модуль? Опишите одной-двумя фразами — это задание для агента.'; descIn.spellcheck = false;
    w.appendChild(nameIn); w.appendChild(idIn); w.appendChild(descIn);

    // -- выбор агента
    const ag = await lite.ext.agents().catch(() => ({ claude: false, codex: false }));
    const agents = el('div', 'ext-wiz-agents');
    let agent = wizState().agent || (ag.claude ? 'claude' : (ag.codex ? 'codex' : 'claude'));
    if (agent === 'claude' && !ag.claude && ag.codex) agent = 'codex';
    for (const [key, label, ok] of [['claude', 'Claude Code', ag.claude], ['codex', 'Codex CLI', ag.codex]]) {
      const lab = el('label', ok ? '' : 'off');
      const r = el('input'); r.type = 'radio'; r.name = 'ext-agent'; r.value = key; r.disabled = !ok; r.checked = agent === key && ok;
      r.addEventListener('change', () => { agent = key; saveWiz({ agent: key }); });
      lab.appendChild(r);
      lab.appendChild(el('span', null, label + (ok ? '' : ' (не найден в PATH)')));
      agents.appendChild(lab);
    }
    w.appendChild(agents);

    const anyAgent = ag.claude || ag.codex;
    w.appendChild(el('div', 'ext-wiz-warn',
      '⚠ Мастер запустит ВАШ локальный агент в терминале от вашего имени — будет использована ' +
      'ваша подписка/токены этого агента. Редактор лишь создаёт заготовку модуля и передаёт задание.'));

    const btn = el('button', 'btn primary', anyAgent ? 'Создать и запустить агента' : 'Создать заготовку (агенты не найдены)');
    btn.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      const id = (idIn.value.trim() || slugify(name));
      const desc = descIn.value.trim();
      if (!name) { toast('Укажите название модуля', { kind: 'error' }); return; }
      if (!/^[a-z0-9-]+$/.test(id)) { toast('id — только латиница a-z, цифры и дефис', { kind: 'error' }); return; }
      if (anyAgent && !desc) { toast('Опишите, что должен делать модуль — это задание для агента', { kind: 'error' }); return; }
      btn.disabled = true;
      const r = await lite.ext.scaffold({ id, name, desc }).catch((e) => ({ error: String(e) }));
      if (!r || r.error) { btn.disabled = false; toast('Не удалось создать модуль: ' + ((r && r.error) || 'ошибка'), { kind: 'error' }); return; }
      await rescan(true); // заготовка валидна — модуль сразу появляется в списке
      if (anyAgent) runAgent(r.dir, name, desc, agent, true);
      else { toast('Заготовка создана: ' + r.dir); lite.openInFileManager(r.dir); }
      openWizard(); // перерисовать список «Мои модули»
    });
    w.appendChild(btn);
  }

  // ------------------------------------------------------------ init
  $('#ext-close').addEventListener('click', () => setOpen(false));
  $('#ext-reload').addEventListener('click', () => { if (activeExtId) reload(activeExtId); });
  rescan(true); // стартовая загрузка включённых модулей (папки нет → main создаст + README)

  return {
    isOpen: () => extPaneOpen,
    setOpen,
    open: openExt,
    toggle, reload, rescan,
    buildMenuSection, paletteActions,
    notifyActiveProject, notifyTheme,
    openWizard,
  };
}
